import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { users } from "@/db/schema";
import { hashPassword } from "@/lib/auth/password";
import { getEnv } from "@/lib/cloudflare";
import { newId } from "@/lib/ids";
import { demoCredentials } from "@/lib/seed-utils";

// Local fork: a second, ordinary account for tests that need two users (tests/e2e/local-tasks-api.spec.ts).
// Creating accounts through /api/accounts takes a license, which a disposable test instance does not have.
// Like /api/seed, this does not exist in production.

const secondUser = { email: "second@example.com", password: demoCredentials.password };

async function removeSecondUser(env: CloudflareEnv) {
	const db = getDb(env);
	// Marked deleted first, as /api/seed?reset=1 does, so the hard delete matches a real account purge.
	await db.update(users).set({ deletedAt: new Date() }).where(eq(users.email, secondUser.email));
	await db.delete(users).where(eq(users.email, secondUser.email));
}

const unavailable = () => NextResponse.json({ error: "Not available in production" }, { status: 403 });

/** Creates the second account afresh: whatever a previous run left on it (sessions, tasks) is gone. */
export async function POST() {
	if (process.env.NODE_ENV === "production") return unavailable();
	const env = getEnv();
	await removeSecondUser(env);
	await getDb(env).insert(users).values({
		id: newId("usr"), email: secondUser.email, passwordHash: hashPassword(secondUser.password), name: "Second User", role: "user", remoteContentMode: "ask",
	});
	return NextResponse.json({ ok: true, credentials: secondUser });
}

export async function DELETE() {
	if (process.env.NODE_ENV === "production") return unavailable();
	await removeSecondUser(getEnv());
	return NextResponse.json({ ok: true });
}
