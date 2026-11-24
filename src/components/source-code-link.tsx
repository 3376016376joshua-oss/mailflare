"use client";

import { createContext, useContext } from "react";
import { DEFAULT_SOURCE_CODE_URL } from "@/lib/source-code";
import { cn } from "@/lib/utils";
import { useLanguage } from "./language-provider";

const SourceCodeContext = createContext(DEFAULT_SOURCE_CODE_URL);

/** Carries SOURCE_CODE_URL from the root layout (server) to every "Source code" link. */
export function SourceCodeProvider({ url, children }: { url: string; children: React.ReactNode }) {
	return <SourceCodeContext.Provider value={url}>{children}</SourceCodeContext.Provider>;
}

/** The link to this installation's source code (AGPL-3.0 section 13). Styled by its surroundings; pass classes for colour and size. */
export function SourceCodeLink({ className }: { className?: string }) {
	const { t } = useLanguage();
	const url = useContext(SourceCodeContext);
	return <a href={url} target="_blank" rel="noreferrer" className={cn("hover:underline", className)}>{t("local.sourceCode")}</a>;
}

/** The link on a line of its own, as the quiet footer of a public page. */
export function SourceCodeFooter({ className }: { className?: string }) {
	return <p className={cn("text-center text-xs text-neutral-500", className)}><SourceCodeLink /></p>;
}
