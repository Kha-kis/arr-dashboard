import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTestPrismaClient } from "../../lib/__tests__/test-prisma.js";
import { createJellyfinMutationRepository } from "../../lib/label-sync/jellyfin-mutation-repository.js";
import { registerAuthRoutes } from "../auth.js";
import { registerLabelSyncRoutes } from "../label-sync.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const work of cleanup.splice(0)) await work();
});

async function fixture() {
	const directory = mkdtempSync(join(tmpdir(), "task55-label-lifecycle-"));
	const dbPath = join(directory, "test.db");
	execFileSync("pnpm", ["exec", "prisma", "db", "push", "--schema", "prisma/schema.prisma"], {
		cwd: process.cwd(),
		env: { ...process.env, DATABASE_URL: `file:${dbPath}` },
		stdio: "ignore",
	});
	const prisma = createTestPrismaClient(dbPath);
	const app = Fastify({ logger: false });
	cleanup.push(async () => {
		await app.close();
		await prisma.$disconnect();
		rmSync(directory, { recursive: true, force: true });
	});
	await prisma.user.create({ data: { id: "owner", username: "owner" } });
	await prisma.serviceInstance.create({
		data: {
			id: "destination",
			userId: "owner",
			service: "JELLYFIN",
			label: "destination",
			baseUrl: "http://fixture.invalid",
			encryptedApiKey: "cipher",
			encryptionIv: "iv",
		},
	});
	await prisma.labelSyncRule.create({
		data: {
			id: "rule",
			userId: "owner",
			name: "original",
			sourceService: "radarr",
			sourceTagName: "source",
			destService: "jellyfin",
			destInstanceId: "destination",
			destTagName: "managed",
		},
	});
	const repository = createJellyfinMutationRepository(prisma);
	const claimed = await repository.claim({
		userId: "owner",
		ruleId: "rule",
		destinationInstanceId: "destination",
		provider: "jellyfin",
		mediaType: "movie",
		tmdbId: 1,
		connectionGeneration: 0,
		identityGeneration: 0,
		targetItemId: "target",
		libraryId: "library",
		intentFingerprint: "intent",
		ruleFingerprint: "rule",
		destinationTag: "managed",
	});
	if (claimed.kind !== "acquired") throw new Error("fixture claim failed");
	const envelope = {
		id: claimed.id,
		userId: "owner",
		ruleId: "rule",
		destinationInstanceId: "destination",
		activeOperationKey: claimed.activeOperationKey,
		claimToken: claimed.claimToken,
	};
	app.decorate("prisma", prisma);
	app.decorate("config", { PASSWORD_POLICY: "relaxed" } as never);
	app.decorate("sessionService", { clearCookie: vi.fn(), invalidateSession: vi.fn() } as never);
	app.decorateRequest("currentUser", null);
	app.addHook("preHandler", async (request) => {
		request.currentUser = { id: "owner", username: "owner" } as never;
	});
	await app.register(registerLabelSyncRoutes, { prefix: "/api/label-sync" });
	await app.register(registerAuthRoutes, { prefix: "/api/auth" });
	await app.ready();
	return { app, prisma, repository, envelope };
}

describe("Label Sync lifecycle routes with persisted mutation attempts", () => {
	it("preserves pending recovery evidence and all account data when account deletion is attempted", async () => {
		const f = await fixture();
		await f.repository.markSending({ ...f.envelope, sendAttemptCount: 0 });
		await f.repository.completeSend({ ...f.envelope, sendAttemptCount: 1, status: "unknown" });
		expect((await f.app.inject({ method: "DELETE", url: "/api/auth/account" })).statusCode).toBe(
			409,
		);
		expect(await f.prisma.user.count()).toBe(1);
		expect(await f.prisma.serviceInstance.count()).toBe(1);
		expect(await f.prisma.labelSyncMutationAttempt.count()).toBe(1);
		expect(f.app.sessionService.clearCookie).not.toHaveBeenCalled();
	}, 120_000);

	it("preserves terminal history when account deletion is denied and removes it only with an authorized account deletion", async () => {
		const f = await fixture();
		await f.repository.completePreSend({
			...f.envelope,
			sendAttemptCount: 0,
			status: "noop",
			reasonCode: "already_applied",
			lastObservedAt: new Date(),
		});
		await f.prisma.user.update({
			where: { id: "owner" },
			data: { hashedPassword: "existing-password-hash" },
		});
		expect((await f.app.inject({ method: "DELETE", url: "/api/auth/account" })).statusCode).toBe(
			400,
		);
		expect(await f.prisma.labelSyncMutationAttempt.count()).toBe(1);
		await f.prisma.user.update({ where: { id: "owner" }, data: { hashedPassword: null } });
		expect((await f.app.inject({ method: "DELETE", url: "/api/auth/account" })).statusCode).toBe(
			200,
		);
		expect(await f.prisma.labelSyncMutationAttempt.count()).toBe(0);
		expect(await f.prisma.user.count()).toBe(0);
	}, 120_000);

	it.each(["claimed", "sending", "unknown"])(
		"blocks edits and deletion while an attempt is %s",
		async (status) => {
			const f = await fixture();
			if (status !== "claimed")
				await f.repository.markSending({ ...f.envelope, sendAttemptCount: 0 });
			if (status === "unknown")
				await f.repository.completeSend({ ...f.envelope, sendAttemptCount: 1, status: "unknown" });
			const edited = await f.app.inject({
				method: "PATCH",
				url: "/api/label-sync/rules/rule",
				payload: { name: "changed" },
			});
			expect(edited.statusCode).toBe(409);
			const deleted = await f.app.inject({ method: "DELETE", url: "/api/label-sync/rules/rule" });
			expect(deleted.statusCode).toBe(409);
			expect((await f.prisma.labelSyncRule.findUniqueOrThrow({ where: { id: "rule" } })).name).toBe(
				"original",
			);
			expect(await f.prisma.labelSyncMutationAttempt.count()).toBe(1);
		},
		120_000,
	);

	it("retains a terminal attempt on edit and removes it atomically with explicit rule deletion", async () => {
		const f = await fixture();
		await f.repository.completePreSend({
			...f.envelope,
			sendAttemptCount: 0,
			status: "noop",
			reasonCode: "already_applied",
			lastObservedAt: new Date(),
		});
		expect(
			(
				await f.app.inject({
					method: "PATCH",
					url: "/api/label-sync/rules/rule",
					payload: { name: "changed" },
				})
			).statusCode,
		).toBe(200);
		expect(await f.prisma.labelSyncMutationAttempt.count()).toBe(1);
		expect(
			(await f.app.inject({ method: "DELETE", url: "/api/label-sync/rules/rule" })).statusCode,
		).toBe(204);
		expect(await f.prisma.labelSyncMutationAttempt.count()).toBe(0);
		expect(await f.prisma.labelSyncRule.count()).toBe(0);
	}, 120_000);
});
