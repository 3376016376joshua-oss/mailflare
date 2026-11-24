"use client";

import { forwardRef, useCallback, useLayoutEffect, useRef } from "react";
import type { ComponentProps, ReactNode } from "react";
import { Check, Star } from "@/components/icons";
import { useLanguage } from "@/components/language-provider";
import { cn } from "@/lib/utils";

/** The small building blocks every Tasks surface shares: the round checkbox, the star, chips and the growing text box. */

export const taskMenuClass = "z-[200] min-w-52 rounded-xl border border-neutral-200 bg-white p-1.5 text-neutral-900 shadow-xl";
export const taskMenuItemClass = "flex cursor-pointer items-center gap-3 rounded-lg px-3 py-2 text-sm text-neutral-700 outline-none data-[disabled]:cursor-default data-[disabled]:opacity-50 data-[highlighted]:bg-neutral-100";
export const taskIconButtonClass = "flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-neutral-500 transition-colors hover:bg-neutral-200/70 hover:text-neutral-800 focus-visible:outline-2 focus-visible:outline-blue-600 disabled:pointer-events-none disabled:opacity-40";

/** The round checkbox of a task: a ring while open (a check appears on hover), a filled disc once completed. */
export function TaskCheckbox({ checked, onToggle, disabled, label }: { checked: boolean; onToggle: () => void; disabled?: boolean; label?: string }) {
	const { t } = useLanguage();
	return (
		<button
			type="button"
			role="checkbox"
			aria-checked={checked}
			aria-label={label ?? (checked ? t("tasks.action.reopen") : t("tasks.action.complete"))}
			title={checked ? t("tasks.action.reopen") : t("tasks.action.complete")}
			disabled={disabled}
			onClick={onToggle}
			className="group/check flex h-9 w-9 shrink-0 items-center justify-center rounded-full transition-colors hover:bg-neutral-200/70 focus-visible:outline-2 focus-visible:outline-blue-600 disabled:pointer-events-none disabled:opacity-50"
		>
			<span className={cn("flex h-[18px] w-[18px] items-center justify-center rounded-full border-2 transition-colors", checked ? "border-blue-600 bg-blue-600 text-white" : "border-neutral-400 text-transparent group-hover/check:border-blue-600 group-hover/check:text-blue-600")}>
				<Check size={12} strokeWidth={3.5} aria-hidden="true" />
			</span>
		</button>
	);
}

export function TaskStarButton({ starred, onToggle, disabled, className }: { starred: boolean; onToggle: () => void; disabled?: boolean; className?: string }) {
	const { t } = useLanguage();
	const label = starred ? t("tasks.action.unstar") : t("tasks.action.star");
	return (
		<button type="button" aria-pressed={starred} aria-label={label} title={label} disabled={disabled} onClick={onToggle} className={cn(taskIconButtonClass, className)}>
			<Star size={18} aria-hidden="true" className={starred ? "fill-amber-400 text-amber-400" : undefined} />
		</button>
	);
}

/** Six dots: the handle a task is dragged by. */
export function GripIcon({ size = 16, className }: { size?: number; className?: string }) {
	return (
		<svg width={size} height={size} viewBox="0 0 16 16" fill="currentColor" aria-hidden="true" className={className}>
			{[3, 8, 13].flatMap((y) => [5.5, 10.5].map((x) => <circle key={`${x}-${y}`} cx={x} cy={y} r={1.25} />))}
		</svg>
	);
}

const chipClass = "inline-flex h-6 max-w-full min-w-0 items-center gap-1 rounded-full border px-2 text-xs transition-colors";
const chipTones = {
	neutral: "border-neutral-200 text-neutral-600",
	danger: "border-red-200 text-red-600",
	quiet: "border-dashed border-neutral-300 text-neutral-500",
};

/** A pill under a task: its due date, its email, its list. Pass `onClick` for a button; otherwise it is plain text. */
export function TaskChip({ icon, children, tone = "neutral", onClick, label, className }: { icon?: ReactNode; children: ReactNode; tone?: keyof typeof chipTones; onClick?: () => void; label?: string; className?: string }) {
	const content = <>{icon}<span className="truncate">{children}</span></>;
	if (!onClick) return <span className={cn(chipClass, chipTones[tone], className)}>{content}</span>;
	return <button type="button" onClick={onClick} aria-label={label} className={cn(chipClass, chipTones[tone], "hover:bg-neutral-200/60 focus-visible:outline-2 focus-visible:outline-blue-600", className)}>{content}</button>;
}

export const taskChipLinkClass = cn(chipClass, chipTones.neutral, "hover:bg-neutral-200/60 focus-visible:outline-2 focus-visible:outline-blue-600");

const supportsFieldSizing = () => typeof CSS !== "undefined" && CSS.supports("field-sizing", "content");

/**
 * A text box as tall as its text, for titles and notes edited in place. Browsers with `field-sizing`
 * size it in CSS; the others get their height set after every change and resize.
 */
export const AutoGrowTextarea = forwardRef<HTMLTextAreaElement, ComponentProps<"textarea">>(({ className, value, ...props }, forwarded) => {
	const inner = useRef<HTMLTextAreaElement | null>(null);
	const setRef = useCallback((node: HTMLTextAreaElement | null) => {
		inner.current = node;
		if (typeof forwarded === "function") forwarded(node);
		else if (forwarded) forwarded.current = node;
	}, [forwarded]);

	useLayoutEffect(() => {
		const element = inner.current;
		if (!element || supportsFieldSizing()) return;
		const fit = () => {
			element.style.height = "auto";
			element.style.height = `${element.scrollHeight}px`;
		};
		fit();
		const observer = new ResizeObserver(fit);
		observer.observe(element);
		return () => observer.disconnect();
	}, [value]);

	return <textarea ref={setRef} rows={1} value={value} className={cn("block w-full resize-none overflow-hidden bg-transparent field-sizing-content focus:outline-none", className)} {...props} />;
});
AutoGrowTextarea.displayName = "AutoGrowTextarea";
