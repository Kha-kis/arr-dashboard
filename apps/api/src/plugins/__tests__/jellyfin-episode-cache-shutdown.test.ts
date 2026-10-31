import { AsyncResource } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import Fastify, { type FastifyInstance } from "fastify";
import fp from "fastify-plugin";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerSchedulers } from "../../bootstrap/schedulers.js";
import { getRestoreRuntimeClientContext } from "../../lib/backup/restore-runtime-admission.js";
import {
	registerRestoreBootstrapPlugin,
	registerRestoreRuntimeActivation,
} from "../../lib/backup/restore-runtime-bootstrap.js";
import { createRuntimePrismaClient } from "../../lib/backup/restore-runtime-client.js";
import {
	withCleanupMaintenanceGuard,
	withCleanupOperationGuard,
} from "../../lib/library-cleanup/cleanup-maintenance-gate.js";
import { createNotificationOutboxNativeFixture } from "../../lib/notifications/__tests__/notification-outbox-native-fixture.js";
import type { ServiceInstance } from "../../lib/prisma.js";
import { JOB_ID } from "../../lib/scheduler-registry/job-definitions.js";
import {
	type EpisodeRefreshRetryResult,
	type EpisodeRefreshSchedulerBridge,
	ensureEpisodeRefreshScheduler,
} from "../../lib/services/episode-refresh-scheduler-bridge.js";
import scheduler from "../jellyfin-episode-cache-scheduler.js";
import registryPlugin from "../scheduler-registry.js";

// Actual native bootstrap, SQL, crypto, bridge, guards, singleflight and cleanup.
// Only the provider/page/finalization executor is synthetic; no delivery proof.
const boundary = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock("../../lib/jellyfin/jellyfin-episode-cache-refresher.js", () => ({
	refreshOwnedJellyfinEpisodeCache: boundary.refresh,
}));
const STARTUP_MS = 360_000,
	INTERVAL_MS = 6 * 60 * 60_000;
type Origin = "startup" | "interval" | "continuation" | "recovery" | "manual";
type Phase =
	| "round"
	| "owner"
	| "artifactRead"
	| "pointer"
	| "terminal"
	| "artifactDelete"
	| "preparation"
	| "page"
	| "retryState";
type Failure = "exception" | "identity" | "preRenewal" | "parent" | "replan" | "superseded" | "due";
type Native = Awaited<ReturnType<typeof createNotificationOutboxNativeFixture>>;
type AwaitOnly<T> = T extends (...args: infer Args) => unknown
	? (...args: Args) => PromiseLike<unknown>
	: never;
type Graph = {
	instanceId: string;
	userId: string;
	role: string;
	runId: string;
	unitId: string;
	watchIds: string[];
	generationIds: string[];
	stageId: string;
	exclusionId: string;
	receiptId: string;
	showReceiptId: string;
};
const apps: FastifyInstance[] = [],
	releases: Array<() => void> = [],
	tasks: Promise<unknown>[] = [];
const fixtures = new Map<
	Native,
	{
		instances: Array<{ id: string; userId: string }>;
		graphs: Graph[];
		owners: Array<{ userId: string; channelId: string }>;
	}
>();
const realTimeout = globalThis.setTimeout,
	realClearTimeout = globalThis.clearTimeout,
	realInterval = globalThis.setInterval,
	realClearInterval = globalThis.clearInterval;
type TimerRecord = {
	kind: "timeout" | "interval";
	delay: number;
	dueAt: number;
	callback: () => void;
	handle: ReturnType<typeof setTimeout>;
};
const installed: TimerRecord[] = [],
	activeTimers = new Map<ReturnType<typeof setTimeout>, TimerRecord>();
function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	releases.push(resolve);
	return { promise, resolve };
}
async function settle() {
	await new Promise<void>((done) => setImmediate(done));
}
async function waitForNative(observe: () => boolean) {
	const deadline = performance.now() + 4000;
	while (!observe()) {
		if (performance.now() >= deadline) return false;
		await settle();
	}
	return true;
}

async function cleanup(native: Native) {
	const owned = fixtures.get(native)!;
	await native.run(async () => {
		expect(
			(await native.prisma.serviceInstance.deleteMany({ where: { OR: owned.instances } })).count,
		).toBe(owned.instances.length);
		const ids = owned.instances.map((row) => row.id),
			runs = owned.graphs.map((row) => row.runId),
			units = owned.graphs.map((row) => row.unitId);
		expect(await native.prisma.serviceInstance.count({ where: { id: { in: ids } } })).toBe(0);
		expect(await native.prisma.providerObservationRun.count({ where: { id: { in: runs } } })).toBe(
			0,
		);
		expect(
			await native.prisma.providerObservationUnit.count({ where: { id: { in: units } } }),
		).toBe(0);
		expect(
			await native.prisma.jellyfinEpisodeObservationStage.count({ where: { runId: { in: runs } } }),
		).toBe(0);
		expect(
			await native.prisma.jellyfinEpisodeObservationExclusion.count({
				where: { runId: { in: runs } },
			}),
		).toBe(0);
		expect(
			await native.prisma.jellyfinEpisodeGenerationRow.count({
				where: { instanceId: { in: ids } },
			}),
		).toBe(0);
		expect(
			await native.prisma.jellyfinEpisodeGenerationShowReceipt.count({
				where: { instanceId: { in: ids } },
			}),
		).toBe(0);
		expect(
			await native.prisma.jellyfinEpisodePreparation.count({ where: { instanceId: { in: ids } } }),
		).toBe(0);
		expect(
			await native.prisma.jellyfinNativeWatchRow.count({ where: { instanceId: { in: ids } } }),
		).toBe(0);
		expect(
			await native.prisma.jellyfinNativeWatchScopeReceipt.count({
				where: { instanceId: { in: ids } },
			}),
		).toBe(0);
		expect(
			await native.prisma.jellyfinNativeWatchPublication.count({
				where: { instanceId: { in: ids } },
			}),
		).toBe(0);
		expect(
			await native.prisma.cacheRefreshStatus.count({ where: { instanceId: { in: ids } } }),
		).toBe(0);
	});
	await native.close();
	fixtures.delete(native);
}
async function boot(
	options: {
		service?: "JELLYFIN" | "EMBY";
		origin?: Origin;
		hold?: {
			phase: Phase;
			gate: Promise<void>;
			reject?: boolean;
			call?: number;
			ownerIndex?: number;
		};
		artifacts?: boolean;
		empty?: boolean;
		instances?: number;
		preCloseGate?: Promise<void>;
		failure?: Failure;
		batches?: boolean;
	} = {},
) {
	const native = await createNotificationOutboxNativeFixture();
	const owners = [
		{ userId: native.userId, channelId: native.channelId },
		await native.createOwner(),
	];
	const owned = {
		instances: [] as Array<{ id: string; userId: string }>,
		graphs: [] as Graph[],
		owners,
	};
	fixtures.set(native, owned);
	const allInstances: ServiceInstance[] = [];
	// Seed only the synthetic pre-launch graph atomically; tested runtime work stays real.
	await native.run(() =>
		native.prisma.$transaction(async (seed) => {
			for (const [index, owner] of owners.entries()) {
				const key = native.encryptor.encrypt("synthetic-provider-key");
				const instance = await seed.serviceInstance.create({
					data: {
						userId: owner.userId,
						service: options.service ?? (index ? "EMBY" : "JELLYFIN"),
						label: "Same synthetic label",
						baseUrl: "https://example.invalid/synthetic-provider",
						encryptedApiKey: key.value,
						encryptionIv: key.iv,
						enabled: !options.empty && (index === 0 || options.instances === 2),
						connectionGeneration: 7,
						identityGeneration: 3,
						expectedIdentity: `synthetic-identity-${index}`,
						identityStatus: "VERIFIED",
					},
				});
				owned.instances.push({ id: instance.id, userId: instance.userId });
				allInstances.push(instance);
				if (options.artifacts) {
					for (const role of ["retired", "active", "previous", "status", "running", "foreign"]) {
						const runId = randomUUID();
						const run = await seed.providerObservationRun.create({
							data: {
								id: runId,
								instanceId: instance.id,
								provider: role === "foreign" ? "foreign" : "jellyfin_episode",
								cacheType: role === "foreign" ? "foreign" : "jellyfin_episode",
								authorityKey: `synthetic-${runId}`,
								targetDigest: "synthetic-target",
								targetCount: 1,
								connectionGeneration: 7,
								identityGeneration: 3,
								state: role === "running" ? "running" : "complete",
								totalUnits: 1,
								totalWork: 1,
							},
						});
						const unit = await seed.providerObservationUnit.create({
							data: {
								runId: run.id,
								ordinal: 0,
								scopeKey: "synthetic-scope",
								scopeDigest: "synthetic-digest",
								phase: "observed",
								expectedTargets: 1,
								state: role === "running" ? "running" : "complete",
							},
						});
						const stage = await seed.jellyfinEpisodeObservationStage.create({
							data: {
								runId,
								unitId: unit.id,
								userKeyDigest: "synthetic-user",
								pass: "observed",
								jellyfinId: "synthetic-episode",
								seriesId: "synthetic-series",
								seasonNumber: 1,
								episodeNumber: 1,
								title: "Synthetic episode",
								played: true,
								userName: "Synthetic viewer",
							},
						});
						const exclusion = await seed.jellyfinEpisodeObservationExclusion.create({
							data: {
								runId,
								unitId: unit.id,
								userKeyDigest: "synthetic-user",
								pass: "observed",
								jellyfinId: "synthetic-excluded",
								reason: "synthetic-reason",
							},
						});
						const watchCount = options.batches && index === 0 && role === "retired" ? 5001 : 1;
						const watchIds = Array.from({ length: watchCount }, () => randomUUID());
						const watchData = watchIds.map((id, i) => ({
							id,
							instanceId: instance.id,
							runId,
							userKeyDigest: "synthetic-user",
							libraryId: "synthetic-library",
							jellyfinId: `synthetic-${i}`,
							seriesId: "synthetic-series",
							seasonNumber: 1,
							episodeNumber: i,
							played: true,
							observedAt: new Date(),
							connectionGeneration: 7,
							identityGeneration: 3,
						}));
						for (let offset = 0; offset < watchData.length; offset += 500) {
							await seed.jellyfinNativeWatchRow.createMany({
								data: watchData.slice(offset, offset + 500),
							});
						}
						const receipt = await seed.jellyfinNativeWatchScopeReceipt.create({
							data: {
								instanceId: instance.id,
								runId,
								userKeyDigest: "synthetic-user",
								libraryId: "synthetic-library",
								expectedRawCount: watchCount,
								observedRawCount: watchCount,
								exact: true,
								contentFingerprint: "synthetic-fingerprint",
								observedAt: new Date(),
								connectionGeneration: 7,
								identityGeneration: 3,
							},
						});
						await seed.jellyfinEpisodePreparation.create({
							data: {
								runId,
								instanceId: instance.id,
								generationId: runId,
								token: "synthetic-preparation",
								leaseExpiresAt: new Date(Date.now() + 60_000),
								state: "verified",
							},
						});
						const generationCount = options.batches && index === 0 && role === "retired" ? 501 : 1;
						const generationIds = Array.from({ length: generationCount }, () => randomUUID());
						await seed.jellyfinEpisodeGenerationRow.createMany({
							data: generationIds.map((id, i) => ({
								id,
								instanceId: instance.id,
								generationId: runId,
								showTmdbId: 1,
								seasonNumber: 1,
								episodeNumber: i,
								jellyfinId: `synthetic-${i}`,
								title: "Synthetic episode",
								watched: true,
								watchedByUsers: "[]",
								connectionGeneration: 7,
								identityGeneration: 3,
							})),
						});
						const showReceipt = await seed.jellyfinEpisodeGenerationShowReceipt.create({
							data: {
								instanceId: instance.id,
								generationId: runId,
								showTmdbId: 1,
								rowCount: generationCount,
								contentFingerprint: "synthetic-fingerprint",
							},
						});
						owned.graphs.push({
							instanceId: instance.id,
							userId: instance.userId,
							role,
							runId,
							unitId: unit.id,
							watchIds,
							generationIds,
							stageId: stage.id,
							exclusionId: exclusion.id,
							receiptId: receipt.id,
							showReceiptId: showReceipt.id,
						});
					}
					const graph = (role: string) =>
						owned.graphs.find((row) => row.instanceId === instance.id && row.role === role)!;
					await seed.jellyfinNativeWatchPublication.create({
						data: {
							instanceId: instance.id,
							activeRunId: graph("active").runId,
							activeCacheGenerationId: graph("active").runId,
							activeObservedAt: new Date(),
							activeExpectedScopeCount: 1,
							previousRunId: graph("previous").runId,
							previousObservedAt: new Date(),
							previousExpectedScopeCount: 1,
							connectionGeneration: 7,
							identityGeneration: 3,
						},
					});
					await seed.cacheRefreshStatus.create({
						data: {
							instanceId: instance.id,
							cacheType: "jellyfin_episode",
							lastRefreshedAt: new Date(),
							lastResult: "success",
							generationId: graph("status").runId,
							connectionGeneration: 7,
							identityGeneration: 3,
						},
					});
				}
				if (options.failure === "identity" || options.failure === "due") {
					const runId = randomUUID();
					const run = await seed.providerObservationRun.create({
						data: {
							id: runId,
							instanceId: instance.id,
							provider: "jellyfin_episode",
							cacheType: "jellyfin_episode",
							authorityKey: `synthetic-${runId}`,
							activeSlotKey: `synthetic-slot-${runId}`,
							targetDigest: "synthetic-target",
							targetCount: 1,
							connectionGeneration: 7,
							identityGeneration: 3,
							state: options.failure === "due" ? "failed" : "running",
							nextAttemptAt: options.failure === "due" ? new Date() : null,
							totalUnits: 0,
							totalWork: 0,
						},
					});
					owned.graphs.push({
						instanceId: instance.id,
						userId: instance.userId,
						role: "retry",
						runId: run.id,
						unitId: "",
						watchIds: [],
						generationIds: [],
						stageId: "",
						exclusionId: "",
						receiptId: "",
						showReceiptId: "",
					});
				}
			}
		}),
	);
	const instances = allInstances.filter((row) => row.enabled);
	await native.restart(false);
	const client = createRuntimePrismaClient(native.runtime),
		prisma = client.prisma;
	const counts: Record<Phase, number> = {
		round: 0,
		owner: 0,
		artifactRead: 0,
		pointer: 0,
		terminal: 0,
		artifactDelete: 0,
		preparation: 0,
		page: 0,
		retryState: 0,
	};
	const state = {
		pending: 0,
		teardown: false,
		afterTeardown: 0,
		pendingAtTeardown: -1,
		forbidden: 0,
		network: 0,
	};
	const pageInputs: Array<{ id: string; userId: string; resume: boolean; renewal: unknown }> = [];
	const deletions: Array<{ kind: string; count: number; instanceId: string }> = [];
	const generationPages: Array<{ instanceId: string; generationId: string; count: number }> = [];
	let held = false,
		heldInstanceId: string | undefined,
		active = 0,
		holdArmed = options.origin !== "interval";
	const holdBase: Partial<Record<Phase, number>> = {};
	let scopedHoldOccurrences = 0;
	async function phase<T>(
		name: Phase,
		operation: () => PromiseLike<T> | T,
		instanceId?: string,
	): Promise<T> {
		counts[name]++;
		if (state.teardown) state.afterTeardown++;
		state.pending++;
		try {
			const target =
				options.origin === "interval" ? (holdBase[name] ?? 0) + 1 : (options.hold?.call ?? 1);
			const scoped = options.hold?.ownerIndex !== undefined;
			const scopeMatches = !scoped || instanceId === owned.instances[options.hold!.ownerIndex!]!.id;
			if (scoped && scopeMatches && options.hold?.phase === name) scopedHoldOccurrences++;
			if (
				holdArmed &&
				options.hold?.phase === name &&
				scopeMatches &&
				(scoped ? scopedHoldOccurrences : counts[name]) === target
			) {
				held = true;
				heldInstanceId = instanceId;
				await options.hold.gate;
				if (options.hold.reject) throw new Error("Synthetic boundary unavailable");
			}
			return await operation();
		} finally {
			if (state.teardown) state.afterTeardown++;
			state.pending--;
		}
	}
	const round = prisma.serviceInstance.findMany.bind(prisma.serviceInstance);
	const roundReads: { findMany: AwaitOnly<typeof prisma.serviceInstance.findMany> } =
		prisma.serviceInstance;
	vi.spyOn(roundReads, "findMany").mockImplementation(async (args) => {
		expect(args).toEqual({ where: { service: { in: ["JELLYFIN", "EMBY"] }, enabled: true } });
		return phase("round", () => round(args));
	});
	const owner = prisma.serviceInstance.findFirst.bind(prisma.serviceInstance);
	const ownerReads: { findFirst: AwaitOnly<typeof prisma.serviceInstance.findFirst> } =
		prisma.serviceInstance;
	vi.spyOn(ownerReads, "findFirst").mockImplementation(async (args) => {
		expect(args).toEqual({
			where: {
				id: expect.any(String),
				userId: expect.any(String),
				service: { in: ["JELLYFIN", "EMBY"] },
				enabled: true,
			},
		});
		return phase("owner", () => owner(args));
	});
	const query = prisma.$queryRaw.bind(prisma),
		execute = prisma.$executeRaw.bind(prisma);
	const raw = prisma as unknown as {
		$queryRaw: (...args: unknown[]) => PromiseLike<unknown>;
		$executeRaw: (...args: unknown[]) => PromiseLike<unknown>;
	};
	vi.spyOn(raw, "$queryRaw").mockImplementation((...args) => {
		expect(args).toHaveLength(2);
		expect(Array.isArray(args[0])).toBe(true);
		const sql = (args[0] as TemplateStringsArray).join("?");
		expect(sql).toContain("SELECT DISTINCT");
		expect(sql).toContain("'complete', 'invalidated'");
		expect(args.slice(1).some((value) => owned.instances.some((row) => row.id === value))).toBe(
			true,
		);
		return phase("artifactRead", () => Reflect.apply(query, prisma, args), String(args[1]));
	});
	vi.spyOn(raw, "$executeRaw").mockImplementation((...args) => {
		const sql = (args[0] as TemplateStringsArray).join("?");
		expect(sql).toContain("DELETE FROM");
		expect(sql).toContain("LIMIT");
		expect(args.at(-1)).toBe(5000);
		expect(args.slice(1).some((value) => owned.instances.some((row) => row.id === value))).toBe(
			true,
		);
		return phase("artifactDelete", async () => {
			const count = (await Reflect.apply(execute, prisma, args)) as number;
			expect(count).toBeGreaterThanOrEqual(0);
			expect(count).toBeLessThanOrEqual(5000);
			deletions.push({
				instanceId: String(
					args.slice(1).find((value) => owned.instances.some((row) => row.id === value)),
				),
				kind: sql.includes("observation_stage")
					? "staging"
					: sql.includes("observation_exclusions")
						? "exclusions"
						: sql.includes("scope_receipts")
							? "receipts"
							: "retired-rows",
				count,
			});
			return count;
		});
	});
	const pointer = prisma.jellyfinNativeWatchPublication.findUnique.bind(
		prisma.jellyfinNativeWatchPublication,
	);
	const pointerReads: {
		findUnique: AwaitOnly<typeof prisma.jellyfinNativeWatchPublication.findUnique>;
	} = prisma.jellyfinNativeWatchPublication;
	vi.spyOn(pointerReads, "findUnique").mockImplementation(async (args) => {
		expect(args).toEqual({
			where: { instanceId: expect.any(String) },
			select: { activeRunId: true },
		});
		return phase("pointer", () => pointer(args));
	});
	const preparation = prisma.jellyfinEpisodePreparation.findMany.bind(
		prisma.jellyfinEpisodePreparation,
	);
	const preparationOwners = new Set<string>();
	const prepReads: { findMany: AwaitOnly<typeof prisma.jellyfinEpisodePreparation.findMany> } =
		prisma.jellyfinEpisodePreparation;
	vi.spyOn(prepReads, "findMany").mockImplementation((args) => {
		expect(args?.select).toEqual({ runId: true, generationId: true });
		expect(args?.orderBy).toEqual({ runId: "asc" });
		expect(args?.take).toBe(500);
		return phase("preparation", async () => {
			const rows = await preparation(args);
			preparationOwners.add(String(args?.where?.instanceId));
			return rows;
		});
	});
	const generation = prisma.jellyfinEpisodeGenerationRow.findMany.bind(
		prisma.jellyfinEpisodeGenerationRow,
	);
	const generationReads: {
		findMany: AwaitOnly<typeof prisma.jellyfinEpisodeGenerationRow.findMany>;
	} = prisma.jellyfinEpisodeGenerationRow;
	vi.spyOn(generationReads, "findMany").mockImplementation(async (args) => {
		expect(args).toEqual({
			where: { instanceId: expect.any(String), generationId: expect.any(String) },
			select: { id: true },
			orderBy: { id: "asc" },
			take: 500,
		});
		const rows = await generation(args);
		generationPages.push({
			instanceId: String(args?.where?.instanceId),
			generationId: String(args?.where?.generationId),
			count: rows.length,
		});
		return rows;
	});
	const run = prisma.providerObservationRun.findFirst.bind(prisma.providerObservationRun);
	const runReads: { findFirst: AwaitOnly<typeof prisma.providerObservationRun.findFirst> } =
		prisma.providerObservationRun;
	vi.spyOn(runReads, "findFirst").mockImplementation((args) => {
		expect(args?.where?.instanceId).toEqual(expect.any(String));
		expect(args?.where?.provider).toBe("jellyfin_episode");
		expect(args?.where?.cacheType).toBe("jellyfin_episode");
		if (args?.where?.id) {
			expect(args.select).toEqual({ id: true });
			expect(args.where.state).toEqual({ in: ["complete", "invalidated"] });
			return phase("terminal", () => run(args));
		}
		expect(args?.where?.activeSlotKey).toEqual({ not: null });
		expect(args?.where?.state).toEqual({ in: ["running", "failed"] });
		expect(args?.select).toEqual({ state: true, nextAttemptAt: true });
		return phase("retryState", () => run(args));
	});
	const transaction = prisma.$transaction.bind(prisma);
	const transactions = prisma as unknown as {
		$transaction: (...args: unknown[]) => Promise<unknown>;
	};
	const transactionOptions: unknown[] = [];
	vi.spyOn(transactions, "$transaction").mockImplementation((...args) => {
		transactionOptions.push(args[1]);
		return Reflect.apply(transaction, prisma, args);
	});
	const app = Fastify({ logger: false });
	apps.push(app);
	const databaseUrl = getRestoreRuntimeClientContext(native.runtime).databaseUrl;
	app.decorate("restoreRuntime", native.runtime);
	app.decorate("config", { DATABASE_URL: databaseUrl } as never);
	app.decorate("arrClientFactory", {
		create() {
			state.forbidden++;
			throw new Error("Fixture forbids provider clients");
		},
	} as never);
	vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
		state.network++;
		throw new Error("Fixture forbids network");
	});
	boundary.refresh.mockImplementation(
		async (context: {
			signal: AbortSignal;
			prisma: unknown;
			databaseUrl?: string;
			encryptor: unknown;
			instance: ServiceInstance;
			log: unknown;
			resumeFailed: boolean;
			automaticRenewal?: unknown;
		}) => {
			expect(context).toEqual({
				signal: expect.any(AbortSignal),
				prisma,
				databaseUrl,
				encryptor: native.encryptor,
				instance: expect.anything(),
				log: app.log,
				resumeFailed: expect.any(Boolean),
				...(context.automaticRenewal !== undefined
					? { automaticRenewal: "provider-unavailable-cooldown" }
					: {}),
			});
			expect(allInstances).toContainEqual(context.instance);
			expect(context.instance.enabled).toBe(true);
			expect(
				native.encryptor.decrypt({
					value: context.instance.encryptedApiKey,
					iv: context.instance.encryptionIv,
				}),
			).toBe("synthetic-provider-key");
			pageInputs.push({
				id: context.instance.id,
				userId: context.instance.userId,
				resume: context.resumeFailed,
				renewal: context.automaticRenewal,
			});
			return phase("page", () => {
				if (options.failure === "exception") throw new Error("Synthetic provider failure");
				const firstPartial = options.origin === "continuation" && counts.page === 1,
					firstDeadline = options.origin === "recovery" && counts.page === 1;
				return {
					complete:
						!firstPartial &&
						!firstDeadline &&
						!options.failure &&
						options.hold?.phase !== "retryState",
					upserted: 1,
					progressed: false,
					errors:
						!firstPartial &&
						(options.hold?.phase === "retryState" ||
							["identity", "preRenewal", "replan", "due"].includes(options.failure ?? ""))
							? 1
							: 0,
					errorMessages: [],
					...(firstDeadline ? { renewalDeadline: new Date(Date.now() + 90_000) } : {}),
					...(options.failure === "parent" ? { parentRefreshPending: true } : {}),
					...(options.failure === "preRenewal" ? { retryablePreRenewalFailure: true } : {}),
					...(options.failure === "replan" ? { replanRequired: true } : {}),
					...(options.failure === "superseded" ? { superseded: true } : {}),
				};
			});
		},
	);
	const preClosed = deferred();
	await app.register(
		fp(
			async (server) => {
				server.decorate("prisma", prisma);
				server.decorate("encryptor", native.encryptor);
				server.addHook("onClose", async () => {
					state.pendingAtTeardown = state.pending;
					expect(state.pending).toBe(0);
					expect(active).toBe(0);
					expect(state.forbidden).toBe(0);
					expect(state.network).toBe(0);
					await native.run(async () => {
						expect(
							await native.prisma.notificationOutboxEvent.count({
								where: { userId: { in: owners.map((row) => row.userId) } },
							}),
						).toBe(0);
						expect(
							await native.prisma.notificationOutboxDelivery.count({
								where: { userId: { in: owners.map((row) => row.userId) } },
							}),
						).toBe(0);
						expect(
							await native.prisma.notificationLog.count({
								where: { channelId: { in: owners.map((row) => row.channelId) } },
							}),
						).toBe(0);
					});
					await client.close();
					state.teardown = true;
				});
			},
			{ name: "prisma" },
		),
	);
	await app.register(fp(async () => {}, { name: "security" }));
	registerRestoreBootstrapPlugin(app, registryPlugin);
	await app.after();
	const track = app.schedulerRegistry.track.bind(app.schedulerRegistry);
	vi.spyOn(app.schedulerRegistry, "track").mockImplementation((...args) => {
		active++;
		const task = track(...args).finally(() => {
			active--;
		});
		tasks.push(task.catch(() => undefined));
		return task;
	});
	const bridge = ensureEpisodeRefreshScheduler(app).episodeRefreshScheduler;
	let retained!: Parameters<EpisodeRefreshSchedulerBridge["register"]>[1];
	const registerHandler = bridge.register.bind(bridge);
	vi.spyOn(bridge, "register").mockImplementation((provider, handler) => {
		retained = handler;
		return registerHandler(provider, handler);
	});
	const register = app.register.bind(app),
		displayName = Symbol.for("fastify.display-name");
	let selectedRegistrations = 0;
	const registration = vi.spyOn(app, "register").mockImplementation(((
		plugin: unknown,
		...args: unknown[]
	) => {
		if (
			typeof plugin === "function" &&
			Reflect.get(plugin, displayName) === Reflect.get(scheduler, displayName)
		) {
			expect(plugin).not.toBe(scheduler);
			expect(Reflect.get(plugin, Symbol.for("plugin-meta"))).toBe(
				Reflect.get(scheduler, Symbol.for("plugin-meta")),
			);
			selectedRegistrations++;
			return Reflect.apply(register, app, [plugin, ...args]);
		}
		return app;
	}) as typeof app.register);
	try {
		registerSchedulers(app);
		expect(selectedRegistrations).toBe(1);
	} finally {
		registration.mockRestore();
	}
	await app.after();
	registerRestoreRuntimeActivation(app);
	app.addHook("preClose", async () => {
		preClosed.resolve();
		if (options.preCloseGate) await options.preCloseGate;
	});
	await app.ready();
	const request = { userId: owners[0]!.userId, instanceId: owned.instances[0]!.id };
	const retry = (provider: "jellyfin_episode", value = request) => {
		const task = app.restoreRuntime.runOperation(() => bridge.retry(provider, value));
		tasks.push(task);
		void task.then((result) => {
			if (result.status === "accepted" && result.backgroundTask) tasks.push(result.backgroundTask);
		});
		return task;
	};
	const idle = async () => {
		await native.runtime.drain();
		expect(await waitForNative(() => active === 0 && state.pending === 0)).toBe(true);
		await settle();
	};
	const advance = async (ms: number) => {
		const target = Date.now() + ms;
		do {
			const due = Math.min(...[...activeTimers.values()].map((timer) => timer.dueAt));
			await vi.advanceTimersByTimeAsync(Math.max(0, Math.min(target, due) - Date.now()));
			let drained = false;
			const joining = native.runtime.drain().then(() => {
				drained = true;
			});
			tasks.push(joining);
			expect(await waitForNative(() => drained || (held && state.pending > 0))).toBe(true);
			if (!(held && state.pending > 0)) await idle();
		} while (Date.now() < target);
		expect(Date.now()).toBe(target);
	};
	const callback = (kind: "startup" | "interval" | "continuation" | "recovery") => {
		const record =
			kind === "startup"
				? installed.find((row) => row.kind === "timeout" && row.delay === STARTUP_MS)
				: kind === "interval"
					? installed.find((row) => row.kind === "interval")
					: [...installed]
							.reverse()
							.find(
								(row) =>
									row.kind === "timeout" &&
									(kind === "recovery"
										? row.delay === 90_000
										: [0, 1000, 30_000, 120_000, 600_000].includes(row.delay)),
							);
		if (!record) throw new Error("Episode callback missing");
		// Retained/overlap/maintenance control only; natural cadence uses advance.
		return () => {
			if (record.kind === "timeout") clearTimeout(record.handle);
			record.callback();
		};
	};
	const start = async (origin: Origin) => {
		if (origin === "manual") {
			manual = retry("jellyfin_episode", request);
			return;
		}
		if (origin !== "startup") {
			await advance(STARTUP_MS);
			if (origin === "interval") {
				Object.assign(holdBase, counts);
				holdArmed = true;
			}
		}
		const delay =
			origin === "startup"
				? STARTUP_MS
				: origin === "interval"
					? INTERVAL_MS
					: origin === "recovery"
						? 90_000
						: 30_000;
		await advance(delay - 1);
		await advance(1);
	};
	let manual: Promise<EpisodeRefreshRetryResult> | undefined;
	const closePending = async () => {
		let settled = false;
		const promise = app.close().then(() => {
			settled = true;
		});
		await preClosed.promise;
		await settle();
		return { promise, settled: () => settled };
	};
	const assertArtifacts = async (cleanedIds: string[]) =>
		native.run(async () => {
			for (const graph of owned.graphs.filter((row) => row.role !== "retry")) {
				const cleaned = cleanedIds.includes(graph.instanceId),
					terminal = ["retired", "active", "previous", "status"].includes(graph.role);
				expect(
					await native.prisma.jellyfinEpisodeObservationStage.count({
						where: { id: graph.stageId },
					}),
				).toBe(cleaned && terminal ? 0 : 1);
				expect(
					await native.prisma.jellyfinEpisodeObservationExclusion.count({
						where: { id: graph.exclusionId },
					}),
				).toBe(cleaned && terminal ? 0 : 1);
				const watchRemoved = cleaned && ["retired", "status"].includes(graph.role);
				for (let offset = 0; offset < graph.watchIds.length; offset += 500) {
					const ids = graph.watchIds.slice(offset, offset + 500);
					expect(
						await native.prisma.jellyfinNativeWatchRow.count({ where: { id: { in: ids } } }),
					).toBe(watchRemoved ? 0 : ids.length);
				}
				expect(
					await native.prisma.jellyfinNativeWatchScopeReceipt.count({
						where: { id: graph.receiptId },
					}),
				).toBe(watchRemoved ? 0 : 1);
				const generationRemoved = cleaned && graph.role === "retired";
				expect(
					await native.prisma.jellyfinEpisodeGenerationRow.count({
						where: { id: { in: graph.generationIds } },
					}),
				).toBe(generationRemoved ? 0 : graph.generationIds.length);
				expect(
					await native.prisma.jellyfinEpisodeGenerationShowReceipt.count({
						where: { id: graph.showReceiptId },
					}),
				).toBe(generationRemoved ? 0 : 1);
				expect(
					await native.prisma.jellyfinEpisodePreparation.count({ where: { runId: graph.runId } }),
				).toBe(generationRemoved ? 0 : 1);
				expect(
					await native.prisma.providerObservationRun.count({ where: { id: graph.runId } }),
				).toBe(1);
				expect(
					await native.prisma.providerObservationUnit.count({ where: { id: graph.unitId } }),
				).toBe(1);
			}
		});
	const timerObservation = (kind: "timeout" | "interval") => ({
		get mock() {
			return {
				calls: installed
					.filter((row) => row.kind === kind)
					.map((row) => [row.callback, row.delay] as const),
			};
		},
	});
	return {
		app,
		native,
		owners,
		bridge,
		retry,
		request,
		prisma,
		counts,
		state,
		pageInputs,
		deletions,
		instances,
		allInstances,
		graphs: owned.graphs,
		generationPages,
		transactionOptions,
		preparationOwners,
		assertArtifacts,
		callback,
		advance,
		idle,
		waitUntilHeld: () => waitForNative(() => held),
		heldObservation: () => ({
			ownerIndex: owned.instances.findIndex((row) => row.id === heldInstanceId),
			phase: options.hold?.phase,
			pending: state.pending,
			startedPageOwners: pageInputs.map((row) =>
				owners.findIndex((owner) => owner.userId === row.userId),
			),
		}),
		retained: (value = request) => retained(value),
		manual: () => manual,
		start,
		closePending,
		timeouts: timerObservation("timeout"),
		intervals: timerObservation("interval"),
	};
}
beforeEach(() => {
	installed.length = 0;
	activeTimers.clear();
	vi.useFakeTimers({
		toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"],
	});
	vi.setSystemTime(new Date("2026-10-02T00:00:00.000Z"));
	const virtualTimeout = globalThis.setTimeout,
		virtualClear = globalThis.clearTimeout;
	const virtualInterval = globalThis.setInterval,
		virtualClearInterval = globalThis.clearInterval;
	// Route by the actual installing callsite, not coincident delay values:
	// PostgreSQL safety timers and unrelated outbox deadlines stay real.
	const schedulerCallsite = () =>
		new Error().stack
			?.split("\n")
			.find((line) => line.includes("/src/") && !line.includes("/__tests__/"))
			?.includes("/plugins/jellyfin-episode-cache-scheduler.ts") === true;
	vi.stubGlobal("setTimeout", ((callback: () => void, delay?: number, ...args: unknown[]) => {
		if (!schedulerCallsite())
			return Reflect.apply(realTimeout, globalThis, [callback, delay, ...args]);
		// Real Node timers retain the installing async context. Preserve that
		// existing context only; this does not mint native runtime authority.
		const invoke = AsyncResource.bind(() => Reflect.apply(callback, globalThis, args));
		let handle: ReturnType<typeof setTimeout>;
		const forward = () => {
			activeTimers.delete(handle);
			invoke();
		};
		handle = Reflect.apply(virtualTimeout, globalThis, [forward, delay]);
		const record: TimerRecord = {
			kind: "timeout",
			delay: delay ?? 0,
			dueAt: Date.now() + Math.max(0, delay ?? 0),
			callback: invoke,
			handle,
		};
		installed.push(record);
		activeTimers.set(handle, record);
		return handle;
	}) as typeof setTimeout);
	vi.stubGlobal("clearTimeout", ((handle: Parameters<typeof clearTimeout>[0]) => {
		if (installed.some((row) => row.handle === handle && row.kind === "timeout")) {
			activeTimers.delete(handle as ReturnType<typeof setTimeout>);
			return virtualClear(handle);
		}
		return realClearTimeout(handle);
	}) as typeof clearTimeout);
	vi.stubGlobal("setInterval", ((callback: () => void, delay?: number, ...args: unknown[]) => {
		if (!schedulerCallsite())
			return Reflect.apply(realInterval, globalThis, [callback, delay, ...args]);
		const invoke = AsyncResource.bind(() => Reflect.apply(callback, globalThis, args));
		let record: TimerRecord;
		const forward = () => {
			record.dueAt += record.delay;
			invoke();
		};
		const handle = Reflect.apply(virtualInterval, globalThis, [forward, delay]);
		record = {
			kind: "interval",
			delay: delay ?? 0,
			dueAt: Date.now() + Math.max(0, delay ?? 0),
			callback: invoke,
			handle,
		};
		installed.push(record);
		activeTimers.set(handle, record);
		return handle;
	}) as typeof setInterval);
	vi.stubGlobal("clearInterval", ((handle: Parameters<typeof clearInterval>[0]) => {
		if (installed.some((row) => row.handle === handle && row.kind === "interval")) {
			activeTimers.delete(handle as ReturnType<typeof setTimeout>);
			return virtualClearInterval(handle);
		}
		return realClearInterval(handle);
	}) as typeof clearInterval);
	boundary.refresh.mockReset();
});
afterEach(async () => {
	for (const release of releases.splice(0)) release();
	await Promise.all(tasks.splice(0));
	for (const app of apps.splice(0)) await app.close();
	vi.restoreAllMocks();
	for (const native of [...fixtures.keys()]) await cleanup(native);
	vi.unstubAllGlobals();
	vi.useRealTimers();
});
describe("Jellyfin and Emby episode scheduler accepted lifetimes", () => {
	for (const origin of ["continuation", "recovery", "manual"] as const) {
		it(`reports accepted detached ${origin} as running until its page settles`, async () => {
			const gate = deferred();
			const f = await boot({
				origin,
				hold: { phase: "page", call: origin === "manual" ? 1 : 2, gate: gate.promise },
			});
			if (origin !== "manual") {
				await f.start("startup");
				await f.idle();
				expect(f.app.schedulerRegistry.getStatus(JOB_ID.jellyfinEpisodeCache)).toMatchObject({
					state: "idle",
					totalRuns: 1,
				});
				await f.advance(origin === "recovery" ? 90_000 : 30_000);
			} else await f.start("manual");
			expect(await f.waitUntilHeld()).toBe(true);
			expect(f.app.schedulerRegistry.getStatus(JOB_ID.jellyfinEpisodeCache)).toMatchObject({
				state: "running",
				totalRuns: origin === "manual" ? 0 : 1,
			});
			const closing = await f.closePending();
			expect(closing.settled()).toBe(false);
			expect(f.app.schedulerRegistry.getStatus(JOB_ID.jellyfinEpisodeCache)?.state).toBe("running");
			gate.resolve();
			await closing.promise;
			await f.manual();
			expect(f.app.schedulerRegistry.getStatus(JOB_ID.jellyfinEpisodeCache)).toMatchObject({
				state: "idle",
				totalRuns: origin === "manual" ? 1 : 2,
				totalFailures: 0,
			});
		});
	}
	it("observes overlapping manual instances once and coalesces the held instance", async () => {
		const gate = deferred();
		const f = await boot({ instances: 2, hold: { phase: "page", gate: gate.promise } });
		const held = await f.retry("jellyfin_episode");
		if (held.status !== "accepted") throw new Error("Synthetic page not admitted");
		expect(await f.waitUntilHeld()).toBe(true);
		await expect(f.retry("jellyfin_episode")).resolves.toEqual({ status: "accepted" });
		const sibling = await f.retry("jellyfin_episode", {
			userId: f.owners[1]!.userId,
			instanceId: f.instances[1]!.id,
		});
		if (sibling.status !== "accepted") throw new Error("Synthetic sibling not admitted");
		await sibling.backgroundTask;
		expect(f.counts.page).toBe(2);
		expect(f.app.schedulerRegistry.getStatus(JOB_ID.jellyfinEpisodeCache)).toMatchObject({
			state: "running",
			totalRuns: 1,
		});
		gate.resolve();
		await held.backgroundTask;
		await f.idle();
		expect(f.app.schedulerRegistry.getStatus(JOB_ID.jellyfinEpisodeCache)).toMatchObject({
			state: "idle",
			totalRuns: 2,
		});
	});
	it("uses natural startup and six-hour cadence with distinct native cleanup batch bounds", async () => {
		const f = await boot({ instances: 2, artifacts: true, batches: true });
		expect(f.counts.round).toBe(0);
		await f.advance(STARTUP_MS - 1);
		expect(f.counts.round).toBe(0);
		expect(f.counts.page).toBe(0);
		await f.advance(1);
		expect(f.counts.round).toBe(1);
		expect(f.counts.page).toBe(2);
		expect(f.app.schedulerRegistry.getStatus(JOB_ID.jellyfinEpisodeCache)).toMatchObject({
			state: "idle",
			totalRuns: 1,
		});
		expect(new Set(f.pageInputs.map((row) => row.userId))).toEqual(
			new Set(f.owners.map((row) => row.userId)),
		);
		const primary = f.request.instanceId;
		const retired = f.graphs.find((row) => row.instanceId === primary && row.role === "retired")!;
		expect(retired.watchIds).toHaveLength(5001);
		expect(retired.generationIds).toHaveLength(501);
		expect(
			f.deletions
				.filter((row) => row.instanceId === primary && row.kind === "retired-rows" && row.count > 0)
				.map((row) => row.count),
		).toEqual([5000, 2]);
		expect(
			f.generationPages
				.filter((row) => row.instanceId === primary && row.generationId === retired.runId)
				.map((row) => row.count),
		).toEqual([500, 1, 0]);
		await f.assertArtifacts(f.instances.map((row) => row.id));
		// The real startup callback installs the six-hour interval.
		await f.advance(INTERVAL_MS - 1);
		expect(f.counts.round).toBe(1);
		expect(f.counts.page).toBe(2);
		await f.advance(1);
		expect(f.counts.round).toBe(2);
		expect(f.counts.page).toBe(4);
		expect(f.app.schedulerRegistry.getStatus(JOB_ID.jellyfinEpisodeCache)?.totalRuns).toBe(2);
		await f.app.close();
		expect(f.state.pendingAtTeardown).toBe(0);
		expect(f.state.afterTeardown).toBe(0);
	}, 15_000);
	for (const service of ["JELLYFIN", "EMBY"] as const)
		for (const origin of ["startup", "interval", "continuation", "recovery", "manual"] as const) {
			const phases: Phase[] =
				origin === "manual"
					? ["owner", "page", "retryState"]
					: origin === "continuation" || origin === "recovery"
						? ["page", "retryState"]
						: [
								"round",
								"artifactRead",
								"pointer",
								"terminal",
								"artifactDelete",
								"preparation",
								"page",
								"retryState",
							];
			for (const phase of phases)
				for (const reject of [false, true]) {
					it(`drains ${service} ${origin} ${phase} ${reject ? "failure" : "completion"} before teardown`, async () => {
						const gate = deferred();
						const f = await boot({
							service,
							origin,
							artifacts: true,
							hold: {
								phase,
								gate: gate.promise,
								reject,
								call:
									origin === "interval"
										? phase === "artifactRead" || phase === "artifactDelete"
											? 5
											: 2
										: (origin === "continuation" || origin === "recovery") && phase === "page"
											? 2
											: 1,
							},
						});
						await f.start(origin);
						expect(await f.waitUntilHeld()).toBe(true);
						expect(f.state.pending).toBe(1);
						const closing = await f.closePending();
						expect(closing.settled()).toBe(false);
						expect(f.state.teardown).toBe(false);
						gate.resolve();
						await closing.promise;
						await f.manual();
						expect(f.state.pendingAtTeardown).toBe(0);
						expect(f.state.afterTeardown).toBe(0);
						const before = { ...f.counts };
						await f.advance(24 * 60 * 60_000);
						expect(f.counts).toEqual(before);
					});
				}
		}
	it("closes admission during preClose before sibling hooks wait", async () => {
		const gate = deferred(),
			f = await boot({ preCloseGate: gate.promise });
		const closing = await f.closePending();
		f.callback("startup")();
		await expect(f.retained()).resolves.toEqual({ status: "unavailable" });
		await settle();
		expect(f.counts.round).toBe(0);
		expect(f.counts.owner).toBe(0);
		gate.resolve();
		await closing.promise;
	});
	for (const origin of ["continuation", "recovery"] as const) {
		it(`permanently retires ${origin} and manual/startup/interval callbacks`, async () => {
			const f = await boot({ origin });
			await f.start("startup");
			await f.idle();
			const startup = f.callback("startup"),
				interval = f.callback("interval"),
				next = f.callback(origin);
			await f.app.close();
			const before = { ...f.counts },
				installed = f.intervals.mock.calls.length;
			startup();
			interval();
			next();
			await expect(f.retained()).resolves.toEqual({ status: "unavailable" });
			await expect(f.retry("jellyfin_episode", f.request)).resolves.toEqual({
				status: "unavailable",
			});
			await f.advance(24 * 60 * 60_000);
			expect(f.counts).toEqual(before);
			expect(f.intervals.mock.calls.length).toBe(installed);
		});
	}
	it("joins duplicate closes while artifact cleanup is pending", async () => {
		const gate = deferred(),
			f = await boot({ artifacts: true, hold: { phase: "artifactDelete", gate: gate.promise } });
		await f.start("startup");
		expect(await f.waitUntilHeld()).toBe(true);
		const closing = await f.closePending();
		let secondSettled = false;
		const second = f.app.close().then(() => {
			secondSettled = true;
		});
		await settle();
		expect(closing.settled()).toBe(false);
		expect(secondSettled).toBe(false);
		gate.resolve();
		await Promise.all([closing.promise, second]);
		expect(f.state.afterTeardown).toBe(0);
		expect(new Set(f.deletions.map((row) => row.kind))).toEqual(
			new Set(["staging", "exclusions", "retired-rows", "receipts"]),
		);
		await f.assertArtifacts([f.request.instanceId]);
	});
	it("rejects an owner lookup settling after close without starting a page", async () => {
		const gate = deferred(),
			f = await boot({ hold: { phase: "owner", gate: gate.promise } });
		await f.start("manual");
		expect(await f.waitUntilHeld()).toBe(true);
		const closing = await f.closePending();
		expect(closing.settled()).toBe(false);
		gate.resolve();
		await expect(f.manual()).resolves.toEqual({ status: "unavailable" });
		await closing.promise;
		expect(f.counts.page).toBe(0);
		expect(f.state.afterTeardown).toBe(0);
	});
	for (const phase of [
		"round",
		"owner",
		"artifactRead",
		"artifactDelete",
		"preparation",
		"page",
		"retryState",
	] as const) {
		it(`excludes maintenance throughout accepted ${phase}`, async () => {
			const gate = deferred(),
				origin = phase === "owner" ? "manual" : "startup";
			const f = await boot({ artifacts: true, hold: { phase, gate: gate.promise } });
			await f.start(origin);
			expect(await f.waitUntilHeld()).toBe(true);
			expect(f.state.pending).toBe(1);
			await expect(withCleanupMaintenanceGuard(async () => undefined)).rejects.toMatchObject({
				statusCode: 409,
			});
			gate.resolve();
			await f.manual();
			await f.idle();
			await f.app.close();
			await expect(withCleanupMaintenanceGuard(async () => "released")).resolves.toBe("released");
		});
	}
	it("retains an independent manual page after its parent request returns", async () => {
		const gate = deferred(),
			f = await boot({ hold: { phase: "page", gate: gate.promise } });
		const admission = await withCleanupOperationGuard(() => f.retry("jellyfin_episode", f.request));
		expect(admission.status).toBe("accepted");
		expect(await f.waitUntilHeld()).toBe(true);
		await expect(withCleanupMaintenanceGuard(async () => undefined)).rejects.toMatchObject({
			statusCode: 409,
		});
		gate.resolve();
		if (admission.status !== "accepted") throw new Error("Synthetic page not admitted");
		await admission.backgroundTask;
		await f.app.close();
		await expect(withCleanupMaintenanceGuard(async () => "released")).resolves.toBe("released");
	});
	it("refuses manual admission during maintenance before querying an owner", async () => {
		const f = await boot();
		await withCleanupMaintenanceGuard(async () => {
			await expect(f.retry("jellyfin_episode", f.request)).resolves.toEqual({
				status: "unavailable",
			});
			expect(f.counts.owner).toBe(0);
			expect(f.counts.page).toBe(0);
			expect(f.app.schedulerRegistry.getStatus(JOB_ID.jellyfinEpisodeCache)).toMatchObject({
				state: "idle",
				totalRuns: 0,
			});
		});
		await expect(f.retry("jellyfin_episode", f.request)).resolves.toMatchObject({
			status: "accepted",
		});
		await f.idle();
		expect(f.counts.page).toBe(1);
	});
	for (const failure of ["exception", "identity", "preRenewal"] as const)
		for (const rung of [0, 1, 2]) {
			it(`preserves maintenance-denied ${failure} rung ${rung} and automatic renewal semantics`, async () => {
				const f = await boot({ failure });
				await f.start("startup");
				await f.idle();
				const delays = [30_000, 120_000, 600_000];
				for (let i = 0; i < rung; i++) await f.advance(delays[i]!);
				expect(f.counts.page).toBe(rung + 1);
				const next = f.callback("continuation"),
					before = f.counts.page;
				await withCleanupMaintenanceGuard(async () => {
					next();
					await f.idle();
					expect(f.counts.page).toBe(before);
					expect(f.timeouts.mock.calls.at(-1)?.[1]).toBe(delays[rung]);
				});
				await f.advance(delays[rung]! - 1);
				expect(f.counts.page).toBe(before);
				await f.advance(1);
				expect(f.counts.page).toBe(before + 1);
				expect(f.pageInputs.at(-1)).toMatchObject({
					resume: false,
					renewal: failure === "exception" ? undefined : "provider-unavailable-cooldown",
				});
				for (let i = rung + 1; i < 3; i++) await f.advance(delays[i]!);
				await f.advance(600_000);
				expect(f.counts.page).toBe(4);
			});
		}
	it("keeps the single allowed replan through a maintenance pause", async () => {
		const f = await boot({ failure: "replan" });
		await f.start("startup");
		await f.idle();
		const next = f.callback("continuation");
		await withCleanupMaintenanceGuard(async () => {
			next();
			await f.idle();
		});
		expect(f.counts.page).toBe(1);
		await f.advance(30_000);
		expect(f.counts.page).toBe(2);
		await f.advance(20 * 60_000);
		expect(f.counts.page).toBe(2);
	});
	it("retains cooldown renewal intent when maintenance denies the trusted recovery deadline", async () => {
		const f = await boot({ origin: "recovery" });
		await f.start("startup");
		await f.idle();
		await withCleanupMaintenanceGuard(async () => {
			await f.advance(90_000);
			await f.idle();
		});
		expect(f.counts.page).toBe(1);
		await f.advance(29_999);
		expect(f.counts.page).toBe(1);
		await f.advance(1);
		expect(f.pageInputs[1]).toMatchObject({
			resume: false,
			renewal: "provider-unavailable-cooldown",
		});
	});
	it("uses positive maintenance backoff for an already-due persisted retry", async () => {
		const f = await boot({ failure: "due" });
		const admission = await f.retry("jellyfin_episode", f.request);
		if (admission.status !== "accepted") throw new Error("Synthetic page not admitted");
		await admission.backgroundTask;
		const due = f.callback("continuation");
		await withCleanupMaintenanceGuard(async () => {
			due();
			await f.idle();
			expect(f.counts.page).toBe(1);
			expect(f.timeouts.mock.calls.at(-1)?.[1]).toBe(30_000);
		});
	});
	it("holds maintenance for a detached continuation after the full round settles", async () => {
		const gate = deferred(),
			f = await boot({
				origin: "continuation",
				hold: { phase: "page", call: 2, gate: gate.promise },
			});
		await f.start("continuation");
		expect(await f.waitUntilHeld()).toBe(true);
		expect(f.state.pending).toBe(1);
		await expect(withCleanupMaintenanceGuard(async () => undefined)).rejects.toMatchObject({
			statusCode: 409,
		});
		gate.resolve();
		await f.idle();
		await f.app.close();
	});
	it("finishes selected cleanup across owners but starts no new page after shutdown", async () => {
		const gate = deferred(),
			f = await boot({
				instances: 2,
				artifacts: true,
				hold: { phase: "artifactRead", gate: gate.promise, ownerIndex: 0 },
			});
		await f.start("startup");
		expect(await f.waitUntilHeld()).toBe(true);
		// Observe the already-started sibling independently of native query order.
		expect(
			await waitForNative(() => f.pageInputs.some((row) => row.userId === f.owners[1]!.userId)),
		).toBe(true);
		expect(f.heldObservation()).toEqual({
			ownerIndex: 0,
			phase: "artifactRead",
			pending: 1,
			startedPageOwners: [1],
		});
		expect(f.state.pending).toBe(1);
		expect(f.pageInputs.map(({ userId }) => userId)).toEqual([f.owners[1]!.userId]);
		const closing = await f.closePending();
		expect(closing.settled()).toBe(false);
		gate.resolve();
		await closing.promise;
		// Six real preparations require a page and terminal cursor read per owner.
		expect(f.counts.preparation).toBe(4);
		expect(f.preparationOwners).toEqual(new Set(f.instances.map((row) => row.id)));
		await f.assertArtifacts(f.instances.map((row) => row.id));
		expect(f.state.afterTeardown).toBe(0);
		expect(f.pageInputs.map(({ userId }) => userId)).toEqual([f.owners[1]!.userId]);
	}, 15_000);
	it("keeps ownership-scoped admission, duplicate suppression and mixed-provider selection", async () => {
		const f = await boot({ instances: 2, origin: "continuation" });
		await expect(
			f.retry("jellyfin_episode", { ...f.request, userId: f.owners[1]!.userId }),
		).resolves.toEqual({ status: "ineligible" });
		const a = await f.retry("jellyfin_episode", f.request);
		if (a.status !== "accepted") throw new Error("Synthetic page not admitted");
		await a.backgroundTask;
		await expect(f.retry("jellyfin_episode", f.request)).resolves.toEqual({
			status: "accepted",
		});
		await f.start("startup");
		await f.idle();
		expect(new Set(f.pageInputs.map(({ userId }) => userId))).toEqual(
			new Set(f.owners.map((owner) => owner.userId)),
		);
	});
	it("does not continue a superseded result", async () => {
		const f = await boot({ failure: "superseded" });
		await f.advance(STARTUP_MS + 30 * 60_000);
		expect(f.counts.page).toBe(1);
		expect(f.counts.retryState).toBe(0);
	});
});
