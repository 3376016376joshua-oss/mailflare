import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { JSDOM } from "jsdom";

// The browser side of the local Tasks app (src/lib/tasks): optimistic cache updates, display helpers,
// and the TanStack Query hooks against a fake API.

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
// Inside node_modules so the bundle's external packages (react, @tanstack/react-query) resolve to the test's own copies.
const outDir = mkdtempSync(join(root, "node_modules", "mailflare-local-tasks-client-test-"));
after(() => rmSync(outDir, { recursive: true, force: true }));

await build({
	entryPoints: {
		cache: join(root, "src/lib/tasks/cache-utils.ts"),
		format: join(root, "src/lib/tasks/format.ts"),
		client: join(root, "src/lib/tasks/client.ts"),
	},
	outdir: outDir,
	outExtension: { ".js": ".mjs" },
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node22",
	packages: "external",
	alias: { "@": join(root, "src") },
	logLevel: "silent",
	plugins: [{
		name: "fake-api",
		setup(builder) {
			builder.onResolve({ filter: /^@\/lib\/auth\/client$/ }, () => ({ path: "auth", namespace: "fake" }));
			builder.onLoad({ filter: /.*/, namespace: "fake" }, () => ({ contents: "export function authFetch(path, init) { return globalThis.tasksFetch(String(path), init); }", loader: "js" }));
		},
	}],
});

const load = (name) => import(pathToFileURL(join(outDir, `${name}.mjs`)).href);
const cache = await load("cache");
const format = await load("format");

const CLOCK = { now: new Date("2026-11-24T15:00:00Z"), timeZone: "UTC" };
const LIST = "tl_1";
let counter = 0;
const task = (fields = {}) => ({
	id: `tsk_${++counter}`, listId: LIST, parentId: null, title: "Task", notes: "", status: "needs-action", completedAt: null, dueDate: null, dueAt: null, timeZone: null,
	starred: false, starredAt: null, position: `j${counter.toString(36).padStart(2, "0")}`, message: null, repeat: null, seriesId: null, createdAt: "2026-11-24T10:00:00.000Z", updatedAt: "2026-11-24T10:00:00.000Z", ...fields,
});
const response = (tasks, occurrences = []) => ({ tasks, occurrences, truncated: false, migrationRequired: false });
const titles = (data) => data.tasks.map((item) => item.title);

// ---- Optimistic cache updates ----

test("an optimistic edit mirrors the server's rules", () => {
	const before = task({ title: "Call", dueDate: "2026-11-30", repeat: { freq: "daily", interval: 1, until: null, count: null, index: 4 } });
	const starred = cache.applyTaskUpdate(before, { starred: true, title: "  Call Maya " }, CLOCK);
	assert.deepEqual([starred.title, starred.starred, starred.starredAt], ["Call Maya", true, CLOCK.now.toISOString()]);
	assert.equal(cache.applyTaskUpdate(starred, { starred: true }, { ...CLOCK, now: new Date("2027-01-01T00:00:00Z") }).starredAt, CLOCK.now.toISOString(), "an existing star keeps its time");

	const timed = cache.applyTaskUpdate(before, { due: { date: "2026-12-01", time: "14:00", timeZone: "America/New_York" } }, CLOCK);
	assert.deepEqual([timed.dueDate, timed.dueAt, timed.timeZone, timed.repeat.freq], ["2026-12-01", "2026-12-01T19:00:00.000Z", "America/New_York", "daily"]);
	const cleared = cache.applyTaskUpdate(before, { due: null }, CLOCK);
	assert.deepEqual([cleared.dueDate, cleared.dueAt, cleared.repeat], [null, null, null]);
	assert.equal(cache.applyTaskUpdate(task(), { repeat: { freq: "daily" } }, CLOCK).repeat, null, "no date, no repeat");
	assert.deepEqual(cache.applyTaskUpdate(before, { repeat: { freq: "weekly", count: 3 } }, CLOCK).repeat, { freq: "weekly", interval: 1, until: null, count: 3, index: 0 });

	const done = cache.applyTaskUpdate(before, { completed: true }, CLOCK);
	assert.deepEqual([done.status, done.completedAt], ["completed", CLOCK.now.toISOString()]);
	assert.deepEqual([cache.applyTaskUpdate(done, { completed: false }, CLOCK).status, cache.applyTaskUpdate(done, { completed: false }, CLOCK).completedAt], ["needs-action", null]);
});

test("a changed task shows where it now belongs and leaves where it no longer does", () => {
	const a = task({ title: "A" });
	const b = task({ title: "B" });
	const child = task({ title: "B1", parentId: b.id });
	const list = response([a, b, child]);

	const done = cache.applyTaskUpdate(b, { completed: true }, CLOCK);
	// In the whole list the task and its subtask move to the completed end; in the open-only view they leave.
	const whole = cache.upsertTaskInResponse(list, { listId: LIST }, done, CLOCK, { completeSubtasks: true });
	assert.deepEqual(whole.tasks.map((item) => [item.title, item.status]), [["A", "needs-action"], ["B", "completed"], ["B1", "completed"]]);
	assert.deepEqual(titles(cache.upsertTaskInResponse(list, { listId: LIST, completed: false }, done, CLOCK, { completeSubtasks: true })), ["A"]);
	assert.deepEqual(titles(cache.upsertTaskInResponse(response([]), { listId: LIST, completed: true }, done, CLOCK)), ["B"]);
	assert.deepEqual(titles(cache.upsertTaskInResponse(response([]), { listId: "tl_other" }, done, CLOCK)), []);

	// Starring puts a task into the Starred view, newest star first; unstarring takes it out.
	const old = task({ title: "Old star", starred: true, starredAt: "2026-11-01T00:00:00.000Z" });
	const starredView = cache.upsertTaskInResponse(response([old]), { view: "starred" }, cache.applyTaskUpdate(a, { starred: true }, CLOCK), CLOCK);
	assert.deepEqual(titles(starredView), ["A", "Old star"]);
	assert.deepEqual(titles(cache.upsertTaskInResponse(starredView, { view: "starred" }, cache.applyTaskUpdate(old, { starred: false }, CLOCK), CLOCK)), ["A"]);

	// Dating a task for today moves it into Today, for next week into Upcoming and the matching calendar week.
	const today = cache.applyTaskUpdate(a, { due: { date: "2026-11-24" } }, CLOCK);
	const nextWeek = cache.applyTaskUpdate(a, { due: { date: "2026-12-01", time: "10:00" } }, CLOCK);
	assert.deepEqual(titles(cache.upsertTaskInResponse(response([]), { view: "today" }, today, CLOCK)), ["A"]);
	assert.deepEqual(titles(cache.upsertTaskInResponse(response([today]), { view: "today" }, nextWeek, CLOCK)), []);
	assert.deepEqual(titles(cache.upsertTaskInResponse(response([]), { view: "upcoming" }, nextWeek, CLOCK)), ["A"]);
	assert.deepEqual(titles(cache.upsertTaskInResponse(response([]), { dueFrom: "2026-11-30", dueTo: "2026-12-06" }, nextWeek, CLOCK)), ["A"]);
	assert.deepEqual(titles(cache.upsertTaskInResponse(response([]), { dueFrom: "2026-12-07", dueTo: "2026-12-13" }, nextWeek, CLOCK)), []);
	assert.deepEqual(titles(cache.upsertTaskInResponse(response([]), { messageId: "m1" }, nextWeek, CLOCK)), []);
	assert.deepEqual(titles(cache.upsertTaskInResponse(response([]), { messageId: "m1" }, { ...nextWeek, message: { id: "m1", subject: "s" } }, CLOCK)), ["A"]);
});

test("search results and the Completed view follow a change like every other query", () => {
	const milk = task({ title: "Buy milk", createdAt: "2026-11-20T00:00:00.000Z" });
	const oat = task({ title: "Oat MILK for Maya", dueDate: "2026-11-30" });
	const bread = task({ title: "Buy bread", notes: "and milk if they have it" });
	const results = response([oat, milk]);

	// A task edited into the search appears among its results, in their order; one edited out of it leaves.
	assert.deepEqual(titles(cache.upsertTaskInResponse(results, { q: "milk" }, bread, CLOCK)), ["Oat MILK for Maya", "Buy bread", "Buy milk"]);
	assert.deepEqual(titles(cache.upsertTaskInResponse(results, { q: "milk" }, cache.applyTaskUpdate(milk, { title: "Buy tea" }, CLOCK), CLOCK)), ["Oat MILK for Maya"]);
	assert.deepEqual(titles(cache.upsertTaskInResponse(results, { q: "milk maya" }, cache.applyTaskUpdate(milk, { notes: "Maya asked" }, CLOCK), CLOCK)), ["Oat MILK for Maya", "Buy milk"]);
	// A completed result stays a result, after the open ones.
	const done = cache.applyTaskUpdate(oat, { completed: true }, CLOCK);
	assert.deepEqual(cache.upsertTaskInResponse(results, { q: "milk" }, done, CLOCK).tasks.map((item) => [item.title, item.status]), [["Buy milk", "needs-action"], ["Oat MILK for Maya", "completed"]]);

	// Completing a task puts it at the top of Completed; reopening takes it out.
	const earlier = task({ title: "Earlier", status: "completed", completedAt: "2026-11-01T00:00:00.000Z" });
	const completedView = cache.upsertTaskInResponse(response([earlier]), { view: "completed" }, done, CLOCK);
	assert.deepEqual(titles(completedView), ["Oat MILK for Maya", "Earlier"]);
	assert.deepEqual(titles(cache.upsertTaskInResponse(completedView, { view: "completed" }, cache.applyTaskUpdate(earlier, { completed: false }, CLOCK), CLOCK)), ["Oat MILK for Maya"]);
	assert.deepEqual(titles(cache.upsertTaskInResponse(response([]), { view: "completed" }, milk, CLOCK)), []);
});

test("projected occurrences go with the task they belong to", () => {
	const repeating = task({ title: "Standup", dueDate: "2026-11-24", repeat: { freq: "daily", interval: 1, until: null, count: null, index: 0 } });
	const other = task({ title: "Other", dueDate: "2026-11-25" });
	const occurrences = [{ id: `${repeating.id}@2026-11-25`, taskId: repeating.id, listId: LIST, title: "Standup", starred: false, dueDate: "2026-11-25", dueAt: null, timeZone: null, repeatIndex: 1 }, { id: "tsk_far@2026-11-26", taskId: "tsk_far", listId: LIST, title: "Far", starred: false, dueDate: "2026-11-26", dueAt: null, timeZone: null, repeatIndex: 3 }];
	const week = response([repeating, other], occurrences);
	const query = { dueFrom: "2026-11-23", dueTo: "2026-11-29" };

	const renamed = cache.upsertTaskInResponse(week, query, { ...repeating, title: "Daily standup" }, CLOCK);
	assert.equal(renamed.occurrences.length, 2, "a rename keeps the projection until the refetch");
	const completed = cache.upsertTaskInResponse(week, query, cache.applyTaskUpdate(repeating, { completed: true }, CLOCK), CLOCK, { resetOccurrences: true });
	assert.deepEqual(completed.occurrences.map((item) => item.taskId), ["tsk_far"]);
	const removed = cache.removeTasksFromResponse(week, query, new Set([repeating.id]), CLOCK);
	assert.deepEqual([titles(removed), removed.occurrences.map((item) => item.taskId)], [["Other"], ["tsk_far"]]);
});

test("removing a task removes its subtasks; a created task replaces its pending copy", () => {
	const parent = task({ title: "Parent" });
	const child = task({ title: "Child", parentId: parent.id });
	const other = task({ title: "Other" });
	assert.deepEqual(titles(cache.removeTasksFromResponse(response([parent, child, other]), { listId: LIST }, new Set([parent.id]), CLOCK)), ["Other"]);

	const pending = cache.optimisticTask({ title: " New ", due: { date: "2026-11-24" }, starred: true }, { id: "tmp_1", listId: LIST, siblings: [parent, child, other], clock: CLOCK });
	assert.deepEqual([pending.id, pending.title, pending.listId, pending.dueDate, pending.starred, cache.isPendingId(pending.id)], ["tmp_1", "New", LIST, "2026-11-24", true, true]);
	assert.ok(pending.position < parent.position, "a new task goes to the top");
	const shown = cache.upsertTaskInResponse(response([parent, child, other]), { listId: LIST }, pending, CLOCK);
	assert.deepEqual(titles(shown), ["New", "Parent", "Child", "Other"]);
	const saved = { ...pending, id: "tsk_real", title: "New" };
	assert.deepEqual(cache.upsertTaskInResponse(shown, { listId: LIST }, saved, CLOCK, { replaceId: "tmp_1" }).tasks.map((item) => item.id), ["tsk_real", parent.id, child.id, other.id]);

	const sub = cache.optimisticTask({ title: "Sub", parentId: parent.id }, { id: "tmp_2", listId: undefined, siblings: [parent, child, other], clock: CLOCK });
	assert.deepEqual([sub.listId, sub.parentId, sub.position > child.position], [LIST, parent.id, true]);
	const after = cache.optimisticTask({ title: "After", previousId: parent.id }, { id: "tmp_3", listId: LIST, siblings: [parent, child, other], clock: CLOCK });
	assert.ok(parent.position < after.position && after.position < other.position);
	// Nothing to show yet: no title (it will come from the email), no list known, or the sibling is not loaded.
	assert.equal(cache.optimisticTask({ messageId: "m1" }, { id: "tmp_4", listId: LIST, siblings: [], clock: CLOCK }), null);
	assert.equal(cache.optimisticTask({ title: "x" }, { id: "tmp_5", listId: undefined, siblings: [], clock: CLOCK }), null);
	assert.equal(cache.optimisticTask({ title: "x", previousId: "tsk_unknown" }, { id: "tmp_6", listId: LIST, siblings: [], clock: CLOCK }), null);
	assert.equal(cache.optimisticTask({ title: "x", parentId: "tsk_unknown" }, { id: "tmp_7", listId: LIST, siblings: [], clock: CLOCK }), null);
});

test("an optimistic move takes the dragged task's new place, parent and list", () => {
	const [a, b, c] = [task({ title: "A" }), task({ title: "B" }), task({ title: "C" })];
	const child = task({ title: "A1", parentId: a.id });
	const all = [a, b, c, child];
	const order = (moved) => titles(cache.upsertTaskInResponse(response(all), { listId: LIST }, moved, CLOCK));

	assert.deepEqual(order(cache.applyTaskMove(c, { previousId: a.id }, all)), ["A", "A1", "C", "B"]);
	assert.deepEqual(order(cache.applyTaskMove(c, {}, all)), ["C", "A", "A1", "B"]);
	const nested = cache.applyTaskMove(c, { parentId: a.id, previousId: child.id }, all);
	assert.deepEqual([nested.parentId, order(nested)], [a.id, ["A", "A1", "C", "B"]]);
	assert.equal(cache.applyTaskMove(child, { parentId: null, previousId: b.id }, all).parentId, null);
	assert.equal(cache.applyTaskMove(child, { previousId: null }, all).parentId, a.id, "reordering keeps the parent");

	// To another list: the parent goes to the top level there and its subtasks follow.
	const away = cache.applyTaskMove(a, { listId: "tl_2" }, all);
	assert.deepEqual([away.listId, away.parentId], ["tl_2", null]);
	assert.deepEqual(titles(cache.upsertTaskInResponse(response(all), { listId: LIST }, away, CLOCK)), ["B", "C"]);
	assert.deepEqual(titles(cache.upsertTaskInResponse(response(all), {}, away, CLOCK)), ["A", "A1", "B", "C"]);
	assert.equal(cache.upsertTaskInResponse(response(all), {}, away, CLOCK).tasks.find((item) => item.title === "A1").listId, "tl_2");
	assert.equal(cache.applyTaskMove(child, { listId: "tl_2" }, all).parentId, null, "a subtask moved alone leaves its parent");
	// The sibling to follow is not loaded: the place is the server's to decide.
	assert.equal(cache.applyTaskMove(c, { previousId: "tsk_unknown" }, all).position, c.position);
});

test("open counts and list order follow optimistic changes", () => {
	const lists = [{ id: "tl_1", title: "My Tasks", position: "i0", openCount: 2 }, { id: "tl_2", title: "Home", position: "i1", openCount: 0 }, { id: "tl_3", title: "Work", position: "i2", openCount: 5 }];
	const open = task({ listId: "tl_1" });
	const counts = (result) => result.map((list) => list.openCount);
	assert.deepEqual(counts(cache.adjustOpenCounts(lists, null, open)), [3, 0, 5]);
	assert.deepEqual(counts(cache.adjustOpenCounts(lists, open, null)), [1, 0, 5]);
	assert.deepEqual(counts(cache.adjustOpenCounts(lists, open, { ...open, status: "completed" })), [1, 0, 5]);
	assert.deepEqual(counts(cache.adjustOpenCounts(lists, open, { ...open, listId: "tl_2" })), [1, 1, 5]);
	assert.deepEqual(counts(cache.adjustOpenCounts(lists, open, { ...open, parentId: "tsk_parent" })), [1, 0, 5], "subtasks are not counted");
	assert.deepEqual(counts(cache.adjustOpenCounts(lists, open, { ...open, title: "renamed" })), [2, 0, 5]);
	assert.deepEqual(counts(cache.adjustOpenCounts(lists, { ...open, listId: "tl_2" }, null)), [2, 0, 5], "never below zero");

	const names = (result) => result.map((list) => list.title);
	assert.deepEqual(names(cache.applyListUpdate(lists, "tl_3", { previousId: null })), ["Work", "My Tasks", "Home"]);
	assert.deepEqual(names(cache.applyListUpdate(lists, "tl_1", { previousId: "tl_3", title: " Mine " })), ["Home", "Work", "Mine"]);
	assert.deepEqual(names(cache.applyListUpdate(lists, "tl_1", { previousId: "tl_unknown" })), ["My Tasks", "Home", "Work"]);
	assert.deepEqual(names(cache.applyListUpdate(lists, "tl_unknown", { title: "x" })), ["My Tasks", "Home", "Work"]);
});

// ---- Display ----

const intl = (value, options) => new Intl.DateTimeFormat(undefined, { ...options, timeZone: options.timeZone ?? "UTC" }).format(new Date(value));

test("due labels read relative to today and add the time of a timed task", () => {
	const options = { now: CLOCK.now, timeZone: "UTC" };
	const due = (dueDate, dueAt = null, zone = options) => format.formatTaskDue({ dueDate, dueAt }, undefined, zone);
	assert.equal(due(null), null);
	assert.equal(due("2026-11-24"), "Today");
	assert.equal(due("2026-11-25"), "Tomorrow");
	assert.equal(due("2026-11-23"), "Yesterday");
	assert.equal(due("2026-11-28"), intl("2026-11-28T12:00:00Z", { weekday: "long" }));
	assert.equal(due("2026-11-30"), intl("2026-11-30T12:00:00Z", { weekday: "long" }));
	assert.equal(due("2026-12-01"), intl("2026-12-01T12:00:00Z", { month: "short", day: "numeric" }));
	assert.equal(due("2026-11-20"), intl("2026-11-20T12:00:00Z", { month: "short", day: "numeric" }));
	assert.equal(due("2027-01-05"), intl("2027-01-05T12:00:00Z", { month: "short", day: "numeric", year: "numeric" }));
	assert.equal(due("2026-11-24", "2026-11-24T19:00:00.000Z"), `Today, ${intl("2026-11-24T19:00:00Z", { hour: "numeric", minute: "2-digit" })}`);
	// 23:30 UTC is already tomorrow in Berlin.
	const berlin = { now: CLOCK.now, timeZone: "Europe/Berlin" };
	assert.equal(due("2026-11-24", "2026-11-24T23:30:00.000Z", berlin), `Tomorrow, ${intl("2026-11-24T23:30:00Z", { hour: "numeric", minute: "2-digit", timeZone: "Europe/Berlin" })}`);
});

test("repeat rules and errors are described in words", () => {
	const rule = { freq: "weekly", interval: 1, until: null, count: null };
	assert.equal(format.describeTaskRepeat(rule), "Weekly");
	assert.equal(format.describeTaskRepeat({ ...rule, freq: "daily", interval: 3 }), "Every 3 days");
	assert.equal(format.describeTaskRepeat({ ...rule, freq: "monthly", interval: 2, count: 5 }), "Every 2 months, 5 times");
	assert.equal(format.describeTaskRepeat({ ...rule, freq: "yearly", count: 1 }), "Yearly, 1 time");
	assert.equal(format.describeTaskRepeat({ ...rule, until: "2026-12-31" }), `Weekly, until ${intl("2026-12-31T12:00:00Z", { month: "short", day: "numeric", year: "numeric" })}`);

	assert.match(format.taskErrorMessage({ code: "MIGRATION_REQUIRED", message: "Apply pending database migrations first" }), /database update/);
	assert.equal(format.taskErrorMessage({ code: "NOT_FOUND", message: "Task not found" }), "This task no longer exists.");
	assert.equal(format.taskErrorMessage({ code: "INVALID", message: "A subtask cannot repeat" }), "A subtask cannot repeat");
	assert.equal(format.taskErrorMessage(new Error("network")), "Could not save the change. Please try again.");
	assert.equal(format.taskErrorMessage(null, undefined, "tasks.error.loadFailed"), "Could not load tasks.");
});

// ---- Hooks ----

// The hooks talk to other tabs through one BroadcastChannel, opened on first use and kept; this stand-in
// lets the tests play the other tab (and keeps a real channel from holding the process open).
const channels = [];
globalThis.BroadcastChannel = class {
	constructor() { this.sent = []; this.listeners = new Set(); channels.push(this); }
	postMessage(message) { this.sent.push(message); }
	addEventListener(_type, listener) { this.listeners.add(listener); }
	removeEventListener(_type, listener) { this.listeners.delete(listener); }
};
const NodeCustomEvent = globalThis.CustomEvent;

/** A tiny stand-in for the tasks API, slow enough that optimistic states can be observed. */
function fakeApi() {
	const state = { tasks: [task({ title: "Existing", position: "j00" })], calls: [], fail: null, gates: [], created: 0 };
	const lists = () => [{ id: LIST, title: "My Tasks", position: "i0", openCount: state.tasks.filter((item) => item.status !== "completed" && !item.parentId).length, createdAt: "", updatedAt: "" }];
	const reply = (status, body) => ({ ok: status < 400, status, json: async () => body });
	globalThis.tasksFetch = async (path, init) => {
		const method = init?.method ?? "GET";
		state.calls.push(`${method} ${path}`);
		if (method !== "GET") await new Promise((resolve) => state.gates.push(resolve));
		if (method !== "GET" && state.fail) return reply(state.fail.status, state.fail.body);
		const body = init?.body ? JSON.parse(init.body) : {};
		if (path === "/api/tasks/lists") return reply(200, { lists: lists(), migrationRequired: false });
		if (method === "GET") {
			const completed = new URL(path, "https://mail.test").searchParams.get("completed");
			return reply(200, response(state.tasks.filter((item) => completed === null || (item.status === "completed") === (completed === "1"))));
		}
		if (method === "POST" && path === "/api/tasks") {
			// Newest first, like the service.
			const created = task({ title: body.title, position: `h${"zyxwvu"[state.created++]}` });
			state.tasks.unshift(created);
			return reply(201, { task: created, next: null, removedIds: [] });
		}
		const id = path.split("/")[3];
		const index = state.tasks.findIndex((item) => item.id === id);
		if (method === "DELETE") {
			state.tasks.splice(index, 1);
			return reply(200, { removedIds: [id] });
		}
		state.tasks[index] = { ...state.tasks[index], ...(body.title ? { title: body.title } : {}), ...(body.completed ? { status: "completed", completedAt: "2026-11-24T15:00:00.000Z" } : {}) };
		return reply(200, { task: state.tasks[index], next: null, removedIds: [] });
	};
	return { state, release: () => state.gates.splice(0).forEach((open) => open()) };
}

async function mount() {
	const dom = new JSDOM("<!doctype html><div id='root'></div>", { url: "https://mail.test/" });
	Object.assign(globalThis, { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true });
	// The hooks dispatch on jsdom's window, which only takes jsdom's own events.
	globalThis.CustomEvent = dom.window.CustomEvent;
	dom.window.localStorage.setItem("mailflare-user-time-zone", JSON.stringify({ timeZone: "UTC" }));
	const { createElement, act } = await import("react");
	const { createRoot } = await import("react-dom/client");
	const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
	const client = await load("client");
	// No garbage-collection timers: they would keep the test process alive for minutes.
	const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity }, mutations: { retry: false, gcTime: Infinity } } });
	const hooks = {};
	const events = [];
	const stop = client.onTasksChanged(() => events.push("changed"));
	function Fixture() {
		const lists = client.useTaskLists();
		const open = client.useTasks({ listId: LIST, completed: false });
		Object.assign(hooks, { create: client.useCreateTask(), update: client.useUpdateTask(), remove: client.useDeleteTask() });
		const count = lists.data?.lists[0]?.openCount ?? "-";
		return createElement("div", null, `${count}|${(open.data?.tasks ?? []).map((item) => `${item.title}${client.isPendingId(item.id) ? "*" : ""}`).join(",")}`);
	}
	const reactRoot = createRoot(document.getElementById("root"));
	await act(async () => reactRoot.render(createElement(QueryClientProvider, { client: queryClient }, createElement(Fixture))));
	const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
	await settle();
	const unmount = async () => {
		stop();
		await act(async () => reactRoot.unmount());
		queryClient.clear();
		dom.window.close();
		globalThis.CustomEvent = NodeCustomEvent;
		for (const key of ["window", "document", "IS_REACT_ACT_ENVIRONMENT", "tasksFetch"]) delete globalThis[key];
	};
	return { act, client, queryClient, hooks, events, settle, unmount, text: () => document.body.textContent };
}

test("hooks show a change at once, keep the server's answer, undo a failure and announce it", async () => {
	const api = fakeApi();
	const page = await mount();
	try {
		assert.equal(page.text(), "1|Existing");

		// Create: the task is on screen (pending) and counted before the request returns.
		await page.act(async () => { page.hooks.create.mutate({ title: "New" }); });
		await page.settle();
		assert.equal(page.text(), "2|New*,Existing");
		assert.deepEqual(page.events, []);
		await page.act(async () => api.release());
		await page.settle();
		assert.equal(page.text(), "2|New,Existing");
		assert.deepEqual(page.events, ["changed"]);
		assert.equal(channels.length, 1);
		assert.equal(channels[0].sent.length, 1, "other tabs are told once");

		// Complete: it leaves the open-only view at once.
		const created = api.state.tasks[0];
		await page.act(async () => { page.hooks.update.mutate({ id: created.id, completed: true }); });
		await page.settle();
		assert.equal(page.text(), "1|Existing");
		await page.act(async () => api.release());
		await page.settle();
		assert.equal(page.text(), "1|Existing");

		// A rejected edit goes back to what the server has, and the error names the API's code.
		api.state.fail = { status: 409, body: { error: "Apply pending database migrations first", code: "MIGRATION_REQUIRED" } };
		const existing = api.state.tasks[1];
		let failure;
		await page.act(async () => { page.hooks.update.mutate({ id: existing.id, title: "Renamed" }, { onError: (error) => { failure = error; } }); });
		await page.settle();
		assert.equal(page.text(), "1|Renamed");
		await page.act(async () => api.release());
		await page.settle();
		assert.equal(page.text(), "1|Existing");
		assert.deepEqual([failure.name, failure.code, failure.status], ["TaskRequestError", "MIGRATION_REQUIRED", 409]);
		api.state.fail = null;

		// Delete.
		await page.act(async () => { page.hooks.remove.mutate(existing.id); });
		await page.settle();
		assert.equal(page.text(), "0|");
		await page.act(async () => api.release());
		await page.settle();
		assert.equal(page.text(), "0|");
	} finally {
		await page.unmount();
	}
});

test("overlapping changes refetch once, after the last of them", async () => {
	const api = fakeApi();
	const page = await mount();
	try {
		await page.act(async () => {
			page.hooks.create.mutate({ title: "One" });
			page.hooks.create.mutate({ title: "Two" });
		});
		await page.settle();
		assert.equal(page.text(), "3|Two*,One*,Existing");
		const readsBefore = api.state.calls.filter((call) => call.startsWith("GET")).length;
		await page.act(async () => api.release());
		await page.settle();
		assert.equal(page.text(), "3|Two,One,Existing");
		assert.deepEqual(page.events, ["changed"]);
		assert.equal(api.state.calls.filter((call) => call.startsWith("GET")).length - readsBefore, 2, "one refetch of the lists and one of the tasks");
	} finally {
		await page.unmount();
	}
});

test("tasks changed elsewhere, in this tab or another, are refetched", async () => {
	const api = fakeApi();
	const page = await mount();
	try {
		api.state.tasks.unshift(task({ title: "From the assistant", position: "i5" }));
		await page.act(async () => page.client.notifyTasksChanged());
		await page.settle();
		assert.equal(page.text(), "2|From the assistant,Existing");

		api.state.tasks.unshift(task({ title: "From another tab", position: "ha" }));
		assert.equal(channels[0].listeners.size, 1, "one listener however many hooks are mounted");
		await page.act(async () => { for (const listener of channels[0].listeners) listener({ data: "changed" }); });
		await page.settle();
		assert.equal(page.text(), "3|From another tab,From the assistant,Existing");

		// Mail deleted for good takes the link to it out of its task: a single delete says so, emptying Trash sends a bare event.
		const mailChanged = (detail) => page.act(async () => { window.dispatchEvent(new window.CustomEvent("mailflare:messages-changed", { detail })); });
		const reads = () => api.state.calls.filter((call) => call.startsWith("GET /api/tasks?")).length;
		let before = reads();
		await mailChanged({ kind: "read", messageIds: ["msg_1"], read: true });
		await mailChanged({ kind: "removed", action: "archive", messageIds: ["msg_1"] });
		await page.settle();
		assert.equal(reads(), before, "reading or filing mail does not touch tasks");
		await mailChanged({ kind: "removed", action: "delete", messageIds: ["msg_1"] });
		await page.settle();
		assert.equal(reads(), before + 1);
		before = reads();
		await mailChanged(undefined);
		await page.settle();
		assert.equal(reads(), before + 1);

		let opened;
		const stop = page.client.onTasksOpenPanel((detail) => { opened = detail; });
		page.client.openTasksPanel({ taskId: "tsk_9", listId: LIST });
		assert.deepEqual(opened, { taskId: "tsk_9", listId: LIST });
		// A day, as the calendar's "N tasks" chip asks for.
		page.client.openTasksPanel({ date: "2026-11-24" });
		assert.deepEqual(opened, { date: "2026-11-24" });
		page.client.openTasksPanel();
		assert.deepEqual(opened, {});
		stop();
		assert.equal(page.client.TASKS_CHANGED_EVENT, "mailflare:tasks-changed");
		assert.equal(page.client.TASKS_OPEN_PANEL_EVENT, "mailflare:tasks-open-panel");
	} finally {
		await page.unmount();
	}
});
