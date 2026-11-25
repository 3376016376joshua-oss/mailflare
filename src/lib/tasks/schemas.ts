import { z } from "zod";
import { isValidTimeZone } from "@/lib/time/utils";
import { MAX_REPEAT_COUNT, MAX_REPEAT_INTERVAL, TASK_LIST_TITLE_MAX, TASK_NOTES_MAX, TASK_TITLE_MAX, isDateString, isTimeString } from "./task-utils";

/**
 * Input validation for the tasks service, shared by the REST routes and any tool layer built on it.
 * The length limits live in task-utils.ts, so the browser can use them without bundling zod.
 */

export { TASK_LIST_TITLE_MAX, TASK_NOTES_MAX, TASK_TITLE_MAX };

const id = z.string().min(1).max(160);
const date = z.string().refine(isDateString, "Use a date like 2026-11-30");
const time = z.string().refine(isTimeString, "Use a 24-hour time like 14:30");
const title = z.string().trim().min(1, "Enter a title").max(TASK_TITLE_MAX);
const notes = z.string().max(TASK_NOTES_MAX);

const due = z.object({
	date,
	time: time.nullish(),
	timeZone: z.string().max(80).refine(isValidTimeZone, "Unknown time zone").nullish(),
});

const repeat = z
	.object({
		freq: z.enum(["daily", "weekly", "monthly", "yearly"]),
		interval: z.number().int().min(1).max(MAX_REPEAT_INTERVAL).default(1),
		until: date.nullish(),
		count: z.number().int().min(1).max(MAX_REPEAT_COUNT).nullish(),
	})
	.refine((value) => !(value.until && value.count), "A repeat ends on a date or after a number of times, not both");

export const createTaskSchema = z.object({
	title: title.optional(),
	notes: notes.optional(),
	listId: id.optional(),
	parentId: id.nullish(),
	previousId: id.nullish(),
	due: due.nullish(),
	repeat: repeat.nullish(),
	starred: z.boolean().optional(),
	messageId: id.nullish(),
});

export const updateTaskSchema = z.object({
	title: title.optional(),
	notes: notes.optional(),
	due: due.nullish(),
	repeat: repeat.nullish(),
	starred: z.boolean().optional(),
	completed: z.boolean().optional(),
});

export const moveTaskSchema = z.object({
	listId: id.optional(),
	parentId: id.nullish(),
	previousId: id.nullish(),
});

const listTitle = z.string().trim().min(1, "Enter a list name").max(TASK_LIST_TITLE_MAX);

export const createTaskListSchema = z.object({ title: listTitle });
export const updateTaskListSchema = z.object({ title: listTitle.optional(), previousId: id.nullish() });

export const taskQuerySchema = z.object({
	listId: id.optional(),
	view: z.enum(["starred", "today", "upcoming"]).optional(),
	dueFrom: date.optional(),
	dueTo: date.optional(),
	messageId: id.optional(),
	completed: z.boolean().optional(),
});

/** The first validation message of a failed parse, for a 400 response. */
export function firstIssue(error: z.ZodError): string {
	const issue = error.issues[0];
	if (!issue) return "Invalid request";
	const path = issue.path.join(".");
	return path ? `${path}: ${issue.message}` : issue.message;
}
