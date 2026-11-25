import { and, asc, count, desc, eq, gt, gte, inArray, isNotNull, isNull, lt, lte, ne, or, type SQL } from "drizzle-orm";
import { getDb } from "@/db";
import type { AppDatabase } from "@/db";
import { messages, taskLists, tasks } from "@/db/schema";
import type { SessionUser } from "@/lib/auth/types";
import { isMissingTableError } from "@/lib/database-errors";
import { selectInBatches } from "@/lib/db-params";
import { isOthersDraft } from "@/lib/email/draft-access";
import { newId } from "@/lib/ids";
import { getMailboxAccessLevel, listAccessibleMailboxIds } from "@/lib/mailboxes/access";
import { normalizeTimeZone } from "@/lib/time/utils";
import { TASK_TITLE_MAX } from "./schemas";
import {
	addDays, compareRanks, compareTasksByDue, dateInZone, deriveDue, dueInputOf, expandRepeatOccurrences, nextRepeatOccurrence,
	rankBetween, repeatAnchorDay, sortTasksForQuery, startOfDayInZone, timeInZone, zonedInstant,
} from "./task-utils";
import type {
	CreateTaskInput, CreateTaskListInput, MoveTaskInput, Task, TaskErrorCode, TaskList, TaskListsResponse, TaskMutationResponse,
	TaskOccurrence, TaskQuery, TasksResponse, UpdateTaskInput, UpdateTaskListInput,
} from "./types";

/**
 * The Tasks service: every query and rule of the local Tasks app lives here, so the REST routes, the
 * side panel, the calendar and any assistant tool share one behaviour.
 *
 * - Ownership: a task and a list belong to one user; every statement filters on `userId`.
 * - Nesting is one level, order is a rank string per sibling group (`rankBetween`).
 * - A due date is a calendar date plus an optional instant; the reminder is derived on every write.
 * - A repeating task is one open row carrying the rule; completing it creates the next occurrence.
 * - Before migration 9000_local_tasks is applied, reads answer empty with `migrationRequired` and
 *   writes throw `TaskError("MIGRATION_REQUIRED")`.
 */

export type TaskUser = Pick<SessionUser, "id" | "email" | "role" | "timeZone">;
type TaskRow = typeof tasks.$inferSelect;
type TaskListRow = typeof taskLists.$inferSelect;

export class TaskError extends Error {
	constructor(readonly code: TaskErrorCode, message: string) {
		super(message);
		this.name = "TaskError";
	}
}

export const DEFAULT_TASK_LIST_TITLE = "My Tasks";
/** Rows one `listTasks` response carries; more sets `truncated`. */
export const MAX_TASKS_PER_RESPONSE = 2000;
export const MAX_TASK_LISTS = 200;
/** Longest `dueFrom`..`dueTo` window, in days. */
export const MAX_DUE_RANGE_DAYS = 370;
const MAX_OCCURRENCES_PER_RESPONSE = 1000;
/** A reminder that came due this long ago (the cron was down) is dropped instead of sent late. */
const STALE_REMINDER_MS = 24 * 60 * 60 * 1000;

const OPEN = "needs-action" as const;
const DONE = "completed" as const;
const NO_REPEAT = { repeatFreq: null, repeatInterval: 1, repeatAnchorDay: null, repeatUntil: null, repeatCount: null } as const;

const invalid = (message: string) => new TaskError("INVALID", message);
const notFound = (message: string) => new TaskError("NOT_FOUND", message);

async function reading<T>(fallback: T, run: () => Promise<T>): Promise<T> {
	try {
		return await run();
	} catch (error) {
		if (isMissingTableError(error)) return fallback;
		throw error;
	}
}

async function writing<T>(run: () => Promise<T>): Promise<T> {
	try {
		return await run();
	} catch (error) {
		if (isMissingTableError(error)) throw new TaskError("MIGRATION_REQUIRED", "Apply pending database migrations first");
		throw error;
	}
}

// ---- Rows to JSON ----

const iso = (value: Date | null) => (value ? value.toISOString() : null);

function toTask(row: TaskRow, links: Map<string, string>): Task {
	const subject = row.messageId ? links.get(row.messageId) : undefined;
	return {
		id: row.id,
		listId: row.listId,
		parentId: row.parentId,
		title: row.title,
		notes: row.notes,
		status: row.status,
		completedAt: iso(row.completedAt),
		dueDate: row.dueDate,
		dueAt: iso(row.dueAt),
		timeZone: row.timeZone,
		starred: row.starredAt !== null,
		starredAt: iso(row.starredAt),
		position: row.position,
		message: row.messageId && subject !== undefined ? { id: row.messageId, subject } : null,
		repeat: row.repeatFreq ? { freq: row.repeatFreq, interval: row.repeatInterval, until: row.repeatUntil, count: row.repeatCount, index: row.repeatIndex } : null,
		seriesId: row.seriesId,
		createdAt: row.createdAt.toISOString(),
		updatedAt: row.updatedAt.toISOString(),
	};
}

/**
 * Subjects of the linked emails the user may still read, by message id. A link to mail in a mailbox that
 * is no longer shared with them (or to someone else's private draft) is left out, so the chip disappears.
 */
async function readableLinks(db: AppDatabase, user: TaskUser, rows: readonly TaskRow[]): Promise<Map<string, string>> {
	const ids = rows.map((row) => row.messageId).filter((id): id is string => id !== null);
	const links = new Map<string, string>();
	if (ids.length === 0) return links;
	const [found, mailboxIds] = await Promise.all([
		selectInBatches(ids, (batch) => db
			.select({ id: messages.id, subject: messages.subject, mailboxId: messages.mailboxId, userId: messages.userId, privateDraft: messages.privateDraft })
			.from(messages)
			.where(inArray(messages.id, batch))),
		listAccessibleMailboxIds(db, user),
	]);
	const accessible = new Set(mailboxIds);
	for (const message of found) {
		if (!message.mailboxId || !accessible.has(message.mailboxId) || isOthersDraft(message, user.id)) continue;
		links.set(message.id, message.subject ?? "");
	}
	return links;
}

async function toTasks(db: AppDatabase, user: TaskUser, rows: readonly TaskRow[]): Promise<Task[]> {
	const links = await readableLinks(db, user, rows);
	return rows.map((row) => toTask(row, links));
}

/** An email the user may read, for linking a task to it. */
async function readableMessage(db: AppDatabase, user: TaskUser, messageId: string): Promise<{ id: string; subject: string } | null> {
	const [message] = await db
		.select({ id: messages.id, subject: messages.subject, mailboxId: messages.mailboxId, userId: messages.userId, privateDraft: messages.privateDraft })
		.from(messages)
		.where(eq(messages.id, messageId))
		.limit(1);
	if (!message?.mailboxId || isOthersDraft(message, user.id)) return null;
	const access = await getMailboxAccessLevel(db, user, message.mailboxId);
	return access?.canRead ? { id: message.id, subject: message.subject ?? "" } : null;
}

async function ownedTask(db: AppDatabase, userId: string, id: string): Promise<TaskRow | null> {
	const [row] = await db.select().from(tasks).where(and(eq(tasks.id, id), eq(tasks.userId, userId))).limit(1);
	return row ?? null;
}

async function ownedList(db: AppDatabase, userId: string, id: string): Promise<TaskListRow | null> {
	const [row] = await db.select().from(taskLists).where(and(eq(taskLists.id, id), eq(taskLists.userId, userId))).limit(1);
	return row ?? null;
}

/** Timestamps keep whole seconds, so an edit made in the row's own second must still land after `createdAt`. */
const editedAt = (row: { createdAt: Date }, now: Date) => new Date(Math.max(now.getTime(), row.createdAt.getTime() + 1000));

// ---- Lists ----

const byPosition = <T extends { position: string; id: string }>(a: T, b: T) => compareRanks(a.position, b.position) || (a.id < b.id ? -1 : 1);

/** The user's lists in order, creating "My Tasks" on first use so there is always somewhere to add a task. */
async function listsOf(db: AppDatabase, userId: string): Promise<TaskListRow[]> {
	const select = () => db.select().from(taskLists).where(eq(taskLists.userId, userId));
	let rows = await select();
	if (rows.length === 0) {
		// A fixed id makes two first requests racing each other insert one list, not two.
		await db.insert(taskLists).values({ id: `tl_${userId}`, userId, title: DEFAULT_TASK_LIST_TITLE, position: rankBetween(null, null) }).onConflictDoNothing();
		rows = await select();
	}
	return rows.sort(byPosition);
}

function toList(row: TaskListRow, openCount: number): TaskList {
	return { id: row.id, title: row.title, position: row.position, openCount, createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString() };
}

export async function listTaskLists(env: CloudflareEnv, user: TaskUser): Promise<TaskListsResponse> {
	return reading<TaskListsResponse>({ lists: [], migrationRequired: true }, async () => {
		const db = getDb(env);
		const rows = await listsOf(db, user.id);
		const counts = await db
			.select({ listId: tasks.listId, open: count() })
			.from(tasks)
			.where(and(eq(tasks.userId, user.id), eq(tasks.status, OPEN), isNull(tasks.parentId)))
			.groupBy(tasks.listId);
		const openByList = new Map(counts.map((row) => [row.listId, Number(row.open)]));
		return { lists: rows.map((row) => toList(row, openByList.get(row.id) ?? 0)), migrationRequired: false };
	});
}

export async function createTaskList(env: CloudflareEnv, user: TaskUser, input: CreateTaskListInput): Promise<TaskList> {
	return writing(async () => {
		const db = getDb(env);
		const rows = await listsOf(db, user.id);
		if (rows.length >= MAX_TASK_LISTS) throw invalid(`You can have up to ${MAX_TASK_LISTS} lists`);
		const now = new Date();
		const row: TaskListRow = { id: newId("tl"), userId: user.id, title: input.title, position: rankBetween(rows.at(-1)?.position ?? null, null), createdAt: now, updatedAt: now };
		await db.insert(taskLists).values(row);
		return toList(row, 0);
	});
}

/** Renames a list and/or moves it after `previousId` (null = first). */
export async function updateTaskList(env: CloudflareEnv, user: TaskUser, id: string, input: UpdateTaskListInput): Promise<TaskList> {
	return writing(async () => {
		const db = getDb(env);
		const rows = await listsOf(db, user.id);
		const row = rows.find((candidate) => candidate.id === id);
		if (!row) throw notFound("List not found");
		const change: Partial<TaskListRow> = { updatedAt: editedAt(row, new Date()) };
		if (input.title !== undefined) change.title = input.title;
		if (input.previousId !== undefined) {
			if (input.previousId === id) throw invalid("A list cannot follow itself");
			const others = rows.filter((candidate) => candidate.id !== id);
			const index = input.previousId === null ? -1 : others.findIndex((candidate) => candidate.id === input.previousId);
			if (input.previousId !== null && index < 0) throw notFound("List not found");
			change.position = rankBetween(others[index]?.position ?? null, others[index + 1]?.position ?? null);
		}
		await db.update(taskLists).set(change).where(and(eq(taskLists.id, id), eq(taskLists.userId, user.id)));
		const [open] = await db.select({ open: count() }).from(tasks).where(and(eq(tasks.listId, id), eq(tasks.status, OPEN), isNull(tasks.parentId)));
		return toList({ ...row, ...change }, Number(open?.open ?? 0));
	});
}

/** Deletes a list with its tasks. The last list stays: there must always be one to add to. */
export async function deleteTaskList(env: CloudflareEnv, user: TaskUser, id: string): Promise<void> {
	return writing(async () => {
		const db = getDb(env);
		const rows = await listsOf(db, user.id);
		if (!rows.some((row) => row.id === id)) throw notFound("List not found");
		if (rows.length === 1) throw new TaskError("LAST_LIST", "The last list cannot be deleted");
		await db.batch([
			db.delete(tasks).where(and(eq(tasks.listId, id), eq(tasks.userId, user.id))),
			db.delete(taskLists).where(and(eq(taskLists.id, id), eq(taskLists.userId, user.id))),
		]);
	});
}

/** Deletes the completed tasks of a list; answers how many. */
export async function clearCompletedTasks(env: CloudflareEnv, user: TaskUser, listId: string): Promise<{ removed: number }> {
	return writing(async () => {
		const db = getDb(env);
		if (!(await ownedList(db, user.id, listId))) throw notFound("List not found");
		const completed = and(eq(tasks.listId, listId), eq(tasks.userId, user.id), eq(tasks.status, DONE));
		const [found] = await db.select({ total: count() }).from(tasks).where(completed);
		await db.delete(tasks).where(completed);
		return { removed: Number(found?.total ?? 0) };
	});
}

// ---- Reading tasks ----

/** Due on `date` or earlier for a viewer in `timeZone`: a timed task counts by its instant, a date-only one by its date. */
function dueOnOrBefore(date: string, timeZone: string): SQL {
	return or(and(isNull(tasks.dueAt), lte(tasks.dueDate, date)), lt(tasks.dueAt, startOfDayInZone(addDays(date, 1), timeZone)))!;
}

function dueOnOrAfter(date: string, timeZone: string): SQL {
	return or(and(isNull(tasks.dueAt), gte(tasks.dueDate, date)), gte(tasks.dueAt, startOfDayInZone(date, timeZone)))!;
}

/** Projected occurrences of the user's open repeating tasks that fall on `from`..`to` for a viewer in `timeZone`. */
async function projectOccurrences(db: AppDatabase, userId: string, query: TaskQuery, from: string, to: string, timeZone: string): Promise<TaskOccurrence[]> {
	const rows = await db
		.select()
		.from(tasks)
		.where(and(
			eq(tasks.userId, userId),
			eq(tasks.status, OPEN),
			isNotNull(tasks.repeatFreq),
			// A day of slack: a timed task entered in another zone can fall on the viewer's neighbouring date.
			lte(tasks.dueDate, addDays(to, 1)),
			...(query.listId ? [eq(tasks.listId, query.listId)] : []),
			...(query.messageId ? [eq(tasks.messageId, query.messageId)] : []),
		))
		.limit(MAX_TASKS_PER_RESPONSE);
	const occurrences: TaskOccurrence[] = [];
	for (const row of rows) {
		if (!row.repeatFreq || !row.dueDate) continue;
		const zone = normalizeTimeZone(row.timeZone);
		const time = row.dueAt ? timeInZone(row.dueAt, zone) : null;
		const state = { freq: row.repeatFreq, interval: row.repeatInterval, until: row.repeatUntil, count: row.repeatCount, index: row.repeatIndex, anchorDay: row.repeatAnchorDay };
		for (const occurrence of expandRepeatOccurrences(row.dueDate, state, addDays(from, -1), addDays(to, 1))) {
			const dueAt = time ? zonedInstant(occurrence.dueDate, time, zone) : null;
			const localDate = dueAt ? dateInZone(dueAt, timeZone) : occurrence.dueDate;
			if (localDate < from || localDate > to) continue;
			occurrences.push({
				id: `${row.id}@${occurrence.dueDate}`, taskId: row.id, listId: row.listId, title: row.title, starred: row.starredAt !== null,
				dueDate: occurrence.dueDate, dueAt: iso(dueAt), timeZone: row.timeZone, repeatIndex: occurrence.index,
			});
			if (occurrences.length >= MAX_OCCURRENCES_PER_RESPONSE) return occurrences;
		}
	}
	return occurrences.sort((a, b) => compareTasksByDue({ ...a, position: "" }, { ...b, position: "" }, timeZone));
}

/**
 * The user's tasks matching `query` (filters combine with AND). `timeZone` is the viewer's zone, which
 * decides what "today" is and which date a timed task falls on; it defaults to the account's.
 */
export async function listTasks(env: CloudflareEnv, user: TaskUser, query: TaskQuery = {}, options: { now?: Date; timeZone?: string } = {}): Promise<TasksResponse> {
	const timeZone = normalizeTimeZone(options.timeZone ?? user.timeZone);
	const today = dateInZone(options.now ?? new Date(), timeZone);
	if (query.dueFrom && query.dueTo) {
		if (query.dueTo < query.dueFrom) throw invalid("dueTo is before dueFrom");
		if (addDays(query.dueFrom, MAX_DUE_RANGE_DAYS) < query.dueTo) throw invalid(`Choose a range of at most ${MAX_DUE_RANGE_DAYS} days`);
	}
	return reading<TasksResponse>({ tasks: [], occurrences: [], truncated: false, migrationRequired: true }, async () => {
		const db = getDb(env);
		const conditions: SQL[] = [eq(tasks.userId, user.id)];
		if (query.listId) conditions.push(eq(tasks.listId, query.listId));
		if (query.messageId) conditions.push(eq(tasks.messageId, query.messageId));
		if (query.completed !== undefined) conditions.push(eq(tasks.status, query.completed ? DONE : OPEN));
		if (query.view) conditions.push(eq(tasks.status, OPEN));
		if (query.view === "starred") conditions.push(isNotNull(tasks.starredAt));
		if (query.view === "today") conditions.push(dueOnOrBefore(today, timeZone));
		if (query.view === "upcoming") conditions.push(dueOnOrAfter(addDays(today, 1), timeZone));
		if (query.dueFrom) conditions.push(dueOnOrAfter(query.dueFrom, timeZone));
		if (query.dueTo) conditions.push(dueOnOrBefore(query.dueTo, timeZone));
		const rows = await db
			.select()
			.from(tasks)
			.where(and(...conditions))
			// Open tasks first, then the most recently completed, so a truncated response drops the oldest history.
			.orderBy(desc(tasks.status), desc(tasks.completedAt), asc(tasks.position))
			.limit(MAX_TASKS_PER_RESPONSE + 1);
		const truncated = rows.length > MAX_TASKS_PER_RESPONSE;
		const page = truncated ? rows.slice(0, MAX_TASKS_PER_RESPONSE) : rows;
		// A closed window is what a calendar asks for: project the repeating tasks into it.
		const window = query.dueFrom && query.dueTo && !query.view && query.completed !== true ? { from: query.dueFrom, to: query.dueTo } : null;
		return {
			tasks: sortTasksForQuery(await toTasks(db, user, page), query, timeZone),
			occurrences: window ? await projectOccurrences(db, user.id, query, window.from, window.to, timeZone) : [],
			truncated,
			migrationRequired: false,
		};
	});
}

export async function getTask(env: CloudflareEnv, user: TaskUser, id: string): Promise<Task | null> {
	return reading<Task | null>(null, async () => {
		const db = getDb(env);
		const row = await ownedTask(db, user.id, id);
		return row ? (await toTasks(db, user, [row]))[0] : null;
	});
}

// ---- Writing tasks ----

type SiblingScope = { userId: string; listId: string; parentId: string | null; excludeId?: string };

/**
 * A rank for a task among its siblings: after `previousId`, first when that is null, and at `fallback`
 * when it is not given. Completed siblings keep their place, so a reopened task returns to where it was.
 */
async function siblingRank(db: AppDatabase, scope: SiblingScope, previousId: string | null | undefined, fallback: "first" | "last"): Promise<string> {
	const siblings = and(
		eq(tasks.userId, scope.userId),
		eq(tasks.listId, scope.listId),
		scope.parentId ? eq(tasks.parentId, scope.parentId) : isNull(tasks.parentId),
		...(scope.excludeId ? [ne(tasks.id, scope.excludeId)] : []),
	);
	const edge = async (end: "first" | "last") => {
		const [row] = await db.select({ position: tasks.position }).from(tasks).where(siblings).orderBy(end === "first" ? asc(tasks.position) : desc(tasks.position)).limit(1);
		return row?.position ?? null;
	};
	if (previousId === undefined && fallback === "last") return rankBetween(await edge("last"), null);
	if (previousId == null) return rankBetween(null, await edge("first"));
	if (previousId === scope.excludeId) throw invalid("A task cannot follow itself");
	const [previous] = await db.select({ position: tasks.position }).from(tasks).where(and(siblings, eq(tasks.id, previousId))).limit(1);
	if (!previous) throw invalid("previousId is not a task at that level of the list");
	const [next] = await db.select({ position: tasks.position }).from(tasks).where(and(siblings, gt(tasks.position, previous.position))).orderBy(asc(tasks.position)).limit(1);
	return rankBetween(previous.position, next?.position ?? null);
}

async function mutationResult(db: AppDatabase, user: TaskUser, id: string, nextId: string | null = null, removedIds: string[] = []): Promise<TaskMutationResponse> {
	const [row, next] = await Promise.all([ownedTask(db, user.id, id), nextId ? ownedTask(db, user.id, nextId) : null]);
	if (!row) throw notFound("Task not found");
	const [task, following] = await toTasks(db, user, next ? [row, next] : [row]);
	return { task, next: following ?? null, removedIds };
}

export async function createTask(env: CloudflareEnv, user: TaskUser, input: CreateTaskInput, now = new Date()): Promise<TaskMutationResponse> {
	return writing(async () => {
		const db = getDb(env);
		const parent = input.parentId ? await ownedTask(db, user.id, input.parentId) : null;
		if (input.parentId && !parent) throw notFound("Parent task not found");
		if (parent?.parentId) throw invalid("A subtask cannot have subtasks");
		if (parent?.status === DONE) throw invalid("Reopen the task before adding a subtask");
		if (parent && input.listId && input.listId !== parent.listId) throw invalid("A subtask lives in its parent's list");
		if (!parent && input.listId && !(await ownedList(db, user.id, input.listId))) throw notFound("List not found");
		const listId = parent?.listId ?? input.listId ?? (await listsOf(db, user.id))[0].id;

		const message = input.messageId ? await readableMessage(db, user, input.messageId) : null;
		if (input.messageId && !message) throw notFound("Message not found");
		const title = input.title ?? (message ? message.subject.trim().slice(0, TASK_TITLE_MAX) || "(no subject)" : "");
		if (!title) throw invalid("Enter a title");

		const due = deriveDue(input.due ?? null, user.timeZone, now);
		if (input.repeat && parent) throw invalid("A subtask cannot repeat");
		if (input.repeat && !due.dueDate) throw invalid("A repeating task needs a date");
		if (input.repeat?.until && due.dueDate && input.repeat.until < due.dueDate) throw invalid("The repeat ends before the task is due");

		const id = newId("tsk");
		await db.insert(tasks).values({
			id,
			userId: user.id,
			listId,
			parentId: parent?.id ?? null,
			title,
			notes: input.notes ?? "",
			...due,
			starredAt: input.starred ? now : null,
			position: await siblingRank(db, { userId: user.id, listId, parentId: parent?.id ?? null }, input.previousId, parent ? "last" : "first"),
			messageId: message?.id ?? null,
			...(input.repeat && due.dueDate
				? { repeatFreq: input.repeat.freq, repeatInterval: input.repeat.interval ?? 1, repeatAnchorDay: repeatAnchorDay(due.dueDate), repeatUntil: input.repeat.until ?? null, repeatCount: input.repeat.count ?? null, seriesId: id }
				: {}),
			createdAt: now,
			updatedAt: now,
		});
		return mutationResult(db, user, id);
	});
}

/** The next occurrence of a repeating task being completed at `now`, as a row to insert; null when the series ends. */
function nextOccurrenceRow(row: TaskRow, position: string, userTimeZone: string | null, now: Date): TaskRow | null {
	if (!row.repeatFreq || !row.dueDate) return null;
	const zone = normalizeTimeZone(row.timeZone ?? userTimeZone);
	const state = { freq: row.repeatFreq, interval: row.repeatInterval, until: row.repeatUntil, count: row.repeatCount, index: row.repeatIndex, anchorDay: row.repeatAnchorDay };
	const next = nextRepeatOccurrence(row.dueDate, state, dateInZone(now, zone));
	if (!next) return null;
	const due = deriveDue({ date: next.dueDate, time: row.dueAt ? timeInZone(row.dueAt, zone) : null, timeZone: zone }, zone, now);
	return {
		...row,
		id: newId("tsk"),
		...due,
		status: OPEN,
		completedAt: null,
		remindedAt: null,
		position,
		repeatIndex: next.index,
		seriesId: row.seriesId ?? row.id,
		createdAt: now,
		updatedAt: now,
	};
}

/**
 * The untouched next occurrence that completing `row` created, when reopening `row` should take it back:
 * it must still be open, never edited, without subtasks, and the series must not have moved on past it.
 */
async function reclaimableSuccessor(db: AppDatabase, row: TaskRow): Promise<TaskRow | null> {
	if (!row.seriesId) return null;
	const series = await db.select().from(tasks).where(and(eq(tasks.userId, row.userId), eq(tasks.seriesId, row.seriesId))).limit(MAX_TASKS_PER_RESPONSE);
	const successor = series.find((candidate) => candidate.repeatFreq && candidate.status === OPEN && candidate.repeatIndex > row.repeatIndex);
	if (!successor || successor.updatedAt.getTime() !== successor.createdAt.getTime()) return null;
	if (series.some((candidate) => candidate.id !== row.id && candidate.repeatIndex >= row.repeatIndex && candidate.repeatIndex < successor.repeatIndex)) return null;
	const [child] = await db.select({ id: tasks.id }).from(tasks).where(eq(tasks.parentId, successor.id)).limit(1);
	return child ? null : successor;
}

/**
 * Edits a task; only the fields present change. Completing a task completes its open subtasks and, when
 * it repeats, creates the next occurrence (`next`), which takes over the rule; the completed row keeps
 * its place in the series. Reopening it takes an untouched next occurrence back (`removedIds`).
 */
export async function updateTask(env: CloudflareEnv, user: TaskUser, id: string, input: UpdateTaskInput, now = new Date()): Promise<TaskMutationResponse> {
	return writing(async () => {
		const db = getDb(env);
		const row = await ownedTask(db, user.id, id);
		if (!row) throw notFound("Task not found");
		const change: Partial<TaskRow> = { updatedAt: editedAt(row, now) };
		if (input.title !== undefined) change.title = input.title;
		if (input.notes !== undefined) change.notes = input.notes;
		if (input.starred !== undefined) change.starredAt = input.starred ? row.starredAt ?? now : null;

		const completing = input.completed === true && row.status !== DONE;
		const reopening = input.completed === false && row.status === DONE;
		const statements: PromiseLike<unknown>[] = [];
		let nextId: string | null = null;
		const removedIds: string[] = [];

		if (reopening) {
			Object.assign(change, { status: OPEN, completedAt: null });
			const parent = row.parentId ? await ownedTask(db, user.id, row.parentId) : null;
			// A subtask cannot be open under a completed parent: it returns to the list on its own.
			if (parent?.status === DONE) Object.assign(change, { parentId: null, position: await siblingRank(db, { userId: user.id, listId: row.listId, parentId: null, excludeId: row.id }, null, "first") });
			const successor = input.repeat === undefined ? await reclaimableSuccessor(db, row) : null;
			if (successor) {
				Object.assign(change, { repeatFreq: successor.repeatFreq, repeatInterval: successor.repeatInterval, repeatAnchorDay: successor.repeatAnchorDay, repeatUntil: successor.repeatUntil, repeatCount: successor.repeatCount });
				statements.push(db.delete(tasks).where(and(eq(tasks.id, successor.id), eq(tasks.userId, user.id))));
				removedIds.push(successor.id);
			}
		}

		if (input.due !== undefined) {
			Object.assign(change, deriveDue(input.due, row.timeZone ?? user.timeZone, now), { remindedAt: null });
			if (input.due === null) Object.assign(change, NO_REPEAT);
		} else if (reopening) {
			// The reminder was derived when the task was last saved; it may still lie ahead.
			Object.assign(change, { remindAt: deriveDue(dueInputOf(row), user.timeZone, now).remindAt, remindedAt: null });
		}

		const dueDate = change.dueDate !== undefined ? change.dueDate : row.dueDate;
		if (input.repeat === null) Object.assign(change, NO_REPEAT);
		if (input.repeat) {
			if (row.parentId && change.parentId !== null) throw invalid("A subtask cannot repeat");
			if (!dueDate) throw invalid("A repeating task needs a date");
			if ((change.status ?? row.status) === DONE) throw invalid("Reopen the task before making it repeat");
			if (input.repeat.until && input.repeat.until < dueDate) throw invalid("The repeat ends before the task is due");
			// A new rule starts counting at this occurrence.
			Object.assign(change, { repeatFreq: input.repeat.freq, repeatInterval: input.repeat.interval ?? 1, repeatUntil: input.repeat.until ?? null, repeatCount: input.repeat.count ?? null, repeatIndex: 0, seriesId: row.seriesId ?? row.id });
		}
		const repeats = change.repeatFreq !== undefined ? change.repeatFreq !== null : row.repeatFreq !== null;
		// Moving the date of a repeating task moves the series with it.
		if (repeats && dueDate && (input.due || input.repeat)) change.repeatAnchorDay = repeatAnchorDay(dueDate);

		if (completing) {
			Object.assign(change, { status: DONE, completedAt: now });
			const current = { ...row, ...change };
			// The next occurrence takes the place right below the one it follows.
			const next = current.repeatFreq
				? nextOccurrenceRow(current, await siblingRank(db, { userId: user.id, listId: row.listId, parentId: row.parentId }, row.id, "first"), user.timeZone, now)
				: null;
			if (next) {
				// The rule moves on to the new row. The last occurrence of a series keeps it, so reopening that one restores it.
				Object.assign(change, NO_REPEAT, { seriesId: next.seriesId });
				statements.push(db.insert(tasks).values(next));
				nextId = next.id;
			}
			statements.push(db.update(tasks).set({ status: DONE, completedAt: now, updatedAt: now }).where(and(eq(tasks.parentId, row.id), eq(tasks.userId, user.id), eq(tasks.status, OPEN))));
		}

		await db.batch([db.update(tasks).set(change).where(and(eq(tasks.id, row.id), eq(tasks.userId, user.id))), ...statements] as never);
		return mutationResult(db, user, row.id, nextId, removedIds);
	});
}

/**
 * Google's `tasks.move`: to another list, under another parent (null = top level) and after the sibling
 * `previousId` (null or omitted = first). Subtasks follow their parent to another list.
 */
export async function moveTask(env: CloudflareEnv, user: TaskUser, id: string, input: MoveTaskInput, now = new Date()): Promise<TaskMutationResponse> {
	return writing(async () => {
		const db = getDb(env);
		const row = await ownedTask(db, user.id, id);
		if (!row) throw notFound("Task not found");
		const changingList = input.listId !== undefined && input.listId !== row.listId;
		// Without a parent in the request, a task keeps its parent unless it leaves the parent's list.
		const parentId = input.parentId !== undefined ? input.parentId : changingList ? null : row.parentId;
		const parent = parentId ? await ownedTask(db, user.id, parentId) : null;
		if (parentId && !parent) throw notFound("Parent task not found");
		if (parent) {
			if (parent.id === row.id) throw invalid("A task cannot be its own subtask");
			if (parent.parentId) throw invalid("A subtask cannot have subtasks");
			if (parent.status === DONE && row.status === OPEN) throw invalid("Reopen the task before adding a subtask");
			if (input.listId !== undefined && input.listId !== parent.listId) throw invalid("A subtask lives in its parent's list");
			if (row.repeatFreq) throw invalid("A repeating task cannot be a subtask");
			const [child] = await db.select({ id: tasks.id }).from(tasks).where(and(eq(tasks.parentId, row.id), eq(tasks.userId, user.id))).limit(1);
			if (child) throw invalid("A task with subtasks cannot become a subtask");
		}
		const listId = parent?.listId ?? input.listId ?? row.listId;
		if (listId !== row.listId && !(await ownedList(db, user.id, listId))) throw notFound("List not found");
		const position = await siblingRank(db, { userId: user.id, listId, parentId: parent?.id ?? null, excludeId: row.id }, input.previousId ?? null, "first");
		await db.batch([
			db.update(tasks).set({ listId, parentId: parent?.id ?? null, position, updatedAt: editedAt(row, now) }).where(and(eq(tasks.id, row.id), eq(tasks.userId, user.id))),
			...(listId !== row.listId ? [db.update(tasks).set({ listId }).where(and(eq(tasks.parentId, row.id), eq(tasks.userId, user.id)))] : []),
		] as never);
		return mutationResult(db, user, row.id);
	});
}

/** Deletes a task and its subtasks; answers the ids removed. */
export async function deleteTask(env: CloudflareEnv, user: TaskUser, id: string): Promise<{ removedIds: string[] }> {
	return writing(async () => {
		const db = getDb(env);
		const row = await ownedTask(db, user.id, id);
		if (!row) throw notFound("Task not found");
		const children = await db.select({ id: tasks.id }).from(tasks).where(and(eq(tasks.parentId, id), eq(tasks.userId, user.id)));
		await db.batch([
			db.delete(tasks).where(and(eq(tasks.parentId, id), eq(tasks.userId, user.id))),
			db.delete(tasks).where(and(eq(tasks.id, id), eq(tasks.userId, user.id))),
		]);
		return { removedIds: [id, ...children.map((child) => child.id)] };
	});
}

// ---- Reminders ----

export type DueTaskReminder = { id: string; userId: string; title: string; dueDate: string | null; dueAt: Date | null; timeZone: string | null };

/**
 * Open tasks whose reminder came due, each claimed by setting `reminded_at` in a conditional update, so
 * overlapping cron runs never return (and notify about) the same task twice. The caller sends the push.
 * Reminders that came due more than a day ago are claimed but not returned.
 */
export async function claimDueTaskReminders(env: CloudflareEnv, now: Date, limit = 200): Promise<DueTaskReminder[]> {
	return reading<DueTaskReminder[]>([], async () => {
		const db = getDb(env);
		const due = await db
			.select({ id: tasks.id, userId: tasks.userId, title: tasks.title, dueDate: tasks.dueDate, dueAt: tasks.dueAt, timeZone: tasks.timeZone, remindAt: tasks.remindAt })
			.from(tasks)
			.where(and(lte(tasks.remindAt, now), isNull(tasks.remindedAt), eq(tasks.status, OPEN)))
			.orderBy(asc(tasks.remindAt))
			.limit(limit);
		const claimed: DueTaskReminder[] = [];
		for (const { remindAt, ...task } of due) {
			const won = await db.update(tasks).set({ remindedAt: now }).where(and(eq(tasks.id, task.id), isNull(tasks.remindedAt))).returning({ id: tasks.id });
			if (won.length > 0 && remindAt && now.getTime() - remindAt.getTime() <= STALE_REMINDER_MS) claimed.push(task);
		}
		return claimed;
	});
}
