import { isPendingId } from "@/lib/tasks/cache-utils";
import { dateInZone, taskLocalDate } from "@/lib/tasks/task-utils";
import type { Task, TaskOccurrence } from "@/lib/tasks/types";
import { normalizeTimeZone, zonedDateFields } from "@/lib/time/utils";

/**
 * Pure helpers that turn a tasks response into what the calendar draws: one item per task or projected
 * occurrence, placed on the viewer's calendar date, grouped per day, and laid out in the time grid.
 * Nothing here touches React or the DOM, so it runs in Node tests.
 */

/** One task chip on the calendar. */
export type CalendarTaskItem = {
	/** React key: the task id, or `<taskId>@<date>` for a projected occurrence. */
	key: string;
	/** The task to act on (for an occurrence: the open task that carries the repeat rule). */
	taskId: string;
	title: string;
	/** Calendar date ("YYYY-MM-DD") the item falls on for the viewer. */
	date: string;
	/** Due instant of a timed task; null for a date-only one. */
	dueAt: string | null;
	completed: boolean;
	/** A future occurrence of a repeating task: shown on its date, but there is no row to check off yet. */
	projected: boolean;
	/** Created optimistically and not yet saved, so it cannot be changed for a moment. */
	saving: boolean;
};

export type CalendarDayTasks = {
	/** Date-only tasks, for the strip under the day header. */
	allDay: CalendarTaskItem[];
	/** Tasks with a time of day, for the time grid. */
	timed: CalendarTaskItem[];
};

type TasksData = { tasks: readonly Task[]; occurrences: readonly TaskOccurrence[] };

const instant = (value: string | null) => (value ? new Date(value).getTime() : -Infinity);

/** Open before completed, date-only before timed, then by time; ties keep the response's own order. */
function compareItems(a: CalendarTaskItem, b: CalendarTaskItem): number {
	if (a.date !== b.date) return a.date < b.date ? -1 : 1;
	if (a.completed !== b.completed) return a.completed ? 1 : -1;
	return instant(a.dueAt) - instant(b.dueAt);
}

/**
 * The chips for a tasks response: every dated task (completed ones only with `showCompleted`) and every
 * projected occurrence of a repeating task, each on the date it falls on in `timeZone`.
 */
export function buildCalendarTaskItems(data: TasksData, timeZone: string, options: { showCompleted: boolean }): CalendarTaskItem[] {
	const items: CalendarTaskItem[] = [];
	for (const task of data.tasks) {
		const date = taskLocalDate(task, timeZone);
		const completed = task.status === "completed";
		if (!date || (completed && !options.showCompleted)) continue;
		items.push({ key: task.id, taskId: task.id, title: task.title, date, dueAt: task.dueAt, completed, projected: false, saving: isPendingId(task.id) });
	}
	for (const occurrence of data.occurrences) {
		const date = taskLocalDate(occurrence, timeZone);
		if (!date) continue;
		items.push({ key: occurrence.id, taskId: occurrence.taskId, title: occurrence.title, date, dueAt: occurrence.dueAt, completed: false, projected: true, saving: false });
	}
	// Array.prototype.sort is stable, so equal items stay in response order.
	return items.sort(compareItems);
}

/** Items per calendar date, split into the date-only strip and the time grid. */
export function groupCalendarTasksByDay(items: readonly CalendarTaskItem[]): Map<string, CalendarDayTasks> {
	const days = new Map<string, CalendarDayTasks>();
	for (const item of items) {
		let day = days.get(item.date);
		if (!day) {
			day = { allDay: [], timed: [] };
			days.set(item.date, day);
		}
		(item.dueAt ? day.timed : day.allDay).push(item);
	}
	return days;
}

/** Open tasks left over from earlier days: what the "N pending tasks" chip on today counts. */
export function countPendingTasks(tasks: readonly Pick<Task, "status" | "dueDate" | "dueAt">[], now: Date, timeZone: string): number {
	const today = dateInZone(now, timeZone);
	let count = 0;
	for (const task of tasks) {
		if (task.status === "completed") continue;
		const date = taskLocalDate(task, timeZone);
		if (date !== null && date < today) count += 1;
	}
	return count;
}

/** How many chips a day shows before the rest collapse into "N more": all of them when they fit in `rows`. */
export function visibleChipCount(total: number, rows: number): number {
	return total <= rows ? total : Math.max(0, rows - 1);
}

// ---- Time grid ----

export type TimedTaskBox = {
	item: CalendarTaskItem;
	/** Pixels from the top of the day column. */
	top: number;
	/** Zero-based column among the chips that share a time slot, and how many columns that slot has. */
	column: number;
	columns: number;
	/** The slot overlaps an event: the chips keep to the trailing part of the day so the event stays readable. */
	besideEvent: boolean;
};

export type TimedTaskLayoutOptions = {
	hourHeight: number;
	chipHeight: number;
	/** Vertical extents of the day's events, in pixels from the top of the column. */
	busy?: ReadonlyArray<{ top: number; bottom: number }>;
};

/**
 * Where the timed tasks of one day go in the time grid. A chip sits at its due time (kept inside the
 * day at the bottom edge). Chips whose boxes would overlap share the row side by side, and a row that
 * collides with an event is flagged so it can leave part of the event visible.
 */
export function layoutTimedTasks(items: readonly CalendarTaskItem[], timeZone: string, options: TimedTaskLayoutOptions): TimedTaskBox[] {
	const zone = normalizeTimeZone(timeZone);
	const dayHeight = 24 * options.hourHeight;
	const placed = items
		.filter((item) => item.dueAt !== null)
		.map((item) => {
			const fields = zonedDateFields(new Date(item.dueAt as string), zone);
			const minutes = fields.getUTCHours() * 60 + fields.getUTCMinutes();
			return { item, top: Math.min(minutes * options.hourHeight / 60, dayHeight - options.chipHeight) };
		})
		.sort((a, b) => a.top - b.top);

	const boxes: TimedTaskBox[] = [];
	let cluster: Array<{ item: CalendarTaskItem; top: number; column: number }> = [];
	let clusterBottom = -Infinity;
	let columnBottoms: number[] = [];
	const flush = () => {
		if (!cluster.length) return;
		const top = cluster[0].top;
		const besideEvent = (options.busy ?? []).some((range) => range.top < clusterBottom && range.bottom > top);
		for (const entry of cluster) boxes.push({ ...entry, columns: columnBottoms.length, besideEvent });
		cluster = [];
		columnBottoms = [];
		clusterBottom = -Infinity;
	};
	for (const entry of placed) {
		if (entry.top >= clusterBottom) flush();
		let column = columnBottoms.findIndex((bottom) => bottom <= entry.top);
		if (column < 0) column = columnBottoms.length;
		columnBottoms[column] = entry.top + options.chipHeight;
		clusterBottom = Math.max(clusterBottom, entry.top + options.chipHeight);
		cluster.push({ ...entry, column });
	}
	flush();
	return boxes;
}

// ---- Month cells ----

export type MonthDayEntry<E> =
	| { kind: "event"; key: string; event: E }
	| { kind: "task"; key: string; item: CalendarTaskItem }
	| { kind: "pending"; key: string; count: number };

export type MonthDayEntries<E> = {
	/** The chips the cell shows, in reading order. */
	shown: MonthDayEntry<E>[];
	/** How many more the day has, behind the cell's "N more". */
	hidden: number;
};

/**
 * What one month cell lists, in reading order: the pending-tasks chip, date-only tasks, then events and
 * timed tasks together by start time. `events` must already be in start order.
 *
 * A cell has `limit` rows. When the day has more than that, events keep their rows and tasks share
 * what is left, but always at least one, so neither a busy task list hides the day's meetings nor a busy
 * day hides that there are tasks. Without tasks this is the first `limit` events, as before.
 */
export function pickMonthDayEntries<E extends { id: string; startsAt: string }>(events: readonly E[], tasks: CalendarDayTasks | undefined, pendingCount: number, limit: number): MonthDayEntries<E> {
	const entries: MonthDayEntry<E>[] = [];
	if (pendingCount > 0) entries.push({ kind: "pending", key: "tasks-pending", count: pendingCount });
	for (const item of tasks?.allDay ?? []) entries.push({ kind: "task", key: `task-${item.key}`, item });
	const timed = [...(tasks?.timed ?? [])].sort((a, b) => instant(a.dueAt) - instant(b.dueAt));
	let next = 0;
	for (const event of events) {
		const start = new Date(event.startsAt).getTime();
		while (next < timed.length && instant(timed[next].dueAt) < start) {
			entries.push({ kind: "task", key: `task-${timed[next].key}`, item: timed[next] });
			next += 1;
		}
		entries.push({ kind: "event", key: `${event.id}-${event.startsAt}`, event });
	}
	for (; next < timed.length; next += 1) entries.push({ kind: "task", key: `task-${timed[next].key}`, item: timed[next] });
	if (entries.length <= limit) return { shown: entries, hidden: 0 };

	const taskCount = entries.length - events.length;
	let eventRows = Math.min(events.length, limit - Math.min(1, taskCount));
	let taskRows = Math.min(taskCount, limit - eventRows);
	const shown = entries.filter((entry) => {
		if (entry.kind === "event") return eventRows-- > 0;
		return taskRows-- > 0;
	});
	return { shown, hidden: entries.length - shown.length };
}
