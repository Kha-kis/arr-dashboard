import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTestPrismaClient } from "../../lib/__tests__/test-prisma.js";
import { Encryptor } from "../../lib/auth/encryption.js";
import { LabelSyncScheduler } from "../../lib/label-sync/label-sync-scheduler.js";

const { executeLabelSyncRule } = vi.hoisted(() => ({
	executeLabelSyncRule: vi.fn(),
}));

vi.mock("../../lib/label-sync/execute-rule.js", () => ({ executeLabelSyncRule }));

import type { PrismaClient } from "../../generated/prisma/client.js";
import { registerLabelSyncRoutes } from "../label-sync.js";

const USER_ID = "label-sync-race-user";
const RULE_ID = "label-sync-race-rule";
const DESTINATION_ID = "label-sync-race-destination";

const success = {
	status: "success" as const,
	message: "Applied one label to one item (one match from one tagged item).",
	totals: {
		sourceInstancesScanned: 1,
		taggedItemsFound: 1,
		destMatchesFound: 1,
		labelsApplied: 1,
		failures: 0,
	},
};

const databases: Array<{
	app: ReturnType<typeof Fastify>;
	prisma: PrismaClient;
	directory: string;
}> = [];

function deferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

async function createFixture(): Promise<{
	app: ReturnType<typeof Fastify>;
	prisma: PrismaClient;
}> {
	const directory = mkdtempSync(join(tmpdir(), "label-sync-run-race-"));
	const databasePath = join(directory, "race.db");
	execFileSync("pnpm", ["exec", "prisma", "db", "push", "--schema", "prisma/schema.prisma"], {
		cwd: process.cwd(),
		env: { ...process.env, DATABASE_URL: `file:${databasePath}` },
		stdio: "ignore",
	});
	const prisma = createTestPrismaClient(databasePath);
	await prisma.$connect();
	await prisma.user.create({ data: { id: USER_ID, username: "label-sync-race-user" } });
	await prisma.serviceInstance.create({
		data: {
			id: DESTINATION_ID,
			userId: USER_ID,
			service: "JELLYFIN",
			label: "Label Sync race destination",
			baseUrl: "http://label-sync-race.invalid",
			encryptedApiKey: "ciphertext",
			encryptionIv: "iv",
		},
	});
	await prisma.labelSyncRule.create({
		data: {
			id: RULE_ID,
			userId: USER_ID,
			name: "Original rule",
			sourceService: "sonarr",
			sourceTagName: "source",
			destService: "jellyfin",
			destInstanceId: DESTINATION_ID,
			destTagName: "managed",
		},
	});

	const app = Fastify({ logger: false });
	app.decorate("prisma", prisma);
	app.decorate("arrClientFactory", {} as never);
	app.decorate("encryptor", new Encryptor("0123456789abcdef0123456789abcdef"));
	app.decorateRequest("currentUser", null);
	app.addHook("preHandler", async (request) => {
		request.currentUser = { id: USER_ID, username: "label-sync-race-user" } as never;
	});
	await app.register(registerLabelSyncRoutes, { prefix: "/api/label-sync" });
	await app.ready();
	databases.push({ app, prisma, directory });
	return { app, prisma };
}

afterEach(async () => {
	executeLabelSyncRule.mockReset();
	for (const database of databases.splice(0)) {
		await database.app.close();
		await database.prisma.$disconnect();
		rmSync(database.directory, { recursive: true, force: true });
	}
});

describe("label-sync manual run result persistence races", () => {
	it.each(["delete", "edit"] as const)(
		"returns a conflict when a guarded %s wins after upstream success and does not overwrite it",
		async (winner) => {
			const { app, prisma } = await createFixture();
			const executionReachedSuccess = deferred();
			const releaseExecution = deferred();
			executeLabelSyncRule.mockImplementation(async () => {
				executionReachedSuccess.resolve();
				await releaseExecution.promise;
				return success;
			});

			const run = app.inject({
				method: "POST",
				url: `/api/label-sync/rules/${RULE_ID}/run`,
			});
			await executionReachedSuccess.promise;

			const concurrentMutation =
				winner === "delete"
					? app.inject({ method: "DELETE", url: `/api/label-sync/rules/${RULE_ID}` })
					: app.inject({
							method: "PATCH",
							url: `/api/label-sync/rules/${RULE_ID}`,
							payload: { name: "Concurrent edit" },
						});
			const mutationResponse = await concurrentMutation;
			expect(mutationResponse.statusCode).toBe(winner === "delete" ? 204 : 200);

			releaseExecution.resolve();
			const runResponse = await run;
			expect(runResponse.statusCode).toBe(409);
			expect(JSON.parse(runResponse.payload)).toEqual({
				error:
					"Label Sync execution finished, but the rule changed or was deleted before its result could be saved.",
				code: "label_sync_rule_changed",
				execution: { status: "success", totals: success.totals },
			});
			expect(executeLabelSyncRule).toHaveBeenCalledOnce();

			const remaining = await prisma.labelSyncRule.findUnique({ where: { id: RULE_ID } });
			if (winner === "delete") {
				expect(remaining).toBeNull();
			} else {
				expect(remaining).toEqual(
					expect.objectContaining({
						name: "Concurrent edit",
						lastRunAt: null,
						lastRunStatus: null,
						lastRunMessage: null,
					}),
				);
			}
		},
		120_000,
	);

	it("rejects a same-timestamp configuration edit instead of applying the old result", async () => {
		const { app, prisma } = await createFixture();
		const executionReachedSuccess = deferred();
		const releaseExecution = deferred();
		executeLabelSyncRule.mockImplementation(async () => {
			executionReachedSuccess.resolve();
			await releaseExecution.promise;
			return success;
		});

		const original = await prisma.labelSyncRule.findUniqueOrThrow({ where: { id: RULE_ID } });
		const run = app.inject({
			method: "POST",
			url: `/api/label-sync/rules/${RULE_ID}/run`,
		});
		await executionReachedSuccess.promise;
		await prisma.labelSyncRule.update({
			where: { id: RULE_ID },
			data: { name: "Same timestamp edit", updatedAt: original.updatedAt },
		});

		releaseExecution.resolve();
		const response = await run;
		expect(response.statusCode).toBe(409);
		expect(JSON.parse(response.payload)).toEqual(
			expect.objectContaining({ code: "label_sync_rule_changed" }),
		);
		expect(await prisma.labelSyncRule.findUniqueOrThrow({ where: { id: RULE_ID } })).toEqual(
			expect.objectContaining({
				name: "Same timestamp edit",
				lastRunAt: null,
				lastRunStatus: null,
				lastRunMessage: null,
			}),
		);
	}, 120_000);

	it("persists and returns the execution result when the rule is unchanged", async () => {
		const { app, prisma } = await createFixture();
		executeLabelSyncRule.mockResolvedValue(success);

		const response = await app.inject({
			method: "POST",
			url: `/api/label-sync/rules/${RULE_ID}/run`,
		});

		expect(response.statusCode).toBe(200);
		const body = JSON.parse(response.payload) as {
			rule: { lastRunStatus: string; lastRunMessage: string };
		};
		expect(body.rule.lastRunStatus).toBe("success");
		expect(body.rule.lastRunMessage).toBe(success.message);
		expect(await prisma.labelSyncRule.findUniqueOrThrow({ where: { id: RULE_ID } })).toEqual(
			expect.objectContaining({
				lastRunStatus: "success",
				lastRunMessage: success.message,
			}),
		);
	}, 120_000);

	it.each(["delete", "edit"] as const)(
		"does not persist a scheduled result after a guarded %s",
		async (winner) => {
			const { app, prisma } = await createFixture();
			const executionReachedSuccess = deferred();
			const releaseExecution = deferred();
			executeLabelSyncRule.mockImplementation(async () => {
				executionReachedSuccess.resolve();
				await releaseExecution.promise;
				return success;
			});
			const log = {
				debug: vi.fn(),
				info: vi.fn(),
				warn: vi.fn(),
				error: vi.fn(),
			};
			const scheduler = new LabelSyncScheduler(
				prisma,
				{} as never,
				new Encryptor("0123456789abcdef0123456789abcdef"),
				log as never,
			);

			const tick = (scheduler as unknown as { tick(): Promise<void> }).tick();
			await executionReachedSuccess.promise;
			const mutationResponse =
				winner === "delete"
					? await app.inject({ method: "DELETE", url: `/api/label-sync/rules/${RULE_ID}` })
					: await app.inject({
							method: "PATCH",
							url: `/api/label-sync/rules/${RULE_ID}`,
							payload: { name: "Concurrent scheduled edit" },
						});
			expect(mutationResponse.statusCode).toBe(winner === "delete" ? 204 : 200);

			releaseExecution.resolve();
			await tick;
			expect(log.error).not.toHaveBeenCalled();
			const remaining = await prisma.labelSyncRule.findUnique({ where: { id: RULE_ID } });
			if (winner === "delete") {
				expect(remaining).toBeNull();
			} else {
				expect(remaining).toEqual(
					expect.objectContaining({
						name: "Concurrent scheduled edit",
						lastRunAt: null,
						lastRunStatus: null,
						lastRunMessage: null,
					}),
				);
			}
		},
		120_000,
	);
});
