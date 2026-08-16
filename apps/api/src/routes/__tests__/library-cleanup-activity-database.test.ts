import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import Fastify, { type FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestPrismaClient } from "../../lib/__tests__/test-prisma.js";
import { appendCleanupAuditEvent } from "../../lib/library-cleanup/cleanup-audit.js";
import type { PrismaClient } from "../../lib/prisma.js";
import { registerLibraryCleanupRoutes } from "../library-cleanup.js";
import { createInjectAuthenticated, setupAuthInjection } from "./test-helpers.js";

const RUN_DB_TESTS = process.env.TEST_DB === "true";
const execFileAsync = promisify(execFile);

(RUN_DB_TESTS ? describe : describe.skip)("library cleanup activity routes (SQLite)", () => {
	let app: FastifyInstance;
	let prisma: PrismaClient;
	let databaseDir: string;

	beforeAll(async () => {
		databaseDir = await mkdtemp(path.join(os.tmpdir(), "arr-cleanup-activity-"));
		const databasePath = path.join(databaseDir, "activity.db");
		const schemaPath = path.resolve(import.meta.dirname, "../../../prisma/schema.prisma");
		const prismaCli = path.resolve(
			import.meta.dirname,
			"../../../node_modules/prisma/build/index.js",
		);
		await execFileAsync(process.execPath, [
			prismaCli,
			"db",
			"push",
			"--schema",
			schemaPath,
			"--url",
			`file:${databasePath}`,
		]);
		prisma = createTestPrismaClient(databasePath);

		for (const suffix of ["a", "b"]) {
			await prisma.user.create({ data: { id: `user-${suffix}`, username: `user-${suffix}` } });
			await prisma.libraryCleanupConfig.create({
				data: { id: `config-${suffix}`, userId: `user-${suffix}` },
			});
			await appendCleanupAuditEvent(prisma, {
				userId: `user-${suffix}`,
				configId: `config-${suffix}`,
				eventKey: `approval-${suffix}:proposal`,
				actionId: `approval-${suffix}`,
				correlationId: `attempt-${suffix}`,
				actorType: "system",
				actorId: null,
				eventType: "proposal_created",
				trigger: "scheduled",
				target: {
					kind: "approval",
					id: `approval-${suffix}`,
					instanceId: `sonarr-${suffix}`,
					itemType: "series",
					arrItemId: suffix === "a" ? 42 : 84,
					targetScope: "series",
				},
				summary: {
					title: suffix === "a" ? "Signal Harbor" : "Other user's series",
					ruleId: `rule-${suffix}`,
					ruleName: "Old series",
					action: "delete",
					reason: "Proposal created",
				},
				outcome: "info",
				evidence: { authority: "queued" },
			});
		}

		app = Fastify({ logger: false });
		setupAuthInjection(app, { id: "user-a", username: "user-a" });
		app.decorate("prisma", prisma);
		await app.register(registerLibraryCleanupRoutes);
		await app.ready();
	});

	afterAll(async () => {
		await app?.close();
		await prisma?.$disconnect();
		await rm(databaseDir, { recursive: true, force: true });
	});

	it("groups and counts only the current user's action history", async () => {
		const response = await createInjectAuthenticated(app)("GET", "/library-cleanup/activity");

		expect(response.statusCode).toBe(200);
		expect(response.json()).toMatchObject({
			total: 1,
			items: [
				{
					actionId: "approval-a",
					title: "Signal Harbor",
					eventCount: 1,
					events: [{ id: "1", eventType: "proposal_created" }],
				},
			],
		});
		expect(response.payload).not.toContain("Other user's series");
	});
});
