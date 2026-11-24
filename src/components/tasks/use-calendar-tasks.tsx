"use client";

import { useCallback, useMemo } from "react";
import toast from "react-hot-toast";
import { dateKey } from "@/app/(calendar)/calendar/utils";
import { useLanguage } from "@/components/language-provider";
import { openTasksPanel, useTasks, useUpdateTask } from "@/lib/tasks/client";
import { taskErrorMessage } from "@/lib/tasks/format";
import type { TasksResponse } from "@/lib/tasks/types";
import { getUserTimeZone } from "@/lib/time/utils";
import { useCalendarTaskPrefs } from "./calendar-task-prefs";
import { buildCalendarTaskItems, countPendingTasks, groupCalendarTasksByDay } from "./calendar-task-utils";
import type { CalendarDayTasks, CalendarTaskItem } from "./calendar-task-utils";

/**
 * The tasks of a calendar window, for whichever calendar piece asks (the strip under the day header,
 * a day column, the month grid). Every piece of one view passes the same days, so they share one query
 * and one cache entry with the rest of Tasks: a task checked off here is checked off in the panel in
 * the same frame, and the other way round.
 */

export type CalendarTasks = {
	/** Chips per calendar date ("YYYY-MM-DD" in the viewer's zone). Empty while tasks are hidden or loading. */
	byDay: ReadonlyMap<string, CalendarDayTasks>;
	/** Today's date key, where the pending-tasks chip goes. */
	todayKey: string;
	/** Open tasks left over from earlier days. */
	pendingCount: number;
	/** Completes an open task, reopens a completed one. */
	toggle: (item: CalendarTaskItem) => void;
	/** Shows the task in the Tasks panel. */
	open: (item: CalendarTaskItem) => void;
	/** Shows the overdue tasks in the Tasks panel. */
	openPending: () => void;
};

/** How long the toast that follows a task leaving the calendar offers Undo. */
const UNDO_MS = 6000;
const NO_TASKS: ReadonlyMap<string, CalendarDayTasks> = new Map();

// Every piece of a view groups the same response; do it once per response and switch position.
const grouped = new WeakMap<TasksResponse, Map<string, ReadonlyMap<string, CalendarDayTasks>>>();

function groupedByDay(data: TasksResponse, timeZone: string, showCompleted: boolean): ReadonlyMap<string, CalendarDayTasks> {
	const variant = `${timeZone}|${showCompleted ? 1 : 0}`;
	let variants = grouped.get(data);
	if (!variants) {
		variants = new Map();
		grouped.set(data, variants);
	}
	let days = variants.get(variant);
	if (!days) {
		days = groupCalendarTasksByDay(buildCalendarTaskItems(data, timeZone, { showCompleted }));
		variants.set(variant, days);
	}
	return days;
}

/** `days` are the calendar's visible days in order (start-of-day instants); `today` is the start of today. */
export function useCalendarTasks(days: readonly Date[], today: Date): CalendarTasks {
	const { t } = useLanguage();
	const { showTasks, showCompleted } = useCalendarTaskPrefs();
	const timeZone = getUserTimeZone();
	const from = dateKey(days[0]);
	const to = dateKey(days[days.length - 1]);
	const visible = useTasks({ dueFrom: from, dueTo: to }, { enabled: showTasks });
	// The same query the Today view uses, so the two share a cache entry.
	const dueByToday = useTasks({ view: "today" }, { enabled: showTasks });
	const { mutate: updateTask } = useUpdateTask();

	const byDay = showTasks && visible.data ? groupedByDay(visible.data, timeZone, showCompleted) : NO_TASKS;
	const pendingCount = useMemo(
		() => (showTasks && dueByToday.data ? countPendingTasks(dueByToday.data.tasks, today, timeZone) : 0),
		[showTasks, dueByToday.data, today, timeZone],
	);

	const toggle = useCallback((item: CalendarTaskItem) => {
		if (item.projected || item.saving) return;
		const onError = (error: unknown) => toast.error(taskErrorMessage(error, t));
		updateTask({ id: item.taskId, completed: !item.completed }, { onError });
		// With completed tasks hidden the chip is gone at once, so the way back is offered here.
		if (!item.completed && !showCompleted) {
			toast((shown) => (
				<span className="flex items-center gap-3">
					{t("tasks.calendar.completed")}
					<button
						type="button"
						className="rounded-md px-2 py-1 font-semibold text-blue-700 hover:bg-blue-50"
						onClick={() => {
							toast.dismiss(shown.id);
							updateTask({ id: item.taskId, completed: false }, { onError });
						}}
					>
						{t("undo.button")}
					</button>
				</span>
			), { duration: UNDO_MS });
		}
	}, [updateTask, showCompleted, t]);

	const open = useCallback((item: CalendarTaskItem) => {
		if (!item.saving) openTasksPanel({ taskId: item.taskId });
	}, []);
	const openPending = useCallback(() => openTasksPanel({ view: "today" }), []);

	return { byDay, todayKey: dateKey(today), pendingCount, toggle, open, openPending };
}
