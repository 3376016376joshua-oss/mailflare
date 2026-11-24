"use client";

import { useId, useState } from "react";
import { X } from "@/components/icons";
import { useLanguage } from "@/components/language-provider";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { MAX_REPEAT_COUNT, MAX_REPEAT_INTERVAL, addDays, dateInZone } from "@/lib/tasks/task-utils";
import type { Task, TaskRepeatFreq, UpdateTaskInput } from "@/lib/tasks/types";
import { getUserTimeZone } from "@/lib/time/utils";
import { cn } from "@/lib/utils";
import { scheduleChanges, scheduleFormError, scheduleFormOf } from "./task-view-utils";
import type { ScheduleEnd, ScheduleError, ScheduleForm } from "./task-view-utils";

const UNIT_KEYS = { daily: "tasks.app.schedule.unitDays", weekly: "tasks.app.schedule.unitWeeks", monthly: "tasks.app.schedule.unitMonths", yearly: "tasks.app.schedule.unitYears" } as const;
const ERROR_KEYS = {
	date: "tasks.app.schedule.errorDate",
	time: "tasks.app.schedule.errorTime",
	interval: "tasks.app.schedule.errorNumber",
	count: "tasks.app.schedule.errorNumber",
	until: "tasks.app.schedule.errorUntil",
} as const satisfies Record<ScheduleError, string>;
const FREQUENCIES: readonly TaskRepeatFreq[] = ["daily", "weekly", "monthly", "yearly"];
const numberClass = "h-9 w-20 rounded-lg px-2 text-center";
// `block`: as a flex box, Chrome puts the picker icon right after the text instead of at the end of the field.
const fieldClass = "block h-10 rounded-lg";

/**
 * When a task is due and how it repeats: a date, an optional time of day, and "every N days / weeks /
 * months / years" ending never, on a date or after a number of times. Saving sends only what changed.
 */
export function TaskScheduleDialog({ task, onClose, onSave }: { task: Task; onClose: () => void; onSave: (changes: Pick<UpdateTaskInput, "due" | "repeat">) => void }) {
	const { t } = useLanguage();
	const id = useId();
	const timeZone = getUserTimeZone();
	const today = dateInZone(new Date(), timeZone);
	const [form, setForm] = useState<ScheduleForm>(() => {
		const initial = scheduleFormOf(task, timeZone);
		return initial.date ? initial : { ...initial, date: today };
	});
	const [submitted, setSubmitted] = useState(false);
	const error = scheduleFormError(form);
	const canRepeat = task.parentId === null;
	const set = (patch: Partial<ScheduleForm>) => setForm((current) => ({ ...current, ...patch }));
	const interval = Number(form.interval) || 1;
	const quickDates = [
		{ label: t("tasks.due.today"), date: today },
		{ label: t("tasks.due.tomorrow"), date: addDays(today, 1) },
		{ label: t("tasks.app.schedule.nextWeek"), date: addDays(today, 7) },
	];

	function save(event: React.FormEvent) {
		event.preventDefault();
		setSubmitted(true);
		const changes = scheduleChanges(task, form, timeZone);
		if (!changes) return;
		if (Object.keys(changes).length > 0) onSave(changes);
		onClose();
	}

	const endOption = (value: ScheduleEnd, label: string, control?: React.ReactNode) => (
		<label className="flex min-h-9 items-center gap-3 text-sm text-neutral-800">
			<input type="radio" name={`${id}-end`} checked={form.end === value} onChange={() => set({ end: value })} className="h-4 w-4 shrink-0 accent-blue-600" />
			<span className="w-12 shrink-0">{label}</span>
			{control}
		</label>
	);

	return (
		<Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
			<DialogContent className="w-[min(440px,calc(100vw-32px))]">
				<DialogHeader>
					<DialogTitle>{t("tasks.app.schedule.title")}</DialogTitle>
					<DialogDescription className="truncate">{task.title}</DialogDescription>
				</DialogHeader>
				<form onSubmit={save} className="space-y-5" noValidate>
					<div className="flex flex-wrap gap-2">
						{quickDates.map((quick) => (
							<button key={quick.date} type="button" aria-pressed={form.date === quick.date} onClick={() => set({ date: quick.date })} className={cn("h-8 rounded-full border px-3 text-sm transition-colors", form.date === quick.date ? "border-blue-200 bg-blue-50 font-medium text-blue-700" : "border-neutral-200 text-neutral-700 hover:bg-neutral-100")}>
								{quick.label}
							</button>
						))}
					</div>
					<div className="grid grid-cols-2 gap-3">
						<div className="space-y-1.5">
							<label htmlFor={`${id}-date`} className="text-sm font-medium text-neutral-700">{t("tasks.app.schedule.date")}</label>
							<Input id={`${id}-date`} type="date" required value={form.date} onChange={(event) => set({ date: event.target.value })} className={fieldClass} />
						</div>
						<div className="space-y-1.5">
							<label htmlFor={`${id}-time`} className="text-sm font-medium text-neutral-700">{t("tasks.app.schedule.time")}</label>
							<div className="relative">
								<Input id={`${id}-time`} type="time" value={form.time} onChange={(event) => set({ time: event.target.value })} className={cn(fieldClass, form.time && "pr-9")} />
								{form.time && <button type="button" onClick={() => set({ time: "" })} aria-label={t("tasks.app.schedule.clearTime")} title={t("tasks.app.schedule.clearTime")} className="absolute right-1.5 top-1/2 flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded-full bg-white text-neutral-500 hover:bg-neutral-100 hover:text-neutral-800"><X size={14} /></button>}
							</div>
						</div>
					</div>
					{canRepeat ? (
						<div className="rounded-2xl border border-neutral-200">
							<div className="flex items-center justify-between gap-3 px-4 py-3">
								<label htmlFor={`${id}-repeat`} className="text-sm font-medium text-neutral-800">{t("tasks.app.schedule.repeat")}</label>
								<Switch id={`${id}-repeat`} checked={form.repeats} onCheckedChange={(repeats) => set({ repeats })} />
							</div>
							{form.repeats && (
								<div className="space-y-4 border-t border-neutral-200 px-4 py-4">
									<div className="flex flex-wrap items-center gap-2 text-sm text-neutral-800">
										<label htmlFor={`${id}-interval`}>{t("tasks.app.schedule.every")}</label>
										<Input id={`${id}-interval`} type="number" inputMode="numeric" min={1} max={MAX_REPEAT_INTERVAL} value={form.interval} onChange={(event) => set({ interval: event.target.value })} className={numberClass} />
										<Select aria-label={t("tasks.app.schedule.unit")} value={form.freq} onChange={(event) => set({ freq: event.target.value as TaskRepeatFreq })} containerClassName="h-9 w-32 items-center" className="h-full text-sm">
											{FREQUENCIES.map((freq) => <option key={freq} value={freq}>{t(UNIT_KEYS[freq], { count: interval })}</option>)}
										</Select>
									</div>
									<fieldset className="space-y-1">
										<legend className="mb-1 text-sm font-medium text-neutral-700">{t("tasks.app.schedule.ends")}</legend>
										{endOption("never", t("tasks.app.schedule.endNever"))}
										{endOption("until", t("tasks.app.schedule.endOn"), <Input type="date" aria-label={t("tasks.app.schedule.endDate")} min={form.date || undefined} value={form.until} disabled={form.end !== "until"} onFocus={() => set({ end: "until" })} onChange={(event) => set({ until: event.target.value })} className="block h-9 w-40 rounded-lg" />)}
										{endOption("count", t("tasks.app.schedule.endAfter"), <>
											<Input type="number" inputMode="numeric" aria-label={t("tasks.app.schedule.endCount")} min={1} max={MAX_REPEAT_COUNT} value={form.count} disabled={form.end !== "count"} onChange={(event) => set({ count: event.target.value })} className={numberClass} />
											<span className="text-neutral-600">{t("tasks.app.schedule.occurrences", { count: Number(form.count) || 0 })}</span>
										</>)}
									</fieldset>
								</div>
							)}
						</div>
					) : <p className="text-xs text-neutral-500">{t("tasks.app.schedule.subtaskNoRepeat")}</p>}
					{submitted && error && <p role="alert" className="text-sm text-red-600">{t(ERROR_KEYS[error])}</p>}
					<div className="flex flex-wrap items-center justify-between gap-2">
						{task.dueDate ? <Button type="button" variant="ghost" className="px-3 text-red-600 hover:bg-red-50" onClick={() => { onSave({ due: null }); onClose(); }}>{t("tasks.app.schedule.remove")}</Button> : <span />}
						<div className="flex gap-2">
							<Button type="button" variant="ghost" onClick={onClose}>{t("common.cancel")}</Button>
							<Button type="submit">{t("common.save")}</Button>
						</div>
					</div>
				</form>
			</DialogContent>
		</Dialog>
	);
}
