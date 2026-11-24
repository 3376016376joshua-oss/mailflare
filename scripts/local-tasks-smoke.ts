/**
 * Exercises the local Tasks service (src/lib/tasks/service.ts) against any DATABASE_URL, the way
 * scripts/db-smoke.ts does for the rest of the app: the 9000_local_tasks migration, the default list,
 * ranks, subtasks, the repeat cycle, the smart views, the calendar window and the reminder claim.
 *
 *   MAILFLARE_DB_DIALECT=postgres node scripts/run-ts.mjs scripts/local-tasks-smoke.ts pglite://memory
 *   MAILFLARE_DB_DIALECT=mysql node scripts/run-ts.mjs scripts/local-tasks-smoke.ts mysql://user:pass@host/db
 *
 * Use a scratch database: it creates a user and deletes it again.
 */
import { eq } from "drizzle-orm";
import { createDb } from "@/db";
import { users } from "@/db/schema";
import { getDatabaseConfig } from "@/db/with-database";
import { openExternalDatabase } from "@/db/external";
import { applyPendingMigrations } from "@/lib/migrations/service";
import {
	claimDueTaskReminders, clearCompletedTasks, createTask, createTaskList, deleteTask, deleteTaskList, listTaskLists, listTasks, moveTask, updateTask, updateTaskList,
} from "@/lib/tasks/service";

const [url, driver] = process.argv.slice(2);
if (!url) throw new Error("usage: local-tasks-smoke <DATABASE_URL> [driver]");

const checks: Array<[string, boolean]> = [];
const check = (name: string, ok: boolean) => {
	checks.push([name, ok]);
	console.log(`${ok ? "ok  " : "FAIL"} ${name}`);
};
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

const config = getDatabaseConfig({ DATABASE_URL: url, DATABASE_DRIVER: driver } as never);
const external = openExternalDatabase(config, true);
const d1 = external as unknown as D1Database;
const env = { DB: d1 } as unknown as CloudflareEnv;
console.log(`dialect=${config.dialect} driver=${config.driver}`);

const migrated = await applyPendingMigrations(d1);
check("migrations are applied", migrated.ready);

const db = createDb(d1);
const stamp = Date.now();
const user = { id: `usr_tasks_${stamp}`, email: `tasks${stamp}@example.com`, role: "user" as const, timeZone: "UTC" };
await db.insert(users).values({ id: user.id, email: user.email, passwordHash: "x", name: "Tasks smoke" });
const now = new Date("2026-11-24T15:00:00Z");
const titles = async (query: Parameters<typeof listTasks>[2]) => (await listTasks(env, user, query, { now })).tasks.map((task) => task.title);

const [first, again] = await Promise.all([listTaskLists(env, user), listTaskLists(env, user)]);
check("default list is created once", first.lists.length === 1 && again.lists.length === 1 && first.lists[0].title === "My Tasks");
const listId = first.lists[0].id;
const home = await createTaskList(env, user, { title: "Home" });
await updateTaskList(env, user, home.id, { previousId: null, title: "House" });
check("lists reorder and rename", same((await listTaskLists(env, user)).lists.map((list) => list.title), ["House", "My Tasks"]));

const a = (await createTask(env, user, { title: "A", listId }, now)).task;
const b = (await createTask(env, user, { title: "B", listId }, now)).task;
const c = (await createTask(env, user, { title: "C", listId, previousId: a.id }, now)).task;
check("ranks order tasks", same(await titles({ listId }), ["B", "A", "C"]));
const child = (await createTask(env, user, { title: "A1", parentId: a.id }, now)).task;
await moveTask(env, user, c.id, { parentId: a.id, previousId: null }, now);
check("subtasks nest and reorder", same(await titles({ listId }), ["B", "A", "C", "A1"]) && child.parentId === a.id);
check("open counts skip subtasks", (await listTaskLists(env, user)).lists.find((list) => list.id === listId)?.openCount === 2);

await updateTask(env, user, a.id, { completed: true }, now);
check("completing a task completes its subtasks", same((await titles({ listId, completed: true })).sort(), ["A", "A1", "C"]));
check("clear completed", (await clearCompletedTasks(env, user, listId)).removed === 3 && same(await titles({ listId }), ["B"]));

const weekly = (await createTask(env, user, { title: "Weekly", listId, starred: true, due: { date: "2026-11-24", time: "16:00", timeZone: "America/New_York" }, repeat: { freq: "weekly", count: 3 } }, now)).task;
check("timed due is an instant in its zone", weekly.dueAt === "2026-11-24T21:00:00.000Z" && weekly.repeat?.count === 3);
const done = await updateTask(env, user, weekly.id, { completed: true }, now);
check("completing a repeating task creates the next occurrence", done.next?.dueDate === "2026-12-01" && done.next.dueAt === "2026-12-01T21:00:00.000Z" && done.next.repeat?.index === 1 && done.task.repeat === null);
const undone = await updateTask(env, user, weekly.id, { completed: false }, now);
check("reopening takes the next occurrence back", same(undone.removedIds, [done.next?.id]) && undone.task.repeat?.index === 0);

await createTask(env, user, { title: "Overdue", listId, due: { date: "2026-11-20" } }, now);
await createTask(env, user, { title: "Later", listId, due: { date: "2026-12-20" } }, now);
check("today view", same(await titles({ view: "today" }), ["Overdue", "Weekly"]));
check("upcoming view", same(await titles({ view: "upcoming" }), ["Later"]));
check("starred view", same(await titles({ view: "starred" }), ["Weekly"]));
const window = await listTasks(env, user, { dueFrom: "2026-11-30", dueTo: "2026-12-31" }, { now });
check("calendar window projects repeating tasks", same(window.tasks.map((task) => task.title), ["Later"]) && same(window.occurrences.map((item) => item.dueDate), ["2026-12-01", "2026-12-08"]));

const claimed = await claimDueTaskReminders(env, new Date("2026-11-24T21:00:00Z"));
check("reminder is claimed once", same(claimed.map((item) => item.title), ["Weekly"]) && (await claimDueTaskReminders(env, new Date("2026-11-24T21:01:00Z"))).length === 0);

await deleteTask(env, user, b.id);
await deleteTaskList(env, user, home.id);
check("delete task and list", !(await titles({})).includes("B") && (await listTaskLists(env, user)).lists.length === 1);

await db.delete(users).where(eq(users.id, user.id));
check("deleting the account deletes its tasks", (await listTasks(env, user, {}, { now })).tasks.length === 0);

await external.sqlExecutor.close?.();
const failed = checks.filter(([, ok]) => !ok);
console.log(failed.length ? `\n${failed.length} FAILED` : `\nall ${checks.length} checks passed`);
process.exit(failed.length ? 1 : 0);
