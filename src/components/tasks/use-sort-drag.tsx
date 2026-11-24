"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent, ReactNode, RefObject } from "react";
import { createPortal } from "react-dom";

/**
 * Pointer drag for reordering rows: a ghost follows the pointer and a blue line marks where the row
 * will land (indented when it will nest); nothing moves until the pointer is released. Used by the task
 * list (drag handle, one level of nesting) and by the lists in the Tasks menu (whole row, flat).
 *
 * Rows are the elements inside `containerRef` that carry `data-sort-id`. Where a pointer position lands
 * is decided by `locate`, a pure function, so the rules live with the data and not with the DOM.
 */

export type SortDragTarget = { index: number; depth: number };

export type SortDragOptions<T extends SortDragTarget> = {
	containerRef: RefObject<HTMLElement | null>;
	/** Rows that travel with the dragged one (its subtasks) and are not drop positions. */
	companions?: (id: string) => readonly string[];
	/** The drop for inserting before row `index` (among the rows that stay put) with the pointer `dx` px right of where the drag began. */
	locate: (id: string, index: number, dx: number) => T | null;
	onDrop: (id: string, target: T) => void;
	/** How far one level of nesting indents the drop line, in px. */
	indent?: number;
	/** On touch, start after a press-and-hold: for rows that scroll or navigate when touched. */
	holdOnTouch?: boolean;
};

type DragView = { id: string; label: string; x: number; y: number; line: { top: number; left: number; width: number } | null };

type Session<T> = { id: string; label: string; startX: number; startY: number; x: number; y: number; active: boolean; target: T | null; finish: (commit: boolean) => void };

const START_DISTANCE = 5;
const HOLD_MS = 350;
const HOLD_SLOP = 8;
const SCROLL_EDGE = 56;
const SCROLL_STEP = 14;

function scrollParent(element: HTMLElement | null): HTMLElement | null {
	for (let node = element; node; node = node.parentElement) {
		const overflow = getComputedStyle(node).overflowY;
		if ((overflow === "auto" || overflow === "scroll") && node.scrollHeight > node.clientHeight) return node;
	}
	return null;
}

export function useSortDrag<T extends SortDragTarget>(options: SortDragOptions<T>) {
	const [view, setView] = useState<DragView | null>(null);
	const latest = useRef(options);
	const session = useRef<Session<T> | null>(null);
	const suppressClick = useRef(false);
	useEffect(() => { latest.current = options; });
	useEffect(() => () => session.current?.finish(false), []);

	const startDrag = useCallback((event: ReactPointerEvent, id: string, label: string) => {
		if (event.button !== 0 || session.current) return;
		const hold = event.pointerType === "touch" && latest.current.holdOnTouch === true;
		let holdTimer = 0;
		let frame = 0;
		let scroller: HTMLElement | null = null;
		const previousUserSelect = document.body.style.userSelect;

		const update = () => {
			const current = session.current;
			const container = latest.current.containerRef.current;
			if (!current?.active || !container) return;
			const skipped = new Set([current.id, ...(latest.current.companions?.(current.id) ?? [])]);
			const rects = Array.from(container.querySelectorAll<HTMLElement>("[data-sort-id]"))
				.filter((row) => !skipped.has(row.dataset.sortId ?? ""))
				.map((row) => row.getBoundingClientRect());
			const index = rects.filter((rect) => rect.top + rect.height / 2 < current.y).length;
			const target = latest.current.locate(current.id, index, current.x - current.startX);
			current.target = target;
			const bounds = container.getBoundingClientRect();
			const offset = target ? target.depth * (latest.current.indent ?? 0) : 0;
			const top = !target ? 0 : target.index < rects.length ? rects[target.index].top : rects.length ? rects[rects.length - 1].bottom : bounds.top;
			setView({ id: current.id, label: current.label, x: current.x, y: current.y, line: target ? { top, left: bounds.left + offset, width: Math.max(0, bounds.width - offset) } : null });
		};

		// While the pointer rests near an edge of the scrolling list, the list keeps scrolling under it.
		const autoScroll = () => {
			const current = session.current;
			if (!current?.active) return;
			if (scroller) {
				const bounds = scroller.getBoundingClientRect();
				const before = scroller.scrollTop;
				if (current.y < bounds.top + SCROLL_EDGE) scroller.scrollTop -= SCROLL_STEP;
				else if (current.y > bounds.bottom - SCROLL_EDGE) scroller.scrollTop += SCROLL_STEP;
				if (scroller.scrollTop !== before) update();
			}
			frame = requestAnimationFrame(autoScroll);
		};

		const activate = () => {
			const current = session.current;
			if (!current || current.active) return;
			current.active = true;
			scroller = scrollParent(latest.current.containerRef.current);
			document.body.style.userSelect = "none";
			frame = requestAnimationFrame(autoScroll);
			update();
		};

		const onMove = (moved: PointerEvent) => {
			const current = session.current;
			if (!current) return;
			current.x = moved.clientX;
			current.y = moved.clientY;
			if (!current.active) {
				const distance = Math.hypot(current.x - current.startX, current.y - current.startY);
				if (hold) {
					if (distance > HOLD_SLOP) current.finish(false);
					return;
				}
				if (distance < START_DISTANCE) return;
				activate();
				return;
			}
			update();
		};
		const onUp = () => session.current?.finish(true);
		const onCancel = () => session.current?.finish(false);
		const onKey = (pressed: KeyboardEvent) => {
			if (pressed.key !== "Escape" || !session.current?.active) return;
			pressed.preventDefault();
			pressed.stopPropagation();
			session.current.finish(false);
		};
		// Once dragging, a touch must not scroll the page under the finger.
		const blockScroll = (touched: TouchEvent) => { if (session.current?.active) touched.preventDefault(); };

		const finish = (commit: boolean) => {
			const current = session.current;
			if (!current) return;
			session.current = null;
			window.clearTimeout(holdTimer);
			cancelAnimationFrame(frame);
			window.removeEventListener("pointermove", onMove);
			window.removeEventListener("pointerup", onUp);
			window.removeEventListener("pointercancel", onCancel);
			window.removeEventListener("keydown", onKey, true);
			document.removeEventListener("touchmove", blockScroll);
			if (!current.active) return;
			document.body.style.userSelect = previousUserSelect;
			// The click that ends a drag belongs to the drag, not to the row under the pointer.
			suppressClick.current = true;
			window.setTimeout(() => { suppressClick.current = false; }, 0);
			setView(null);
			if (commit && current.target) latest.current.onDrop(current.id, current.target);
		};

		session.current = { id, label, startX: event.clientX, startY: event.clientY, x: event.clientX, y: event.clientY, active: false, target: null, finish };
		window.addEventListener("pointermove", onMove);
		window.addEventListener("pointerup", onUp);
		window.addEventListener("pointercancel", onCancel);
		window.addEventListener("keydown", onKey, true);
		document.addEventListener("touchmove", blockScroll, { passive: false });
		if (hold) holdTimer = window.setTimeout(activate, HOLD_MS);
	}, []);

	/** Put on `onClickCapture` of anything a drag can end over. */
	const guardClick = useCallback((event: ReactMouseEvent) => {
		if (!suppressClick.current) return;
		event.preventDefault();
		event.stopPropagation();
	}, []);

	const overlay: ReactNode = view && createPortal(
		<>
			{view.line && <div aria-hidden="true" className="pointer-events-none fixed z-[300] h-0.5 rounded-full bg-blue-600" style={{ top: view.line.top - 1, left: view.line.left, width: view.line.width }} />}
			<div aria-hidden="true" className="pointer-events-none fixed z-[301] max-w-[min(20rem,70vw)] truncate rounded-xl bg-white px-3 py-2 text-sm text-neutral-800 shadow-lg ring-1 ring-neutral-200" style={{ top: view.y - 18, left: view.x + 14 }}>
				{view.label}
			</div>
		</>,
		document.body,
	);

	return { dragId: view?.id ?? null, startDrag, guardClick, overlay };
}
