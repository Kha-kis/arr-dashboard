import { createHash } from "node:crypto";
import fastifyCookie from "@fastify/cookie";
import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ApiEnv } from "../../../config/env.js";
import { registerAuthRoutes } from "../../../routes/auth.js";
import {
	closeScopedWriteFixtures,
	createScopedWriteFixture,
	interceptScopedWriteCompetition,
	recordScopedWriteEvidence,
	snapshotProtectedRows,
} from "../../__tests__/scoped-write-intent-fixture.js";
import { hashPassword } from "../../auth/password.js";
import { SessionService } from "../../auth/session.js";
import { RestoreRuntimeAdmissionError } from "../restore-runtime-admission.js";
import * as publication from "../restore-runtime-client.js";

// Only external warming is suppressed. Authentication, admission, native SQL,
// transaction outcomes and cookie signing remain the production implementations.
vi.mock("../../arr/connection-warmer.js", () => ({
	warmConnectionsForUser: vi.fn().mockResolvedValue(undefined),
}));

afterEach(closeScopedWriteFixtures);

const env = {
	PASSWORD_POLICY: "relaxed",
	SESSION_COOKIE_NAME: "fixture_session",
	SESSION_TTL_HOURS: 24,
	TRUST_PROXY: false,
} as ApiEnv;
const password = "Synthetic-auth-only-123!";

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

/**
 * Advance only the publication acquisition clock pair, after real admission.
 * No timer, native start, guard, callback or transaction result is replaced.
 * This proves the recorded remaining-budget branch, not QA timing/throughput.
 */
function expireBudgets(refusals: number, onBegin?: () => void) {
	const now = performance.now.bind(performance);
	let calls = 0;
	let offset = 0;
	let refusedAt: number | undefined;
	const begins: number[] = [];
	const clock = vi.spyOn(performance, "now").mockImplementation(() => {
		const stack = new Error().stack ?? "";
		if (/\bat (?:Object\.)?publicationTransaction \(/.test(stack)) {
			calls++;
			if (calls % 2 === 1) {
				begins.push(now());
				onBegin?.();
			} else if (calls / 2 <= refusals) {
				offset += 2001;
				refusedAt = now();
			}
		}
		return now() + offset;
	});
	return {
		stop: () => clock.mockRestore(),
		get attempts() {
			return calls / 2;
		},
		receipt: () => ({ attempts: calls / 2, begins, refusedAt }),
	};
}

async function setup() {
	const f = await createScopedWriteFixture();
	interceptScopedWriteCompetition(f);
	return { f, service: new SessionService(f.client.prisma, env) };
}

async function setupRoute() {
	const { f, service } = await setup();
	await f.plain.user.update({
		where: { id: "synthetic-user" },
		data: { hashedPassword: await hashPassword(password) },
	});
	const app = Fastify({ logger: false });
	app.decorate("prisma", f.client.prisma);
	app.decorate("config", env);
	app.decorate("sessionService", service);
	app.decorateRequest("currentUser", null);
	app.decorateRequest("sessionToken", null);
	await app.register(fastifyCookie, { secret: "synthetic-cookie-secret-32-characters" });
	await app.register(registerAuthRoutes, { prefix: "/auth" });
	await app.ready();
	return {
		f,
		app,
		login: () =>
			f.runtime.runOperation(() =>
				app.inject({
					method: "POST",
					url: "/auth/login",
					payload: { username: "synthetic-user", password },
				}),
			),
	};
}

describe("session publication acquisition budget", { timeout: 20_000 }, () => {
	// Break caught: a session that never entered native start is discarded instead
	// of retrying once after its same-client background staging releases the lane.
	it("retries one exhausted acquisition after real same-client background staging", async () => {
		const { f, service } = await setup();
		const before = snapshotProtectedRows(f);
		const staged = deferred();
		const release = deferred();
		const queued = deferred();
		const background = f.runtime.runOperation(() =>
			publication.withIsolatedRuntimePrismaTransaction(f.client.prisma, async (tx) => {
				await tx.$executeRawUnsafe("UPDATE CompetitionProbe SET value=1 WHERE id=1");
				staged.resolve();
				await release.promise;
			}),
		);
		let session: Promise<Awaited<ReturnType<SessionService["createSession"]>>> | undefined;
		let clock: ReturnType<typeof expireBudgets> | undefined;
		try {
			await staged.promise;
			clock = expireBudgets(1, queued.resolve);
			session = f.runtime.runOperation(() =>
				service.createSession("synthetic-user", true, { userAgent: "synthetic-agent" }),
			);
			// Join rejection immediately so RED still cleans up without an unhandled promise.
			void session.catch(() => undefined);
			await queued.promise;
			expect(await f.plain.session.count()).toBe(0);
			release.resolve();
			await background;
			const result = await session;
			clock.stop();
			const rows = await f.plain.session.findMany();
			expect(rows).toHaveLength(1);
			expect(rows[0]).toMatchObject({
				id: createHash("sha256").update(result.token).digest("hex"),
				userId: "synthetic-user",
				expiresAt: result.expiresAt,
				userAgent: "synthetic-agent",
			});
			expect(clock.attempts).toBe(2);
			const timing = clock.receipt();
			expect(timing.begins[1]! - timing.refusedAt!).toBeGreaterThanOrEqual(20);
			expect(f.writer.prepare("SELECT value FROM CompetitionProbe").pluck().get()).toBe(1);
			recordScopedWriteEvidence("auth-budget-background", timing);
		} finally {
			release.resolve();
			await Promise.allSettled([background, ...(session ? [session] : [])]);
			clock?.stop();
			expect(snapshotProtectedRows(f)).toEqual(before);
			expect(f.losses).toEqual([]);
		}
	});

	// Break caught: retrying indefinitely, entering an expired callback, or losing
	// exact refusal provenance prevents honest bounded failure and later recovery.
	it("stops after two exhausted attempts and allows a later publication", async () => {
		const { f, service } = await setup();
		const before = snapshotProtectedRows(f);
		const clock = expireBudgets(10);
		let failure: unknown;
		try {
			failure = await f.runtime
				.runOperation(() => service.createSession("synthetic-user"))
				.catch((error: unknown) => error);
		} finally {
			clock.stop();
		}
		expect(failure).toBeInstanceOf(RestoreRuntimeAdmissionError);
		expect(publication.isRetryableSqlitePublicationStartRefusal(failure)).toBe(true);
		expect(clock.attempts).toBe(2);
		expect(f.applications.size).toBe(0);
		expect(await f.plain.session.count()).toBe(0);
		await f.runtime.runOperation(() => service.createSession("synthetic-user"));
		expect(await f.plain.session.count()).toBe(1);
		expect(snapshotProtectedRows(f)).toEqual(before);
		expect(f.losses).toEqual([]);
		recordScopedWriteEvidence("auth-budget-persistent", clock.receipt());
	});

	// Break caught: carrying an earlier proof into an ENTERED transaction can
	// replay ambiguous writes. Throw the exact object after a real session insert.
	it("revokes old exact-object proof after entry and rolls back without replay", async () => {
		const { f, service } = await setup();
		const before = snapshotProtectedRows(f);
		const clock = expireBudgets(1);
		let failure: unknown;
		try {
			failure = await f.runtime
				.runOperation(() =>
					publication.withIsolatedRuntimePrismaTransaction(f.client.prisma, async () => {
						throw new Error("Expired acquisition must not enter");
					}),
				)
				.catch((error: unknown) => error);
		} finally {
			clock.stop();
		}
		expect(publication.isRetryableSqlitePublicationStartRefusal(failure)).toBe(true);
		const run = publication.withIsolatedRuntimePrismaTransaction;
		let callbacks = 0;
		const injected = vi
			.spyOn(publication, "withIsolatedRuntimePrismaTransaction")
			.mockImplementation((prisma, operation, options) =>
				run(
					prisma,
					async (tx) => {
						callbacks++;
						await operation(tx);
						throw failure;
					},
					options,
				),
			);
		try {
			await expect(
				f.runtime.runOperation(() => service.createSession("synthetic-user")),
			).rejects.toBe(failure);
		} finally {
			injected.mockRestore();
		}
		expect(callbacks).toBe(1);
		expect(publication.isRetryableSqlitePublicationStartRefusal(failure)).toBe(false);
		expect(await f.plain.session.count()).toBe(0);
		await f.runtime.runOperation(() => service.createSession("synthetic-user"));
		expect(await f.plain.session.count()).toBe(1);
		expect(snapshotProtectedRows(f)).toEqual(before);
		expect(f.losses).toEqual([]);
	});

	// Break caught: generic shape-based retries replay entered/ambiguous work.
	it.each([undefined, "P2028", "P1008", "SQLITE_BUSY"])(
		"does not retry an entered error with code %s",
		async (code) => {
			const { f, service } = await setup();
			const before = snapshotProtectedRows(f);
			const failure = Object.assign(new Error("Synthetic entered failure"), { code });
			const run = publication.withIsolatedRuntimePrismaTransaction;
			let callbacks = 0;
			const injected = vi
				.spyOn(publication, "withIsolatedRuntimePrismaTransaction")
				.mockImplementation((prisma, operation, options) =>
					run(
						prisma,
						async (tx) => {
							callbacks++;
							await operation(tx);
							throw failure;
						},
						options,
					),
				);
			try {
				await expect(
					f.runtime.runOperation(() => service.createSession("synthetic-user")),
				).rejects.toBe(failure);
			} finally {
				injected.mockRestore();
			}
			expect(callbacks).toBe(1);
			expect(publication.isRetryableSqlitePublicationStartRefusal(failure)).toBe(false);
			expect(await f.plain.session.count()).toBe(0);
			expect(snapshotProtectedRows(f)).toEqual(before);
			expect(f.losses).toEqual([]);
		},
	);

	// Break caught: closure and absent execution authority must never become a
	// retryable local timeout. Native fences, not client identity alone, decide.
	it.each(["closed", "unadmitted"] as const)("does not retry %s admission", async (kind) => {
		const { f, service } = await setup();
		const before = snapshotProtectedRows(f);
		if (kind === "closed") await f.client.close();
		const observed = vi.spyOn(publication, "withIsolatedRuntimePrismaTransaction");
		const failure = await (kind === "closed"
			? f.runtime.runOperation(() => service.createSession("synthetic-user"))
			: service.createSession("synthetic-user")
		).catch((error: unknown) => error);
		expect(failure).toBeInstanceOf(RestoreRuntimeAdmissionError);
		expect(observed).toHaveBeenCalledTimes(1);
		expect(publication.isRetryableSqlitePublicationStartRefusal(failure)).toBe(false);
		expect(await f.plain.session.count()).toBe(0);
		expect(snapshotProtectedRows(f)).toEqual(before);
		expect(f.losses).toEqual([]);
	});

	// Break caught: route cookies must represent exactly one committed session,
	// and an exhausted retry must leave no authentication acknowledgment.
	it.each([false, true])(
		"login cookie follows commit (persistent refusal=%s)",
		async (persistent) => {
			const { f, app, login } = await setupRoute();
			const before = snapshotProtectedRows(f);
			const clock = expireBudgets(persistent ? 10 : 1);
			try {
				const response = await login();
				clock.stop();
				expect(clock.attempts).toBe(2);
				if (persistent) {
					expect(response.statusCode).toBe(503);
					expect(response.cookies).toEqual([]);
					expect(await f.plain.session.count()).toBe(0);
				} else {
					expect(response.statusCode).toBe(200);
					const cookie = response.cookies.find((entry) => entry.name === "fixture_session");
					expect(cookie?.httpOnly).toBe(true);
					const unsigned = app.unsignCookie(cookie!.value);
					expect(unsigned.valid).toBe(true);
					const rows = await f.plain.session.findMany();
					expect(rows).toHaveLength(1);
					expect(rows[0]).toMatchObject({
						id: createHash("sha256").update(unsigned.value!).digest("hex"),
						userId: "synthetic-user",
					});
				}
				recordScopedWriteEvidence(`auth-budget-route-${persistent}`, {
					...clock.receipt(),
					status: response.statusCode,
					cookies: response.cookies.length,
					sessions: await f.plain.session.count(),
				});
			} finally {
				clock.stop();
				await app.close();
				expect(snapshotProtectedRows(f)).toEqual(before);
				expect(f.losses).toEqual([]);
			}
		},
	);
});
