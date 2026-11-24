// Writes the strings of the local fork (src/lib/i18n/local/*.json, English) into every catalog:
// src/lib/i18n/en.json and public/locales/*.json. Run it after adding or changing a local string:
//
//   node scripts/local-i18n.mjs
//
// Local features keep their strings in fragments instead of editing the 34 catalogs by hand, so
// parallel branches and upstream releases never fight over the same lines: after a merge conflict in
// a catalog, keep either side and run this again. Local strings are English in every language; they
// always sit at the end of a catalog, in fragment order, so the output does not depend on merge order.
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const root = new URL("../", import.meta.url);
const fragmentsDir = new URL("src/lib/i18n/local/", root);
/** Local keys are namespaced so they cannot collide with an upstream key. */
const PREFIXES = ["tasks.", "local."];

export function readLocalStrings() {
	const strings = {};
	for (const name of readdirSync(fragmentsDir).filter((file) => file.endsWith(".json")).sort()) {
		for (const [key, value] of Object.entries(JSON.parse(readFileSync(new URL(name, fragmentsDir), "utf8")))) {
			if (!PREFIXES.some((prefix) => key.startsWith(prefix))) throw new Error(`${name}: "${key}" must start with ${PREFIXES.join(" or ")}`);
			if (key in strings) throw new Error(`${name}: "${key}" is already defined by another fragment`);
			if (typeof value !== "string" || !value.trim()) throw new Error(`${name}: "${key}" needs a text`);
			strings[key] = value;
		}
	}
	return strings;
}

export function catalogFiles() {
	const localesDir = new URL("public/locales/", root);
	return [new URL("src/lib/i18n/en.json", root), ...readdirSync(localesDir).filter((file) => file.endsWith(".json")).sort().map((file) => new URL(file, localesDir))];
}

/** The catalog with every local string at its end, in fragment order. */
export function withLocalStrings(catalog, strings) {
	const kept = Object.fromEntries(Object.entries(catalog).filter(([key]) => !(key in strings)));
	return { ...kept, ...strings };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	const strings = readLocalStrings();
	let changed = 0;
	for (const file of catalogFiles()) {
		const before = readFileSync(file, "utf8");
		const after = `${JSON.stringify(withLocalStrings(JSON.parse(before), strings), null, "\t")}\n`;
		if (after === before) continue;
		writeFileSync(file, after);
		changed += 1;
	}
	console.log(`${Object.keys(strings).length} local strings; ${changed} catalogs updated.`);
}
