import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

// The pure rules behind the Tasks screens (src/components/tasks): where a dragged or keyboard-moved task
// lands, which list or view a URL names, how a smart view is cut into sections, and what the date,
// time and repeat form sends. The screens themselves are covered by tests/e2e/local-tasks-ui.spec.ts.

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = mkdtempSync(join(root, "node_modules", "mailflare-local-tasks-ui-test-"));
after(() => rmSync(outDir, { recursive: true, force: true }));

await build({
	entryPoints: { order: join(root, "src/components/tasks/task-order-utils.ts"), view: join(root, "src/components/tasks/task-view-utils.ts") },
	outdir: outDir,
	outExtension: { ".js": ".mjs" },
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node22",
	packages: "external",
	alias: { "@": join(root, "src") },
	logLevel: "silent",
});

const load = (name) => import(pathToFileURL(join(outDir, `${name}.mjs`)).href);
const order = await load("order");
const view = await load("view");

let counter = 0;
const task = (fields = {}) => ({
	id: `tsk_${++counter}`, listId: "tl_1", parentId: null, title: "Task", notes: "", status: "needs-action", completedAt: null, dueDate: null, dueAt: null, timeZone: null,
	starred: false, starredAt: null, position: `j${counter.toString(36).padStart(2, "0")}`, message: null, repeat: null, seriesId: null, createdAt: "2026-11-24T10:00:00.000Z", updatedAt: "2026-11-24T10:00:00.000Z", ...fields,
});

// A list as it reads on screen: a, b (with subtasks b1, b2), c, d (repeating).
const row = (id, parentId = null, extra = {}) => ({ id, parentId, canNest: true, canParent: parentId === null, ...extra });
const ROWS = [row("a"), row("b", null, { canNest: false }), row("b1", "b"), row("b2", "b"), row("c"), row("d", null, { canNest: false })];
const drop = (id, index, depth) => order.resolveTaskDrop(ROWS, id, index, depth);
const spot = (target) => target && { parentId: target.parentId, previousId: target.previousId };

// ---- Order: drag ----

test("the rows of a tree know what may nest and what may take subtasks", () => {
	const parent = { ...task({ id: "p" }), subtasks: [task({ id: "s", parentId: "p" })] };
	const repeating = { ...task({ id: "r", repeat: { freq: "daily", interval: 1, until: null, count: null, index: 0 } }), subtasks: [] };
	const pending = { ...task({ id: "tmp_1" }), subtasks: [] };
	assert.deepEqual(order.flattenTaskRows([parent, repeating, pending]), [
		{ id: "p", parentId: null, canNest: false, canParent: true },
		{ id: "s", parentId: "p", canNest: true, canParent: false },
		{ id: "r", parentId: null, canNest: false, canParent: true },
		{ id: "tmp_1", parentId: null, canNest: false, canParent: false },
	]);
});

test("a task whose subtasks are all completed still cannot nest, and nothing is placed after a task being created", () => {
	// Only open subtasks are in the tree; the service counts completed ones too.
	const parent = { ...task({ id: "p" }), subtasks: [] };
	assert.equal(order.flattenTaskRows([parent], new Set(["p"]))[0].canNest, false);
	assert.equal(order.flattenTaskRows([parent])[0].canNest, true);
	assert.equal(order.dropNeedsPendingTask({ parentId: null, previousId: "tmp_1" }), true);
	assert.equal(order.dropNeedsPendingTask({ parentId: "tmp_1", previousId: null }), true);
	assert.equal(order.dropNeedsPendingTask({ parentId: "a", previousId: "b" }), false);
	assert.equal(order.dropNeedsPendingTask({ parentId: null, previousId: null }), false);
});

test("a task dropped at the top level follows the top-level task above it", () => {
	// Rows that stay while "c" is dragged: a, b, b1, b2, d.
	assert.deepEqual(spot(drop("c", 0, 0)), { parentId: null, previousId: null });
	assert.deepEqual(spot(drop("c", 1, 0)), { parentId: null, previousId: "a" });
	assert.deepEqual(spot(drop("c", 4, 0)), { parentId: null, previousId: "b" }, "below the last subtask of b, the sibling above is b");
	assert.deepEqual(spot(drop("c", 99, 0)), { parentId: null, previousId: "d" }, "an index past the end means the end");
});

test("dragging to the right nests under the task above, in order among its subtasks", () => {
	assert.deepEqual(drop("c", 1, 1), { index: 1, depth: 1, parentId: "a", previousId: null });
	assert.deepEqual(drop("c", 4, 1), { index: 4, depth: 1, parentId: "b", previousId: "b2" });
	assert.equal(drop("c", 0, 1).depth, 0, "nothing above to nest under");
});

test("a gap inside a group of subtasks only takes a subtask", () => {
	assert.deepEqual(drop("c", 2, 0), { index: 2, depth: 1, parentId: "b", previousId: null }, "between b and its first subtask");
	assert.deepEqual(drop("c", 3, 0), { index: 3, depth: 1, parentId: "b", previousId: "b1" });
});

test("a task that cannot nest snaps to the nearer edge of the group instead of splitting it", () => {
	// "d" repeats, so it never becomes a subtask. Rows that stay: a, b, b1, b2, c.
	assert.deepEqual(drop("d", 2, 1), { index: 1, depth: 0, parentId: null, previousId: "a" }, "nearer the top of b's group: above b");
	assert.deepEqual(drop("d", 3, 1), { index: 4, depth: 0, parentId: null, previousId: "b" }, "nearer the bottom: below the group");
	assert.equal(drop("d", 1, 1).depth, 0, "and it never nests in an open gap either");
});

test("a parent travels with its subtasks and stays at the top level", () => {
	// Rows that stay while "b" is dragged: a, c, d.
	assert.deepEqual(order.rowsWithoutDragged(ROWS, "b").map((item) => item.id), ["a", "c", "d"]);
	assert.deepEqual(drop("b", 2, 1), { index: 2, depth: 0, parentId: null, previousId: "c" });
});

test("a subtask leaves its parent when dragged left, and joins another when dropped under it", () => {
	// Rows that stay while "b1" is dragged: a, b, b2, c, d.
	assert.deepEqual(spot(drop("b1", 3, 0)), { parentId: null, previousId: "b" }, "below b's remaining subtask, at the top level");
	assert.deepEqual(spot(drop("b1", 1, 1)), { parentId: "a", previousId: null });
	assert.deepEqual(spot(drop("b1", 3, 1)), { parentId: "b", previousId: "b2" });
});

test("nothing nests under a task that is still being created", () => {
	const rows = [row("tmp_1", null, { canParent: false }), row("x")];
	assert.equal(order.resolveTaskDrop(rows, "x", 1, 1).depth, 0);
	assert.equal(order.resolveTaskDrop(rows, "missing", 0, 0), null);
});

test("a drop where the task already is asks for nothing", () => {
	assert.equal(order.isSameTaskSpot(ROWS, "c", spot(drop("c", 4, 0))), true);
	assert.equal(order.isSameTaskSpot(ROWS, "b2", { parentId: "b", previousId: "b1" }), true);
	assert.equal(order.isSameTaskSpot(ROWS, "c", spot(drop("c", 1, 0))), false);
	assert.equal(order.isSameTaskSpot(ROWS, "c", spot(drop("c", 4, 1))), false, "same place on screen, but nested");
});

// ---- Order: keyboard ----

test("arrow keys move a task among its siblings", () => {
	const move = (id, direction) => order.keyboardTaskMove(ROWS, id, direction);
	assert.deepEqual(move("c", "up"), { parentId: null, previousId: "a" });
	assert.deepEqual(move("b", "up"), { parentId: null, previousId: null });
	assert.equal(move("a", "up"), null);
	assert.deepEqual(move("a", "down"), { parentId: null, previousId: "b" });
	assert.equal(move("d", "down"), null);
	assert.deepEqual(move("b1", "down"), { parentId: "b", previousId: "b2" });
	assert.equal(move("b1", "up"), null);
});

test("right nests under the task above as its last subtask, left returns below the former parent", () => {
	const move = (id, direction) => order.keyboardTaskMove(ROWS, id, direction);
	assert.deepEqual(move("c", "in"), { parentId: "b", previousId: "b2" });
	assert.equal(move("a", "in"), null, "nothing above");
	assert.equal(move("b", "in"), null, "it has subtasks");
	assert.equal(move("d", "in"), null, "it repeats");
	assert.equal(move("b1", "in"), null, "already a subtask");
	assert.deepEqual(move("b2", "out"), { parentId: null, previousId: "b" });
	assert.equal(move("c", "out"), null);
	assert.equal(move("missing", "up"), null);
});

// ---- Order: lists ----

test("lists reorder by drop position and by keyboard", () => {
	const ids = ["l1", "l2", "l3"];
	assert.deepEqual(order.resolveListDrop(ids, "l3", 0), { index: 0, previousId: null });
	assert.deepEqual(order.resolveListDrop(ids, "l1", 2), { index: 2, previousId: "l3" });
	assert.equal(order.resolveListDrop(ids, "missing", 0), null);
	assert.equal(order.isSameListSpot(ids, "l2", "l1"), true);
	assert.equal(order.isSameListSpot(ids, "l1", null), true);
	assert.equal(order.isSameListSpot(ids, "l3", "l1"), false);
	assert.equal(order.keyboardListMove(ids, "l3", "up"), "l1");
	assert.equal(order.keyboardListMove(ids, "l2", "up"), null);
	assert.equal(order.keyboardListMove(ids, "l1", "up"), undefined);
	assert.equal(order.keyboardListMove(ids, "l1", "down"), "l2");
	assert.equal(order.keyboardListMove(ids, "l3", "down"), undefined);
});

// ---- What is on screen ----

test("the URL names a view, a day, a list, or falls back to the first list", () => {
	const ids = ["l1", "l2"];
	assert.deepEqual(view.resolveTaskScope({ view: "today", list: "l2" }, ids), { kind: "view", view: "today" });
	assert.deepEqual(view.resolveTaskScope({ view: "nonsense", list: "l2" }, ids), { kind: "list", listId: "l2" });
	assert.deepEqual(view.resolveTaskScope({ view: null, list: "deleted" }, ids), { kind: "list", listId: "l1" });
	assert.equal(view.resolveTaskScope({ view: null, list: null }, []), null);
	assert.deepEqual(view.resolveTaskScope({ view: null, date: "2026-11-24", list: "l2" }, ids), { kind: "date", date: "2026-11-24" });
	assert.deepEqual(view.resolveTaskScope({ view: "starred", date: "2026-11-24", list: null }, ids), { kind: "view", view: "starred" });
	assert.deepEqual(view.resolveTaskScope({ view: null, date: "2026-02-30", list: "l2" }, ids), { kind: "list", listId: "l2" }, "not a date");
	assert.equal(view.taskScopeHref({ kind: "list", listId: "l 1" }), "/tasks?list=l+1");
	assert.equal(view.taskScopeHref({ kind: "view", view: "upcoming" }, "tsk_9"), "/tasks?view=upcoming&task=tsk_9");
	assert.equal(view.taskScopeHref({ kind: "date", date: "2026-11-24" }), "/tasks?date=2026-11-24");
	assert.equal(view.taskScopeHref(null), "/tasks");
	assert.deepEqual(view.taskScopeQuery({ kind: "view", view: "starred" }), { view: "starred" });
	assert.deepEqual(view.taskScopeQuery({ kind: "list", listId: "l1" }), { listId: "l1" });
	// A day is the window the calendar asks for, one day long.
	assert.deepEqual(view.taskScopeQuery({ kind: "date", date: "2026-11-24" }), { dueFrom: "2026-11-24", dueTo: "2026-11-24" });
	assert.deepEqual([{ kind: "list", listId: "l1" }, { kind: "view", view: "today" }, { kind: "date", date: "2026-11-24" }].map(view.taskScopeKey), ["l1", "today", "2026-11-24"]);
});

test("a search is part of the address and covers the list, view or day under it", () => {
	const ids = ["l1", "l2"];
	assert.deepEqual(view.resolveTaskScope({ view: "today", list: "l2", q: "  call   Maya " }, ids), { kind: "search", text: "call Maya" });
	assert.deepEqual(view.resolveTaskScope({ view: null, list: null, q: "milk" }, []), { kind: "search", text: "milk" }, "a search needs no list");
	assert.deepEqual(view.resolveTaskScope({ view: "today", list: "l2", q: "   " }, ids), { kind: "view", view: "today" }, "only spaces: no search");
	assert.deepEqual(view.resolveTaskScope({ view: "completed", list: null }, ids), { kind: "view", view: "completed" });
	assert.equal(view.normalizeTaskSearch(`  ${"x".repeat(250)}`).length, 200);
	assert.equal(view.normalizeTaskSearch(null), "");

	assert.equal(view.taskScopeHref({ kind: "search", text: "call Maya" }), "/tasks?q=call+Maya");
	assert.deepEqual(view.taskScopeQuery({ kind: "search", text: "call Maya" }), { q: "call Maya" });
	assert.deepEqual(view.taskScopeQuery({ kind: "view", view: "completed" }), { view: "completed" });
	// Searching keeps where the user was, and clearing the search goes back there. A task to focus is not carried along.
	assert.equal(view.taskSearchHref("list=l2", " milk "), "/tasks?list=l2&q=milk");
	assert.equal(view.taskSearchHref("view=today&q=mil&task=tsk_1", "milk"), "/tasks?view=today&q=milk");
	assert.equal(view.taskSearchHref("list=l2&q=milk", ""), "/tasks?list=l2");
	assert.equal(view.taskSearchHref("q=milk", "  "), "/tasks");

	// Each search is its own scope, but the list on screen is kept while the text is refined.
	const [milk, bread] = [{ kind: "search", text: "milk" }, { kind: "search", text: "bread" }];
	assert.notEqual(view.taskScopeKey(milk), view.taskScopeKey(bread));
	assert.equal(view.taskListViewKey(milk), view.taskListViewKey(bread));
	assert.notEqual(view.taskListViewKey({ kind: "list", listId: "l1" }), view.taskListViewKey({ kind: "list", listId: "l2" }));

	// Nothing is added among search results or completed tasks: it would not show there.
	assert.deepEqual([milk, { kind: "view", view: "completed" }, { kind: "view", view: "today" }, { kind: "list", listId: "l1" }, { kind: "date", date: "2026-11-24" }].map(view.scopeTakesNewTasks), [false, false, true, true, true]);
	assert.equal(view.defaultDueDateForScope(milk, "2026-11-24"), null);
	assert.equal(view.defaultDueDateForScope({ kind: "view", view: "completed" }, "2026-11-24"), null);
});

test("a task added from a smart view or a day starts with a date that keeps it there", () => {
	assert.equal(view.defaultDueDateForScope({ kind: "view", view: "today" }, "2026-11-24"), "2026-11-24");
	assert.equal(view.defaultDueDateForScope({ kind: "view", view: "upcoming" }, "2026-11-30"), "2026-12-01");
	assert.equal(view.defaultDueDateForScope({ kind: "view", view: "starred" }, "2026-11-24"), null);
	assert.equal(view.defaultDueDateForScope({ kind: "list", listId: "l1" }, "2026-11-24"), null);
	assert.equal(view.defaultDueDateForScope({ kind: "date", date: "2026-12-05" }, "2026-11-24"), "2026-12-05");
});

test("a task added outside a list goes to the last-used list, else to the first", () => {
	const ids = ["l1", "l2", "l3"];
	assert.equal(view.listForNewTask(ids, "l3"), "l3");
	assert.equal(view.listForNewTask(ids, undefined), "l1", "nothing remembered yet");
	assert.equal(view.listForNewTask(ids, "deleted"), "l1", "the remembered list is gone");
	assert.equal(view.listForNewTask([], "l3"), undefined, "no lists loaded: the API picks");
});

test("a day lists its open tasks and the repeating tasks coming up on it, in the order of the day", () => {
	const anyTime = task({ title: "any time", dueDate: "2026-11-27" });
	const five = task({ title: "9:05", dueDate: "2026-11-27", dueAt: "2026-11-27T09:05:00.000Z" });
	const ten = task({ title: "9:10", dueDate: "2026-11-27", dueAt: "2026-11-27T09:10:00.000Z" });
	const repeating = task({ id: "tsk_r", title: "stand-up", dueDate: "2026-11-25", dueAt: "2026-11-25T09:05:00.000Z" });
	const occurrence = (dueDate, dueAt) => ({ id: `${repeating.id}@${dueDate}`, taskId: repeating.id, listId: repeating.listId, title: repeating.title, starred: false, dueDate, dueAt, timeZone: "UTC", repeatIndex: 2 });
	const entries = view.taskDayEntries([anyTime, five, ten], [occurrence("2026-11-27", "2026-11-27T09:05:00.000Z")], "UTC");
	// The occurrence is due with "9:05": the task comes first.
	assert.deepEqual(entries.map((entry) => [entry.kind, entry.kind === "task" ? entry.task.title : entry.occurrence.title, entry.key]), [
		["task", "any time", anyTime.id], ["task", "9:05", five.id], ["occurrence", "stand-up", "tsk_r@2026-11-27"], ["task", "9:10", ten.id],
	]);
	assert.deepEqual(Object.keys(entries[0]).sort(), ["key", "kind", "task"]);
	// An occurrence without a time sits with the tasks without one.
	assert.deepEqual(view.taskDayEntries([five], [occurrence("2026-11-27", null)], "UTC").map((entry) => entry.kind), ["occurrence", "task"]);
	assert.deepEqual(view.taskDayEntries([], [], "UTC"), []);
});

test("Today is cut into Overdue and today; Upcoming into one section per date", () => {
	const late = task({ title: "late", dueDate: "2026-11-20" });
	const older = task({ title: "older", dueDate: "2026-11-01" });
	const now = task({ title: "now", dueDate: "2026-11-24" });
	// 23:30 in New York on the 23rd is the 24th in Berlin: a timed task counts on the viewer's date.
	const timed = task({ title: "timed", dueDate: "2026-11-23", dueAt: "2026-11-24T04:30:00.000Z", timeZone: "America/New_York" });
	const today = view.groupTasksForView([older, late, now, timed], "today", "2026-11-24", "Europe/Berlin");
	assert.deepEqual(today.map((section) => [section.kind, section.date, section.tasks.map((item) => item.title)]), [["overdue", null, ["older", "late"]], ["date", "2026-11-24", ["now", "timed"]]]);

	const upcoming = view.groupTasksForView([task({ title: "b", dueDate: "2026-11-27" }), task({ title: "a", dueDate: "2026-11-25" }), task({ title: "c", dueDate: "2026-11-27" })], "upcoming", "2026-11-24", "UTC");
	assert.deepEqual(upcoming.map((section) => [section.date, section.tasks.map((item) => item.title)]), [["2026-11-25", ["a"]], ["2026-11-27", ["b", "c"]]]);

	assert.deepEqual(view.groupTasksForView([late, now], "starred", "2026-11-24", "UTC").map((section) => [section.kind, section.tasks.length]), [["all", 2]]);
	assert.deepEqual(view.groupTasksForView([], "starred", "2026-11-24", "UTC"), []);
});

// ---- The date, time and repeat form ----

test("the form shows a task's date and time in the viewer's zone", () => {
	const timed = task({ dueDate: "2026-11-23", dueAt: "2026-11-24T04:30:00.000Z", timeZone: "America/New_York", repeat: { freq: "monthly", interval: 3, until: "2027-06-30", count: null, index: 2 } });
	assert.deepEqual(view.scheduleFormOf(timed, "Europe/Berlin"), { date: "2026-11-24", time: "05:30", repeats: true, freq: "monthly", interval: "3", end: "until", until: "2027-06-30", count: "10" });
	assert.deepEqual(view.scheduleFormOf(task(), "UTC"), { date: "", time: "", repeats: false, freq: "weekly", interval: "1", end: "never", until: "", count: "10" });
	assert.equal(view.scheduleFormOf(task({ dueDate: "2026-11-24", repeat: { freq: "daily", interval: 1, until: null, count: 5, index: 0 } }), "UTC").end, "count");
});

test("the form is checked before it is sent", () => {
	const form = { date: "2026-11-24", time: "", repeats: true, freq: "weekly", interval: "2", end: "never", until: "", count: "10" };
	assert.equal(view.scheduleFormError(form), null);
	assert.equal(view.scheduleFormError({ ...form, date: "" }), "date");
	assert.equal(view.scheduleFormError({ ...form, date: "2026-02-30" }), "date");
	assert.equal(view.scheduleFormError({ ...form, time: "25:00" }), "time");
	assert.equal(view.scheduleFormError({ ...form, interval: "0" }), "interval");
	assert.equal(view.scheduleFormError({ ...form, interval: "1.5" }), "interval");
	assert.equal(view.scheduleFormError({ ...form, interval: "1000" }), "interval");
	assert.equal(view.scheduleFormError({ ...form, end: "until", until: "" }), "until");
	assert.equal(view.scheduleFormError({ ...form, end: "until", until: "2026-11-23" }), "until");
	assert.equal(view.scheduleFormError({ ...form, end: "until", until: "2026-11-24" }), null);
	assert.equal(view.scheduleFormError({ ...form, end: "count", count: "" }), "count");
	assert.equal(view.scheduleFormError({ ...form, repeats: false, interval: "", end: "count", count: "" }), null, "the repeat fields do not matter while it is off");
});

test("saving sends only what changed", () => {
	const plain = task({ dueDate: "2026-11-24" });
	const form = view.scheduleFormOf(plain, "UTC");
	assert.deepEqual(view.scheduleChanges(plain, form, "UTC"), {});
	assert.deepEqual(view.scheduleChanges(plain, { ...form, time: "14:30" }, "Europe/Berlin"), { due: { date: "2026-11-24", time: "14:30", timeZone: "Europe/Berlin" } });
	assert.deepEqual(view.scheduleChanges(plain, { ...form, date: "2026-11-25" }, "UTC"), { due: { date: "2026-11-25", time: null, timeZone: "UTC" } });
	assert.deepEqual(view.scheduleChanges(plain, { ...form, repeats: true, freq: "daily", interval: "2", end: "count", count: "5" }, "UTC"), { repeat: { freq: "daily", interval: 2, until: null, count: 5 } });
	assert.equal(view.scheduleChanges(plain, { ...form, date: "" }, "UTC"), null);

	const undated = task();
	assert.deepEqual(view.scheduleChanges(undated, { ...view.scheduleFormOf(undated, "UTC"), date: "2026-12-01" }, "UTC"), { due: { date: "2026-12-01", time: null, timeZone: "UTC" } });
});

test("a repeating task keeps its series unless the rule itself is edited", () => {
	const weekly = task({ dueDate: "2026-11-24", repeat: { freq: "weekly", interval: 1, until: null, count: 8, index: 3 } });
	const form = view.scheduleFormOf(weekly, "UTC");
	assert.deepEqual(view.scheduleChanges(weekly, form, "UTC"), {}, "an untouched form restarts nothing");
	assert.deepEqual(view.scheduleChanges(weekly, { ...form, date: "2026-11-26" }, "UTC"), { due: { date: "2026-11-26", time: null, timeZone: "UTC" } }, "a new date moves the series, the rule is not resent");
	assert.deepEqual(view.scheduleChanges(weekly, { ...form, end: "until", until: "2027-01-31" }, "UTC"), { repeat: { freq: "weekly", interval: 1, until: "2027-01-31", count: null } });
	assert.deepEqual(view.scheduleChanges(weekly, { ...form, repeats: false }, "UTC"), { repeat: null });
});

// ---- Strings ----

test("every string the Tasks screens ask for exists", () => {
	const strings = { ...JSON.parse(readFileSync(join(root, "src/lib/i18n/en.json"), "utf8")) };
	const known = (key) => key in strings || `${key}.other` in strings;
	const sources = ["src/components/tasks/task-row.tsx", "src/components/tasks/task-list-view.tsx", "src/components/tasks/task-list-rows.tsx", "src/components/tasks/task-list-dialog.tsx", "src/components/tasks/task-schedule-dialog.tsx", "src/components/tasks/task-controls.tsx", "src/components/tasks/task-search-box.tsx", "src/components/tasks/tasks-panel.tsx", "src/app/(tasks)/tasks-nav.tsx", "src/app/(tasks)/tasks/page.tsx", "src/app/(tasks)/layout.tsx"];
	const used = new Set(sources.flatMap((file) => [...readFileSync(join(root, file), "utf8").matchAll(/"(tasks\.[A-Za-z0-9.]+)"/g)].map((match) => match[1])));
	assert.ok(used.size > 60, "the scan found the keys");
	assert.deepEqual([...used].filter((key) => !known(key)), []);
	const fragments = Object.assign({}, ...["tasks-app", "tasks-panel", "tasks-find"].map((name) => JSON.parse(readFileSync(join(root, `src/lib/i18n/local/${name}.json`), "utf8"))));
	const unused = Object.keys(fragments).filter((key) => !used.has(key) && !used.has(key.replace(/\.(one|other)$/, "")));
	assert.deepEqual(unused, [], "strings nothing asks for");
});
