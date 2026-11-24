import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { activeAgentToolLabel, agentToolLabel } from "../src/components/agent/utils.ts";
import { loadApp } from "./helpers/real-db.mjs";

// The task tools of the assistant and the MCP server (src/lib/tasks/tools.ts, mcp.ts) on a migrated SQLite
// database. Only the MCP transport is a stand-in.

const { app, newDatabase } = await loadApp("local-tasks-tools", `
	export * as tools from "./src/lib/tasks/tools.ts";
	export * as scopes from "./src/lib/tasks/tool-scopes.ts";
	export * as service from "./src/lib/tasks/service.ts";
	export { registerTaskMcpTools } from "./src/lib/tasks/mcp.ts";
`);
const { tools, scopes, service } = app;

const SEED = `
	INSERT INTO users (id, email, password_hash, name, role, time_zone, created_at) VALUES
		('u1', 'kevin@example.com', 'x', 'Kevin', 'user', 'America/New_York', 1),
		('u2', 'anna@example.com', 'x', 'Anna', 'user', NULL, 1);
	INSERT INTO domains (id, user_id, hostname, zone_id, created_at) VALUES ('d1', 'u1', 'example.com', 'zone', 1);
	INSERT INTO mailboxes (id, user_id, domain_id, local_part, created_at) VALUES
		('mb1', 'u1', 'd1', 'kevin', 1), ('mb-side', 'u1', 'd1', 'side', 1), ('mb2', 'u2', 'd1', 'anna', 1);
	INSERT INTO messages (id, mailbox_id, user_id, direction, from_addr, to_addr, subject, status, created_at) VALUES
		('m1', 'mb1', 'u1', 'inbound', 'a@example.org', 'kevin@example.com', 'Renew the certificate', 'received', 1),
		('m-side', 'mb-side', 'u1', 'inbound', 'a@example.org', 'side@example.com', 'Side project invoice', 'received', 1),
		('m-anna', 'mb2', 'u2', 'inbound', 'a@example.org', 'anna@example.com', 'Private to Anna', 'received', 1);
`;
const kevin = { id: "u1", email: "kevin@example.com", role: "user", timeZone: "America/New_York" };
const anna = { id: "u2", email: "anna@example.com", role: "user", timeZone: null };

async function fixture(t, { user = kevin, emailMailboxIds = ["mb1"], timeZone } = {}) {
	const { env, sqlite } = await newDatabase(t, SEED);
	const context = { env, user, emailMailboxIds, timeZone };
	const run = (name, input, as = context) => tools.runTaskTool(as, name, input);
	return { env, sqlite, context, run };
}

test("tool names, scopes and the mailbox rule agree", () => {
	assert.deepEqual([...tools.TASK_TOOL_NAMES], ["list_task_lists", "list_tasks", "get_task", "create_task", "update_tasks"]);
	assert.deepEqual(Object.keys(tools.taskToolSchemas), [...tools.TASK_TOOL_NAMES]);
	assert.deepEqual(Object.keys(tools.taskToolDescriptions), [...tools.TASK_TOOL_NAMES]);
	assert.equal(tools.TASK_TOOL_NAMES.some((name) => /delete|remove|clear/.test(name)), false, "no delete tool");
	assert.deepEqual(tools.TASK_TOOL_NAMES.map(tools.taskToolScope), ["mcp:tasks-read", "mcp:tasks-read", "mcp:tasks-read", "mcp:tasks-write", "mcp:tasks-write"]);
	assert.equal(scopes.isTaskWriteTool("create_task"), true);
	assert.equal(scopes.isTaskWriteTool("list_tasks"), false);
	assert.equal(scopes.isTaskWriteTool("create_event"), false);
	for (const scope of ["mcp:tasks-read", "mcp:tasks-write", "mcp:calendar-read", "mcp:calendar-write"]) assert.equal(scopes.mcpScopeNeedsMailbox(scope), false, scope);
	for (const scope of ["mcp:read", "mcp:draft", "mcp:organize", "mcp:request-send"]) assert.equal(scopes.mcpScopeNeedsMailbox(scope), true, scope);
});

test("the assistant panel and the key dialog have a text for every task tool and permission", () => {
	const strings = JSON.parse(readFileSync(new URL("../src/lib/i18n/local/tasks-agent.json", import.meta.url), "utf8"));
	const t = (key) => strings[key] ?? `MISSING ${key}`;
	for (const name of tools.TASK_TOOL_NAMES) {
		const texts = [activeAgentToolLabel(name, t), agentToolLabel(name, "running", "", t).label, agentToolLabel(name, "used", "{}", t).label, agentToolLabel(name, "used", "{}", t).description];
		for (const text of texts) assert.doesNotMatch(text, /MISSING|agent\.tool/, `${name}: ${text}`);
		assert.equal(texts[0], strings[`tasks.agent.tool.${name}.running`]);
		assert.equal(texts[2], strings[`tasks.agent.tool.${name}.completed`]);
	}
	for (const scope of scopes.TASK_MCP_SCOPES) {
		const part = scope === "mcp:tasks-read" ? "read" : "write";
		assert.ok(strings[`tasks.agent.scope.${part}.label`] && strings[`tasks.agent.scope.${part}.description`], scope);
	}
});

test("create_task saves at once with a due date in the caller's zone, a repeat rule, a star and a parent", async (t) => {
	const { run, sqlite } = await fixture(t, { timeZone: "Europe/Berlin" });
	const { lists } = await run("list_task_lists", {});
	assert.deepEqual(lists.map((list) => [list.title, list.openTaskCount]), [["My Tasks", 0]]);

	const created = await run("create_task", { title: "  Pay rent  ", notes: "Bank transfer", due: { date: "2027-01-31", time: "09:30" }, repeat: { freq: "monthly" }, starred: true });
	assert.equal(created.status, "created");
	assert.equal(created.task.title, "Pay rent");
	assert.equal(created.task.listId, lists[0].id);
	assert.deepEqual(created.task.due, { date: "2027-01-31", time: "09:30", timeZone: "Europe/Berlin" });
	assert.deepEqual(created.task.repeat, { freq: "monthly", interval: 1, until: null, count: null });
	assert.equal(created.task.starred, true);
	assert.equal(created.task.status, "open");
	assert.equal(created.task.url, `/tasks?task=${created.task.id}`);
	assert.equal(sqlite.prepare("SELECT due_at FROM local_tasks WHERE id = ?").get(created.task.id).due_at, Date.parse("2027-01-31T08:30:00Z") / 1000);

	// Without a caller zone the account's zone is used, and a date alone has no time.
	const { run: plain } = await fixture(t);
	const dateOnly = await plain("create_task", { title: "File taxes", due: { date: "2027-04-15" } });
	assert.deepEqual(dateOnly.task.due, { date: "2027-04-15", timeZone: "America/New_York" });

	const child = await run("create_task", { title: "Find the IBAN", parentTaskId: created.task.id });
	assert.equal(child.task.parentTaskId, created.task.id);
	assert.equal((await run("list_task_lists", {})).lists[0].openTaskCount, 1, "subtasks are not counted");

	await assert.rejects(run("create_task", {}), /Enter a title/);
	await assert.rejects(run("create_task", { title: "x", due: { date: "2027-02-30" } }), /due\.date/);
	await assert.rejects(run("create_task", { title: "x", repeat: { freq: "daily" } }), /needs a date/);
	await assert.rejects(run("create_task", { title: "x", listId: "tl_missing" }), /List not found/);
	await assert.rejects(run("create_task", { title: "x", parentTaskId: child.task.id }), /cannot have subtasks/);
	await assert.rejects(run("create_task", { title: "x", due: { date: "2027-01-01" }, repeat: { freq: "daily", until: "2027-02-01", count: 3 } }), /not both/);
});

test("emailId links the open email, and only inside the caller's mailboxes", async (t) => {
	const { run, context } = await fixture(t);
	const linked = await run("create_task", { emailId: "m1" });
	assert.equal(linked.task.title, "Renew the certificate", "the subject is the default title");
	assert.deepEqual(linked.task.email, { id: "m1", subject: "Renew the certificate", url: "/inbox/m1" });

	// The user can read m-side, but the assistant works in mb1; and nobody links mail they cannot read.
	await assert.rejects(run("create_task", { title: "x", emailId: "m-side" }), /Email not found/);
	await assert.rejects(run("create_task", { emailId: "m-anna" }), /Email not found/);
	await assert.rejects(run("create_task", { emailId: "missing" }), /Email not found/);
	await assert.rejects(run("create_task", { emailId: "m-anna" }, { ...context, emailMailboxIds: ["mb2"] }), /Message not found/, "the service still checks read access");

	// A task linked in the app to mail of another mailbox keeps the link in the app, but tools outside that mailbox do not see it.
	const side = (await service.createTask(context.env, kevin, { title: "Pay it", messageId: "m-side" })).task;
	assert.equal((await run("get_task", { taskId: side.id })).task.email, null);
	assert.equal((await run("get_task", { taskId: side.id }, { ...context, emailMailboxIds: [] })).task.email, null);
	assert.deepEqual((await run("get_task", { taskId: side.id }, { ...context, emailMailboxIds: ["mb1", "mb-side"] })).task.email, { id: "m-side", subject: "Side project invoice", url: "/inbox/m-side" });
	const listed = (await run("list_tasks", {})).tasks;
	assert.deepEqual(listed.map((task) => [task.title, task.email?.id ?? null]), [["Pay it", null], ["Renew the certificate", "m1"]]);
});

test("list_tasks filters by list, view, due range and status, and get_task returns subtasks", async (t) => {
	const { run, context } = await fixture(t);
	const now = new Date();
	const day = (offset) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(new Date(now.getTime() + offset * 86_400_000));
	const work = await service.createTaskList(context.env, kevin, { title: "Work" });
	const add = async (input) => (await run("create_task", input)).task;
	const overdue = await add({ title: "Overdue", due: { date: day(-2) } });
	const today = await add({ title: "Today", due: { date: day(0) }, starred: true });
	const later = await add({ title: "Later", due: { date: day(5) }, listId: work.id });
	const undated = await add({ title: "Undated", listId: work.id });
	const sub = await add({ title: "Sub", parentTaskId: undated.id });
	const done = await add({ title: "Done" });
	await run("update_tasks", { updates: [{ taskId: done.id, completed: true }] });
	const titles = async (input) => (await run("list_tasks", input)).tasks.map((task) => task.title).sort();

	assert.deepEqual(await titles({}), ["Later", "Overdue", "Sub", "Today", "Undated"], "open tasks by default");
	assert.deepEqual(await titles({ status: "completed" }), ["Done"]);
	assert.deepEqual(await titles({ status: "all" }), ["Done", "Later", "Overdue", "Sub", "Today", "Undated"]);
	assert.deepEqual(await titles({ listId: work.id }), ["Later", "Sub", "Undated"]);
	assert.deepEqual(await titles({ view: "today" }), ["Overdue", "Today"]);
	assert.deepEqual(await titles({ view: "upcoming" }), ["Later"]);
	assert.deepEqual(await titles({ view: "starred" }), ["Today"]);
	assert.deepEqual(await titles({ dueFrom: day(0), dueTo: day(7) }), ["Later", "Today"]);
	assert.deepEqual(await titles({ dueTo: day(-1) }), ["Overdue"]);
	await assert.rejects(run("list_tasks", { view: "today", status: "completed" }), /open tasks only/);
	await assert.rejects(run("list_tasks", { listId: "tl_missing" }), /List not found/);
	await assert.rejects(run("list_tasks", { dueFrom: "tomorrow" }), /dueFrom/);

	const limited = await run("list_tasks", { limit: 2 });
	assert.equal(limited.tasks.length, 2);
	assert.equal(limited.truncated, true);
	assert.equal((await run("list_tasks", {})).truncated, false);

	const fetched = (await run("get_task", { taskId: undated.id })).task;
	assert.deepEqual(fetched.subtasks.map((task) => task.title), ["Sub"]);
	assert.deepEqual((await run("get_task", { taskId: sub.id })).task.subtasks, []);
	await assert.rejects(run("get_task", { taskId: "tsk_missing" }), /Task not found/);
	assert.ok(overdue.id && today.id && later.id);
});

test("a due range lists the coming occurrences of a repeating task", async (t) => {
	const { run } = await fixture(t);
	const task = (await run("create_task", { title: "Water plants", due: { date: "2030-03-01" }, repeat: { freq: "weekly" } })).task;
	const result = await run("list_tasks", { dueFrom: "2030-03-01", dueTo: "2030-03-20" });
	assert.deepEqual(result.tasks.map((item) => item.id), [task.id]);
	assert.deepEqual(result.upcomingOccurrences.map((item) => [item.taskId, item.due.date]), [[task.id, "2030-03-08"], [task.id, "2030-03-15"]]);
	assert.equal("upcomingOccurrences" in (await run("list_tasks", {})), false);
});

test("update_tasks edits, completes, reopens, stars and moves, and reports the next occurrence", async (t) => {
	const { run, context } = await fixture(t);
	const work = await service.createTaskList(context.env, kevin, { title: "Work" });
	const add = async (input) => (await run("create_task", input)).task;
	const a = await add({ title: "A" });
	const b = await add({ title: "B" });
	const repeating = await add({ title: "Standup notes", due: { date: "2030-03-01", time: "10:00" }, repeat: { freq: "daily", count: 3 } });

	const edited = await run("update_tasks", { updates: [
		{ taskId: a.id, title: "A2", notes: "n", starred: true, due: { date: "2030-05-01" } },
		{ taskId: b.id, listId: work.id },
	] });
	assert.equal(edited.status, "updated");
	assert.deepEqual(edited.tasks.map((task) => [task.title, task.listId, task.starred, task.due?.date ?? null]), [["A2", a.listId, true, "2030-05-01"], ["B", work.id, false, null]]);

	// Clearing the date, nesting, and placing after a sibling.
	const c = await add({ title: "C", listId: work.id });
	const moved = await run("update_tasks", { updates: [{ taskId: a.id, due: null, listId: work.id, afterTaskId: c.id }, { taskId: b.id, parentTaskId: c.id }] });
	assert.deepEqual(moved.tasks.map((task) => [task.title, task.listId, task.parentTaskId, task.due]), [["A2", work.id, null, null], ["B", work.id, c.id, null]]);
	assert.deepEqual((await run("list_tasks", { listId: work.id })).tasks.map((task) => task.title), ["C", "B", "A2"]);
	const top = await run("update_tasks", { updates: [{ taskId: b.id, parentTaskId: null }] });
	assert.equal(top.tasks[0].parentTaskId, null);

	const completed = await run("update_tasks", { updates: [{ taskId: repeating.id, completed: true }] });
	assert.equal(completed.tasks[0].status, "completed");
	assert.ok(completed.tasks[0].completedAt);
	const next = completed.tasks[0].nextOccurrence;
	assert.equal(next.title, "Standup notes");
	assert.equal(next.status, "open");
	assert.notEqual(next.id, repeating.id);
	assert.equal(next.due.time, "10:00");
	assert.deepEqual(next.repeat, { freq: "daily", interval: 1, until: null, count: 3 });

	const reopened = await run("update_tasks", { updates: [{ taskId: repeating.id, completed: false }] });
	assert.equal(reopened.tasks[0].status, "open");
	assert.deepEqual(reopened.tasks[0].removedTaskIds, [next.id], "the untouched next occurrence is taken back");
});

test("update_tasks checks every update before changing anything, and says how far it got when one fails", async (t) => {
	const { run, sqlite } = await fixture(t);
	const a = (await run("create_task", { title: "A" })).task;
	const b = (await run("create_task", { title: "B" })).task;
	const title = (id) => sqlite.prepare("SELECT title FROM local_tasks WHERE id = ?").get(id).title;

	await assert.rejects(run("update_tasks", { updates: [{ taskId: a.id, title: "changed" }, { taskId: "tsk_missing", title: "x" }] }), /Task not found/);
	await assert.rejects(run("update_tasks", { updates: [{ taskId: a.id, title: "changed" }, { taskId: a.id, starred: true }] }), /each task ID once/);
	await assert.rejects(run("update_tasks", { updates: [{ taskId: a.id, title: "changed" }, { taskId: b.id }] }), /nothing to change/);
	await assert.rejects(run("update_tasks", { updates: [] }), /updates/);
	await assert.rejects(run("update_tasks", { updates: Array.from({ length: 21 }, () => ({ taskId: a.id, starred: true })) }), /updates/);
	assert.equal(title(a.id), "A", "nothing was applied");

	// A rule only the service knows (a repeat needs a date) fails on the second item: the first one stays applied and the error says so.
	await assert.rejects(
		run("update_tasks", { updates: [{ taskId: a.id, title: "A2" }, { taskId: b.id, repeat: { freq: "daily" } }] }),
		(error) => error.message.includes(`Task ${b.id}`) && /needs a date/.test(error.message) && /1 earlier update was applied/.test(error.message),
	);
	assert.equal(title(a.id), "A2");
});

test("tools act on the caller's own tasks only", async (t) => {
	const { run, context } = await fixture(t);
	const mine = (await run("create_task", { title: "Mine" })).task;
	const asAnna = { ...context, user: anna, emailMailboxIds: ["mb2"] };
	assert.deepEqual((await run("list_tasks", {}, asAnna)).tasks, []);
	await assert.rejects(run("get_task", { taskId: mine.id }, asAnna), /Task not found/);
	await assert.rejects(run("update_tasks", { updates: [{ taskId: mine.id, completed: true }] }, asAnna), /Task not found/);
	await assert.rejects(run("create_task", { title: "x", listId: mine.listId }, asAnna), /List not found/);
	await assert.rejects(run("create_task", { title: "x", parentTaskId: mine.id }, asAnna), /Parent task not found/);
	await assert.rejects(run("list_tasks", { listId: mine.listId }, asAnna), /List not found/);
});

test("before migration 9000 every tool asks for the database update", async (t) => {
	const { run, sqlite } = await fixture(t);
	sqlite.exec("DROP TABLE local_tasks; DROP TABLE local_task_lists;");
	for (const [name, input] of [["list_task_lists", {}], ["list_tasks", {}], ["get_task", { taskId: "tsk_x" }], ["create_task", { title: "x" }], ["update_tasks", { updates: [{ taskId: "tsk_x", starred: true }] }]]) {
		await assert.rejects(run(name, input), /database update/, name);
	}
});

test("the assistant gets every task tool, limited to the mailbox it works in", async (t) => {
	const { env } = await fixture(t);
	const chat = tools.taskChatTools({ env, user: kevin, mailboxId: "mb1", origin: "chat", timeZone: "Asia/Tokyo" });
	assert.deepEqual(Object.keys(chat), [...tools.TASK_TOOL_NAMES]);
	for (const name of tools.TASK_TOOL_NAMES) assert.ok(chat[name].description && chat[name].inputSchema === tools.taskToolSchemas[name], name);
	const created = await chat.create_task.execute({ emailId: "m1", due: { date: "2030-06-01", time: "08:00" } });
	assert.equal(created.task.email.id, "m1");
	assert.equal(created.task.due.timeZone, "Asia/Tokyo", "a time without a zone is the chat's local time");
	await assert.rejects(chat.create_task.execute({ emailId: "m-side" }), /Email not found/);
	assert.equal((await chat.list_tasks.execute({})).tasks.length, 1);
});

// ---- MCP ----

function mcpServer(env, principal) {
	const server = { tools: new Map(), registerTool(name, config, handler) { this.tools.set(name, { config, handler }); } };
	app.registerTaskMcpTools(server, env, principal);
	const call = async (name, args) => {
		const result = await server.tools.get(name).handler(args);
		return { data: JSON.parse(result.content[0].text), isError: !!result.isError };
	};
	return { server, call };
}

test("MCP task tools need their own scopes and mark what they return as untrusted", async (t) => {
	const { env } = await fixture(t);
	const audit = t.mock.method(console, "info", () => {});
	const principal = (scopes, mailboxIds = []) => ({ keyId: "key", user: kevin, scopes, mailboxIds });

	const { server, call } = mcpServer(env, principal(["mcp:tasks-read", "mcp:tasks-write"]));
	assert.deepEqual([...server.tools.keys()], [...tools.TASK_TOOL_NAMES]);
	assert.deepEqual([...server.tools.values()].map(({ config }) => config.annotations.readOnlyHint), [true, true, true, false, false]);
	assert.equal([...server.tools.values()].every(({ config }) => config.annotations.destructiveHint === false && config.description && config.inputSchema), true);

	const created = await call("create_task", { title: "From MCP", due: { date: "2030-01-02" } });
	assert.equal(created.isError, false, JSON.stringify(created.data));
	assert.equal(created.data.contentTrust, "untrusted_third_party_content");
	assert.equal(created.data.task.title, "From MCP");
	const listed = await call("list_tasks", {});
	assert.deepEqual(listed.data.tasks.map((task) => task.title), ["From MCP"]);
	assert.deepEqual(await call("get_task", { taskId: "tsk_missing" }), { data: { error: "Task not found" }, isError: true });

	const readOnly = mcpServer(env, principal(["mcp:tasks-read"]));
	assert.equal((await readOnly.call("list_task_lists", {})).isError, false);
	assert.deepEqual(await readOnly.call("create_task", { title: "x" }), { data: { error: "Permission denied" }, isError: true });
	assert.deepEqual(await readOnly.call("update_tasks", { updates: [{ taskId: created.data.task.id, completed: true }] }), { data: { error: "Permission denied" }, isError: true });

	// Other MCP permissions give no access to tasks.
	const mailOnly = mcpServer(env, principal(["mcp:read", "mcp:organize", "mcp:calendar-read", "mcp:calendar-write"], ["mb1"]));
	for (const name of tools.TASK_TOOL_NAMES) assert.deepEqual(await mailOnly.call(name, {}), { data: { error: "Permission denied" }, isError: true }, name);
	assert.equal((await service.listTasks(env, kevin, {})).tasks.length, 1);
	// One audit line per permitted call, in the format of the mail and calendar tools.
	assert.deepEqual(audit.mock.calls.map((call) => JSON.parse(call.arguments[0])).slice(0, 2), [{ audit: "mcp", tool: "create_task", userId: "u1" }, { audit: "mcp", tool: "list_tasks", userId: "u1" }]);
	assert.equal(audit.mock.callCount(), 4, "denied calls are not audited as tool use");
});

test("an MCP key links and sees emails only with mail read access to that mailbox", async (t) => {
	const { env } = await fixture(t);
	t.mock.method(console, "info", () => {});
	const principal = (scopes, mailboxIds) => ({ keyId: "key", user: kevin, scopes, mailboxIds });
	const task = (await service.createTask(env, kevin, { messageId: "m1" })).task;

	const withMail = mcpServer(env, principal(["mcp:tasks-read", "mcp:tasks-write", "mcp:read"], ["mb1"]));
	assert.equal((await withMail.call("get_task", { taskId: task.id })).data.task.email.subject, "Renew the certificate");
	assert.equal((await withMail.call("create_task", { emailId: "m1" })).isError, false);
	assert.deepEqual(await withMail.call("create_task", { emailId: "m-side" }), { data: { error: "Email not found" }, isError: true });

	// Mailboxes on the key without the mail read permission, and task-only keys, never see mail subjects through a link.
	for (const key of [principal(["mcp:tasks-read", "mcp:tasks-write", "mcp:draft"], ["mb1"]), principal(["mcp:tasks-read", "mcp:tasks-write"], [])]) {
		const { call } = mcpServer(env, key);
		assert.equal((await call("get_task", { taskId: task.id })).data.task.email, null);
		assert.deepEqual(await call("create_task", { emailId: "m1" }), { data: { error: "Email not found" }, isError: true });
	}
});
