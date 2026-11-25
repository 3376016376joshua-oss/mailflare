"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { Dispatch, SetStateAction } from "react";

const TASKS_OPEN_KEY = "mailflare-dashboard:tasks-open";

type AssistantPanelState = {
	assistantOpen: boolean;
	setAssistantOpen: Dispatch<SetStateAction<boolean>>;
	assistantFullSize: boolean;
	setAssistantFullSize: Dispatch<SetStateAction<boolean>>;
};

export type SidePanelState = AssistantPanelState & { tasksOpen: boolean; setTasksOpen: Dispatch<SetStateAction<boolean>> };

function readSaved(key: string): boolean | null {
	try {
		const saved = localStorage.getItem(key);
		return saved === null ? null : saved === "true";
	} catch { return null; }
}

/**
 * Adds the Tasks panel to the Assistant's panel state. The right-hand dock of Mail and Calendar shows
 * one panel at a time: opening either closes the other, and the Assistant reads as closed while Tasks is
 * open. Like the Assistant, the choice is remembered in localStorage (per user once the user is known).
 */
export function useExclusiveTasksPanel({ assistantOpen, setAssistantOpen, assistantFullSize, setAssistantFullSize }: AssistantPanelState, storagePrefix: string | null): SidePanelState {
	const [tasksOpen, setTasksOpenState] = useState(false);
	const [restored, setRestored] = useState(false);

	useLayoutEffect(() => {
		// eslint-disable-next-line react-hooks/set-state-in-effect -- localStorage is client-only; restoring it in a lazy initialiser would mismatch the server-rendered markup.
		setTasksOpenState(readSaved(TASKS_OPEN_KEY) ?? false);
		setRestored(true);
	}, []);

	useEffect(() => {
		if (!storagePrefix) return;
		const saved = readSaved(`${storagePrefix}:tasks-open`);
		// eslint-disable-next-line react-hooks/set-state-in-effect -- the per-user choice is only readable once the session has resolved.
		if (saved !== null) setTasksOpenState(saved);
	}, [storagePrefix]);

	// Both can be restored as open (the two are saved separately, and a second account of this browser may
	// inherit one of them). Tasks wins, and the Assistant is closed for good rather than left to reappear.
	useEffect(() => {
		if (!tasksOpen || !assistantOpen) return;
		setAssistantOpen(false);
		setAssistantFullSize(false);
	}, [tasksOpen, assistantOpen, setAssistantOpen, setAssistantFullSize]);

	useEffect(() => {
		if (!restored) return;
		try {
			localStorage.setItem(TASKS_OPEN_KEY, String(tasksOpen));
			if (storagePrefix) localStorage.setItem(`${storagePrefix}:tasks-open`, String(tasksOpen));
		} catch { /* Storage is optional. */ }
	}, [restored, storagePrefix, tasksOpen]);

	const assistantShown = assistantOpen && !tasksOpen;
	const shown = useRef({ assistant: assistantShown, tasks: tasksOpen });
	useEffect(() => { shown.current = { assistant: assistantShown, tasks: tasksOpen }; });

	const openAssistant = useCallback<Dispatch<SetStateAction<boolean>>>((value) => {
		const next = typeof value === "function" ? value(shown.current.assistant) : value;
		setAssistantOpen(next);
		if (next) setTasksOpenState(false);
	}, [setAssistantOpen]);

	const setTasksOpen = useCallback<Dispatch<SetStateAction<boolean>>>((value) => {
		const next = typeof value === "function" ? value(shown.current.tasks) : value;
		setTasksOpenState(next);
		if (!next) return;
		setAssistantOpen(false);
		setAssistantFullSize(false);
	}, [setAssistantOpen, setAssistantFullSize]);

	return { assistantOpen: assistantShown, setAssistantOpen: openAssistant, assistantFullSize: assistantFullSize && !tasksOpen, setAssistantFullSize, tasksOpen, setTasksOpen };
}
