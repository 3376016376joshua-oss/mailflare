/**
 * Where the source code of this installation can be downloaded. Mailflare is AGPL-3.0: section 13 asks
 * that everyone who uses a modified version over a network is offered its source, so the app shows a
 * "Source code" link (src/components/source-code-link.tsx) in its shell and on its public pages.
 *
 * Set SOURCE_CODE_URL to the repository that holds the code this installation actually runs.
 */
export const DEFAULT_SOURCE_CODE_URL = "https://github.com/3376016376joshua-oss/mailflare";

/** The configured address when it is a usable http(s) URL, else the default: the link must never be missing or broken. */
export function resolveSourceCodeUrl(value: unknown): string {
	if (typeof value !== "string" || !value.trim()) return DEFAULT_SOURCE_CODE_URL;
	try {
		const url = new URL(value.trim());
		return url.protocol === "https:" || url.protocol === "http:" ? url.href : DEFAULT_SOURCE_CODE_URL;
	} catch {
		return DEFAULT_SOURCE_CODE_URL;
	}
}
