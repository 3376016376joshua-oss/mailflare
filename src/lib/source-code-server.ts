import { getEnv } from "@/lib/cloudflare";
import { DEFAULT_SOURCE_CODE_URL, resolveSourceCodeUrl } from "./source-code";

/** SOURCE_CODE_URL of this installation, for the root layout. A failure to read the environment keeps the default. */
export function getSourceCodeUrl(): string {
	try {
		return resolveSourceCodeUrl(getEnv().SOURCE_CODE_URL);
	} catch {
		return DEFAULT_SOURCE_CODE_URL;
	}
}
