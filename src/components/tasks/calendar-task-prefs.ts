"use client";

import { useSyncExternalStore } from "react";

/**
 * Whether the calendar shows tasks, and completed ones among them. Remembered per browser like the
 * calendar's view choice, and shared by every component that reads it (the options menu, the strip, the
 * grid, the month cells), so flipping a switch redraws them all at once.
 */

export type CalendarTaskPrefs = { showTasks: boolean; showCompleted: boolean };

const KEYS = { showTasks: "mailflare.calendar.showTasks", showCompleted: "mailflare.calendar.showCompletedTasks" } as const;
const DEFAULTS: CalendarTaskPrefs = { showTasks: true, showCompleted: true };

/** Both switches default to on; only an explicit "off" is stored as such. */
function readStored(): CalendarTaskPrefs {
	try {
		return { showTasks: window.localStorage.getItem(KEYS.showTasks) !== "0", showCompleted: window.localStorage.getItem(KEYS.showCompleted) !== "0" };
	} catch {
		// Storage can be blocked; the defaults are fine.
		return DEFAULTS;
	}
}

// The current state lives here, so a switch still works for the session when storage is blocked, and
// useSyncExternalStore gets the same object until something changes.
let current: CalendarTaskPrefs | null = null;
const listeners = new Set<() => void>();

function snapshot(): CalendarTaskPrefs {
	current ??= readStored();
	return current;
}

function publish(next: CalendarTaskPrefs): void {
	current = next;
	for (const listener of listeners) listener();
}

/** Another tab flipped a switch. */
function onStorage(event: StorageEvent): void {
	if (event.key === null || event.key === KEYS.showTasks || event.key === KEYS.showCompleted) publish(readStored());
}

function subscribe(listener: () => void): () => void {
	if (listeners.size === 0) window.addEventListener("storage", onStorage);
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
		if (listeners.size === 0) window.removeEventListener("storage", onStorage);
	};
}

export function setCalendarTaskPref(key: keyof CalendarTaskPrefs, value: boolean): void {
	try {
		window.localStorage.setItem(KEYS[key], value ? "1" : "0");
	} catch { /* kept for this session only */ }
	publish({ ...snapshot(), [key]: value });
}

export function useCalendarTaskPrefs(): CalendarTaskPrefs {
	return useSyncExternalStore(subscribe, snapshot, () => DEFAULTS);
}
