import type { CreateTaskInput } from "@/lib/tasks/types";

/**
 * Pure helpers behind "Add to tasks" on an email (add-to-tasks.tsx), kept apart so they run in Node tests.
 */

/**
 * What `POST /api/tasks` gets for an email: only the link and the list. No title is sent, so the service
 * uses the email's subject (trimmed, capped, "(no subject)" when empty) and the rule lives in one place.
 */
export function messageTaskInput(messageId: string, listId: string | undefined): CreateTaskInput {
	return listId ? { messageId, listId } : { messageId };
}

type ShortcutKeyEvent = Pick<KeyboardEvent, "key" | "shiftKey" | "metaKey" | "ctrlKey" | "altKey" | "repeat">;

/**
 * Shift+T and nothing else: not a bare "t" (which starts no action but ends the "g t" sequence), not a
 * Cmd/Ctrl/Alt combination (those belong to the browser), and not a key held down.
 */
export function isAddToTasksShortcut(event: ShortcutKeyEvent): boolean {
	return event.shiftKey && !event.metaKey && !event.ctrlKey && !event.altKey && !event.repeat && event.key.toLowerCase() === "t";
}

/** The request failed because the remembered list is gone (deleted here or on another device). */
export function isMissingListError(error: unknown, input: CreateTaskInput): boolean {
	return input.listId !== undefined && (error as { code?: string } | null)?.code === "NOT_FOUND";
}
