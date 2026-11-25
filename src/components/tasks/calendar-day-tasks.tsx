"use client";

import { memo, useCallback, useMemo, useState } from "react";
import { addDays, CALENDAR_HOUR_HEIGHT, dateKey, eventPosition } from "@/app/(calendar)/calendar/utils";
import type { CalendarEvent } from "@/app/(calendar)/calendar/types";
import { getUserTimeZone } from "@/lib/time/utils";
import { CALENDAR_TASK_CHIP_HEIGHT, CalendarTaskChip, CalendarTaskGroupChip } from "./calendar-task-chip";
import { layoutTimedTasks, timedTaskRowStart } from "./calendar-task-utils";
import { useCalendarTasks } from "./use-calendar-tasks";

/** Pixels between the column edge and a chip (the events' `left-1 right-1`), and between two chips of a row. */
const EDGE = 4;
const GAP = 2;

type CalendarDayTasksProps = {
	day: Date;
	/** Every visible day, so all columns of the view share one tasks query. */
	days: readonly Date[];
	today: Date;
	/** The calendar's events, to keep task chips off their titles. */
	events: readonly CalendarEvent[];
};

/**
 * The timed tasks of one day column of the week and day views, each at its due time. Tasks too close
 * together to read side by side in a column this wide show as one "N tasks" chip.
 */
function CalendarDayTasksImpl({ day, days, today, events }: CalendarDayTasksProps) {
	const tasks = useCalendarTasks(days, today);
	const timed = tasks.byDay.get(dateKey(day))?.timed;
	// The width the chips share, from a ruler laid across the column. A ref callback runs before the
	// first paint, so chips never show at one width and then merge.
	const [columnWidth, setColumnWidth] = useState<number>();
	const measure = useCallback((ruler: HTMLDivElement | null) => {
		if (!ruler) return;
		const update = () => setColumnWidth(ruler.offsetWidth);
		update();
		const observer = new ResizeObserver(update);
		observer.observe(ruler);
		return () => observer.disconnect();
	}, []);
	const boxes = useMemo(() => {
		if (!timed?.length) return [];
		const nextDay = addDays(day, 1);
		const busy = events.flatMap((event) => {
			if (!(new Date(event.startsAt) < nextDay && new Date(event.endsAt) > day)) return [];
			const position = eventPosition(event, day);
			return position ? [{ top: position.top, bottom: position.top + position.height }] : [];
		});
		return layoutTimedTasks(timed, getUserTimeZone(), { hourHeight: CALENDAR_HOUR_HEIGHT, chipHeight: CALENDAR_TASK_CHIP_HEIGHT, busy, columnWidth });
	}, [timed, events, day, columnWidth]);

	if (!timed?.length) return null;
	return (
		<>
			<div ref={measure} aria-hidden="true" className="pointer-events-none invisible absolute top-0 h-0" style={{ left: EDGE, right: EDGE }} />
			{boxes.map((box) => {
				const start = timedTaskRowStart(box);
				const share = (1 - start) / box.columns;
				return (
					// Above the events and their resize handles (z-10, z-20), below the current-time line (z-30).
					<div key={box.key} className="absolute z-[25]" style={{
						top: box.top,
						left: `calc(${EDGE}px + (100% - ${2 * EDGE}px) * ${start + share * box.column})`,
						width: `calc((100% - ${2 * EDGE}px) * ${share} - ${box.column < box.columns - 1 ? GAP : 0}px)`,
					}}>
						{box.kind === "group" ? <CalendarTaskGroupChip items={box.items} tasks={tasks} /> : <CalendarTaskChip item={box.item} tasks={tasks} showTime />}
					</div>
				);
			})}
		</>
	);
}

export const CalendarDayTasks = memo(CalendarDayTasksImpl);
