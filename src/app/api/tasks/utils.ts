import { NextResponse } from "next/server";
import { ZodError, type z } from "zod";
import { requireSessionUser } from "@/lib/api/auth";
import { getEnv } from "@/lib/cloudflare";
import { firstIssue } from "@/lib/tasks/schemas";
import { TaskError } from "@/lib/tasks/service";
import type { TaskUser } from "@/lib/tasks/service";
import type { TaskErrorCode } from "@/lib/tasks/types";
import { getRequestTimeZone } from "@/lib/time/utils";

export type TaskRouteContext = {
	env: CloudflareEnv;
	/** The signed-in user, with the time zone this request works in (the account's, else the browser's). */
	user: TaskUser;
};

const STATUS: Record<TaskErrorCode, number> = { INVALID: 400, NOT_FOUND: 404, LAST_LIST: 409, MIGRATION_REQUIRED: 409 };

/**
 * Runs a tasks route for the signed-in user (session only; cookie mutations are origin-checked by
 * `getCurrentUser`) and turns the service's errors into responses: `{ error, code }` with 400 for
 * invalid input, 404, and 409 `MIGRATION_REQUIRED` before migration 9000_local_tasks is applied.
 */
export async function withTaskUser(request: Request, handle: (context: TaskRouteContext) => Promise<NextResponse>): Promise<NextResponse> {
	const env = getEnv();
	const { user, error } = await requireSessionUser(env, request);
	if (error) return error;
	try {
		return await handle({ env, user: { id: user.id, email: user.email, role: user.role, timeZone: getRequestTimeZone(request, user.timeZone) } });
	} catch (caught) {
		if (caught instanceof TaskError) return NextResponse.json({ error: caught.message, code: caught.code }, { status: STATUS[caught.code] });
		if (caught instanceof ZodError) return NextResponse.json({ error: firstIssue(caught), code: "INVALID" satisfies TaskErrorCode }, { status: 400 });
		throw caught;
	}
}

/** The request's JSON body, validated; a missing or malformed body fails validation (400). */
export async function readBody<Schema extends z.ZodType>(request: Request, schema: Schema): Promise<z.infer<Schema>> {
	let body: unknown;
	try {
		body = await request.json();
	} catch {
		throw new TaskError("INVALID", "Send a JSON body");
	}
	return schema.parse(body);
}
