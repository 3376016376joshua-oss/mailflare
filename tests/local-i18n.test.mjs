import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { catalogFiles, readLocalStrings, withLocalStrings } from "../scripts/local-i18n.mjs";

// Strings of the local fork live in src/lib/i18n/local/*.json and are written into every catalog by
// scripts/local-i18n.mjs; this fails when a fragment changed and the script was not run.

test("every catalog carries the local strings, at its end and in fragment order", () => {
	const strings = readLocalStrings();
	assert.ok(Object.keys(strings).length > 0);
	for (const file of catalogFiles()) {
		const text = readFileSync(file, "utf8");
		assert.equal(text, `${JSON.stringify(withLocalStrings(JSON.parse(text), strings), null, "\t")}\n`, `${fileURLToPath(file)} is stale: run \`node scripts/local-i18n.mjs\``);
	}
});

test("local strings replace their old text and leave every other key where it was", () => {
	const merged = withLocalStrings({ "navigation.inbox": "Posteingang", "tasks.title": "old", "invite.undo": "Undo" }, { "tasks.title": "Tasks", "tasks.view.today": "Today" });
	assert.deepEqual(Object.entries(merged), [["navigation.inbox", "Posteingang"], ["invite.undo", "Undo"], ["tasks.title", "Tasks"], ["tasks.view.today", "Today"]]);
});
