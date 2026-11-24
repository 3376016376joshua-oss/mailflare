import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_SOURCE_CODE_URL, resolveSourceCodeUrl } from "../src/lib/source-code.ts";

// The address behind the "Source code" link (AGPL-3.0 section 13): one configurable value with a safe default.

test("the source code link falls back to the fork's repository unless a usable URL is configured", () => {
	const fallback = "https://github.com/3376016376joshua-oss/mailflare";
	assert.equal(DEFAULT_SOURCE_CODE_URL, fallback);
	for (const unset of [undefined, null, "", "   ", 42, "not a url", "javascript:alert(1)", "ftp://example.com/src.tar", "//example.com/x"]) assert.equal(resolveSourceCodeUrl(unset), fallback, String(unset));
	assert.equal(resolveSourceCodeUrl(" https://git.example.com/me/mailflare "), "https://git.example.com/me/mailflare");
	assert.equal(resolveSourceCodeUrl("http://localhost:3000/source.tar.gz"), "http://localhost:3000/source.tar.gz");
});
