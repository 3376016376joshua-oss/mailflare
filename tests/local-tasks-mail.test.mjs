import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { JSDOM } from "jsdom";

// "Add to tasks" on an email (src/components/tasks/add-to-tasks*): its helpers, the last-used list, and the
// whole action driven in jsdom against a fake API.

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
// Inside node_modules so the bundle's external packages (react, @tanstack/react-query) resolve to the test's own copies.
const outDir = mkdtempSync(join(root, "node_modules", "mailflare-local-tasks-mail-test-"));
after(() => rmSync(outDir, { recursive: true, force: true }));

// The pieces of the app shell "Add to tasks" plugs into, reduced to what it uses.
const FAKES = {
	"@/lib/auth/client": "export function authFetch(path, init) { return globalThis.tasksFetch(String(path), init); }",
	"@/components/compose/compose-context": "export function useCompose() { return { showNotice: (message, options) => { globalThis.notices.push({ message, ...options }); return globalThis.notices.length; } }; }",
	"@/components/language-provider": "const t = (key) => key; export function useLanguage() { return { t }; }",
	"@/components/shortcuts": `export { isTypingInInput } from ${JSON.stringify(join(root, "src/components/shortcuts/use-hotkeys.ts"))}; export function useShortcuts() { return { shortcutsEnabled: globalThis.shortcutsEnabled }; }`,
	"@/components/icons": "export const CheckCircle2 = () => null;",
	"@/components/message-actions/action-menu": "export function MessageActionMenuItem() { return null; }",
};

await build({
	entryPoints: {
		mail: join(root, "src/components/tasks/add-to-tasks-utils.ts"),
		addToTasks: join(root, "src/components/tasks/add-to-tasks.tsx"),
		lastList: join(root, "src/lib/tasks/last-list.ts"),
		client: join(root, "src/lib/tasks/client.ts"),
	},
	outdir: outDir,
	outExtension: { ".js": ".mjs" },
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node22",
	packages: "external",
	jsx: "automatic",
	alias: { "@": join(root, "src") },
	logLevel: "silent",
	plugins: [{
		name: "fake-shell",
		setup(builder) {
			builder.onResolve({ filter: /^@\// }, (args) => (args.path in FAKES ? { path: args.path, namespace: "fake" } : undefined));
			builder.onLoad({ filter: /.*/, namespace: "fake" }, (args) => ({ contents: FAKES[args.path], loader: "js", resolveDir: root }));
		},
	}],
});

const load = (name) => import(pathToFileURL(join(outDir, `${name}.mjs`)).href);
const mail = await load("mail");

const LIST = "tl_1";
let counter = 0;
const task = (fields = {}) => ({
	id: `tsk_${++counter}`, listId: LIST, parentId: null, title: "Task", notes: "", status: "needs-action", completedAt: null, dueDate: null, dueAt: null, timeZone: null,
	starred: false, starredAt: null, position: `j${counter.toString(36).padStart(2, "0")}`, message: null, repeat: null, seriesId: null, createdAt: "2026-11-24T10:00:00.000Z", updatedAt: "2026-11-24T10:00:00.000Z", ...fields,
});

// ---- Helpers ----

test("an email becomes a task by its link alone, in the last-used list when there is one", () => {
	assert.deepEqual(mail.messageTaskInput("msg_1", "tl_9"), { messageId: "msg_1", listId: "tl_9" });
	assert.deepEqual(mail.messageTaskInput("msg_1", undefined), { messageId: "msg_1" });
	assert.equal(mail.isMissingListError({ code: "NOT_FOUND" }, { messageId: "msg_1", listId: "tl_9" }), true);
	assert.equal(mail.isMissingListError({ code: "NOT_FOUND" }, { messageId: "msg_1" }), false, "without a list the missing thing is the email");
	assert.equal(mail.isMissingListError({ code: "MIGRATION_REQUIRED" }, { messageId: "msg_1", listId: "tl_9" }), false);
	assert.equal(mail.isMissingListError(null, { messageId: "msg_1", listId: "tl_9" }), false);
});

test("the shortcut is Shift+T and nothing else", () => {
	const key = (fields) => ({ key: "T", shiftKey: true, metaKey: false, ctrlKey: false, altKey: false, repeat: false, ...fields });
	assert.equal(mail.isAddToTasksShortcut(key({})), true);
	assert.equal(mail.isAddToTasksShortcut(key({ key: "t" })), true, "Caps Lock");
	assert.equal(mail.isAddToTasksShortcut(key({ key: "t", shiftKey: false })), false);
	assert.equal(mail.isAddToTasksShortcut(key({ metaKey: true })), false);
	assert.equal(mail.isAddToTasksShortcut(key({ ctrlKey: true })), false);
	assert.equal(mail.isAddToTasksShortcut(key({ altKey: true })), false);
	assert.equal(mail.isAddToTasksShortcut(key({ repeat: true })), false);
	assert.equal(mail.isAddToTasksShortcut(key({ key: "R" })), false);
});

// ---- Browser state ----

globalThis.BroadcastChannel = class {
	postMessage() {}
	addEventListener() {}
	removeEventListener() {}
};
const NodeCustomEvent = globalThis.CustomEvent;
const DOM_GLOBALS = ["window", "document", "Element", "HTMLElement", "IS_REACT_ACT_ENVIRONMENT", "tasksFetch", "notices", "shortcutsEnabled"];

function openPage() {
	const dom = new JSDOM("<!doctype html><div id='root'></div><input id='field'>", { url: "https://mail.test/" });
	Object.assign(globalThis, { window: dom.window, document: dom.window.document, Element: dom.window.Element, HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true });
	// Code under test dispatches on jsdom's window, which only takes jsdom's own events.
	globalThis.CustomEvent = dom.window.CustomEvent;
	const close = () => {
		dom.window.close();
		globalThis.CustomEvent = NodeCustomEvent;
		for (const key of DOM_GLOBALS) delete globalThis[key];
	};
	return { dom, close };
}

test("the last-used list is remembered per browser, and storage that is blocked costs nothing", async () => {
	const page = openPage();
	try {
		const lastList = await load("lastList");
		assert.equal(lastList.getLastTaskListId(), undefined);
		lastList.rememberLastTaskList("tl_9");
		assert.equal(lastList.getLastTaskListId(), "tl_9");
		assert.equal(window.localStorage.getItem("mailflare.tasks.lastList"), "tl_9");
		lastList.rememberLastTaskList(null);
		assert.equal(lastList.getLastTaskListId(), undefined);

		Object.defineProperty(window, "localStorage", { get() { throw new Error("blocked"); } });
		lastList.rememberLastTaskList("tl_9");
		assert.equal(lastList.getLastTaskListId(), undefined);
	} finally {
		page.close();
	}
});

// ---- "Add to tasks" end to end against a fake API ----

/** The tasks API as far as "Add to tasks" uses it. `lists` are the lists that exist. */
function fakeApi({ lists = [LIST], failWith = null } = {}) {
	const state = { calls: [], tasks: [] };
	const reply = (status, body) => ({ ok: status < 400, status, json: async () => body });
	globalThis.tasksFetch = async (path, init) => {
		const method = init?.method ?? "GET";
		const body = init?.body ? JSON.parse(init.body) : undefined;
		state.calls.push(body ? `${method} ${path} ${JSON.stringify(body)}` : `${method} ${path}`);
		if (method === "GET") return reply(200, { tasks: state.tasks, occurrences: [], truncated: false, migrationRequired: false });
		if (failWith) return reply(failWith.status, failWith.body);
		if (method === "POST") {
			if (body.listId && !lists.includes(body.listId)) return reply(404, { error: "List not found", code: "NOT_FOUND" });
			const created = task({ title: "Cannot access workspace", listId: body.listId ?? lists[0], message: { id: body.messageId, subject: "Cannot access workspace" } });
			state.tasks.push(created);
			return reply(201, { task: created, next: null, removedIds: [] });
		}
		const id = path.split("/")[3];
		state.tasks = state.tasks.filter((entry) => entry.id !== id);
		return reply(200, { removedIds: [id] });
	};
	return state;
}

async function mountToolbar({ shortcutsEnabled = true } = {}) {
	const page = openPage();
	Object.assign(globalThis, { notices: [], shortcutsEnabled });
	const { createElement, act } = await import("react");
	const { createRoot } = await import("react-dom/client");
	const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
	const { useAddToTasksAction } = await load("addToTasks");
	const client = await load("client");
	// No garbage-collection timers: they would keep the test process alive for minutes.
	const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity }, mutations: { retry: false, gcTime: Infinity } } });
	const toolbar = {};
	function Fixture() {
		Object.assign(toolbar, { action: useAddToTasksAction("msg_1") });
		return null;
	}
	const opened = [];
	const stop = client.onTasksOpenPanel((detail) => opened.push(detail));
	const reactRoot = createRoot(document.getElementById("root"));
	await act(async () => reactRoot.render(createElement(QueryClientProvider, { client: queryClient }, createElement(Fixture))));
	const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
	const press = async (init, target = document.body) => {
		const keydown = new window.KeyboardEvent("keydown", { key: "T", shiftKey: true, bubbles: true, cancelable: true, ...init });
		await act(async () => { target.dispatchEvent(keydown); });
		await settle();
	};
	const unmount = async () => {
		stop();
		await act(async () => reactRoot.unmount());
		queryClient.clear();
		page.close();
	};
	return { act, toolbar, opened, notices: globalThis.notices, settle, press, unmount };
}

const posts = (api) => api.calls.filter((call) => call.startsWith("POST"));

test("Add to tasks links the email, opens the panel on the new task and offers to undo", async () => {
	const api = fakeApi({ lists: [LIST, "tl_work"] });
	const page = await mountToolbar();
	try {
		window.localStorage.setItem("mailflare.tasks.lastList", "tl_work");
		assert.deepEqual([page.toolbar.action.id, page.toolbar.action.label, page.toolbar.action.hint, page.toolbar.action.group], ["addToTasks", "tasks.mail.add", "tasks.mail.addHint", "secondary"]);

		await page.act(async () => {
			page.toolbar.action.onSelect();
			// A second click while the first is in flight adds nothing.
			page.toolbar.action.onSelect();
		});
		await page.settle();
		assert.deepEqual(posts(api), ['POST /api/tasks {"messageId":"msg_1","listId":"tl_work"}'], "the title is the service's to derive from the subject");
		const created = api.tasks[0];
		assert.deepEqual(page.opened, [{ taskId: created.id }]);
		assert.equal(page.notices.at(-1).message, "tasks.mail.added");
		assert.deepEqual(page.notices.at(-1).actions.map((action) => action.label), ["undo.button"]);

		await page.act(async () => { await page.notices.at(-1).actions[0].onClick(); });
		await page.settle();
		assert.equal(api.calls.includes(`DELETE /api/tasks/${created.id}`), true);
		assert.deepEqual(api.tasks, []);
		assert.equal(page.notices.at(-1).message, "tasks.mail.removed");
	} finally {
		await page.unmount();
	}
});

test("a remembered list that is gone falls back to the default list and is forgotten", async () => {
	const api = fakeApi();
	const page = await mountToolbar();
	try {
		window.localStorage.setItem("mailflare.tasks.lastList", "tl_deleted");
		await page.act(async () => page.toolbar.action.onSelect());
		await page.settle();
		assert.deepEqual(posts(api), ['POST /api/tasks {"messageId":"msg_1","listId":"tl_deleted"}', 'POST /api/tasks {"messageId":"msg_1"}']);
		assert.equal(window.localStorage.getItem("mailflare.tasks.lastList"), LIST);
		assert.deepEqual(page.opened, [{ taskId: api.tasks[0].id }]);
		assert.equal(page.notices.at(-1).message, "tasks.mail.added");
	} finally {
		await page.unmount();
	}
});

test("a failed add says why, opens nothing and can be tried again", async () => {
	const api = fakeApi({ failWith: { status: 409, body: { error: "Tasks are not set up", code: "MIGRATION_REQUIRED" } } });
	const page = await mountToolbar();
	try {
		await page.act(async () => page.toolbar.action.onSelect());
		await page.settle();
		assert.deepEqual([page.notices.at(-1).message, page.notices.at(-1).tone], ["tasks.error.migrationRequired", "error"]);
		assert.deepEqual(page.opened, []);
		await page.act(async () => page.toolbar.action.onSelect());
		await page.settle();
		assert.equal(posts(api).length, 2);
	} finally {
		await page.unmount();
	}
});

test("Shift+T adds the open email; a bare t, typing, menus and claimed keys do not", async () => {
	const api = fakeApi();
	const page = await mountToolbar();
	try {
		await page.press({ key: "t", shiftKey: false });
		await page.press({ metaKey: true });
		await page.press({}, document.getElementById("field"));
		const menu = document.body.appendChild(document.createElement("div"));
		menu.setAttribute("role", "menu");
		await page.press({}, menu);
		// "g" then Shift+T is the "go to Sent" sequence: whoever handles it claims the event.
		const claim = (keydown) => keydown.preventDefault();
		window.addEventListener("keydown", claim);
		await page.press({});
		window.removeEventListener("keydown", claim);
		assert.deepEqual(posts(api), []);

		await page.press({});
		assert.deepEqual(posts(api), ['POST /api/tasks {"messageId":"msg_1"}']);
		assert.deepEqual(page.opened, [{ taskId: api.tasks[0].id }]);
	} finally {
		await page.unmount();
	}
});

test("with keyboard shortcuts turned off, Shift+T does nothing", async () => {
	const api = fakeApi();
	const page = await mountToolbar({ shortcutsEnabled: false });
	try {
		await page.press({});
		assert.deepEqual(posts(api), []);
	} finally {
		await page.unmount();
	}
});
