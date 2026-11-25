"use client";

import { useMemo } from "react";
import toast from "react-hot-toast";
import { useLanguage } from "@/components/language-provider";
import { useClearCompletedTasks, useCreateTask, useCreateTaskList, useDeleteTask, useDeleteTaskList, useMoveTask, useUpdateTask, useUpdateTaskList } from "@/lib/tasks/client";
import { taskErrorMessage } from "@/lib/tasks/format";
import type { CreateTaskInput, MoveTaskInput, Task, TaskList, UpdateTaskInput } from "@/lib/tasks/types";

export type TaskActions = {
	create: (input: CreateTaskInput, onCreated?: (task: Task) => void) => void;
	update: (id: string, input: UpdateTaskInput) => void;
	move: (id: string, input: MoveTaskInput) => void;
	remove: (id: string) => void;
};

/**
 * The task mutations of one screen, each already wired to an error toast (the hooks roll the optimistic
 * change back themselves). One instance serves every row of a list, so rows hold no mutation state.
 *
 * Each call is followed through its own promise: callbacks passed to `mutate` only fire for the latest
 * call of a hook, so with several changes in flight an earlier failure would roll back without a word.
 */
export function useTaskActions(): TaskActions {
	const { t } = useLanguage();
	const { mutateAsync: create } = useCreateTask();
	const { mutateAsync: update } = useUpdateTask();
	const { mutateAsync: move } = useMoveTask();
	const { mutateAsync: remove } = useDeleteTask();
	return useMemo(() => {
		const onError = (error: unknown) => { toast.error(taskErrorMessage(error, t)); };
		return {
			create: (input, onCreated) => void create(input).then((data) => onCreated?.(data.task), onError),
			update: (id, input) => void update({ id, ...input }).catch(onError),
			move: (id, input) => void move({ id, ...input }).catch(onError),
			remove: (id) => void remove(id).catch(onError),
		};
	}, [create, update, move, remove, t]);
}

export type TaskListActions = {
	create: (title: string, onCreated?: (list: TaskList) => void) => void;
	rename: (id: string, title: string) => void;
	/** Places the list after `previousId` (null = first). */
	reorder: (id: string, previousId: string | null) => void;
	remove: (id: string, onRemoved?: () => void) => void;
	clearCompleted: (id: string) => void;
};

/** The list mutations (new, rename, reorder, delete, delete completed), each wired to an error toast. */
export function useTaskListActions(): TaskListActions {
	const { t } = useLanguage();
	const { mutateAsync: create } = useCreateTaskList();
	const { mutateAsync: update } = useUpdateTaskList();
	const { mutateAsync: remove } = useDeleteTaskList();
	const { mutateAsync: clear } = useClearCompletedTasks();
	return useMemo(() => {
		const onError = (error: unknown) => { toast.error(taskErrorMessage(error, t)); };
		return {
			create: (title, onCreated) => void create({ title }).then((list) => onCreated?.(list), onError),
			rename: (id, title) => void update({ id, title }).catch(onError),
			reorder: (id, previousId) => void update({ id, previousId }).catch(onError),
			remove: (id, onRemoved) => void remove(id).then(() => onRemoved?.(), onError),
			clearCompleted: (id) => void clear(id).catch(onError),
		};
	}, [create, update, remove, clear, t]);
}
