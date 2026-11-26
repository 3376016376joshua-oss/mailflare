import { MAX_REPEAT_COUNT, MAX_REPEAT_INTERVAL, TASK_SEARCH_MAX, TASK_VIEWS, addDays, compareTasksByDue, isDateString, isTimeString, taskLocalDate, timeInZone } from "@/lib/tasks/task-utils";
import type { Task, TaskOccurrence, TaskQuery, TaskRepeatFreq, TaskRepeatInput, TaskView, UpdateTaskInput } from "@/lib/tasks/types";

/**
 * Pure helpers of the Tasks screens: which list or view a URL names, where a task added outside a list
 * goes, how a smart view is cut into sections, and how the date, time and repeat form maps to an update.
 * No DOM, so they run in Node tests.
 */

// ---- What is on screen ----

/**
 * One list, a smart view across all lists, the tasks due on one day ("YYYY-MM-DD" in the viewer's
 * zone) across all lists (what a crowded "N tasks" chip of the calendar opens), or the tasks a search
 * text finds across all lists.
 */
export type TaskScope = { kind: "list"; listId: string } | { kind: "view"; view: TaskView } | { kind: "date"; date: string } | { kind: "search"; text: string };

export function parseTaskView(value: string | null | undefined): TaskView | null {
	return TASK_VIEWS.includes(value as TaskView) ? (value as TaskView) : null;
}

/** A search text as the API takes it: words one space apart, no longer than it accepts. "" means no search. */
export function normalizeTaskSearch(value: string | null | undefined): string {
	return (value ?? "").trim().replace(/\s+/g, " ").slice(0, TASK_SEARCH_MAX).trim();
}

/** Names a scope among the others, for an effect that must run once per scope. */
export function taskScopeKey(scope: TaskScope): string {
	if (scope.kind === "search") return `search:${scope.text}`;
	return scope.kind === "list" ? scope.listId : scope.kind === "view" ? scope.view : scope.date;
}

/**
 * The React `key` of the task list showing a scope, so its editing state starts fresh per list, view or
 * day. Every search shares one: refining the text keeps the results on screen instead of starting over.
 */
export function taskListViewKey(scope: TaskScope): string {
	return scope.kind === "search" ? "search" : taskScopeKey(scope);
}

export function taskScopeQuery(scope: TaskScope): TaskQuery {
	if (scope.kind === "list") return { listId: scope.listId };
	if (scope.kind === "search") return { q: scope.text };
	return scope.kind === "view" ? { view: scope.view } : { dueFrom: scope.date, dueTo: scope.date };
}

/**
 * Whether tasks are added in a scope. Search results and the Completed view only show what exists: a
 * task typed there would not appear in them.
 */
export function scopeTakesNewTasks(scope: TaskScope): boolean {
	return scope.kind !== "search" && !(scope.kind === "view" && scope.view === "completed");
}

/** The address of a list, view, day or search in the Tasks app, optionally with a task to bring into focus. */
export function taskScopeHref(scope: TaskScope | null, taskId?: string | null): string {
	const params = new URLSearchParams();
	if (scope?.kind === "list") params.set("list", scope.listId);
	if (scope?.kind === "view") params.set("view", scope.view);
	if (scope?.kind === "date") params.set("date", scope.date);
	if (scope?.kind === "search") params.set("q", scope.text);
	if (taskId) params.set("task", taskId);
	const query = params.toString();
	return query ? `/tasks?${query}` : "/tasks";
}

/**
 * The address that searches for `text` from the page at `search` (its query string). The list, view or
 * day stays in the address underneath, so clearing the search (`text` "") returns to it.
 */
export function taskSearchHref(search: string, text: string): string {
	const params = new URLSearchParams(search);
	params.delete("task");
	const wanted = normalizeTaskSearch(text);
	if (wanted) params.set("q", wanted);
	else params.delete("q");
	const query = params.toString();
	return query ? `/tasks?${query}` : "/tasks";
}

/**
 * What `/tasks?q=...&view=...&date=...&list=...` shows: the search when there is one, else the named
 * view, else the named day, else the named list when it exists, else the first list. null while there
 * is no list to show (still loading, or Tasks is not set up).
 */
export function resolveTaskScope(params: { view: string | null; date?: string | null; list: string | null; q?: string | null }, listIds: readonly string[]): TaskScope | null {
	const text = normalizeTaskSearch(params.q);
	if (text) return { kind: "search", text };
	const view = parseTaskView(params.view);
	if (view) return { kind: "view", view };
	if (isDateString(params.date)) return { kind: "date", date: params.date };
	const listId = params.list && listIds.includes(params.list) ? params.list : listIds[0];
	return listId ? { kind: "list", listId } : null;
}

/** The due date a task added from a smart view or a day starts with, so it stays where it was added. */
export function defaultDueDateForScope(scope: TaskScope, today: string): string | null {
	if (scope.kind === "date") return scope.date;
	if (scope.kind !== "view") return null;
	if (scope.view === "today") return today;
	return scope.view === "upcoming" ? addDays(today, 1) : null;
}

/**
 * The list a task added outside a list (in Starred, Today, Upcoming or a day) goes to: the one the user
 * last worked in, as "Add to tasks" on an email does, while it still exists; else the first list.
 */
export function listForNewTask(listIds: readonly string[], lastListId: string | undefined): string | undefined {
	return lastListId !== undefined && listIds.includes(lastListId) ? lastListId : listIds[0];
}

// ---- Sections of a smart view ----

export type TaskSection = { key: string; kind: "overdue" | "date" | "all"; date: string | null; tasks: Task[] };

/**
 * A smart view of open tasks cut into sections: Today is "Overdue" then today's tasks, Upcoming is one
 * section per date, Starred is a single run. The order inside a section is the order the API answered in.
 */
export function groupTasksForView(tasks: readonly Task[], view: Exclude<TaskView, "completed">, today: string, timeZone: string): TaskSection[] {
	if (view === "starred") return tasks.length ? [{ key: "all", kind: "all", date: null, tasks: [...tasks] }] : [];
	const sections = new Map<string, TaskSection>();
	for (const task of tasks) {
		const date = taskLocalDate(task, timeZone);
		const overdue = view === "today" && date !== null && date < today;
		const key = overdue ? "overdue" : date ?? "none";
		const section = sections.get(key) ?? { key, kind: overdue ? "overdue" : "date", date: overdue ? null : date, tasks: [] };
		section.tasks.push(task);
		sections.set(key, section);
	}
	return [...sections.values()].sort((a, b) => (a.kind === "overdue" ? -1 : b.kind === "overdue" ? 1 : (a.date ?? "") < (b.date ?? "") ? -1 : 1));
}

// ---- The tasks of a day ----

/** A row of a day: an open task, or a coming occurrence of a repeating task (there is no task to check off yet). */
export type TaskDayEntry = { kind: "task"; key: string; task: Task } | { kind: "occurrence"; key: string; occurrence: TaskOccurrence };

/**
 * What a day lists, in the order of the day: its open tasks and the occurrences of repeating tasks
 * projected onto it, those without a time first, then by time. At the same time a task comes before an occurrence.
 */
export function taskDayEntries(tasks: readonly Task[], occurrences: readonly TaskOccurrence[], timeZone: string): TaskDayEntry[] {
	const entries: TaskDayEntry[] = [
		...tasks.map((task) => ({ kind: "task" as const, key: task.id, task })),
		...occurrences.map((occurrence) => ({ kind: "occurrence" as const, key: occurrence.id, occurrence })),
	];
	// The position is left out of the comparison: Array.prototype.sort is stable, so rows due together keep the order they came in.
	const dueOf = (entry: TaskDayEntry) => {
		const { dueDate, dueAt } = entry.kind === "task" ? entry.task : entry.occurrence;
		return { dueDate, dueAt, position: "" };
	};
	return entries.sort((a, b) => compareTasksByDue(dueOf(a), dueOf(b), timeZone));
}

// ---- The date, time and repeat form ----

export type ScheduleEnd = "never" | "until" | "count";

/** The fields of the schedule dialog. Numbers are kept as typed so an empty box stays empty. */
export type ScheduleForm = {
	date: string;
	time: string;
	repeats: boolean;
	freq: TaskRepeatFreq;
	interval: string;
	end: ScheduleEnd;
	until: string;
	count: string;
};

export type ScheduleError = "date" | "time" | "interval" | "until" | "count";

type Scheduled = Pick<Task, "dueDate" | "dueAt" | "repeat">;

/** The form as the task stands, with its date and time shown in the viewer's time zone. */
export function scheduleFormOf(task: Scheduled, timeZone: string): ScheduleForm {
	const repeat = task.repeat;
	return {
		date: taskLocalDate(task, timeZone) ?? "",
		time: task.dueAt ? timeInZone(new Date(task.dueAt), timeZone) : "",
		repeats: repeat !== null,
		freq: repeat?.freq ?? "weekly",
		interval: String(repeat?.interval ?? 1),
		end: repeat?.until ? "until" : repeat?.count != null ? "count" : "never",
		until: repeat?.until ?? "",
		count: String(repeat?.count ?? 10),
	};
}

const wholeNumber = (value: string, max: number): number | null => {
	const number = Number(value);
	return /^\d+$/.test(value.trim()) && number >= 1 && number <= max ? number : null;
};

/** The first thing wrong with the form, or null when it can be saved. */
export function scheduleFormError(form: ScheduleForm): ScheduleError | null {
	if (!isDateString(form.date)) return "date";
	if (form.time && !isTimeString(form.time)) return "time";
	if (!form.repeats) return null;
	if (wholeNumber(form.interval, MAX_REPEAT_INTERVAL) === null) return "interval";
	if (form.end === "until" && !(isDateString(form.until) && form.until >= form.date)) return "until";
	if (form.end === "count" && wholeNumber(form.count, MAX_REPEAT_COUNT) === null) return "count";
	return null;
}

function repeatInputOf(form: ScheduleForm): TaskRepeatInput {
	return {
		freq: form.freq,
		interval: wholeNumber(form.interval, MAX_REPEAT_INTERVAL) ?? 1,
		until: form.end === "until" ? form.until : null,
		count: form.end === "count" ? wholeNumber(form.count, MAX_REPEAT_COUNT) : null,
	};
}

/**
 * The update a saved form asks for: only what changed is sent, because a new due date moves a repeating
 * series and a new rule restarts its count. Empty when nothing changed; null when the form is invalid.
 */
export function scheduleChanges(task: Scheduled, form: ScheduleForm, timeZone: string): Pick<UpdateTaskInput, "due" | "repeat"> | null {
	if (scheduleFormError(form) !== null) return null;
	const before = scheduleFormOf(task, timeZone);
	const changes: Pick<UpdateTaskInput, "due" | "repeat"> = {};
	if (form.date !== before.date || form.time !== before.time) changes.due = { date: form.date, time: form.time || null, timeZone };
	if (!form.repeats) {
		if (task.repeat) changes.repeat = null;
		return changes;
	}
	const rule = repeatInputOf(form);
	const current = task.repeat;
	if (!current || current.freq !== rule.freq || current.interval !== rule.interval || (current.until ?? null) !== rule.until || (current.count ?? null) !== rule.count) changes.repeat = rule;
	return changes;
}
