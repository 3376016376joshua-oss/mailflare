import { NextResponse } from "next/server";
import { moveTaskSchema } from "@/lib/tasks/schemas";
import { moveTask } from "@/lib/tasks/service";
import { readBody, withTaskUser } from "../../utils";

/** Moves a task: `listId`, `parentId` (null = top level) and `previousId`, the sibling to follow (null or omitted = first). */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	return withTaskUser(request, async ({ env, user }) => NextResponse.json(await moveTask(env, user, id, await readBody(request, moveTaskSchema))));
}
