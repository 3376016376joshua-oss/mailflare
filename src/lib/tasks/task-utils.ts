import { dateFromZonedFields, normalizeTimeZone, zonedDateFields } from "@/lib/time/utils";
import type { Task, TaskQuery, TaskRepeatFreq, TaskRepeatRule } from "./types";

/**
 * Pure helpers shared by the tasks service (server) and the tasks UI (browser): rank strings for manual
 * ordering, calendar-date arithmetic, due and reminder derivation, and the repeat rule.
 * Nothing here touches the database or the DOM.
 */

// ---- Rank strings (fractional indexing) ----
//
// A task's `position` is a string that sorts between its neighbours, so a drag is one row update and
// nothing is renumbered. The alphabet is digits and lowercase letters only: SQLite's binary collation,
// PostgreSQL's locale collations and MySQL's case-insensitive default all order those the same way.
//
// A rank is an integer part followed by an optional fraction. The first character says how long the
// integer part is ("i" = 1 more digit ... "z" = 18 more; "h" = 1 more ... "0" = 18 more for the
// ranks below "i0"), so adding at either end of a list counts up or down instead of growing the string.

const DIGITS = "0123456789abcdefghijklmnopqrstuvwxyz";
const BASE = DIGITS.length;
const HALF = BASE / 2;
const FIRST_RANK = "i0";
const SMALLEST_INTEGER = `0${"0".repeat(HALF)}`;

function integerLength(head: string): number {
	const index = DIGITS.indexOf(head);
	if (index < 0) throw new Error(`Invalid rank: ${head}`);
	return index >= HALF ? index - HALF + 2 : HALF - index + 1;
}

function integerPart(rank: string): string {
	const length = integerLength(rank[0] ?? "");
	if (rank.length < length) throw new Error(`Invalid rank: ${rank}`);
	return rank.slice(0, length);
}

/** A fraction strictly between `a` and `b` ("" is zero, null is one); fractions never end in "0". */
function midpoint(a: string, b: string | null): string {
	if (b !== null) {
		let shared = 0;
		while ((a[shared] ?? "0") === b[shared]) shared += 1;
		if (shared > 0) return b.slice(0, shared) + midpoint(a.slice(shared), b.slice(shared));
	}
	const low = a ? DIGITS.indexOf(a[0]) : 0;
	const high = b !== null ? DIGITS.indexOf(b[0]) : BASE;
	if (high - low > 1) return DIGITS[Math.round((low + high) / 2)];
	if (b !== null && b.length > 1) return b.slice(0, 1);
	return DIGITS[low] + midpoint(a.slice(1), null);
}

function incrementInteger(value: string): string | null {
	const head = value[0];
	const digits = value.slice(1).split("");
	for (let index = digits.length - 1; index >= 0; index -= 1) {
		const next = DIGITS.indexOf(digits[index]) + 1;
		if (next < BASE) {
			digits[index] = DIGITS[next];
			return head + digits.join("");
		}
		digits[index] = "0";
	}
	if (head === "z") return null;
	const nextHead = DIGITS[DIGITS.indexOf(head) + 1];
	// Past "h" the integer part grows by a digit; below it, it shrinks towards "i0".
	if (DIGITS.indexOf(nextHead) > HALF) digits.push("0");
	else if (DIGITS.indexOf(nextHead) < HALF) digits.pop();
	return nextHead + digits.join("");
}

function decrementInteger(value: string): string | null {
	const head = value[0];
	const digits = value.slice(1).split("");
	for (let index = digits.length - 1; index >= 0; index -= 1) {
		const next = DIGITS.indexOf(digits[index]) - 1;
		if (next >= 0) {
			digits[index] = DIGITS[next];
			return head + digits.join("");
		}
		digits[index] = "z";
	}
	if (head === "0") return null;
	const nextHead = DIGITS[DIGITS.indexOf(head) - 1];
	if (DIGITS.indexOf(nextHead) < HALF - 1) digits.push("z");
	else if (DIGITS.indexOf(nextHead) >= HALF) digits.pop();
	return nextHead + digits.join("");
}

/**
 * A rank that sorts strictly between `before` and `after`. Pass null for an open end: `(null, first)`
 * goes above the first row, `(last, null)` below the last, `(null, null)` starts an empty list.
 */
export function rankBetween(before: string | null, after: string | null): string {
	if (before !== null && after !== null && before >= after) throw new Error(`Ranks out of order: ${before} >= ${after}`);
	if (before === null) {
		if (after === null) return FIRST_RANK;
		const integer = integerPart(after);
		if (after === SMALLEST_INTEGER) throw new Error("No rank is left before the first one");
		if (integer === SMALLEST_INTEGER) return integer + midpoint("", after.slice(integer.length));
		if (integer < after) return integer;
		return decrementInteger(integer) ?? SMALLEST_INTEGER;
	}
	const integer = integerPart(before);
	const fraction = before.slice(integer.length);
	if (after === null) return incrementInteger(integer) ?? integer + midpoint(fraction, null);
	const afterInteger = integerPart(after);
	if (integer === afterInteger) return integer + midpoint(fraction, after.slice(afterInteger.length));
	const next = incrementInteger(integer);
	return next !== null && next < after ? next : integer + midpoint(fraction, null);
}

/** Ascending order of two ranks, matching the database's ordering of the `position` column. */
export function compareRanks(a: string, b: string): number {
	return a < b ? -1 : a > b ? 1 : 0;
}

// ---- Calendar dates ("YYYY-MM-DD") and times of day ("HH:MM") ----

const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;

function utcDay(date: string): Date {
	const match = DATE_PATTERN.exec(date);
	if (!match) throw new Error(`Invalid date: ${date}`);
	const day = new Date(0);
	day.setUTCFullYear(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
	return day;
}

const formatDay = (day: Date) => day.toISOString().slice(0, 10);

/** A real calendar date: "2026-02-30" is not one. */
export function isDateString(value: unknown): value is string {
	if (typeof value !== "string" || !DATE_PATTERN.test(value)) return false;
	return formatDay(utcDay(value)) === value;
}

export function isTimeString(value: unknown): value is string {
	return typeof value === "string" && TIME_PATTERN.test(value);
}

export function addDays(date: string, days: number): string {
	const day = utcDay(date);
	day.setUTCDate(day.getUTCDate() + days);
	return formatDay(day);
}

/** The calendar date of an instant in a time zone. */
export function dateInZone(instant: Date, timeZone: string): string {
	return formatDay(zonedDateFields(instant, normalizeTimeZone(timeZone)));
}

/** The time of day ("HH:MM") of an instant in a time zone. */
export function timeInZone(instant: Date, timeZone: string): string {
	return zonedDateFields(instant, normalizeTimeZone(timeZone)).toISOString().slice(11, 16);
}

/** The instant a wall-clock date and time name in a time zone (the later side of a skipped hour). */
export function zonedInstant(date: string, time: string, timeZone: string): Date {
	const match = TIME_PATTERN.exec(time);
	if (!match) throw new Error(`Invalid time: ${time}`);
	const fields = utcDay(date);
	fields.setUTCHours(Number(match[1]), Number(match[2]), 0, 0);
	return dateFromZonedFields(fields, normalizeTimeZone(timeZone));
}

/** Midnight at the start of `date` in a time zone. */
export function startOfDayInZone(date: string, timeZone: string): Date {
	return zonedInstant(date, "00:00", timeZone);
}

// ---- Due date and reminder ----

/** Time of day a date-only task reminds at, in the task's zone (Google Tasks does the same). */
export const DATE_ONLY_REMINDER_TIME = "09:00";

export type DueInput = { date: string; time?: string | null; timeZone?: string | null };
export type DueFields = { dueDate: string | null; dueAt: Date | null; timeZone: string | null; remindAt: Date | null };

export const NO_DUE: DueFields = { dueDate: null, dueAt: null, timeZone: null, remindAt: null };

/**
 * The stored due columns for a date with an optional time. `dueAt` exists only for timed tasks; the
 * reminder is the due time, or 09:00 on the date for a date-only task, and is dropped when that moment
 * has already passed (a task created late or dated in the past must not notify at once).
 */
export function deriveDue(due: DueInput | null, fallbackTimeZone: string | null | undefined, now: Date): DueFields {
	if (!due) return NO_DUE;
	const timeZone = normalizeTimeZone(due.timeZone ?? fallbackTimeZone);
	const dueAt = due.time ? zonedInstant(due.date, due.time, timeZone) : null;
	const reminder = dueAt ?? zonedInstant(due.date, DATE_ONLY_REMINDER_TIME, timeZone);
	return { dueDate: due.date, dueAt, timeZone, remindAt: reminder.getTime() > now.getTime() ? reminder : null };
}

/** The date and time a stored task is due, back in the shape `deriveDue` takes. */
export function dueInputOf(task: { dueDate: string | null; dueAt: Date | string | null; timeZone: string | null }): DueInput | null {
	if (!task.dueDate) return null;
	const timeZone = normalizeTimeZone(task.timeZone);
	return { date: task.dueDate, time: task.dueAt ? timeInZone(new Date(task.dueAt), timeZone) : null, timeZone };
}

/**
 * The calendar date a task falls on for someone in `timeZone`: a timed task follows its instant (a
 * 23:30 task entered in New York is tomorrow's in Berlin), a date-only task keeps its date everywhere.
 */
export function taskLocalDate(task: Pick<Task, "dueDate" | "dueAt">, timeZone: string): string | null {
	if (task.dueAt) return dateInZone(new Date(task.dueAt), timeZone);
	return task.dueDate;
}

/** An open task whose date (or time, when it has one) has passed. */
export function isTaskOverdue(task: Pick<Task, "status" | "dueDate" | "dueAt">, now: Date, timeZone: string): boolean {
	if (task.status === "completed" || !task.dueDate) return false;
	if (task.dueAt) return new Date(task.dueAt).getTime() < now.getTime();
	return task.dueDate < dateInZone(now, timeZone);
}

type DueKey = Pick<Task, "dueDate" | "dueAt" | "position">;

/**
 * Orders tasks by when they are due: earlier dates first, date-only before timed within a day, undated
 * last. With `timeZone`, a timed task counts on the date it falls on for that viewer.
 */
export function compareTasksByDue(a: DueKey, b: DueKey, timeZone?: string): number {
	const aDate = timeZone ? taskLocalDate(a, timeZone) : a.dueDate;
	const bDate = timeZone ? taskLocalDate(b, timeZone) : b.dueDate;
	if (aDate !== bDate) {
		if (!aDate) return 1;
		if (!bDate) return -1;
		return aDate < bDate ? -1 : 1;
	}
	const aTime = a.dueAt ? new Date(a.dueAt).getTime() : -Infinity;
	const bTime = b.dueAt ? new Date(b.dueAt).getTime() : -Infinity;
	if (aTime !== bTime) return aTime < bTime ? -1 : 1;
	return compareRanks(a.position, b.position);
}

// ---- Repeat rule ----
//
// A repeating task is one open row that carries the rule. Completing it leaves that row behind as a
// plain completed task and creates the next occurrence as a new row carrying the rule (see the service).
// The rule is "every N days / weeks / months / years", ending never, on a date, or after a number of
// occurrences, which is exactly an iCalendar RRULE with FREQ, INTERVAL and UNTIL or COUNT.

export const MAX_REPEAT_INTERVAL = 999;
export const MAX_REPEAT_COUNT = 999;
/** Steps tried when catching a neglected series up to today; a daily task can skip about 13 years. */
const MAX_REPEAT_STEPS = 5000;

function daysInMonth(year: number, monthIndex: number): number {
	return new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
}

/**
 * The date one interval after `date`. Monthly and yearly steps land on `anchorDay` (the day of month the
 * series started on), or on the month's last day when it is shorter, so a series started on the 31st
 * goes Jan 31, Feb 28, Mar 31 instead of drifting to the 28th for good.
 */
export function stepRepeatDate(date: string, freq: TaskRepeatFreq, interval: number, anchorDay: number | null): string {
	if (freq === "daily") return addDays(date, interval);
	if (freq === "weekly") return addDays(date, interval * 7);
	const day = utcDay(date);
	const months = day.getUTCFullYear() * 12 + day.getUTCMonth() + (freq === "monthly" ? interval : interval * 12);
	const year = Math.floor(months / 12);
	const monthIndex = months % 12;
	const next = new Date(0);
	next.setUTCFullYear(year, monthIndex, Math.min(anchorDay ?? day.getUTCDate(), daysInMonth(year, monthIndex)));
	return formatDay(next);
}

/** The day of month a series anchored on `date` repeats on. */
export function repeatAnchorDay(date: string): number {
	return utcDay(date).getUTCDate();
}

type RepeatState = TaskRepeatRule & { index: number; anchorDay: number | null };

/** Whether the occurrence at `index` on `date` is still inside the rule's end. */
function withinRepeatEnd(rule: TaskRepeatRule, index: number, date: string): boolean {
	if (rule.count !== null && index >= rule.count) return false;
	return rule.until === null || date <= rule.until;
}

/**
 * The occurrence that follows the one due on `dueDate`, or null when the series has ended. Occurrences
 * that already passed are skipped (they still count towards `count`), so completing a daily task after
 * a week away brings up today's occurrence rather than seven overdue ones.
 */
export function nextRepeatOccurrence(dueDate: string, state: RepeatState, today: string): { dueDate: string; index: number } | null {
	let date = dueDate;
	let index = state.index;
	for (let step = 0; step < MAX_REPEAT_STEPS; step += 1) {
		date = stepRepeatDate(date, state.freq, state.interval, state.anchorDay);
		index += 1;
		if (!withinRepeatEnd(state, index, date)) return null;
		if (date >= today) return { dueDate: date, index };
	}
	return null;
}

/**
 * Future occurrences of a repeating task after its current due date that fall on `from`..`to`
 * (inclusive), oldest first, for showing the series on a calendar. The current occurrence is the task
 * row itself and is not repeated here.
 */
export function expandRepeatOccurrences(dueDate: string, state: RepeatState, from: string, to: string, limit = 400): Array<{ dueDate: string; index: number }> {
	const occurrences: Array<{ dueDate: string; index: number }> = [];
	let date = dueDate;
	let index = state.index;
	for (let step = 0; step < MAX_REPEAT_STEPS && occurrences.length < limit; step += 1) {
		date = stepRepeatDate(date, state.freq, state.interval, state.anchorDay);
		index += 1;
		if (date > to || !withinRepeatEnd(state, index, date)) break;
		if (date >= from) occurrences.push({ dueDate: date, index });
	}
	return occurrences;
}

const RRULE_FREQ: Record<TaskRepeatFreq, string> = { daily: "DAILY", weekly: "WEEKLY", monthly: "MONTHLY", yearly: "YEARLY" };

/**
 * The rule as an iCalendar RRULE value (RFC 5545) for a VTODO whose DUE is the task's current due date,
 * so a later CalDAV layer is a mechanical mapping. COUNT is what is left from this occurrence on.
 * A monthly or yearly series anchored after the 28th means "that day or the month's last", which
 * RRULE spells as the last of the candidate days.
 */
export function repeatToRRule(state: RepeatState): string {
	const parts = [`FREQ=${RRULE_FREQ[state.freq]}`];
	if (state.interval !== 1) parts.push(`INTERVAL=${state.interval}`);
	if ((state.freq === "monthly" || state.freq === "yearly") && state.anchorDay !== null && state.anchorDay > 28) {
		const days = Array.from({ length: state.anchorDay - 27 }, (_, offset) => 28 + offset);
		parts.push(`BYMONTHDAY=${days.join(",")}`, "BYSETPOS=-1");
	}
	if (state.count !== null) parts.push(`COUNT=${Math.max(1, state.count - state.index)}`);
	else if (state.until !== null) parts.push(`UNTIL=${state.until.replaceAll("-", "")}`);
	return parts.join(";");
}

// ---- Tree ----

export type TaskNode<T> = T & { subtasks: T[] };

/**
 * Groups a flat list into top-level tasks with their subtasks, each level in manual order. A subtask
 * whose parent is not in the list (filtered out, or completed elsewhere) is shown at the top level.
 */
export function buildTaskTree<T extends Pick<Task, "id" | "parentId" | "position">>(tasks: readonly T[]): TaskNode<T>[] {
	const byPosition = (a: T, b: T) => compareRanks(a.position, b.position) || (a.id < b.id ? -1 : 1);
	const ids = new Set(tasks.map((task) => task.id));
	const children = new Map<string, T[]>();
	const roots: T[] = [];
	for (const task of tasks) {
		if (task.parentId && ids.has(task.parentId)) children.set(task.parentId, [...(children.get(task.parentId) ?? []), task]);
		else roots.push(task);
	}
	return roots.sort(byPosition).map((task) => ({ ...task, subtasks: (children.get(task.id) ?? []).sort(byPosition) }));
}

// ---- Queries ----

const time = (value: string | null) => (value ? new Date(value).getTime() : 0);

/**
 * The order a `GET /api/tasks` response comes in, also used to keep a cached response in order after an
 * optimistic change. A list reads top to bottom, each open task followed by its open subtasks, then
 * completed tasks, most recent first. Date-driven queries read by due date, Starred by most recently starred.
 */
export function sortTasksForQuery(tasks: readonly Task[], query: TaskQuery, timeZone: string): Task[] {
	const byPosition = (a: Task, b: Task) => compareRanks(a.position, b.position) || (a.id < b.id ? -1 : 1);
	if (query.view === "starred") return [...tasks].sort((a, b) => time(b.starredAt) - time(a.starredAt) || byPosition(a, b));
	const open = tasks.filter((task) => task.status !== "completed");
	const completed = tasks.filter((task) => task.status === "completed");
	if (query.view !== undefined || query.dueFrom !== undefined || query.dueTo !== undefined) {
		const byDue = (a: Task, b: Task) => compareTasksByDue(a, b, timeZone) || byPosition(a, b);
		return [...open.sort(byDue), ...completed.sort(byDue)];
	}
	const tree = buildTaskTree(open).flatMap(({ subtasks, ...task }) => [task as Task, ...subtasks]);
	return [...tree, ...completed.sort((a, b) => time(b.completedAt) - time(a.completedAt) || byPosition(a, b))];
}

/**
 * Whether a task belongs in the response to `query` for a viewer whose date is `today` in `timeZone`:
 * the client-side twin of the service's filters, for optimistic cache updates.
 */
export function taskMatchesQuery(task: Task, query: TaskQuery, today: string, timeZone: string): boolean {
	const completed = task.status === "completed";
	if (query.listId !== undefined && task.listId !== query.listId) return false;
	if (query.messageId !== undefined && task.message?.id !== query.messageId) return false;
	if (query.completed !== undefined && query.completed !== completed) return false;
	if (query.view !== undefined && completed) return false;
	if (query.view === "starred" && !task.starred) return false;
	const date = taskLocalDate(task, timeZone);
	if (query.view === "today" && !(date !== null && date <= today)) return false;
	if (query.view === "upcoming" && !(date !== null && date > today)) return false;
	if (query.dueFrom !== undefined && !(date !== null && date >= query.dueFrom)) return false;
	if (query.dueTo !== undefined && !(date !== null && date <= query.dueTo)) return false;
	return true;
}
