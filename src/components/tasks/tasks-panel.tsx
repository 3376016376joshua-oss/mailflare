"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import toast from "react-hot-toast";
import { CalendarClock, CalendarDays, Check, CheckCircle2, ChevronDown, ExternalLink, Plus, Star, X } from "@/components/icons";
import { useLanguage } from "@/components/language-provider";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { isPendingId } from "@/lib/tasks/cache-utils";
import { onTasksOpenPanel, useTask, useTaskLists } from "@/lib/tasks/client";
import { formatTaskDay, taskErrorMessage } from "@/lib/tasks/format";
import { getLastTaskListId, rememberLastTaskList } from "@/lib/tasks/last-list";
import { isDateString } from "@/lib/tasks/task-utils";
import type { TaskView } from "@/lib/tasks/types";
import { cn } from "@/lib/utils";
import { taskIconButtonClass, taskMenuClass, taskMenuItemClass } from "./task-controls";
import { TaskListDialog } from "./task-list-dialog";
import { TaskListView, focusTaskAddRowOnOpen } from "./task-list-view";
import { taskScopeHref, taskScopeKey } from "./task-view-utils";
import type { TaskScope } from "./task-view-utils";
import { useTaskListActions } from "./use-task-actions";

const VIEWS = [
	{ view: "starred", labelKey: "tasks.view.starred", icon: Star },
	{ view: "today", labelKey: "tasks.view.today", icon: CalendarDays },
	{ view: "upcoming", labelKey: "tasks.view.upcoming", icon: CalendarClock },
] as const satisfies readonly { view: TaskView; labelKey: string; icon: unknown }[];

/**
 * Shown in the header of Mail and Calendar, next to the Assistant's button: opens and closes the Tasks panel.
 * Not below 640px: a phone's header has no room for another control (with the Upgrade pill and the
 * Assistant button it is already full at 390px). There the Tasks app is one tap away in the apps menu,
 * and the panel still opens when something asks for it (`openTasksPanel`), covering the page like the Assistant.
 */
export function TasksPanelToggle({ open, onToggle }: { open: boolean; onToggle: () => void }) {
	const { t } = useLanguage();
	return (
		<Button type="button" variant="ghost" size="sm" className={cn("max-sm:hidden", open ? "bg-blue-50 text-blue-700" : "text-neutral-600")} onClick={onToggle} aria-label={open ? t("tasks.panel.close") : t("tasks.panel.open")} title={open ? t("tasks.panel.close") : t("tasks.panel.open")} aria-expanded={open} aria-controls="tasks-side-panel">
			<CheckCircle2 className="h-5 w-5" />
		</Button>
	);
}

/**
 * The Tasks side panel of Mail and Calendar: a switcher (the lists, then Starred, Today and Upcoming)
 * over the same task list as the Tasks app. It lives in the right-hand dock that also hosts the
 * Assistant, one at a time, and starts on the list the user last worked in.
 *
 * Mount it always: closed it renders nothing, but it still listens for `mailflare:tasks-open-panel`
 * (`openTasksPanel({ taskId?, listId?, view?, date? })`), which opens it on that list, view or day, or
 * on the list of that task with the cursor in it.
 */
export function TasksPanel({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
	const { t } = useLanguage();
	const [listId, setListId] = useState<string | null>(() => getLastTaskListId() ?? null);
	// A smart view or a day, shown instead of the list until the user picks a list again.
	const [across, setAcross] = useState<Exclude<TaskScope, { kind: "list" }> | null>(null);
	const [focusId, setFocusId] = useState<string | null>(null);
	const [creating, setCreating] = useState(false);
	const { data, isPending, isError, error, refetch } = useTaskLists({ enabled: open });
	const focusTask = useTask(open ? focusId : null);
	// A task that is gone (deleted since the link was made) cannot be shown: say so and stay on the current list.
	const focusMissing = !!focusId && focusTask.isError;
	useEffect(() => {
		if (focusMissing) toast.error(t("tasks.error.notFound"));
		// eslint-disable-next-line react-hooks/exhaustive-deps -- once per missing task, not per language change
	}, [focusMissing, focusId]);
	const listActions = useTaskListActions();
	const lists = data?.lists ?? [];
	// A task asked for by id brings its own list with it.
	const wantedListId = (focusId && focusTask.data?.listId) || listId;
	const list = lists.find((candidate) => candidate.id === wantedListId) ?? lists[0] ?? null;
	const scope: TaskScope | null = across && (!focusId || focusMissing) ? across : list ? { kind: "list", listId: list.id } : null;
	const title = scope?.kind === "view" ? t(VIEWS.find((item) => item.view === scope.view)!.labelKey) : scope?.kind === "date" ? formatTaskDay(scope.date) : list?.title ?? t("tasks.title");

	function selectList(id: string) {
		setListId(id);
		setAcross(null);
		setFocusId(null);
		rememberLastTaskList(id);
	}

	useEffect(() => onTasksOpenPanel((detail) => {
		if (detail.taskId) {
			setFocusId(detail.taskId);
			setAcross(null);
		} else if (detail.listId) {
			setListId(detail.listId);
			setAcross(null);
			setFocusId(null);
			rememberLastTaskList(detail.listId);
		} else if (detail.view) {
			setAcross({ kind: "view", view: detail.view });
			setFocusId(null);
		} else if (isDateString(detail.date)) {
			setAcross({ kind: "date", date: detail.date });
			setFocusId(null);
		}
		onOpenChange(true);
	}), [onOpenChange]);

	if (!open) return null;

	return (
		<section id="tasks-side-panel" aria-label={t("tasks.title")} className="flex h-full w-full min-w-0 flex-col overflow-hidden rounded-3xl border border-neutral-200/70 bg-white text-neutral-900 shadow-xl shadow-neutral-300/30 max-md:rounded-b-none max-md:border-0 max-md:shadow-none">
			<header className="flex h-14 shrink-0 items-center justify-between gap-2 border-b border-neutral-100 pl-4 pr-2">
				<div className="flex min-w-0 items-center gap-1.5">
					<CheckCircle2 className="h-5 w-5 shrink-0 fill-blue-400/20 text-blue-600/70" aria-hidden="true" />
					{scope ? (
						<DropdownMenu.Root>
							<DropdownMenu.Trigger asChild>
								<button type="button" aria-label={t("tasks.panel.switchList", { title })} className="flex h-9 min-w-0 items-center gap-1 rounded-full px-2 text-sm font-semibold text-neutral-900 hover:bg-neutral-100 focus-visible:outline-2 focus-visible:outline-blue-600 data-[state=open]:bg-neutral-100">
									<span className="truncate">{title}</span>
									<ChevronDown size={16} aria-hidden="true" className="shrink-0 text-neutral-500" />
								</button>
							</DropdownMenu.Trigger>
							<DropdownMenu.Portal>
								<DropdownMenu.Content align="start" sideOffset={4} collisionPadding={8} className={cn(taskMenuClass, "max-h-[min(28rem,var(--radix-dropdown-menu-content-available-height))] w-64 overflow-y-auto")}>
									{lists.map((candidate) => (
										<DropdownMenu.Item key={candidate.id} disabled={isPendingId(candidate.id)} className={taskMenuItemClass} onSelect={() => selectList(candidate.id)}>
											<span className="flex h-4 w-4 shrink-0 items-center justify-center text-blue-600">{scope.kind === "list" && candidate.id === scope.listId && <Check size={16} aria-hidden="true" />}</span>
											<span className="min-w-0 flex-1 truncate">{candidate.title}</span>
											{candidate.openCount > 0 && <span className="shrink-0 text-xs tabular-nums text-neutral-500">{candidate.openCount}</span>}
										</DropdownMenu.Item>
									))}
									<DropdownMenu.Separator className="my-1 h-px bg-neutral-100" />
									{VIEWS.map(({ view: item, labelKey, icon: Icon }) => (
										<DropdownMenu.Item key={item} className={cn(taskMenuItemClass, scope.kind === "view" && scope.view === item && "font-medium text-blue-700")} onSelect={() => { setAcross({ kind: "view", view: item }); setFocusId(null); }}>
											<Icon size={16} aria-hidden="true" className="shrink-0" />{t(labelKey)}
										</DropdownMenu.Item>
									))}
									<DropdownMenu.Separator className="my-1 h-px bg-neutral-100" />
									<DropdownMenu.Item className={taskMenuItemClass} onSelect={() => setCreating(true)}><Plus size={16} aria-hidden="true" className="shrink-0" />{t("tasks.app.newList")}</DropdownMenu.Item>
								</DropdownMenu.Content>
							</DropdownMenu.Portal>
						</DropdownMenu.Root>
					) : <strong className="truncate px-2 text-sm font-semibold">{t("tasks.title")}</strong>}
				</div>
				<div className="flex shrink-0 items-center gap-0.5">
					<Link href={taskScopeHref(scope)} aria-label={t("tasks.panel.openApp")} title={t("tasks.panel.openApp")} className={cn(taskIconButtonClass, "h-9 w-9 text-neutral-600")}><ExternalLink size={18} aria-hidden="true" /></Link>
					<button type="button" onClick={() => onOpenChange(false)} aria-label={t("tasks.panel.close")} className={cn(taskIconButtonClass, "h-9 w-9 text-neutral-600")}><X size={18} aria-hidden="true" /></button>
				</div>
			</header>
			{scope ? (
				<TaskListView
					key={taskScopeKey(scope)}
					scope={scope}
					lists={lists}
					variant="panel"
					focusTaskId={focusMissing ? null : focusId}
					onFocusHandled={() => { if (focusTask.data) selectList(focusTask.data.listId); else setFocusId(null); }}
					onOpenList={selectList}
					onOpenTask={(taskId) => { setFocusId(taskId); setAcross(null); }}
				/>
			) : isPending ? (
				<div aria-hidden="true" className="space-y-3 p-5">{Array.from({ length: 4 }, (_, index) => <Skeleton key={index} className="h-4" style={{ width: `${80 - index * 12}%` }} />)}</div>
			) : (
				<div role={isError ? "alert" : "status"} className="flex flex-col items-start gap-3 p-5 text-sm text-neutral-600">
					<p>{isError ? taskErrorMessage(error, t, "tasks.error.loadFailed") : t("tasks.error.migrationRequired")}</p>
					{isError && <Button type="button" variant="outline" size="sm" onClick={() => void refetch()}>{t("tasks.app.retry")}</Button>}
				</div>
			)}
			{creating && <TaskListDialog onClose={() => setCreating(false)} onSubmit={(name) => listActions.create(name, (created) => { focusTaskAddRowOnOpen(created.id); selectList(created.id); })} />}
		</section>
	);
}
