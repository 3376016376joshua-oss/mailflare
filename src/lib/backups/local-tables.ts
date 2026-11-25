import type { LocalBackupTable } from "./types";

/**
 * Tables added by the local fork rather than upstream Mailflare, in foreign-key order. They are appended
 * to the backup lists in export.ts and table-groups.ts on separate lines, so merging an upstream release
 * that adds its own tables to those long lists does not conflict.
 */
export const LOCAL_BACKUP_TABLES: LocalBackupTable[] = ["local_task_lists", "local_tasks"];
