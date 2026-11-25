"use client";

import { useState } from "react";
import { useLanguage } from "@/components/language-provider";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { TASK_LIST_TITLE_MAX } from "@/lib/tasks/task-utils";

/** Names a new list, or renames one when `initialTitle` is given. Mount it while it should be open. */
export function TaskListDialog({ initialTitle, onSubmit, onClose }: { initialTitle?: string; onSubmit: (title: string) => void; onClose: () => void }) {
	const { t } = useLanguage();
	const [title, setTitle] = useState(initialTitle ?? "");
	const renaming = initialTitle !== undefined;
	const trimmed = title.trim();

	function submit(event: React.FormEvent) {
		event.preventDefault();
		if (!trimmed) return;
		if (trimmed !== initialTitle) onSubmit(trimmed);
		onClose();
	}

	return (
		<Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
			<DialogContent className="w-[min(420px,calc(100vw-32px))]">
				<DialogHeader><DialogTitle>{renaming ? t("tasks.app.renameList") : t("tasks.app.newList")}</DialogTitle></DialogHeader>
				<form onSubmit={submit} className="space-y-5">
					<Input
						// eslint-disable-next-line jsx-a11y/no-autofocus -- the dialog exists to type this one name
						autoFocus
						value={title}
						onChange={(event) => setTitle(event.target.value)}
						onFocus={(event) => event.currentTarget.select()}
						placeholder={t("tasks.app.listName")}
						aria-label={t("tasks.app.listName")}
						maxLength={TASK_LIST_TITLE_MAX}
					/>
					<div className="flex justify-end gap-2">
						<Button type="button" variant="ghost" onClick={onClose}>{t("common.cancel")}</Button>
						<Button type="submit" disabled={!trimmed}>{renaming ? t("common.save") : t("tasks.app.create")}</Button>
					</div>
				</form>
			</DialogContent>
		</Dialog>
	);
}
