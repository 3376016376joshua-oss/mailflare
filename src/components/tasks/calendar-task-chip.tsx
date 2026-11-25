"use client";

import { AlertCircle, Check, ListChecks, Repeat2 } from "@/components/icons";
import { useLanguage } from "@/components/language-provider";
import { formatEventTime } from "@/app/(calendar)/calendar/utils";
import { cn } from "@/lib/utils";
import type { CalendarTaskItem } from "./calendar-task-utils";
import type { CalendarTasks } from "./use-calendar-tasks";

/**
 * A task on the calendar: a compact outlined chip with a round checkbox, so it never reads as an event
 * (events are filled blocks). The checkbox completes or reopens the task; the title opens it in the
 * Tasks panel. A projected occurrence of a repeating task has no row to check off yet, so it shows a
 * repeat mark instead of the checkbox.
 */

/** Height of a chip in pixels (`h-5`); the time grid lays chips out with it. */
export const CALENDAR_TASK_CHIP_HEIGHT = 20;

const chipClass = "flex h-5 min-w-0 items-center rounded-md border bg-white text-[11px] font-medium leading-none";

type CalendarTaskChipProps = {
	item: CalendarTaskItem;
	tasks: Pick<CalendarTasks, "toggle" | "open">;
	/** Adds the time of a timed task after the title where the chip is wide enough (the day view). */
	showTime?: boolean;
	className?: string;
};

export function CalendarTaskChip({ item, tasks, showTime = false, className }: CalendarTaskChipProps) {
	const { t } = useLanguage();
	const time = item.dueAt ? formatEventTime(new Date(item.dueAt)) : null;
	return (
		<div className={cn(chipClass, "@container", item.projected ? "border-dashed border-neutral-300" : "border-neutral-300 hover:border-neutral-400", item.saving && "opacity-60", className)}>
			{item.projected ? (
				<span role="img" aria-label={t("tasks.calendar.repeats")} title={t("tasks.calendar.repeats")} className="flex h-full w-5 shrink-0 items-center justify-center text-neutral-500">
					<Repeat2 size={11} aria-hidden="true" />
				</span>
			) : (
				<button
					type="button"
					role="checkbox"
					aria-checked={item.completed}
					aria-label={t(item.completed ? "tasks.calendar.reopen" : "tasks.calendar.complete", { title: item.title })}
					title={t(item.completed ? "tasks.action.reopen" : "tasks.action.complete")}
					disabled={item.saving}
					onClick={() => tasks.toggle(item)}
					className="group/check flex h-full w-5 shrink-0 items-center justify-center rounded-l-md outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-500 disabled:cursor-default"
				>
					<span className={cn("flex h-3 w-3 items-center justify-center rounded-full border", item.completed ? "border-blue-600 bg-blue-600 text-white" : "border-neutral-500 group-hover/check:border-blue-600 group-hover/check:bg-blue-50")}>
						{item.completed && <Check size={8} strokeWidth={3.5} aria-hidden="true" />}
					</span>
				</button>
			)}
			<button
				type="button"
				disabled={item.saving}
				onClick={() => tasks.open(item)}
				title={time ? `${item.title} · ${time}` : item.title}
				className={cn("h-full min-w-0 flex-1 truncate rounded-r-md pr-1.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-500 disabled:cursor-default", item.completed ? "text-neutral-500 line-through" : "text-neutral-800")}
			>
				{item.title}
				{/* The space keeps the title and the time apart for screen readers too. */}
				{showTime && time && <span className="ml-1 hidden font-normal text-neutral-500 @[14rem]:inline"> {time}</span>}
			</button>
		</div>
	);
}

/**
 * The tasks of a time slot too crowded to show side by side, as one "N tasks" chip. It opens the Tasks
 * panel on their day, where each can be read, checked off and changed. Hovering lists what it stands for.
 */
export function CalendarTaskGroupChip({ items, tasks, className }: { items: readonly CalendarTaskItem[]; tasks: Pick<CalendarTasks, "openDay">; className?: string }) {
	const { t } = useLanguage();
	const label = t("tasks.calendar.group", { count: items.length });
	const allCompleted = items.every((item) => item.completed);
	return (
		<button
			type="button"
			onClick={() => tasks.openDay(items[0].date)}
			aria-label={`${label}: ${items.map((item) => item.title).join(", ")}`}
			title={items.map((item) => (item.dueAt ? `${item.title} · ${formatEventTime(new Date(item.dueAt))}` : item.title)).join("\n")}
			className={cn(chipClass, "@container w-full gap-1 border-neutral-300 px-1.5 text-left outline-none hover:border-neutral-400 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-500", allCompleted ? "text-neutral-500 line-through" : "text-neutral-800", className)}
		>
			<ListChecks size={12} aria-hidden="true" className="hidden shrink-0 text-neutral-500 @[3.5rem]:block" />
			<span className="min-w-0 flex-1 truncate">{label}</span>
		</button>
	);
}

/** The one chip on today that stands for every open task left over from earlier days. It opens the Tasks panel. */
export function CalendarPendingTasksChip({ count, tasks, className }: { count: number; tasks: Pick<CalendarTasks, "openPending">; className?: string }) {
	const { t } = useLanguage();
	return (
		<button
			type="button"
			onClick={tasks.openPending}
			title={t("tasks.calendar.pendingHint")}
			className={cn(chipClass, "w-full gap-1 border-amber-300 bg-amber-50 px-1 text-left text-amber-900 outline-none hover:bg-amber-100 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-amber-500", className)}
		>
			<AlertCircle size={12} aria-hidden="true" className="shrink-0" />
			<span className="min-w-0 flex-1 truncate">{t("tasks.calendar.pending", { count })}</span>
		</button>
	);
}
