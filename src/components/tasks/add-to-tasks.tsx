"use client";

import { useCallback, useEffect, useRef } from "react";
import type { ReactNode } from "react";
import { CheckCircle2 } from "@/components/icons";
import { useCompose } from "@/components/compose/compose-context";
import { useLanguage } from "@/components/language-provider";
import { MessageActionMenuItem } from "@/components/message-actions/action-menu";
import { isTypingInInput, useShortcuts } from "@/components/shortcuts";
import { openTasksPanel, useCreateTask, useDeleteTask } from "@/lib/tasks/client";
import { taskErrorMessage } from "@/lib/tasks/format";
import { getLastTaskListId, rememberLastTaskList } from "@/lib/tasks/last-list";
import type { TaskMutationResponse } from "@/lib/tasks/types";
import { isAddToTasksShortcut, isMissingListError, messageTaskInput } from "./add-to-tasks-utils";

/**
 * "Add to tasks" on an email: a task in the last-used list, titled with the subject and linked back to
 * the message. The Tasks panel is asked to open on the new task so a date can be added, and a toast
 * offers to undo. The email itself is not changed.
 */

/** How long the "Added to tasks" toast offers Undo. */
const ADDED_NOTICE_MS = 6000;

/** The shape of an entry in the reader toolbar's `inlineActions` (message-actions.tsx). */
type ToolbarAction = { id: string; label: string; hint: string; icon: ReactNode; onSelect: () => void; group: "secondary" };

/** Returns the function that turns the email into a task. A second call while one is in flight does nothing. */
function useAddToTasks(messageId: string): () => void {
	const { t } = useLanguage();
	const { showNotice } = useCompose();
	const { mutateAsync: createTask } = useCreateTask();
	const { mutateAsync: deleteTask } = useDeleteTask();
	const busy = useRef(false);

	return useCallback(() => {
		if (busy.current) return;
		busy.current = true;
		void (async () => {
			let created: TaskMutationResponse;
			try {
				const input = messageTaskInput(messageId, getLastTaskListId());
				created = await createTask(input).catch((error: unknown) => {
					if (!isMissingListError(error, input)) throw error;
					rememberLastTaskList(null);
					return createTask(messageTaskInput(messageId, undefined));
				});
			} catch (error) {
				showNotice(taskErrorMessage(error, t), { tone: "error" });
				return;
			} finally {
				busy.current = false;
			}
			const { task } = created;
			rememberLastTaskList(task.listId);
			openTasksPanel({ taskId: task.id });
			showNotice(t("tasks.mail.added"), {
				durationMs: ADDED_NOTICE_MS,
				actions: [{
					label: t("undo.button"),
					onClick: async () => {
						try {
							await deleteTask(task.id);
							showNotice(t("tasks.mail.removed"));
						} catch (error) {
							showNotice(taskErrorMessage(error, t), { tone: "error" });
						}
					},
				}],
			});
		})();
	}, [messageId, createTask, deleteTask, showNotice, t]);
}

/**
 * The reader toolbar's "Add to tasks" action for `messageId`, shaped as an `inlineActions` entry, and the
 * Shift+T shortcut that goes with it (bound while the toolbar is mounted and shortcuts are on).
 */
export function useAddToTasksAction(messageId: string): ToolbarAction {
	const { t } = useLanguage();
	const { shortcutsEnabled } = useShortcuts();
	const addToTasks = useAddToTasks(messageId);

	// Bound here rather than through useHotkeys, which matches a single key without looking at Shift:
	// a bare "t" would add a task.
	useEffect(() => {
		if (!shortcutsEnabled) return;
		const onKeyDown = (event: KeyboardEvent) => {
			if (!isAddToTasksShortcut(event) || isTypingInInput(event.target)) return;
			if (event.target instanceof Element && event.target.closest('[role="dialog"], [role="menu"], [role="listbox"]')) return;
			// Let every other listener see the key first: "g" then Shift+T is still the "go to Sent" sequence,
			// which claims the event with preventDefault.
			setTimeout(() => {
				if (!event.defaultPrevented) addToTasks();
			}, 0);
		};
		window.addEventListener("keydown", onKeyDown);
		return () => window.removeEventListener("keydown", onKeyDown);
	}, [shortcutsEnabled, addToTasks]);

	return {
		id: "addToTasks",
		label: t("tasks.mail.add"),
		hint: t("tasks.mail.addHint"),
		icon: <CheckCircle2 size={16} />,
		onSelect: addToTasks,
		group: "secondary",
	};
}

/** "Add to tasks" for one message of a conversation, as an item of its "More actions" menu. */
export function AddToTasksMenuItem({ messageId }: { messageId: string }) {
	const { t } = useLanguage();
	const addToTasks = useAddToTasks(messageId);
	return (
		<MessageActionMenuItem icon={<CheckCircle2 className="h-4 w-4" />} onSelect={addToTasks}>
			{t("tasks.mail.add")}
		</MessageActionMenuItem>
	);
}
