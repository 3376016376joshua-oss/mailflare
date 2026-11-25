import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { JSDOM } from "jsdom";

// Tasks on the calendar (src/components/tasks/calendar-*): what the calendar draws for a tasks response, where
// chips go in the time grid and the month cells, and the switches that show or hide them.

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
// Inside node_modules so the bundle's external packages (react, @tanstack/react-query) resolve to the test's own copies.
const outDir = mkdtempSync(join(root, "node_modules", "mailflare-local-tasks-calendar-test-"));
after(() => rmSync(outDir, { recursive: true, force: true }));

await build({
	entryPoints: {
		calendar: join(root, "src/components/tasks/calendar-task-utils.ts"),
		prefs: join(root, "src/components/tasks/calendar-task-prefs.ts"),
	},
	outdir: outDir,
	outExtension: { ".js": ".mjs" },
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node22",
	packages: "external",
	jsx: "automatic",
	alias: { "@": join(root, "src") },
	logLevel: "silent",
});

const load = (name) => import(pathToFileURL(join(outDir, `${name}.mjs`)).href);
const calendar = await load("calendar");

const LIST = "tl_1";
let counter = 0;
const task = (fields = {}) => ({
	id: `tsk_${++counter}`, listId: LIST, parentId: null, title: "Task", notes: "", status: "needs-action", completedAt: null, dueDate: null, dueAt: null, timeZone: null,
	starred: false, starredAt: null, position: `j${counter.toString(36).padStart(2, "0")}`, message: null, repeat: null, seriesId: null, createdAt: "2026-11-24T10:00:00.000Z", updatedAt: "2026-11-24T10:00:00.000Z", ...fields,
});
const occurrence = (of, dueDate, dueAt = null) => ({ id: `${of.id}@${dueDate}`, taskId: of.id, listId: of.listId, title: of.title, starred: false, dueDate, dueAt, timeZone: of.timeZone, repeatIndex: 1 });
const titles = (items) => items.map((item) => item.title);
const item = (fields) => ({ key: fields.title, taskId: fields.title, title: fields.title, date: "2026-11-24", dueAt: null, completed: false, projected: false, saving: false, ...fields });

// ---- Calendar: from a tasks response to chips ----

test("tasks land on the viewer's calendar date, open before completed, date-only before timed", () => {
	const lateInNewYork = task({ title: "Late", dueDate: "2026-11-24", dueAt: "2026-11-25T04:30:00.000Z", timeZone: "America/New_York" });
	const data = {
		tasks: [
			task({ title: "Undated" }),
			task({ title: "Done", status: "completed", dueDate: "2026-11-24" }),
			task({ title: "Afternoon", dueDate: "2026-11-24", dueAt: "2026-11-24T14:00:00.000Z", timeZone: "UTC" }),
			task({ title: "Morning", dueDate: "2026-11-24", dueAt: "2026-11-24T08:00:00.000Z", timeZone: "UTC" }),
			task({ title: "Any time", dueDate: "2026-11-24" }),
			lateInNewYork,
			task({ id: "tmp_new", title: "Just added", dueDate: "2026-11-23" }),
		],
		occurrences: [],
	};
	const items = calendar.buildCalendarTaskItems(data, "Europe/Berlin", { showCompleted: true });
	assert.deepEqual(items.map((entry) => `${entry.date} ${entry.title}`), [
		"2026-11-23 Just added", "2026-11-24 Any time", "2026-11-24 Morning", "2026-11-24 Afternoon", "2026-11-24 Done", "2026-11-25 Late",
	]);
	assert.equal(items[0].saving, true, "a task the server has not confirmed cannot be changed yet");
	assert.equal(items.find((entry) => entry.title === "Done").completed, true);
	// The same task is still on the 24th for someone in New York.
	assert.equal(calendar.buildCalendarTaskItems({ tasks: [lateInNewYork], occurrences: [] }, "America/New_York", { showCompleted: true })[0].date, "2026-11-24");
	assert.deepEqual(titles(calendar.buildCalendarTaskItems(data, "Europe/Berlin", { showCompleted: false })).includes("Done"), false);
});

test("projected occurrences of a repeating task are shown but act on the task that carries the rule", () => {
	const daily = task({ title: "Water the plants", dueDate: "2026-11-24", repeat: { freq: "daily", interval: 1, until: null, count: null, index: 0 } });
	const items = calendar.buildCalendarTaskItems({ tasks: [daily], occurrences: [occurrence(daily, "2026-11-25"), occurrence(daily, "2026-11-26")] }, "UTC", { showCompleted: false });
	assert.deepEqual(items.map((entry) => [entry.key, entry.taskId, entry.date, entry.projected]), [
		[daily.id, daily.id, "2026-11-24", false],
		[`${daily.id}@2026-11-25`, daily.id, "2026-11-25", true],
		[`${daily.id}@2026-11-26`, daily.id, "2026-11-26", true],
	]);
});

test("a day's chips split into the date-only strip and the time grid", () => {
	const days = calendar.groupCalendarTasksByDay([
		item({ title: "A" }),
		item({ title: "B", dueAt: "2026-11-24T09:00:00.000Z" }),
		item({ title: "C", date: "2026-11-25" }),
	]);
	assert.deepEqual([...days.keys()], ["2026-11-24", "2026-11-25"]);
	assert.deepEqual([titles(days.get("2026-11-24").allDay), titles(days.get("2026-11-24").timed)], [["A"], ["B"]]);
	assert.deepEqual([titles(days.get("2026-11-25").allDay), titles(days.get("2026-11-25").timed)], [["C"], []]);
});

test("pending tasks are the open ones left over from earlier days", () => {
	const now = new Date("2026-11-24T15:00:00Z");
	const tasks = [
		task({ dueDate: "2026-11-23" }),
		task({ dueDate: "2026-11-14" }),
		task({ dueDate: "2026-11-23", status: "completed" }),
		task({ dueDate: "2026-11-24" }),
		// Earlier today: overdue, but still on today's date, so the grid shows it.
		task({ dueDate: "2026-11-24", dueAt: "2026-11-24T09:00:00.000Z" }),
		task({ dueDate: "2026-11-25" }),
		task(),
	];
	assert.equal(calendar.countPendingTasks(tasks, now, "UTC"), 2);
	// 15:00 UTC on the 24th is already the 25th in Auckland, where the 24th's task is left over too.
	assert.equal(calendar.countPendingTasks(tasks, now, "Pacific/Auckland"), 4);
});

test("a strip column shows every chip that fits, or leaves a row for the count of the rest", () => {
	assert.deepEqual([0, 1, 3, 4, 9].map((total) => calendar.visibleChipCount(total, 3)), [0, 1, 3, 2, 2]);
	assert.equal(calendar.visibleChipCount(5, 2), 1);
});

// ---- Calendar: the time grid ----

const GRID = { hourHeight: 36, chipHeight: 20 };
const at = (title, time) => item({ title, dueAt: `2026-11-24T${time}:00.000Z` });

test("a timed task sits at its due time in the viewer's zone and stays inside the day", () => {
	const boxes = calendar.layoutTimedTasks([at("Ten", "10:00"), at("Half past two", "14:30"), at("Almost midnight", "23:59")], "UTC", GRID);
	assert.deepEqual(boxes.map((box) => [box.item.title, box.top, box.column, box.columns, box.besideEvent]), [
		["Ten", 360, 0, 1, false],
		["Half past two", 522, 0, 1, false],
		["Almost midnight", 24 * 36 - 20, 0, 1, false],
	]);
	// 10:00 UTC is 11:00 in Berlin.
	assert.equal(calendar.layoutTimedTasks([at("Ten", "10:00")], "Europe/Berlin", GRID)[0].top, 11 * 36);
	assert.deepEqual(calendar.layoutTimedTasks([item({ title: "No time" })], "UTC", GRID), []);
});

test("tasks whose chips would overlap share the row; a column is reused once it is free", () => {
	// 20px chips at 36px an hour: 14:00 and 14:15 overlap, 14:40 clears the first but not the second.
	const boxes = calendar.layoutTimedTasks([at("C", "14:40"), at("A", "14:00"), at("B", "14:15"), at("Alone", "18:00")], "UTC", GRID);
	assert.deepEqual(boxes.map((box) => [box.item.title, box.column, box.columns]), [["A", 0, 2], ["B", 1, 2], ["C", 0, 2], ["Alone", 0, 1]]);
});

test("a task row that collides with an event is flagged, so it can leave the event readable", () => {
	const busy = [{ top: 9 * 36, bottom: 11 * 36 }];
	const boxes = calendar.layoutTimedTasks([at("During", "10:00"), at("Right after", "11:00"), at("Just before", "08:45")], "UTC", { ...GRID, busy });
	assert.deepEqual(boxes.map((box) => [box.item.title, box.besideEvent]), [["Just before", true], ["During", true], ["Right after", false]]);
	assert.equal(calendar.layoutTimedTasks([at("Well before", "08:00")], "UTC", { ...GRID, busy })[0].besideEvent, false);
});

const shape = (box) => [box.kind, box.kind === "group" ? box.items.map((entry) => entry.title) : box.item.title, box.top, box.column, box.columns, box.besideEvent];

test("tasks too narrow to read side by side merge into one chip, and only then", () => {
	// 16:00, 16:15 and 16:20 overlap each other: three columns.
	const crowded = [at("B", "16:15"), at("A", "16:00"), at("C", "16:20")];
	// Until the column is measured nothing merges.
	assert.deepEqual(calendar.layoutTimedTasks(crowded, "UTC", GRID).map((box) => [box.kind, box.columns]), [["task", 3], ["task", 3], ["task", 3]]);
	// A week column of 141px leaves each of three chips 47px: one chip, at the time of the first task, in time order.
	assert.equal(calendar.MIN_TIMED_CHIP_WIDTH, 56);
	const merged = calendar.layoutTimedTasks(crowded, "UTC", { ...GRID, columnWidth: 141 });
	assert.deepEqual(merged.map(shape), [["group", ["A", "B", "C"], 576, 0, 1, false]]);
	assert.equal(merged[0].key, "group:A");
	// A day column has room for them (96px each).
	assert.deepEqual(calendar.layoutTimedTasks(crowded, "UTC", { ...GRID, columnWidth: 288 }).map(shape), [["task", "A", 576, 0, 3, false], ["task", "B", 585, 1, 3, false], ["task", "C", 588, 2, 3, false]]);
	// Two tasks fit a 141px column (70px each) and not a 90px one (45px each).
	const pair = [at("A", "10:00"), at("B", "10:10")];
	assert.deepEqual(calendar.layoutTimedTasks(pair, "UTC", { ...GRID, columnWidth: 141 }).map((box) => box.kind), ["task", "task"]);
	assert.deepEqual(calendar.layoutTimedTasks(pair, "UTC", { ...GRID, columnWidth: 90 }).map(shape), [["group", ["A", "B"], 360, 0, 1, false]]);
	// A task on its own is never merged, however narrow the column.
	assert.deepEqual(calendar.layoutTimedTasks([at("Alone", "10:00")], "UTC", { ...GRID, columnWidth: 20 }).map(shape), [["task", "Alone", 360, 0, 1, false]]);
});

test("an event under a row of tasks makes it merge sooner, and the merged chip leaves the event readable", () => {
	const busy = [{ top: 16 * 36, bottom: 17 * 36 }];
	// The row keeps to the trailing 80% beside an event: 56px each of 141px is enough, 36px each of 90px is not.
	const pair = [at("A", "16:00"), at("B", "16:15")];
	assert.deepEqual(calendar.layoutTimedTasks(pair, "UTC", { ...GRID, busy, columnWidth: 141 }).map(shape), [["task", "A", 576, 0, 2, true], ["task", "B", 585, 1, 2, true]]);
	const merged = calendar.layoutTimedTasks(pair, "UTC", { ...GRID, busy, columnWidth: 90 });
	assert.deepEqual(merged.map(shape), [["group", ["A", "B"], 576, 0, 1, true]]);
	// One chip takes the share a single task takes, so the event keeps 40% of the column instead of 20%.
	assert.equal(calendar.timedTaskRowStart(merged[0]), 0.4);
	assert.equal(calendar.timedTaskRowStart({ columns: 2, besideEvent: true }), 0.2);
	assert.equal(calendar.timedTaskRowStart({ columns: 3, besideEvent: false }), 0);
});

test("a crowded run of tasks becomes one chip per time slot, and a task alone in its slot stays a task", () => {
	// 09:00, 09:05 and 09:10 need three columns; 09:40 clears the first of them, so it stands alone below the merged chip.
	const morning = calendar.layoutTimedTasks([at("A", "09:00"), at("B", "09:05"), at("C", "09:10"), at("Later", "09:40")], "UTC", { ...GRID, columnWidth: 141 });
	assert.deepEqual(morning.map(shape), [["group", ["A", "B", "C"], 324, 0, 1, false], ["task", "Later", 348, 0, 1, false]]);
	// A chain every 20 minutes shares two columns. In a 90px column it becomes two chips, each where its slot begins.
	const chain = [at("A", "14:00"), at("B", "14:20"), at("C", "14:40"), at("D", "15:00")];
	assert.deepEqual(calendar.layoutTimedTasks(chain, "UTC", { ...GRID, columnWidth: 141 }).map((box) => [box.kind, box.columns]), [["task", 2], ["task", 2], ["task", 2], ["task", 2]]);
	const slots = calendar.layoutTimedTasks(chain, "UTC", { ...GRID, columnWidth: 90 });
	assert.deepEqual(slots.map(shape), [["group", ["A", "B"], 504, 0, 1, false], ["group", ["C", "D"], 528, 0, 1, false]]);
	assert.equal(new Set(slots.map((box) => box.key)).size, slots.length, "keys are unique within a day");
	// Each slot answers for itself whether an event lies under it: here only the second one (15:00-16:00).
	const withEvent = calendar.layoutTimedTasks(chain, "UTC", { ...GRID, columnWidth: 90, busy: [{ top: 15 * 36, bottom: 16 * 36 }] });
	assert.deepEqual(withEvent.map((box) => [box.kind, box.besideEvent]), [["group", false], ["group", true]]);
});

// ---- Calendar: month cells ----

const event = (id, time) => ({ id, startsAt: `2026-11-24T${time}:00.000Z` });
const kinds = (picked) => picked.shown.map((entry) => (entry.kind === "event" ? entry.event.id : entry.kind === "task" ? entry.item.title : `pending:${entry.count}`));

test("a month cell reads pending chip, date-only tasks, then events and timed tasks by time", () => {
	const tasks = { allDay: [item({ title: "Any time" })], timed: [at("Noon task", "12:00"), at("Early task", "07:00")] };
	const picked = calendar.pickMonthDayEntries([event("standup", "09:00"), event("review", "15:00")], tasks, 2, 10);
	assert.deepEqual(kinds(picked), ["pending:2", "Any time", "Early task", "standup", "Noon task", "review"]);
	assert.equal(picked.hidden, 0);
	assert.equal(new Set(picked.shown.map((entry) => entry.key)).size, picked.shown.length, "keys are unique within a cell");
});

test("a full month cell keeps its events and at least one row for tasks", () => {
	const events = [event("a", "09:00"), event("b", "11:00"), event("c", "13:00"), event("d", "15:00")];
	const tasks = { allDay: [item({ title: "T1" }), item({ title: "T2" }), item({ title: "T3" })], timed: [] };
	assert.deepEqual([kinds(calendar.pickMonthDayEntries(events, tasks, 0, 3)), calendar.pickMonthDayEntries(events, tasks, 0, 3).hidden], [["T1", "a", "b"], 4]);
	assert.deepEqual(kinds(calendar.pickMonthDayEntries(events.slice(0, 1), tasks, 1, 3)), ["pending:1", "T1", "a"]);
	assert.deepEqual(kinds(calendar.pickMonthDayEntries([], tasks, 1, 3)), ["pending:1", "T1", "T2"]);
	// Without tasks the cell is what it was before tasks existed: the first events, and the count of the rest.
	const plain = calendar.pickMonthDayEntries(events, undefined, 0, 3);
	assert.deepEqual([kinds(plain), plain.hidden], [["a", "b", "c"], 1]);
});

// ---- The switches ----

const DOM_GLOBALS = ["window", "document", "IS_REACT_ACT_ENVIRONMENT"];

function openPage() {
	const dom = new JSDOM("<!doctype html><div id='root'></div>", { url: "https://mail.test/" });
	Object.assign(globalThis, { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true });
	const close = () => {
		dom.window.close();
		for (const key of DOM_GLOBALS) delete globalThis[key];
	};
	return { dom, close };
}

test("the calendar's task switches default to on, are remembered, and follow another tab", async () => {
	const page = openPage();
	try {
		const { createElement, act } = await import("react");
		const { createRoot } = await import("react-dom/client");
		const prefs = await load("prefs");
		const seen = [];
		function Fixture() {
			const state = prefs.useCalendarTaskPrefs();
			seen.push(`${state.showTasks}/${state.showCompleted}`);
			return null;
		}
		const reactRoot = createRoot(document.getElementById("root"));
		await act(async () => reactRoot.render(createElement(Fixture)));
		assert.equal(seen.at(-1), "true/true");

		await act(async () => prefs.setCalendarTaskPref("showCompleted", false));
		assert.equal(seen.at(-1), "true/false");
		assert.equal(window.localStorage.getItem("mailflare.calendar.showCompletedTasks"), "0");

		// Another tab turned tasks off.
		window.localStorage.setItem("mailflare.calendar.showTasks", "0");
		await act(async () => window.dispatchEvent(new window.StorageEvent("storage", { key: "mailflare.calendar.showTasks" })));
		assert.equal(seen.at(-1), "false/false");

		await act(async () => prefs.setCalendarTaskPref("showTasks", true));
		assert.equal(seen.at(-1), "true/false");
		assert.equal(window.localStorage.getItem("mailflare.calendar.showTasks"), "1");
		await act(async () => reactRoot.unmount());
	} finally {
		page.close();
	}
});
