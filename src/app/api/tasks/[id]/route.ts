import { NextResponse } from "next/server";
import { updateTaskSchema } from "@/lib/tasks/schemas";
import { deleteTask, getTask, updateTask } from "@/lib/tasks/service";
import { readBody, withTaskUser } from "../utils";

type Params = { params: Promise<{ id: string }> };

export async function GET(request: Request, { params }: Params) {
	const { id } = await params;
	return withTaskUser(request, async ({ env, user }) => {
		const task = await getTask(env, user, id);
		return task ? NextResponse.json({ task }) : NextResponse.json({ error: "Task not found", code: "NOT_FOUND" }, { status: 404 });
	});
}

/** Edits title, notes, due date, repeat rule and star, and completes (`completed: true`) or reopens a task. */
export async function PATCH(request: Request, { params }: Params) {
	const { id } = await params;
	return withTaskUser(request, async ({ env, user }) => NextResponse.json(await updateTask(env, user, id, await readBody(request, updateTaskSchema))));
}

export async function DELETE(request: Request, { params }: Params) {
	const { id } = await params;
	return withTaskUser(request, async ({ env, user }) => NextResponse.json(await deleteTask(env, user, id)));
}
