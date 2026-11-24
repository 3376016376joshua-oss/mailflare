"use client";

import { useEffect } from "react";
import { useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { authFetch } from "@/lib/auth/client";
import { MESSAGES_CHANGED_EVENT, getMessagesChangedDetail } from "@/lib/messages/change-events";
import { getUserTimeZone } from "@/lib/time/utils";
import {
	PENDING_TASK_PREFIX, adjustOpenCounts, applyListUpdate, applyTaskMove, applyTaskUpdate, isPendingId, optimisticTask, removeTasksFromResponse, upsertTaskInResponse,
} from "./cache-utils";
import type { ViewerClock } from "./cache-utils";
import { rankBetween } from "./task-utils";
import type {
	CreateTaskInput, CreateTaskListInput, MoveTaskInput, Task, TaskErrorCode, TaskList, TaskListsResponse, TaskMutationResponse, TaskQuery, TasksResponse, TaskView,
	UpdateTaskInput, UpdateTaskListInput,
} from "./types";

/**
 * The browser side of Tasks: the REST calls, the TanStack Query hooks every Tasks surface shares (the
 * /tasks app, the side panel, the calendar, the mail reader), and the two window events that connect
 * them. One cache with optimistic updates means a task checked off in the panel is checked off in the
 * calendar in the same frame. See docs/local-tasks.md.
 */

export { isPendingId } from "./cache-utils";

// ---- Window events ----

/**
 * Tasks changed. The hooks send it after every mutation and refetch when anything else sends it, so code
 * that changes tasks without the hooks calls `notifyTasksChanged()`, and code that shows tasks without
 * the hooks listens with `onTasksChanged`.
 */
export const TASKS_CHANGED_EVENT = "mailflare:tasks-changed";
/** Asks the Tasks side panel to open, optionally on a list, a smart view or with a task in focus. Detail: `TasksOpenPanelDetail`. */
export const TASKS_OPEN_PANEL_EVENT = "mailflare:tasks-open-panel";

/** `view` is a hint: a panel without smart views just opens. */
export type TasksOpenPanelDetail = { taskId?: string; listId?: string; view?: TaskView };
type TasksChangedDetail = { fromHooks?: boolean };

const CHANNEL_NAME = "mailflare-tasks";
let channel: BroadcastChannel | null | undefined;

/** Other tabs of the same browser, so a task added in the mail tab shows up in an open /tasks tab. */
function tabsChannel(): BroadcastChannel | null {
	if (channel === undefined) channel = typeof BroadcastChannel === "undefined" ? null : new BroadcastChannel(CHANNEL_NAME);
	return channel;
}

function announceChange(detail: TasksChangedDetail): void {
	if (typeof window === "undefined") return;
	window.dispatchEvent(new CustomEvent<TasksChangedDetail>(TASKS_CHANGED_EVENT, { detail }));
	try {
		tabsChannel()?.postMessage("changed");
	} catch { /* A closed channel only costs the other tabs a refresh. */ }
}

/** Tell every Tasks surface (and other tabs) that tasks changed outside the hooks. */
export function notifyTasksChanged(): void {
	announceChange({});
}

/** Runs `listener` whenever tasks change in this tab, by the hooks or otherwise. Returns the unsubscribe. */
export function onTasksChanged(listener: () => void): () => void {
	window.addEventListener(TASKS_CHANGED_EVENT, listener);
	return () => window.removeEventListener(TASKS_CHANGED_EVENT, listener);
}

/** Open the Tasks side panel (where one is mounted: Mail and Calendar), optionally on a list, a smart view or a task. */
export function openTasksPanel(detail: TasksOpenPanelDetail = {}): void {
	window.dispatchEvent(new CustomEvent<TasksOpenPanelDetail>(TASKS_OPEN_PANEL_EVENT, { detail }));
}

/** Runs `listener` when something asks for the Tasks side panel. Returns the unsubscribe. */
export function onTasksOpenPanel(listener: (detail: TasksOpenPanelDetail) => void): () => void {
	const handle = (event: Event) => listener((event as CustomEvent<TasksOpenPanelDetail>).detail ?? {});
	window.addEventListener(TASKS_OPEN_PANEL_EVENT, handle);
	return () => window.removeEventListener(TASKS_OPEN_PANEL_EVENT, handle);
}

// ---- REST ----

/** A failed tasks request: `code` is the API's (`MIGRATION_REQUIRED`, `NOT_FOUND`, ...), or `UNKNOWN`. */
export class TaskRequestError extends Error {
	constructor(message: string, readonly code: TaskErrorCode | "UNKNOWN", readonly status: number) {
		super(message);
		this.name = "TaskRequestError";
	}
}

async function request<T>(path: string, init?: { method: string; body?: unknown }): Promise<T> {
	const response = await authFetch(path, init && {
		method: init.method,
		...(init.body !== undefined ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(init.body) } : {}),
	});
	const data = await response.json().catch(() => null) as ({ error?: string; code?: TaskErrorCode } & T) | null;
	if (!response.ok || data === null) throw new TaskRequestError(data?.error || `Request failed (${response.status})`, data?.code ?? "UNKNOWN", response.status);
	return data;
}

function queryString(query: TaskQuery): string {
	const params = new URLSearchParams();
	for (const key of ["listId", "view", "dueFrom", "dueTo", "messageId"] as const) if (query[key]) params.set(key, query[key]);
	if (query.completed !== undefined) params.set("completed", query.completed ? "1" : "0");
	const text = params.toString();
	return text ? `?${text}` : "";
}

const item = (id: string) => `/api/tasks/${encodeURIComponent(id)}`;
const listItem = (id: string) => `/api/tasks/lists/${encodeURIComponent(id)}`;

/** The REST calls, for code that cannot use hooks. After a write made this way, call `notifyTasksChanged()`. */
export const tasksApi = {
	lists: () => request<TaskListsResponse>("/api/tasks/lists"),
	createList: (input: CreateTaskListInput) => request<{ list: TaskList }>("/api/tasks/lists", { method: "POST", body: input }).then((data) => data.list),
	updateList: (id: string, input: UpdateTaskListInput) => request<{ list: TaskList }>(listItem(id), { method: "PATCH", body: input }).then((data) => data.list),
	deleteList: (id: string) => request<{ ok: true }>(listItem(id), { method: "DELETE" }),
	clearCompleted: (listId: string) => request<{ removed: number }>(`${listItem(listId)}/clear`, { method: "POST" }),
	list: (query: TaskQuery = {}) => request<TasksResponse>(`/api/tasks${queryString(query)}`),
	get: (id: string) => request<{ task: Task }>(item(id)).then((data) => data.task),
	create: (input: CreateTaskInput) => request<TaskMutationResponse>("/api/tasks", { method: "POST", body: input }),
	update: (id: string, input: UpdateTaskInput) => request<TaskMutationResponse>(item(id), { method: "PATCH", body: input }),
	move: (id: string, input: MoveTaskInput) => request<TaskMutationResponse>(`${item(id)}/move`, { method: "POST", body: input }),
	delete: (id: string) => request<{ removedIds: string[] }>(item(id), { method: "DELETE" }),
};

// ---- Query cache ----

const ROOT = ["tasks"] as const;

export const taskKeys = {
	/** Everything Tasks keeps in the query cache. */
	all: ROOT,
	lists: [...ROOT, "lists"] as const,
	/** Every `useTasks` query. */
	queries: [...ROOT, "query"] as const,
	query: (query: TaskQuery) => [...ROOT, "query", query] as const,
	task: (id: string) => [...ROOT, "task", id] as const,
};

/** Fresh enough to skip a refetch when a second surface mounts; stale soon enough to notice another device. */
const STALE_TIME = 15_000;
const freshness = { staleTime: STALE_TIME, refetchOnMount: true, refetchOnWindowFocus: true, refetchOnReconnect: true } as const;

const clock = (): ViewerClock => ({ now: new Date(), timeZone: getUserTimeZone() });

type CachedQuery = [query: TaskQuery, data: TasksResponse];

function cachedQueries(client: QueryClient): CachedQuery[] {
	return client.getQueriesData<TasksResponse>({ queryKey: taskKeys.queries }).flatMap(([key, data]) => (data ? [[(key[2] ?? {}) as TaskQuery, data] satisfies CachedQuery] : []));
}

/** Every task some query already loaded, once each: what optimistic updates know about the user's tasks. */
function cachedTasks(client: QueryClient): Task[] {
	const byId = new Map<string, Task>();
	for (const [, data] of cachedQueries(client)) for (const task of data.tasks) if (!byId.has(task.id)) byId.set(task.id, task);
	for (const [, task] of client.getQueriesData<Task>({ queryKey: [...ROOT, "task"] })) if (task && !byId.has(task.id)) byId.set(task.id, task);
	return [...byId.values()];
}

/** A task from the cache, for surfaces that hold only its id (a calendar chip, a notification link). */
export function findCachedTask(client: QueryClient, id: string): Task | undefined {
	return cachedTasks(client).find((task) => task.id === id);
}

function rewriteQueries(client: QueryClient, rewrite: (data: TasksResponse, query: TaskQuery) => TasksResponse): void {
	for (const [query] of cachedQueries(client)) client.setQueryData<TasksResponse>(taskKeys.query(query), (data) => (data ? rewrite(data, query) : data));
}

function rewriteLists(client: QueryClient, rewrite: (lists: TaskList[]) => TaskList[]): void {
	client.setQueryData<TaskListsResponse>(taskKeys.lists, (data) => (data ? { ...data, lists: rewrite(data.lists) } : data));
}

/** Shows `after` (the state of a task once the mutation lands) everywhere it belongs, replacing `before`. */
function showTask(client: QueryClient, before: Task | null, after: Task, options: { completeSubtasks?: boolean; resetOccurrences?: boolean } = {}): void {
	const now = clock();
	rewriteQueries(client, (data, query) => upsertTaskInResponse(data, query, after, now, options));
	rewriteLists(client, (lists) => adjustOpenCounts(lists, before, after));
	client.setQueryData<Task>(taskKeys.task(after.id), (current) => (current ? after : current));
}

type Snapshot = Array<[key: readonly unknown[], data: unknown]>;

/** Stops in-flight reads from overwriting an optimistic update, and remembers the cache to roll back to. */
async function beginOptimistic(client: QueryClient): Promise<Snapshot> {
	await client.cancelQueries({ queryKey: taskKeys.all });
	return client.getQueriesData({ queryKey: taskKeys.all });
}

function rollBack(client: QueryClient, snapshot: Snapshot | undefined): void {
	for (const [key, data] of snapshot ?? []) client.setQueryData(key, data);
}

const MUTATION_KEY = ["tasks"] as const;

const settling = new WeakSet<QueryClient>();

/**
 * After a mutation settles: refetch what the server knows better, and tell the rest of the page. The
 * check runs once the mutation has left the cache's pending set, and waits while other task mutations
 * are still in flight (the last of them refetches), so a slow response never paints an older state over
 * a newer optimistic one and a burst of changes costs one refetch.
 */
function settle(client: QueryClient): void {
	if (settling.has(client)) return;
	settling.add(client);
	setTimeout(() => {
		settling.delete(client);
		if (client.isMutating({ mutationKey: MUTATION_KEY }) > 0) return;
		void client.invalidateQueries({ queryKey: taskKeys.all });
		announceChange({ fromHooks: true });
	}, 0);
}

const listeners = new WeakMap<QueryClient, { count: number; stop: () => void }>();

/** Refetches cached tasks when they change outside the hooks (`notifyTasksChanged`) or in another tab, and when mail is deleted for good. */
function useTasksSync(): void {
	const client = useQueryClient();
	useEffect(() => {
		const entry = listeners.get(client) ?? { count: 0, stop: () => undefined };
		if (!listeners.has(client)) {
			const refetch = () => void client.invalidateQueries({ queryKey: taskKeys.all });
			const onChanged = (event: Event) => {
				if (!(event as CustomEvent<TasksChangedDetail>).detail?.fromHooks) refetch();
			};
			// A task names its email only while that email exists, so mail deleted for good takes the link with it.
			// The mail screens say so with `action: "delete"`; emptying Trash or Spam only says that mail changed.
			const onMailChanged = (event: Event) => {
				const detail = getMessagesChangedDetail(event);
				if (!detail || detail.action === "delete") refetch();
			};
			const tabs = tabsChannel();
			window.addEventListener(TASKS_CHANGED_EVENT, onChanged);
			window.addEventListener(MESSAGES_CHANGED_EVENT, onMailChanged);
			tabs?.addEventListener("message", refetch);
			entry.stop = () => {
				window.removeEventListener(TASKS_CHANGED_EVENT, onChanged);
				window.removeEventListener(MESSAGES_CHANGED_EVENT, onMailChanged);
				tabs?.removeEventListener("message", refetch);
			};
			listeners.set(client, entry);
		}
		entry.count += 1;
		return () => {
			entry.count -= 1;
			if (entry.count === 0) {
				entry.stop();
				listeners.delete(client);
			}
		};
	}, [client]);
}

// ---- Reading ----

/** The user's lists in order with their open counts. `data.migrationRequired` means Tasks is not set up yet. */
export function useTaskLists(options: { enabled?: boolean } = {}) {
	useTasksSync();
	return useQuery({ queryKey: taskKeys.lists, queryFn: tasksApi.lists, enabled: options.enabled ?? true, ...freshness });
}

/**
 * Tasks matching `query` (see `TaskQuery`): a list, a smart view, a due-date window (with projected
 * occurrences of repeating tasks) or the tasks made from an email. The response is already in display
 * order; `buildTaskTree` groups subtasks under their parents.
 */
export function useTasks(query: TaskQuery, options: { enabled?: boolean } = {}) {
	useTasksSync();
	return useQuery({ queryKey: taskKeys.query(query), queryFn: () => tasksApi.list(query), enabled: options.enabled ?? true, ...freshness });
}

/** One task by id, shown at once from whatever query already loaded it. */
export function useTask(id: string | null | undefined) {
	useTasksSync();
	const client = useQueryClient();
	return useQuery({
		queryKey: taskKeys.task(id ?? ""),
		queryFn: () => tasksApi.get(id ?? ""),
		enabled: !!id && !isPendingId(id),
		placeholderData: () => (id ? findCachedTask(client, id) : undefined),
		...freshness,
	});
}

// ---- Writing ----

/**
 * Adds a task. It appears at once under a temporary id (`isPendingId`) wherever it belongs, and is
 * replaced by the server's task when the request returns. Pass `due.timeZone` from `getUserTimeZone()`.
 */
export function useCreateTask() {
	const client = useQueryClient();
	return useMutation({
		mutationKey: MUTATION_KEY,
		mutationFn: (input: CreateTaskInput) => tasksApi.create(input),
		onMutate: async (input) => {
			const snapshot = await beginOptimistic(client);
			const pending = optimisticTask(input, {
				id: `${PENDING_TASK_PREFIX}${crypto.randomUUID()}`,
				listId: client.getQueryData<TaskListsResponse>(taskKeys.lists)?.lists[0]?.id,
				siblings: cachedTasks(client),
				clock: clock(),
			});
			if (pending) showTask(client, null, pending);
			return { snapshot, pendingId: pending?.id };
		},
		onSuccess: (data, _input, context) => {
			// The pending copy already counted towards its list.
			if (context?.pendingId) rewriteQueries(client, (response, query) => upsertTaskInResponse(response, query, data.task, clock(), { replaceId: context.pendingId }));
			else showTask(client, null, data.task);
		},
		onError: (_error, _input, context) => rollBack(client, context?.snapshot),
		onSettled: () => settle(client),
	});
}

/**
 * Edits a task: title, notes, due date, repeat rule, star, and completing or reopening it. The change
 * shows at once in every cached query. Completing a repeating task answers with `next`, the occurrence
 * that follows; reopening it may answer with `removedIds`.
 */
export function useUpdateTask() {
	const client = useQueryClient();
	return useMutation({
		mutationKey: MUTATION_KEY,
		mutationFn: ({ id, ...input }: UpdateTaskInput & { id: string }) => tasksApi.update(id, input),
		onMutate: async ({ id, ...input }) => {
			const snapshot = await beginOptimistic(client);
			const before = findCachedTask(client, id);
			if (before) {
				showTask(client, before, applyTaskUpdate(before, input, clock()), {
					completeSubtasks: input.completed === true && before.status !== "completed",
					resetOccurrences: input.completed !== undefined || input.due !== undefined || input.repeat !== undefined,
				});
			}
			return { snapshot };
		},
		onSuccess: (data) => {
			const now = clock();
			rewriteQueries(client, (response, query) => {
				let next = upsertTaskInResponse(response, query, data.task, now);
				if (data.next) next = upsertTaskInResponse(next, query, data.next, now);
				return data.removedIds.length ? removeTasksFromResponse(next, query, new Set(data.removedIds), now) : next;
			});
			client.setQueryData<Task>(taskKeys.task(data.task.id), (current) => (current ? data.task : current));
		},
		onError: (_error, _input, context) => rollBack(client, context?.snapshot),
		onSettled: () => settle(client),
	});
}

/**
 * Moves a task: to another list (`listId`), under a parent or back to the top level (`parentId`), and
 * after a sibling (`previousId`; null or omitted = first). This is what a drag ends with.
 */
export function useMoveTask() {
	const client = useQueryClient();
	return useMutation({
		mutationKey: MUTATION_KEY,
		mutationFn: ({ id, ...input }: MoveTaskInput & { id: string }) => tasksApi.move(id, input),
		onMutate: async ({ id, ...input }) => {
			const snapshot = await beginOptimistic(client);
			const tasks = cachedTasks(client);
			const before = tasks.find((task) => task.id === id);
			if (before) showTask(client, before, applyTaskMove(before, input, tasks));
			return { snapshot };
		},
		onSuccess: (data) => rewriteQueries(client, (response, query) => upsertTaskInResponse(response, query, data.task, clock())),
		onError: (_error, _input, context) => rollBack(client, context?.snapshot),
		onSettled: () => settle(client),
	});
}

/** Deletes a task and its subtasks. */
export function useDeleteTask() {
	const client = useQueryClient();
	return useMutation({
		mutationKey: MUTATION_KEY,
		mutationFn: (id: string) => tasksApi.delete(id),
		onMutate: async (id) => {
			const snapshot = await beginOptimistic(client);
			const before = findCachedTask(client, id);
			const now = clock();
			rewriteQueries(client, (data, query) => removeTasksFromResponse(data, query, new Set([id]), now));
			rewriteLists(client, (lists) => adjustOpenCounts(lists, before, null));
			client.removeQueries({ queryKey: taskKeys.task(id) });
			return { snapshot };
		},
		onError: (_error, _id, context) => rollBack(client, context?.snapshot),
		onSettled: () => settle(client),
	});
}

/** Adds a list after the last one; it appears at once under a temporary id (`isPendingId`). */
export function useCreateTaskList() {
	const client = useQueryClient();
	return useMutation({
		mutationKey: MUTATION_KEY,
		mutationFn: (input: CreateTaskListInput) => tasksApi.createList(input),
		onMutate: async (input) => {
			const snapshot = await beginOptimistic(client);
			const now = new Date().toISOString();
			const pendingId = `${PENDING_TASK_PREFIX}${crypto.randomUUID()}`;
			rewriteLists(client, (lists) => [...lists, { id: pendingId, title: input.title.trim(), position: rankBetween(lists.at(-1)?.position ?? null, null), openCount: 0, createdAt: now, updatedAt: now }]);
			return { snapshot, pendingId };
		},
		onSuccess: (list, _input, context) => rewriteLists(client, (lists) => [...lists.filter((candidate) => candidate.id !== context?.pendingId && candidate.id !== list.id), list]),
		onError: (_error, _input, context) => rollBack(client, context?.snapshot),
		onSettled: () => settle(client),
	});
}

/** Renames a list (`title`) and/or moves it after another (`previousId`; null = first). */
export function useUpdateTaskList() {
	const client = useQueryClient();
	return useMutation({
		mutationKey: MUTATION_KEY,
		mutationFn: ({ id, ...input }: UpdateTaskListInput & { id: string }) => tasksApi.updateList(id, input),
		onMutate: async ({ id, ...input }) => {
			const snapshot = await beginOptimistic(client);
			rewriteLists(client, (lists) => applyListUpdate(lists, id, input));
			return { snapshot };
		},
		onError: (_error, _input, context) => rollBack(client, context?.snapshot),
		onSettled: () => settle(client),
	});
}

/** Deletes a list with its tasks. The only list cannot be deleted (`TaskRequestError` code `LAST_LIST`). */
export function useDeleteTaskList() {
	const client = useQueryClient();
	return useMutation({
		mutationKey: MUTATION_KEY,
		mutationFn: (id: string) => tasksApi.deleteList(id),
		onMutate: async (id) => {
			const snapshot = await beginOptimistic(client);
			const lists = client.getQueryData<TaskListsResponse>(taskKeys.lists)?.lists ?? [];
			if (lists.length > 1) {
				rewriteLists(client, (current) => current.filter((list) => list.id !== id));
				rewriteQueries(client, (data) => ({ ...data, tasks: data.tasks.filter((task) => task.listId !== id), occurrences: data.occurrences.filter((occurrence) => occurrence.listId !== id) }));
			}
			return { snapshot };
		},
		onError: (_error, _id, context) => rollBack(client, context?.snapshot),
		onSettled: () => settle(client),
	});
}

/** Deletes the completed tasks of a list. */
export function useClearCompletedTasks() {
	const client = useQueryClient();
	return useMutation({
		mutationKey: MUTATION_KEY,
		mutationFn: (listId: string) => tasksApi.clearCompleted(listId),
		onMutate: async (listId) => {
			const snapshot = await beginOptimistic(client);
			rewriteQueries(client, (data) => ({ ...data, tasks: data.tasks.filter((task) => !(task.listId === listId && task.status === "completed")) }));
			return { snapshot };
		},
		onError: (_error, _listId, context) => rollBack(client, context?.snapshot),
		onSettled: () => settle(client),
	});
}
