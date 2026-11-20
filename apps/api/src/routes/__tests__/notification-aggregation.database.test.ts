import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestPrismaClient } from "../../lib/__tests__/test-prisma.js";
import type { PrismaClient } from "../../lib/prisma.js";
import { registerNotificationRoutes } from "../notifications.js";
import {
	createInjectAuthenticated,
	registerTestErrorHandler,
	setupAuthInjection,
} from "./test-helpers.js";

let directory: string;
let prisma: PrismaClient;
let app: FastifyInstance;

beforeAll(async () => {
	directory = mkdtempSync(join(tmpdir(), "notification-aggregation-"));
	const databasePath = join(directory, "fixture.db");
	execFileSync("pnpm", ["exec", "prisma", "db", "push", "--schema", "prisma/schema.prisma"], {
		env: { ...process.env, DATABASE_URL: `file:${databasePath}` },
		stdio: "pipe",
	});
	prisma = createTestPrismaClient(databasePath);
	await prisma.user.createMany({
		data: [
			{ id: "user-1", username: "synthetic-owner" },
			{ id: "user-2", username: "synthetic-other-owner" },
		],
	});
}, 30_000);

beforeEach(async () => {
	await prisma.$executeRawUnsafe('DROP TRIGGER IF EXISTS "reject_aggregation_write"');
	await prisma.notificationAggregationConfig.deleteMany({});
	await prisma.notificationAggregationConfig.createMany({
		data: [
			{
				id: "owned-edited",
				userId: "user-1",
				eventType: "HUNT_COMPLETED",
				windowSeconds: 120,
				maxBatchSize: 4,
				enabled: true,
			},
			{
				id: "owned-unsubmitted",
				userId: "user-1",
				eventType: "QUEUE_ITEMS_REMOVED",
				windowSeconds: 600,
				maxBatchSize: 8,
				enabled: true,
			},
			{
				id: "other-owner",
				userId: "user-2",
				eventType: "HUNT_COMPLETED",
				windowSeconds: 900,
				maxBatchSize: 12,
				enabled: true,
			},
		],
	});
	app = Fastify({ logger: false });
	app.decorate("prisma", prisma);
	setupAuthInjection(app);
	registerTestErrorHandler(app);
	await app.register(registerNotificationRoutes);
	await app.ready();
});

afterEach(async () => {
	await app?.close();
});

afterAll(async () => {
	await prisma?.$disconnect();
	if (directory) rmSync(directory, { recursive: true, force: true });
});

const editedConfigs = [
	{ eventType: "HUNT_COMPLETED", windowSeconds: 300, maxBatchSize: 10, enabled: false },
	{ eventType: "HUNT_FAILED", windowSeconds: 180, maxBatchSize: 6, enabled: true },
];

function save(configs: unknown = editedConfigs) {
	return createInjectAuthenticated(app)("PUT", "/aggregation", { body: { configs } });
}

function persisted() {
	return prisma.notificationAggregationConfig.findMany({ orderBy: { id: "asc" } });
}

async function readOwned() {
	const response = await createInjectAuthenticated(app)("GET", "/aggregation");
	expect(response.statusCode).toBe(200);
	return response.json();
}

describe("notification aggregation save on populated disposable SQLite", () => {
	it.each(["INSERT", "UPDATE"] as const)(
		"rolls back earlier edits when a later %s fails, then explicitly retries the complete batch",
		async (operation) => {
			if (operation === "UPDATE") {
				await prisma.notificationAggregationConfig.create({
					data: {
						id: "owned-second",
						userId: "user-1",
						eventType: "HUNT_FAILED",
						windowSeconds: 240,
						maxBatchSize: 7,
						enabled: false,
					},
				});
			}
			const before = await persisted();
			// A real database fault on the second row, not a mocked transaction.
			await prisma.$executeRawUnsafe(
				`CREATE TRIGGER reject_aggregation_write BEFORE ${operation}
				 ON notification_aggregation_configs
				 WHEN NEW.userId = 'user-1' AND NEW.eventType = 'HUNT_FAILED'
				 BEGIN SELECT RAISE(ABORT, 'synthetic_aggregation_failure'); END`,
			);
			const failed = await save();
			expect(failed.statusCode).toBe(500);
			expect(await persisted()).toEqual(before);

			await prisma.$executeRawUnsafe('DROP TRIGGER "reject_aggregation_write"');
			const retried = await save();
			expect(retried.statusCode).toBe(200);
			expect(retried.json()).toEqual({ success: true });
			expect(await readOwned()).toEqual(expect.arrayContaining(editedConfigs));
			expect(
				await prisma.notificationAggregationConfig.count({ where: { userId: "user-1" } }),
			).toBe(3);
		},
	);

	it("saves explicit disable plus insertion without changing another owner or an unsubmitted event", async () => {
		const before = (await persisted()).filter((row) => row.id !== "owned-edited");
		expect((await save()).statusCode).toBe(200);
		const after = await persisted();
		expect(after.filter((row) => before.some((old) => old.id === row.id))).toEqual(before);
		expect(await readOwned()).toEqual(expect.arrayContaining(editedConfigs));
		expect(await readOwned()).not.toContainEqual({
			eventType: "HUNT_COMPLETED",
			windowSeconds: 900,
			maxBatchSize: 12,
			enabled: true,
		});
	});

	it("rejects an invalid later row before persisting any earlier edit", async () => {
		const before = await persisted();
		const failed = await save([editedConfigs[0], { ...editedConfigs[1], windowSeconds: 59 }]);
		expect(failed.statusCode).toBe(400);
		expect(await persisted()).toEqual(before);
	});

	it("retains schema defaults and ordered duplicate-event updates", async () => {
		expect(
			(
				await save([
					{ eventType: "HUNT_COMPLETED", windowSeconds: 90, maxBatchSize: 3, enabled: true },
					{ eventType: "HUNT_COMPLETED", enabled: false },
				])
			).statusCode,
		).toBe(200);
		expect(await readOwned()).toContainEqual({
			eventType: "HUNT_COMPLETED",
			windowSeconds: 300,
			maxBatchSize: 10,
			enabled: false,
		});
		expect(await prisma.notificationAggregationConfig.count({ where: { userId: "user-1" } })).toBe(
			2,
		);
	});

	it("acknowledges an empty request without touching existing settings", async () => {
		const before = await persisted();
		const response = await save([]);
		expect(response.statusCode).toBe(200);
		expect(response.json()).toEqual({ success: true });
		expect(await persisted()).toEqual(before);
	});

	it("persists a complete batch rather than mixed rows after concurrent saves", async () => {
		const otherBatch = [
			{ eventType: "HUNT_COMPLETED", windowSeconds: 360, maxBatchSize: 11, enabled: true },
			{ eventType: "HUNT_FAILED", windowSeconds: 240, maxBatchSize: 7, enabled: false },
		];
		const responses = await Promise.all([save(editedConfigs), save(otherBatch)]);
		expect(responses.map((response) => response.statusCode)).toEqual([200, 200]);
		const owned = ((await readOwned()) as Array<{ eventType: string }>)
			.filter((row) => row.eventType === "HUNT_COMPLETED" || row.eventType === "HUNT_FAILED")
			.sort((a, b) => a.eventType.localeCompare(b.eventType));
		expect([editedConfigs, otherBatch]).toContainEqual(owned);
	});
});
