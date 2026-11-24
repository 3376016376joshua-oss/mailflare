import { MAX_REPEAT_COUNT, MAX_REPEAT_INTERVAL, addDays, isDateString, isTimeString, taskLocalDate, timeInZone } from "@/lib/tasks/task-utils";
import type { Task, TaskQuery, TaskRepeatFreq, TaskRepeatInput, TaskView, UpdateTaskInput } from "@/lib/tasks/types";

/**
 * Pure helpers of the Tasks screens: which list or view a URL names, how a smart view is cut into
 * sections, and how the date, time and repeat form maps to an update. No DOM, so they run in Node tests.
 */

// ---- What is on screen ----

/** One list, or a smart view across all lists. */
export type TaskScope = { kind: "list"; listId: string } | { kind: "view"; view: TaskView };

const VIEWS: readonly TaskView[] = ["starred", "today", "upcoming"];

export function parseTaskView(value: string | null | undefined): TaskView | null {
	return VIEWS.includes(value as TaskView) ? (value as TaskView) : null;
}

export function taskScopeQuery(scope: TaskScope): TaskQuery {
	return scope.kind === "list" ? { listId: scope.listId } : { view: scope.view };
}

/** The address of a list or view in the Tasks app, optionally with a task to bring into focus. */
export function taskScopeHref(scope: TaskScope | null, taskId?: string | null): string {
	const params = new URLSearchParams();
	if (scope?.kind === "list") params.set("list", scope.listId);
	if (scope?.kind === "view") params.set("view", scope.view);
	if (taskId) params.set("task", taskId);
	const query = params.toString();
	return query ? `/tasks?${query}` : "/tasks";
}

/**
 * What `/tasks?view=...&list=...` shows: the named view, else the named list when it exists, else the
 * first list. null while there is no list to show (still loading, or Tasks is not set up).
 */
export function resolveTaskScope(params: { view: string | null; list: string | null }, listIds: readonly string[]): TaskScope | null {
	const view = parseTaskView(params.view);
	if (view) return { kind: "view", view };
	const listId = params.list && listIds.includes(params.list) ? params.list : listIds[0];
	return listId ? { kind: "list", listId } : null;
}

/** The due date a task added from a smart view starts with, so it stays in the view it was added to. */
export function defaultDueDateForScope(scope: TaskScope, today: string): string | null {
	if (scope.kind !== "view") return null;
	if (scope.view === "today") return today;
	return scope.view === "upcoming" ? addDays(today, 1) : null;
}

// ---- Sections of a smart view ----

export type TaskSection = { key: string; kind: "overdue" | "date" | "all"; date: string | null; tasks: Task[] };

/**
 * A smart view cut into sections: Today is "Overdue" then today's tasks, Upcoming is one section per
 * date, Starred is a single run. The order inside a section is the order the API answered in.
 */
export function groupTasksForView(tasks: readonly Task[], view: TaskView, today: string, timeZone: string): TaskSection[] {
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
