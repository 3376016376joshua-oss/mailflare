import { expect, test, type APIRequestContext } from "@playwright/test";

// The tasks REST API (src/app/api/tasks) against a running instance: the route layer on the real
// database binding. The rules behind it are covered in tests/local-tasks.test.mjs.
// Like the other specs, it resets the demo account; run it only against a disposable instance.

const EMAIL = "admin@example.com";
const PASSWORD = "demo-password-change-me";

let headers: Record<string, string>;
let origin: string;

async function resetDemo(request: APIRequestContext) {
	const response = await request.post("/api/seed?reset=1");
	expect(response.ok(), `POST /api/seed?reset=1 returned ${response.status()}`).toBe(true);
}

test.beforeAll(async ({ request, baseURL }) => {
	origin = new URL(baseURL ?? "http://localhost:3000").origin;
	// A configured installation answers 403; a dev server without Cloudflare credentials answers 503 once migrated.
	const prepared = await request.post("/api/setup/prepare");
	expect([200, 403, 503]).toContain(prepared.status());
	await resetDemo(request);
	const login = await request.post("/api/auth/login", { headers: { Origin: origin }, data: { email: EMAIL, password: PASSWORD } });
	expect(login.ok(), `login returned ${login.status()}`).toBe(true);
	headers = { Authorization: `Bearer ${(await login.json()).token}`, "X-Time-Zone": "UTC" };
});

test.afterAll(async ({ request }) => {
	await resetDemo(request);
	await request.delete("/api/seed/local-user");
});

test("tasks need a session", async ({ playwright, baseURL }) => {
	const anonymous = await playwright.request.newContext({ baseURL });
	try {
		expect((await anonymous.get("/api/tasks/lists")).status()).toBe(401);
		expect((await anonymous.get("/api/tasks?view=today")).status()).toBe(401);
		expect((await anonymous.post("/api/tasks", { headers: { Origin: origin }, data: { title: "x" } })).status()).toBe(401);
	} finally {
		await anonymous.dispose();
	}
});

test("another account cannot read or change this account's tasks and lists", async ({ request }) => {
	const mine = await (await request.get("/api/tasks/lists", { headers })).json();
	const listId: string = mine.lists[0].id;
	const task = (await (await request.post("/api/tasks", { headers, data: { title: "Private errand", notes: "for my eyes", starred: true, due: { date: "2030-03-04" } } })).json()).task;

	// A second, ordinary account on the same installation (dev-only route; see src/app/api/seed/local-user).
	const created = await request.post("/api/seed/local-user");
	expect(created.ok(), `POST /api/seed/local-user returned ${created.status()}`).toBe(true);
	const { credentials } = await created.json();
	const login = await request.post("/api/auth/login", { headers: { Origin: origin }, data: credentials });
	expect(login.ok(), `second login returned ${login.status()}`).toBe(true);
	const other = { Authorization: `Bearer ${(await login.json()).token}`, "X-Time-Zone": "UTC" };

	const refusals: Array<[string, Promise<{ status(): number; json(): Promise<{ code?: string }> }>]> = [
		["read the task", request.get(`/api/tasks/${task.id}`, { headers: other })],
		["edit the task", request.patch(`/api/tasks/${task.id}`, { headers: other, data: { title: "taken", completed: true } })],
		["move the task", request.post(`/api/tasks/${task.id}/move`, { headers: other, data: { parentId: null } })],
		["delete the task", request.delete(`/api/tasks/${task.id}`, { headers: other })],
		["add a task to the list", request.post("/api/tasks", { headers: other, data: { title: "intruder", listId } })],
		["add a subtask to the task", request.post("/api/tasks", { headers: other, data: { title: "intruder", parentId: task.id } })],
		["rename the list", request.patch(`/api/tasks/lists/${listId}`, { headers: other, data: { title: "taken" } })],
		["clear the list", request.post(`/api/tasks/lists/${listId}/clear`, { headers: other })],
		["delete the list", request.delete(`/api/tasks/lists/${listId}`, { headers: other })],
	];
	for (const [what, pending] of refusals) {
		const response = await pending;
		expect([what, response.status(), (await response.json()).code]).toEqual([what, 404, "NOT_FOUND"]);
	}

	// What the second account can list is its own: one empty default list, and no task under any filter.
	const theirs = await (await request.get("/api/tasks/lists", { headers: other })).json();
	expect(theirs.lists.map((list: { title: string; openCount: number }) => [list.title, list.openCount])).toEqual([["My Tasks", 0]]);
	expect(theirs.lists[0].id).not.toBe(listId);
	for (const query of [`listId=${listId}`, "view=starred", "view=upcoming", "dueFrom=2030-03-01&dueTo=2030-03-31", ""]) {
		const body = await (await request.get(`/api/tasks?${query}`, { headers: other })).json();
		expect([query, body.tasks, body.occurrences]).toEqual([query, [], []]);
	}
	// Moving its own task into the first account's list, or under its task, is refused too.
	const own = (await (await request.post("/api/tasks", { headers: other, data: { title: "Mine" } })).json()).task;
	expect((await request.post(`/api/tasks/${own.id}/move`, { headers: other, data: { listId } })).status()).toBe(404);
	expect((await request.post(`/api/tasks/${own.id}/move`, { headers: other, data: { parentId: task.id } })).status()).toBe(404);

	// The first account's task and list are as it left them.
	expect((await (await request.get(`/api/tasks/${task.id}`, { headers })).json()).task).toMatchObject({ title: "Private errand", notes: "for my eyes", status: "needs-action", listId, parentId: null });
	const after = await (await request.get("/api/tasks/lists", { headers })).json();
	expect(after.lists.map((list: { id: string; title: string; openCount: number }) => [list.id, list.title, list.openCount])).toEqual([[listId, "My Tasks", 1]]);
	expect((await request.delete(`/api/tasks/${task.id}`, { headers })).status()).toBe(200);
});

test("lists, tasks, subtasks, moves and views work end to end", async ({ request }) => {
	const lists = await (await request.get("/api/tasks/lists", { headers })).json();
	expect(lists.migrationRequired).toBe(false);
	expect(lists.lists.map((list: { title: string }) => list.title)).toEqual(["My Tasks"]);
	const listId: string = lists.lists[0].id;

	const create = async (data: object) => {
		const response = await request.post("/api/tasks", { headers, data });
		expect(response.status()).toBe(201);
		return (await response.json()).task;
	};
	const titles = async (query: string) => (await (await request.get(`/api/tasks?${query}`, { headers })).json()).tasks.map((task: { title: string }) => task.title);

	const trip = await create({ title: "Plan trip" });
	const flights = await create({ title: "Book flights", parentId: trip.id });
	const starred = await create({ title: "Call Maya", starred: true });
	expect(flights.listId).toBe(listId);
	expect(await titles(`listId=${listId}`)).toEqual(["Call Maya", "Plan trip", "Book flights"]);
	expect(await titles("view=starred")).toEqual(["Call Maya"]);

	// Reorder, un-nest, complete.
	const moved = await request.post(`/api/tasks/${starred.id}/move`, { headers, data: { previousId: trip.id } });
	expect(moved.status()).toBe(200);
	expect(await titles(`listId=${listId}&completed=0`)).toEqual(["Plan trip", "Book flights", "Call Maya"]);
	expect((await (await request.post(`/api/tasks/${flights.id}/move`, { headers, data: { parentId: null } })).json()).task.parentId).toBeNull();
	const completed = await (await request.patch(`/api/tasks/${trip.id}`, { headers, data: { completed: true } })).json();
	expect(completed.task.status).toBe("completed");
	expect(await titles(`listId=${listId}&completed=1`)).toEqual(["Plan trip"]);
	expect(await titles(`listId=${listId}&completed=0`)).toEqual(["Book flights", "Call Maya"]);

	// Lists: add, rename and reorder, clear completed, delete.
	const home = (await (await request.post("/api/tasks/lists", { headers, data: { title: "Home" } })).json()).list;
	const renamed = await request.patch(`/api/tasks/lists/${home.id}`, { headers, data: { title: "House", previousId: null } });
	expect((await renamed.json()).list.title).toBe("House");
	expect((await (await request.get("/api/tasks/lists", { headers })).json()).lists.map((list: { title: string; openCount: number }) => [list.title, list.openCount])).toEqual([["House", 0], ["My Tasks", 2]]);
	expect(await (await request.post(`/api/tasks/lists/${listId}/clear`, { headers })).json()).toEqual({ removed: 1 });
	expect((await request.delete(`/api/tasks/lists/${home.id}`, { headers })).status()).toBe(200);
	const last = await request.delete(`/api/tasks/lists/${listId}`, { headers });
	expect([last.status(), (await last.json()).code]).toEqual([409, "LAST_LIST"]);

	expect(await (await request.delete(`/api/tasks/${starred.id}`, { headers })).json()).toEqual({ removedIds: [starred.id] });
	expect((await request.get(`/api/tasks/${starred.id}`, { headers })).status()).toBe(404);
});

test("a repeating task advances when completed and shows in a calendar window", async ({ request }) => {
	const response = await request.post("/api/tasks", { headers, data: { title: "Water plants", due: { date: "2030-03-04", time: "08:00", timeZone: "UTC" }, repeat: { freq: "weekly", count: 3 } } });
	const first = (await response.json()).task;
	expect(first.repeat).toEqual({ freq: "weekly", interval: 1, until: null, count: 3, index: 0 });
	expect(first.dueAt).toBe("2030-03-04T08:00:00.000Z");

	const week = await (await request.get("/api/tasks?dueFrom=2030-03-04&dueTo=2030-03-31", { headers })).json();
	expect(week.tasks.map((task: { title: string }) => task.title)).toEqual(["Water plants"]);
	expect(week.occurrences.map((occurrence: { dueDate: string }) => occurrence.dueDate)).toEqual(["2030-03-11", "2030-03-18"]);
	expect(await (await request.get("/api/tasks?view=upcoming", { headers })).json()).toMatchObject({ tasks: [{ id: first.id }] });

	const done = await (await request.patch(`/api/tasks/${first.id}`, { headers, data: { completed: true } })).json();
	expect(done.task.repeat).toBeNull();
	expect(done.next).toMatchObject({ dueDate: "2030-03-11", dueAt: "2030-03-11T08:00:00.000Z", repeat: { index: 1, count: 3 }, seriesId: first.id });

	// Undo takes the untouched next occurrence back.
	const undone = await (await request.patch(`/api/tasks/${first.id}`, { headers, data: { completed: false } })).json();
	expect(undone.removedIds).toEqual([done.next.id]);
	expect(undone.task.repeat).toMatchObject({ freq: "weekly", index: 0 });
});

test("an email becomes a task that links back to it", async ({ request }) => {
	const inbox = await (await request.get("/api/messages?status=received&limit=1", { headers })).json();
	const message = inbox.messages[0];
	const created = await (await request.post("/api/tasks", { headers, data: { messageId: message.id } })).json();
	expect(created.task.title).toBe(message.subject);
	expect(created.task.message).toEqual({ id: message.id, subject: message.subject });
	const linked = await (await request.get(`/api/tasks?messageId=${message.id}`, { headers })).json();
	expect(linked.tasks.map((task: { id: string }) => task.id)).toEqual([created.task.id]);
	expect((await request.post("/api/tasks", { headers, data: { messageId: "msg_missing" } })).status()).toBe(404);
});

test("invalid requests are refused with a reason", async ({ request }) => {
	const cases: Array<[object | Buffer, RegExp]> = [
		[{ title: "   " }, /title/],
		[{ title: "x", due: { date: "2030-02-30" } }, /due\.date/],
		[{ title: "x", repeat: { freq: "daily" } }, /needs a date/],
		[{ title: "x", parentId: "tsk_missing" }, /Parent task not found/],
		[Buffer.from("{not json"), /JSON/],
		[["a", "list"], /expected object/],
	];
	for (const [data, reason] of cases) {
		const response = Buffer.isBuffer(data)
			? await request.post("/api/tasks", { headers: { ...headers, "Content-Type": "application/json" }, data })
			: await request.post("/api/tasks", { headers, data });
		const body = await response.json();
		expect(response.status(), String(reason)).toBeGreaterThanOrEqual(400);
		expect(body.error).toMatch(reason);
		expect(["INVALID", "NOT_FOUND"]).toContain(body.code);
	}
	expect((await request.get("/api/tasks?view=someday", { headers })).status()).toBe(400);
	expect((await request.get("/api/tasks?dueFrom=2030-01-01&dueTo=2031-06-01", { headers })).status()).toBe(400);
	expect((await request.patch("/api/tasks/tsk_missing", { headers, data: { title: "x" } })).status()).toBe(404);
});
