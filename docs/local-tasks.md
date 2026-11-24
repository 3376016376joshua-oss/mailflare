# Tasks (local fork): the foundation contract

Tasks is a feature of this local copy of Mailflare, not of upstream. This page is the contract of its foundation layer: the data model, the service, the REST API, and the browser hooks and events that every Tasks surface builds on. The surfaces themselves (the `/tasks` app, the side panel in Mail and Calendar, "Add to tasks" on an email, tasks in the calendar) are built on top of it and are not described here. Reminders and the assistant and MCP tools have no screen of their own; they are described at the end of this page.

If you build on this layer: use the service on the server and the hooks in the browser. Do not query `local_tasks` yourself and do not call `/api/tasks` with your own `fetch`, or your surface will drift from the others.

## Where things are

| Path | What it holds |
| --- | --- |
| `src/db/schema/index.ts` (`taskLists`, `tasks`) | The two tables |
| `drizzle/migrations*/9000_local_tasks.sql` | Their migration, one per dialect |
| `src/lib/tasks/types.d.ts` | Every JSON shape (`Task`, `TaskList`, `TaskQuery`, inputs, responses) |
| `src/lib/tasks/task-utils.ts` | Pure helpers for server and browser: ranks, dates, due and reminder derivation, the repeat rule, sorting, `buildTaskTree` |
| `src/lib/tasks/schemas.ts` | zod input schemas, shared by the routes and any tool layer |
| `src/lib/tasks/service.ts` | Every query and rule. Server only |
| `src/app/api/tasks/**` | The REST routes, thin wrappers over the service |
| `src/lib/tasks/client.ts` | Browser: REST calls, TanStack Query hooks, window events |
| `src/lib/tasks/cache-utils.ts` | Optimistic cache updates behind the hooks |
| `src/lib/tasks/last-list.ts` | The last-used list, remembered per browser |
| `src/lib/tasks/format.ts` | Due labels, repeat descriptions, error messages |
| `src/lib/tasks/reminders.ts` | The reminder run of the cron: claims due reminders from the service and sends the Web Push |
| `src/lib/tasks/tools.ts`, `tool-scopes.ts`, `tool-types.d.ts` | The assistant and MCP tools: schemas, descriptions, `runTaskTool`, names and MCP scopes |
| `src/lib/tasks/mcp.ts`, `tool-labels.ts` | MCP registration; the task permissions shown in the key dialog |
| `src/lib/i18n/local/*.json`, `scripts/local-i18n.mjs` | Local strings and the script that writes them into all catalogs |
| `tests/local-tasks.test.mjs`, `tests/local-tasks-client.test.mjs`, `tests/local-i18n.test.mjs` | Node tests: helpers and service on SQLite, cache updates and hooks in jsdom, catalogs in step with the fragments |
| `tests/local-tasks-tools.test.mjs`, `tests/local-tasks-reminders.test.mjs` | Node tests of the tools and MCP permissions, and of the reminder run, on SQLite |
| `tests/e2e/local-tasks-api.spec.ts` | Playwright spec of the REST API against a running instance |
| `scripts/local-tasks-smoke.ts` | Runs the service against any `DATABASE_URL` (PostgreSQL, MySQL, a SQLite file) |

## Data model

Two tables, owned per user like `calendar_events`. Nothing is shared between users. Deleting a user deletes their lists and tasks (cascade).

**`local_task_lists`**: `id`, `user_id`, `title`, `position`, `created_at`, `updated_at`.

**`local_tasks`**:

| Column | Meaning |
| --- | --- |
| `id`, `user_id`, `list_id` | Identity and ownership. Deleting a list deletes its tasks |
| `parent_id` | Set on a subtask. One level only: a parent never has a parent. Not a foreign key (a restore inserts rows in table order, where a subtask can precede its parent); the service deletes subtasks with their parent |
| `title`, `notes` | Up to 1024 and 8192 characters |
| `status`, `completed_at` | `needs-action` or `completed` (the iCalendar VTODO words) |
| `due_date` | Calendar date `YYYY-MM-DD` in `time_zone`. null means undated. A date-only task keeps its date in every time zone |
| `due_at` | The due instant. Set only when the task has a time of day |
| `time_zone` | IANA zone the date and time were entered in |
| `remind_at`, `reminded_at` | When the reminder is due, and when the cron claimed it. Derived on every write, see below |
| `starred_at` | null means not starred. Also the "recently starred" order |
| `position` | Rank string among siblings (same list and parent). Sort ascending |
| `message_id` | The email the task was made from. Set to null when that mail is purged |
| `repeat_freq`, `repeat_interval`, `repeat_until`, `repeat_count` | The repeat rule: every N `daily` / `weekly` / `monthly` / `yearly`, ending never, on a date, or after a total number of occurrences |
| `repeat_anchor_day` | Day of month the series runs on, so a series started on the 31st goes Jan 31, Feb 28, Mar 31 |
| `repeat_index`, `series_id` | Which occurrence of its series a task is (zero-based), and the id all occurrences of the series share |

Rules the service enforces:

- **Lists.** The first read creates "My Tasks", so a user always has a list. The last list cannot be deleted.
- **Order.** `position` is a fractional rank (`rankBetween` in `task-utils.ts`): a move rewrites one row. Ranks use digits and lowercase letters only, so SQLite, PostgreSQL and MySQL sort them the same way. A new top-level task goes first in its list, a new subtask goes last.
- **Subtasks.** One level. A subtask lives in its parent's list, cannot repeat, and cannot be added to a completed task. A task that has subtasks cannot become a subtask.
- **Completing** a task completes its open subtasks. Reopening it leaves them as they were. Reopening a subtask whose parent is still completed moves the subtask to the top level of the list.
- **Reminders.** `remind_at` is the due instant of a timed task, or 09:00 on the due date in the task's zone for a date-only task. It is left null when that moment has already passed at the time of the write, and re-derived (with `reminded_at` cleared) whenever the due date changes or the task is reopened.
- **Repeating tasks.** A repeating task is one open row that carries the rule. Completing it marks that row completed and inserts the next occurrence as a new row, which takes over the rule (`repeat_index` advanced, same `series_id`, same time of day, placed right below the completed one). Occurrences whose date already passed are skipped but still count towards `repeat_count`, so completing a daily task after a week away brings up today's occurrence. When the series has ended no row is inserted and the completed row keeps the rule. Reopening a completed occurrence deletes its next occurrence and takes the rule back, as long as that next occurrence is untouched (never edited, no subtasks, still the newest of the series); otherwise the reopened task becomes a plain task. Changing the due date of a repeating task moves the series with it; setting a rule restarts the count at the current occurrence; clearing the due date clears the rule.
- **iCalendar mapping.** `repeatToRRule` in `task-utils.ts` turns the rule of an open task into an RRULE for a VTODO whose DUE is the task's due date (`FREQ`, `INTERVAL`, `UNTIL` or the remaining `COUNT`, and `BYMONTHDAY=28,29,30,31;BYSETPOS=-1` style clamping for month ends). Completed occurrences are plain rows with the series id.

## Service (`src/lib/tasks/service.ts`)

Every function takes `env` and a `TaskUser` (`{ id, email, role, timeZone }`; `timeZone` is the zone "today" is computed in and the default zone of a due date).

| Function | Purpose |
| --- | --- |
| `listTaskLists` | Lists in order, each with `openCount` (open top-level tasks) |
| `createTaskList`, `updateTaskList`, `deleteTaskList` | Add, rename and reorder (`previousId`), delete with tasks |
| `clearCompletedTasks(listId)` | Delete the completed tasks of a list |
| `listTasks(query, { now?, timeZone? })` | The one read, see "Queries" |
| `getTask(id)` | One task or null |
| `createTask(input)`, `updateTask(id, input)`, `moveTask(id, input)`, `deleteTask(id)` | Writes, see the API below |
| `claimDueTaskReminders(env, now, limit?)` | For the reminder cron: open tasks whose reminder came due, each claimed with a conditional update so overlapping runs never return a task twice. The caller sends the push. Reminders that came due more than a day ago are claimed and dropped |

Errors are `TaskError` with a `code`: `INVALID` (broken rule, the message says which), `NOT_FOUND` (missing or someone else's), `LAST_LIST`, `MIGRATION_REQUIRED`.

**Before the migration is applied** (deploys ship before migrations here) nothing throws a database error: reads answer empty with `migrationRequired: true`, `getTask` answers null, `claimDueTaskReminders` answers `[]`, and writes throw `TaskError("MIGRATION_REQUIRED")`.

**Email links.** `createTask({ messageId })` requires that the user can read that message (mailbox access and the private-draft rule), and uses its subject when no title is given. On read, `task.message` is `{ id, subject }` only while the user can still read the mail; open it at `/inbox/<id>`, which works for every folder.

## REST API

Session auth only (cookie or the app's bearer session token); cookie mutations are origin-checked like every other session route. There are no API-key scopes yet. Failures are `{ "error": "...", "code": "INVALID" | "NOT_FOUND" | "LAST_LIST" | "MIGRATION_REQUIRED" }` with status 400, 404, 409, 409, and `{ "error": "Unauthorized" }` with 401.

| Route | Body or query | Answers |
| --- | --- | --- |
| `GET /api/tasks/lists` | | `{ lists: TaskList[], migrationRequired }` |
| `POST /api/tasks/lists` | `{ title }` | 201 `{ list }` |
| `PATCH /api/tasks/lists/:id` | `{ title?, previousId? }` (`previousId: null` = first) | `{ list }` |
| `DELETE /api/tasks/lists/:id` | | `{ ok: true }` |
| `POST /api/tasks/lists/:id/clear` | | `{ removed }` |
| `GET /api/tasks` | see "Queries" | `{ tasks, occurrences, truncated, migrationRequired }` |
| `POST /api/tasks` | `CreateTaskInput` | 201 `{ task, next: null, removedIds: [] }` |
| `GET /api/tasks/:id` | | `{ task }` |
| `PATCH /api/tasks/:id` | `UpdateTaskInput` | `{ task, next, removedIds }` |
| `POST /api/tasks/:id/move` | `{ listId?, parentId?, previousId? }` | `{ task, next: null, removedIds: [] }` |
| `DELETE /api/tasks/:id` | | `{ removedIds }` (the task and its subtasks) |

**Create** (`CreateTaskInput`): `title` (optional when `messageId` is given), `notes`, `listId` (default: the parent's list, else the first list), `parentId`, `previousId` (the sibling to follow; `null` = first), `due`, `repeat`, `starred`, `messageId`.

**Update** (`UpdateTaskInput`): only the fields sent change. `title`, `notes`, `due`, `repeat`, `starred`, `completed`.

- `due` is `{ date: "YYYY-MM-DD", time?: "HH:MM", timeZone? }`, or `null` to clear it. Send `timeZone` (the browser's, `getUserTimeZone()`); without it an edit keeps the task's zone and a new task uses the account's.
- `repeat` is `{ freq, interval?, until?, count? }` (`until` or `count`, not both), or `null` to stop repeating. It needs a due date.
- `completed: true` on a repeating task answers `next`, the occurrence that follows. `completed: false` may answer `removedIds`, the next occurrence it took back.

**Move** is Google's `tasks.move`: `listId` moves to another list (subtasks follow their parent; a subtask moved alone becomes a top-level task there), `parentId` nests under a task or (`null`) returns to the top level, `previousId` is the sibling to follow (`null` or omitted = first).

### Queries

`GET /api/tasks` filters combine with AND:

| Parameter | Meaning |
| --- | --- |
| `listId` | One list |
| `view=starred` | Open starred tasks across all lists, most recently starred first |
| `view=today` | Open tasks across all lists due today or overdue |
| `view=upcoming` | Open tasks across all lists due after today |
| `dueFrom`, `dueTo` | Inclusive dates. With both (at most 370 days apart), `occurrences` is filled |
| `messageId` | Tasks made from that email |
| `completed=1` / `completed=0` | Completed only / open only. Omitted: both |

- **Time zone.** "Today" and the date a timed task falls on are computed in the viewer's zone: the account's saved zone, else the `X-Time-Zone` header that `authFetch` sends. A task at 23:30 New York time is tomorrow's task in Berlin. In the browser use `taskLocalDate(task, getUserTimeZone())` to place a task on a day; do not read `dueDate` of a timed task for that.
- **Order.** A list reads top to bottom: each open task followed by its open subtasks, then completed tasks, most recent first. Date queries read by due date (date-only before timed within a day), open before completed. `sortTasksForQuery` is the same order for the browser.
- **Calendar window.** `dueFrom` + `dueTo` returns the tasks due in the window (completed ones too unless `completed=0`) in `tasks`, and in `occurrences` the future occurrences of open repeating tasks that fall in the window. An occurrence is a projection, not a row: `{ id: "<taskId>@<date>", taskId, listId, title, starred, dueDate, dueAt, timeZone, repeatIndex }`. Show it, and act on `taskId` (the open task of the series). The current occurrence of a series is the task itself and is not repeated in `occurrences`.
- **Limits.** One response carries at most 2000 tasks (open first, then the most recently completed) and sets `truncated` beyond that; at most 1000 occurrences.

## Browser (`src/lib/tasks/client.ts`)

All Tasks surfaces share one TanStack Query cache (the client is already mounted app-wide in `src/components/providers.tsx`), so a change made in one place shows in the others in the same frame.

**Reading**

| Hook | Returns |
| --- | --- |
| `useTaskLists()` | `data: { lists, migrationRequired }` |
| `useTasks(query, { enabled? })` | `data: { tasks, occurrences, truncated, migrationRequired }` for a `TaskQuery` (`{ listId }`, `{ view: "today" }`, `{ dueFrom, dueTo }`, `{ messageId }`, with optional `completed`) |
| `useTask(id)` | One task, shown at once from whatever query already loaded it |

`buildTaskTree(tasks)` groups a flat response into top-level tasks with `subtasks`. When `migrationRequired` is true, show the `tasks.error.migrationRequired` text instead of an empty list.

**Writing**

| Hook | `mutate` argument |
| --- | --- |
| `useCreateTask()` | `CreateTaskInput` |
| `useUpdateTask()` | `{ id, ...UpdateTaskInput }` |
| `useMoveTask()` | `{ id, listId?, parentId?, previousId? }` |
| `useDeleteTask()` | `id` |
| `useCreateTaskList()`, `useUpdateTaskList()`, `useDeleteTaskList()` | `{ title }`, `{ id, title?, previousId? }`, `id` |
| `useClearCompletedTasks()` | `listId` |

Every mutation is optimistic: the change is applied to every cached query where it is visible (a completed task leaves Today, a starred task enters Starred, counts in the list nav follow), rolled back if the request fails, and followed by one refetch once no other task mutation is in flight. The hooks do not show toasts; pass `onError` and use `taskErrorMessage(error, t)`. Errors are `TaskRequestError` with the API's `code` and the HTTP `status`.

A task or list created optimistically has a temporary id until the server answers. Check `isPendingId(id)` and do not edit, move or delete such a row (disable its controls for that moment).

For code that cannot use hooks, `tasksApi` has the same calls as plain functions; after a write made that way call `notifyTasksChanged()`.

**Window events**

| Event | Detail | Use |
| --- | --- | --- |
| `mailflare:tasks-changed` (`TASKS_CHANGED_EVENT`) | none | Sent after every mutation by the hooks. Call `notifyTasksChanged()` when tasks changed some other way (an assistant tool ran, a plain `fetch`); the hooks then refetch. Listen with `onTasksChanged(fn)` in code that shows tasks without the hooks. Other tabs of the same browser are told through a `BroadcastChannel` and refetch too |
| `mailflare:tasks-open-panel` (`TASKS_OPEN_PANEL_EVENT`) | `{ taskId?, listId?, view?, date? }` | Asks the Tasks side panel to open, on a list, on a smart view (`view: "today"` is what the calendar's pending-tasks chip sends), on the tasks due one day (`date: "YYYY-MM-DD"` in the viewer's zone, what the calendar's "N tasks" chip sends) or with a task in focus. The first of `taskId`, `listId`, `view`, `date` that is set wins. `view` and `date` are hints: a panel without smart views just opens. Send with `openTasksPanel(detail)`; the panel listens with `onTasksOpenPanel(fn)`. Nothing happens on pages that do not mount the panel |

The hooks also listen to Mail's own `mailflare:messages-changed`: when mail is deleted for good (the event says `action: "delete"`, or carries no detail at all, as emptying Trash does) they refetch, so the email chip of a purged message goes away at once instead of at the next refetch.

**Last-used list** (`last-list.ts`): `getLastTaskListId()` is where a surface that does not ask puts a new task: "Add to tasks" on an email, and the "Add a task" box of Starred, Today, Upcoming or a day. A surface that shows a list calls `rememberLastTaskList(listId)` when the user switches to it or adds a task to it. It is one `localStorage` entry, so the id can name a list that is gone: a surface that has the lists checks it against them and falls back to the first list (`listForNewTask` in `task-view-utils.ts`), and one that does not retries a create that fails with `NOT_FOUND` without `listId`.

**Display helpers** (`format.ts`): `formatTaskDue(task, t)` ("Today", "Tomorrow", "Friday", "Nov 30", plus the time of a timed task), `describeTaskRepeat(repeat, t)` ("Weekly", "Every 2 weeks, 5 times"), `taskErrorMessage(error, t, fallback?)`. `isTaskOverdue(task, now, timeZone)` and `compareTasksByDue` are in `task-utils.ts`.

## Screens

The `/tasks` app and the side panel are built from the same parts in `src/components/tasks/`. Reuse them rather than drawing tasks again.

| Part | What it is |
| --- | --- |
| `TaskListView` (`task-list-view.tsx`) | The tasks of one list, smart view or day (`scope`): the "Add a task" box, the open tasks, the collapsed Completed section (a list and a day have one). A day (`{ kind: "date", date }`) lists the tasks due that date across all lists in the order of the day, with the coming occurrences of repeating tasks among them (`TaskOccurrenceRow`); a task added there is due that day. In a list, tasks are dragged by their handle to reorder and to nest one level (a step to the right nests); with the handle focused the arrow keys do the same (up, down, right = make a subtask, left = back to the top level). `focusTaskId` scrolls to a task and puts the cursor in it |
| `TaskRow`, `CompletedTaskRow`, `TaskAddRow` | One task: checkbox, title and notes edited in place, due date, repeat rule and email as chips, star, menu. The email chip opens `/inbox/<messageId>` |
| `TaskScheduleDialog` | Date, optional time, and the repeat rule (every N days / weeks / months / years; ends never, on a date, or after N times). It sends only what changed |
| `TasksPanel`, `TasksPanelToggle` (`tasks-panel.tsx`) | The side panel and its header button. The panel listens for `mailflare:tasks-open-panel` and starts on the last-used list |
| `useTaskActions`, `useTaskListActions` | The mutation hooks wired to error toasts |
| `task-order-utils.ts`, `task-view-utils.ts` | The pure rules: where a dragged task lands, the sections of a smart view, the rows of a day, the list a task added outside a list goes to, what the schedule form sends |

- **Addresses.** `/tasks` shows the first list, `/tasks?list=<id>` a list, `/tasks?view=starred|today|upcoming` a smart view, `/tasks?date=YYYY-MM-DD` the tasks due that day (no menu entry leads there; the panel's "Open in Tasks" does when it shows a day). `/tasks?task=<id>` opens the list that holds the task with the cursor in it; use it for links to a task (`taskScopeHref` builds all of them).
- **One dock, one panel.** Mail and Calendar share the right-hand dock between the Assistant and Tasks: `useDashboardState` answers `tasksOpen` / `setTasksOpen` next to the Assistant's state, opening either closes the other, and the choice is remembered like the Assistant's. Below 640px the header has no room for the Tasks button, so it is hidden there; the panel still opens on `openTasksPanel(...)` and covers the page like the Assistant, and the Tasks app is in the apps menu. While either panel is open, Mail hides its phone Compose button, which would otherwise sit on top of the panel.
- **Crowded tasks on the calendar.** In the week and day views a timed task is a chip at its time, and tasks whose chips would overlap share the row. When the column is too narrow for that (each chip under `MIN_TIMED_CHIP_WIDTH`, 56px, in `layoutTimedTasks`, which is given the measured column width), the tasks of a time slot merge into one "N tasks" chip (`CalendarTaskGroupChip`). It asks the panel for that day (`openTasksPanel({ date })`). A wide column, such as the day view's, keeps the tasks apart.
- **Create button.** `focusTaskAddRow()` puts the cursor in the "Add a task" box of the list on screen. A list that was just created opens with the cursor there too: its creator calls `focusTaskAddRowOnOpen(listId)` before showing it.
- **Tests.** `tests/local-tasks-ui.test.mjs` (the pure rules) and `tests/e2e/local-tasks-ui.spec.ts` (the screens, run like the API spec below).

## Reminders

`runTaskReminders(env, now)` (`src/lib/tasks/reminders.ts`) runs beside `runCalendarReminders`: on Workers from the five-minute cron in `worker.ts`, in the self-hosted runtime from `server/runtime/scheduler.ts` every minute. It asks the service for `claimDueTaskReminders` in batches of 200 until none are left (at most 1,000 per run) and sends one notification per task with `sendPushContent`:

| Field | Value |
| --- | --- |
| `title` | The task title |
| `body` | "Due Mon, Nov 30, 2:00 PM" in the task's zone, or "Due Mon, Nov 30" for a task without a time |
| `tag` | `task:<id>`, so a repeated notification for the same task replaces the earlier one |
| `url` | `/tasks?task=<id>`, opened when the notification is clicked |

- **When.** A timed task reminds at its time, a task with only a date at 09:00 in its zone (`remind_at`, see the data model). Completed tasks and tasks without a date never remind. A reminder is sent once: a task is claimed before its push is sent, so overlapping runs cannot notify twice and a push that fails is not retried.
- **Web Push only**, like calendar reminders: the user needs notifications enabled in a browser or the installed app, and the installation needs the VAPID keys (`docs/deployment.md`, "Optional Web Push configuration"). Without them the run still claims the reminders and sends nothing. Native APNs push is not wired to tasks.
- The notification text is English, like the calendar's.

## Assistant and MCP tools

One tool layer (`src/lib/tasks/tools.ts`, shaped like `src/lib/calendar/tools.ts`) serves the in-app assistant and the MCP server. Every tool goes through the service, so it follows the rules above.

| Tool | Permission | What it does |
| --- | --- | --- |
| `list_task_lists` | read | The user's lists with `openTaskCount` |
| `list_tasks` | read | Tasks of one list or all lists; `view` (`starred`, `today` including overdue, `upcoming`), `dueFrom` / `dueTo`, `status` (`open` by default, `completed`, `all`), `limit` (100 by default, at most 500). With both dates it also returns `upcomingOccurrences` of repeating tasks |
| `get_task` | read | One task with its `subtasks` |
| `create_task` | write | `title` (optional with `emailId`), `notes`, `listId`, `parentTaskId`, `due`, `repeat`, `starred`, `emailId` |
| `update_tasks` | write | Up to 20 tasks per call: `title`, `notes`, `due` (null clears), `repeat` (null stops), `starred`, `completed`, and moves with `listId`, `parentTaskId` (null = top level), `afterTaskId` (null or omitted = first) |

- **A task in a tool result** is `{ id, listId, parentTaskId, title, notes, status: "open" | "completed", completedAt, due, starred, repeat, email, url }`. `due` is `{ date, time?, timeZone }` and `repeat` is `{ freq, interval, until, count }`, the shapes the write tools take, so a result can be sent back. `url` is `/tasks?task=<id>`.
- **Writes apply at once**, like `create_event`: there is no approval step, because every change can be undone in the app. There is no delete tool; deleting stays a human action.
- **`update_tasks` is not atomic.** All ids are checked first, then the updates are applied in order. When one fails on a rule only the service knows, the error names that task and how many earlier updates were applied.
- **Time zone.** A due date without `timeZone` is read in the zone of the chat (the browser's), else the account's; an edit keeps the zone the task already has.
- **Email links.** `emailId` links the task to an email (the assistant is told which email is open). A tool may link, and is shown the linked email of, mail in its own mailboxes only: the mailbox the assistant is working in, or the mailboxes of an MCP key that also holds **Read mail**. Elsewhere `email` is null and `emailId` answers "Email not found", so a key for tasks alone never learns a subject through a link.
- **Before the migration** every tool answers that Tasks need a database update.

**Assistant.** `taskChatTools(context)` is added to the chat's tools in `src/lib/agent/chat.ts`, with one sentence in the system prompt (`src/lib/agent/model.ts`). When a `create_task` or `update_tasks` call finishes, the assistant panel calls `notifyTasksChanged()`, so every open Tasks surface refetches. The panel's text for each tool is `tasks.agent.tool.<name>.*`; `src/components/agent/utils.ts` lists the tool names again (it cannot import them), and a test keeps the two lists equal.

**MCP.** `registerTaskMcpTools` (`src/lib/tasks/mcp.ts`) registers the tools for user keys. They need the permissions `mcp:tasks-read` (**Read tasks**) and `mcp:tasks-write` (**Manage tasks**), chosen when a key is created in **Settings → API keys** with **Allow MCP access**. A key with only task (or calendar) permissions needs no mailbox (`mcpScopeNeedsMailbox`). Results carry `contentTrust: "untrusted_third_party_content"`, because titles and notes can be copied from mail, and every permitted call writes the same audit line as the mail tools.

## Source code link

Mailflare is AGPL-3.0, and this copy is modified, so everyone who uses it over the network is offered its source (section 13). `SourceCodeLink` (`src/components/source-code-link.tsx`) renders a "Source code" link in the sidebar footer next to "Powered by" (Mail, Settings, Admin, Drive, Tasks), in the account menu (every signed-in page, including Calendar and Tasks), on the sign-in pages and the landing page, and on the public booking and shared-file pages. A new shell or public page should include it.

The address is one value, `SOURCE_CODE_URL`: `vars` in `wrangler.jsonc` on Workers, an environment variable when self-hosted. It defaults to `https://github.com/3376016376joshua-oss/mailflare` (`src/lib/source-code.ts`); anything that is not an http(s) URL falls back to the default. The root layout reads it once per request and hands it to the links. Point it at the repository that holds the code actually deployed.

## Strings

All Tasks strings use the key prefix `tasks.` (other local features: `local.`). Do not edit the 34 catalogs by hand:

1. Put the English text in a fragment under `src/lib/i18n/local/`, one file per work stream (for example `tasks-app.json`), using its own sub-prefix (`tasks.app.`, `tasks.panel.`, `tasks.mail.`, `tasks.calendar.`, `tasks.reminder.`, `tasks.agent.`).
2. Run `node scripts/local-i18n.mjs`. It writes every fragment key into `src/lib/i18n/en.json` and each `public/locales/*.json` (English text in every language), always at the end of the file and in fragment order.
3. Commit the fragment and the catalogs. `tests/local-i18n.test.mjs` fails when they are out of step.

Because the catalogs are generated from the fragments, a merge conflict in a catalog (two branches adding strings, or an upstream release) is resolved by keeping either side and running the script again. A key removed from a fragment has to be removed from the catalogs by hand.

Shared keys already exist in `tasks-core.json`: `tasks.title`, `tasks.view.*` (Today, Upcoming, Starred), `tasks.action.*` (add, addSubtask, complete, reopen, star, unstar, delete), `tasks.due.*`, `tasks.repeat.*`, `tasks.error.*`. Plural keys follow the catalog convention (`key.one`, `key.other`, called as `t("key", { count })`).

## Keeping the fork cheap

- New code goes in new files. Hooks into upstream files stay one line where possible.
- The tables are prefixed `local_` and the migration is named `9000_local_tasks.sql`, so neither can collide with an upstream table or migration. The migration only creates the two tables.
- The backup lists are extended on separate lines (`src/lib/backups/local-tables.ts`, pushed into `BACKUP_TABLES`, `LATER_MIGRATION_TABLES` and the "mail" group), so upstream edits to those long lists do not conflict. Only the `DatabaseBackupTable` union in `src/lib/backups/types.d.ts` gains a member on an upstream line.
- `src/lib/migrations/bundle*.json` are generated: after any migration change or merge run `npm run db:bundle`, never edit them.

## Operating it

- **Before deploying.** Check that `SOURCE_CODE_URL` in `wrangler.jsonc` names the repository holding the code you deploy. For task reminders, the VAPID keys must be set (the same ones mail notifications use).
- **Deploy.** Ship the code, then apply `9000_local_tasks.sql` from Admin (the "Update database" step, or `POST /api/admin/migrations`). Until then Tasks reads empty and writes answer 409 `MIGRATION_REQUIRED`; the rest of the app, including backups, is unaffected.
- **Backups** include both tables once they exist. A backup taken before the migration restores fine after it.
- **Rollback to unmodified upstream.** The unmodified app refuses to run migrations or backups while these tables and the ledger row exist. Remove them first: `DROP TABLE local_tasks; DROP TABLE local_task_lists;` and delete the row named `9000_local_tasks.sql` from the migration ledger (`d1_migrations` on D1 and SQLite, `mailflare_migrations` on PostgreSQL and MySQL).
- **Checks.** `npm run lint`, `npx tsc --noEmit`, `node --test tests/*.test.mjs`, `npm run build`. Against a disposable running instance: `PLAYWRIGHT_BASE_URL=http://localhost:3002 npx playwright test tests/e2e/local-tasks-api.spec.ts` (see `tests/e2e/README.md`; it resets the demo account). Against another database: `MAILFLARE_DB_DIALECT=postgres node scripts/run-ts.mjs scripts/local-tasks-smoke.ts pglite://memory`, or `MAILFLARE_DB_DIALECT=mysql ... mysql://user:pass@host/scratch`.
