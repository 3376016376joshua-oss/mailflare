import { compareRanks, dateInZone, rankBetween, sortTasksForQuery, taskMatchesQuery, zonedInstant } from "./task-utils";
import type { CreateTaskInput, MoveTaskInput, Task, TaskList, TaskQuery, TasksResponse, UpdateTaskInput } from "./types";

/**
 * Optimistic updates for cached task responses: what a mutation will most likely do, applied to the data
 * already on screen while the request is in flight. Pure functions, so they are tested in Node; the
 * hooks in client.ts apply them to every cached query and roll back when the request fails.
 *
 * The server stays the authority: every mutation ends with a refetch, which is where the things only it
 * knows arrive (the next occurrence of a repeating task, an email link, a rank it adjusted).
 */

/** Ids of tasks created optimistically, until the server answers with the real one. */
export const PENDING_TASK_PREFIX = "tmp_";

/** A task (or list) that exists only in the cache so far: it cannot be edited, moved or deleted yet. */
export function isPendingId(id: string): boolean {
	return id.startsWith(PENDING_TASK_PREFIX);
}

export type ViewerClock = { now: Date; timeZone: string };

/**
 * Applies `change` to the tasks of one cached response, then re-applies the query's filter and order.
 * Projected occurrences of the tasks in `stale` are dropped: their dates are the server's to work out.
 */
function reshape(data: TasksResponse, query: TaskQuery, clock: ViewerClock, change: (tasks: Task[]) => Task[], stale: ReadonlySet<string> = new Set()): TasksResponse {
	const today = dateInZone(clock.now, clock.timeZone);
	const tasks = change(data.tasks).filter((task) => taskMatchesQuery(task, query, today, clock.timeZone));
	return {
		...data,
		tasks: sortTasksForQuery(tasks, query, clock.timeZone),
		occurrences: stale.size ? data.occurrences.filter((occurrence) => !stale.has(occurrence.taskId)) : data.occurrences,
	};
}

/** The task as `PATCH /api/tasks/:id` would most likely return it. */
export function applyTaskUpdate(task: Task, input: UpdateTaskInput, clock: ViewerClock): Task {
	const next: Task = { ...task, updatedAt: clock.now.toISOString() };
	if (input.title !== undefined) next.title = input.title.trim();
	if (input.notes !== undefined) next.notes = input.notes;
	if (input.starred !== undefined && input.starred !== task.starred) {
		next.starred = input.starred;
		next.starredAt = input.starred ? clock.now.toISOString() : null;
	}
	if (input.due === null) Object.assign(next, { dueDate: null, dueAt: null, timeZone: null, repeat: null });
	if (input.due) {
		const timeZone = input.due.timeZone ?? task.timeZone ?? clock.timeZone;
		Object.assign(next, { dueDate: input.due.date, dueAt: input.due.time ? zonedInstant(input.due.date, input.due.time, timeZone).toISOString() : null, timeZone });
	}
	if (input.repeat === null) next.repeat = null;
	if (input.repeat && next.dueDate) next.repeat = { freq: input.repeat.freq, interval: input.repeat.interval ?? 1, until: input.repeat.until ?? null, count: input.repeat.count ?? null, index: 0 };
	if (input.completed === true && task.status !== "completed") Object.assign(next, { status: "completed", completedAt: clock.now.toISOString() });
	if (input.completed === false && task.status === "completed") Object.assign(next, { status: "needs-action", completedAt: null });
	return next;
}

/**
 * One cached response with `task` in its new state: added where it now belongs, replaced where it was,
 * and dropped where it no longer matches the query (a completed task leaves Today).
 * - `replaceId`: the temporary id this task replaces once the server created it.
 * - `completeSubtasks`: the task was just completed, which completes its open subtasks.
 * - `resetOccurrences`: its date, repeat rule or status changed, so its projected occurrences are stale.
 */
export function upsertTaskInResponse(
	data: TasksResponse,
	query: TaskQuery,
	task: Task,
	clock: ViewerClock,
	options: { replaceId?: string; completeSubtasks?: boolean; resetOccurrences?: boolean } = {},
): TasksResponse {
	const replaced = new Set([task.id, options.replaceId ?? task.id]);
	return reshape(data, query, clock, (tasks) => [
		...tasks
			.filter((candidate) => !replaced.has(candidate.id))
			.map((candidate) => {
				if (candidate.parentId !== task.id) return candidate;
				// Subtasks follow their parent: into its list, and into completion.
				const followed = candidate.listId === task.listId ? candidate : { ...candidate, listId: task.listId };
				return options.completeSubtasks && followed.status !== "completed" ? applyTaskUpdate(followed, { completed: true }, clock) : followed;
			}),
		task,
	], options.resetOccurrences ? new Set([task.id]) : undefined);
}

/** One cached response with tasks removed, along with their subtasks and projected occurrences. */
export function removeTasksFromResponse(data: TasksResponse, query: TaskQuery, ids: ReadonlySet<string>, clock: ViewerClock): TasksResponse {
	return reshape(data, query, clock, (tasks) => tasks.filter((task) => !ids.has(task.id) && !(task.parentId !== null && ids.has(task.parentId))), ids);
}

/**
 * The rank a task gets among its siblings in `tasks`: after `previousId`, first when that is null, and
 * `fallback` when it is not given. null when the cache does not hold the sibling it should follow, in
 * which case the server's answer places the task.
 */
export function siblingRankFromCache(tasks: readonly Task[], scope: { listId: string; parentId: string | null; excludeId?: string }, previousId: string | null | undefined, fallback: "first" | "last"): string | null {
	const siblings = tasks
		.filter((task) => task.listId === scope.listId && task.parentId === scope.parentId && task.id !== scope.excludeId)
		.sort((a, b) => compareRanks(a.position, b.position));
	if (previousId === undefined && fallback === "last") return rankBetween(siblings.at(-1)?.position ?? null, null);
	if (previousId == null) return rankBetween(null, siblings[0]?.position ?? null);
	const index = siblings.findIndex((task) => task.id === previousId);
	if (index < 0) return null;
	const next = siblings.slice(index + 1).find((task) => task.position > siblings[index].position);
	return rankBetween(siblings[index].position, next?.position ?? null);
}

/** The task `POST /api/tasks` will most likely create, under a temporary id. null without a title or a list to put it in. */
export function optimisticTask(input: CreateTaskInput, context: { id: string; listId: string | undefined; siblings: readonly Task[]; clock: ViewerClock }): Task | null {
	const parent = input.parentId ? context.siblings.find((task) => task.id === input.parentId) : undefined;
	const listId = parent?.listId ?? input.listId ?? context.listId;
	const title = input.title?.trim();
	if (!listId || !title || (input.parentId && !parent)) return null;
	const parentId = input.parentId ?? null;
	const position = siblingRankFromCache(context.siblings, { listId, parentId }, input.previousId, parentId ? "last" : "first");
	if (position === null) return null;
	const now = context.clock.now.toISOString();
	const blank: Task = {
		id: context.id, listId, parentId, title: "", notes: "", status: "needs-action", completedAt: null, dueDate: null, dueAt: null, timeZone: null,
		starred: false, starredAt: null, position, message: null, repeat: null, seriesId: null, createdAt: now, updatedAt: now,
	};
	return applyTaskUpdate(blank, { title, notes: input.notes, due: input.due ?? undefined, repeat: input.repeat ?? undefined, starred: input.starred }, context.clock);
}

/** The task as `POST /api/tasks/:id/move` would most likely return it; `siblings` are the cached tasks of the target list. */
export function applyTaskMove(task: Task, input: MoveTaskInput, siblings: readonly Task[]): Task {
	const changingList = input.listId !== undefined && input.listId !== task.listId;
	const parentId = input.parentId !== undefined ? input.parentId : changingList ? null : task.parentId;
	const parent = parentId ? siblings.find((candidate) => candidate.id === parentId) : undefined;
	const listId = parent?.listId ?? input.listId ?? task.listId;
	const position = siblingRankFromCache(siblings, { listId, parentId, excludeId: task.id }, input.previousId ?? null, "first");
	return { ...task, listId, parentId, position: position ?? task.position };
}

const counted = (task: Task | null | undefined): task is Task => !!task && task.status !== "completed" && task.parentId === null;

/** Lists with `openCount` adjusted for one task changing from `before` to `after` (either may be absent). */
export function adjustOpenCounts(lists: readonly TaskList[], before: Task | null | undefined, after: Task | null | undefined): TaskList[] {
	const delta = new Map<string, number>();
	if (counted(before)) delta.set(before.listId, (delta.get(before.listId) ?? 0) - 1);
	if (counted(after)) delta.set(after.listId, (delta.get(after.listId) ?? 0) + 1);
	return lists.map((list) => (delta.get(list.id) ? { ...list, openCount: Math.max(0, list.openCount + (delta.get(list.id) ?? 0)) } : list));
}

/** Lists in order after one of them is renamed and/or moved to follow `previousId` (null = first). */
export function applyListUpdate(lists: readonly TaskList[], id: string, input: { title?: string; previousId?: string | null }): TaskList[] {
	const others = lists.filter((list) => list.id !== id).sort((a, b) => compareRanks(a.position, b.position));
	const list = lists.find((candidate) => candidate.id === id);
	if (!list) return [...lists];
	let position = list.position;
	if (input.previousId !== undefined) {
		const index = input.previousId === null ? -1 : others.findIndex((candidate) => candidate.id === input.previousId);
		if (input.previousId === null || index >= 0) position = rankBetween(others[index]?.position ?? null, others[index + 1]?.position ?? null);
	}
	return [...others, { ...list, title: input.title?.trim() || list.title, position }].sort((a, b) => compareRanks(a.position, b.position));
}
