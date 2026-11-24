"use client";

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CheckCircle2, ChevronRight } from "@/components/icons";
import { useLanguage } from "@/components/language-provider";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useTasks } from "@/lib/tasks/client";
import { formatTaskDue, taskErrorMessage } from "@/lib/tasks/format";
import { rememberLastTaskList } from "@/lib/tasks/last-list";
import { buildTaskTree, dateInZone } from "@/lib/tasks/task-utils";
import type { Task, TaskList } from "@/lib/tasks/types";
import { getUserTimeZone } from "@/lib/time/utils";
import { cn } from "@/lib/utils";
import { CompletedTaskRow, TaskAddRow } from "./task-list-rows";
import { dropNeedsPendingTask, flattenTaskRows, isSameTaskSpot, keyboardTaskMove, resolveTaskDrop } from "./task-order-utils";
import type { TaskDropTarget, TaskMoveDirection } from "./task-order-utils";
import { TaskRow } from "./task-row";
import type { TaskRowReorder } from "./task-row";
import { defaultDueDateForScope, groupTasksForView, taskScopeQuery } from "./task-view-utils";
import type { TaskScope } from "./task-view-utils";
import { useKeepFocus } from "./use-keep-focus";
import { useSortDrag } from "./use-sort-drag";
import { useTaskActions } from "./use-task-actions";

/** Asks the task list on screen to put the cursor in its "Add a task" box (the Create button sends it). */
export const TASKS_FOCUS_ADD_EVENT = "mailflare:tasks-focus-add";

export function focusTaskAddRow(): void {
	window.dispatchEvent(new Event(TASKS_FOCUS_ADD_EVENT));
}

// The list that was just created. It is not on screen yet when its creator asks, so the request waits here.
let focusAddOnOpen: string | null = null;

/** Asks this list to open with the cursor in its "Add a task" box: a new list is empty, and adding to it is what comes next. */
export function focusTaskAddRowOnOpen(listId: string): void {
	focusAddOnOpen = listId;
}

const SUBTASK_INDENT = 28;
const MOVED_KEYS = { up: "tasks.app.movedUp", down: "tasks.app.movedDown", in: "tasks.app.movedIn", out: "tasks.app.movedOut" } as const;
const EMPTY_KEYS = {
	list: ["tasks.app.emptyList", "tasks.app.emptyListHint"],
	done: ["tasks.app.allDone", "tasks.app.allDoneHint"],
	today: ["tasks.app.emptyToday", "tasks.app.emptyTodayHint"],
	upcoming: ["tasks.app.emptyUpcoming", "tasks.app.emptyUpcomingHint"],
	starred: ["tasks.app.emptyStarred", "tasks.app.emptyStarredHint"],
} as const;
const NO_TASKS: Task[] = [];

/** The current time, refreshed every minute so "overdue" and "Today" stay true on a page left open. */
function useNow(): Date {
	const [now, setNow] = useState(() => new Date());
	useEffect(() => {
		const timer = window.setInterval(() => setNow(new Date()), 60_000);
		return () => window.clearInterval(timer);
	}, []);
	return now;
}

export type TaskListViewProps = {
	/** One list, or a smart view. Give the component a `key` per scope so its editing state starts fresh. */
	scope: TaskScope;
	lists: readonly TaskList[];
	/** The side panel is narrower: tighter gutters, nothing else differs. */
	variant?: "page" | "panel";
	/** A task to scroll to and put the cursor in, once it is on screen. */
	focusTaskId?: string | null;
	onFocusHandled?: () => void;
	/** Answers the Create button (`focusTaskAddRow`). Only one list on screen should. */
	listensForCreate?: boolean;
	/** In a smart view, makes a task's list chip switch lists in place instead of linking to the Tasks app. */
	onOpenList?: (listId: string) => void;
	className?: string;
};

/**
 * The tasks of one list or smart view: the "Add a task" box, the open tasks (in a list: draggable, one
 * level of subtasks), and the collapsed Completed section. The Tasks app and the side panel both render this.
 */
export function TaskListView({ scope, lists, variant = "page", focusTaskId, onFocusHandled, listensForCreate, onOpenList, className }: TaskListViewProps) {
	const { t } = useLanguage();
	const timeZone = getUserTimeZone();
	const now = useNow();
	const today = dateInZone(now, timeZone);
	const scopeKey = scope.kind === "list" ? scope.listId : scope.view;
	// eslint-disable-next-line react-hooks/exhaustive-deps -- a scope is fully named by its kind and key
	const query = useMemo(() => taskScopeQuery(scope), [scope.kind, scopeKey]);
	const { data, isPending, isError, error, refetch } = useTasks(query);
	const actions = useTaskActions();
	const [activeId, setActiveId] = useState<string | null>(null);
	const [subtaskParent, setSubtaskParent] = useState<string | null>(null);
	const [completedOpen, setCompletedOpen] = useState(false);
	const [keyboardMove, setKeyboardMove] = useState<{ id: string; direction: TaskMoveDirection } | null>(null);
	const scrollRef = useRef<HTMLDivElement | null>(null);
	const listRef = useRef<HTMLUListElement | null>(null);
	const addRef = useRef<HTMLInputElement | null>(null);

	const tasks = data?.tasks ?? NO_TASKS;
	const isList = scope.kind === "list";
	const openTasks = useMemo(() => tasks.filter((task) => task.status !== "completed"), [tasks]);
	const completedTasks = useMemo(() => tasks.filter((task) => task.status === "completed"), [tasks]);
	const tree = useMemo(() => (isList ? buildTaskTree(openTasks) : []), [isList, openTasks]);
	// Subtasks of any status, by parent: completed ones are not in the tree but still count.
	const subtaskCounts = useMemo(() => {
		const counts = new Map<string, number>();
		for (const task of tasks) if (task.parentId) counts.set(task.parentId, (counts.get(task.parentId) ?? 0) + 1);
		return counts;
	}, [tasks]);
	const rows = useMemo(() => flattenTaskRows(tree, new Set(subtaskCounts.keys())), [tree, subtaskCounts]);
	const sections = useMemo(() => (scope.kind === "view" ? groupTasksForView(openTasks, scope.view, today, timeZone) : []), [scope, openTasks, today, timeZone]);
	const listTitles = useMemo(() => new Map(lists.map((list) => [list.id, list.title])), [lists]);
	const rowsRef = useRef(rows);
	useEffect(() => { rowsRef.current = rows; });

	const { dragId, startDrag, guardClick, overlay } = useSortDrag<TaskDropTarget>({
		containerRef: listRef,
		indent: SUBTASK_INDENT,
		companions: (id) => rows.filter((row) => row.parentId === id).map((row) => row.id),
		// Dragging sideways changes the depth: a step to the right nests, a step to the left returns to the top level.
		locate: (id, index, dx) => resolveTaskDrop(rows, id, index, (rows.find((row) => row.id === id)?.parentId ? 1 : 0) + Math.round(dx / SUBTASK_INDENT)),
		onDrop: (id, target) => { if (!isSameTaskSpot(rows, id, target) && !dropNeedsPendingTask(target)) actions.move(id, { parentId: target.parentId, previousId: target.previousId }); },
	});

	const keepFocus = useKeepFocus(listRef, "data-task-handle", rows);
	const moveByKey = useCallback((id: string, direction: TaskMoveDirection) => {
		const drop = keyboardTaskMove(rowsRef.current, id, direction);
		if (!drop || dropNeedsPendingTask(drop)) return;
		actions.move(id, drop);
		keepFocus(id);
		setKeyboardMove({ id, direction });
	}, [actions, keepFocus]);
	const reorder = useMemo<TaskRowReorder>(() => ({ startDrag, move: moveByKey }), [startDrag, moveByKey]);
	// The announcement is cleared so that the same move made twice is read out twice.
	useEffect(() => {
		if (!keyboardMove) return;
		const timer = window.setTimeout(() => setKeyboardMove(null), 1000);
		return () => window.clearTimeout(timer);
	}, [keyboardMove]);

	// A click outside the rows ends editing. Menus and dialogs opened from a row render elsewhere in the page.
	useEffect(() => {
		if (activeId === null) return;
		const onPointerDown = (event: PointerEvent) => {
			if (!(event.target instanceof Element) || event.target.closest("[data-task-row], [role='menu'], [role='dialog'], [role='listbox']")) return;
			setActiveId(null);
		};
		document.addEventListener("pointerdown", onPointerDown);
		return () => document.removeEventListener("pointerdown", onPointerDown);
	}, [activeId]);

	useEffect(() => {
		if (!listensForCreate) return;
		const focusAdd = () => { scrollRef.current?.scrollTo({ top: 0 }); addRef.current?.focus(); };
		window.addEventListener(TASKS_FOCUS_ADD_EVENT, focusAdd);
		return () => window.removeEventListener(TASKS_FOCUS_ADD_EVENT, focusAdd);
	}, [listensForCreate]);

	// A list that was just created opens with the cursor in the box, which is disabled until the list has loaded.
	useEffect(() => {
		if (isPending || scope.kind !== "list" || focusAddOnOpen !== scopeKey) return;
		focusAddOnOpen = null;
		addRef.current?.focus();
		// eslint-disable-next-line react-hooks/exhaustive-deps -- a scope is fully named by its kind and key
	}, [isPending, scope.kind, scopeKey]);

	const focusTarget = focusTaskId ? tasks.find((task) => task.id === focusTaskId) : undefined;
	const focusCompleted = focusTarget?.status === "completed";
	useEffect(() => {
		if (!focusTarget) return;
		// Next frame: a completed task first needs its section opened.
		const frame = requestAnimationFrame(() => {
			if (focusCompleted) setCompletedOpen(true);
			requestAnimationFrame(() => {
				const row = scrollRef.current?.querySelector<HTMLElement>(`[data-task-row="${CSS.escape(focusTarget.id)}"]`);
				row?.scrollIntoView({ block: "center" });
				row?.querySelector<HTMLElement>("[data-task-title]")?.focus({ preventScroll: true });
				onFocusHandled?.();
			});
		});
		return () => cancelAnimationFrame(frame);
		// eslint-disable-next-line react-hooks/exhaustive-deps -- runs once per requested task, when it has loaded
	}, [focusTarget?.id, focusCompleted]);

	function addTask(title: string) {
		if (scope.kind === "list") {
			actions.create({ title, listId: scope.listId });
			// "Add to tasks" on an email goes to the list the user last added to.
			rememberLastTaskList(scope.listId);
			return;
		}
		const date = defaultDueDateForScope(scope, today);
		actions.create({ title, listId: lists[0]?.id, starred: scope.view === "starred" || undefined, due: date ? { date, timeZone } : undefined });
	}

	const rowProps = { actions, lists, now, timeZone, onActiveChange: setActiveId };
	const gutter = variant === "panel" ? "px-1.5" : "px-2 md:px-3";
	const loading = isPending;
	const migrationRequired = data?.migrationRequired === true;
	const emptyKind = loading || isError || migrationRequired || openTasks.length > 0 ? null : scope.kind === "view" ? scope.view : completedTasks.length > 0 ? "done" : "list";

	return (
		<div className={cn("flex min-h-0 flex-1 flex-col", className)}>
			<div ref={scrollRef} className={cn("min-h-0 flex-1 overflow-y-auto overscroll-contain pb-8 pt-2", gutter)}>
				<div className={variant === "page" ? "max-w-3xl" : undefined}>
					{!migrationRequired && <TaskAddRow inputRef={addRef} aligned={isList} placeholder={t("tasks.action.add")} onAdd={addTask} disabled={loading || isError || lists.length === 0} />}
					{loading && (
						<div aria-hidden="true" className="space-y-1 pt-1">
							{Array.from({ length: 5 }, (_, index) => <div key={index} className="flex h-9 items-center gap-3 pl-8"><Skeleton className="h-[18px] w-[18px] shrink-0 rounded-full" /><Skeleton className="h-3.5" style={{ width: `${55 - index * 7}%` }} /></div>)}
						</div>
					)}
					{isError && (
						<div role="alert" className="flex flex-col items-start gap-3 px-3 py-6 text-sm text-neutral-600">
							<p>{taskErrorMessage(error, t, "tasks.error.loadFailed")}</p>
							<Button type="button" variant="outline" size="sm" onClick={() => void refetch()}>{t("tasks.app.retry")}</Button>
						</div>
					)}
					{migrationRequired && <p role="status" className="px-3 py-6 text-sm text-neutral-600">{t("tasks.error.migrationRequired")}</p>}
					{isList && tree.length > 0 && (
						<ul ref={listRef} aria-label={listTitles.get(scopeKey) ?? t("tasks.title")} onClickCapture={guardClick} className={dragId ? "select-none" : undefined}>
							{tree.map((task) => (
								<Fragment key={task.id}>
									<li><TaskRow task={task} active={activeId === task.id} reorder={reorder} dragging={dragId === task.id} subtaskCount={subtaskCounts.get(task.id) ?? 0} onAddSubtask={setSubtaskParent} {...rowProps} /></li>
									{task.subtasks.map((subtask) => <li key={subtask.id}><TaskRow task={subtask} depth={1} active={activeId === subtask.id} reorder={reorder} dragging={dragId === subtask.id || dragId === task.id} {...rowProps} /></li>)}
									{subtaskParent === task.id && <li><TaskAddRow indent aligned autoFocus placeholder={t("tasks.action.addSubtask")} onAdd={(title) => actions.create({ title, parentId: task.id })} onCancel={() => setSubtaskParent(null)} /></li>}
								</Fragment>
							))}
						</ul>
					)}
					{sections.map((section) => (
						<section key={section.key} aria-label={section.kind === "overdue" ? t("tasks.app.overdue") : section.date ? formatTaskDue({ dueDate: section.date, dueAt: null }, t, { now, timeZone }) ?? undefined : t("tasks.view.starred")}>
							{section.kind !== "all" && <h2 className={cn("px-3 pb-1 pt-4 text-xs font-semibold uppercase tracking-wide", section.kind === "overdue" ? "text-red-600" : "text-neutral-500")}>{section.kind === "overdue" ? t("tasks.app.overdue") : formatTaskDue({ dueDate: section.date, dueAt: null }, t, { now, timeZone })}</h2>}
							<ul>
								{section.tasks.map((task) => <li key={task.id}><TaskRow task={task} active={activeId === task.id} listTitle={listTitles.get(task.listId)} onOpenList={onOpenList} {...rowProps} /></li>)}
							</ul>
						</section>
					))}
					{emptyKind && (
						<div className="flex flex-col items-center px-6 py-12 text-center">
							<span className="mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-blue-50 text-blue-600"><CheckCircle2 size={28} aria-hidden="true" /></span>
							<p className="text-base font-medium text-neutral-800">{t(EMPTY_KEYS[emptyKind][0])}</p>
							<p className="mt-1 max-w-xs text-sm text-neutral-500">{t(EMPTY_KEYS[emptyKind][1])}</p>
						</div>
					)}
					{isList && completedTasks.length > 0 && (
						<section className="mt-3 border-t border-neutral-100 pt-2">
							<button type="button" onClick={() => setCompletedOpen((open) => !open)} aria-expanded={completedOpen} className="flex h-10 w-full items-center gap-2 rounded-2xl px-3 text-left text-sm font-medium text-neutral-700 transition-colors hover:bg-neutral-100/70 focus-visible:outline-2 focus-visible:outline-blue-600">
								<ChevronRight size={16} aria-hidden="true" className={cn("shrink-0 transition-transform rtl:rotate-180", completedOpen && "rotate-90 rtl:rotate-90")} />
								{t("tasks.app.completedCount", { count: completedTasks.length })}
							</button>
							{completedOpen && <ul>{completedTasks.map((task) => <li key={task.id}><CompletedTaskRow task={task} actions={actions} aligned subtaskCount={subtaskCounts.get(task.id) ?? 0} /></li>)}</ul>}
						</section>
					)}
					{data?.truncated && <p className="px-3 pt-4 text-xs text-neutral-500">{t("tasks.app.truncated")}</p>}
				</div>
			</div>
			<p role="status" aria-live="polite" className="sr-only">{keyboardMove ? t(MOVED_KEYS[keyboardMove.direction]) : ""}</p>
			{overlay}
		</div>
	);
}
