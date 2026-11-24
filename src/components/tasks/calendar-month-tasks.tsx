"use client";

import { CalendarPendingTasksChip, CalendarTaskChip } from "./calendar-task-chip";
import { pickMonthDayEntries } from "./calendar-task-utils";
import type { MonthDayEntries, MonthDayEntry } from "./calendar-task-utils";
import type { CalendarTasks } from "./use-calendar-tasks";

/**
 * Tasks in the month grid: each cell lists its task chips next to its event chips, sharing the cell's
 * few rows. The grid asks `monthDayEntries` what a cell shows and renders the task entries with
 * `CalendarMonthTaskEntry`; event entries stay its own.
 */

/** What the cell for `dayKey` shows in `limit` rows, given its events in start order. */
export function monthDayEntries<E extends { id: string; startsAt: string }>(tasks: CalendarTasks, dayKey: string, events: readonly E[], limit: number): MonthDayEntries<E> {
	return pickMonthDayEntries(events, tasks.byDay.get(dayKey), dayKey === tasks.todayKey ? tasks.pendingCount : 0, limit);
}

type TaskEntry = Exclude<MonthDayEntry<never>, { kind: "event" }>;

export function CalendarMonthTaskEntry({ entry, tasks }: { entry: TaskEntry; tasks: CalendarTasks }) {
	// `rounded` like the month grid's event chips.
	if (entry.kind === "pending") return <CalendarPendingTasksChip count={entry.count} tasks={tasks} className="rounded" />;
	return <CalendarTaskChip item={entry.item} tasks={tasks} className="rounded" />;
}
