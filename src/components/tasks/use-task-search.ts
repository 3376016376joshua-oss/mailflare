"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { normalizeTaskSearch } from "./task-view-utils";

/** How long typing has to pause before a search runs. */
export const TASK_SEARCH_DELAY = 200;

/**
 * `value` once it has stopped changing for `delay` ms, so a search runs per pause and not per keystroke.
 * An emptied value settles at once: clearing a search must not leave its results up for a moment.
 */
export function useSettledText(value: string, delay = TASK_SEARCH_DELAY): string {
	const [settled, setSettled] = useState(value);
	useEffect(() => {
		const timer = window.setTimeout(() => setSettled(value), value ? delay : 0);
		return () => window.clearTimeout(timer);
	}, [value, delay]);
	return value ? settled : "";
}

/**
 * The text of a search box whose search lives in the address (`?q=`), as the Tasks app's does: typing
 * shows at once and reaches the address after a pause (`commit`), and a search that changes some other
 * way (a link that leaves it, Back) replaces what was typed.
 *
 * The address trails the box, so `sent` remembers every text on its way there: when one of them
 * arrives it is this box's own and the newer typing stays; anything else came from outside.
 */
export function useAddressSearchText(addressText: string, commit: (text: string) => void, delay = TASK_SEARCH_DELAY) {
	const [draft, setDraft] = useState<string | null>(null);
	const [sent, setSent] = useState<readonly string[]>([]);
	const [seen, setSeen] = useState(addressText);
	if (addressText !== seen) {
		setSeen(addressText);
		const index = sent.indexOf(addressText);
		if (index >= 0) setSent(sent.slice(index + 1));
		else {
			setSent([]);
			setDraft(null);
		}
	}

	const latest = useRef(commit);
	useEffect(() => { latest.current = commit; });

	/** What the address holds, or is about to. */
	const target = sent.at(-1) ?? addressText;
	const wanted = draft === null ? target : normalizeTaskSearch(draft);

	const send = useCallback((text: string) => {
		setSent((pending) => [...pending, text]);
		latest.current(text);
	}, []);

	useEffect(() => {
		if (wanted === target) return;
		const timer = window.setTimeout(() => send(wanted), wanted ? delay : 0);
		return () => window.clearTimeout(timer);
	}, [wanted, target, delay, send]);

	return {
		text: draft ?? addressText,
		setText: setDraft,
		/** Runs the search now instead of after the pause (Enter). */
		submit: () => { if (wanted !== target) send(wanted); },
	};
}
