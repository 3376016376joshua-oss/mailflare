import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

// The Tasks screens against a running instance: the /tasks app and the side panel in Mail and Calendar.
// The rules they stand on are covered in tests/local-tasks-ui.test.mjs (drag, sections, the schedule
// form) and tests/local-tasks*.test.mjs (service, cache). Like the other specs, it resets the demo
// account; run it only against a disposable instance.

const EMAIL = "admin@example.com";
const PASSWORD = "demo-password-change-me";

type ApiTask = { id: string; title: string; notes: string; status: string; parentId: string | null; listId: string; starred: boolean; dueDate: string | null; repeat: { freq: string; interval: number; count: number | null } | null };
type ApiList = { id: string; title: string; openCount: number };

async function resetDemo(request: APIRequestContext) {
	const response = await request.post("/api/seed?reset=1");
	expect(response.ok(), `POST /api/seed?reset=1 returned ${response.status()}`).toBe(true);
}

async function login(page: Page) {
	await page.goto("/login");
	await page.waitForLoadState("networkidle");
	await page.getByLabel("Email").fill(EMAIL);
	await page.getByLabel("Password").fill(PASSWORD);
	await page.getByRole("button", { name: "Sign in", exact: true }).click();
	await page.waitForURL("**/inbox", { timeout: 30_000 });
}

/** The page's own session, so API calls and the screen see the same account. */
function api(page: Page) {
	const origin = new URL(page.url()).origin;
	const send = async (method: "get" | "post" | "patch", path: string, data?: object) => {
		const response = await page.request[method](path, { headers: { Origin: origin, "X-Time-Zone": "UTC" }, data });
		expect(response.ok(), `${method.toUpperCase()} ${path} returned ${response.status()}`).toBe(true);
		return response.json();
	};
	return {
		lists: async () => (await send("get", "/api/tasks/lists")).lists as ApiList[],
		tasks: async (query: string) => (await send("get", `/api/tasks?${query}`)).tasks as ApiTask[],
		create: async (data: object) => (await send("post", "/api/tasks", data)).task as ApiTask,
		createList: async (title: string) => (await send("post", "/api/tasks/lists", { title })).list as ApiList,
	};
}

const row = (page: Page, id: string) => page.locator(`[data-task-row="${id}"]`);
const handle = (page: Page, id: string) => page.locator(`[data-task-handle="${id}"]`);
/** Titles of the open tasks on screen, top to bottom; subtasks are marked with ">". */
const shownTitles = (page: Page) => page.locator("[data-task-row]:has([data-task-title])").evaluateAll((rows) => rows.map((element) => `${(element as HTMLElement).style.marginLeft ? "> " : ""}${element.querySelector<HTMLTextAreaElement>("[data-task-title]")?.value}`));

/** Drags a task by its handle to a point given relative to another row. */
async function dragTask(page: Page, id: string, target: { id: string; edge: "top" | "bottom"; dx?: number }) {
	await row(page, id).hover();
	const from = (await handle(page, id).boundingBox())!;
	const to = (await row(page, target.id).boundingBox())!;
	const startX = from.x + from.width / 2;
	await page.mouse.move(startX, from.y + from.height / 2);
	await page.mouse.down();
	await page.mouse.move(startX, from.y + from.height / 2 + 12, { steps: 3 });
	await page.mouse.move(startX + (target.dx ?? 0), target.edge === "top" ? to.y + 3 : to.y + to.height - 3, { steps: 10 });
	await page.mouse.up();
}

test.beforeAll(async ({ request }) => {
	// A configured installation answers 403; a dev server without Cloudflare credentials answers 503 once migrated.
	const prepared = await request.post("/api/setup/prepare");
	expect([200, 403, 503]).toContain(prepared.status());
});

test.beforeEach(async ({ page }) => {
	await resetDemo(page.request);
	await login(page);
});

test.afterAll(async ({ request }) => {
	await resetDemo(request);
});

test("the Tasks app adds, edits, schedules, stars, completes and reopens a task", async ({ page }) => {
	await page.goto("/tasks");
	await expect(page.getByRole("heading", { name: "My Tasks" })).toBeVisible();
	await expect(page).toHaveTitle(/^Tasks/);

	// The app sits between Calendar and Drive in the apps menu.
	await page.getByRole("button", { name: "Open apps menu" }).click();
	await expect(page.getByRole("link", { name: /^(Inbox|Calendar|Tasks|Drive|Contacts)$/ })).toHaveText(["Inbox", "Calendar", "Tasks", "Drive", "Contacts"]);
	await page.keyboard.press("Escape");

	const add = page.getByRole("textbox", { name: "Add a task" });
	await add.fill("Buy milk");
	await add.press("Enter");
	await add.fill("Call Maya");
	await add.press("Enter");
	await expect.poll(() => shownTitles(page)).toEqual(["Call Maya", "Buy milk"]);
	const { tasks } = api(page);
	const listId = (await api(page).lists())[0].id;
	await expect.poll(async () => (await tasks(`listId=${listId}`)).length).toBe(2);
	const milk = (await tasks(`listId=${listId}`)).find((task) => task.title === "Buy milk")!;
	const milkRow = row(page, milk.id);

	// Title and notes are edited in place.
	const title = milkRow.getByRole("textbox", { name: "Title" });
	const saves: string[] = [];
	page.on("request", (request) => { if (request.method() === "PATCH") saves.push(request.url()); });
	await title.fill("Buy oat milk");
	await title.press("Enter");
	await expect.poll(async () => (await tasks(`listId=${listId}`)).find((task) => task.id === milk.id)?.title).toBe("Buy oat milk");
	// Escape discards what was typed; Enter saved once, not once more on the blur that follows.
	await title.fill("Typed, then cancelled");
	await title.press("Escape");
	await expect(title).toHaveValue("Buy oat milk");
	await expect(title).not.toBeFocused();
	await title.click();
	const notes = milkRow.getByRole("textbox", { name: "Details" });
	await notes.fill("Two litres");
	await page.getByRole("heading", { name: "My Tasks" }).click();
	await expect(notes).toHaveCount(0);
	await expect(milkRow).toContainText("Two litres");
	await expect.poll(async () => (await tasks(`listId=${listId}`)).find((task) => task.id === milk.id)).toMatchObject({ title: "Buy oat milk", notes: "Two litres" });
	expect(saves).toHaveLength(2);

	// Date and repeat: tomorrow, every 2 weeks, 3 times.
	await title.click();
	await milkRow.getByRole("button", { name: "Date and time" }).click();
	const dialog = page.getByRole("dialog", { name: "Date and time" });
	await dialog.getByRole("button", { name: "Tomorrow" }).click();
	await dialog.getByRole("switch", { name: "Repeat" }).click();
	await dialog.getByLabel("Every").fill("2");
	await dialog.getByRole("radio", { name: /^After/ }).check();
	await dialog.getByLabel("Number of times").fill("3");
	await dialog.getByRole("button", { name: "Save" }).click();
	await expect(dialog).toHaveCount(0);
	await expect(milkRow.getByRole("button", { name: /^Due Tomorrow/ })).toBeVisible();
	await expect(milkRow).toContainText("Every 2 weeks, 3 times");
	await expect.poll(async () => (await tasks(`listId=${listId}`)).find((task) => task.id === milk.id)?.repeat).toMatchObject({ freq: "weekly", interval: 2, count: 3 });

	// Starred and Upcoming show it; Today does not.
	await milkRow.hover();
	await milkRow.getByRole("button", { name: "Add star" }).click();
	await page.getByRole("link", { name: "Starred" }).click();
	await expect(page.getByRole("heading", { name: "Starred" })).toBeVisible();
	await expect.poll(() => shownTitles(page)).toEqual(["Buy oat milk"]);
	await page.getByRole("link", { name: "Upcoming" }).click();
	await expect(page.getByRole("heading", { name: "Tomorrow" })).toBeVisible();
	await expect.poll(() => shownTitles(page)).toEqual(["Buy oat milk"]);
	await page.getByRole("link", { name: "Today", exact: true }).click();
	await expect(page.getByText("Nothing due today")).toBeVisible();

	// Completing a repeating task leaves it in Completed and brings up the next occurrence.
	await page.getByRole("link", { name: /^My Tasks/ }).click();
	await milkRow.getByRole("checkbox", { name: "Mark complete" }).click();
	const completed = page.getByRole("button", { name: "Completed (1)" });
	await expect(completed).toBeVisible();
	await expect.poll(async () => (await tasks(`listId=${listId}`)).filter((task) => task.title === "Buy oat milk").map((task) => task.status).sort()).toEqual(["completed", "needs-action"]);
	await expect.poll(() => shownTitles(page)).toEqual(["Call Maya", "Buy oat milk"]);

	// Reopening takes the next occurrence back.
	await completed.click();
	await milkRow.getByRole("checkbox", { name: "Mark incomplete" }).click();
	await expect(completed).toHaveCount(0);
	await expect.poll(async () => (await tasks(`listId=${listId}`)).filter((task) => task.title === "Buy oat milk").map((task) => [task.id, task.status])).toEqual([[milk.id, "needs-action"]]);
});

test("tasks reorder and nest by keyboard and by drag, and take subtasks", async ({ page }) => {
	const { create, tasks, lists } = api(page);
	const listId = (await lists())[0].id;
	// Each new task goes first, so this reads Alpha, Bravo, Charlie.
	const charlie = await create({ title: "Charlie" });
	const bravo = await create({ title: "Bravo" });
	const alpha = await create({ title: "Alpha" });
	await page.goto("/tasks");
	await expect.poll(() => shownTitles(page)).toEqual(["Alpha", "Bravo", "Charlie"]);
	const parentOf = async (id: string) => (await tasks(`listId=${listId}`)).find((task) => task.id === id)?.parentId;

	// Keyboard, from the drag handle: up, in (nest), out.
	await handle(page, charlie.id).focus();
	await page.keyboard.press("ArrowUp");
	await expect.poll(() => shownTitles(page)).toEqual(["Alpha", "Charlie", "Bravo"]);
	await expect(handle(page, charlie.id)).toBeFocused();
	await page.keyboard.press("ArrowRight");
	await expect.poll(() => shownTitles(page)).toEqual(["Alpha", "> Charlie", "Bravo"]);
	await expect.poll(() => parentOf(charlie.id)).toBe(alpha.id);
	await expect(handle(page, charlie.id)).toBeFocused();
	await page.keyboard.press("ArrowLeft");
	await expect.poll(() => shownTitles(page)).toEqual(["Alpha", "Charlie", "Bravo"]);
	await expect.poll(() => parentOf(charlie.id)).toBeNull();
	await page.keyboard.press("ArrowDown");
	await expect.poll(() => shownTitles(page)).toEqual(["Alpha", "Bravo", "Charlie"]);
	await expect.poll(async () => (await tasks(`listId=${listId}`)).map((task) => task.title)).toEqual(["Alpha", "Bravo", "Charlie"]);

	// Drag: Charlie to the top, then Alpha under Charlie (a step to the right nests).
	await dragTask(page, charlie.id, { id: alpha.id, edge: "top" });
	await expect.poll(() => shownTitles(page)).toEqual(["Charlie", "Alpha", "Bravo"]);
	await dragTask(page, alpha.id, { id: charlie.id, edge: "bottom", dx: 40 });
	await expect.poll(() => shownTitles(page)).toEqual(["Charlie", "> Alpha", "Bravo"]);
	await expect.poll(() => parentOf(alpha.id)).toBe(charlie.id);
	await expect.poll(async () => (await tasks(`listId=${listId}`)).map((task) => task.title)).toEqual(["Charlie", "Alpha", "Bravo"]);

	// A subtask from the menu.
	await row(page, bravo.id).hover();
	await page.getByRole("button", { name: "Options for Bravo" }).click();
	await page.getByRole("menuitem", { name: "Add a subtask" }).click();
	const addSubtask = page.getByRole("textbox", { name: "Add a subtask" });
	await expect(addSubtask).toBeFocused();
	await addSubtask.fill("Bravo one");
	await addSubtask.press("Enter");
	await addSubtask.press("Escape");
	await expect.poll(() => shownTitles(page)).toEqual(["Charlie", "> Alpha", "Bravo", "> Bravo one"]);
	await expect.poll(async () => (await tasks(`listId=${listId}`)).find((task) => task.title === "Bravo one")?.parentId).toBe(bravo.id);

	// Deleting a task with subtasks asks first.
	await row(page, charlie.id).hover();
	await page.getByRole("button", { name: "Options for Charlie" }).click();
	await page.getByRole("menuitem", { name: "Delete task" }).click();
	await page.getByRole("dialog").getByRole("button", { name: "Delete" }).click();
	await expect.poll(() => shownTitles(page)).toEqual(["Bravo", "> Bravo one"]);
	await expect.poll(async () => (await tasks(`listId=${listId}`)).map((task) => task.title)).toEqual(["Bravo", "Bravo one"]);
});

test("lists are created, renamed, reordered, cleared and deleted", async ({ page }) => {
	const { lists, tasks } = api(page);
	await page.goto("/tasks");
	await expect(page.getByRole("heading", { name: "My Tasks" })).toBeVisible();

	// The only list cannot be deleted.
	await page.getByRole("button", { name: "Options for My Tasks" }).click();
	await expect(page.getByRole("menuitem", { name: /Delete list/ })).toBeDisabled();
	await page.keyboard.press("Escape");

	await page.getByRole("button", { name: "New list" }).click();
	const newList = page.getByRole("dialog", { name: "New list" });
	await newList.getByRole("textbox", { name: "List name" }).fill("Home");
	await newList.getByRole("button", { name: "Create" }).click();
	await expect(page.getByRole("heading", { name: "Home" })).toBeVisible();
	await expect(page).toHaveURL(/list=/);
	// A new list is empty: it opens ready for its first task.
	await expect(page.getByRole("textbox", { name: "Add a task" })).toBeFocused();

	await page.getByRole("button", { name: "Options for Home" }).click();
	await page.getByRole("menuitem", { name: "Rename list" }).click();
	const rename = page.getByRole("dialog", { name: "Rename list" });
	await rename.getByRole("textbox", { name: "List name" }).fill("House");
	await rename.getByRole("button", { name: "Save" }).click();
	await expect(page.getByRole("heading", { name: "House" })).toBeVisible();
	const navLists = page.getByRole("navigation", { name: "Lists" }).getByRole("link");
	await expect(navLists).toHaveText([/My Tasks/, /House/]);

	// Alt+Up moves the list in the menu, and the link keeps focus.
	await navLists.filter({ hasText: "House" }).focus();
	await page.keyboard.press("Alt+ArrowUp");
	await expect(navLists).toHaveText([/House/, /My Tasks/]);
	await expect(navLists.filter({ hasText: "House" })).toBeFocused();
	await expect.poll(async () => (await lists()).map((list) => list.title)).toEqual(["House", "My Tasks"]);

	// Dragging a list in the menu reorders it too, and the drag is not taken for a click on the list.
	const dragged = (await navLists.filter({ hasText: "My Tasks" }).boundingBox())!;
	const above = (await navLists.filter({ hasText: "House" }).boundingBox())!;
	await page.mouse.move(dragged.x + 40, dragged.y + dragged.height / 2);
	await page.mouse.down();
	await page.mouse.move(dragged.x + 40, dragged.y, { steps: 3 });
	await page.mouse.move(dragged.x + 40, above.y + 2, { steps: 8 });
	await page.mouse.up();
	await expect(navLists).toHaveText([/My Tasks/, /House/]);
	await expect(page.getByRole("heading", { name: "House" })).toBeVisible();
	await expect.poll(async () => (await lists()).map((list) => list.title)).toEqual(["My Tasks", "House"]);
	await navLists.filter({ hasText: "House" }).focus();
	await page.keyboard.press("Alt+ArrowUp");
	await expect.poll(async () => (await lists()).map((list) => list.title)).toEqual(["House", "My Tasks"]);

	// The open count follows the tasks; completed tasks can be deleted in one go.
	const house = (await lists())[0];
	const add = page.getByRole("textbox", { name: "Add a task" });
	await add.fill("Fix the bike light");
	await add.press("Enter");
	await add.fill("Water the plants");
	await add.press("Enter");
	await expect(navLists.filter({ hasText: "House" })).toContainText("2");
	await expect.poll(async () => (await tasks(`listId=${house.id}`)).length).toBe(2);
	const plants = (await tasks(`listId=${house.id}`)).find((task) => task.title === "Water the plants")!;
	await row(page, plants.id).getByRole("checkbox", { name: "Mark complete" }).click();
	await expect(page.getByRole("button", { name: "Completed (1)" })).toBeVisible();
	await expect(navLists.filter({ hasText: "House" })).toContainText("1");
	await page.getByRole("button", { name: "Options for House" }).click();
	await page.getByRole("menuitem", { name: "Delete completed tasks" }).click();
	await page.getByRole("dialog").getByRole("button", { name: "Delete" }).click();
	await expect(page.getByRole("button", { name: /^Completed/ })).toHaveCount(0);
	await expect.poll(async () => (await tasks(`listId=${house.id}`)).map((task) => task.title)).toEqual(["Fix the bike light"]);

	await page.getByRole("button", { name: "Options for House" }).click();
	await page.getByRole("menuitem", { name: "Delete list" }).click();
	await page.getByRole("dialog").getByRole("button", { name: "Delete" }).click();
	await expect(page.getByRole("heading", { name: "My Tasks" })).toBeVisible();
	await expect(navLists).toHaveText([/My Tasks/]);
	await expect.poll(async () => (await lists()).map((list) => list.title)).toEqual(["My Tasks"]);
});

test("the Tasks panel opens in Mail and Calendar, one panel at a time, and on request", async ({ page }) => {
	const { create, createList, tasks, lists } = api(page);
	const other = await createList("Errands");
	const focusMe = await create({ title: "Pick up the parcel", listId: other.id });
	const mainList = (await lists())[0];

	await page.goto("/inbox");
	const toggle = page.locator('[aria-controls="tasks-side-panel"]');
	const panel = page.locator("#tasks-side-panel");
	await expect(panel).toHaveCount(0);
	await toggle.click();
	await expect(panel).toBeVisible();
	await expect(toggle).toHaveAttribute("aria-expanded", "true");
	await expect(panel.getByRole("button", { name: /^List: My Tasks/ })).toBeVisible();

	const add = panel.getByRole("textbox", { name: "Add a task" });
	await add.fill("From the panel");
	await add.press("Enter");
	await expect.poll(async () => (await tasks(`listId=${mainList.id}`)).map((task) => task.title)).toEqual(["From the panel"]);

	// The dock holds the Assistant or Tasks, never both.
	const assistantToggle = page.locator('[aria-controls="email-assistant-panel"]');
	const assistant = page.locator("#email-assistant-panel");
	if (await assistantToggle.count()) {
		await assistantToggle.click();
		await expect(panel).toHaveCount(0);
		await expect(assistant).toBeVisible();
		await expect(toggle).toHaveAttribute("aria-expanded", "false");
		await toggle.click();
		await expect(panel).toBeVisible();
		await expect(assistant).toBeHidden();
		await expect(assistantToggle).toHaveAttribute("aria-expanded", "false");
	}

	// The list switcher.
	await panel.getByRole("button", { name: /^List: My Tasks/ }).click();
	await page.getByRole("menuitem", { name: /Errands/ }).click();
	await expect(panel.getByRole("textbox", { name: "Title" })).toHaveValue("Pick up the parcel");
	await panel.getByRole("button", { name: /^List: Errands/ }).click();
	await page.getByRole("menuitem", { name: /My Tasks/ }).click();
	await expect(panel.getByRole("textbox", { name: "Title" })).toHaveValue("From the panel");

	// Closed, it opens again when something asks for a task: on that task's list, with the cursor in it.
	await panel.getByRole("button", { name: "Close tasks" }).click();
	await expect(panel).toHaveCount(0);
	await page.evaluate((taskId) => window.dispatchEvent(new CustomEvent("mailflare:tasks-open-panel", { detail: { taskId } })), focusMe.id);
	await expect(panel).toBeVisible();
	await expect(panel.getByRole("button", { name: /^List: Errands/ })).toBeVisible();
	await expect(row(page, focusMe.id).getByRole("textbox", { name: "Title" })).toBeFocused();

	// And on a list, when asked for one.
	await page.evaluate((listId) => window.dispatchEvent(new CustomEvent("mailflare:tasks-open-panel", { detail: { listId } })), mainList.id);
	await expect(panel.getByRole("button", { name: /^List: My Tasks/ })).toBeVisible();

	// And on a smart view (the calendar's pending-tasks chip asks for Today); a list chip there switches back to the list.
	await page.evaluate(() => window.dispatchEvent(new CustomEvent("mailflare:tasks-open-panel", { detail: { view: "starred" } })));
	await expect(panel.getByRole("button", { name: /^List: Starred/ })).toBeVisible();
	await expect(panel.getByText("No starred tasks")).toBeVisible();
	await panel.getByRole("button", { name: /^List: Starred/ }).click();
	await page.getByRole("menuitem", { name: "Today" }).click();
	await expect(panel.getByText("Nothing due today")).toBeVisible();

	// Calendar has the same dock, and remembers that the panel was open.
	await page.goto("/calendar");
	await expect(panel).toBeVisible();
	await expect(panel.getByRole("textbox", { name: "Title" })).toHaveValue("From the panel");
	await page.locator('[aria-controls="tasks-side-panel"]').click();
	await expect(panel).toHaveCount(0);

	// A link to a task opens the app on its list with the cursor in the task.
	await page.goto(`/tasks?task=${focusMe.id}`);
	await expect(page.getByRole("heading", { name: "Errands" })).toBeVisible();
	await expect(row(page, focusMe.id).getByRole("textbox", { name: "Title" })).toBeFocused();
	await expect(page).not.toHaveURL(/task=/);
});

test("a task added in Starred, Today or Upcoming goes to the list used last", async ({ page }) => {
	const { createList, tasks, lists } = api(page);
	const main = (await lists())[0];
	const errands = await createList("Errands");
	const created = async (title: string) => (await tasks("completed=0")).find((task) => task.title === title);

	// Nothing is remembered in a fresh browser: the first list.
	await page.goto("/tasks?view=starred");
	const add = page.getByRole("textbox", { name: "Add a task" });
	await add.fill("Before any list");
	await add.press("Enter");
	await expect.poll(async () => (await created("Before any list"))?.listId).toBe(main.id);

	// Opening a list makes it the one used last, and every smart view adds to it.
	await page.getByRole("navigation", { name: "Lists" }).getByRole("link", { name: /Errands/ }).click();
	await expect(page.getByRole("heading", { name: "Errands", level: 1 })).toBeVisible();
	for (const [view, title] of [["Starred", "A starred errand"], ["Today", "An errand for today"], ["Upcoming", "An errand for tomorrow"]]) {
		await page.getByRole("navigation", { name: "Views" }).getByRole("link", { name: view }).click();
		await expect(page.getByRole("heading", { name: view, level: 1 })).toBeVisible();
		await add.fill(title);
		await add.press("Enter");
		await expect.poll(async () => (await created(title))?.listId).toBe(errands.id);
		// The row says where the task went.
		await expect(row(page, (await created(title))!.id).getByRole("link", { name: "Errands" })).toBeVisible();
	}
	expect(await created("A starred errand")).toMatchObject({ starred: true, dueDate: null });
	expect((await created("An errand for today"))?.dueDate).not.toBeNull();

	// The side panel follows the same rule.
	await page.goto("/inbox");
	await page.locator('[aria-controls="tasks-side-panel"]').click();
	const panel = page.locator("#tasks-side-panel");
	await panel.getByRole("button", { name: /^List: Errands/ }).click();
	await page.getByRole("menuitem", { name: "Today" }).click();
	const panelAdd = panel.getByRole("textbox", { name: "Add a task" });
	await panelAdd.fill("From the panel's Today");
	await panelAdd.press("Enter");
	await expect.poll(async () => (await created("From the panel's Today"))?.listId).toBe(errands.id);

	// A remembered list that is gone (deleted on another device) falls back to the first list.
	await page.evaluate(() => window.localStorage.setItem("mailflare.tasks.lastList", "tl_gone"));
	await panelAdd.fill("After the list was deleted");
	await panelAdd.press("Enter");
	await expect.poll(async () => (await created("After the list was deleted"))?.listId).toBe(main.id);
});

test("crowded timed tasks merge into one chip on the calendar, which opens their day in the panel", async ({ page }) => {
	const { create, tasks } = api(page);
	await page.setViewportSize({ width: 1280, height: 800 });
	await page.goto("/calendar");
	// Today in the browser's zone, which is the zone the calendar draws in.
	const { date, timeZone } = await page.evaluate(() => {
		const now = new Date();
		const pad = (value: number) => String(value).padStart(2, "0");
		return { date: `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone };
	});
	// Three tasks within twenty minutes, and one with the morning to itself.
	for (const [title, time] of [["Send invoice", "12:20"], ["Call the bank", "12:15"], ["Book flights", "12:00"], ["Water the plants", "08:00"]]) await create({ title, due: { date, time, timeZone } });
	await page.reload();
	const options = page.getByRole("button", { name: "Calendar options" });
	await options.click();
	await page.getByRole("menuitem", { name: "Week" }).click();

	// A week column cannot show three chips side by side: they are one chip, in time order.
	const grid = page.getByRole("main");
	const merged = grid.getByRole("button", { name: "3 tasks: Book flights, Call the bank, Send invoice" });
	await expect(merged).toBeVisible();
	await expect(merged).toHaveText("3 tasks");
	await expect(grid.getByRole("checkbox", { name: 'Mark "Book flights" complete' })).toHaveCount(0);
	// A task with room to itself is drawn as before.
	await expect(grid.getByRole("checkbox", { name: 'Mark "Water the plants" complete' })).toBeVisible();
	expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(1280);

	// The chip opens the Tasks panel on that day: every task due then, in the order of the day.
	await merged.click();
	const panel = page.locator("#tasks-side-panel");
	await expect(panel).toBeVisible();
	await expect(panel.getByRole("button", { name: /^List: \w{3}, \w{3} \d{1,2}\./ })).toBeVisible();
	await expect.poll(() => shownTitles(page)).toEqual(["Water the plants", "Book flights", "Call the bank", "Send invoice"]);
	await expect(panel.getByRole("link", { name: "Open in Tasks" })).toHaveAttribute("href", `/tasks?date=${date}`);
	// The panel takes room from the columns; the tasks stay merged.
	await expect(merged).toBeVisible();

	// A task added to a day is due that day.
	const add = panel.getByRole("textbox", { name: "Add a task" });
	await add.fill("Also today");
	await add.press("Enter");
	await expect.poll(async () => (await tasks(`dueFrom=${date}&dueTo=${date}`)).find((task) => task.title === "Also today")?.dueDate).toBe(date);

	// The day view has room for the three, each with its own checkbox.
	await options.click();
	await page.getByRole("menuitem", { name: "Day" }).click();
	await expect(grid.getByRole("checkbox", { name: 'Mark "Book flights" complete' })).toBeVisible();
	await expect(grid.getByRole("checkbox", { name: 'Mark "Send invoice" complete' })).toBeVisible();
	await expect(grid.getByRole("button", { name: /^3 tasks/ })).toHaveCount(0);

	// The same day in the Tasks app.
	await page.goto(`/tasks?date=${date}`);
	await expect.poll(() => shownTitles(page)).toEqual(["Also today", "Water the plants", "Book flights", "Call the bank", "Send invoice"]);
});

test("on a phone the menu drawer holds the lists and the panel covers the page", async ({ page }) => {
	const { createList, create } = api(page);
	const errands = await createList("Errands");
	await create({ title: "Pick up the parcel", listId: errands.id });
	await page.setViewportSize({ width: 390, height: 844 });

	await page.goto("/tasks");
	await expect(page.getByRole("heading", { name: "My Tasks" })).toBeVisible();
	const drawerLink = page.getByRole("navigation", { name: "Lists" }).getByRole("link", { name: /Errands/ });
	await expect(drawerLink).not.toBeInViewport();
	await page.getByRole("button", { name: "Open menu" }).click();
	await expect(drawerLink).toBeInViewport();
	await drawerLink.click();
	await expect(page.getByRole("heading", { name: "Errands" })).toBeVisible();
	await expect(drawerLink).not.toBeInViewport();
	await expect(page.getByRole("textbox", { name: "Title" })).toHaveValue("Pick up the parcel");
	// Nothing spills past the screen.
	expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);

	// Create puts the cursor in the add box.
	await page.getByRole("button", { name: "Open menu" }).click();
	await page.getByRole("button", { name: "Create" }).click();
	await expect(page.getByRole("textbox", { name: "Add a task" })).toBeFocused();

	// New list: the drawer gets out of the way of its dialog.
	await page.getByRole("button", { name: "Open menu" }).click();
	await page.getByRole("button", { name: "New list" }).click();
	const newList = page.getByRole("dialog", { name: "New list" });
	await expect(drawerLink).not.toBeInViewport();
	await newList.getByRole("textbox", { name: "List name" }).fill("Packing");
	await newList.getByRole("button", { name: "Create" }).click();
	await expect(page.getByRole("heading", { name: "Packing" })).toBeVisible();

	// Mail: no header button at this width, but the panel still opens on request and covers the page.
	await page.goto("/inbox");
	await expect(page.locator('[aria-controls="tasks-side-panel"]')).toHaveCount(1);
	await expect(page.locator('[aria-controls="tasks-side-panel"]')).toBeHidden();
	// The header has room for its controls: the search button sits beside the logo, not on top of it.
	const header = page.locator("header").first();
	const logo = (await header.getByRole("link", { name: "Inbox", exact: true }).boundingBox())!;
	const search = (await header.getByRole("button", { name: "Search mail" }).boundingBox())!;
	expect(search.x).toBeGreaterThanOrEqual(logo.x + logo.width);
	const compose = page.getByRole("button", { name: "Compose" });
	await expect(compose).toBeVisible();
	await page.evaluate((listId) => window.dispatchEvent(new CustomEvent("mailflare:tasks-open-panel", { detail: { listId } })), errands.id);
	const panel = page.locator("#tasks-side-panel");
	await expect(panel).toBeVisible();
	await expect.poll(async () => Math.round((await panel.boundingBox())?.width ?? 0)).toBe(390);
	// The phone Compose button would lie on top of the panel.
	await expect(compose).toBeHidden();
	await expect(panel.getByRole("textbox", { name: "Title" })).toHaveValue("Pick up the parcel");
	await panel.getByRole("button", { name: "Close tasks" }).click();
	await expect(panel).toHaveCount(0);
	await expect(compose).toBeVisible();
});
