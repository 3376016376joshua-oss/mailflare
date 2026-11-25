import { isPendingId } from "@/lib/tasks/cache-utils";
import type { TaskNode } from "@/lib/tasks/task-utils";
import type { Task } from "@/lib/tasks/types";

/**
 * Where a task lands when it is dragged or moved with the keyboard: pure functions over the rows of one
 * list, so the rules (one level of nesting, a parent keeps its subtasks together, a repeating task or a
 * task with subtasks never nests) are tested in Node. The result is the body of `POST /api/tasks/:id/move`.
 */

/** One visible open task of a list, in display order: every top-level task followed by its subtasks. */
export type TaskOrderRow = {
	id: string;
	parentId: string | null;
	/** May become a subtask: it has no subtasks of its own, does not repeat and exists on the server. */
	canNest: boolean;
	/** May take subtasks: a top-level task that exists on the server. */
	canParent: boolean;
};

/** The move request: the parent to nest under (null = top level) and the sibling to follow (null = first). */
export type TaskDrop = { parentId: string | null; previousId: string | null };

/** A drop while dragging: where the line is drawn (`index` among the rows that stay put) and how deep. */
export type TaskDropTarget = TaskDrop & { index: number; depth: 0 | 1 };

export type TaskMoveDirection = "up" | "down" | "in" | "out";

/**
 * The rows of a list's open tasks, as `buildTaskTree` grouped them. `parentIds` names every task that
 * has a subtask of any status: one whose subtasks are all completed shows none here, yet still cannot nest.
 */
export function flattenTaskRows(tree: readonly TaskNode<Task>[], parentIds: ReadonlySet<string> = new Set()): TaskOrderRow[] {
	return tree.flatMap((task) => [
		{ id: task.id, parentId: null, canNest: task.subtasks.length === 0 && !parentIds.has(task.id) && task.repeat === null && !isPendingId(task.id), canParent: !isPendingId(task.id) },
		...task.subtasks.map((subtask) => ({ id: subtask.id, parentId: task.id, canNest: !isPendingId(subtask.id), canParent: false })),
	]);
}

/** The rows left in place while `dragId` is dragged: everything but the task and its subtasks. */
export function rowsWithoutDragged(rows: readonly TaskOrderRow[], dragId: string): TaskOrderRow[] {
	return rows.filter((row) => row.id !== dragId && row.parentId !== dragId);
}

function previousSiblingId(rows: readonly TaskOrderRow[], id: string): string | null {
	const row = rows.find((candidate) => candidate.id === id);
	if (!row) return null;
	const siblings = rows.filter((candidate) => candidate.parentId === row.parentId);
	return siblings[siblings.indexOf(row) - 1]?.id ?? null;
}

/** Whether a move names a task that exists only in the cache so far; the server could not place it yet. */
export function dropNeedsPendingTask(drop: TaskDrop): boolean {
	return (drop.parentId !== null && isPendingId(drop.parentId)) || (drop.previousId !== null && isPendingId(drop.previousId));
}

/** Whether `drop` is where the task already is, so no request is needed. */
export function isSameTaskSpot(rows: readonly TaskOrderRow[], id: string, drop: TaskDrop): boolean {
	const row = rows.find((candidate) => candidate.id === id);
	return !!row && row.parentId === drop.parentId && previousSiblingId(rows, id) === drop.previousId;
}

/**
 * The drop for a task dragged to sit before the row at `index` (among the rows that stay put; their
 * count means "at the end"), at the depth the pointer asks for (0 = top level, 1 = subtask).
 *
 * A gap between a parent and its subtasks, or between two subtasks, only takes a subtask. A task that
 * cannot nest there snaps to the nearer edge of that group instead of splitting it.
 */
export function resolveTaskDrop(rows: readonly TaskOrderRow[], dragId: string, index: number, wantDepth: number): TaskDropTarget | null {
	const dragged = rows.find((row) => row.id === dragId);
	if (!dragged) return null;
	const rest = rowsWithoutDragged(rows, dragId);
	let at = Math.max(0, Math.min(index, rest.length));
	const parentOf = (position: number): TaskOrderRow | null => {
		const above = rest[position - 1];
		if (!above) return null;
		return above.parentId === null ? above : rest.find((row) => row.id === above.parentId) ?? null;
	};
	const canNestAt = (position: number) => dragged.canNest && parentOf(position)?.canParent === true;
	let depth: 0 | 1;
	if (rest[at]?.parentId != null) {
		// Inside a group of subtasks.
		if (canNestAt(at)) depth = 1;
		else {
			const groupStart = rest.findIndex((row) => row.id === rest[at].parentId);
			let groupEnd = at;
			while (groupEnd < rest.length && rest[groupEnd].parentId !== null) groupEnd += 1;
			at = at - groupStart <= groupEnd - at ? groupStart : groupEnd;
			depth = 0;
		}
	} else depth = wantDepth >= 1 && canNestAt(at) ? 1 : 0;
	const above = rest[at - 1] ?? null;
	if (depth === 1) {
		const parent = parentOf(at)!;
		return { index: at, depth, parentId: parent.id, previousId: above!.id === parent.id ? null : above!.id };
	}
	return { index: at, depth, parentId: null, previousId: above ? above.parentId ?? above.id : null };
}

/**
 * The move one key press makes: up or down among its siblings, in under the task above it (as its last
 * subtask), or out to the top level right below its former parent. null when that move does not exist.
 */
export function keyboardTaskMove(rows: readonly TaskOrderRow[], id: string, direction: TaskMoveDirection): TaskDrop | null {
	const row = rows.find((candidate) => candidate.id === id);
	if (!row) return null;
	const siblings = rows.filter((candidate) => candidate.parentId === row.parentId);
	const position = siblings.indexOf(row);
	if (direction === "up") return position > 0 ? { parentId: row.parentId, previousId: siblings[position - 2]?.id ?? null } : null;
	if (direction === "down") return position < siblings.length - 1 ? { parentId: row.parentId, previousId: siblings[position + 1].id } : null;
	if (direction === "out") return row.parentId !== null ? { parentId: null, previousId: row.parentId } : null;
	const parent = siblings[position - 1];
	if (row.parentId !== null || !row.canNest || !parent?.canParent) return null;
	return { parentId: parent.id, previousId: rows.findLast((candidate) => candidate.parentId === parent.id)?.id ?? null };
}

/** The sibling a list follows after it is dropped before position `index` among the other lists (null = first). */
export function resolveListDrop(ids: readonly string[], dragId: string, index: number): { previousId: string | null; index: number } | null {
	if (!ids.includes(dragId)) return null;
	const rest = ids.filter((id) => id !== dragId);
	const at = Math.max(0, Math.min(index, rest.length));
	return { index: at, previousId: rest[at - 1] ?? null };
}

/** Whether a list dropped after `previousId` stays where it is. */
export function isSameListSpot(ids: readonly string[], dragId: string, previousId: string | null): boolean {
	return (ids[ids.indexOf(dragId) - 1] ?? null) === previousId;
}

/** The list a keyboard move places `id` after, one step up or down (null = first); undefined when it cannot move. */
export function keyboardListMove(ids: readonly string[], id: string, direction: "up" | "down"): string | null | undefined {
	const position = ids.indexOf(id);
	if (position < 0) return undefined;
	if (direction === "up") return position > 0 ? ids[position - 2] ?? null : undefined;
	return position < ids.length - 1 ? ids[position + 1] : undefined;
}
