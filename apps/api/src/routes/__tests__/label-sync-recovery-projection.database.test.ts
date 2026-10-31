import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestPrismaClient } from "../../lib/__tests__/test-prisma.js";
import { createJellyfinMutationRepository } from "../../lib/label-sync/jellyfin-mutation-repository.js";
import { prepareRestoredLabelSyncMutationAttempt } from "../../lib/label-sync/jellyfin-mutation-restore.js";
import { projectLabelSyncRecovery } from "../../lib/label-sync/recovery-projection.js";
import { registerLabelSyncRoutes } from "../label-sync.js";

// Only the external provider execution is replaced; routes, persistence and
// recovery aggregation run against the actual populated database.
vi.mock("../../lib/label-sync/execute-rule.js", () => ({
	executeLabelSyncRule: async () => ({
		status: "success",
		message: "Synthetic completed run",
		items: [],
		totals: {
			sourceInstancesScanned: 0,
			taggedItemsFound: 0,
			destMatchesFound: 0,
			labelsApplied: 0,
			failures: 0,
		},
	}),
}));

const checked = new Date("2026-10-07T12:00:00.000Z");
let directory: string;
let prisma: ReturnType<typeof createTestPrismaClient>;
let app: FastifyInstance;

beforeAll(async () => {
	directory = mkdtempSync(join(tmpdir(), "label-recovery-projection-"));
	const database = join(directory, "test.db");
	execFileSync(
		process.execPath,
		[
			resolve("node_modules/prisma/build/index.js"),
			"db",
			"push",
			"--schema",
			resolve("prisma/schema.prisma"),
			"--url",
			`file:${database}`,
		],
		{
			cwd: directory,
			env: { PATH: process.env.PATH, DATABASE_URL: `file:${database}` },
			stdio: "ignore",
		},
	);
	prisma = createTestPrismaClient(database);
	app = Fastify({ logger: false });
	app.decorate("prisma", prisma);
	app.decorateRequest("currentUser", null);
	app.addHook("preHandler", async (request) => {
		request.currentUser = { id: "owner", username: "synthetic" } as never;
	});
	await app.register(registerLabelSyncRoutes, { prefix: "/api/label-sync" });
	await app.ready();
}, 60_000);
afterAll(async () => {
	await app?.close();
	await prisma?.$disconnect();
	if (directory) rmSync(directory, { recursive: true, force: false });
});
afterEach(() => vi.restoreAllMocks());
beforeEach(async () => {
	await prisma.labelSyncMutationAttempt.deleteMany();
	await prisma.labelSyncRule.deleteMany();
	await prisma.serviceInstance.deleteMany();
	await prisma.user.deleteMany();
	for (const owner of ["owner", "other"]) {
		await prisma.user.create({ data: { id: owner, username: owner } });
		await prisma.serviceInstance.create({
			data: {
				id: `${owner}-destination`,
				userId: owner,
				service: "JELLYFIN",
				label: "synthetic",
				baseUrl: "http://fixture.invalid",
				encryptedApiKey: "cipher",
				encryptionIv: "iv",
			},
		});
		await prisma.labelSyncRule.create({
			data: {
				id: `${owner}-rule`,
				userId: owner,
				name: "synthetic",
				sourceService: "radarr",
				sourceTagName: "source",
				destService: "jellyfin",
				destInstanceId: `${owner}-destination`,
				destTagName: "tag",
				lastRunAt: checked,
				lastRunStatus: "success",
			},
		});
	}
});

async function attempt(owner: string, tmdbId: number, reconciled = false) {
	const repository = createJellyfinMutationRepository(prisma);
	const result = await repository.claim({
		userId: owner,
		ruleId: `${owner}-rule`,
		destinationInstanceId: `${owner}-destination`,
		provider: "jellyfin",
		mediaType: "movie",
		tmdbId,
		connectionGeneration: 0,
		identityGeneration: 0,
		targetItemId: `target-${tmdbId}`,
		libraryId: "library",
		intentFingerprint: "intent",
		ruleFingerprint: "rule",
		destinationTag: "tag",
	});
	if (result.kind !== "acquired") throw new Error("Synthetic claim not acquired");
	const row = await prisma.labelSyncMutationAttempt.findUniqueOrThrow({ where: { id: result.id } });
	const held = prepareRestoredLabelSyncMutationAttempt(row);
	await prisma.labelSyncMutationAttempt.update({
		where: { id: result.id },
		data: {
			status: held.status,
			reasonCode: held.reasonCode,
			claimToken: null,
			restoreEvidence: held.restoreEvidence,
			...(reconciled
				? {
						status: "reconciled",
						reasonCode: "desired_state_observed",
						activeOperationKey: null,
						reconcileAttemptCount: 1,
						lastObservedAt: checked,
						completedAt: checked,
					}
				: {}),
		},
	});
}

describe("owner-scoped persisted recovery projection", () => {
	it("returns unavailable when an older adapter has no aggregation capability", async () => {
		const missing = { labelSyncMutationAttempt: {} };
		expect(
			(await projectLabelSyncRecovery(missing as never, "owner", ["owner-rule"])).get("owner-rule"),
		).toEqual({ availability: "unavailable" });
	});
	it("projects held and observed counts without leaking another owner or private attempt fields", async () => {
		await attempt("owner", 1);
		await attempt("owner", 2);
		await attempt("owner", 3, true);
		await attempt("other", 4);
		const response = await app.inject({ method: "GET", url: "/api/label-sync/rules" });
		expect(response.statusCode).toBe(200);
		const body = response.json();
		expect(body.rules).toHaveLength(1);
		expect(body.rules[0].recovery).toEqual({
			availability: "known",
			state: "restored-held",
			heldCount: 2,
			reconciledCount: 1,
			lastCheckAt: checked.toISOString(),
		});
		expect(Object.keys(body.rules[0].recovery).sort()).toEqual([
			"availability",
			"heldCount",
			"lastCheckAt",
			"reconciledCount",
			"state",
		]);
	});
	it("does not substitute the historical successful run time for a missing observation", async () => {
		await attempt("owner", 1);
		const body = (await app.inject({ method: "GET", url: "/api/label-sync/rules" })).json();
		expect(body.rules[0].recovery).toEqual({
			availability: "known",
			state: "restored-held",
			heldCount: 1,
			reconciledCount: 0,
			lastCheckAt: null,
		});
	});
	it("distinguishes positively observed restored work from original-send acknowledgment", async () => {
		await attempt("owner", 1, true);
		const body = (await app.inject({ method: "GET", url: "/api/label-sync/rules" })).json();
		expect(body.rules[0].recovery).toEqual({
			availability: "known",
			state: "reconciled",
			heldCount: 0,
			reconciledCount: 1,
			lastCheckAt: checked.toISOString(),
		});
	});
	it("returns a genuine clear projection when the owner has no restored work", async () => {
		await attempt("other", 4);
		const body = (await app.inject({ method: "GET", url: "/api/label-sync/rules" })).json();
		expect(body.rules[0].recovery).toEqual({
			availability: "known",
			state: "clear",
			heldCount: 0,
			reconciledCount: 0,
			lastCheckAt: null,
		});
	});
	it("returns unavailable without counterfeit counts when the aggregate query fails", async () => {
		await attempt("owner", 1);
		vi.spyOn(prisma.labelSyncMutationAttempt, "groupBy").mockRejectedValueOnce(
			new Error("Synthetic failure"),
		);
		const response = await app.inject({ method: "GET", url: "/api/label-sync/rules" });
		expect(response.statusCode).toBe(200);
		expect(response.json().rules[0].recovery).toEqual({ availability: "unavailable" });
	});
	it("does not interpret an unknown persisted category as healthy", async () => {
		await attempt("owner", 1);
		await prisma.labelSyncMutationAttempt.updateMany({ data: { status: "future-unverified" } });
		const body = (await app.inject({ method: "GET", url: "/api/label-sync/rules" })).json();
		expect(body.rules[0].recovery).toEqual({ availability: "unavailable" });
	});
	it("uses the same projection for create and update rather than inventing zero on failure", async () => {
		const payload = {
			name: "new",
			sourceService: "radarr",
			sourceTagName: "source",
			destService: "jellyfin",
			destInstanceId: "owner-destination",
			destTagName: "tag",
		};
		vi.spyOn(prisma.labelSyncMutationAttempt, "groupBy").mockRejectedValueOnce(
			new Error("Synthetic failure"),
		);
		const created = await app.inject({ method: "POST", url: "/api/label-sync/rules", payload });
		expect(created.statusCode).toBe(201);
		expect(created.json().rule.recovery).toEqual({ availability: "unavailable" });
		const updated = await app.inject({
			method: "PATCH",
			url: `/api/label-sync/rules/${created.json().rule.id}`,
			payload: { name: "updated" },
		});
		expect(updated.statusCode).toBe(200);
		expect(updated.json().rule.recovery).toEqual({
			availability: "known",
			state: "clear",
			heldCount: 0,
			reconciledCount: 0,
			lastCheckAt: null,
		});
	});
	it("returns held recovery even when a new unrelated-target run completes successfully", async () => {
		await attempt("owner", 1);
		const response = await app.inject({
			method: "POST",
			url: "/api/label-sync/rules/owner-rule/run",
		});
		expect(response.statusCode).toBe(200);
		expect(response.json().rule.lastRunStatus).toBe("success");
		expect(response.json().rule.recovery).toEqual({
			availability: "known",
			state: "restored-held",
			heldCount: 1,
			reconciledCount: 0,
			lastCheckAt: null,
		});
	});
});
