import type { McpServer } from "@modelcontextprotocol/server";
import type { McpPrincipal } from "@/lib/mcp/types";
import { isTaskWriteTool, TASK_TOOL_NAMES, taskToolScope } from "./tool-scopes";
import { runTaskTool, taskToolDescriptions, taskToolSchemas } from "./tools";

function output(value: unknown, isError = false) {
	return { content: [{ type: "text" as const, text: JSON.stringify(value) }], isError };
}

/**
 * Registers the task tools on the MCP server of a mail key. Each call needs `mcp:tasks-read` or
 * `mcp:tasks-write`. Tasks are the key owner's own, but a task can link to an email: that link is shown,
 * and accepted on create, only for the mailboxes of a key that may also read mail.
 */
export function registerTaskMcpTools(server: McpServer, env: CloudflareEnv, principal: McpPrincipal) {
	const emailMailboxIds = principal.scopes.includes("mcp:read") ? principal.mailboxIds : [];
	for (const name of TASK_TOOL_NAMES) {
		server.registerTool(name, { description: taskToolDescriptions[name], inputSchema: taskToolSchemas[name], annotations: { readOnlyHint: !isTaskWriteTool(name), destructiveHint: false, openWorldHint: false } }, async (args) => {
			if (!principal.scopes.includes(taskToolScope(name))) return output({ error: "Permission denied" }, true);
			// The same audit line as the mail and calendar tools in src/lib/mcp/server.ts.
			console.info(JSON.stringify({ audit: "mcp", tool: name, userId: principal.user.id }));
			try {
				// Titles and notes can be copied from mail, so they are marked like mail content.
				return output({ contentTrust: "untrusted_third_party_content", ...(await runTaskTool({ env, user: principal.user, emailMailboxIds }, name, args) as Record<string, unknown>) });
			} catch (error) {
				return output({ error: error instanceof Error ? error.message : "Task tool failed" }, true);
			}
		});
	}
}
