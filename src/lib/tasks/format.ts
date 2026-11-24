import { defaultTranslator } from "@/lib/i18n/utils";
import type { Translator } from "@/lib/i18n/utils";
import { formatUserDate, getUserTimeZone } from "@/lib/time/utils";
import { addDays, dateInZone, taskLocalDate } from "./task-utils";
import type { Task, TaskErrorCode, TaskRepeatRule } from "./types";

/**
 * How Tasks reads to a person: due labels, repeat descriptions and error messages, shared by every
 * Tasks surface so "Tomorrow" and "Every 2 weeks" are worded once. Strings live under `tasks.` in
 * src/lib/i18n/local/tasks-core.json.
 */

type FormatOptions = { now?: Date; timeZone?: string };

/** A calendar date for display; formatted in UTC so the date never shifts with the viewer's zone. */
function formatDate(date: string, options: Intl.DateTimeFormatOptions): string {
	return formatUserDate(new Date(`${date}T12:00:00Z`), { ...options, timeZone: "UTC" });
}

/**
 * "Today", "Tomorrow", "Yesterday", a weekday for the rest of the coming week, else "Nov 30" (with the
 * year when it is not this one); a timed task adds its time ("Tomorrow, 2:00 PM"). null for an undated task.
 */
export function formatTaskDue(task: Pick<Task, "dueDate" | "dueAt">, t: Translator = defaultTranslator, options: FormatOptions = {}): string | null {
	const timeZone = options.timeZone ?? getUserTimeZone();
	const date = taskLocalDate(task, timeZone);
	if (!date) return null;
	const today = dateInZone(options.now ?? new Date(), timeZone);
	let label: string;
	if (date === today) label = t("tasks.due.today");
	else if (date === addDays(today, 1)) label = t("tasks.due.tomorrow");
	else if (date === addDays(today, -1)) label = t("tasks.due.yesterday");
	else if (date > today && date <= addDays(today, 6)) label = formatDate(date, { weekday: "long" });
	else label = formatDate(date, date.slice(0, 4) === today.slice(0, 4) ? { month: "short", day: "numeric" } : { month: "short", day: "numeric", year: "numeric" });
	if (!task.dueAt) return label;
	return t("tasks.due.withTime", { date: label, time: formatUserDate(task.dueAt, { hour: "numeric", minute: "2-digit", timeZone }) });
}

/** A day as a heading: "Tue, Nov 24", with the year when it is not this one. */
export function formatTaskDay(date: string, options: FormatOptions = {}): string {
	const today = dateInZone(options.now ?? new Date(), options.timeZone ?? getUserTimeZone());
	return formatDate(date, { weekday: "short", month: "short", day: "numeric", ...(date.slice(0, 4) === today.slice(0, 4) ? {} : { year: "numeric" }) });
}

const EVERY = { daily: "tasks.repeat.everyDays", weekly: "tasks.repeat.everyWeeks", monthly: "tasks.repeat.everyMonths", yearly: "tasks.repeat.everyYears" } as const;

/** "Weekly", "Every 2 weeks", "Daily, until Dec 31, 2026", "Monthly, 5 times". */
export function describeTaskRepeat(repeat: TaskRepeatRule, t: Translator = defaultTranslator): string {
	const cadence = repeat.interval === 1 ? t(`tasks.repeat.${repeat.freq}`) : t(EVERY[repeat.freq], { count: repeat.interval });
	if (repeat.until) return t("tasks.repeat.until", { repeat: cadence, date: formatDate(repeat.until, { month: "short", day: "numeric", year: "numeric" }) });
	if (repeat.count !== null) return t("tasks.repeat.times", { repeat: cadence, count: repeat.count });
	return cadence;
}

const ERROR_KEYS: Partial<Record<TaskErrorCode | "UNKNOWN", "tasks.error.migrationRequired" | "tasks.error.notFound" | "tasks.error.lastList">> = {
	MIGRATION_REQUIRED: "tasks.error.migrationRequired",
	NOT_FOUND: "tasks.error.notFound",
	LAST_LIST: "tasks.error.lastList",
};

/**
 * What to tell the user when a tasks request failed (a `TaskRequestError` from the hooks). Invalid input
 * shows the API's own sentence; anything unexpected falls back to `fallback`.
 */
export function taskErrorMessage(error: unknown, t: Translator = defaultTranslator, fallback: "tasks.error.saveFailed" | "tasks.error.loadFailed" = "tasks.error.saveFailed"): string {
	const { code, message } = (error ?? {}) as { code?: TaskErrorCode | "UNKNOWN"; message?: string };
	const key = code ? ERROR_KEYS[code] : undefined;
	if (key) return t(key);
	return code === "INVALID" && message ? message : t(fallback);
}
