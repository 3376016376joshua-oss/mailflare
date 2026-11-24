import type { TranslationKey } from "@/lib/i18n/types";
import type { TaskMcpScope } from "./tool-scopes";

/** The task permissions of an MCP key, for the key dialog in Settings. */
export const TASK_MCP_KEY_SCOPES: { value: TaskMcpScope; labelKey: TranslationKey; descriptionKey: TranslationKey }[] = [
	{ value: "mcp:tasks-read", labelKey: "tasks.agent.scope.read.label", descriptionKey: "tasks.agent.scope.read.description" },
	{ value: "mcp:tasks-write", labelKey: "tasks.agent.scope.write.label", descriptionKey: "tasks.agent.scope.write.description" },
];
