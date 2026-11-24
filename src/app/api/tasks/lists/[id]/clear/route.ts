import { NextResponse } from "next/server";
import { clearCompletedTasks } from "@/lib/tasks/service";
import { withTaskUser } from "../../../utils";

/** Deletes the completed tasks of a list. */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	return withTaskUser(request, async ({ env, user }) => NextResponse.json(await clearCompletedTasks(env, user, id)));
}
