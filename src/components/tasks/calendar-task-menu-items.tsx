"use client";

import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { Check } from "@/components/icons";
import { useLanguage } from "@/components/language-provider";
import { setCalendarTaskPref, useCalendarTaskPrefs } from "./calendar-task-prefs";
import type { CalendarTaskPrefs } from "./calendar-task-prefs";

// The look of the view choices in the same menu.
const itemClass = "flex cursor-pointer items-center gap-2 rounded-lg px-3 py-2 text-neutral-700 outline-none data-[disabled]:cursor-not-allowed data-[disabled]:text-neutral-400 data-[highlighted]:bg-neutral-100";

/** "Show tasks" and "Show completed" for the calendar options menu. The menu stays open while they are flipped. */
export function CalendarTaskMenuItems() {
	const { t } = useLanguage();
	const prefs = useCalendarTaskPrefs();
	const item = (key: keyof CalendarTaskPrefs, label: string, disabled = false) => (
		<DropdownMenu.CheckboxItem
			checked={prefs[key]}
			disabled={disabled}
			onCheckedChange={(checked) => setCalendarTaskPref(key, checked === true)}
			onSelect={(event) => event.preventDefault()}
			className={itemClass}
		>
			<span className="flex h-4 w-4 shrink-0 items-center justify-center">{prefs[key] && <Check className={disabled ? "h-4 w-4" : "h-4 w-4 text-blue-600"} />}</span>
			{label}
		</DropdownMenu.CheckboxItem>
	);
	return (
		<>
			<DropdownMenu.Separator className="my-1 h-px bg-neutral-100" />
			<DropdownMenu.Label className="px-3 pb-1 pt-2 text-xs font-medium text-neutral-500">{t("tasks.title")}</DropdownMenu.Label>
			{item("showTasks", t("tasks.calendar.showTasks"))}
			{item("showCompleted", t("tasks.calendar.showCompleted"), !prefs.showTasks)}
		</>
	);
}
