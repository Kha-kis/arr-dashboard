import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { SqliteSchemaFixture } from "../../__tests__/sqlite-schema-fixture.js";
import { createTestPrismaClient } from "../../__tests__/test-prisma.js";
import { JellyfinClient } from "../../jellyfin/jellyfin-client.js";
import { createJellyfinNativeEpisodeJobAdapter } from "../../jellyfin/jellyfin-native-episode-inventory.js";
import { createJellyfinNativeLibraryJobAdapter } from "../../jellyfin/jellyfin-native-inventory.js";
import { PlexClient } from "../../plex/plex-client.js";
import { createPlexNativeJobAdapter } from "../../plex/plex-native-inventory.js";
import type { PrismaClient } from "../../prisma.js";
import { createProviderPublicationAuthority } from "../../services/provider-identity-guard.js";
import { readProviderInventoryConnections } from "../inventory-connection-repository.js";
import * as nativeControl from "../native-control-worker-transport.js";
import {
	type NativeInventoryDomain,
	readNativeInventoryDisplayPage,
	readNativeInventoryPage,
} from "../native-inventory.js";
import {
	requestNativeInventoryRefresh,
	runDueNativeInventoryWork,
	schedulePeriodicNativeInventoryWork,
} from "../native-inventory-job-orchestration.js";
import { admitNativeInventoryRun } from "../native-inventory-job-repository.js";
import {
	type NativeInventoryJobAdapter,
	type NativeInventorySlicePhase,
	runNativeInventoryJobSlice as runGuardedNativeInventoryJobSlice,
} from "../native-inventory-job-runner.js";

const databases: Array<{ directory: string; prisma: PrismaClient }> = [];
const schemaFixture = new SqliteSchemaFixture();
beforeAll(() => schemaFixture.initialize(), 60_000);
afterAll(() => schemaFixture.dispose());

const verifiedIdentity = async () => "verified" as const;
function runNativeInventoryJobSlice<
	Scope extends { scopeKey: string; domain?: NativeInventoryDomain },
>(
	prisma: PrismaClient,
	runId: string,
	adapter: NativeInventoryJobAdapter<Scope>,
	options: {
		deadlineAt: number;
		maxPages: number;
		pageSize: number;
		retryDelayMs: number;
		verifyIdentity?: () => Promise<"verified" | "unavailable" | "superseded">;
		signal?: AbortSignal;
		reportPhase?: (phase: NativeInventorySlicePhase) => void;
	},
) {
	return runGuardedNativeInventoryJobSlice(prisma, runId, adapter, {
		...options,
		verifyIdentity: options.verifyIdentity ?? verifiedIdentity,
	});
}

afterEach(async () => {
	for (const database of databases.splice(0)) {
		await database.prisma.$disconnect();
		rmSync(database.directory, { recursive: true, force: true });
	}
});

async function database(service: "JELLYFIN" | "EMBY" | "PLEX" = "JELLYFIN") {
	const directory = mkdtempSync(join(tmpdir(), "native-inventory-runner-"));
	const dbPath = join(directory, "test.db");
	schemaFixture.copyTo(dbPath);
	const prisma = createTestPrismaClient(dbPath);
	databases.push({ directory, prisma });
	await prisma.user.create({ data: { id: "owner", username: "synthetic-owner" } });
	const instance = await prisma.serviceInstance.create({
		data: {
			id: "jellyfin-1",
			userId: "owner",
			service,
			label: "Synthetic Jellyfin",
			baseUrl: "http://jellyfin.invalid",
			encryptedApiKey: "synthetic-cipher",
			encryptionIv: "synthetic-iv",
			connectionGeneration: 2,
			expectedIdentity: "synthetic-provider",
			identityStatus: "VERIFIED",
			identityGeneration: 3,
			identityKind:
				service === "PLEX"
					? "PLEX_MACHINE_IDENTIFIER"
					: service === "EMBY"
						? "EMBY_SERVER_ID"
						: "JELLYFIN_SERVER_ID",
			identityVerifiedAt: new Date(),
		},
	});
	return { prisma, authority: createProviderPublicationAuthority(instance) };
}

function singlePageAdapter(comparisonKeys: string[]) {
	let nextPass = 0;
	return {
		domain: "library" as const,
		discoverScopes: vi.fn().mockResolvedValue({
			status: "ready",
			catalogIdentity: "stable-catalog",
			scopes: [{ scopeKey: "library:scope-a", libraryId: "scope-a" }],
		}),
		readPage: vi.fn().mockImplementation(async () => ({
			status: "page",
			domain: "library",
			scopeKey: "library:scope-a",
			startIndex: 0,
			totalRecordCount: 1,
			rawNativeIds: ["movie-1"],
			comparisonKeys: [comparisonKeys[nextPass++]],
			rows: [
				{
					nativeId: "movie-1",
					mediaType: "movie",
					libraryIds: ["scope-a"],
					parentNativeId: null,
					seasonNumber: null,
					episodeNumber: null,
					title: "Synthetic",
				},
			],
		})),
	};
}

describe("durable native inventory runner", { timeout: 30_000 }, () => {
	it.each(
		(["identity", "discovery", "provider-page"] as const).flatMap((boundary) =>
			(["throw", "unavailable"] as const).flatMap((outcome) =>
				(["exhausted", "remaining"] as const).flatMap((budget) =>
					(budget === "exhausted" ? [0, 2] : [0]).map((priorFailures) => ({
						boundary,
						outcome,
						budget,
						priorFailures,
					})),
				),
			),
		),
	)(
		"$boundary $outcome with $budget invocation budget and $priorFailures prior failures preserves committed pages",
		async ({ boundary, outcome, budget, priorFailures }) => {
			const { prisma, authority } = await database();
			await prisma.providerNativeInventorySnapshot.create({
				data: {
					instanceId: authority.id,
					domain: "library",
					generationId: "prior-head",
					observedAt: new Date(),
					connectionGeneration: authority.connectionGeneration,
					identityGeneration: authority.identityGeneration,
					scopeDigest: "a".repeat(64),
					contentDigest: "b".repeat(64),
					itemCount: 0,
					scopeCount: 0,
					lastAttemptAt: new Date(),
					lastAttemptResult: "success",
				},
			});
			await admitNativeInventoryRun(prisma, authority, "library", new Date());
			const run = await prisma.providerNativeInventoryRun.findFirstOrThrow();
			let interrupt = false;
			let clock = Date.now();
			const deadlineAt = clock + 10_000;
			const dateNow = vi.spyOn(Date, "now").mockImplementation(() => clock);
			const interruptAt = (phase: typeof boundary) => {
				if (!interrupt || phase !== boundary) return false;
				if (budget === "exhausted") clock = deadlineAt;
				if (outcome === "throw") throw new Error("Synthetic provider worker rejected");
				return true;
			};
			const readOffsets: number[] = [];
			const discoverScopes = vi.fn(async (receivedDeadline: number) => {
				expect(receivedDeadline).toBe(deadlineAt);
				if (interruptAt("discovery"))
					return { status: "unavailable" as const, reason: "deadline-exceeded" as const };
				return {
					status: "ready" as const,
					catalogIdentity: "stable-catalog",
					scopes: [{ scopeKey: "library:scope-a" }],
				};
			});
			const adapter: NativeInventoryJobAdapter<{ scopeKey: string }> = {
				domain: "library",
				discoverScopes,
				readPage: async (_scope, startIndex, _limit, receivedDeadline) => {
					expect(receivedDeadline).toBe(deadlineAt);
					readOffsets.push(startIndex);
					if (interruptAt("provider-page"))
						return { status: "unavailable", reason: "deadline-exceeded" };
					return {
						status: "page",
						domain: "library",
						scopeKey: "library:scope-a",
						startIndex,
						totalRecordCount: 2,
						rawNativeIds: [`movie-${startIndex + 1}`],
						comparisonKeys: [`Movie ${startIndex + 1}`],
						rows: [
							{
								nativeId: `movie-${startIndex + 1}`,
								mediaType: "movie",
								libraryIds: ["scope-a"],
								parentNativeId: null,
								seasonNumber: null,
								episodeNumber: null,
								title: `Synthetic ${startIndex + 1}`,
							},
						],
					};
				},
			};
			const options = { deadlineAt, maxPages: 1, pageSize: 1, retryDelayMs: 0 };
			try {
				expect(await runNativeInventoryJobSlice(prisma, run.id, adapter, options)).toEqual({
					status: "yielded",
					pagesCommitted: 1,
				});
				const receipts = await prisma.providerNativeInventoryPageReceipt.findMany();
				const stageItems = await prisma.providerNativeInventoryStageItem.findMany();
				const priorHead = await prisma.providerNativeInventorySnapshot.findFirstOrThrow();
				const pass = await prisma.providerNativeInventoryPass.findFirstOrThrow();
				expect(receipts).toHaveLength(1);
				expect(stageItems).toHaveLength(1);
				expect(pass).toMatchObject({ ordinal: 1, state: "collecting" });
				if (priorFailures > 0) {
					await prisma.providerNativeInventoryRun.update({
						where: { id: run.id },
						data: { failureCount: priorFailures, lastFailureCategory: "provider-unavailable" },
					});
				}
				interrupt = true;
				const phases: NativeInventorySlicePhase[] = [];
				const result = await runNativeInventoryJobSlice(prisma, run.id, adapter, {
					...options,
					verifyIdentity: async () => (interruptAt("identity") ? "unavailable" : "verified"),
					reportPhase: (phase) => phases.push(phase),
				});
				expect(clock >= deadlineAt).toBe(budget === "exhausted");
				// Check the persistent failure boundary, not just a returned status. Soft
				// assertions let the same RED case still exercise retention and recovery.
				expect.soft(result).toEqual({
					status: budget === "exhausted" ? "yielded" : "retryable",
					pagesCommitted: 0,
				});
				expect.soft(await prisma.providerNativeInventoryRun.findFirstOrThrow()).toMatchObject({
					state: "pending",
					passOrdinal: 1,
					claimToken: null,
					leaseUntil: null,
					failureCount: budget === "exhausted" ? priorFailures : 1,
					lastFailureCategory:
						budget === "exhausted"
							? priorFailures > 0
								? "provider-unavailable"
								: null
							: outcome === "unavailable" && boundary !== "identity"
								? "deadline-exceeded"
								: "provider-unavailable",
				});
				expect.soft(phases.at(-1)).toBe(budget === "exhausted" ? "yield" : "failure-settlement");
				expect(await prisma.providerNativeInventoryPageReceipt.findMany()).toEqual(receipts);
				expect(await prisma.providerNativeInventoryStageItem.findMany()).toEqual(stageItems);
				expect(await prisma.providerNativeInventoryPass.findFirstOrThrow()).toEqual(pass);
				expect(await prisma.providerNativeInventorySnapshot.findFirstOrThrow()).toEqual(priorHead);
				expect(await prisma.providerNativeInventoryItem.count()).toBe(0);
				interrupt = false;
				clock = deadlineAt - 10_000;
				expect(await runNativeInventoryJobSlice(prisma, run.id, adapter, options)).toEqual({
					status: "pass-complete",
					pagesCommitted: 1,
				});
				expect(readOffsets).toEqual(boundary === "provider-page" ? [0, 1, 1] : [0, 1]);
				const resumedReceipts = await prisma.providerNativeInventoryPageReceipt.findMany({
					orderBy: { startIndex: "asc" },
				});
				expect(resumedReceipts).toHaveLength(2);
				expect(resumedReceipts[0]).toEqual(receipts[0]);
				expect(resumedReceipts.map((receipt) => receipt.passId)).toEqual([pass.id, pass.id]);
				expect(
					await prisma.providerNativeInventoryPass.findUniqueOrThrow({ where: { id: pass.id } }),
				).toMatchObject({ state: "complete", ordinal: 1 });
				expect(await prisma.providerNativeInventorySnapshot.findFirstOrThrow()).toEqual(priorHead);
				expect(await prisma.providerNativeInventoryRun.findFirstOrThrow()).toMatchObject({
					state: "pending",
					passOrdinal: 2,
					failureCount: 0,
					claimToken: null,
					leaseUntil: null,
				});
			} finally {
				dateNow.mockRestore();
			}
		},
	);
	it.each(["reported", "wrong-scope"] as const)(
		"confirmed coverage failure from %s after invocation deadline still consumes a failure",
		async (outcome) => {
			const { prisma, authority } = await database();
			await admitNativeInventoryRun(prisma, authority, "library", new Date());
			const run = await prisma.providerNativeInventoryRun.findFirstOrThrow();
			const adapter = singlePageAdapter(["Movie"]);
			const readPage = adapter.readPage.getMockImplementation()!;
			let clock = Date.now();
			const deadlineAt = clock + 10_000;
			const dateNow = vi.spyOn(Date, "now").mockImplementation(() => clock);
			adapter.readPage.mockImplementationOnce(async () => {
				clock = deadlineAt;
				return outcome === "reported"
					? { status: "unavailable", reason: "coverage-incomplete" }
					: { ...(await readPage()), scopeKey: "library:unexpected-scope" };
			});
			try {
				expect(
					await runNativeInventoryJobSlice(prisma, run.id, adapter, {
						deadlineAt,
						maxPages: 1,
						pageSize: 1,
						retryDelayMs: 0,
					}),
				).toEqual({ status: "retryable", pagesCommitted: 0 });
				expect(Date.now()).toBe(deadlineAt);
				expect(await prisma.providerNativeInventoryRun.findFirstOrThrow()).toMatchObject({
					state: "pending",
					failureCount: 1,
					lastFailureCategory: "coverage-incomplete",
					claimToken: null,
					leaseUntil: null,
				});
				expect(await prisma.providerNativeInventoryPageReceipt.count()).toBe(0);
				expect(await prisma.providerNativeInventorySnapshot.count()).toBe(0);
			} finally {
				dateNow.mockRestore();
			}
		},
	);
	it("genuine provider failures before the invocation deadline retain retry and incomplete semantics", async () => {
		const { prisma, authority } = await database();
		await admitNativeInventoryRun(prisma, authority, "library", new Date());
		const run = await prisma.providerNativeInventoryRun.findFirstOrThrow();
		const adapter = singlePageAdapter(["Movie"]);
		adapter.readPage.mockRejectedValue(new Error("Synthetic provider rejection before deadline"));
		const clock = Date.now(),
			deadlineAt = clock + 10_000;
		const dateNow = vi.spyOn(Date, "now").mockReturnValue(clock);
		try {
			for (let failureCount = 1; failureCount <= 3; failureCount++) {
				expect(
					await runNativeInventoryJobSlice(prisma, run.id, adapter, {
						deadlineAt,
						maxPages: 1,
						pageSize: 1,
						retryDelayMs: 0,
					}),
				).toEqual({ status: failureCount < 3 ? "retryable" : "incomplete", pagesCommitted: 0 });
				expect(Date.now()).toBeLessThan(deadlineAt);
				expect(await prisma.providerNativeInventoryRun.findFirstOrThrow()).toMatchObject({
					state: failureCount < 3 ? "pending" : "incomplete",
					failureCount,
					lastFailureCategory: "provider-unavailable",
					claimToken: null,
					leaseUntil: null,
				});
			}
			expect(adapter.readPage).toHaveBeenCalledTimes(3);
			expect(await prisma.providerNativeInventoryPageReceipt.count()).toBe(0);
			expect(await prisma.providerNativeInventorySnapshot.count()).toBe(0);
		} finally {
			dateNow.mockRestore();
		}
	});
	it.each([
		"claim",
		"identity",
		"scope-discovery",
		"pass-begin",
		"lease-renewal",
		"provider-page",
		"page-commit",
		"pass-complete",
		"publication",
		"identity-return",
		"discovery-return",
		"page-return",
	])(
		"cancellation at %s preserves the prior head and yields without consuming failures",
		async (boundary) => {
			const { prisma, authority } = await database();
			await prisma.providerNativeInventorySnapshot.create({
				data: {
					instanceId: authority.id,
					domain: "library",
					generationId: "prior-head",
					observedAt: new Date(),
					connectionGeneration: authority.connectionGeneration,
					identityGeneration: authority.identityGeneration,
					scopeDigest: "a".repeat(64),
					contentDigest: "b".repeat(64),
					itemCount: 0,
					scopeCount: 0,
					lastAttemptAt: new Date(),
					lastAttemptResult: "success",
				},
			});
			await admitNativeInventoryRun(prisma, authority, "library", new Date());
			const run = await prisma.providerNativeInventoryRun.findFirstOrThrow();
			const adapter = singlePageAdapter(["Movie", "Movie", "Movie"]);
			const ordinary = {
				deadlineAt: Date.now() + 10_000,
				maxPages: 1,
				pageSize: 1,
				retryDelayMs: 0,
			};
			if (boundary === "publication")
				expect((await runNativeInventoryJobSlice(prisma, run.id, adapter, ordinary)).status).toBe(
					"pass-complete",
				);
			await prisma.providerNativeInventoryRun.update({
				where: { id: run.id },
				data: { failureCount: 2, lastFailureCategory: "provider-unavailable" },
			});
			const controller = new AbortController();
			if (boundary === "discovery-return") {
				const read = adapter.discoverScopes.getMockImplementation()!;
				adapter.discoverScopes.mockImplementation(async (...args) => {
					const value = await read(...args);
					controller.abort();
					return value;
				});
			}
			if (boundary === "page-return") {
				const read = adapter.readPage.getMockImplementation()!;
				adapter.readPage.mockImplementation(async (...args) => {
					const value = await read(...args);
					controller.abort();
					return value;
				});
			}
			const result = await runNativeInventoryJobSlice(prisma, run.id, adapter, {
				...ordinary,
				signal: controller.signal,
				verifyIdentity: async () => {
					if (boundary === "identity-return") controller.abort();
					return "verified";
				},
				reportPhase: (phase) => {
					if (phase === boundary) controller.abort();
				},
			});
			expect(result.status).toBe("yielded");
			expect(await prisma.providerNativeInventorySnapshot.findFirstOrThrow()).toMatchObject({
				generationId: "prior-head",
			});
			expect(await prisma.providerNativeInventoryRun.findFirstOrThrow()).toMatchObject({
				state: "pending",
				claimToken: null,
				leaseUntil: null,
				failureCount: ["pass-complete", "publication"].includes(boundary) ? 0 : 2,
			});
			if (["identity-return", "discovery-return", "page-return", "page-commit"].includes(boundary))
				expect(await prisma.providerNativeInventoryPageReceipt.count()).toBe(0);
		},
	);
	it("an already aborted runner never claims work", async () => {
		const { prisma, authority } = await database();
		await admitNativeInventoryRun(prisma, authority, "library", new Date());
		const run = await prisma.providerNativeInventoryRun.findFirstOrThrow();
		const controller = new AbortController();
		controller.abort();
		expect(
			await runNativeInventoryJobSlice(prisma, run.id, singlePageAdapter(["Movie"]), {
				signal: controller.signal,
				deadlineAt: Date.now() + 10_000,
				maxPages: 1,
				pageSize: 1,
				retryDelayMs: 0,
			}),
		).toEqual({ status: "yielded", pagesCommitted: 0 });
		expect(await prisma.providerNativeInventoryRun.findFirstOrThrow()).toMatchObject({
			state: "pending",
			claimToken: null,
			failureCount: 0,
		});
		expect(await prisma.providerNativeInventoryPass.count()).toBe(0);
	});
	it.each(["token", "lease", "identity"])(
		"cancellation cannot release a changed %s fence",
		async (drift) => {
			const { prisma, authority } = await database();
			await admitNativeInventoryRun(prisma, authority, "library", new Date());
			const run = await prisma.providerNativeInventoryRun.findFirstOrThrow(),
				controller = new AbortController();
			const adapter = singlePageAdapter(["Movie"]),
				read = adapter.readPage.getMockImplementation()!;
			adapter.readPage.mockImplementation(async (...args) => {
				if (drift === "identity")
					await prisma.serviceInstance.update({
						where: { id: authority.id },
						data: { identityGeneration: authority.identityGeneration + 1 },
					});
				else
					await prisma.providerNativeInventoryRun.update({
						where: { id: run.id },
						data:
							drift === "token"
								? { claimToken: "replacement-token" }
								: { leaseUntil: new Date(Date.now() - 1) },
					});
				controller.abort();
				return await read(...args);
			});
			expect(
				(
					await runNativeInventoryJobSlice(prisma, run.id, adapter, {
						signal: controller.signal,
						deadlineAt: Date.now() + 10_000,
						maxPages: 1,
						pageSize: 1,
						retryDelayMs: 0,
					})
				).status,
			).toBe("superseded");
			const retained = await prisma.providerNativeInventoryRun.findFirstOrThrow();
			expect(retained.claimToken).not.toBeNull();
			if (drift === "token") expect(retained.claimToken).toBe("replacement-token");
			expect(retained.failureCount).toBe(0);
			expect(await prisma.providerNativeInventorySnapshot.count()).toBe(0);
			expect(await prisma.providerNativeInventoryPageReceipt.count()).toBe(0);
		},
	);
	it("resumes cancelled work only after two complete consecutive passes", async () => {
		const { prisma, authority } = await database();
		await admitNativeInventoryRun(prisma, authority, "library", new Date());
		const run = await prisma.providerNativeInventoryRun.findFirstOrThrow(),
			controller = new AbortController();
		const adapter = singlePageAdapter(["Movie", "Movie", "Movie"]),
			read = adapter.readPage.getMockImplementation()!;
		adapter.readPage.mockImplementationOnce(async (...args) => {
			const page = await read(...args);
			controller.abort();
			return page;
		});
		const options = { deadlineAt: Date.now() + 10_000, maxPages: 1, pageSize: 1, retryDelayMs: 0 };
		expect(
			(
				await runNativeInventoryJobSlice(prisma, run.id, adapter, {
					...options,
					signal: controller.signal,
				})
			).status,
		).toBe("yielded");
		expect(await prisma.providerNativeInventoryPageReceipt.count()).toBe(0);
		expect((await runNativeInventoryJobSlice(prisma, run.id, adapter, options)).status).toBe(
			"pass-complete",
		);
		expect(await prisma.providerNativeInventorySnapshot.count()).toBe(0);
		expect((await runNativeInventoryJobSlice(prisma, run.id, adapter, options)).status).toBe(
			"published",
		);
		expect(await prisma.providerNativeInventorySnapshot.count()).toBe(1);
	});
	it.each(["page-commit", "publication"] as const)(
		"keeps an already-started blocked %s owned until actual database settlement",
		async (phase) => {
			const { prisma, authority } = await database();
			await admitNativeInventoryRun(prisma, authority, "library", new Date());
			const run = await prisma.providerNativeInventoryRun.findFirstOrThrow(),
				adapter = singlePageAdapter(["Movie", "Movie"]);
			const options = {
				deadlineAt: Date.now() + 10_000,
				maxPages: 1,
				pageSize: 1,
				retryDelayMs: 0,
			};
			if (phase === "publication")
				await runNativeInventoryJobSlice(prisma, run.id, adapter, options);
			let release!: () => void, entered!: () => void;
			const gate = new Promise<void>((resolve) => {
					release = resolve;
				}),
				started = new Promise<void>((resolve) => {
					entered = resolve;
				});
			let armed = false,
				held = false,
				settled = false;
			const controller = new AbortController();
			const transaction = prisma.$transaction.bind(prisma) as unknown as (
				action: (tx: unknown) => Promise<unknown>,
				options?: unknown,
			) => Promise<unknown>;
			const joined = new Proxy(prisma, {
				get(target, key) {
					if (key === "$transaction")
						return async (action: (tx: unknown) => Promise<unknown>, txOptions?: unknown) =>
							transaction(async (tx) => {
								if (armed && !held) {
									held = true;
									entered();
									await gate;
								}
								return await action(tx);
							}, txOptions);
					const value = Reflect.get(target, key, target);
					return typeof value === "function" ? value.bind(target) : value;
				},
			}) as PrismaClient;
			const pending = runNativeInventoryJobSlice(joined, run.id, adapter, {
				...options,
				signal: controller.signal,
				reportPhase: (next) => {
					if (next === phase) armed = true;
				},
			}).finally(() => {
				settled = true;
			});
			try {
				await started;
				controller.abort();
				await new Promise<void>((resolve) => setImmediate(resolve));
				expect(settled).toBe(false);
				release();
				expect((await pending).status).toBe(phase === "publication" ? "published" : "yielded");
				expect(await prisma.providerNativeInventorySnapshot.count()).toBe(
					phase === "publication" ? 1 : 0,
				);
			} finally {
				release();
				await pending;
			}
		},
	);
	it.each(["JELLYFIN", "EMBY"] as const)(
		"rejects a replacement %s server before reading native pages",
		async (service) => {
			const { prisma, authority } = await database(service);
			await admitNativeInventoryRun(prisma, authority, "library", new Date());
			const identityRead = vi
				.spyOn(nativeControl, "runNativeControlWorker")
				.mockResolvedValue({ status: "identity", identity: "synthetic-replacement" });
			const catalogRead = vi.spyOn(JellyfinClient.prototype, "getNativeMediaFolders");
			try {
				const app = {
					prisma,
					encryptor: { decrypt: vi.fn(() => "synthetic-token") },
					log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
				};
				expect(
					await runDueNativeInventoryWork(app as never, {
						maxRuns: 1,
						maxConcurrent: 1,
						maxPagesPerRun: 1,
						pageSize: 1,
						maxDurationMs: 10_000,
						retryDelayMs: 0,
					}),
				).toMatchObject({ superseded: 1, completed: 0 });
				expect(identityRead).toHaveBeenCalledOnce();
				expect(catalogRead).not.toHaveBeenCalled();
				expect(
					await prisma.serviceInstance.findUniqueOrThrow({ where: { id: authority.id } }),
				).toMatchObject({ identityStatus: "MISMATCH", expectedIdentity: "synthetic-provider" });
				expect(await prisma.providerNativeInventorySnapshot.count()).toBe(0);
			} finally {
				identityRead.mockRestore();
				catalogRead.mockRestore();
			}
		},
	);
	it("rejects a replacement Plex server before the production job reads catalog pages", async () => {
		const { prisma, authority } = await database("PLEX");
		await admitNativeInventoryRun(prisma, authority, "paired", new Date());
		const identityRead = vi
			.spyOn(nativeControl, "runNativeControlWorker")
			.mockResolvedValue({ status: "identity", identity: "synthetic-replacement" });
		const catalogRead = vi.spyOn(PlexClient.prototype, "getLibrarySettlementSections");
		try {
			const app = {
				prisma,
				encryptor: { decrypt: vi.fn(() => "synthetic-token") },
				log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
			};
			expect(
				await runDueNativeInventoryWork(app as never, {
					maxRuns: 1,
					maxConcurrent: 1,
					maxPagesPerRun: 1,
					pageSize: 1,
					maxDurationMs: 10_000,
					retryDelayMs: 0,
				}),
			).toMatchObject({ superseded: 1, completed: 0 });
			expect(identityRead).toHaveBeenCalledOnce();
			expect(catalogRead).not.toHaveBeenCalled();
			expect(
				await prisma.serviceInstance.findUniqueOrThrow({ where: { id: authority.id } }),
			).toMatchObject({ identityStatus: "MISMATCH", expectedIdentity: "synthetic-provider" });
			expect(await prisma.providerNativeInventoryRun.findFirstOrThrow()).toMatchObject({
				state: "superseded",
				activeSlotKey: null,
				claimToken: null,
			});
			expect(await prisma.providerNativeInventorySnapshot.count()).toBe(0);
		} finally {
			identityRead.mockRestore();
			catalogRead.mockRestore();
		}
	});
	it("admits initial domains but cools down a terminal failure before a new scan", async () => {
		const { prisma } = await database();
		const now = new Date();
		const cadence = {
			maxInstances: 4,
			refreshIntervalMs: 30 * 60_000,
			retryCooldownMs: 5 * 60_000,
		};
		expect(await schedulePeriodicNativeInventoryWork(prisma, now, cadence)).toMatchObject({
			accepted: 2,
			coalesced: 0,
		});
		expect(await schedulePeriodicNativeInventoryWork(prisma, now, cadence)).toMatchObject({
			accepted: 0,
		});
		expect(await prisma.providerNativeInventoryRun.count()).toBe(2);
		await prisma.providerNativeInventoryRun.updateMany({
			data: { state: "incomplete", activeSlotKey: null, claimToken: null, leaseUntil: null },
		});
		expect(
			await schedulePeriodicNativeInventoryWork(prisma, new Date(now.getTime() + 60_000), cadence),
		).toMatchObject({ accepted: 0 });
		expect(
			await schedulePeriodicNativeInventoryWork(
				prisma,
				new Date(now.getTime() + 6 * 60_000),
				cadence,
			),
		).toMatchObject({ accepted: 2 });
		expect(await prisma.providerNativeInventoryRun.count()).toBe(4);
	});

	it("turns credential preparation failure into a bounded retry without provider I/O", async () => {
		const { prisma, authority } = await database();
		await admitNativeInventoryRun(prisma, authority, "library", new Date());
		const decrypt = vi.fn(() => {
			throw new Error("private synthetic credential detail");
		});
		const app = {
			prisma,
			encryptor: { decrypt },
			log: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
		};
		const result = await runDueNativeInventoryWork(app as never, {
			maxRuns: 1,
			maxConcurrent: 1,
			maxPagesPerRun: 1,
			pageSize: 1,
			maxDurationMs: 5_000,
			retryDelayMs: 30_000,
		});
		expect(result).toMatchObject({ completed: 0, retryable: 1, superseded: 0 });
		expect(decrypt).toHaveBeenCalledOnce();
		expect(await prisma.providerNativeInventoryRun.findFirstOrThrow()).toMatchObject({
			state: "pending",
			claimToken: null,
			leaseUntil: null,
			failureCount: 1,
			lastFailureCategory: "provider-unavailable",
		});
		expect(
			JSON.stringify(app.log.info.mock.calls) + JSON.stringify(app.log.error.mock.calls),
		).not.toContain("private synthetic credential detail");
	});

	it("resumes a due job from the database through a replacement scheduler invocation", async () => {
		const { prisma, authority } = await database();
		await admitNativeInventoryRun(prisma, authority, "library", new Date());
		const adapter = singlePageAdapter(["Movie", "Movie"]);
		const budget = {
			maxRuns: 1,
			maxConcurrent: 1,
			maxPagesPerRun: 1,
			pageSize: 1,
			maxDurationMs: 5_000,
			retryDelayMs: 0,
		};
		const executeRun = async (
			run: { id: string },
			options: { deadlineAt: number; maxPages: number; pageSize: number; retryDelayMs: number },
		) => await runNativeInventoryJobSlice(prisma, run.id, adapter, options);
		const app = () => ({
			prisma,
			encryptor: { decrypt: vi.fn() },
			log: { info: vi.fn(), error: vi.fn() },
		});
		expect(await runDueNativeInventoryWork(app() as never, budget, { executeRun })).toMatchObject({
			completed: 0,
			retryable: 1,
		});
		expect(await prisma.providerNativeInventorySnapshot.count()).toBe(0);
		expect(await runDueNativeInventoryWork(app() as never, budget, { executeRun })).toMatchObject({
			completed: 1,
			retryable: 0,
		});
		expect(adapter.readPage).toHaveBeenCalledTimes(2);
		expect(
			await readNativeInventoryPage(prisma, {
				userId: authority.userId,
				instanceId: authority.id,
				domain: "library",
			}),
		).toMatchObject({ status: "available", complete: true });
	});
	it("admits separate Jellyfin domains and coalesces a duplicate canonical request", async () => {
		const { prisma, authority } = await database();
		expect(await requestNativeInventoryRefresh(prisma, authority, ["library", "episode"])).toEqual({
			status: "accepted",
		});
		expect(await requestNativeInventoryRefresh(prisma, authority, ["library", "episode"])).toEqual({
			status: "coalesced",
		});
		expect(await prisma.providerNativeInventoryRun.count()).toBe(2);
		expect(await prisma.providerNativeInventoryRun.findMany({ select: { workKey: true } })).toEqual(
			expect.arrayContaining([{ workKey: "library" }, { workKey: "episode" }]),
		);
	});

	it("does not rescan fresh published domains for an automatic canonical refresh", async () => {
		const { prisma, authority } = await database();
		const now = new Date();
		for (const domain of ["library", "episode"] as const) {
			await prisma.providerNativeInventorySnapshot.create({
				data: {
					instanceId: authority.id,
					domain,
					generationId: `generation-${domain}`,
					observedAt: new Date(now.getTime() - 18 * 60_000),
					connectionGeneration: authority.connectionGeneration,
					identityGeneration: authority.identityGeneration,
					scopeDigest: "a".repeat(64),
					contentDigest: "b".repeat(64),
					itemCount: 0,
					scopeCount: 1,
					lastAttemptAt: new Date(now.getTime() - 18 * 60_000),
					lastAttemptResult: "success",
				},
			});
		}
		expect(
			await requestNativeInventoryRefresh(prisma, authority, ["library", "episode"], {
				mode: "automatic",
				now,
			}),
		).toEqual({ status: "current" });
		expect(await prisma.providerNativeInventoryRun.count()).toBe(0);
	});

	it("schedules only the stale domain and preserves the fresh one", async () => {
		const { prisma, authority } = await database();
		const now = new Date();
		for (const domain of ["library", "episode"] as const) {
			await prisma.providerNativeInventorySnapshot.create({
				data: {
					instanceId: authority.id,
					domain,
					generationId: `generation-${domain}`,
					observedAt: new Date(now.getTime() - (domain === "library" ? 18 : 31) * 60_000),
					connectionGeneration: authority.connectionGeneration,
					identityGeneration: authority.identityGeneration,
					scopeDigest: "a".repeat(64),
					contentDigest: "b".repeat(64),
					itemCount: 0,
					scopeCount: 1,
					lastAttemptAt: new Date(now.getTime() - (domain === "library" ? 18 : 31) * 60_000),
					lastAttemptResult: "success",
				},
			});
		}
		expect(
			await requestNativeInventoryRefresh(prisma, authority, ["library", "episode"], {
				mode: "automatic",
				now,
			}),
		).toEqual({ status: "accepted" });
		expect(await prisma.providerNativeInventoryRun.findMany({ select: { workKey: true } })).toEqual(
			[{ workKey: "episode" }],
		);
	});

	it("forces a new scan of fresh domains for an operator request", async () => {
		const { prisma, authority } = await database();
		const now = new Date();
		for (const domain of ["library", "episode"] as const) {
			await prisma.providerNativeInventorySnapshot.create({
				data: {
					instanceId: authority.id,
					domain,
					generationId: `generation-${domain}`,
					observedAt: now,
					connectionGeneration: authority.connectionGeneration,
					identityGeneration: authority.identityGeneration,
					scopeDigest: "a".repeat(64),
					contentDigest: "b".repeat(64),
					itemCount: 0,
					scopeCount: 1,
					lastAttemptAt: now,
					lastAttemptResult: "success",
				},
			});
		}
		expect(
			await requestNativeInventoryRefresh(prisma, authority, ["library", "episode"], {
				mode: "force",
				now,
			}),
		).toEqual({ status: "accepted" });
		expect(await prisma.providerNativeInventoryRun.count()).toBe(2);
	});

	it("does not call a changed identity current even when its old head is fresh", async () => {
		const { prisma, authority } = await database();
		const now = new Date();
		await prisma.providerNativeInventorySnapshot.create({
			data: {
				instanceId: authority.id,
				domain: "library",
				generationId: "generation-library",
				observedAt: now,
				connectionGeneration: authority.connectionGeneration,
				identityGeneration: authority.identityGeneration,
				scopeDigest: "a".repeat(64),
				contentDigest: "b".repeat(64),
				itemCount: 0,
				scopeCount: 1,
				lastAttemptAt: now,
				lastAttemptResult: "success",
			},
		});
		await prisma.serviceInstance.update({
			where: { id: authority.id },
			data: { identityGeneration: authority.identityGeneration + 1 },
		});
		expect(
			await requestNativeInventoryRefresh(prisma, authority, ["library"], {
				mode: "automatic",
				now,
			}),
		).toEqual({ status: "superseded" });
		expect(await prisma.providerNativeInventoryRun.count()).toBe(0);
	});

	it("does not call paired domain reads current after authority changes between them", async () => {
		const { prisma, authority } = await database("PLEX");
		const now = new Date();
		for (const domain of ["library", "episode"] as const) {
			await prisma.providerNativeInventorySnapshot.create({
				data: {
					instanceId: authority.id,
					domain,
					generationId: "paired-generation",
					observedAt: now,
					connectionGeneration: authority.connectionGeneration,
					identityGeneration: authority.identityGeneration,
					scopeDigest: "a".repeat(64),
					contentDigest: "b".repeat(64),
					itemCount: 0,
					scopeCount: 1,
					lastAttemptAt: now,
					lastAttemptResult: "success",
				},
			});
		}
		const transaction = prisma.$transaction.bind(prisma) as unknown as (
			operation: (tx: unknown) => Promise<unknown>,
			options?: unknown,
		) => Promise<unknown>;
		let reads = 0;
		const interleavedPrisma = new Proxy(prisma, {
			get(target, property) {
				if (property === "$transaction") {
					return async (operation: (tx: unknown) => Promise<unknown>, options?: unknown) => {
						const result = await transaction(operation, options);
						if (++reads === 1) {
							await prisma.serviceInstance.update({
								where: { id: authority.id },
								data: { identityGeneration: authority.identityGeneration + 1 },
							});
						}
						return result;
					};
				}
				const value = Reflect.get(target, property, target);
				return typeof value === "function" ? value.bind(target) : value;
			},
		}) as PrismaClient;
		expect(
			await requestNativeInventoryRefresh(interleavedPrisma, authority, ["paired"], {
				mode: "automatic",
				now,
			}),
		).toEqual({ status: "superseded" });
		expect(await prisma.providerNativeInventoryRun.count()).toBe(0);
	});

	it("coalesces an active automatic run even when the previous head is fresh", async () => {
		const { prisma, authority } = await database();
		const now = new Date();
		await prisma.providerNativeInventorySnapshot.create({
			data: {
				instanceId: authority.id,
				domain: "library",
				generationId: "prior-generation",
				observedAt: now,
				connectionGeneration: authority.connectionGeneration,
				identityGeneration: authority.identityGeneration,
				scopeDigest: "a".repeat(64),
				contentDigest: "b".repeat(64),
				itemCount: 0,
				scopeCount: 1,
				lastAttemptAt: now,
				lastAttemptResult: "success",
			},
		});
		await admitNativeInventoryRun(prisma, authority, "library", now);
		expect(
			await requestNativeInventoryRefresh(prisma, authority, ["library"], {
				mode: "automatic",
				now,
			}),
		).toEqual({ status: "coalesced" });
		expect(await prisma.providerNativeInventoryRun.count()).toBe(1);
	});

	it("does not call a malformed fresh head current", async () => {
		const { prisma, authority } = await database();
		const now = new Date();
		await prisma.providerNativeInventorySnapshot.create({
			data: {
				instanceId: authority.id,
				domain: "library",
				generationId: "prior-generation",
				observedAt: now,
				connectionGeneration: authority.connectionGeneration,
				identityGeneration: authority.identityGeneration,
				scopeDigest: "bad-digest",
				contentDigest: "b".repeat(64),
				itemCount: 1,
				scopeCount: 1,
				lastAttemptAt: now,
				lastAttemptResult: "success",
			},
		});
		expect(
			await requestNativeInventoryRefresh(prisma, authority, ["library"], {
				mode: "automatic",
				now,
			}),
		).toEqual({ status: "accepted" });
		expect(await prisma.providerNativeInventoryRun.count()).toBe(1);
	});

	it("does not call a fresh head with missing rows current", async () => {
		const { prisma, authority } = await database();
		const now = new Date();
		await prisma.providerNativeInventorySnapshot.create({
			data: {
				instanceId: authority.id,
				domain: "library",
				generationId: "prior-generation",
				observedAt: now,
				connectionGeneration: authority.connectionGeneration,
				identityGeneration: authority.identityGeneration,
				scopeDigest: "a".repeat(64),
				contentDigest: "b".repeat(64),
				itemCount: 1,
				scopeCount: 1,
				lastAttemptAt: now,
				lastAttemptResult: "success",
			},
		});
		expect(
			await requestNativeInventoryRefresh(prisma, authority, ["library"], {
				mode: "automatic",
				now,
			}),
		).toEqual({ status: "accepted" });
	});

	it("retries a newer terminal failure instead of calling its older head current", async () => {
		const { prisma, authority } = await database();
		const now = new Date();
		await prisma.providerNativeInventorySnapshot.create({
			data: {
				instanceId: authority.id,
				domain: "library",
				generationId: "prior-generation",
				observedAt: new Date(now.getTime() - 60_000),
				connectionGeneration: authority.connectionGeneration,
				identityGeneration: authority.identityGeneration,
				scopeDigest: "a".repeat(64),
				contentDigest: "b".repeat(64),
				itemCount: 0,
				scopeCount: 1,
				lastAttemptAt: new Date(now.getTime() - 60_000),
				lastAttemptResult: "success",
			},
		});
		await admitNativeInventoryRun(prisma, authority, "library", now);
		await prisma.providerNativeInventoryRun.updateMany({
			data: { state: "incomplete", activeSlotKey: null, claimToken: null, leaseUntil: null },
		});
		expect(
			await requestNativeInventoryRefresh(prisma, authority, ["library"], {
				mode: "automatic",
				now,
			}),
		).toEqual({ status: "accepted" });
		expect(await prisma.providerNativeInventoryRun.count()).toBe(2);
	});

	it("periodic admission repairs a malformed recent head without rescanning a valid domain", async () => {
		const { prisma, authority } = await database();
		const now = new Date();
		for (const domain of ["library", "episode"] as const) {
			await prisma.providerNativeInventorySnapshot.create({
				data: {
					instanceId: authority.id,
					domain,
					generationId: `generation-${domain}`,
					observedAt: now,
					connectionGeneration: authority.connectionGeneration,
					identityGeneration: authority.identityGeneration,
					scopeDigest: "a".repeat(64),
					contentDigest: "b".repeat(64),
					itemCount: domain === "library" ? 1 : 0,
					scopeCount: 1,
					lastAttemptAt: now,
					lastAttemptResult: "success",
				},
			});
		}
		expect(
			await schedulePeriodicNativeInventoryWork(prisma, now, {
				maxInstances: 4,
				refreshIntervalMs: 30 * 60_000,
				retryCooldownMs: 5 * 60_000,
			}),
		).toMatchObject({ accepted: 1, skipped: 1 });
		expect(await prisma.providerNativeInventoryRun.findMany({ select: { workKey: true } })).toEqual(
			[{ workKey: "library" }],
		);
	});

	it("returns a bounded pending attempt separately from an absent publication", async () => {
		const { prisma, authority } = await database();
		await admitNativeInventoryRun(prisma, authority, "library", new Date());
		expect(
			await readNativeInventoryPage(prisma, {
				userId: authority.userId,
				instanceId: authority.id,
				domain: "library",
				includeAttempt: true,
			}),
		).toEqual({
			status: "unavailable",
			reason: "no-publication",
			attempt: {
				state: "pending",
				passOrdinal: 1,
				pagesCompleted: 0,
				itemsStaged: 0,
				failureCount: 0,
				reasonCode: null,
			},
		});
	});
	it("publishes both Plex domains atomically after matching settled paired passes", async () => {
		const { prisma, authority } = await database("PLEX");
		await admitNativeInventoryRun(prisma, authority, "paired", new Date());
		const run = await prisma.providerNativeInventoryRun.findFirstOrThrow();
		const getActivities = vi.fn().mockResolvedValue([]);
		const getLibrarySettlementSections = vi.fn().mockResolvedValue([
			{
				key: "shows",
				uuid: "uuid-shows",
				title: "Synthetic",
				type: "show",
				refreshing: false,
				scannedAt: 10,
				updatedAt: 10,
			},
		]);
		const providerPage = vi
			.fn()
			.mockImplementation(async (input: { domain: string; startIndex: number }) =>
				input.domain === "library"
					? {
							status: "page",
							domain: "library",
							startIndex: input.startIndex,
							totalRecordCount: 1,
							items: [{ ratingKey: "show-1", type: "show", title: "Synthetic" }],
						}
					: {
							status: "page",
							domain: "episode",
							startIndex: input.startIndex,
							totalRecordCount: 1,
							items: [
								{
									ratingKey: "episode-1",
									type: "episode",
									title: "Synthetic",
									grandparentRatingKey: "show-1",
									seasonNumber: 1,
									episodeNumber: 2,
								},
							],
						},
			);
		const adapter = createPlexNativeJobAdapter({
			getActivities,
			getLibrarySettlementSections,
			readNativeInventoryPage: providerPage,
		});
		const options = { deadlineAt: Date.now() + 10_000, maxPages: 2, pageSize: 1, retryDelayMs: 0 };
		expect((await runNativeInventoryJobSlice(prisma, run.id, adapter, options)).status).toBe(
			"pass-complete",
		);
		expect(await prisma.providerNativeInventorySnapshot.count()).toBe(0);
		expect((await runNativeInventoryJobSlice(prisma, run.id, adapter, options)).status).toBe(
			"published",
		);
		expect(await prisma.providerNativeInventorySnapshot.count()).toBe(2);
		expect(
			await readNativeInventoryPage(prisma, {
				userId: authority.userId,
				instanceId: authority.id,
				domain: "library",
			}),
		).toMatchObject({ status: "available", complete: true, rows: [{ nativeId: "show-1" }] });
		expect(
			await readNativeInventoryPage(prisma, {
				userId: authority.userId,
				instanceId: authority.id,
				domain: "episode",
			}),
		).toMatchObject({ status: "available", complete: true, rows: [{ nativeId: "episode-1" }] });
		expect(getLibrarySettlementSections).toHaveBeenCalledTimes(4);
	});

	it("keeps both Plex heads unpublished when one native ID crosses domains", async () => {
		const { prisma, authority } = await database("PLEX");
		await admitNativeInventoryRun(prisma, authority, "paired", new Date());
		const run = await prisma.providerNativeInventoryRun.findFirstOrThrow();
		const adapter = createPlexNativeJobAdapter({
			getActivities: vi.fn().mockResolvedValue([]),
			getLibrarySettlementSections: vi.fn().mockResolvedValue([
				{
					key: "shows",
					uuid: "uuid-shows",
					title: "Synthetic",
					type: "show",
					refreshing: false,
					scannedAt: 10,
					updatedAt: 10,
				},
			]),
			readNativeInventoryPage: vi
				.fn()
				.mockImplementation(async (input: { domain: string; startIndex: number }) =>
					input.domain === "library"
						? {
								status: "page",
								domain: "library",
								startIndex: input.startIndex,
								totalRecordCount: 1,
								items: [{ ratingKey: "duplicate-1", type: "show", title: "Synthetic" }],
							}
						: {
								status: "page",
								domain: "episode",
								startIndex: input.startIndex,
								totalRecordCount: 1,
								items: [
									{
										ratingKey: "duplicate-1",
										type: "episode",
										title: "Synthetic",
										grandparentRatingKey: null,
										seasonNumber: null,
										episodeNumber: null,
									},
								],
							},
				),
		});
		const result = await runNativeInventoryJobSlice(prisma, run.id, adapter, {
			deadlineAt: Date.now() + 10_000,
			maxPages: 2,
			pageSize: 1,
			retryDelayMs: 0,
		});
		expect(result.status).toBe("retryable");
		expect(await prisma.providerNativeInventorySnapshot.count()).toBe(0);
	});

	it("rejects Plex catalog drift at the pass-end settled probe", async () => {
		const { prisma, authority } = await database("PLEX");
		await admitNativeInventoryRun(prisma, authority, "paired", new Date());
		const run = await prisma.providerNativeInventoryRun.findFirstOrThrow();
		const getLibrarySettlementSections = vi
			.fn()
			.mockResolvedValueOnce([
				{
					key: "shows",
					uuid: "uuid-shows",
					title: "Synthetic",
					type: "show",
					refreshing: false,
					scannedAt: 10,
					updatedAt: 10,
				},
			])
			.mockResolvedValueOnce([
				{
					key: "shows",
					uuid: "uuid-shows",
					title: "Synthetic",
					type: "show",
					refreshing: false,
					scannedAt: 11,
					updatedAt: 10,
				},
			]);
		const adapter = createPlexNativeJobAdapter({
			getActivities: vi.fn().mockResolvedValue([]),
			getLibrarySettlementSections,
			readNativeInventoryPage: vi
				.fn()
				.mockImplementation(async (input: { domain: string; startIndex: number }) =>
					input.domain === "library"
						? {
								status: "page",
								domain: "library",
								startIndex: input.startIndex,
								totalRecordCount: 1,
								items: [{ ratingKey: "show-1", type: "show", title: "Synthetic" }],
							}
						: {
								status: "page",
								domain: "episode",
								startIndex: input.startIndex,
								totalRecordCount: 1,
								items: [
									{
										ratingKey: "episode-1",
										type: "episode",
										title: "Synthetic",
										grandparentRatingKey: "show-1",
										seasonNumber: 1,
										episodeNumber: 2,
									},
								],
							},
				),
		});
		expect(
			(
				await runNativeInventoryJobSlice(prisma, run.id, adapter, {
					deadlineAt: Date.now() + 10_000,
					maxPages: 2,
					pageSize: 1,
					retryDelayMs: 0,
				})
			).status,
		).toBe("retryable");
		expect(await prisma.providerNativeInventorySnapshot.count()).toBe(0);
		expect(await prisma.providerNativeInventoryPageReceipt.count()).toBe(2);
	});

	it("requires two new paired passes when Plex's settled catalog changes between passes", async () => {
		const { prisma, authority } = await database("PLEX");
		await admitNativeInventoryRun(prisma, authority, "paired", new Date());
		const run = await prisma.providerNativeInventoryRun.findFirstOrThrow();
		const section = (scannedAt: number) => ({
			key: "shows",
			uuid: "uuid-shows",
			title: "Synthetic",
			type: "show",
			refreshing: false,
			scannedAt,
			updatedAt: 10,
		});
		const getLibrarySettlementSections = vi
			.fn()
			.mockResolvedValueOnce([section(10)])
			.mockResolvedValueOnce([section(10)])
			.mockResolvedValue([section(11)]);
		const adapter = createPlexNativeJobAdapter({
			getActivities: vi.fn().mockResolvedValue([]),
			getLibrarySettlementSections,
			readNativeInventoryPage: vi
				.fn()
				.mockImplementation(async (input: { domain: string; startIndex: number }) =>
					input.domain === "library"
						? {
								status: "page",
								domain: "library",
								startIndex: input.startIndex,
								totalRecordCount: 1,
								items: [{ ratingKey: "show-1", type: "show", title: "Synthetic" }],
							}
						: {
								status: "page",
								domain: "episode",
								startIndex: input.startIndex,
								totalRecordCount: 1,
								items: [
									{
										ratingKey: "episode-1",
										type: "episode",
										title: "Synthetic",
										grandparentRatingKey: "show-1",
										seasonNumber: 1,
										episodeNumber: 2,
									},
								],
							},
				),
		});
		const options = { deadlineAt: Date.now() + 10_000, maxPages: 2, pageSize: 1, retryDelayMs: 0 };
		expect((await runNativeInventoryJobSlice(prisma, run.id, adapter, options)).status).toBe(
			"pass-complete",
		);
		expect((await runNativeInventoryJobSlice(prisma, run.id, adapter, options)).status).toBe(
			"retryable",
		);
		expect(await prisma.providerNativeInventorySnapshot.count()).toBe(0);
		expect(
			(await prisma.providerNativeInventoryRun.findUniqueOrThrow({ where: { id: run.id } }))
				.passOrdinal,
		).toBe(3);
		expect((await runNativeInventoryJobSlice(prisma, run.id, adapter, options)).status).toBe(
			"published",
		);
		expect(await prisma.providerNativeInventorySnapshot.count()).toBe(2);
	});

	it("resumes Plex's second domain after a persisted first-domain page", async () => {
		const { prisma, authority } = await database("PLEX");
		await admitNativeInventoryRun(prisma, authority, "paired", new Date());
		const run = await prisma.providerNativeInventoryRun.findFirstOrThrow();
		const providerPage = vi
			.fn()
			.mockImplementation(async (input: { domain: string; startIndex: number }) =>
				input.domain === "library"
					? {
							status: "page",
							domain: "library",
							startIndex: input.startIndex,
							totalRecordCount: 1,
							items: [{ ratingKey: "show-1", type: "show", title: "Synthetic" }],
						}
					: {
							status: "page",
							domain: "episode",
							startIndex: input.startIndex,
							totalRecordCount: 1,
							items: [
								{
									ratingKey: "episode-1",
									type: "episode",
									title: "Synthetic",
									grandparentRatingKey: "show-1",
									seasonNumber: 1,
									episodeNumber: 2,
								},
							],
						},
			);
		const adapter = createPlexNativeJobAdapter({
			getActivities: vi.fn().mockResolvedValue([]),
			getLibrarySettlementSections: vi.fn().mockResolvedValue([
				{
					key: "shows",
					uuid: "uuid-shows",
					title: "Synthetic",
					type: "show",
					refreshing: false,
					scannedAt: 10,
					updatedAt: 10,
				},
			]),
			readNativeInventoryPage: providerPage,
		});
		const options = { deadlineAt: Date.now() + 10_000, maxPages: 1, pageSize: 1, retryDelayMs: 0 };
		expect((await runNativeInventoryJobSlice(prisma, run.id, adapter, options)).status).toBe(
			"yielded",
		);
		expect((await runNativeInventoryJobSlice(prisma, run.id, adapter, options)).status).toBe(
			"pass-complete",
		);
		expect(providerPage.mock.calls.map(([input]) => input.domain)).toEqual(["library", "episode"]);
		expect(await prisma.providerNativeInventorySnapshot.count()).toBe(0);
		expect((await runNativeInventoryJobSlice(prisma, run.id, adapter, options)).status).toBe(
			"yielded",
		);
		expect((await runNativeInventoryJobSlice(prisma, run.id, adapter, options)).status).toBe(
			"published",
		);
		expect(providerPage.mock.calls.map(([input]) => input.domain)).toEqual([
			"library",
			"episode",
			"library",
			"episode",
		]);
		expect(await prisma.providerNativeInventorySnapshot.count()).toBe(2);
	});
	it("releases a claim selected with the wrong adapter without provider I/O", async () => {
		const { prisma, authority } = await database();
		await admitNativeInventoryRun(prisma, authority, "library", new Date());
		const run = await prisma.providerNativeInventoryRun.findFirstOrThrow();
		const adapter = {
			domain: "episode" as const,
			discoverScopes: vi.fn(),
			readPage: vi.fn(),
		};
		const options = { deadlineAt: Date.now() + 10_000, maxPages: 1, pageSize: 1, retryDelayMs: 0 };
		expect(await runNativeInventoryJobSlice(prisma, run.id, adapter, options)).toEqual({
			status: "superseded",
			pagesCommitted: 0,
		});
		expect(adapter.discoverScopes).not.toHaveBeenCalled();
		expect(
			await prisma.providerNativeInventoryRun.findUniqueOrThrow({ where: { id: run.id } }),
		).toMatchObject({ state: "pending", claimToken: null, leaseUntil: null, failureCount: 0 });
	});

	it("publishes through the actual Jellyfin library adapter after two matching passes", async () => {
		const { prisma, authority } = await database();
		await admitNativeInventoryRun(prisma, authority, "library", new Date());
		const run = await prisma.providerNativeInventoryRun.findFirstOrThrow();
		const getNativeMediaFolders = vi
			.fn()
			.mockResolvedValue([{ id: "scope-a", name: "Synthetic", collectionType: "movies" }]);
		const providerPage = vi.fn().mockResolvedValue({
			status: "page",
			domain: "library",
			startIndex: 0,
			totalRecordCount: 1,
			items: [{ id: "movie-1", type: "Movie", name: "Synthetic", externalIds: { tmdb: [101] } }],
		});
		const adapter = createJellyfinNativeLibraryJobAdapter({
			getNativeMediaFolders,
			readNativeInventoryPage: providerPage,
		});
		const options = { deadlineAt: Date.now() + 10_000, maxPages: 1, pageSize: 1, retryDelayMs: 0 };
		expect((await runNativeInventoryJobSlice(prisma, run.id, adapter, options)).status).toBe(
			"pass-complete",
		);
		expect((await runNativeInventoryJobSlice(prisma, run.id, adapter, options)).status).toBe(
			"published",
		);
		expect(getNativeMediaFolders).toHaveBeenCalledTimes(4);
		expect(providerPage).toHaveBeenCalledTimes(2);
		expect(
			await readNativeInventoryPage(prisma, {
				userId: authority.userId,
				instanceId: authority.id,
				domain: "library",
			}),
		).toMatchObject({ status: "available", complete: true, rows: [{ nativeId: "movie-1" }] });
	});

	it("publishes native episode presence without inventing missing coordinates", async () => {
		const { prisma, authority } = await database();
		await admitNativeInventoryRun(prisma, authority, "episode", new Date());
		const run = await prisma.providerNativeInventoryRun.findFirstOrThrow();
		const getNativeMediaFolders = vi
			.fn()
			.mockResolvedValue([{ id: "scope-a", name: "Synthetic", collectionType: "tvshows" }]);
		const providerPage = vi.fn().mockResolvedValue({
			status: "page",
			domain: "episode",
			startIndex: 0,
			totalRecordCount: 1,
			items: [
				{
					id: "episode-1",
					type: "Episode",
					name: "Synthetic",
					seriesId: "series-1",
					episodeNumber: 2,
				},
			],
		});
		const adapter = createJellyfinNativeEpisodeJobAdapter({
			getNativeMediaFolders,
			readNativeInventoryPage: providerPage,
		});
		const options = { deadlineAt: Date.now() + 10_000, maxPages: 1, pageSize: 1, retryDelayMs: 0 };
		expect((await runNativeInventoryJobSlice(prisma, run.id, adapter, options)).status).toBe(
			"pass-complete",
		);
		expect((await runNativeInventoryJobSlice(prisma, run.id, adapter, options)).status).toBe(
			"published",
		);
		expect(providerPage).toHaveBeenCalledTimes(2);
		expect(
			await readNativeInventoryPage(prisma, {
				userId: authority.userId,
				instanceId: authority.id,
				domain: "episode",
			}),
		).toMatchObject({
			status: "available",
			complete: true,
			rows: [
				{ nativeId: "episode-1", parentNativeId: null, seasonNumber: null, episodeNumber: null },
			],
		});
		expect(
			await readNativeInventoryDisplayPage(prisma, {
				userId: authority.userId,
				instanceId: authority.id,
				domain: "episode",
			}),
		).toMatchObject({ status: "available", complete: true, rows: [{ nativeId: "episode-1" }] });
	});

	it("bounds the invocation before claiming provider work", async () => {
		const { prisma, authority } = await database();
		await admitNativeInventoryRun(prisma, authority, "library", new Date());
		const run = await prisma.providerNativeInventoryRun.findFirstOrThrow();
		const adapter = singlePageAdapter(["Movie", "Movie"]);
		expect(
			await runNativeInventoryJobSlice(prisma, run.id, adapter, {
				deadlineAt: Date.now() + 24 * 60 * 60_000,
				maxPages: 20,
				pageSize: 500,
				retryDelayMs: 0,
			}),
		).toEqual({ status: "retryable", pagesCommitted: 0 });
		expect(adapter.discoverScopes).not.toHaveBeenCalled();
		expect(
			await prisma.providerNativeInventoryRun.findUniqueOrThrow({ where: { id: run.id } }),
		).toMatchObject({ state: "pending", claimToken: null, failureCount: 0 });
	});

	it.each(["discovery", "page"] as const)(
		"releases a claim after an unexpected adapter %s exception",
		async (phase) => {
			const { prisma, authority } = await database();
			await admitNativeInventoryRun(prisma, authority, "library", new Date());
			const run = await prisma.providerNativeInventoryRun.findFirstOrThrow();
			const adapter = {
				domain: "library" as const,
				discoverScopes: vi.fn().mockImplementation(async () => {
					if (phase === "discovery") throw new Error("private synthetic provider detail");
					return {
						status: "ready",
						catalogIdentity: "catalog-a",
						scopes: [{ scopeKey: "library:scope-a" }],
					};
				}),
				readPage: vi.fn().mockImplementation(async () => {
					throw new Error("private synthetic provider detail");
				}),
			};
			const options = {
				deadlineAt: Date.now() + 10_000,
				maxPages: 1,
				pageSize: 1,
				retryDelayMs: 0,
			};
			await expect(runNativeInventoryJobSlice(prisma, run.id, adapter, options)).resolves.toEqual({
				status: "retryable",
				pagesCommitted: 0,
			});
			expect(
				await prisma.providerNativeInventoryRun.findUniqueOrThrow({ where: { id: run.id } }),
			).toMatchObject({
				state: "pending",
				claimToken: null,
				leaseUntil: null,
				lastFailureCategory: "provider-unavailable",
				failureCount: 1,
			});
		},
	);

	it("resumes a real Jellyfin adapter after provider page two times out", async () => {
		const { prisma, authority } = await database();
		await admitNativeInventoryRun(prisma, authority, "library", new Date());
		const run = await prisma.providerNativeInventoryRun.findFirstOrThrow();
		const getNativeMediaFolders = vi
			.fn()
			.mockResolvedValue([{ id: "scope-a", name: "Synthetic", collectionType: "movies" }]);
		const providerPage = vi
			.fn()
			.mockResolvedValueOnce({
				status: "page",
				domain: "library",
				startIndex: 0,
				totalRecordCount: 2,
				items: [{ id: "movie-1", type: "Movie", name: "Synthetic 1" }],
			})
			.mockResolvedValueOnce({ status: "unavailable", reason: "deadline-exceeded" })
			.mockResolvedValueOnce({
				status: "page",
				domain: "library",
				startIndex: 1,
				totalRecordCount: 2,
				items: [{ id: "movie-2", type: "Movie", name: "Synthetic 2" }],
			});
		const adapter = createJellyfinNativeLibraryJobAdapter({
			getNativeMediaFolders,
			readNativeInventoryPage: providerPage,
		});
		const options = { deadlineAt: Date.now() + 10_000, maxPages: 1, pageSize: 1, retryDelayMs: 0 };
		expect((await runNativeInventoryJobSlice(prisma, run.id, adapter, options)).status).toBe(
			"yielded",
		);
		expect((await runNativeInventoryJobSlice(prisma, run.id, adapter, options)).status).toBe(
			"retryable",
		);
		expect((await runNativeInventoryJobSlice(prisma, run.id, adapter, options)).status).toBe(
			"pass-complete",
		);
		expect(providerPage.mock.calls.map(([input]) => input.startIndex)).toEqual([0, 1, 1]);
		expect(await prisma.providerNativeInventorySnapshot.count()).toBe(0);
	});

	it("resumes page two after a timed-out page without re-reading committed page one", async () => {
		const { prisma, authority } = await database();
		const now = new Date();
		expect((await admitNativeInventoryRun(prisma, authority, "library", now)).status).toBe(
			"acquired",
		);
		const run = await prisma.providerNativeInventoryRun.findFirstOrThrow();
		const readPage = vi
			.fn()
			.mockImplementationOnce(async () => ({
				status: "page",
				domain: "library",
				scopeKey: "library:scope-a",
				startIndex: 0,
				totalRecordCount: 2,
				rawNativeIds: ["movie-1"],
				comparisonKeys: ["Movie"],
				rows: [
					{
						nativeId: "movie-1",
						mediaType: "movie",
						libraryIds: ["scope-a"],
						parentNativeId: null,
						seasonNumber: null,
						episodeNumber: null,
						title: "Synthetic 1",
					},
				],
			}))
			.mockResolvedValueOnce({ status: "unavailable", reason: "deadline-exceeded" })
			.mockImplementationOnce(async () => ({
				status: "page",
				domain: "library",
				scopeKey: "library:scope-a",
				startIndex: 1,
				totalRecordCount: 2,
				rawNativeIds: ["movie-2"],
				comparisonKeys: ["Movie"],
				rows: [
					{
						nativeId: "movie-2",
						mediaType: "movie",
						libraryIds: ["scope-a"],
						parentNativeId: null,
						seasonNumber: null,
						episodeNumber: null,
						title: "Synthetic 2",
					},
				],
			}));
		const adapter = {
			domain: "library" as const,
			discoverScopes: vi.fn().mockResolvedValue({
				status: "ready",
				catalogIdentity: "stable-catalog",
				scopes: [{ scopeKey: "library:scope-a", libraryId: "scope-a" }],
			}),
			readPage,
		};
		const phases: NativeInventorySlicePhase[] = [];
		const options = {
			deadlineAt: Date.now() + 10_000,
			maxPages: 1,
			pageSize: 1,
			retryDelayMs: 0,
			reportPhase: (phase: NativeInventorySlicePhase) => phases.push(phase),
		};
		expect(await runNativeInventoryJobSlice(prisma, run.id, adapter, options)).toEqual({
			status: "yielded",
			pagesCommitted: 1,
		});
		expect(phases).toContain("provider-page");
		expect(phases).toContain("page-commit");
		expect(phases.at(-1)).toBe("yield");
		expect(await prisma.providerNativeInventoryPageReceipt.count()).toBe(1);
		expect(
			await readNativeInventoryPage(prisma, {
				userId: authority.userId,
				instanceId: authority.id,
				domain: "library",
			}),
		).toEqual({ status: "unavailable", reason: "no-publication" });
		expect(await runNativeInventoryJobSlice(prisma, run.id, adapter, options)).toEqual({
			status: "retryable",
			pagesCommitted: 0,
		});
		expect(await runNativeInventoryJobSlice(prisma, run.id, adapter, options)).toEqual({
			status: "pass-complete",
			pagesCommitted: 1,
		});
		expect(readPage.mock.calls.map((call) => call[1])).toEqual([0, 1, 1]);
		expect(await prisma.providerNativeInventoryPageReceipt.count()).toBe(2);
		expect(await prisma.providerNativeInventorySnapshot.count()).toBe(0);
	});

	it.each([
		["duplicate native ID", "movie-1", 2, "retryable"],
		["changed declared total", "movie-2", 3, "incomplete"],
	] as const)(
		"keeps %s in page two unpublished",
		async (_scenario, secondId, secondTotal, status) => {
			const { prisma, authority } = await database();
			await admitNativeInventoryRun(prisma, authority, "library", new Date());
			const run = await prisma.providerNativeInventoryRun.findFirstOrThrow();
			const readPage = vi
				.fn()
				.mockResolvedValueOnce({
					status: "page",
					domain: "library",
					scopeKey: "library:scope-a",
					startIndex: 0,
					totalRecordCount: 2,
					rawNativeIds: ["movie-1"],
					comparisonKeys: ["Movie"],
					rows: [
						{
							nativeId: "movie-1",
							mediaType: "movie",
							libraryIds: ["scope-a"],
							parentNativeId: null,
							seasonNumber: null,
							episodeNumber: null,
							title: "Synthetic",
						},
					],
				})
				.mockResolvedValueOnce({
					status: "page",
					domain: "library",
					scopeKey: "library:scope-a",
					startIndex: 1,
					totalRecordCount: secondTotal,
					rawNativeIds: [secondId],
					comparisonKeys: ["Movie"],
					rows: [
						{
							nativeId: secondId,
							mediaType: "movie",
							libraryIds: ["scope-a"],
							parentNativeId: null,
							seasonNumber: null,
							episodeNumber: null,
							title: "Synthetic",
						},
					],
				});
			const adapter = {
				domain: "library" as const,
				discoverScopes: vi.fn().mockResolvedValue({
					status: "ready",
					catalogIdentity: "stable-catalog",
					scopes: [{ scopeKey: "library:scope-a" }],
				}),
				readPage,
			};
			const options = {
				deadlineAt: Date.now() + 10_000,
				maxPages: 1,
				pageSize: 1,
				retryDelayMs: 0,
			};
			expect((await runNativeInventoryJobSlice(prisma, run.id, adapter, options)).status).toBe(
				"yielded",
			);
			expect((await runNativeInventoryJobSlice(prisma, run.id, adapter, options)).status).toBe(
				status,
			);
			expect(await prisma.providerNativeInventoryPageReceipt.count()).toBe(1);
			expect(await prisma.providerNativeInventorySnapshot.count()).toBe(0);
		},
	);

	it("does not stitch a resumed page onto a changed scope catalog", async () => {
		const { prisma, authority } = await database();
		await admitNativeInventoryRun(prisma, authority, "library", new Date());
		const run = await prisma.providerNativeInventoryRun.findFirstOrThrow();
		const adapter = {
			domain: "library" as const,
			discoverScopes: vi
				.fn()
				.mockResolvedValueOnce({
					status: "ready",
					catalogIdentity: "catalog-a",
					scopes: [{ scopeKey: "library:scope-a" }],
				})
				.mockResolvedValue({
					status: "ready",
					catalogIdentity: "catalog-b",
					scopes: [{ scopeKey: "library:scope-a" }],
				}),
			readPage: vi.fn().mockResolvedValue({
				status: "page",
				domain: "library",
				scopeKey: "library:scope-a",
				startIndex: 0,
				totalRecordCount: 2,
				rawNativeIds: ["movie-1"],
				comparisonKeys: ["Movie"],
				rows: [
					{
						nativeId: "movie-1",
						mediaType: "movie",
						libraryIds: ["scope-a"],
						parentNativeId: null,
						seasonNumber: null,
						episodeNumber: null,
						title: "Synthetic",
					},
				],
			}),
		};
		const options = { deadlineAt: Date.now() + 10_000, maxPages: 1, pageSize: 1, retryDelayMs: 0 };
		expect((await runNativeInventoryJobSlice(prisma, run.id, adapter, options)).status).toBe(
			"yielded",
		);
		expect((await runNativeInventoryJobSlice(prisma, run.id, adapter, options)).status).toBe(
			"retryable",
		);
		expect(adapter.readPage).toHaveBeenCalledTimes(1);
		expect(await prisma.providerNativeInventoryPageReceipt.count()).toBe(1);
		expect(await prisma.providerNativeInventorySnapshot.count()).toBe(0);
	});

	it("publishes only after two independently complete matching passes", async () => {
		const { prisma, authority } = await database();
		await admitNativeInventoryRun(prisma, authority, "library", new Date());
		const run = await prisma.providerNativeInventoryRun.findFirstOrThrow();
		const adapter = singlePageAdapter(["Movie", "Movie"]);
		const options = { deadlineAt: Date.now() + 10_000, maxPages: 1, pageSize: 1, retryDelayMs: 0 };

		expect(await runNativeInventoryJobSlice(prisma, run.id, adapter, options)).toEqual({
			status: "pass-complete",
			pagesCommitted: 1,
		});
		expect(await prisma.providerNativeInventorySnapshot.count()).toBe(0);
		expect(await runNativeInventoryJobSlice(prisma, run.id, adapter, options)).toEqual({
			status: "published",
			pagesCommitted: 1,
		});
		expect(
			await readNativeInventoryPage(prisma, {
				userId: authority.userId,
				instanceId: authority.id,
				domain: "library",
			}),
		).toMatchObject({ status: "available", complete: true, rows: [{ nativeId: "movie-1" }] });
		await admitNativeInventoryRun(prisma, authority, "library", new Date());
		expect(
			await readNativeInventoryPage(prisma, {
				userId: authority.userId,
				instanceId: authority.id,
				domain: "library",
				includeAttempt: true,
			}),
		).toMatchObject({
			status: "available",
			freshness: "last-known",
			complete: false,
			rows: [{ nativeId: "movie-1" }],
			attempt: { state: "pending", pagesCompleted: 0, itemsStaged: 0 },
		});
	});
	it("keeps a two-pass Plex TMDb disagreement in the published missing-metadata filter", async () => {
		const { prisma, authority } = await database("PLEX");
		await admitNativeInventoryRun(prisma, authority, "paired", new Date());
		const run = await prisma.providerNativeInventoryRun.findFirstOrThrow();
		let libraryPass = 0;
		const adapter = createPlexNativeJobAdapter({
			getActivities: vi.fn().mockResolvedValue([]),
			getLibrarySettlementSections: vi.fn().mockResolvedValue([
				{
					key: "shows",
					uuid: "uuid-shows",
					title: "Synthetic",
					type: "show",
					refreshing: false,
					scannedAt: 10,
					updatedAt: 10,
				},
			]),
			readNativeInventoryPage: vi.fn().mockImplementation(async (input: { domain: string }) =>
				input.domain === "library"
					? {
							status: "page",
							domain: "library",
							startIndex: 0,
							totalRecordCount: 1,
							items: [
								{
									ratingKey: "show-1",
									type: "show",
									title: "Synthetic",
									externalIds: { tmdb: [++libraryPass === 1 ? 42 : 43] },
								},
							],
						}
					: {
							status: "page",
							domain: "episode",
							startIndex: 0,
							totalRecordCount: 1,
							items: [
								{
									ratingKey: "episode-1",
									type: "episode",
									title: "Synthetic",
									grandparentRatingKey: "show-1",
									seasonNumber: 1,
									episodeNumber: 1,
								},
							],
						},
			),
		});
		const options = { deadlineAt: Date.now() + 10_000, maxPages: 2, pageSize: 1, retryDelayMs: 0 };
		expect((await runNativeInventoryJobSlice(prisma, run.id, adapter, options)).status).toBe(
			"pass-complete",
		);
		expect((await runNativeInventoryJobSlice(prisma, run.id, adapter, options)).status).toBe(
			"published",
		);
		const filtered = await readProviderInventoryConnections(
			prisma,
			{
				userId: authority.userId,
				instanceId: authority.id,
				domain: "library",
				metadataFilter: "missing-tmdb",
			},
			{ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never,
		);
		expect(filtered).toMatchObject({
			status: "available",
			itemCount: 1,
			filteredItemCount: 1,
			rows: [{ nativeId: "show-1", externalIds: { tmdb: [42, 43] } }],
		});
	});
	it("refuses the head switch when live identity changes after complete passes", async () => {
		const { prisma, authority } = await database();
		await admitNativeInventoryRun(prisma, authority, "library", new Date());
		const run = await prisma.providerNativeInventoryRun.findFirstOrThrow();
		let observations = 0;
		const options = {
			deadlineAt: Date.now() + 10_000,
			maxPages: 1,
			pageSize: 1,
			retryDelayMs: 0,
			verifyIdentity: async () =>
				++observations === 3 ? ("superseded" as const) : ("verified" as const),
		};
		const adapter = singlePageAdapter(["Movie", "Movie"]);
		expect((await runNativeInventoryJobSlice(prisma, run.id, adapter, options)).status).toBe(
			"pass-complete",
		);
		expect((await runNativeInventoryJobSlice(prisma, run.id, adapter, options)).status).toBe(
			"superseded",
		);
		expect(observations).toBe(3);
		expect(await prisma.providerNativeInventorySnapshot.count()).toBe(0);
	});
	it("resets transient failure budget after each committed page", async () => {
		const { prisma, authority } = await database();
		await admitNativeInventoryRun(prisma, authority, "library", new Date());
		const run = await prisma.providerNativeInventoryRun.findFirstOrThrow();
		const failedOffsets = new Set<number>();
		const adapter = {
			domain: "library" as const,
			discoverScopes: vi.fn().mockResolvedValue({
				status: "ready",
				catalogIdentity: "stable-catalog",
				scopes: [{ scopeKey: "library:scope-a" }],
			}),
			readPage: vi.fn().mockImplementation(async (_scope: unknown, offset: number) => {
				if (offset > 0 && !failedOffsets.has(offset)) {
					failedOffsets.add(offset);
					return { status: "unavailable", reason: "provider-unavailable" };
				}
				return {
					status: "page",
					domain: "library",
					scopeKey: "library:scope-a",
					startIndex: offset,
					totalRecordCount: 4,
					rawNativeIds: [`movie-${offset}`],
					comparisonKeys: [`Movie:${offset}`],
					rows: [
						{
							nativeId: `movie-${offset}`,
							mediaType: "movie",
							libraryIds: ["scope-a"],
							parentNativeId: null,
							seasonNumber: null,
							episodeNumber: null,
							title: "Synthetic",
						},
					],
				};
			}),
		};
		const options = { deadlineAt: Date.now() + 30_000, maxPages: 1, pageSize: 1, retryDelayMs: 0 };
		for (let offset = 0; offset < 3; offset++) {
			expect((await runNativeInventoryJobSlice(prisma, run.id, adapter, options)).status).toBe(
				"yielded",
			);
			expect((await runNativeInventoryJobSlice(prisma, run.id, adapter, options)).status).toBe(
				"retryable",
			);
		}
		expect(
			await prisma.providerNativeInventoryRun.findUniqueOrThrow({ where: { id: run.id } }),
		).toMatchObject({ state: "pending", failureCount: 1 });
		expect(await prisma.providerNativeInventoryPageReceipt.count()).toBe(3);
		expect(await prisma.providerNativeInventorySnapshot.count()).toBe(0);
	});
	it("releases a claimed run after an unexpected post-claim storage exception", async () => {
		const { prisma, authority } = await database();
		await admitNativeInventoryRun(prisma, authority, "library", new Date());
		const run = await prisma.providerNativeInventoryRun.findFirstOrThrow();
		vi.spyOn(prisma.providerNativeInventoryPass, "findUnique").mockRejectedValueOnce(
			new Error("synthetic private storage detail"),
		);
		expect(
			(
				await runNativeInventoryJobSlice(prisma, run.id, singlePageAdapter(["Movie"]), {
					deadlineAt: Date.now() + 10_000,
					maxPages: 1,
					pageSize: 1,
					retryDelayMs: 0,
				})
			).status,
		).toBe("retryable");
		expect(
			await prisma.providerNativeInventoryRun.findUniqueOrThrow({ where: { id: run.id } }),
		).toMatchObject({
			state: "pending",
			claimToken: null,
			failureCount: 1,
			lastFailureCategory: "database-retryable",
		});
	});
	it("surfaces a generic error when even post-claim retry persistence is unavailable", async () => {
		const { prisma, authority } = await database();
		await admitNativeInventoryRun(prisma, authority, "library", new Date());
		const run = await prisma.providerNativeInventoryRun.findFirstOrThrow();
		vi.spyOn(prisma.providerNativeInventoryPass, "findUnique").mockImplementationOnce(() => {
			vi.spyOn(prisma.providerNativeInventoryRun, "findUnique").mockRejectedValueOnce(
				new Error("synthetic private retry storage detail"),
			);
			throw new Error("synthetic private pass storage detail");
		});
		await expect(
			runNativeInventoryJobSlice(prisma, run.id, singlePageAdapter(["Movie"]), {
				deadlineAt: Date.now() + 10_000,
				maxPages: 1,
				pageSize: 1,
				retryDelayMs: 0,
			}),
		).rejects.toThrow("Native inventory failure state could not be persisted");
	});

	it("keeps second-pass drift unpublished until a matching third pass completes", async () => {
		const { prisma, authority } = await database();
		await admitNativeInventoryRun(prisma, authority, "library", new Date());
		const run = await prisma.providerNativeInventoryRun.findFirstOrThrow();
		const adapter = singlePageAdapter(["Movie:first", "Movie:changed", "Movie:changed"]);
		const options = { deadlineAt: Date.now() + 10_000, maxPages: 1, pageSize: 1, retryDelayMs: 0 };

		expect((await runNativeInventoryJobSlice(prisma, run.id, adapter, options)).status).toBe(
			"pass-complete",
		);
		expect((await runNativeInventoryJobSlice(prisma, run.id, adapter, options)).status).toBe(
			"retryable",
		);
		expect(await prisma.providerNativeInventorySnapshot.count()).toBe(0);
		expect(
			(await prisma.providerNativeInventoryRun.findUniqueOrThrow({ where: { id: run.id } }))
				.passOrdinal,
		).toBe(3);
		expect((await runNativeInventoryJobSlice(prisma, run.id, adapter, options)).status).toBe(
			"published",
		);
		expect(
			await readNativeInventoryPage(prisma, {
				userId: authority.userId,
				instanceId: authority.id,
				domain: "library",
			}),
		).toMatchObject({ status: "available", complete: true, rows: [{ nativeId: "movie-1" }] });
	});

	it("shows completed Jellyfin episode observations after drift without granting exact absence", async () => {
		const { prisma, authority } = await database();
		await admitNativeInventoryRun(prisma, authority, "episode", new Date());
		const run = await prisma.providerNativeInventoryRun.findFirstOrThrow();
		let pass = 0;
		const adapter = {
			domain: "episode" as const,
			discoverScopes: vi.fn().mockResolvedValue({
				status: "ready",
				catalogIdentity: "stable-catalog",
				scopes: [{ scopeKey: "library:scope-a", libraryId: "scope-a" }],
			}),
			readPage: vi.fn().mockImplementation(async () => {
				pass++;
				const ids = pass === 1 ? ["episode-1", "episode-2"] : ["episode-1", "episode-3"];
				return {
					status: "page",
					domain: "episode",
					scopeKey: "library:scope-a",
					startIndex: 0,
					totalRecordCount: ids.length,
					rawNativeIds: ids,
					comparisonKeys: ids.map(() => "Episode"),
					rows: ids.map((nativeId) => ({
						nativeId,
						mediaType: "episode",
						libraryIds: ["scope-a"],
						parentNativeId: "series-1",
						seasonNumber: 1,
						episodeNumber: Number(nativeId.slice(-1)),
						title: "Synthetic",
					})),
				};
			}),
		};
		const options = { deadlineAt: Date.now() + 10_000, maxPages: 1, pageSize: 2, retryDelayMs: 0 };
		expect((await runNativeInventoryJobSlice(prisma, run.id, adapter, options)).status).toBe(
			"pass-complete",
		);
		expect((await runNativeInventoryJobSlice(prisma, run.id, adapter, options)).status).toBe(
			"retryable",
		);
		expect(
			await readNativeInventoryPage(prisma, {
				userId: authority.userId,
				instanceId: authority.id,
				domain: "episode",
			}),
		).toEqual({ status: "unavailable", reason: "no-publication" });

		const first = await readNativeInventoryDisplayPage(prisma, {
			userId: authority.userId,
			instanceId: authority.id,
			domain: "episode",
			limit: 1,
		});
		expect(first).toMatchObject({
			status: "available",
			evidence: "positive-only",
			complete: false,
			freshness: "last-known",
			itemCount: 2,
			rows: [{ nativeId: "episode-1" }],
			nextNativeId: "episode-1",
		});
		if (first.status !== "available") throw new Error("positive display was unavailable");
		const second = await readNativeInventoryDisplayPage(prisma, {
			userId: authority.userId,
			instanceId: authority.id,
			domain: "episode",
			limit: 1,
			afterNativeId: first.nextNativeId ?? undefined,
			expectedGenerationId: first.generationId,
		});
		expect(second).toMatchObject({
			status: "available",
			evidence: "positive-only",
			rows: [{ nativeId: "episode-3" }],
		});
		const projected = await readProviderInventoryConnections(
			prisma,
			{
				userId: authority.userId,
				instanceId: authority.id,
				domain: "episode",
				limit: 1,
			},
			{ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never,
		);
		expect(projected).toMatchObject({
			status: "available",
			evidence: "positive-only",
			complete: false,
			rows: [{ nativeId: "episode-1" }],
		});
		expect(
			await readNativeInventoryDisplayPage(prisma, {
				userId: authority.userId,
				instanceId: authority.id,
				domain: "episode",
				expectedGenerationId: "positive:stale-pass",
			}),
		).toEqual({ status: "unavailable", reason: "snapshot-changed" });
		expect(
			await readNativeInventoryDisplayPage(prisma, {
				userId: "other-owner",
				instanceId: authority.id,
				domain: "episode",
			}),
		).toEqual({ status: "unavailable", reason: "not-owned" });
		const latestPass = await prisma.providerNativeInventoryPass.findFirstOrThrow({
			where: { runId: run.id, ordinal: 2 },
		});
		await prisma.providerNativeInventoryStageItem.deleteMany({
			where: { passId: latestPass.id, domain: "episode", nativeId: "episode-3" },
		});
		expect(
			await readNativeInventoryDisplayPage(prisma, {
				userId: authority.userId,
				instanceId: authority.id,
				domain: "episode",
			}),
		).toEqual({ status: "unavailable", reason: "malformed-publication" });
		await prisma.serviceInstance.update({
			where: { id: authority.id },
			data: { identityStatus: "MISMATCH" },
		});
		expect(
			await readNativeInventoryDisplayPage(prisma, {
				userId: authority.userId,
				instanceId: authority.id,
				domain: "episode",
			}),
		).toEqual({ status: "unavailable", reason: "identity-changed" });
	});

	it("retains episode presence but nulls coordinates that disagree between accepted passes", async () => {
		const { prisma, authority } = await database();
		await admitNativeInventoryRun(prisma, authority, "episode", new Date());
		const run = await prisma.providerNativeInventoryRun.findFirstOrThrow();
		let pass = 0;
		const adapter = {
			domain: "episode" as const,
			discoverScopes: vi.fn().mockResolvedValue({
				status: "ready",
				catalogIdentity: "stable-catalog",
				scopes: [{ scopeKey: "library:scope-a", libraryId: "scope-a" }],
			}),
			readPage: vi.fn().mockImplementation(async () => ({
				status: "page",
				domain: "episode",
				scopeKey: "library:scope-a",
				startIndex: 0,
				totalRecordCount: 1,
				rawNativeIds: ["episode-1"],
				comparisonKeys: ["Episode"],
				rows: [
					{
						nativeId: "episode-1",
						mediaType: "episode",
						libraryIds: ["scope-a"],
						parentNativeId: "series-1",
						seasonNumber: 1,
						episodeNumber: ++pass,
						title: "Synthetic",
					},
				],
			})),
		};
		const options = { deadlineAt: Date.now() + 10_000, maxPages: 1, pageSize: 1, retryDelayMs: 0 };
		expect((await runNativeInventoryJobSlice(prisma, run.id, adapter, options)).status).toBe(
			"pass-complete",
		);
		expect((await runNativeInventoryJobSlice(prisma, run.id, adapter, options)).status).toBe(
			"published",
		);
		expect(
			await readNativeInventoryPage(prisma, {
				userId: authority.userId,
				instanceId: authority.id,
				domain: "episode",
			}),
		).toMatchObject({
			status: "available",
			complete: true,
			rows: [
				{ nativeId: "episode-1", parentNativeId: null, seasonNumber: null, episodeNumber: null },
			],
		});
	});
});
