import assert from "node:assert/strict";
import test from "node:test";
import { loadApp } from "./helpers/real-db.mjs";

// The reminder run of the local Tasks app (src/lib/tasks/reminders.ts) on a migrated SQLite database.
// The push sender is injected, so nothing leaves the process.

const { app, newDatabase } = await loadApp("local-tasks-reminders", `
	export * as service from "./src/lib/tasks/service.ts";
	export * as reminders from "./src/lib/tasks/reminders.ts";
`, { mocks: {
	"@/lib/push/server": `export const sendPushContent = () => { throw new Error("the real push sender is not under test"); };`,
} });
const { service, reminders } = app;

const SEED = `
	INSERT INTO users (id, email, password_hash, name, role, time_zone, created_at) VALUES
		('u1', 'kevin@example.com', 'x', 'Kevin', 'user', 'America/New_York', 1),
		('u2', 'anna@example.com', 'x', 'Anna', 'user', NULL, 1);
`;
const kevin = { id: "u1", email: "kevin@example.com", role: "user", timeZone: "America/New_York" };
const anna = { id: "u2", email: "anna@example.com", role: "user", timeZone: null };
const fixture = (t) => newDatabase(t, SEED);

test("the reminder push names the task, when it is due, and where it opens", () => {
	const push = reminders.taskReminderPush({ id: "tsk_1", userId: "u1", title: "  Call the bank  ", dueDate: "2026-11-30", dueAt: new Date("2026-11-30T19:00:00Z"), timeZone: "America/New_York" });
	assert.deepEqual(push, { title: "Call the bank", body: "Due Mon, Nov 30, 2:00 PM", tag: "task:tsk_1", url: "/tasks?task=tsk_1" });
	assert.equal(reminders.formatTaskReminderBody({ dueDate: "2026-11-30", dueAt: null, timeZone: "Pacific/Kiritimati" }), "Due Mon, Nov 30", "a date keeps its day in every zone");
	assert.equal(reminders.formatTaskReminderBody({ dueDate: "2026-11-30", dueAt: new Date("2026-11-30T19:00:00Z"), timeZone: "Not/AZone" }), "Due Mon, Nov 30, 7:00 PM", "an unknown zone falls back to UTC");
	assert.equal(reminders.formatTaskReminderBody({ dueDate: null, dueAt: null, timeZone: null }), "Task due");
	assert.equal(reminders.taskReminderPush({ id: "t", userId: "u1", title: "x".repeat(400), dueDate: null, dueAt: null, timeZone: null }).title.length, 180);
});

test("a reminder run pushes each due task once, to its owner, and survives a failed delivery", async (t) => {
	const { env } = await fixture(t);
	const created = new Date("2026-11-24T12:00:00Z");
	const add = (user, input) => service.createTask(env, user, input, created).then((result) => result.task);
	const timed = await add(kevin, { title: "Timed", due: { date: "2026-11-24", time: "11:00" } });
	const dateOnly = await add(anna, { title: "Date only", due: { date: "2026-11-25", timeZone: "UTC" } });
	const doneBefore = await add(kevin, { title: "Done before", due: { date: "2026-11-24", time: "11:00" } });
	await service.updateTask(env, kevin, doneBefore.id, { completed: true }, created);
	await add(kevin, { title: "No date" });
	await add(kevin, { title: "Later", due: { date: "2026-12-24" } });

	const sent = [];
	const send = async (sentEnv, userIds, content) => {
		assert.equal(sentEnv, env);
		sent.push([userIds, content]);
	};
	await reminders.runTaskReminders(env, new Date("2026-11-24T15:55:00Z"), send);
	assert.deepEqual(sent, [], "nothing is due yet (11:00 New York is 16:00 UTC)");

	await reminders.runTaskReminders(env, new Date("2026-11-24T16:00:00Z"), send);
	assert.deepEqual(sent, [[["u1"], { title: "Timed", body: "Due Tue, Nov 24, 11:00 AM", tag: `task:${timed.id}`, url: `/tasks?task=${timed.id}` }]]);

	await reminders.runTaskReminders(env, new Date("2026-11-24T16:05:00Z"), send);
	assert.equal(sent.length, 1, "already reminded");

	// 09:00 on the due date in the task's zone; a delivery that throws is logged, not rethrown.
	const errors = t.mock.method(console, "error", () => {});
	const failing = async (...args) => { await send(...args); throw new Error("push service down"); };
	await reminders.runTaskReminders(env, new Date("2026-11-25T09:00:00Z"), failing);
	assert.deepEqual(sent[1], [["u2"], { title: "Date only", body: "Due Wed, Nov 25", tag: `task:${dateOnly.id}`, url: `/tasks?task=${dateOnly.id}` }]);
	assert.equal(errors.mock.callCount(), 1);
	await reminders.runTaskReminders(env, new Date("2026-11-25T09:05:00Z"), send);
	assert.equal(sent.length, 2, "a claimed reminder is not sent again");
});

test("a reminder run keeps claiming until the queue is empty, and does nothing before the migration", async (t) => {
	const { env, sqlite } = await fixture(t);
	const created = new Date("2026-11-24T12:00:00Z");
	const list = (await service.listTaskLists(env, kevin)).lists[0];
	const insert = sqlite.prepare("INSERT INTO local_tasks (id, user_id, list_id, title, status, due_date, due_at, time_zone, remind_at, position, created_at, updated_at) VALUES (?, 'u1', ?, ?, 'needs-action', '2026-11-24', ?, 'UTC', ?, ?, ?, ?)");
	const dueAt = Date.parse("2026-11-24T13:00:00Z") / 1000;
	for (let index = 0; index < 450; index += 1) insert.run(`tsk_bulk_${index}`, list.id, `Bulk ${index}`, dueAt, dueAt, `m${String(index).padStart(4, "0")}`, created.getTime() / 1000, created.getTime() / 1000);

	const sent = [];
	await reminders.runTaskReminders(env, new Date("2026-11-24T13:00:00Z"), async (_env, userIds, content) => { sent.push(content.tag); });
	assert.equal(sent.length, 450);
	assert.equal(new Set(sent).size, 450);

	sqlite.exec("DROP TABLE local_tasks; DROP TABLE local_task_lists;");
	await reminders.runTaskReminders(env, new Date("2026-11-25T13:00:00Z"), async () => assert.fail("nothing to send"));
});
