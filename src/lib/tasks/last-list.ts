/**
 * The list the user last worked in, remembered per browser. Surfaces that add a task without asking
 * where it goes ("Add to tasks" on an email) put it there; surfaces that show a list call
 * `rememberLastTaskList` when the user switches to it or adds a task to it.
 *
 * The id may name a list that no longer exists (deleted here or on another device), so a caller that
 * sends it must be ready for the API's NOT_FOUND and fall back to the default list.
 */

const STORAGE_KEY = "mailflare.tasks.lastList";

/** The id of the last-used list, or undefined when none is remembered (the API then uses the first list). */
export function getLastTaskListId(): string | undefined {
	try {
		return window.localStorage.getItem(STORAGE_KEY) || undefined;
	} catch {
		// Storage can be blocked; the default list is fine.
		return undefined;
	}
}

/** Remembers `listId` as the last-used list; null or undefined forgets it. */
export function rememberLastTaskList(listId: string | null | undefined): void {
	try {
		if (listId) window.localStorage.setItem(STORAGE_KEY, listId);
		else window.localStorage.removeItem(STORAGE_KEY);
	} catch { /* not remembered */ }
}
