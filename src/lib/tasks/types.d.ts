/**
 * The Tasks contract shared by the service, the REST API and the browser. Everything here is JSON:
 * instants are ISO 8601 strings, calendar dates are "YYYY-MM-DD". See docs/local-tasks.md.
 */

export type TaskStatus = "needs-action" | "completed";
export type TaskRepeatFreq = "daily" | "weekly" | "monthly" | "yearly";

/** "Every `interval` days/weeks/months/years", ending never, on `until`, or after `count` occurrences. */
export type TaskRepeatRule = {
	freq: TaskRepeatFreq;
	interval: number;
	/** Last date ("YYYY-MM-DD") an occurrence may fall on. */
	until: string | null;
	/** Total number of occurrences in the series. */
	count: number | null;
};

/** The rule of a repeating task plus which occurrence of the series this task is (zero-based). */
export type TaskRepeat = TaskRepeatRule & { index: number };

export type TaskList = {
	id: string;
	title: string;
	/** Rank string; lists sort ascending by it. */
	position: string;
	/** Open top-level tasks in the list. */
	openCount: number;
	createdAt: string;
	updatedAt: string;
};

export type Task = {
	id: string;
	listId: string;
	/** Set on a subtask. Nesting is one level: a parent never has a parent. */
	parentId: string | null;
	title: string;
	notes: string;
	status: TaskStatus;
	completedAt: string | null;
	/** Calendar date the task is due, in `timeZone`. null = undated. */
	dueDate: string | null;
	/** The due instant; present only when the task has a time of day. */
	dueAt: string | null;
	/** IANA zone the date and time were entered in. */
	timeZone: string | null;
	starred: boolean;
	starredAt: string | null;
	/** Rank string among siblings (same list and parent); sort ascending. */
	position: string;
	/** The email this task was made from, when the reader may still open it (`/inbox/<id>`). */
	message: { id: string; subject: string } | null;
	/** null = does not repeat. Only an open, top-level, dated task carries a rule. */
	repeat: TaskRepeat | null;
	/** Shared by every occurrence of one repeating series, including completed ones. */
	seriesId: string | null;
	createdAt: string;
	updatedAt: string;
};

/**
 * A future occurrence of a repeating task, projected for calendars. It is not a row: act on it through
 * `taskId`, the open task that carries the rule.
 */
export type TaskOccurrence = {
	/** `<taskId>@<dueDate>`, stable for React keys. */
	id: string;
	taskId: string;
	listId: string;
	title: string;
	starred: boolean;
	dueDate: string;
	dueAt: string | null;
	timeZone: string | null;
	repeatIndex: number;
};

/** Smart views across all lists; each returns open tasks only. */
export type TaskView = "starred" | "today" | "upcoming";

/** Filters of `GET /api/tasks`; they combine with AND. */
export type TaskQuery = {
	listId?: string;
	view?: TaskView;
	/** Inclusive calendar-date bounds in the viewer's time zone. With both set, `occurrences` is filled. */
	dueFrom?: string;
	dueTo?: string;
	/** Tasks made from this email. */
	messageId?: string;
	/** true = completed only, false = open only, omitted = both. */
	completed?: boolean;
};

export type TasksResponse = {
	tasks: Task[];
	/** Projected occurrences of repeating tasks; filled only for a `dueFrom`..`dueTo` query. */
	occurrences: TaskOccurrence[];
	/** More rows matched than one response carries. */
	truncated: boolean;
	/** The tasks tables do not exist yet (migration 9000_local_tasks is pending). */
	migrationRequired: boolean;
};

export type TaskListsResponse = { lists: TaskList[]; migrationRequired: boolean };

/** A due date with an optional time of day ("HH:MM"), as entered in `timeZone` (default: the user's). */
export type TaskDueInput = { date: string; time?: string | null; timeZone?: string | null };
export type TaskRepeatInput = { freq: TaskRepeatFreq; interval?: number; until?: string | null; count?: number | null };

export type CreateTaskInput = {
	/** May be omitted when `messageId` is given: the email's subject is used. */
	title?: string;
	notes?: string;
	/** Default: the parent's list, else the user's first list. */
	listId?: string;
	parentId?: string | null;
	/** The sibling to place the task after. Omitted: first for a top-level task, last for a subtask. */
	previousId?: string | null;
	due?: TaskDueInput | null;
	repeat?: TaskRepeatInput | null;
	starred?: boolean;
	messageId?: string | null;
};

/** Only the fields present change. `due: null` clears the date (and the repeat rule with it). */
export type UpdateTaskInput = {
	title?: string;
	notes?: string;
	due?: TaskDueInput | null;
	repeat?: TaskRepeatInput | null;
	starred?: boolean;
	completed?: boolean;
};

/** Google's `tasks.move`: another list, another parent (null = top level) and the sibling to follow (null = first). */
export type MoveTaskInput = { listId?: string; parentId?: string | null; previousId?: string | null };

export type TaskMutationResponse = {
	task: Task;
	/** The next occurrence created by completing a repeating task. */
	next: Task | null;
	/** Tasks deleted as a side effect (the next occurrence, when a completion is undone). */
	removedIds: string[];
};

export type CreateTaskListInput = { title: string };
export type UpdateTaskListInput = { title?: string; previousId?: string | null };

export type TaskErrorCode = "INVALID" | "NOT_FOUND" | "LAST_LIST" | "MIGRATION_REQUIRED";
