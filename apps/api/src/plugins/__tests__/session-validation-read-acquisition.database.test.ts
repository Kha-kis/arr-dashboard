import { createHash } from "node:crypto";
import fastifyCookie from "@fastify/cookie";
import Fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import type { ApiEnv } from "../../config/env.js";
import { SessionService } from "../../lib/auth/session.js";
import { createRuntimeSessionMetadataPrismaClient } from "../../lib/backup/restore-runtime-client.js";
import { createNotificationOutboxNativeFixture } from "../../lib/notifications/__tests__/notification-outbox-native-fixture.js";
import { registerSessionValidationHook } from "../../server.js";

const hash = (token: string) => createHash("sha256").update(token).digest("hex");
const token = "synthetic-only-session-read-token";
const uncommittedToken = "synthetic-only-uncommitted-session-token";
const disposals: Array<() => Promise<void>> = [];

afterEach(async () => {
	for (const dispose of disposals.splice(0).reverse()) await dispose();
});

async function boot() {
	const native = await createNotificationOutboxNativeFixture();
	expect(native.engine).toBe("sqlite");
	const sibling = await native.createOwner();
	await native.run(async () => {
		await native.prisma.user.update({
			where: { id: native.userId },
			data: { username: "synthetic-committed-owner", mustChangePassword: false },
		});
		await native.prisma.session.create({
			data: {
				id: hash(token),
				userId: native.userId,
				expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
				lastAccessedAt: new Date(0),
			},
		});
	});
	const metadata = createRuntimeSessionMetadataPrismaClient(native.runtime);
	const app = Fastify({ logger: false });
	const sessionService = new SessionService(
		native.prisma,
		{ SESSION_COOKIE_NAME: "fixture_session" } as ApiEnv,
		app.log,
		metadata.prisma,
	);
	app.decorate("restoreRuntime", native.runtime);
	app.decorate("sessionService", sessionService);
	app.decorateRequest("currentUser", null);
	app.decorateRequest("sessionToken", null);
	await app.register(fastifyCookie, {
		secret: "synthetic-only-cookie-signing-secret-32bytes",
		hook: "onRequest",
	});
	registerSessionValidationHook(app);
	app.get("/synthetic-protected", async (request, reply) => {
		if (!request.currentUser) return reply.status(401).send({ error: "Unauthenticated" });
		return {
			id: request.currentUser.id,
			username: request.currentUser.username,
			mustChangePassword: request.currentUser.mustChangePassword,
		};
	});
	app.addHook("preClose", async () => sessionService.closeValidationAdmission());
	app.addHook("onClose", async () => {
		await sessionService.drainValidations();
		await metadata.close();
	});
	await app.ready();
	disposals.push(async () => {
		await app.close();
		await native.run(async () => {
			const where = { id: { in: [native.userId, sibling.userId] } };
			expect((await native.prisma.user.deleteMany({ where })).count).toBe(2);
			expect(await native.prisma.user.count({ where })).toBe(0);
		});
		await native.close();
	});
	return {
		native,
		sibling,
		app,
		request: (value = token, invalidSignature = false) =>
			app.inject({
				url: "/synthetic-protected",
				headers: {
					cookie: `fixture_session=${encodeURIComponent(
						invalidSignature ? `${app.signCookie(value)}tampered` : app.signCookie(value),
					)}`,
				},
			}),
	};
}

describe.skipIf(process.env.NOTIFICATION_OUTBOX_TEST_ENGINE === "postgresql")(
	"session validation read acquisition",
	() => {
		// Break caught: the real pre-handler must not wait on or borrow an unrelated
		// ordinary transaction, including its uncommitted session/user changes.
		it("authenticates committed identity while an ordinary transaction holds changed session data", async () => {
			const fixture = await boot();
			let release!: () => void;
			const held = new Promise<void>((resolve) => {
				release = resolve;
			});
			let entered!: () => void;
			const started = new Promise<void>((resolve) => {
				entered = resolve;
			});
			const rollback = new Error("Synthetic transaction rollback");
			const transaction = fixture.native
				.run(() =>
					fixture.native.prisma.$transaction(
						async (tx) => {
							await tx.user.update({
								where: { id: fixture.native.userId },
								data: { username: "synthetic-uncommitted-owner", mustChangePassword: true },
							});
							await tx.session.update({
								where: { id: hash(token) },
								data: { userId: fixture.sibling.userId, expiresAt: new Date(0) },
							});
							await tx.session.create({
								data: {
									id: hash(uncommittedToken),
									userId: fixture.sibling.userId,
									expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
								},
							});
							entered();
							await held;
							throw rollback;
						},
						{ timeout: 15_000 },
					),
				)
				.catch((error: unknown) => {
					if (error !== rollback) throw error;
				});
			try {
				await started;
				const response = await fixture.request();
				expect(response.statusCode, response.body).toBe(200);
				expect(response.json()).toEqual({
					id: fixture.native.userId,
					username: "synthetic-committed-owner",
					mustChangePassword: false,
				});
				expect((await fixture.request(uncommittedToken)).statusCode).toBe(401);
			} finally {
				release();
				await transaction;
			}
		}, 20_000);

		it("rejects missing and invalid signatures, expired sessions, and committed revocation", async () => {
			const fixture = await boot();
			expect((await fixture.app.inject({ url: "/synthetic-protected" })).statusCode).toBe(401);
			expect((await fixture.request(token, true)).statusCode).toBe(401);
			expect((await fixture.request("synthetic-unknown-token")).statusCode).toBe(401);
			expect((await fixture.request()).statusCode).toBe(200);
			await fixture.native.run(() =>
				fixture.native.prisma.session.delete({ where: { id: hash(token) } }),
			);
			expect((await fixture.request()).statusCode).toBe(401);
			await fixture.native.run(() =>
				fixture.native.prisma.session.create({
					data: { id: hash(token), userId: fixture.native.userId, expiresAt: new Date(0) },
				}),
			);
			expect((await fixture.request()).statusCode).toBe(401);
			expect(
				await fixture.native.run(() =>
					fixture.native.prisma.session.findUnique({ where: { id: hash(token) } }),
				),
			).toBeNull();
		}, 20_000);
	},
);
