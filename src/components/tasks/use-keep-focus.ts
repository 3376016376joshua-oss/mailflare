"use client";

import { useCallback, useEffect, useLayoutEffect, useState } from "react";
import type { RefObject } from "react";

/**
 * Keeps keyboard focus on a row while it is reordered with the keyboard. Moving a row re-inserts its
 * element, which drops focus; call the returned function with the row's id right after asking for the
 * move, and the element whose `attribute` equals that id is focused again once the list has re-rendered.
 * `version` is anything that changes when the order does.
 */
export function useKeepFocus(containerRef: RefObject<HTMLElement | null>, attribute: string, version: unknown): (id: string) => void {
	const [kept, setKept] = useState<{ id: string } | null>(null);

	useLayoutEffect(() => {
		if (!kept) return;
		const element = containerRef.current?.querySelector<HTMLElement>(`[${attribute}="${CSS.escape(kept.id)}"]`);
		// Only when the move dropped focus (it falls back to the page): if the user has moved on, it stays where they put it.
		const active = document.activeElement;
		if (!element || (active !== element && active !== null && active !== document.body)) return;
		if (active !== element) element.focus({ preventScroll: true });
		element.scrollIntoView({ block: "nearest" });
	}, [kept, version, containerRef, attribute]);

	// The optimistic reorder lands within a frame or two; after that, focus is the user's again.
	useEffect(() => {
		if (!kept) return;
		const timer = window.setTimeout(() => setKept(null), 1200);
		return () => window.clearTimeout(timer);
	}, [kept]);

	return useCallback((id: string) => setKept({ id }), []);
}
