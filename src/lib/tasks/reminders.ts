import { sendPushContent, type PushContent } from "@/lib/push/server";
import { normalizeTimeZone } from "@/lib/time/utils";
import { claimDueTaskReminders, type DueTaskReminder } from "./service";

/** Reminders claimed per pass, and passes per run: one run sends at most 1,000. */
const REMINDER_BATCH = 200;
const MAX_REMINDER_PASSES = 5;

/** Push body: when the task is due, in the zone it was entered in. A task without a time shows its date only. */
export function formatTaskReminderBody(task: Pick<DueTaskReminder, "dueDate" | "dueAt" | "timeZone">): string {
	try {
		if (task.dueAt) {
			return `Due ${new Intl.DateTimeFormat("en-US", { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: normalizeTimeZone(task.timeZone) }).format(task.dueAt)}`;
		}
		// A calendar date is the same day everywhere: format it in UTC so no zone can shift it.
		if (task.dueDate) return `Due ${new Intl.DateTimeFormat("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" }).format(new Date(`${task.dueDate}T00:00:00Z`))}`;
	} catch { /* An unreadable date falls through to the plain text. */ }
	return "Task due";
}

export function taskReminderPush(task: DueTaskReminder): PushContent {
	return {
		title: task.title.trim().slice(0, 180) || "Task",
		body: formatTaskReminderBody(task),
		tag: `task:${task.id}`,
		url: `/tasks?task=${encodeURIComponent(task.id)}`,
	};
}

/**
 * Five-minute cron (and the Node scheduler): sends a Web Push for every open task whose reminder came
 * due. A timed task reminds at its time, a task with only a date at 09:00 in its zone. The service claims
 * each task before it is returned, so overlapping runs never notify twice; before migration
 * 9000_local_tasks it returns nothing.
 */
export async function runTaskReminders(env: CloudflareEnv, now: Date, send: typeof sendPushContent = sendPushContent): Promise<void> {
	for (let pass = 1; pass <= MAX_REMINDER_PASSES; pass++) {
		const due = await claimDueTaskReminders(env, now, REMINDER_BATCH);
		for (const task of due) {
			try {
				await send(env, [task.userId], taskReminderPush(task));
			} catch (error) {
				// The task is already claimed: one failed delivery must not hold back the others.
				console.error("Task reminder push failed", task.id, error);
			}
		}
		// Fewer than a full batch means the queue is empty (stale reminders are claimed but not returned, so this can end a pass early; the next run continues).
		if (due.length < REMINDER_BATCH) return;
	}
	console.warn(`Task reminders: stopped after ${MAX_REMINDER_PASSES * REMINDER_BATCH} reminders; the rest go out on the next run`);
}
