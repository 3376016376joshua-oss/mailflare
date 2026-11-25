import { NextResponse } from "next/server";
import { updateTaskListSchema } from "@/lib/tasks/schemas";
import { deleteTaskList, updateTaskList } from "@/lib/tasks/service";
import { readBody, withTaskUser } from "../../utils";

type Params = { params: Promise<{ id: string }> };

/** Renames a list (`title`) and/or moves it after another (`previousId`, null = first). */
export async function PATCH(request: Request, { params }: Params) {
	const { id } = await params;
	return withTaskUser(request, async ({ env, user }) => NextResponse.json({ list: await updateTaskList(env, user, id, await readBody(request, updateTaskListSchema)) }));
}

/** Deletes a list and its tasks; 409 `LAST_LIST` for the only list. */
export async function DELETE(request: Request, { params }: Params) {
	const { id } = await params;
	return withTaskUser(request, async ({ env, user }) => {
		await deleteTaskList(env, user, id);
		return NextResponse.json({ ok: true });
	});
}
