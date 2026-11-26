"use client";

import { useRef } from "react";
import type { RefObject } from "react";
import { Search, X } from "@/components/icons";
import { useLanguage } from "@/components/language-provider";
import { TASK_SEARCH_MAX } from "@/lib/tasks/task-utils";
import { cn } from "@/lib/utils";
import { taskIconButtonClass } from "./task-controls";

/**
 * The search box of the Tasks menu and of the side panel: a pill with the text to look for in titles and
 * notes. The owner decides when the search runs (both run it as the text settles); Enter calls
 * `onSubmit`, Escape or the cross empties the box.
 */
export function TaskSearchBox({ value, onChange, onSubmit, inputRef, className }: {
	value: string;
	onChange: (value: string) => void;
	onSubmit?: () => void;
	inputRef?: RefObject<HTMLInputElement | null>;
	className?: string;
}) {
	const { t } = useLanguage();
	const ownRef = useRef<HTMLInputElement | null>(null);
	const ref = inputRef ?? ownRef;
	const label = t("tasks.find.search");

	return (
		<form
			role="search"
			onSubmit={(event) => { event.preventDefault(); onSubmit?.(); }}
			className={cn("flex h-10 items-center gap-3 rounded-full bg-[#eaf1fb] pl-4 pr-1 text-neutral-600 transition-shadow focus-within:ring-2 focus-within:ring-blue-500/30 max-md:h-11", className)}
		>
			<Search size={16} aria-hidden="true" className="shrink-0 max-md:h-5 max-md:w-5" />
			<input
				ref={ref}
				type="text"
				inputMode="search"
				enterKeyHint="search"
				autoComplete="off"
				spellCheck={false}
				value={value}
				maxLength={TASK_SEARCH_MAX}
				placeholder={label}
				aria-label={label}
				onChange={(event) => onChange(event.target.value)}
				onKeyDown={(event) => {
					if (event.key !== "Escape" || event.nativeEvent.isComposing) return;
					event.preventDefault();
					if (value) onChange("");
					else event.currentTarget.blur();
				}}
				className="h-full min-w-0 flex-1 bg-transparent text-sm text-neutral-900 placeholder:text-neutral-500 focus:outline-none max-md:text-base"
			/>
			{value ? (
				<button type="button" onClick={() => { onChange(""); ref.current?.focus(); }} aria-label={t("tasks.find.clear")} title={t("tasks.find.clear")} className={cn(taskIconButtonClass, "max-md:h-9 max-md:w-9")}>
					<X size={16} aria-hidden="true" />
				</button>
			) : <span aria-hidden="true" className="w-2.5 shrink-0" />}
		</form>
	);
}
