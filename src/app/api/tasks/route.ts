import { NextResponse } from "next/server";
import { createTaskSchema, taskQuerySchema } from "@/lib/tasks/schemas";
import { createTask, listTasks } from "@/lib/tasks/service";
import { readBody, withTaskUser } from "./utils";

const FLAGS: Record<string, boolean> = { "1": true, true: true, "0": false, false: false };

/**
 * Lists the user's tasks. Filters combine with AND: `listId`, `view` (`starred`, `today`, `upcoming`:
 * open tasks across all lists; `completed`: completed tasks across all lists), `dueFrom` / `dueTo`
 * (inclusive dates in the viewer's zone; with both, `occurrences` projects repeating tasks into the
 * window), `messageId`, `completed` (`1` or `0`), `q` (text search in titles and notes).
 */
export async function GET(request: Request) {
	return withTaskUser(request, async ({ env, user }) => {
		const params = new URL(request.url).searchParams;
		const text = (name: string) => params.get(name) || undefined;
		const completed = params.get("completed");
		const query = taskQuerySchema.parse({
			listId: text("listId"),
			view: text("view"),
			dueFrom: text("dueFrom"),
			dueTo: text("dueTo"),
			messageId: text("messageId"),
			completed: completed === null || completed === "" ? undefined : FLAGS[completed] ?? completed,
			// A search box left with only spaces in it is no search.
			q: params.get("q")?.trim() || undefined,
		});
		return NextResponse.json(await listTasks(env, user, query));
	});
}

export async function POST(request: Request) {
	return withTaskUser(request, async ({ env, user }) => NextResponse.json(await createTask(env, user, await readBody(request, createTaskSchema)), { status: 201 }));
}
