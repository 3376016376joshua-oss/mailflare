import { NextResponse } from "next/server";
import { createTaskListSchema } from "@/lib/tasks/schemas";
import { createTaskList, listTaskLists } from "@/lib/tasks/service";
import { readBody, withTaskUser } from "../utils";

/** The user's lists in order, each with its open-task count. The first call creates "My Tasks". */
export async function GET(request: Request) {
	return withTaskUser(request, async ({ env, user }) => NextResponse.json(await listTaskLists(env, user)));
}

export async function POST(request: Request) {
	return withTaskUser(request, async ({ env, user }) => NextResponse.json({ list: await createTaskList(env, user, await readBody(request, createTaskListSchema)) }, { status: 201 }));
}
