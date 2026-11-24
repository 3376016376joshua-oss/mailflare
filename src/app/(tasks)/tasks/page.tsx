"use client";

import { Suspense, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import toast, { Toaster } from "react-hot-toast";
import { ListChecks, MoreVertical, Pencil, Trash2 } from "@/components/icons";
import { useLanguage } from "@/components/language-provider";
import { taskIconButtonClass, taskMenuClass, taskMenuItemClass } from "@/components/tasks/task-controls";
import { TaskListDialog } from "@/components/tasks/task-list-dialog";
import { TaskListView } from "@/components/tasks/task-list-view";
import { resolveTaskScope, taskScopeHref, taskScopeKey } from "@/components/tasks/task-view-utils";
import { useTaskListActions } from "@/components/tasks/use-task-actions";
import { Button } from "@/components/ui/button";
import { confirmDestructive } from "@/components/ui/confirm-dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { isPendingId } from "@/lib/tasks/cache-utils";
import { useTask, useTaskLists } from "@/lib/tasks/client";
import { formatTaskDay, taskErrorMessage } from "@/lib/tasks/format";
import type { TaskList } from "@/lib/tasks/types";
import { cn } from "@/lib/utils";

const VIEW_TITLES = { starred: "tasks.view.starred", today: "tasks.view.today", upcoming: "tasks.view.upcoming" } as const;

/** Rename, delete completed tasks, delete: the menu beside a list's title. */
function ListMenu({ list, onlyList, onDeleted }: { list: TaskList; onlyList: boolean; onDeleted: () => void }) {
	const { t } = useLanguage();
	const listActions = useTaskListActions();
	const [renaming, setRenaming] = useState(false);

	async function clearCompleted() {
		if (await confirmDestructive({ title: t("tasks.app.clearCompleted"), message: t("tasks.app.clearCompletedConfirm", { title: list.title }), confirmLabel: t("common.delete") })) listActions.clearCompleted(list.id);
	}

	async function remove() {
		if (await confirmDestructive({ title: t("tasks.app.deleteList"), message: t("tasks.app.deleteListConfirm", { title: list.title }), confirmLabel: t("common.delete") })) listActions.remove(list.id, onDeleted);
	}

	return (
		<>
			<DropdownMenu.Root>
				<DropdownMenu.Trigger asChild>
					<button type="button" aria-label={t("tasks.app.listMenu", { title: list.title })} title={t("tasks.app.listOptions")} className={cn(taskIconButtonClass, "h-10 w-10 text-neutral-600")}><MoreVertical size={20} aria-hidden="true" /></button>
				</DropdownMenu.Trigger>
				<DropdownMenu.Portal>
					<DropdownMenu.Content align="end" sideOffset={4} collisionPadding={8} className={cn(taskMenuClass, "w-64")}>
						<DropdownMenu.Item className={taskMenuItemClass} onSelect={() => setRenaming(true)}><Pencil size={16} aria-hidden="true" />{t("tasks.app.renameList")}</DropdownMenu.Item>
						<DropdownMenu.Item className={taskMenuItemClass} onSelect={() => void clearCompleted()}><ListChecks size={16} aria-hidden="true" />{t("tasks.app.clearCompleted")}</DropdownMenu.Item>
						<DropdownMenu.Separator className="my-1 h-px bg-neutral-100" />
						<DropdownMenu.Item disabled={onlyList} className={cn(taskMenuItemClass, "items-start text-red-600")} onSelect={() => void remove()}>
							<Trash2 size={16} aria-hidden="true" className="mt-0.5 shrink-0" />
							<span className="min-w-0">{t("tasks.app.deleteList")}{onlyList && <span className="block text-xs text-neutral-600">{t("tasks.error.lastList")}</span>}</span>
						</DropdownMenu.Item>
					</DropdownMenu.Content>
				</DropdownMenu.Portal>
			</DropdownMenu.Root>
			{renaming && <TaskListDialog initialTitle={list.title} onClose={() => setRenaming(false)} onSubmit={(title) => listActions.rename(list.id, title)} />}
		</>
	);
}

function TasksScreen() {
	const { t } = useLanguage();
	const router = useRouter();
	const params = useSearchParams();
	const { data, isPending, isError, error, refetch } = useTaskLists();
	const lists = data?.lists ?? [];
	const scope = resolveTaskScope({ view: params.get("view"), date: params.get("date"), list: params.get("list") }, lists.map((list) => list.id));
	const list = scope?.kind === "list" ? lists.find((candidate) => candidate.id === scope.listId) ?? null : null;
	const title = scope?.kind === "view" ? t(VIEW_TITLES[scope.view]) : scope?.kind === "date" ? formatTaskDay(scope.date) : list?.title;

	// `/tasks?task=<id>` (a reminder, a link from the calendar) opens the list that holds the task and puts the cursor in it.
	const taskId = params.get("task");
	const target = useTask(taskId);
	const targetListId = taskId ? target.data?.listId ?? null : null;
	const targetMissing = !!taskId && target.isError;
	const onTargetList = scope?.kind === "list" && scope.listId === targetListId;
	const scopeHref = taskScopeHref(scope);
	useEffect(() => {
		if (targetMissing) {
			toast.error(t("tasks.error.notFound"));
			router.replace(scopeHref);
		} else if (targetListId && lists.length > 0 && !onTargetList) router.replace(taskScopeHref({ kind: "list", listId: targetListId }, taskId));
		// eslint-disable-next-line react-hooks/exhaustive-deps -- reacts to the requested task resolving, not to every render's helpers
	}, [targetMissing, targetListId, onTargetList, lists.length > 0, taskId]);

	return (
		<div className="flex h-full min-h-0 flex-col rounded-t-3xl bg-white">
			<Toaster position="bottom-left" containerClassName="text-sm" />
			<div className="flex min-h-[4.25rem] shrink-0 items-center justify-between gap-3 border-b border-neutral-200 py-3 pl-5 pr-3">
				{title !== undefined ? <h1 className="min-w-0 truncate text-xl font-normal text-neutral-800 max-md:text-lg">{title}</h1> : isPending ? <Skeleton className="h-7 w-40" /> : <h1 className="text-xl font-normal text-neutral-800 max-md:text-lg">{t("tasks.title")}</h1>}
				{list && !isPendingId(list.id) && <ListMenu list={list} onlyList={lists.length <= 1} onDeleted={() => router.replace("/tasks")} />}
			</div>
			{scope ? (
				<TaskListView
					key={taskScopeKey(scope)}
					scope={scope}
					lists={lists}
					listensForCreate
					onOpenTask={(id) => router.push(taskScopeHref(null, id))}
					focusTaskId={onTargetList ? taskId : null}
					onFocusHandled={() => router.replace(scopeHref)}
				/>
			) : isPending ? (
				<div aria-hidden="true" className="space-y-1 px-3 pt-3">
					{Array.from({ length: 6 }, (_, index) => <div key={index} className="flex h-9 items-center gap-3 pl-8"><Skeleton className="h-[18px] w-[18px] shrink-0 rounded-full" /><Skeleton className="h-3.5" style={{ width: `${40 - index * 4}%` }} /></div>)}
				</div>
			) : (
				<div role={isError ? "alert" : "status"} className="flex flex-col items-start gap-3 px-5 py-8 text-sm text-neutral-600">
					<p>{isError ? taskErrorMessage(error, t, "tasks.error.loadFailed") : t("tasks.error.migrationRequired")}</p>
					{isError && <Button type="button" variant="outline" size="sm" onClick={() => void refetch()}>{t("tasks.app.retry")}</Button>}
				</div>
			)}
		</div>
	);
}

export default function TasksPage() {
	return <Suspense fallback={null}><TasksScreen /></Suspense>;
}
