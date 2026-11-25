"use client";

import { memo, useCallback, useEffect, useRef, useState } from "react";
import type { KeyboardEvent, PointerEvent as ReactPointerEvent, Ref } from "react";
import Link from "next/link";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { CalendarDays, ChevronRight, CornerDownRight, FolderInput, Mail, MoreVertical, Repeat2, Trash2 } from "@/components/icons";
import { useLanguage } from "@/components/language-provider";
import { confirmDestructive } from "@/components/ui/confirm-dialog";
import { isPendingId } from "@/lib/tasks/cache-utils";
import { describeTaskRepeat, formatTaskDue } from "@/lib/tasks/format";
import { TASK_NOTES_MAX, TASK_TITLE_MAX, isTaskOverdue } from "@/lib/tasks/task-utils";
import type { Task, TaskList } from "@/lib/tasks/types";
import { cn } from "@/lib/utils";
import { AutoGrowTextarea, GripIcon, TaskCheckbox, TaskChip, TaskStarButton, taskChipLinkClass, taskIconButtonClass, taskMenuClass, taskMenuItemClass } from "./task-controls";
import type { TaskMoveDirection } from "./task-order-utils";
import { TaskScheduleDialog } from "./task-schedule-dialog";
import { taskScopeHref } from "./task-view-utils";
import type { TaskActions } from "./use-task-actions";

export type TaskRowReorder = {
	/** Starts a pointer drag from the handle. */
	startDrag: (event: ReactPointerEvent, id: string, label: string) => void;
	/** Moves the task one step with the keyboard. */
	move: (id: string, direction: TaskMoveDirection) => void;
};

export type TaskRowProps = {
	task: Task;
	/** 1 for a subtask shown under its parent. */
	depth?: 0 | 1;
	/** The row being edited: it shows its notes box and the date and repeat controls. */
	active: boolean;
	onActiveChange: (id: string | null) => void;
	actions: TaskActions;
	lists: readonly TaskList[];
	now: Date;
	timeZone: string;
	/** Shown as a chip in views that mix lists. */
	listTitle?: string;
	/** Makes that chip switch lists in place (the side panel); without it the chip links to the list in the Tasks app. */
	onOpenList?: (listId: string) => void;
	/** Present where tasks keep a manual order (a list, not a smart view). */
	reorder?: TaskRowReorder;
	dragging?: boolean;
	subtaskCount?: number;
	onAddSubtask?: (id: string) => void;
};

const KEY_DIRECTIONS: Record<string, TaskMoveDirection> = { ArrowUp: "up", ArrowDown: "down", ArrowRight: "in", ArrowLeft: "out" };
const quietControl = "opacity-0 focus-visible:opacity-100 group-hover/task:opacity-100 group-focus-within/task:opacity-100 data-[state=open]:opacity-100 [@media(hover:none)]:opacity-100";

/**
 * The notes box of the task being edited. It saves when focus leaves it and also when it is taken away
 * (the row stops being edited as the pointer goes down elsewhere, before any blur), so typed notes are never lost.
 */
function TaskNotesEditor({ notes, onCommit, onEscape, inputRef }: { notes: string; onCommit: (notes: string) => void; onEscape: () => void; inputRef: Ref<HTMLTextAreaElement> }) {
	const { t } = useLanguage();
	const [draft, setDraft] = useState<string | null>(null);
	const unsaved = useRef<string | null>(null);
	const commit = useRef(onCommit);
	useEffect(() => { commit.current = onCommit; });
	const flush = useCallback(() => {
		const value = unsaved.current;
		unsaved.current = null;
		if (value !== null) commit.current(value.trim());
	}, []);
	useEffect(() => flush, [flush]);

	return (
		<AutoGrowTextarea
			ref={inputRef}
			aria-label={t("tasks.app.notesLabel")}
			placeholder={t("tasks.app.notesPlaceholder")}
			value={draft ?? notes}
			maxLength={TASK_NOTES_MAX}
			onChange={(event) => { unsaved.current = event.target.value; setDraft(event.target.value); }}
			onBlur={() => { flush(); setDraft(null); }}
			onKeyDown={(event) => {
				if (event.key !== "Escape" || event.nativeEvent.isComposing) return;
				event.preventDefault();
				unsaved.current = null;
				setDraft(null);
				event.currentTarget.blur();
				onEscape();
			}}
			className="-mt-1 pb-2 pr-1 text-xs leading-4 text-neutral-600 placeholder:text-neutral-400"
		/>
	);
}

/**
 * One open task: checkbox, title and notes edited in place, its due date, repeat rule and email as
 * chips, a star and a menu. Shared by the Tasks app and the side panel.
 */
export const TaskRow = memo(function TaskRow({ task, depth = 0, active, onActiveChange, actions, lists, now, timeZone, listTitle, onOpenList, reorder, dragging, subtaskCount = 0, onAddSubtask }: TaskRowProps) {
	const { t } = useLanguage();
	const [title, setTitle] = useState<string | null>(null);
	const [scheduling, setScheduling] = useState(false);
	const notesRef = useRef<HTMLTextAreaElement | null>(null);
	const unsavedTitle = useRef<string | null>(null);
	// Set by a menu item that sends focus somewhere new, so the closing menu does not pull it back to its button.
	const keepFocusAway = useRef(false);
	const pending = isPendingId(task.id);
	const overdue = isTaskOverdue(task, now, timeZone);
	const due = formatTaskDue(task, t, { now, timeZone });
	const otherLists = lists.filter((list) => list.id !== task.listId && !isPendingId(list.id));

	// The typed title also lives in a ref: Enter and Escape settle it and then blur, and that blur must find nothing left to save.
	function commitTitle() {
		const typed = unsavedTitle.current;
		unsavedTitle.current = null;
		setTitle(null);
		const next = typed?.trim();
		if (next && next !== task.title) actions.update(task.id, { title: next });
	}

	function onTitleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
		if (event.nativeEvent.isComposing) return;
		if (event.key === "Enter" && !event.shiftKey) {
			event.preventDefault();
			commitTitle();
			event.currentTarget.blur();
			onActiveChange(null);
		} else if (event.key === "Escape") {
			event.preventDefault();
			unsavedTitle.current = null;
			setTitle(null);
			event.currentTarget.blur();
			onActiveChange(null);
		}
	}

	async function remove() {
		if (subtaskCount > 0 && !(await confirmDestructive({ title: t("tasks.action.delete"), message: t("tasks.app.deleteWithSubtasks", { count: subtaskCount }), confirmLabel: t("common.delete") }))) return;
		actions.remove(task.id);
	}

	return (
		<div
			data-sort-id={reorder ? task.id : undefined}
			data-task-row={task.id}
			className={cn("group/task relative flex items-start rounded-2xl pr-1 transition-colors", active ? "bg-[#f2f6fc]" : "hover:bg-neutral-100/70", dragging && "opacity-40")}
			style={depth ? { marginLeft: 28 } : undefined}
		>
			{reorder && !pending ? (
				<button
					type="button"
					data-task-handle={task.id}
					aria-label={t("tasks.app.reorder", { title: task.title })}
					title={t("tasks.app.reorderHint")}
					onPointerDown={(event) => reorder.startDrag(event, task.id, task.title)}
					onKeyDown={(event) => {
						const direction = KEY_DIRECTIONS[event.key];
						if (!direction || event.altKey || event.ctrlKey || event.metaKey) return;
						event.preventDefault();
						reorder.move(task.id, direction);
					}}
					className={cn("mt-1.5 flex h-6 w-5 shrink-0 cursor-grab touch-none items-center justify-center rounded text-neutral-400 hover:text-neutral-700 focus-visible:outline-2 focus-visible:outline-blue-600 active:cursor-grabbing", quietControl)}
				>
					<GripIcon />
				</button>
			) : <span aria-hidden="true" className={reorder ? "w-5 shrink-0" : "w-1.5 shrink-0"} />}
			<TaskCheckbox checked={false} disabled={pending} onToggle={() => actions.update(task.id, { completed: true })} />
			<div className="min-w-0 flex-1">
				<AutoGrowTextarea
					aria-label={t("tasks.app.titleLabel")}
					data-task-title=""
					value={title ?? task.title}
					readOnly={pending}
					maxLength={TASK_TITLE_MAX}
					spellCheck={active}
					onFocus={() => onActiveChange(task.id)}
					onChange={(event) => {
						const typed = event.target.value.replace(/[\r\n]+/g, " ");
						unsavedTitle.current = typed;
						setTitle(typed);
					}}
					onBlur={commitTitle}
					onKeyDown={onTitleKeyDown}
					className="py-2 pr-1 text-sm leading-5 text-neutral-900 placeholder:text-neutral-400"
				/>
				{active && !pending ? (
					<TaskNotesEditor inputRef={notesRef} notes={task.notes} onCommit={(next) => { if (next !== task.notes) actions.update(task.id, { notes: next }); }} onEscape={() => onActiveChange(null)} />
				) : task.notes ? (
					<p
						onClick={() => { onActiveChange(task.id); requestAnimationFrame(() => notesRef.current?.focus()); }}
						className="-mt-1 mb-2 line-clamp-2 cursor-text whitespace-pre-wrap break-words pr-1 text-xs leading-4 text-neutral-500"
					>
						{task.notes}
					</p>
				) : null}
				{(due || task.repeat || task.message || listTitle || (active && !pending)) && (
					<div className="flex min-w-0 flex-wrap items-center gap-1.5 pb-2">
						{due && <TaskChip tone={overdue ? "danger" : "neutral"} icon={<CalendarDays size={12} aria-hidden="true" className="shrink-0" />} onClick={pending ? undefined : () => setScheduling(true)} label={t("tasks.app.dueChip", { due })}>{due}</TaskChip>}
						{task.repeat && <TaskChip icon={<Repeat2 size={12} aria-hidden="true" className="shrink-0" />} onClick={pending ? undefined : () => setScheduling(true)} label={t("tasks.app.repeatChip", { repeat: describeTaskRepeat(task.repeat, t) })}>{describeTaskRepeat(task.repeat, t)}</TaskChip>}
						{active && !pending && !due && <TaskChip tone="quiet" icon={<CalendarDays size={12} aria-hidden="true" className="shrink-0" />} onClick={() => setScheduling(true)}>{t("tasks.app.addDate")}</TaskChip>}
						{active && !pending && due && !task.repeat && depth === 0 && <TaskChip tone="quiet" icon={<Repeat2 size={12} aria-hidden="true" className="shrink-0" />} onClick={() => setScheduling(true)}>{t("tasks.app.addRepeat")}</TaskChip>}
						{task.message && (
							<Link href={`/inbox/${encodeURIComponent(task.message.id)}`} title={t("tasks.app.openEmail")} className={cn(taskChipLinkClass, "max-w-[16rem]")}>
								<Mail size={12} aria-hidden="true" className="shrink-0" />
								<span className="truncate">{task.message.subject || t("tasks.app.emailChip")}</span>
							</Link>
						)}
						{listTitle && (onOpenList
							? <TaskChip onClick={() => onOpenList(task.listId)} className="max-w-[12rem] border-transparent bg-neutral-100">{listTitle}</TaskChip>
							: <Link href={taskScopeHref({ kind: "list", listId: task.listId })} className={cn(taskChipLinkClass, "max-w-[12rem] border-transparent bg-neutral-100")}><span className="truncate">{listTitle}</span></Link>)}
					</div>
				)}
			</div>
			<div className="flex shrink-0 items-center pt-0.5">
				<TaskStarButton starred={task.starred} disabled={pending} onToggle={() => actions.update(task.id, { starred: !task.starred })} className={task.starred ? undefined : quietControl} />
				<DropdownMenu.Root>
					<DropdownMenu.Trigger asChild>
						<button type="button" disabled={pending} aria-label={t("tasks.app.taskMenu", { title: task.title })} className={cn(taskIconButtonClass, quietControl)}><MoreVertical size={18} aria-hidden="true" /></button>
					</DropdownMenu.Trigger>
					<DropdownMenu.Portal>
						<DropdownMenu.Content align="end" sideOffset={4} collisionPadding={8} className={taskMenuClass} onCloseAutoFocus={(event) => { if (keepFocusAway.current) event.preventDefault(); keepFocusAway.current = false; }}>
							{onAddSubtask && <DropdownMenu.Item className={taskMenuItemClass} onSelect={() => { keepFocusAway.current = true; onAddSubtask(task.id); }}><CornerDownRight size={16} aria-hidden="true" />{t("tasks.action.addSubtask")}</DropdownMenu.Item>}
							<DropdownMenu.Item className={taskMenuItemClass} onSelect={() => { keepFocusAway.current = true; setScheduling(true); }}><CalendarDays size={16} aria-hidden="true" />{t("tasks.app.schedule.title")}</DropdownMenu.Item>
							{otherLists.length > 0 && (
								<DropdownMenu.Sub>
									<DropdownMenu.SubTrigger className={cn(taskMenuItemClass, "data-[state=open]:bg-neutral-100")}><FolderInput size={16} aria-hidden="true" /><span className="flex-1">{t("tasks.app.moveToList")}</span><ChevronRight size={14} aria-hidden="true" className="rtl:rotate-180" /></DropdownMenu.SubTrigger>
									<DropdownMenu.Portal>
										<DropdownMenu.SubContent sideOffset={6} collisionPadding={8} className={cn(taskMenuClass, "max-h-72 max-w-64 overflow-y-auto")}>
											{otherLists.map((list) => <DropdownMenu.Item key={list.id} className={taskMenuItemClass} onSelect={() => actions.move(task.id, { listId: list.id })}><span className="truncate">{list.title}</span></DropdownMenu.Item>)}
										</DropdownMenu.SubContent>
									</DropdownMenu.Portal>
								</DropdownMenu.Sub>
							)}
							<DropdownMenu.Separator className="my-1 h-px bg-neutral-100" />
							<DropdownMenu.Item className={cn(taskMenuItemClass, "text-red-600")} onSelect={() => void remove()}><Trash2 size={16} aria-hidden="true" />{t("tasks.action.delete")}</DropdownMenu.Item>
						</DropdownMenu.Content>
					</DropdownMenu.Portal>
				</DropdownMenu.Root>
			</div>
			{scheduling && <TaskScheduleDialog task={task} onClose={() => setScheduling(false)} onSave={(changes) => actions.update(task.id, changes)} />}
		</div>
	);
});
