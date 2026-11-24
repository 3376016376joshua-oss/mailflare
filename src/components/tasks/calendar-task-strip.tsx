"use client";

import { useState } from "react";
import { ChevronDown } from "@/components/icons";
import { useLanguage } from "@/components/language-provider";
import { dateKey } from "@/app/(calendar)/calendar/utils";
import { cn } from "@/lib/utils";
import { CalendarPendingTasksChip, CalendarTaskChip } from "./calendar-task-chip";
import { visibleChipCount } from "./calendar-task-utils";
import { useCalendarTasks } from "./use-calendar-tasks";

/** Rows a day shows before the strip offers to expand. */
const COLLAPSED_ROWS = 3;

/**
 * The strip directly under the week and day header: date-only tasks of each visible day, and on today
 * the pending-tasks chip. The calendar has no all-day row, so tasks without a time get this one. It
 * takes no room while no visible day has such a task.
 */
export function CalendarTaskStrip({ days, today }: { days: readonly Date[]; today: Date }) {
	const { t } = useLanguage();
	const tasks = useCalendarTasks(days, today);
	const [expanded, setExpanded] = useState(false);

	const columns = days.map((day) => {
		const key = dateKey(day);
		const items = tasks.byDay.get(key)?.allDay ?? [];
		const pending = key === tasks.todayKey ? tasks.pendingCount : 0;
		return { key, items, pending, rows: items.length + (pending > 0 ? 1 : 0) };
	});
	const rows = Math.max(...columns.map((column) => column.rows));
	if (rows === 0) return null;
	const overflowing = rows > COLLAPSED_ROWS;

	return (
		<div
			role="group"
			aria-label={t("tasks.calendar.strip")}
			// z-40 like the day header: the current-time line of the grid below (z-30) must pass under both.
			className={cn("sticky top-14 z-40 grid border-b border-neutral-200 bg-white", expanded && "max-h-[40vh] overflow-y-auto overscroll-contain")}
			style={{ gridTemplateColumns: `64px repeat(${days.length}, minmax(0, 1fr))` }}
		>
			<div className="flex flex-col items-end gap-0.5 py-1.5 pr-3 text-xs text-neutral-700">
				<span>{t("tasks.title")}</span>
				{overflowing && (
					<button
						type="button"
						aria-expanded={expanded}
						aria-label={t(expanded ? "tasks.calendar.showFewer" : "tasks.calendar.showAll")}
						title={t(expanded ? "tasks.calendar.showFewer" : "tasks.calendar.showAll")}
						onClick={() => setExpanded((open) => !open)}
						className="-mr-1 flex h-6 w-6 items-center justify-center rounded-full text-neutral-600 hover:bg-neutral-100"
					>
						<ChevronDown className={cn("h-4 w-4 transition-transform motion-reduce:transition-none", expanded && "rotate-180")} />
					</button>
				)}
			</div>
			{columns.map((column) => {
				// The pending chip takes the first row of today.
				const room = COLLAPSED_ROWS - (column.pending > 0 ? 1 : 0);
				const shown = expanded ? column.items.length : visibleChipCount(column.items.length, room);
				const hidden = column.items.length - shown;
				return (
					<div key={column.key} className="min-w-0 space-y-0.5 border-l border-neutral-100 p-1">
						{column.pending > 0 && <CalendarPendingTasksChip count={column.pending} tasks={tasks} />}
						{column.items.slice(0, shown).map((item) => <CalendarTaskChip key={item.key} item={item} tasks={tasks} />)}
						{hidden > 0 && (
							<button type="button" onClick={() => setExpanded(true)} className="block h-5 w-full truncate rounded-md px-1.5 text-left text-[11px] font-medium text-neutral-600 hover:bg-neutral-100">
								{t("calendar.moreEvents", { count: hidden })}
							</button>
						)}
					</div>
				);
			})}
		</div>
	);
}
