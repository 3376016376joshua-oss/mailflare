import type { TaskToolName } from "./tool-types";

/**
 * The names and MCP permissions of the task tools. No server imports here: the settings page and the
 * assistant panel read this file too.
 */

export const TASK_MCP_SCOPES = ["mcp:tasks-read", "mcp:tasks-write"] as const;
export type TaskMcpScope = (typeof TASK_MCP_SCOPES)[number];

export const TASK_TOOL_NAMES = ["list_task_lists", "list_tasks", "get_task", "create_task", "update_tasks"] as const satisfies readonly TaskToolName[];
const WRITE_TOOLS: ReadonlySet<string> = new Set<TaskToolName>(["create_task", "update_tasks"]);

export function isTaskToolName(name: string | null | undefined): name is TaskToolName {
	return (TASK_TOOL_NAMES as readonly string[]).includes(name ?? "");
}

/** The tools that change tasks; a browser showing tasks refetches after one of them ran. */
export function isTaskWriteTool(name: string | null | undefined): boolean {
	return WRITE_TOOLS.has(name ?? "");
}

export function taskToolScope(name: TaskToolName): TaskMcpScope {
	return isTaskWriteTool(name) ? "mcp:tasks-write" : "mcp:tasks-read";
}

/** Tasks belong to the key's user, not to a mailbox, so a key with only these permissions needs no mailbox. */
export function isTaskMcpScope(scope: string): scope is TaskMcpScope {
	return (TASK_MCP_SCOPES as readonly string[]).includes(scope);
}

/** Whether a key holding this MCP permission must name a mailbox: mail permissions do, calendar and task ones do not. */
export function mcpScopeNeedsMailbox(scope: string): boolean {
	return !scope.startsWith("mcp:calendar-") && !isTaskMcpScope(scope);
}
