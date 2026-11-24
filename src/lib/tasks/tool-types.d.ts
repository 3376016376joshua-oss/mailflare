import type { SessionUser } from "@/lib/auth/types";

export type TaskToolName = "list_task_lists" | "list_tasks" | "get_task" | "create_task" | "update_tasks";

export type TaskToolContext = {
	env: CloudflareEnv;
	user: SessionUser;
	/** The zone "today" and a due date without a zone are read in; defaults to the account's. */
	timeZone?: string;
	/**
	 * Mailboxes whose mail this caller may see: the assistant's selected mailbox, or the mailboxes of an
	 * MCP key that may read mail. A task's email link is shown, and `emailId` accepted, only inside them.
	 */
	emailMailboxIds: readonly string[];
};

/** A task as the tools return it: `due` and `repeat` have the shape the write tools take. */
export type ToolTask = {
	id: string;
	listId: string;
	parentTaskId: string | null;
	title: string;
	notes: string;
	status: "open" | "completed";
	completedAt: string | null;
	due: { date: string; time?: string; timeZone: string } | null;
	starred: boolean;
	repeat: { freq: "daily" | "weekly" | "monthly" | "yearly"; interval: number; until: string | null; count: number | null } | null;
	email: { id: string; subject: string; url: string } | null;
	/** Where the task opens in Mailflare. */
	url: string;
};
