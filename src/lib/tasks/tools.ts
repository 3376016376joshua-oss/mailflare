import { and, inArray } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "@/db";
import { messages } from "@/db/schema";
import type { AgentToolContext } from "@/lib/agent/types";
import { normalizeTimeZone } from "@/lib/time/utils";
import { createTaskSchema, firstIssue, moveTaskSchema, TASK_NOTES_MAX, TASK_TITLE_MAX, updateTaskSchema } from "./schemas";
import { createTask, getTask, listTaskLists, listTasks, moveTask, TaskError, updateTask } from "./service";
import { dueInputOf, MAX_REPEAT_COUNT, MAX_REPEAT_INTERVAL } from "./task-utils";
import { TASK_TOOL_NAMES } from "./tool-scopes";
import type { TaskToolContext, TaskToolName, ToolTask } from "./tool-types";
import type { Task, TaskMutationResponse, TaskOccurrence, TaskQuery } from "./types";

/**
 * The task tools of the assistant and the MCP server, shaped like `src/lib/calendar/tools.ts`: schemas,
 * descriptions and one runner. Every read and write goes through the tasks service, so the tools follow
 * the same rules as the app. Create and update apply at once (they are easy to undo); there is no delete
 * tool, deleting stays a human action.
 */

export { TASK_TOOL_NAMES, taskToolScope } from "./tool-scopes";

const MAX_UPDATES = 20;
const MAX_LISTED = 500;
const MIGRATION_MESSAGE = "Tasks need a database update first: an administrator has to apply the pending migrations in Mailflare.";

const id = z.string().min(1).max(160);
// The patterns guide the model; the service schemas check that the date and time really exist.
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe("Calendar date, YYYY-MM-DD");
const due = z.object({
	date,
	time: z.string().regex(/^\d{2}:\d{2}$/).optional().describe("24-hour time of day, HH:MM. Leave out for a task due on the day without a time."),
	timeZone: z.string().max(80).optional().describe("IANA time zone of the date and time. Defaults to the user's."),
});
const repeat = z.object({
	freq: z.enum(["daily", "weekly", "monthly", "yearly"]),
	interval: z.number().int().min(1).max(MAX_REPEAT_INTERVAL).optional().describe("Every N days, weeks, months or years. Default 1."),
	until: date.optional().describe("Last date an occurrence may fall on. Not together with count."),
	count: z.number().int().min(1).max(MAX_REPEAT_COUNT).optional().describe("Total number of occurrences. Not together with until."),
});
const title = z.string().trim().min(1).max(TASK_TITLE_MAX);
const notes = z.string().max(TASK_NOTES_MAX);

const update = z.object({
	taskId: id,
	title: title.optional(),
	notes: notes.optional(),
	due: due.nullable().optional().describe("New due date. null removes it, and the repeat with it."),
	repeat: repeat.nullable().optional().describe("New repeat rule; the task needs a due date. null stops the repeat."),
	starred: z.boolean().optional(),
	completed: z.boolean().optional().describe("true completes the task and its open subtasks, false reopens it."),
	listId: id.optional().describe("Move the task, with its subtasks, to this list."),
	parentTaskId: id.nullable().optional().describe("Make the task a subtask of this task. null returns a subtask to the top level of its list."),
	afterTaskId: id.nullable().optional().describe("Place the task right after this sibling. null places it first."),
});

export const taskToolSchemas = {
	list_task_lists: z.object({}),
	list_tasks: z.object({
		listId: id.optional().describe("Only this list. Leave out for all lists."),
		view: z.enum(["starred", "today", "upcoming"]).optional().describe("starred: open starred tasks. today: open tasks due today or overdue. upcoming: open tasks due after today."),
		dueFrom: date.optional().describe("Only tasks due on or after this date."),
		dueTo: date.optional().describe("Only tasks due on or before this date."),
		status: z.enum(["open", "completed", "all"]).default("open"),
		limit: z.number().int().min(1).max(MAX_LISTED).default(100),
	}),
	get_task: z.object({ taskId: id }),
	create_task: z.object({
		title: title.optional().describe("What to do. May be left out when emailId is given: the email's subject is used."),
		notes: notes.optional(),
		listId: id.optional().describe("The list to add to. Defaults to the user's first list."),
		parentTaskId: id.optional().describe("Create a subtask of this task. Subtasks are one level deep and cannot repeat."),
		due: due.optional(),
		repeat: repeat.optional().describe("Repeat rule; needs a due date."),
		starred: z.boolean().optional(),
		emailId: id.optional().describe("Link the task to this email, so the user can open the email from the task."),
	}),
	update_tasks: z.object({ updates: z.array(update).min(1).max(MAX_UPDATES) }),
} as const;

export const taskToolDescriptions: Record<TaskToolName, string> = {
	list_task_lists: "List the user's task lists with the number of open tasks in each.",
	list_tasks: "List the user's tasks: one list or all lists, a view (starred, today including overdue, upcoming), a due date range, and open (default), completed or all. A subtask names its parent in parentTaskId.",
	get_task: "Get one task by ID with its notes, due date, repeat rule, linked email and subtasks.",
	create_task: "Create a task in one of the user's lists. This saves immediately. Optional due date (with or without a time), repeat rule, star, parent task, and an email to link.",
	update_tasks: "Change up to 20 tasks by ID: edit the title, notes, due date or repeat rule, complete or reopen, star or unstar, or move to another list, under a parent or after a sibling. This saves immediately. Completing a repeating task creates its next occurrence. Tasks cannot be deleted with these tools.",
};

type Inputs = { [K in TaskToolName]: z.infer<(typeof taskToolSchemas)[K]> };
type UpdateInput = z.infer<typeof update>;

function parsed<S extends z.ZodType>(schema: S, value: unknown): z.infer<S> {
	const result = schema.safeParse(value);
	if (!result.success) throw new Error(firstIssue(result.error));
	return result.data;
}

/** Drops the keys a tool call left out, so the service changes only what was sent. */
function defined<T extends Record<string, unknown>>(value: T): Partial<T> {
	return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as Partial<T>;
}

const zoneOf = (context: TaskToolContext) => normalizeTimeZone(context.timeZone ?? context.user.timeZone);

/** The ids among `messageIds` that sit in a mailbox this caller may see mail of. */
async function visibleEmailIds(context: TaskToolContext, messageIds: readonly string[]): Promise<Set<string>> {
	const visible = new Set<string>();
	const ids = [...new Set(messageIds)];
	const mailboxIds = [...new Set(context.emailMailboxIds)];
	if (!ids.length || !mailboxIds.length) return visible;
	const db = getDb(context.env);
	// D1 binds at most 100 parameters per statement: 45 + 45 leaves room.
	for (let m = 0; m < mailboxIds.length; m += 45) {
		for (let i = 0; i < ids.length; i += 45) {
			const rows = await db.select({ id: messages.id }).from(messages).where(and(inArray(messages.id, ids.slice(i, i + 45)), inArray(messages.mailboxId, mailboxIds.slice(m, m + 45))));
			for (const row of rows) visible.add(row.id);
		}
	}
	return visible;
}

function toToolTask(task: Task, emails: ReadonlySet<string>): ToolTask {
	const dueInput = dueInputOf(task);
	return {
		id: task.id,
		listId: task.listId,
		parentTaskId: task.parentId,
		title: task.title,
		notes: task.notes,
		status: task.status === "completed" ? "completed" : "open",
		completedAt: task.completedAt,
		due: dueInput ? { date: dueInput.date, ...(dueInput.time ? { time: dueInput.time } : {}), timeZone: normalizeTimeZone(dueInput.timeZone) } : null,
		starred: task.starred,
		repeat: task.repeat ? { freq: task.repeat.freq, interval: task.repeat.interval, until: task.repeat.until, count: task.repeat.count } : null,
		// The service already dropped links the user can no longer read; this narrows them to the caller's mailboxes.
		email: task.message && emails.has(task.message.id) ? { id: task.message.id, subject: task.message.subject, url: `/inbox/${encodeURIComponent(task.message.id)}` } : null,
		url: `/tasks?task=${encodeURIComponent(task.id)}`,
	};
}

async function toToolTasks(context: TaskToolContext, tasks: readonly Task[]): Promise<ToolTask[]> {
	const emails = await visibleEmailIds(context, tasks.flatMap((task) => task.message ? [task.message.id] : []));
	return tasks.map((task) => toToolTask(task, emails));
}

function toToolOccurrence(occurrence: TaskOccurrence) {
	const dueInput = dueInputOf(occurrence);
	return { taskId: occurrence.taskId, listId: occurrence.listId, title: occurrence.title, due: dueInput ? { date: dueInput.date, ...(dueInput.time ? { time: dueInput.time } : {}), timeZone: normalizeTimeZone(dueInput.timeZone) } : null };
}

/** A due date in a tool call without a zone is meant in the caller's zone, or the one the task already has. */
function withZone<T extends { timeZone?: string }>(value: T | null | undefined, timeZone: string): (T & { timeZone: string }) | null | undefined {
	return value ? { ...value, timeZone: value.timeZone ?? timeZone } : value;
}

async function userLists(context: TaskToolContext) {
	const { lists, migrationRequired } = await listTaskLists(context.env, context.user);
	if (migrationRequired) throw new Error(MIGRATION_MESSAGE);
	return lists;
}

const handlers: { [K in TaskToolName]: (context: TaskToolContext, input: Inputs[K]) => Promise<unknown> } = {
	async list_task_lists(context) {
		return { lists: (await userLists(context)).map((list) => ({ id: list.id, title: list.title, openTaskCount: list.openCount })) };
	},

	async list_tasks(context, input) {
		if (input.view && input.status === "completed") throw new Error("The starred, today and upcoming views list open tasks only");
		// An unknown list would read as "no tasks", which an assistant then reports as a fact.
		if (input.listId && !(await userLists(context)).some((list) => list.id === input.listId)) throw new Error("List not found");
		const query: TaskQuery = defined({ listId: input.listId, view: input.view, dueFrom: input.dueFrom, dueTo: input.dueTo, completed: input.status === "all" ? undefined : input.status === "completed" });
		const response = await listTasks(context.env, context.user, query, { timeZone: zoneOf(context) });
		if (response.migrationRequired) throw new Error(MIGRATION_MESSAGE);
		return {
			tasks: await toToolTasks(context, response.tasks.slice(0, input.limit)),
			// Future occurrences of repeating tasks in a closed date range; act on them through taskId.
			...(response.occurrences.length ? { upcomingOccurrences: response.occurrences.slice(0, input.limit).map(toToolOccurrence) } : {}),
			truncated: response.truncated || response.tasks.length > input.limit || response.occurrences.length > input.limit,
		};
	},

	async get_task(context, input) {
		const task = await getTask(context.env, context.user, input.taskId);
		if (!task) {
			await userLists(context);
			throw new Error("Task not found");
		}
		const siblings = task.parentId ? [] : (await listTasks(context.env, context.user, { listId: task.listId }, { timeZone: zoneOf(context) })).tasks.filter((item) => item.parentId === task.id);
		const [shown, ...subtasks] = await toToolTasks(context, [task, ...siblings]);
		return { task: { ...shown, subtasks } };
	},

	async create_task(context, input) {
		if (!input.title && !input.emailId) throw new Error("Enter a title");
		if (input.emailId && !(await visibleEmailIds(context, [input.emailId])).has(input.emailId)) throw new Error("Email not found");
		const result = await createTask(context.env, context.user, parsed(createTaskSchema, defined({
			title: input.title,
			notes: input.notes,
			listId: input.listId,
			parentId: input.parentTaskId,
			due: withZone(input.due, zoneOf(context)),
			repeat: input.repeat,
			starred: input.starred,
			messageId: input.emailId,
		})));
		return { status: "created", task: (await toToolTasks(context, [result.task]))[0] };
	},

	async update_tasks(context, input) {
		const ids = input.updates.map((item) => item.taskId);
		if (new Set(ids).size !== ids.length) throw new Error("Use each task ID once");
		for (const item of input.updates) if (!hasEdit(item) && !hasMove(item)) throw new Error(`Task ${item.taskId}: nothing to change`);
		const existing = await Promise.all(ids.map((taskId) => getTask(context.env, context.user, taskId)));
		if (existing.some((task) => !task)) {
			await userLists(context);
			throw new Error("Task not found");
		}
		const results: TaskMutationResponse[] = [];
		for (const [index, item] of input.updates.entries()) {
			try {
				results.push(await applyUpdate(context, item, existing[index]!));
			} catch (error) {
				// Updates are applied one by one, so say how far the call got instead of implying nothing changed.
				const message = error instanceof Error ? error.message : "Update failed";
				throw new Error(`Task ${item.taskId}: ${message}${index ? ` (${index} earlier ${index === 1 ? "update was" : "updates were"} applied)` : ""}`);
			}
		}
		const shown = await toToolTasks(context, results.flatMap((result) => result.next ? [result.task, result.next] : [result.task]));
		const byId = new Map(shown.map((task) => [task.id, task]));
		return {
			status: "updated",
			tasks: results.map((result) => ({
				...byId.get(result.task.id)!,
				// Completing a repeating task opens the next one; reopening it can take that one back.
				...(result.next ? { nextOccurrence: byId.get(result.next.id)! } : {}),
				...(result.removedIds.length ? { removedTaskIds: result.removedIds } : {}),
			})),
		};
	},
};

const hasEdit = (item: UpdateInput) => [item.title, item.notes, item.due, item.repeat, item.starred, item.completed].some((value) => value !== undefined);
const hasMove = (item: UpdateInput) => [item.listId, item.parentTaskId, item.afterTaskId].some((value) => value !== undefined);

async function applyUpdate(context: TaskToolContext, item: UpdateInput, current: Task): Promise<TaskMutationResponse> {
	let result: TaskMutationResponse = { task: current, next: null, removedIds: [] };
	if (hasEdit(item)) {
		result = await updateTask(context.env, context.user, item.taskId, parsed(updateTaskSchema, defined({
			title: item.title,
			notes: item.notes,
			due: withZone(item.due, current.timeZone ?? zoneOf(context)),
			repeat: item.repeat,
			starred: item.starred,
			completed: item.completed,
		})));
	}
	if (hasMove(item)) {
		const moved = await moveTask(context.env, context.user, item.taskId, parsed(moveTaskSchema, defined({ listId: item.listId, parentId: item.parentTaskId, previousId: item.afterTaskId })));
		result = { ...result, task: moved.task };
	}
	return result;
}

export async function runTaskTool<K extends TaskToolName>(context: TaskToolContext, name: K, rawInput: unknown): Promise<unknown> {
	try {
		return await handlers[name](context, parsed(taskToolSchemas[name], rawInput) as Inputs[K]);
	} catch (error) {
		if (error instanceof TaskError && error.code === "MIGRATION_REQUIRED") throw new Error(MIGRATION_MESSAGE);
		throw error;
	}
}

/** The task tools as the assistant chat registers them. Email links stay inside the mailbox the assistant works in. */
export function taskChatTools(context: AgentToolContext) {
	const taskContext: TaskToolContext = { env: context.env, user: context.user, timeZone: context.timeZone, emailMailboxIds: [context.mailboxId] };
	return Object.fromEntries(TASK_TOOL_NAMES.map((name) => [name, {
		description: taskToolDescriptions[name],
		inputSchema: taskToolSchemas[name],
		execute: async (input: unknown) => runTaskTool(taskContext, name, input),
	}]));
}
