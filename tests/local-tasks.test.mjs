import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

// The local Tasks app (src/lib/tasks): pure helpers first, then the service against a migrated SQLite file.

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = mkdtempSync(join(root, "tests", ".tmp-local-tasks-"));
after(() => rmSync(outDir, { recursive: true, force: true }));

await build({
	entryPoints: {
		utils: join(root, "src/lib/tasks/task-utils.ts"),
		schemas: join(root, "src/lib/tasks/schemas.ts"),
		service: join(root, "src/lib/tasks/service.ts"),
		backups: join(root, "src/lib/backups/export.ts"),
		deletion: join(root, "src/lib/accounts/deletion.ts"),
		database: join(root, "server/runtime/sqlite-database.ts"),
		migrate: join(root, "server/runtime/migrate.ts"),
	},
	outdir: outDir,
	outExtension: { ".js": ".mjs" },
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node22",
	tsconfig: join(root, "tsconfig.json"),
	external: ["better-sqlite3", "drizzle-orm", "drizzle-orm/*", "zod"],
	logLevel: "silent",
});

const load = (name) => import(pathToFileURL(join(outDir, `${name}.mjs`)).href);
const utils = await load("utils");
const schemas = await load("schemas");
const service = await load("service");
const backups = await load("backups");
const deletion = await load("deletion");
const { SqliteDatabase } = await load("database");
const { applyMigrations } = await load("migrate");

// ---- Pure helpers ----

test("ranks sort between their neighbours wherever a row is inserted", () => {
	const ranks = [utils.rankBetween(null, null)];
	let seed = 42;
	const random = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
	for (let step = 0; step < 3000; step += 1) {
		const index = Math.floor(random() * (ranks.length + 1));
		const rank = utils.rankBetween(ranks[index - 1] ?? null, ranks[index] ?? null);
		assert.match(rank, /^[0-9a-z]+$/);
		ranks.splice(index, 0, rank);
	}
	for (let index = 1; index < ranks.length; index += 1) assert.ok(ranks[index - 1] < ranks[index], `${ranks[index - 1]} < ${ranks[index]}`);
	assert.equal(new Set(ranks).size, ranks.length);
});

test("adding at the top or the bottom of a list keeps ranks short", () => {
	let top = utils.rankBetween(null, null);
	let bottom = top;
	const seen = [top];
	for (let step = 0; step < 5000; step += 1) {
		const above = utils.rankBetween(null, top);
		const below = utils.rankBetween(bottom, null);
		assert.ok(above < top && below > bottom);
		top = above;
		bottom = below;
		seen.push(above, below);
	}
	// 191 characters is the MySQL key length of the column; counting ranks stay far below it.
	assert.ok(Math.max(...seen.map((rank) => rank.length)) <= 5, `longest rank ${Math.max(...seen.map((rank) => rank.length))}`);
});

test("repeated inserts into one gap grow slowly and stay ordered", () => {
	const low = utils.rankBetween(null, null);
	let high = utils.rankBetween(low, null);
	for (let step = 0; step < 300; step += 1) {
		const middle = utils.rankBetween(low, high);
		assert.ok(low < middle && middle < high);
		high = middle;
	}
	assert.ok(high.length < 100, `rank grew to ${high.length}`);
	assert.throws(() => utils.rankBetween("i5", "i5"), /out of order/);
	assert.throws(() => utils.rankBetween("i5", "i4"), /out of order/);
});

test("dates and times are validated and converted through the task's zone", () => {
	assert.equal(utils.isDateString("2026-02-28"), true);
	for (const bad of ["2026-02-30", "2026-2-3", "20260203", "", null, 20260203]) assert.equal(utils.isDateString(bad), false, String(bad));
	assert.equal(utils.isTimeString("09:05"), true);
	for (const bad of ["9:05", "24:00", "12:60", "", null]) assert.equal(utils.isTimeString(bad), false, String(bad));
	assert.equal(utils.addDays("2026-12-31", 1), "2027-01-01");
	assert.equal(utils.addDays("2028-03-01", -1), "2028-02-29");
	assert.equal(utils.zonedInstant("2026-11-30", "14:00", "America/New_York").toISOString(), "2026-11-30T19:00:00.000Z");
	// Summer time: the same wall clock is an hour earlier in UTC.
	assert.equal(utils.zonedInstant("2026-07-01", "14:00", "America/New_York").toISOString(), "2026-07-01T18:00:00.000Z");
	assert.equal(utils.dateInZone(new Date("2026-11-25T04:30:00Z"), "America/New_York"), "2026-11-24");
	assert.equal(utils.timeInZone(new Date("2026-11-25T04:30:00Z"), "America/New_York"), "23:30");
	assert.equal(utils.startOfDayInZone("2026-11-24", "Asia/Tokyo").toISOString(), "2026-11-23T15:00:00.000Z");
});

test("a timed task reminds at its time, a date-only task at 09:00 in its zone, and never in the past", () => {
	const now = new Date("2026-11-24T12:00:00Z");
	const timed = utils.deriveDue({ date: "2026-11-30", time: "14:00", timeZone: "America/New_York" }, "UTC", now);
	assert.equal(timed.dueDate, "2026-11-30");
	assert.equal(timed.dueAt.toISOString(), "2026-11-30T19:00:00.000Z");
	assert.equal(timed.remindAt.toISOString(), "2026-11-30T19:00:00.000Z");
	assert.equal(timed.timeZone, "America/New_York");

	const dateOnly = utils.deriveDue({ date: "2026-11-30" }, "Europe/Berlin", now);
	assert.equal(dateOnly.dueAt, null);
	assert.equal(dateOnly.timeZone, "Europe/Berlin");
	assert.equal(dateOnly.remindAt.toISOString(), "2026-11-30T08:00:00.000Z");

	// Dated today after 09:00, or in the past: nothing to remind about.
	assert.equal(utils.deriveDue({ date: "2026-11-24" }, "UTC", now).remindAt, null);
	assert.equal(utils.deriveDue({ date: "2026-11-01", time: "10:00" }, "UTC", now).remindAt, null);
	assert.deepEqual(utils.deriveDue(null, "UTC", now), { dueDate: null, dueAt: null, timeZone: null, remindAt: null });
	assert.deepEqual(utils.dueInputOf({ dueDate: "2026-11-30", dueAt: timed.dueAt, timeZone: "America/New_York" }), { date: "2026-11-30", time: "14:00", timeZone: "America/New_York" });
	assert.equal(utils.dueInputOf({ dueDate: null, dueAt: null, timeZone: null }), null);
});

test("a task's local date and overdue state follow the viewer's zone", () => {
	const late = { status: "needs-action", dueDate: "2026-11-24", dueAt: "2026-11-25T04:30:00.000Z" };
	assert.equal(utils.taskLocalDate(late, "America/New_York"), "2026-11-24");
	assert.equal(utils.taskLocalDate(late, "Europe/Berlin"), "2026-11-25");
	assert.equal(utils.taskLocalDate({ dueDate: "2026-11-24", dueAt: null }, "Europe/Berlin"), "2026-11-24");
	assert.equal(utils.isTaskOverdue(late, new Date("2026-11-25T04:00:00Z"), "UTC"), false);
	assert.equal(utils.isTaskOverdue(late, new Date("2026-11-25T05:00:00Z"), "UTC"), true);
	const dateOnly = { status: "needs-action", dueDate: "2026-11-24", dueAt: null };
	assert.equal(utils.isTaskOverdue(dateOnly, new Date("2026-11-24T23:00:00Z"), "UTC"), false, "due today is not overdue");
	assert.equal(utils.isTaskOverdue(dateOnly, new Date("2026-11-25T01:00:00Z"), "UTC"), true);
	assert.equal(utils.isTaskOverdue({ ...dateOnly, status: "completed" }, new Date("2026-12-25T01:00:00Z"), "UTC"), false);
	assert.equal(utils.isTaskOverdue({ status: "needs-action", dueDate: null, dueAt: null }, new Date(), "UTC"), false);
});

test("repeat steps keep the day of month a series started on", () => {
	assert.equal(utils.stepRepeatDate("2026-11-24", "daily", 3, null), "2026-11-27");
	assert.equal(utils.stepRepeatDate("2026-11-24", "weekly", 2, null), "2026-12-08");
	assert.equal(utils.stepRepeatDate("2026-01-31", "monthly", 1, 31), "2026-02-28");
	assert.equal(utils.stepRepeatDate("2026-02-28", "monthly", 1, 31), "2026-03-31");
	assert.equal(utils.stepRepeatDate("2026-11-30", "monthly", 3, 30), "2027-02-28");
	assert.equal(utils.stepRepeatDate("2028-02-29", "yearly", 1, 29), "2029-02-28");
	assert.equal(utils.stepRepeatDate("2029-02-28", "yearly", 3, 29), "2032-02-29");
	assert.equal(utils.repeatAnchorDay("2026-01-31"), 31);
});

test("the next occurrence skips dates that passed and stops at the rule's end", () => {
	const daily = { freq: "daily", interval: 1, until: null, count: null, index: 0, anchorDay: 24 };
	assert.deepEqual(utils.nextRepeatOccurrence("2026-11-24", daily, "2026-11-24"), { dueDate: "2026-11-25", index: 1 });
	// Completed a week late: today's occurrence comes up, and the skipped ones still count.
	assert.deepEqual(utils.nextRepeatOccurrence("2026-11-24", daily, "2026-12-01"), { dueDate: "2026-12-01", index: 7 });
	// Completed early: the series does not jump ahead.
	assert.deepEqual(utils.nextRepeatOccurrence("2026-11-24", daily, "2026-11-01"), { dueDate: "2026-11-25", index: 1 });

	assert.equal(utils.nextRepeatOccurrence("2026-11-24", { ...daily, count: 1 }, "2026-11-24"), null);
	assert.deepEqual(utils.nextRepeatOccurrence("2026-11-24", { ...daily, count: 3, index: 1 }, "2026-11-24"), { dueDate: "2026-11-25", index: 2 });
	assert.equal(utils.nextRepeatOccurrence("2026-11-24", { ...daily, count: 3, index: 2 }, "2026-11-24"), null);
	assert.equal(utils.nextRepeatOccurrence("2026-11-24", { ...daily, count: 5 }, "2026-12-24"), null, "every remaining occurrence already passed");
	assert.deepEqual(utils.nextRepeatOccurrence("2026-11-24", { ...daily, until: "2026-11-25" }, "2026-11-24"), { dueDate: "2026-11-25", index: 1 });
	assert.equal(utils.nextRepeatOccurrence("2026-11-25", { ...daily, until: "2026-11-25", index: 1 }, "2026-11-24"), null);
});

test("occurrences are projected into a window without repeating the task's own date", () => {
	const weekly = { freq: "weekly", interval: 1, until: null, count: null, index: 0, anchorDay: 24 };
	assert.deepEqual(utils.expandRepeatOccurrences("2026-11-24", weekly, "2026-11-24", "2026-12-15"), [
		{ dueDate: "2026-12-01", index: 1 }, { dueDate: "2026-12-08", index: 2 }, { dueDate: "2026-12-15", index: 3 },
	]);
	assert.deepEqual(utils.expandRepeatOccurrences("2026-11-24", weekly, "2027-01-01", "2027-01-10").map((item) => item.dueDate), ["2027-01-05"]);
	assert.deepEqual(utils.expandRepeatOccurrences("2026-11-24", { ...weekly, count: 2 }, "2026-11-01", "2027-01-01").map((item) => item.dueDate), ["2026-12-01"]);
	assert.deepEqual(utils.expandRepeatOccurrences("2026-11-24", { ...weekly, until: "2026-12-07" }, "2026-11-01", "2027-01-01").map((item) => item.dueDate), ["2026-12-01"]);
	assert.equal(utils.expandRepeatOccurrences("2026-11-24", { ...weekly, freq: "daily" }, "2026-11-01", "2028-01-01", 10).length, 10);
});

test("a repeat rule maps to an iCalendar RRULE", () => {
	const rule = { freq: "weekly", interval: 1, until: null, count: null, index: 0, anchorDay: 24 };
	assert.equal(utils.repeatToRRule(rule), "FREQ=WEEKLY");
	assert.equal(utils.repeatToRRule({ ...rule, freq: "daily", interval: 3, until: "2026-12-31" }), "FREQ=DAILY;INTERVAL=3;UNTIL=20261231");
	assert.equal(utils.repeatToRRule({ ...rule, freq: "yearly", count: 5, index: 2 }), "FREQ=YEARLY;COUNT=3");
	assert.equal(utils.repeatToRRule({ ...rule, freq: "monthly", anchorDay: 31 }), "FREQ=MONTHLY;BYMONTHDAY=28,29,30,31;BYSETPOS=-1");
	assert.equal(utils.repeatToRRule({ ...rule, freq: "monthly", anchorDay: 15, interval: 2 }), "FREQ=MONTHLY;INTERVAL=2");
});

test("tasks group into one level of subtasks and sort by due date", () => {
	const flat = [
		{ id: "c", parentId: "a", position: "i2" }, { id: "b", parentId: null, position: "i1" }, { id: "a", parentId: null, position: "i0" },
		{ id: "d", parentId: "a", position: "i1" }, { id: "orphan", parentId: "gone", position: "hz" },
	];
	const tree = utils.buildTaskTree(flat);
	assert.deepEqual(tree.map((node) => [node.id, node.subtasks.map((child) => child.id)]), [["orphan", []], ["a", ["d", "c"]], ["b", []]]);

	const due = [
		{ id: 1, dueDate: null, dueAt: null, position: "i0" },
		{ id: 2, dueDate: "2026-11-25", dueAt: "2026-11-25T10:00:00.000Z", position: "i0" },
		{ id: 3, dueDate: "2026-11-25", dueAt: null, position: "i0" },
		{ id: 4, dueDate: "2026-11-24", dueAt: null, position: "i1" },
		{ id: 5, dueDate: "2026-11-24", dueAt: null, position: "i0" },
	];
	assert.deepEqual([...due].sort((a, b) => utils.compareTasksByDue(a, b)).map((task) => task.id), [5, 4, 3, 2, 1]);
	// 23:30 UTC on the 24th is the 25th in Berlin, after that day's date-only tasks.
	const late = { id: 6, dueDate: "2026-11-24", dueAt: "2026-11-24T23:30:00.000Z", position: "i0" };
	assert.deepEqual([late, ...due].sort((a, b) => utils.compareTasksByDue(a, b, "UTC")).map((task) => task.id), [5, 4, 6, 3, 2, 1]);
	assert.deepEqual([late, ...due].sort((a, b) => utils.compareTasksByDue(a, b, "Europe/Berlin")).map((task) => task.id), [5, 4, 3, 6, 2, 1]);
});

test("input schemas trim, default and reject", () => {
	assert.deepEqual(schemas.createTaskSchema.parse({ title: "  Call Maya  " }), { title: "Call Maya" });
	assert.equal(schemas.createTaskSchema.parse({ title: "x", repeat: { freq: "weekly" } }).repeat.interval, 1);
	for (const bad of [
		{ title: "   " }, { title: "x".repeat(1025) }, { title: "x", notes: "n".repeat(8193) }, { title: "x", due: { date: "2026-02-30" } },
		{ title: "x", due: { date: "2026-02-03", time: "25:00" } }, { title: "x", due: { date: "2026-02-03", timeZone: "Mars/Olympus" } },
		{ title: "x", repeat: { freq: "hourly" } }, { title: "x", repeat: { freq: "daily", interval: 0 } },
		{ title: "x", repeat: { freq: "daily", until: "2026-12-01", count: 3 } },
	]) assert.equal(schemas.createTaskSchema.safeParse(bad).success, false, JSON.stringify(bad).slice(0, 80));
	assert.equal(schemas.taskQuerySchema.safeParse({ view: "someday" }).success, false);
	assert.match(schemas.firstIssue(schemas.createTaskSchema.safeParse({ title: "" }).error), /^title: /);
});

// ---- Service ----

const NOW = new Date("2026-11-24T15:00:00Z");
const seconds = (date) => Math.floor(date.getTime() / 1000);
const kevin = { id: "u1", email: "kevin@example.com", role: "user", timeZone: "UTC" };
const anna = { id: "u2", email: "anna@example.com", role: "user", timeZone: "UTC" };

async function createFixture(t) {
	const database = new SqliteDatabase(join(outDir, `${crypto.randomUUID()}.sqlite`));
	t.after(() => database.db.close());
	await applyMigrations(database, join(root, "drizzle/migrations"));
	const at = seconds(NOW);
	for (const [id, email] of [["u1", "kevin@example.com"], ["u2", "anna@example.com"]]) {
		database.db.prepare("INSERT INTO users (id, email, name, password_hash, created_at) VALUES (?, ?, 'x', 'x', ?)").run(id, email, at);
	}
	database.db.prepare("INSERT INTO domains (id, user_id, hostname, zone_id, created_at) VALUES ('d1', 'u1', 'example.com', 'zone', ?)").run(at);
	database.db.prepare("INSERT INTO mailboxes (id, user_id, domain_id, local_part, created_at) VALUES ('mb1', 'u1', 'd1', 'kevin', ?)").run(at);
	database.db.prepare("INSERT INTO mailboxes (id, user_id, domain_id, local_part, created_at) VALUES ('mb2', 'u2', 'd1', 'anna', ?)").run(at);
	const addMessage = (id, mailboxId, userId, subject) => database.db.prepare(
		"INSERT INTO messages (id, mailbox_id, user_id, direction, from_addr, to_addr, subject, status, created_at) VALUES (?, ?, ?, 'inbound', 'a@example.org', 'b@example.com', ?, 'received', ?)",
	).run(id, mailboxId, userId, subject, at);
	const env = { DB: database };
	const row = (id) => database.db.prepare("SELECT * FROM local_tasks WHERE id = ?").get(id);
	const add = async (input, user = kevin, now = NOW) => (await service.createTask(env, user, input, now)).task;
	const titles = async (query, options = { now: NOW }, user = kevin) => (await service.listTasks(env, user, query, options)).tasks.map((task) => task.title);
	return { env, database, addMessage, row, add, titles };
}

const rejects = (promise, code) => assert.rejects(promise, (error) => error.name === "TaskError" && error.code === code);

test("before migration 9000 reads are empty and writes ask for the migration", async (t) => {
	const { env, database } = await createFixture(t);
	database.db.exec("DROP TABLE local_tasks; DROP TABLE local_task_lists;");
	assert.deepEqual(await service.listTaskLists(env, kevin), { lists: [], migrationRequired: true });
	assert.deepEqual(await service.listTasks(env, kevin, { view: "today" }), { tasks: [], occurrences: [], truncated: false, migrationRequired: true });
	assert.equal(await service.getTask(env, kevin, "tsk_x"), null);
	assert.deepEqual(await service.claimDueTaskReminders(env, NOW), []);
	await rejects(service.createTask(env, kevin, { title: "x" }), "MIGRATION_REQUIRED");
	await rejects(service.createTaskList(env, kevin, { title: "x" }), "MIGRATION_REQUIRED");
	await rejects(service.updateTask(env, kevin, "tsk_x", { title: "y" }), "MIGRATION_REQUIRED");
	await rejects(service.moveTask(env, kevin, "tsk_x", {}), "MIGRATION_REQUIRED");
	await rejects(service.deleteTask(env, kevin, "tsk_x"), "MIGRATION_REQUIRED");
	await rejects(service.deleteTaskList(env, kevin, "tl_x"), "MIGRATION_REQUIRED");
	await rejects(service.clearCompletedTasks(env, kevin, "tl_x"), "MIGRATION_REQUIRED");
});

test("the default list appears once, and lists can be added, renamed, reordered and deleted", async (t) => {
	const { env, add } = await createFixture(t);
	const [first, again] = await Promise.all([service.listTaskLists(env, kevin), service.listTaskLists(env, kevin)]);
	assert.deepEqual(first.lists.map((list) => list.title), ["My Tasks"]);
	assert.equal(first.migrationRequired, false);
	assert.deepEqual(again.lists.map((list) => list.id), first.lists.map((list) => list.id));
	const mine = first.lists[0];

	const home = await service.createTaskList(env, kevin, { title: "Home" });
	const work = await service.createTaskList(env, kevin, { title: "Work" });
	const order = async () => (await service.listTaskLists(env, kevin)).lists.map((list) => list.title);
	assert.deepEqual(await order(), ["My Tasks", "Home", "Work"]);

	await service.updateTaskList(env, kevin, work.id, { previousId: null });
	assert.deepEqual(await order(), ["Work", "My Tasks", "Home"]);
	await service.updateTaskList(env, kevin, work.id, { previousId: home.id, title: "Office" });
	assert.deepEqual(await order(), ["My Tasks", "Home", "Office"]);
	await rejects(service.updateTaskList(env, kevin, work.id, { previousId: work.id }), "INVALID");
	await rejects(service.updateTaskList(env, anna, work.id, { title: "Mine now" }), "NOT_FOUND");

	// Open top-level tasks are counted; subtasks and completed tasks are not.
	const parent = await add({ title: "Paint", listId: home.id });
	await add({ title: "Buy brushes", parentId: parent.id });
	const done = await add({ title: "Measure", listId: home.id });
	await service.updateTask(env, kevin, done.id, { completed: true }, NOW);
	assert.deepEqual((await service.listTaskLists(env, kevin)).lists.map((list) => [list.title, list.openCount]), [["My Tasks", 0], ["Home", 1], ["Office", 0]]);

	await rejects(service.deleteTaskList(env, anna, home.id), "NOT_FOUND");
	await service.deleteTaskList(env, kevin, home.id);
	assert.equal(await service.getTask(env, kevin, parent.id), null, "a list takes its tasks with it");
	await service.deleteTaskList(env, kevin, work.id);
	await rejects(service.deleteTaskList(env, kevin, mine.id), "LAST_LIST");
	assert.deepEqual(await order(), ["My Tasks"]);
});

test("new tasks go to the top, subtasks to the bottom, and nesting stops at one level", async (t) => {
	const { env, add, titles } = await createFixture(t);
	const a = await add({ title: "A" });
	const b = await add({ title: "B" });
	const c = await add({ title: "C", previousId: a.id });
	assert.deepEqual(await titles({ listId: a.listId }), ["B", "A", "C"]);
	assert.equal(a.listId, (await service.listTaskLists(env, kevin)).lists[0].id);

	const s1 = await add({ title: "A1", parentId: a.id });
	const s2 = await add({ title: "A2", parentId: a.id });
	const s0 = await add({ title: "A0", parentId: a.id, previousId: null });
	assert.ok(s0.position < s1.position && s1.position < s2.position);
	assert.equal(s1.listId, a.listId);

	await rejects(add({ title: "too deep", parentId: s1.id }), "INVALID");
	await rejects(add({ title: "x", parentId: "tsk_missing" }), "NOT_FOUND");
	await rejects(add({ title: "x", listId: "tl_missing" }), "NOT_FOUND");
	await rejects(add({ title: "x", previousId: s1.id }), "INVALID");
	await rejects(add({ title: "x", parentId: a.id, repeat: { freq: "daily" }, due: { date: "2026-12-01" } }), "INVALID");
	await rejects(add({ title: "x", repeat: { freq: "daily" } }), "INVALID");
	await rejects(add({ title: "x", due: { date: "2026-12-01" }, repeat: { freq: "daily", until: "2026-11-30" } }), "INVALID");
	await rejects(add({}), "INVALID");

	await service.updateTask(env, kevin, b.id, { completed: true }, NOW);
	await rejects(add({ title: "x", parentId: b.id }), "INVALID");
	// A list reads top to bottom: each task is followed by its subtasks.
	assert.deepEqual(await titles({ listId: a.listId, completed: false }), ["A", "A0", "A1", "A2", "C"]);
	assert.deepEqual(await titles({ listId: a.listId, completed: true }), ["B"]);
	assert.equal(c.parentId, null);
});

test("tasks belong to their user", async (t) => {
	const { env, add, titles } = await createFixture(t);
	const task = await add({ title: "Kevin's" });
	const theirs = await add({ title: "Anna's" }, anna);
	assert.notEqual(task.listId, theirs.listId);
	assert.deepEqual(await titles({}), ["Kevin's"]);
	assert.deepEqual(await titles({}, { now: NOW }, anna), ["Anna's"]);
	assert.equal(await service.getTask(env, anna, task.id), null);
	await rejects(service.updateTask(env, anna, task.id, { title: "taken" }), "NOT_FOUND");
	await rejects(service.moveTask(env, anna, task.id, {}), "NOT_FOUND");
	await rejects(service.deleteTask(env, anna, task.id), "NOT_FOUND");
	await rejects(add({ title: "x", listId: task.listId }, anna), "NOT_FOUND");
	await rejects(add({ title: "x", parentId: task.id }, anna), "NOT_FOUND");
	await rejects(service.moveTask(env, anna, theirs.id, { listId: task.listId }), "NOT_FOUND");
	await rejects(service.moveTask(env, anna, theirs.id, { parentId: task.id }), "NOT_FOUND");
	await rejects(service.clearCompletedTasks(env, anna, task.listId), "NOT_FOUND");
	assert.deepEqual(await titles({ listId: task.listId }, { now: NOW }, anna), []);
});

test("a task made from an email takes its subject and links back while the mail stays readable", async (t) => {
	const { env, database, addMessage, add } = await createFixture(t);
	addMessage("m1", "mb1", "u1", "Cannot access workspace");
	addMessage("m2", "mb2", "u2", "Private to Anna");
	addMessage("m3", "mb1", "u1", "   ");
	const task = await add({ messageId: "m1" });
	assert.equal(task.title, "Cannot access workspace");
	assert.deepEqual(task.message, { id: "m1", subject: "Cannot access workspace" });
	assert.equal((await add({ messageId: "m3" })).title, "(no subject)");
	assert.equal((await add({ title: "Reply to Maya", messageId: "m1" })).title, "Reply to Maya");
	await rejects(add({ messageId: "m2" }), "NOT_FOUND");
	await rejects(add({ messageId: "missing" }), "NOT_FOUND");
	assert.deepEqual((await service.listTasks(env, kevin, { messageId: "m1" })).tasks.map((item) => item.title).sort(), ["Cannot access workspace", "Reply to Maya"]);

	// The mailbox moves to someone else: the task stays, the link no longer shows.
	database.db.prepare("UPDATE mailboxes SET user_id = 'u2' WHERE id = 'mb1'").run();
	assert.equal((await service.getTask(env, kevin, task.id)).message, null);
	database.db.prepare("UPDATE mailboxes SET user_id = 'u1' WHERE id = 'mb1'").run();
	// Purging the mail leaves the task without its link.
	database.db.prepare("DELETE FROM messages WHERE id = 'm1'").run();
	const kept = await service.getTask(env, kevin, task.id);
	assert.equal(kept.title, "Cannot access workspace");
	assert.equal(kept.message, null);
});

test("due dates store a date, an instant only with a time, and the reminder", async (t) => {
	const { env, add, row } = await createFixture(t);
	const dateOnly = await add({ title: "Renew", due: { date: "2026-11-30", timeZone: "Europe/Berlin" } });
	assert.deepEqual([dateOnly.dueDate, dateOnly.dueAt, dateOnly.timeZone], ["2026-11-30", null, "Europe/Berlin"]);
	assert.equal(row(dateOnly.id).remind_at, seconds(new Date("2026-11-30T08:00:00Z")));

	const timed = await add({ title: "Call", due: { date: "2026-11-30", time: "14:00" } }, { ...kevin, timeZone: "America/New_York" });
	assert.deepEqual([timed.dueAt, timed.timeZone], ["2026-11-30T19:00:00.000Z", "America/New_York"]);
	assert.equal(row(timed.id).remind_at, seconds(new Date("2026-11-30T19:00:00Z")));

	// Moving the date re-arms a reminder that was already sent; clearing it removes both.
	await service.claimDueTaskReminders(env, new Date("2026-12-01T00:00:00Z"));
	assert.ok(row(timed.id).reminded_at);
	const moved = (await service.updateTask(env, kevin, timed.id, { due: { date: "2026-12-05", time: "09:30" } }, new Date("2026-12-01T00:00:00Z"))).task;
	assert.equal(moved.dueAt, "2026-12-05T14:30:00.000Z", "an edit without a zone keeps the task's zone");
	assert.equal(row(timed.id).reminded_at, null);
	const cleared = (await service.updateTask(env, kevin, timed.id, { due: null }, NOW)).task;
	assert.deepEqual([cleared.dueDate, cleared.dueAt, cleared.timeZone], [null, null, null]);
	assert.equal(row(timed.id).remind_at, null);
});

test("editing changes only the fields sent; stars remember when they were set", async (t) => {
	const { env, add } = await createFixture(t);
	const task = await add({ title: "Draft", notes: "first", due: { date: "2026-12-01" } });
	const later = new Date(NOW.getTime() + 60_000);
	const starred = (await service.updateTask(env, kevin, task.id, { starred: true }, later)).task;
	assert.deepEqual([starred.title, starred.notes, starred.dueDate, starred.starred, starred.starredAt], ["Draft", "first", "2026-12-01", true, later.toISOString()]);
	const renamed = (await service.updateTask(env, kevin, task.id, { title: "Final", starred: true }, new Date(later.getTime() + 60_000))).task;
	assert.deepEqual([renamed.title, renamed.starredAt], ["Final", later.toISOString()]);
	assert.ok(renamed.updatedAt > task.updatedAt);
	assert.equal((await service.updateTask(env, kevin, task.id, { starred: false }, NOW)).task.starred, false);
	assert.equal((await service.updateTask(env, kevin, task.id, { notes: "" }, NOW)).task.notes, "");
});

test("completing a task completes its subtasks; reopening a subtask of a completed task frees it", async (t) => {
	const { env, add, titles } = await createFixture(t);
	const parent = await add({ title: "Trip" });
	const packed = await add({ title: "Pack", parentId: parent.id });
	const booked = await add({ title: "Book", parentId: parent.id });
	await service.updateTask(env, kevin, booked.id, { completed: true }, new Date(NOW.getTime() - 60_000));

	const done = (await service.updateTask(env, kevin, parent.id, { completed: true }, NOW)).task;
	assert.deepEqual([done.status, done.completedAt], ["completed", NOW.toISOString()]);
	assert.equal((await service.getTask(env, kevin, packed.id)).status, "completed");
	assert.equal((await service.getTask(env, kevin, booked.id)).completedAt, new Date(NOW.getTime() - 60_000).toISOString(), "an earlier completion keeps its time");
	assert.deepEqual(await titles({ listId: parent.listId, completed: false }), []);
	// Completing twice is harmless.
	assert.equal((await service.updateTask(env, kevin, parent.id, { completed: true }, new Date(NOW.getTime() + 5000))).task.completedAt, NOW.toISOString());

	const freed = (await service.updateTask(env, kevin, packed.id, { completed: false }, NOW)).task;
	assert.deepEqual([freed.status, freed.parentId, freed.completedAt], ["needs-action", null, null]);
	assert.equal((await service.getTask(env, kevin, parent.id)).status, "completed");

	const reopened = (await service.updateTask(env, kevin, parent.id, { completed: false }, NOW)).task;
	assert.equal(reopened.status, "needs-action");
	assert.equal((await service.getTask(env, kevin, booked.id)).status, "completed", "reopening a task leaves its subtasks as they were");
	const back = (await service.updateTask(env, kevin, booked.id, { completed: false }, NOW)).task;
	assert.equal(back.parentId, parent.id, "under an open parent a reopened subtask stays put");
});

test("completing a repeating task brings up the next occurrence, which takes over the rule", async (t) => {
	const { env, add, row, titles } = await createFixture(t);
	const user = { ...kevin, timeZone: "America/New_York" };
	const other = await add({ title: "Below" });
	const first = await add({ title: "Standup", notes: "bring notes", starred: true, due: { date: "2026-11-24", time: "09:30" }, repeat: { freq: "weekly", interval: 2 } }, user);
	assert.deepEqual(first.repeat, { freq: "weekly", interval: 2, until: null, count: null, index: 0 });
	assert.equal(first.seriesId, first.id);

	const { task: done, next } = await service.updateTask(env, user, first.id, { completed: true }, NOW);
	assert.deepEqual([done.status, done.repeat, done.seriesId], ["completed", null, first.id]);
	assert.deepEqual([next.title, next.notes, next.starred, next.status, next.listId], ["Standup", "bring notes", true, "needs-action", first.listId]);
	assert.deepEqual([next.dueDate, next.dueAt, next.timeZone], ["2026-12-08", "2026-12-08T14:30:00.000Z", "America/New_York"]);
	assert.deepEqual(next.repeat, { freq: "weekly", interval: 2, until: null, count: null, index: 1 });
	assert.equal(next.seriesId, first.id);
	assert.equal(row(next.id).remind_at, seconds(new Date("2026-12-08T14:30:00Z")));
	assert.ok(first.position < next.position && next.position < other.position, "the next occurrence sits where the completed one was");
	assert.deepEqual(await titles({ listId: first.listId, completed: false }), ["Standup", "Below"]);

	// Undoing the completion takes the untouched next occurrence back and restores the rule.
	const undone = await service.updateTask(env, user, first.id, { completed: false }, NOW);
	assert.deepEqual(undone.removedIds, [next.id]);
	assert.deepEqual(undone.task.repeat, { freq: "weekly", interval: 2, until: null, count: null, index: 0 });
	assert.equal(await service.getTask(env, user, next.id), null);
	assert.deepEqual(await titles({ listId: first.listId }), ["Standup", "Below"]);
});

test("reopening an older occurrence leaves an edited or advanced series alone", async (t) => {
	const { env, add } = await createFixture(t);
	const first = await add({ title: "Water plants", due: { date: "2026-11-24" }, repeat: { freq: "daily" } });
	const second = (await service.updateTask(env, kevin, first.id, { completed: true }, NOW)).next;
	await service.updateTask(env, kevin, second.id, { notes: "the fern too" }, new Date(NOW.getTime() + 1000));
	const reopened = await service.updateTask(env, kevin, first.id, { completed: false }, NOW);
	assert.deepEqual([reopened.removedIds, reopened.task.repeat], [[], null], "an edited next occurrence is kept");
	assert.equal((await service.getTask(env, kevin, second.id)).notes, "the fern too");

	const third = (await service.updateTask(env, kevin, second.id, { completed: true }, NOW)).next;
	assert.equal(third.repeat.index, 2);
	await service.updateTask(env, kevin, first.id, { completed: true }, NOW);
	const again = await service.updateTask(env, kevin, first.id, { completed: false }, NOW);
	assert.deepEqual(again.removedIds, [], "the series moved on past this occurrence");
	assert.ok(await service.getTask(env, kevin, third.id));

	// A next occurrence that got a subtask is somebody's work, not a by-product.
	const fourth = (await service.updateTask(env, kevin, third.id, { completed: true }, NOW)).next;
	await add({ title: "and the cactus", parentId: fourth.id });
	assert.deepEqual((await service.updateTask(env, kevin, third.id, { completed: false }, NOW)).removedIds, []);
});

test("a repeat ends after its count or date, skips missed dates, and follows a moved date", async (t) => {
	const { env, add } = await createFixture(t);
	const twice = await add({ title: "Twice", due: { date: "2026-11-24" }, repeat: { freq: "daily", count: 2 } });
	const second = (await service.updateTask(env, kevin, twice.id, { completed: true }, NOW)).next;
	assert.deepEqual([second.dueDate, second.repeat.index, second.repeat.count], ["2026-11-25", 1, 2]);
	const last = await service.updateTask(env, kevin, second.id, { completed: true }, NOW);
	assert.equal(last.next, null);
	// The final occurrence keeps the rule, so undoing its completion restores a repeating task.
	assert.equal(last.task.repeat.index, 1);
	assert.equal((await service.updateTask(env, kevin, second.id, { completed: false }, NOW)).task.repeat.count, 2);

	const until = await add({ title: "Until", due: { date: "2026-11-24" }, repeat: { freq: "weekly", until: "2026-11-30" } });
	assert.equal((await service.updateTask(env, kevin, until.id, { completed: true }, NOW)).next, null);

	// Not touched for ten days: the next occurrence is today's, not nine overdue ones.
	const neglected = await add({ title: "Neglected", due: { date: "2026-11-24" }, repeat: { freq: "daily" } });
	const caughtUp = (await service.updateTask(env, kevin, neglected.id, { completed: true }, new Date("2026-12-04T10:00:00Z"))).next;
	assert.deepEqual([caughtUp.dueDate, caughtUp.repeat.index], ["2026-12-04", 10]);

	// Monthly on the 31st keeps the 31st through February.
	const monthly = await add({ title: "Rent", due: { date: "2027-01-31" }, repeat: { freq: "monthly" } });
	const feb = (await service.updateTask(env, kevin, monthly.id, { completed: true }, NOW)).next;
	assert.equal(feb.dueDate, "2027-02-28");
	const mar = (await service.updateTask(env, kevin, feb.id, { completed: true }, NOW)).next;
	assert.equal(mar.dueDate, "2027-03-31");
	// Moving the date moves the series: now it repeats on the 5th.
	await service.updateTask(env, kevin, mar.id, { due: { date: "2027-04-05" } }, NOW);
	assert.equal((await service.updateTask(env, kevin, mar.id, { completed: true }, NOW)).next.dueDate, "2027-05-05");
});

test("repeat rules can be set, replaced and removed, within their limits", async (t) => {
	const { env, add } = await createFixture(t);
	const task = await add({ title: "Review", due: { date: "2026-11-24" } });
	const weekly = (await service.updateTask(env, kevin, task.id, { repeat: { freq: "weekly" } }, NOW)).task;
	assert.deepEqual(weekly.repeat, { freq: "weekly", interval: 1, until: null, count: null, index: 0 });
	assert.equal(weekly.seriesId, task.id);
	const next = (await service.updateTask(env, kevin, task.id, { completed: true }, NOW)).next;
	// A replaced rule counts from the occurrence it was set on.
	const counted = (await service.updateTask(env, kevin, next.id, { repeat: { freq: "daily", count: 3 } }, NOW)).task;
	assert.deepEqual(counted.repeat, { freq: "daily", interval: 1, until: null, count: 3, index: 0 });
	assert.equal((await service.updateTask(env, kevin, next.id, { repeat: null }, NOW)).task.repeat, null);
	assert.equal((await service.updateTask(env, kevin, next.id, { completed: true }, NOW)).next, null);

	const undated = await add({ title: "Someday" });
	await rejects(service.updateTask(env, kevin, undated.id, { repeat: { freq: "daily" } }), "INVALID");
	assert.equal((await service.updateTask(env, kevin, undated.id, { due: { date: "2026-12-01" }, repeat: { freq: "daily" } }, NOW)).task.repeat.freq, "daily");
	assert.equal((await service.updateTask(env, kevin, undated.id, { due: null }, NOW)).task.repeat, null, "a task without a date cannot repeat");
	const child = await add({ title: "Child", parentId: undated.id, due: { date: "2026-12-01" } });
	await rejects(service.updateTask(env, kevin, child.id, { repeat: { freq: "daily" } }), "INVALID");
	await rejects(service.updateTask(env, kevin, task.id, { repeat: { freq: "daily" } }), "INVALID");
	await rejects(service.updateTask(env, kevin, next.id, { completed: false, due: { date: "2026-12-10" }, repeat: { freq: "daily", until: "2026-12-01" } }), "INVALID");
});

test("moving reorders, nests one level, and carries subtasks to another list", async (t) => {
	const { env, add, titles } = await createFixture(t);
	const a = await add({ title: "A" });
	const b = await add({ title: "B", previousId: a.id });
	const c = await add({ title: "C", previousId: b.id });
	const listId = a.listId;
	const open = () => titles({ listId, completed: false });
	assert.deepEqual(await open(), ["A", "B", "C"]);

	await service.moveTask(env, kevin, c.id, { previousId: a.id });
	assert.deepEqual(await open(), ["A", "C", "B"]);
	await service.moveTask(env, kevin, b.id, {});
	assert.deepEqual(await open(), ["B", "A", "C"]);
	await rejects(service.moveTask(env, kevin, b.id, { previousId: b.id }), "INVALID");

	// Nest C and B under A; B first.
	await service.moveTask(env, kevin, c.id, { parentId: a.id });
	const nested = (await service.moveTask(env, kevin, b.id, { parentId: a.id, previousId: null })).task;
	assert.equal(nested.parentId, a.id);
	const tree = async () => utils.buildTaskTree((await service.listTasks(env, kevin, { listId: a.listId })).tasks).map((node) => [node.title, node.subtasks.map((child) => child.title)]);
	assert.deepEqual(await tree(), [["A", ["B", "C"]]]);
	// Reordering among subtasks keeps the parent.
	assert.equal((await service.moveTask(env, kevin, b.id, { previousId: c.id })).task.parentId, a.id);
	assert.deepEqual(await tree(), [["A", ["C", "B"]]]);

	const d = await add({ title: "D" });
	await rejects(service.moveTask(env, kevin, a.id, { parentId: d.id }), "INVALID");
	await rejects(service.moveTask(env, kevin, d.id, { parentId: b.id }), "INVALID");
	await rejects(service.moveTask(env, kevin, d.id, { parentId: d.id }), "INVALID");
	await rejects(service.moveTask(env, kevin, d.id, { previousId: b.id }), "INVALID");
	const repeating = await add({ title: "R", due: { date: "2026-12-01" }, repeat: { freq: "daily" } });
	await rejects(service.moveTask(env, kevin, repeating.id, { parentId: d.id }), "INVALID");

	// Un-nest B, then move A (with C) to another list.
	await service.moveTask(env, kevin, b.id, { parentId: null, previousId: a.id });
	assert.deepEqual(await tree(), [["R", []], ["D", []], ["A", ["C"]], ["B", []]]);
	const other = await service.createTaskList(env, kevin, { title: "Other" });
	const moved = (await service.moveTask(env, kevin, a.id, { listId: other.id })).task;
	assert.equal(moved.listId, other.id);
	assert.equal((await service.getTask(env, kevin, c.id)).listId, other.id);
	await rejects(service.moveTask(env, kevin, b.id, { parentId: a.id, listId: listId }), "INVALID");
	// A subtask sent to another list on its own becomes a top-level task there.
	const alone = (await service.moveTask(env, kevin, c.id, { listId })).task;
	assert.deepEqual([alone.listId, alone.parentId], [listId, null]);
	await rejects(service.moveTask(env, kevin, b.id, { listId: "tl_missing" }), "NOT_FOUND");
});

test("smart views: Today holds overdue and today's tasks, Upcoming the later ones, Starred the starred", async (t) => {
	const { env, add, titles } = await createFixture(t);
	await add({ title: "undated" });
	await add({ title: "overdue", due: { date: "2026-11-20" } });
	await add({ title: "today", due: { date: "2026-11-24" }, starred: true });
	await add({ title: "tonight", due: { date: "2026-11-24", time: "23:30" } });
	await add({ title: "tomorrow", due: { date: "2026-11-25" } });
	const later = await add({ title: "later", due: { date: "2026-12-24" }, starred: true }, kevin, new Date(NOW.getTime() + 1000));
	const done = await add({ title: "done today", due: { date: "2026-11-24" }, starred: true });
	await service.updateTask(env, kevin, done.id, { completed: true }, NOW);
	const sub = await add({ title: "sub due today", parentId: later.id, due: { date: "2026-11-24" } });

	assert.deepEqual(await titles({ view: "today" }), ["overdue", "today", "sub due today", "tonight"]);
	assert.deepEqual(await titles({ view: "upcoming" }), ["tomorrow", "later"]);
	assert.deepEqual(await titles({ view: "starred" }), ["later", "today"], "most recently starred first, completed ones gone");
	assert.equal(sub.parentId, later.id);

	// "tonight" is 23:30 UTC, which is half past midnight on the 25th in Berlin: there it is tomorrow's.
	const berlin = { now: NOW, timeZone: "Europe/Berlin" };
	assert.deepEqual(await titles({ view: "today" }, berlin), ["overdue", "today", "sub due today"]);
	assert.deepEqual(await titles({ view: "upcoming" }, berlin), ["tomorrow", "tonight", "later"]);
	// In Tokyo it is already the 25th, so tomorrow's task is today's.
	const tokyo = { now: NOW, timeZone: "Asia/Tokyo" };
	assert.equal(utils.dateInZone(NOW, "Asia/Tokyo"), "2026-11-25");
	assert.deepEqual(await titles({ view: "today" }, tokyo), ["overdue", "today", "sub due today", "tomorrow", "tonight"]);
	assert.deepEqual(await titles({ view: "upcoming" }, tokyo), ["later"]);
	assert.deepEqual(await titles({ view: "today", listId: "tl_other" }), []);
});

test("a due range returns the tasks in it and projects repeating tasks into it", async (t) => {
	const { env, add } = await createFixture(t);
	await add({ title: "before", due: { date: "2026-11-29" } });
	await add({ title: "first day", due: { date: "2026-11-30" } });
	await add({ title: "last day", due: { date: "2026-12-06", time: "22:00" } });
	await add({ title: "after", due: { date: "2026-12-07" } });
	const finished = await add({ title: "finished", due: { date: "2026-12-02" } });
	await service.updateTask(env, kevin, finished.id, { completed: true }, NOW);
	const standup = await add({ title: "standup", due: { date: "2026-11-24", time: "09:00" }, repeat: { freq: "weekly" } });
	await add({ title: "bins", due: { date: "2026-12-03" }, repeat: { freq: "daily", count: 3 } });

	const week = await service.listTasks(env, kevin, { dueFrom: "2026-11-30", dueTo: "2026-12-06" }, { now: NOW });
	assert.deepEqual(week.tasks.map((task) => task.title), ["first day", "bins", "last day", "finished"]);
	assert.deepEqual(week.occurrences.map((item) => [item.title, item.dueDate, item.dueAt]), [
		["standup", "2026-12-01", "2026-12-01T09:00:00.000Z"],
		["bins", "2026-12-04", null],
		["bins", "2026-12-05", null],
	]);
	assert.deepEqual(week.occurrences[0], { id: `${standup.id}@2026-12-01`, taskId: standup.id, listId: standup.listId, title: "standup", starred: false, dueDate: "2026-12-01", dueAt: "2026-12-01T09:00:00.000Z", timeZone: "UTC", repeatIndex: 1 });

	const open = await service.listTasks(env, kevin, { dueFrom: "2026-11-30", dueTo: "2026-12-06", completed: false }, { now: NOW });
	assert.deepEqual(open.tasks.map((task) => task.title), ["first day", "bins", "last day"]);
	assert.equal((await service.listTasks(env, kevin, { dueFrom: "2026-11-30", dueTo: "2026-12-06", completed: true }, { now: NOW })).occurrences.length, 0);
	assert.equal((await service.listTasks(env, kevin, { dueFrom: "2026-11-30" }, { now: NOW })).occurrences.length, 0, "projection needs both ends");

	// 22:00 UTC on the 6th is the 7th in Tokyo, so that week ends without it; the 09:00 standup is 18:00 there.
	const tokyo = await service.listTasks(env, kevin, { dueFrom: "2026-11-30", dueTo: "2026-12-06" }, { now: NOW, timeZone: "Asia/Tokyo" });
	assert.equal(tokyo.tasks.some((task) => task.title === "last day"), false);
	assert.deepEqual(tokyo.occurrences.filter((item) => item.title === "standup").map((item) => item.dueDate), ["2026-12-01"]);

	await rejects(service.listTasks(env, kevin, { dueFrom: "2026-12-06", dueTo: "2026-11-30" }), "INVALID");
	await rejects(service.listTasks(env, kevin, { dueFrom: "2026-01-01", dueTo: "2027-06-01" }), "INVALID");
});

test("a list shows open tasks in order, then completed ones newest first; clearing removes the completed", async (t) => {
	const { env, add, titles } = await createFixture(t);
	const [a, b, c] = [await add({ title: "A" }), await add({ title: "B" }), await add({ title: "C" })];
	await service.updateTask(env, kevin, a.id, { completed: true }, new Date(NOW.getTime() + 1000));
	await service.updateTask(env, kevin, c.id, { completed: true }, new Date(NOW.getTime() + 2000));
	const keep = await add({ title: "D" });
	const child = await add({ title: "D1", parentId: keep.id });
	await service.updateTask(env, kevin, child.id, { completed: true }, new Date(NOW.getTime() + 3000));
	assert.deepEqual(await titles({ listId: a.listId }), ["D", "B", "D1", "C", "A"]);

	assert.deepEqual(await service.clearCompletedTasks(env, kevin, a.listId), { removed: 3 });
	assert.deepEqual(await titles({ listId: a.listId }), ["D", "B"]);
	assert.deepEqual(await service.clearCompletedTasks(env, kevin, a.listId), { removed: 0 });
	assert.equal((await service.listTasks(env, kevin, { listId: a.listId })).truncated, false);
	assert.equal(b.status, "needs-action");
});

test("deleting a task removes its subtasks", async (t) => {
	const { env, add } = await createFixture(t);
	const parent = await add({ title: "Parent" });
	const child = await add({ title: "Child", parentId: parent.id });
	const other = await add({ title: "Other" });
	const { removedIds } = await service.deleteTask(env, kevin, parent.id);
	assert.deepEqual(removedIds.sort(), [parent.id, child.id].sort());
	assert.equal(await service.getTask(env, kevin, child.id), null);
	assert.ok(await service.getTask(env, kevin, other.id));
	await rejects(service.deleteTask(env, kevin, parent.id), "NOT_FOUND");
});

test("deleting an account deletes its lists and tasks", async (t) => {
	const { env, database, add } = await createFixture(t);
	await add({ title: "Kevin's" });
	await add({ title: "Anna's" }, anna);
	database.db.prepare("DELETE FROM mailboxes WHERE user_id = 'u2'").run();
	database.db.prepare("DELETE FROM users WHERE id = 'u2'").run();
	assert.deepEqual(database.db.prepare("SELECT title FROM local_tasks").all().map((row) => row.title), ["Kevin's"]);
	assert.deepEqual(database.db.prepare("SELECT user_id FROM local_task_lists").all().map((row) => row.user_id), ["u1"]);
	assert.equal((await service.listTaskLists(env, kevin)).lists.length, 1);
});

test("deleting an account with a transfer hands its lists and tasks to the chosen account", async (t) => {
	const { env, database, add, titles, addMessage } = await createFixture(t);
	database.db.prepare("UPDATE users SET role = 'admin', is_primary_admin = 1 WHERE id = 'u1'").run();
	database.db.prepare("UPDATE users SET name = 'Anna' WHERE id = 'u2'").run();
	const admin = { ...kevin, role: "admin", isPrimaryAdmin: true };
	addMessage("m2", "mb2", "u2", "Invoice");
	await add({ title: "Kevin's" });
	const dentist = await add({ title: "Book dentist", messageId: "m2" }, anna);
	const work = await service.createTaskList(env, anna, { title: "Work" });
	const report = await add({ title: "Quarterly report", listId: work.id, starred: true, due: { date: "2026-12-01" }, repeat: { freq: "weekly" } }, anna);
	const figures = await add({ title: "Collect figures", parentId: report.id }, anna);
	await service.createTaskList(env, anna, { title: "Empty" });

	assert.deepEqual(await deletion.deleteAccounts(env, admin, { ids: ["u2"], transferToId: "u1" }), { ok: true, deleted: 1 });

	// Kevin's own list stays first; Anna's lists follow in her order, named after her. The empty one is not carried over.
	const { lists } = await service.listTaskLists(env, kevin);
	assert.deepEqual(lists.map((list) => [list.title, list.openCount]), [["My Tasks", 1], ["My Tasks (Anna)", 1], ["Work (Anna)", 1]]);
	assert.ok(lists.every((list, index) => index === 0 || lists[index - 1].position < list.position));
	assert.deepEqual(await titles({ listId: lists[1].id }), ["Book dentist"]);
	assert.deepEqual(await titles({ listId: lists[2].id }), ["Quarterly report", "Collect figures"]);
	const moved = await service.getTask(env, kevin, report.id);
	assert.deepEqual([moved.starred, moved.dueDate, moved.repeat.freq, moved.listId], [true, "2026-12-01", "weekly", lists[2].id]);
	assert.equal((await service.getTask(env, kevin, figures.id)).parentId, report.id);
	assert.deepEqual(await titles({ view: "starred" }), ["Quarterly report"]);
	// Mail stays with the deleted account, so the link to it does not show.
	assert.equal((await service.getTask(env, kevin, dentist.id)).message, null);
	// They are Kevin's tasks now: he can complete one, and the repeat carries on in his list.
	const done = await service.updateTask(env, kevin, report.id, { completed: true }, NOW);
	assert.equal(done.next.listId, lists[2].id);

	// Nothing of the kind is left with the deleted account but its empty list, and its default list id is free again.
	assert.deepEqual(database.db.prepare("SELECT DISTINCT user_id FROM local_tasks").all().map((row) => row.user_id), ["u1"]);
	assert.deepEqual(database.db.prepare("SELECT title FROM local_task_lists WHERE user_id = 'u2'").all().map((row) => row.title), ["Empty"]);
	assert.equal(database.db.prepare("SELECT count(*) AS n FROM local_task_lists WHERE id = 'tl_u2'").get().n, 0);
});

test("deleting an account without a transfer leaves its tasks with it, and a transfer before migration 9000 still deletes", async (t) => {
	const { env, database, add, titles } = await createFixture(t);
	database.db.prepare("UPDATE users SET role = 'admin', is_primary_admin = 1 WHERE id = 'u1'").run();
	const admin = { ...kevin, role: "admin", isPrimaryAdmin: true };
	await add({ title: "Anna's" }, anna);
	assert.deepEqual(await deletion.deleteAccounts(env, admin, { ids: ["u2"] }), { ok: true, deleted: 1 });
	assert.deepEqual(await titles({}, { now: NOW }, anna), ["Anna's"]);
	assert.deepEqual((await service.listTaskLists(env, kevin)).lists.map((list) => list.title), ["My Tasks"]);

	database.db.prepare("UPDATE users SET deleted_at = NULL, disabled = 0 WHERE id = 'u2'").run();
	database.db.exec("DROP TABLE local_tasks; DROP TABLE local_task_lists;");
	assert.deepEqual(await deletion.deleteAccounts(env, admin, { ids: ["u2"], transferToId: "u1" }), { ok: true, deleted: 1 });
});

test("a due reminder is claimed once, and not for completed or long-missed tasks", async (t) => {
	const { env, add, row } = await createFixture(t);
	const call = await add({ title: "Call", due: { date: "2026-11-24", time: "16:00" } });
	const done = await add({ title: "Done", due: { date: "2026-11-24", time: "16:00" } });
	await service.updateTask(env, kevin, done.id, { completed: true }, NOW);
	const tomorrow = await add({ title: "Tomorrow", due: { date: "2026-11-25" } });
	const missed = await add({ title: "Missed", due: { date: "2026-11-24", time: "15:30" } });

	assert.deepEqual(await service.claimDueTaskReminders(env, new Date("2026-11-24T15:55:00Z")).then((list) => list.map((item) => item.title)), ["Missed"]);
	const due = await service.claimDueTaskReminders(env, new Date("2026-11-24T16:00:00Z"));
	assert.deepEqual(due, [{ id: call.id, userId: "u1", title: "Call", dueDate: "2026-11-24", dueAt: new Date("2026-11-24T16:00:00Z"), timeZone: "UTC" }]);
	assert.deepEqual(await service.claimDueTaskReminders(env, new Date("2026-11-24T16:05:00Z")), [], "already claimed");
	assert.equal(row(done.id).reminded_at, null);
	assert.ok(row(missed.id).reminded_at);

	// The date-only task reminds at 09:00; a cron that was down for two days claims it without notifying.
	assert.deepEqual(await service.claimDueTaskReminders(env, new Date("2026-11-27T10:00:00Z")), []);
	assert.ok(row(tomorrow.id).reminded_at);

	// Reopening a task whose reminder still lies ahead arms it again.
	const future = await add({ title: "Future", due: { date: "2026-12-01", time: "10:00" } });
	await service.updateTask(env, kevin, future.id, { completed: true }, NOW);
	await service.updateTask(env, kevin, future.id, { completed: false }, NOW);
	assert.equal(row(future.id).remind_at, seconds(new Date("2026-12-01T10:00:00Z")));
});

test("backups carry lists and tasks, also when a subtask was stored before its parent", async (t) => {
	const source = await createFixture(t);
	source.addMessage("m1", "mb1", "u1", "Invoice");
	const older = await source.add({ title: "Older" });
	const newer = await source.add({ title: "Newer", messageId: "m1", due: { date: "2026-12-01", time: "10:00" }, repeat: { freq: "weekly" }, starred: true });
	const plain = await source.add({ title: "Parent" });
	// The subtask's row is older than its parent's, so a restore inserts it first.
	await service.moveTask(source.env, kevin, older.id, { parentId: plain.id });
	await service.updateTask(source.env, kevin, newer.id, { completed: true }, NOW);
	const snapshot = async (env) => (await service.listTasks(env, kevin, {}, { now: NOW })).tasks;
	const original = await snapshot(source.env);
	assert.equal(original.length, 4);
	const document = await backups.exportDatabaseRecords(source.database);
	assert.deepEqual(JSON.parse(new TextDecoder().decode(document)).tables.local_tasks.length, 4);

	const target = await createFixture(t);
	await target.add({ title: "Replaced by the restore" });
	await backups.restoreDatabaseRecords(target.database, document.buffer);
	assert.deepEqual(await snapshot(target.env), original);
	assert.deepEqual((await service.listTaskLists(target.env, kevin)).lists, (await service.listTaskLists(source.env, kevin)).lists);

	// A database that has not applied migration 9000 yet still backs up, and that backup restores after it.
	const before = await createFixture(t);
	before.database.db.exec("DROP TABLE local_tasks; DROP TABLE local_task_lists;");
	const early = await backups.exportDatabaseRecords(before.database);
	assert.deepEqual(JSON.parse(new TextDecoder().decode(early)).tables.local_tasks, []);
	await backups.restoreDatabaseRecords(target.database, early.buffer);
	assert.deepEqual(await snapshot(target.env), []);
	// The other way round needs the migration first.
	await assert.rejects(backups.restoreDatabaseRecords(before.database, document.buffer), /Apply pending database migrations before restoring local_task_lists, local_tasks/);
});
