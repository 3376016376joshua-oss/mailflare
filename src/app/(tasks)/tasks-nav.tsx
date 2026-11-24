"use client";

import { useId, useRef, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import clsx from "clsx";
import { CalendarClock, CalendarDays, ListChecks, Plus, Star } from "@/components/icons";
import { useLanguage } from "@/components/language-provider";
import { PoweredBy } from "@/components/sidebar-footer";
import { useSidebar } from "@/components/sidebar-state";
import { TaskListDialog } from "@/components/tasks/task-list-dialog";
import { focusTaskAddRow } from "@/components/tasks/task-list-view";
import { isSameListSpot, keyboardListMove, resolveListDrop } from "@/components/tasks/task-order-utils";
import { resolveTaskScope, taskScopeHref } from "@/components/tasks/task-view-utils";
import { useKeepFocus } from "@/components/tasks/use-keep-focus";
import { useSortDrag } from "@/components/tasks/use-sort-drag";
import { useTaskListActions } from "@/components/tasks/use-task-actions";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip } from "@/components/ui/tooltip";
import { isPendingId } from "@/lib/tasks/cache-utils";
import { useTaskLists } from "@/lib/tasks/client";
import { rememberLastTaskList } from "@/lib/tasks/last-list";
import type { TaskView } from "@/lib/tasks/types";

const VIEWS = [
	{ view: "starred", labelKey: "tasks.view.starred", icon: Star },
	{ view: "today", labelKey: "tasks.view.today", icon: CalendarDays },
	{ view: "upcoming", labelKey: "tasks.view.upcoming", icon: CalendarClock },
] as const satisfies readonly { view: TaskView; labelKey: string; icon: unknown }[];

type ListDropTarget = { index: number; depth: number; previousId: string | null };

/** The Tasks menu: Create, the smart views, then the user's lists (drag or Alt+Arrow to reorder) and New list. */
export function TasksNav({ onNavigate }: { onNavigate?: () => void }) {
	const { t } = useLanguage();
	const { minimal, mobile } = useSidebar();
	const router = useRouter();
	const params = useSearchParams();
	const hintId = useId();
	const { data, isPending } = useTaskLists();
	const listActions = useTaskListActions();
	const [creating, setCreating] = useState(false);
	const listRef = useRef<HTMLUListElement | null>(null);
	const lists = data?.lists ?? [];
	const ids = lists.map((list) => list.id);
	const scope = resolveTaskScope({ view: params.get("view"), list: params.get("list") }, ids);
	const compact = minimal && !mobile;
	const keepFocus = useKeepFocus(listRef, "data-sort-id", ids.join("\n"));

	const { dragId, startDrag, guardClick, overlay } = useSortDrag<ListDropTarget>({
		containerRef: listRef,
		holdOnTouch: true,
		locate: (id, index) => {
			const drop = resolveListDrop(ids, id, index);
			return drop && { ...drop, depth: 0 };
		},
		onDrop: (id, target) => { if (!isSameListSpot(ids, id, target.previousId) && !(target.previousId !== null && isPendingId(target.previousId))) listActions.reorder(id, target.previousId); },
	});

	function moveList(id: string, direction: "up" | "down") {
		const previousId = keyboardListMove(ids, id, direction);
		if (previousId === undefined || (previousId !== null && isPendingId(previousId))) return;
		listActions.reorder(id, previousId);
		keepFocus(id);
	}

	const rowClass = (active: boolean) => clsx("flex h-10 items-center gap-3 rounded-full text-sm max-md:h-11 max-md:text-base", compact ? "w-10 justify-center" : "px-4", active ? "bg-blue-100 font-medium text-blue-900" : "text-neutral-700 hover:bg-neutral-200/60");
	const withTooltip = (label: string, node: React.ReactElement) => (compact ? <Tooltip label={label} placement="right">{node}</Tooltip> : node);

	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<div className="min-h-0 flex-1 overflow-y-auto px-3 pt-1">
				{withTooltip(t("tasks.app.create"), (
					<button type="button" onClick={() => { onNavigate?.(); focusTaskAddRow(); }} aria-label={compact ? t("tasks.app.create") : undefined} className={clsx("mb-4 flex h-14 items-center gap-3 rounded-2xl bg-white text-sm font-medium text-neutral-800 shadow-md transition-shadow hover:shadow-lg", compact ? "w-14 justify-center" : "w-fit px-5")}>
						<Plus size={22} aria-hidden="true" />{!compact && t("tasks.app.create")}
					</button>
				))}
				<nav aria-label={t("tasks.app.views")} className="space-y-0.5">
					{VIEWS.map(({ view, labelKey, icon: Icon }) => {
						const active = scope?.kind === "view" && scope.view === view;
						return (
							<div key={view}>
								{withTooltip(t(labelKey), (
									<Link href={taskScopeHref({ kind: "view", view })} onClick={onNavigate} aria-current={active ? "page" : undefined} aria-label={compact ? t(labelKey) : undefined} className={rowClass(active)}>
										<Icon size={16} aria-hidden="true" className="shrink-0 max-md:h-5 max-md:w-5" />{!compact && t(labelKey)}
									</Link>
								))}
							</div>
						);
					})}
				</nav>
				<nav aria-label={t("tasks.app.lists")} className="mt-3">
					{!compact && <p className="flex h-9 items-center px-4 text-xs font-semibold uppercase tracking-wide text-neutral-500 max-md:text-sm">{t("tasks.app.lists")}</p>}
					{isPending && !compact && <div aria-hidden="true" className="space-y-2 px-4 py-2"><Skeleton className="h-4 w-32" /><Skeleton className="h-4 w-24" /></div>}
					<ul ref={listRef} onClickCapture={guardClick} className={clsx("space-y-0.5", dragId && "select-none")}>
						{lists.map((list) => {
							const active = scope?.kind === "list" && scope.listId === list.id;
							const pending = isPendingId(list.id);
							const content = <><ListChecks size={16} aria-hidden="true" className="shrink-0 max-md:h-5 max-md:w-5" />{!compact && <><span className="min-w-0 flex-1 truncate">{list.title}</span>{list.openCount > 0 && <span className="shrink-0 text-xs tabular-nums text-neutral-500">{list.openCount > 999 ? "999+" : list.openCount}</span>}</>}</>;
							return (
								<li key={list.id} className={clsx(dragId === list.id && "opacity-40")}>
									{withTooltip(list.title, pending ? <span className={clsx(rowClass(false), "opacity-60")}>{content}</span> : (
										<Link
											href={taskScopeHref({ kind: "list", listId: list.id })}
											data-sort-id={list.id}
											draggable={false}
											onClick={() => { rememberLastTaskList(list.id); onNavigate?.(); }}
											onPointerDown={(event) => startDrag(event, list.id, list.title)}
											onDragStart={(event) => event.preventDefault()}
											onKeyDown={(event) => {
												if (!event.altKey || (event.key !== "ArrowUp" && event.key !== "ArrowDown")) return;
												event.preventDefault();
												moveList(list.id, event.key === "ArrowUp" ? "up" : "down");
											}}
											aria-current={active ? "page" : undefined}
											aria-label={compact ? list.title : undefined}
											aria-describedby={hintId}
											aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown"
											className={rowClass(active)}
										>
											{content}
										</Link>
									))}
								</li>
							);
						})}
					</ul>
					{withTooltip(t("tasks.app.newList"), (
						<button type="button" onClick={() => { onNavigate?.(); setCreating(true); }} aria-label={compact ? t("tasks.app.newList") : undefined} className={clsx(rowClass(false), "mt-0.5", !compact && "w-full text-left")}>
							<Plus size={16} aria-hidden="true" className="shrink-0 max-md:h-5 max-md:w-5" />{!compact && t("tasks.app.newList")}
						</button>
					))}
					<p id={hintId} className="sr-only">{t("tasks.app.listReorderHint")}</p>
				</nav>
			</div>
			{!compact && <div className="shrink-0 border-t border-neutral-200/70 px-4 py-3"><PoweredBy className="" /></div>}
			{creating && <TaskListDialog onClose={() => setCreating(false)} onSubmit={(title) => listActions.create(title, (list) => { rememberLastTaskList(list.id); router.push(taskScopeHref({ kind: "list", listId: list.id })); onNavigate?.(); })} />}
			{overlay}
		</div>
	);
}
