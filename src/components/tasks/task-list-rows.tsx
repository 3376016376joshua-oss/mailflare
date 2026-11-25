"use client";

import { memo, useEffect, useRef, useState } from "react";
import type { Ref } from "react";
import { CalendarDays, Plus, Repeat2, Trash2 } from "@/components/icons";
import { useLanguage } from "@/components/language-provider";
import { confirmDestructive } from "@/components/ui/confirm-dialog";
import { isPendingId } from "@/lib/tasks/cache-utils";
import { TASK_TITLE_MAX } from "@/lib/tasks/task-utils";
import type { Task, TaskOccurrence } from "@/lib/tasks/types";
import { formatUserDate } from "@/lib/time/utils";
import { cn } from "@/lib/utils";
import { TaskCheckbox, TaskChip, taskIconButtonClass } from "./task-controls";
import type { TaskActions } from "./use-task-actions";

/**
 * The row a task is typed into: Enter adds it and keeps the box ready for the next one. With `onCancel`
 * (a subtask box opened from a task's menu) Escape, or leaving it empty, closes it.
 */
export function TaskAddRow({ placeholder, onAdd, onCancel, autoFocus, inputRef, indent, disabled, aligned }: {
	placeholder: string;
	onAdd: (title: string) => void;
	onCancel?: () => void;
	autoFocus?: boolean;
	inputRef?: Ref<HTMLInputElement>;
	/** Sits under a parent task, at subtask depth. */
	indent?: boolean;
	disabled?: boolean;
	/** Leaves room for the drag handle column, so the box lines up with the tasks of a list. */
	aligned?: boolean;
}) {
	const [title, setTitle] = useState("");
	const [focused, setFocused] = useState(false);
	const formRef = useRef<HTMLFormElement | null>(null);

	// Not the `autoFocus` attribute: the box is opened from a menu, which is still letting go of focus when it mounts.
	useEffect(() => {
		if (!autoFocus) return;
		const frame = requestAnimationFrame(() => formRef.current?.querySelector("input")?.focus());
		return () => cancelAnimationFrame(frame);
	}, [autoFocus]);

	function submit(event: React.FormEvent) {
		event.preventDefault();
		const next = title.trim();
		if (!next) return;
		onAdd(next);
		setTitle("");
	}

	return (
		<form ref={formRef} onSubmit={submit} className={cn("flex items-center rounded-2xl pr-2 transition-colors", focused ? "bg-[#f2f6fc]" : "hover:bg-neutral-100/70")} style={indent ? { marginLeft: 28 } : undefined}>
			<span aria-hidden="true" className={aligned ? "w-5 shrink-0" : "w-1.5 shrink-0"} />
			<span aria-hidden="true" className="flex h-9 w-9 shrink-0 items-center justify-center text-blue-600"><Plus size={18} /></span>
			<input
				ref={inputRef}
				type="text"
				value={title}
				disabled={disabled}
				maxLength={TASK_TITLE_MAX}
				placeholder={placeholder}
				aria-label={placeholder}
				enterKeyHint="done"
				onChange={(event) => setTitle(event.target.value)}
				onFocus={() => setFocused(true)}
				onBlur={() => {
					setFocused(false);
					if (!title.trim()) onCancel?.();
				}}
				onKeyDown={(event) => {
					if (event.key !== "Escape") return;
					event.preventDefault();
					setTitle("");
					if (onCancel) onCancel();
					else event.currentTarget.blur();
				}}
				className="h-9 min-w-0 flex-1 bg-transparent text-sm text-neutral-900 placeholder:text-neutral-500 focus:outline-none disabled:cursor-not-allowed"
			/>
		</form>
	);
}

/**
 * A future occurrence of a repeating task among the tasks of a day. There is no row to check off yet, so
 * it shows a repeat mark instead of a checkbox, and its title leads to the open task that repeats.
 */
export function TaskOccurrenceRow({ occurrence, due, listTitle, onOpen }: { occurrence: TaskOccurrence; due: string | null; listTitle?: string; onOpen?: (taskId: string) => void }) {
	const { t } = useLanguage();
	return (
		<div className="flex items-start rounded-2xl pr-1 transition-colors hover:bg-neutral-100/70">
			<span aria-hidden="true" className="w-1.5 shrink-0" />
			<span role="img" aria-label={t("tasks.calendar.repeats")} title={t("tasks.calendar.repeats")} className="flex h-9 w-9 shrink-0 items-center justify-center text-neutral-500"><Repeat2 size={16} aria-hidden="true" /></span>
			<div className="min-w-0 flex-1">
				<div className="py-2 pr-1">
					{onOpen
						? <button type="button" onClick={() => onOpen(occurrence.taskId)} className="block max-w-full break-words rounded text-left text-sm leading-5 text-neutral-900 hover:underline focus-visible:outline-2 focus-visible:outline-blue-600">{occurrence.title}</button>
						: <p className="break-words text-sm leading-5 text-neutral-900">{occurrence.title}</p>}
				</div>
				{(due || listTitle) && (
					<div className="flex min-w-0 flex-wrap items-center gap-1.5 pb-2">
						{due && <TaskChip icon={<CalendarDays size={12} aria-hidden="true" className="shrink-0" />}>{due}</TaskChip>}
						{listTitle && <TaskChip className="max-w-[12rem] border-transparent bg-neutral-100">{listTitle}</TaskChip>}
					</div>
				)}
			</div>
		</div>
	);
}

/** A finished task in the Completed section: struck through, with its completion date; the check reopens it. */
export const CompletedTaskRow = memo(function CompletedTaskRow({ task, actions, aligned, subtaskCount = 0 }: { task: Task; actions: TaskActions; aligned?: boolean; subtaskCount?: number }) {
	const { t } = useLanguage();
	const pending = isPendingId(task.id);

	// Deleting a task deletes its subtasks, which are listed here as rows of their own.
	async function remove() {
		if (subtaskCount > 0 && !(await confirmDestructive({ title: t("tasks.action.delete"), message: t("tasks.app.deleteWithSubtasks", { count: subtaskCount }), confirmLabel: t("common.delete") }))) return;
		actions.remove(task.id);
	}
	return (
		<div data-task-row={task.id} className="group/task flex items-start rounded-2xl pr-1 transition-colors hover:bg-neutral-100/70">
			<span aria-hidden="true" className={aligned ? "w-5 shrink-0" : "w-1.5 shrink-0"} />
			<TaskCheckbox checked disabled={pending} onToggle={() => actions.update(task.id, { completed: false })} />
			<div className="min-w-0 flex-1 py-2">
				<p className="break-words text-sm leading-5 text-neutral-500 line-through">{task.title}</p>
				{task.completedAt && <p className="mt-0.5 text-xs leading-4 text-neutral-500">{t("tasks.app.completedOn", { date: formatUserDate(task.completedAt, { weekday: "short", month: "short", day: "numeric" }) })}</p>}
			</div>
			<button type="button" disabled={pending} onClick={() => void remove()} aria-label={t("tasks.app.deleteTask", { title: task.title })} title={t("tasks.action.delete")} className={cn(taskIconButtonClass, "mt-0.5 opacity-0 focus-visible:opacity-100 group-hover/task:opacity-100 [@media(hover:none)]:opacity-100")}>
				<Trash2 size={16} aria-hidden="true" />
			</button>
		</div>
	);
});
