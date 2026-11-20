import type { FastifyInstance } from "fastify";
import { createJellyfinNativeEpisodeJobAdapter } from "../jellyfin/jellyfin-native-episode-inventory.js";
import { createJellyfinNativeLibraryJobAdapter } from "../jellyfin/jellyfin-native-inventory.js";
import { runJellyfinNativePageWorker } from "../jellyfin/jellyfin-native-page-worker-transport.js";
import { runPlexNativePageWorker } from "../plex/plex-native-page-worker-transport.js";
import { createPlexNativeJobAdapter } from "../plex/plex-native-inventory.js";
import type { PrismaClient, ProviderNativeInventoryRun, ServiceInstance } from "../prisma.js";
import type { ProviderPublicationAuthority } from "../services/provider-identity-guard.js";
import { getStoredHttpAuthHeaders } from "../services/http-auth.js";
import {
	createProviderPublicationAuthority,
	ProviderIdentityGuardError,
	verifyLiveProviderIdentity,
} from "../services/provider-identity-guard.js";
import { readNativeInventoryPage } from "./native-inventory.js";
import { runNativeControlWorker } from "./native-control-worker-transport.js";
import {
	admitNativeInventoryRun,
	type NativeInventoryWorkKey,
} from "./native-inventory-job-repository.js";
import {
	type NativeInventorySlicePhase,
	runNativeInventoryJobSlice,
} from "./native-inventory-job-runner.js";

type DueNativeInventoryRun = Pick<
	ProviderNativeInventoryRun,
	"id" | "instanceId" | "workKey" | "connectionGeneration" | "identityGeneration" | "updatedAt"
> & { instance: ServiceInstance };

export type NativeInventoryWorkBudget = {
	maxRuns: number;
	maxConcurrent: number;
	maxPagesPerRun: number;
	pageSize: number;
	maxDurationMs: number;
	retryDelayMs: number;
};

type NativeInventorySliceResult = Awaited<ReturnType<typeof runNativeInventoryJobSlice>>;

export type NativeInventoryWorkDependencies = {
	signal?: AbortSignal;
	executeRun?: (
		run: DueNativeInventoryRun,
		options: {
			signal?: AbortSignal;
			deadlineAt: number;
			maxPages: number;
			pageSize: number;
			retryDelayMs: number;
			reportPhase?: (phase: NativeInventorySlicePhase) => void;
		},
	) => Promise<NativeInventorySliceResult>;
};

let fairnessOffset = 0;
let periodicOffset = 0;

export type NativeInventoryRefreshRequestResult = {
	status: "accepted" | "coalesced" | "current" | "superseded" | "retryable";
};

export const NATIVE_INVENTORY_REFRESH_INTERVAL_MS = 30 * 60_000;
const JELLYFIN_NATIVE_PAGE_SIZE = 2_000;

type NativeInventoryRefreshOptions = { mode?: "automatic" | "force"; now?: Date };

async function inspectCurrentNativeWork(
	prisma: PrismaClient,
	authority: ProviderPublicationAuthority,
	workKey: NativeInventoryWorkKey,
	now: Date,
	maxAgeMs: number,
): Promise<"current" | "not-current" | "superseded"> {
	let generationId: string | null = null;
	for (const domain of workKey === "paired" ? (["library", "episode"] as const) : [workKey]) {
		const page = await readNativeInventoryPage(prisma, {
			userId: authority.userId,
			instanceId: authority.id,
			domain,
			limit: 1,
			now,
			maxAgeMs,
			expectedAuthority: authority,
		});
		if (page.status === "unavailable") {
			return page.reason === "identity-changed" || page.reason === "not-owned"
				? "superseded"
				: "not-current";
		}
		if (!page.complete || now.getTime() - page.observedAt.getTime() >= maxAgeMs) {
			return "not-current";
		}
		if (generationId !== null && page.generationId !== generationId) return "not-current";
		generationId = page.generationId;
	}
	return "current";
}

/** Persist independent native work without waiting for a provider page. */
export async function requestNativeInventoryRefresh(
	prisma: PrismaClient,
	authority: ProviderPublicationAuthority,
	workKeys: readonly NativeInventoryWorkKey[],
	options: NativeInventoryRefreshOptions = {},
): Promise<NativeInventoryRefreshRequestResult> {
	const now = options.now ?? new Date();
	if (
		!Number.isFinite(now.getTime()) ||
		workKeys.length === 0 ||
		new Set(workKeys).size !== workKeys.length ||
		(authority.service === "PLEX"
			? workKeys.some((key) => key !== "paired")
			: authority.service === "JELLYFIN" || authority.service === "EMBY"
				? workKeys.some((key) => key === "paired")
				: true)
	)
		return { status: "superseded" };
	let accepted = false;
	let retryable = false;
	let coalesced = false;
	for (const workKey of workKeys) {
		if (options.mode !== "force") {
			const state = await inspectCurrentNativeWork(
				prisma,
				authority,
				workKey,
				now,
				NATIVE_INVENTORY_REFRESH_INTERVAL_MS,
			);
			if (state === "superseded") return { status: "superseded" };
			if (state === "current") continue;
		}
		const result = await admitNativeInventoryRun(prisma, authority, workKey, now);
		if (result.status === "superseded") return { status: "superseded" };
		if (result.status === "retryable") retryable = true;
		if (result.status === "acquired") accepted = true;
		if (result.status === "coalesced") coalesced = true;
	}
	return {
		status: retryable ? "retryable" : accepted ? "accepted" : coalesced ? "coalesced" : "current",
	};
}

/** Admit missing or aged native work, with a cooldown after terminal attempts. */
export async function schedulePeriodicNativeInventoryWork(
	prisma: PrismaClient,
	now: Date,
	cadence: { maxInstances: number; refreshIntervalMs: number; retryCooldownMs: number },
	options: { signal?: AbortSignal } = {},
): Promise<{
	accepted: number;
	coalesced: number;
	superseded: number;
	retryable: number;
	skipped: number;
}> {
	const totals = { accepted: 0, coalesced: 0, superseded: 0, retryable: 0, skipped: 0 };
	if (options.signal?.aborted) return totals;
	if (
		!Number.isFinite(now.getTime()) ||
		!Number.isSafeInteger(cadence.maxInstances) ||
		cadence.maxInstances < 1 ||
		cadence.maxInstances > 8 ||
		!Number.isSafeInteger(cadence.refreshIntervalMs) ||
		cadence.refreshIntervalMs < 60_000 ||
		!Number.isSafeInteger(cadence.retryCooldownMs) ||
		cadence.retryCooldownMs < 60_000
	)
		return totals;
	const instances = await prisma.serviceInstance.findMany({
		where: {
			enabled: true,
			identityStatus: "VERIFIED",
			service: { in: ["PLEX", "JELLYFIN", "EMBY"] },
		},
		orderBy: { id: "asc" },
	});
	if (instances.length === 0) return totals;
	const start = periodicOffset++ % instances.length;
	for (let index = 0; index < Math.min(cadence.maxInstances, instances.length); index++) {
		if (options.signal?.aborted) break;
		const instance = instances[(start + index) % instances.length]!;
		let authority: ProviderPublicationAuthority;
		try {
			authority = createProviderPublicationAuthority(instance);
		} catch {
			totals.superseded++;
			continue;
		}
		const workKeys: NativeInventoryWorkKey[] =
			instance.service === "PLEX" ? ["paired"] : ["library", "episode"];
		for (const workKey of workKeys) {
			if (options.signal?.aborted) return totals;
			const latest = await prisma.providerNativeInventoryRun.findFirst({
				where: { instanceId: instance.id, workKey },
				orderBy: [{ createdAt: "desc" }, { id: "desc" }],
			});
			const sameAuthority =
				latest &&
				latest.connectionGeneration === authority.connectionGeneration &&
				latest.identityGeneration === authority.identityGeneration;
			if (options.signal?.aborted) return totals;
			if (sameAuthority && latest.activeSlotKey !== null) {
				totals.skipped++;
				continue;
			}
			try {
				const state = await inspectCurrentNativeWork(
					prisma,
					authority,
					workKey,
					now,
					cadence.refreshIntervalMs,
				);
				if (state === "superseded") {
					totals.superseded++;
					continue;
				}
				if (state === "current") {
					totals.skipped++;
					continue;
				}
				if (sameAuthority && now.getTime() - latest.updatedAt.getTime() < cadence.retryCooldownMs) {
					totals.skipped++;
					continue;
				}
				if (options.signal?.aborted) return totals;
				const result = await admitNativeInventoryRun(prisma, authority, workKey, now);
				if (result.status === "acquired") totals.accepted++;
				else totals[result.status]++;
			} catch {
				totals.retryable++;
			}
		}
	}
	return totals;
}

/** Choose at most one oldest-progress run per instance, rotating across instances. */
export function selectDueNativeInventoryRuns<
	T extends { id: string; instanceId: string; updatedAt: Date },
>(runs: readonly T[], maxRuns: number, offset: number): T[] {
	if (!Number.isSafeInteger(maxRuns) || maxRuns < 1 || !Number.isSafeInteger(offset)) return [];
	const oldestByInstance = new Map<string, T>();
	for (const run of [...runs].sort(
		(a, b) => a.updatedAt.getTime() - b.updatedAt.getTime() || a.id.localeCompare(b.id),
	)) {
		if (!oldestByInstance.has(run.instanceId)) oldestByInstance.set(run.instanceId, run);
	}
	const candidates = [...oldestByInstance.values()];
	if (candidates.length === 0) return [];
	const start = ((offset % candidates.length) + candidates.length) % candidates.length;
	return Array.from(
		{ length: Math.min(maxRuns, candidates.length) },
		(_, index) => candidates[(start + index) % candidates.length]!,
	);
}

function validBudget(budget: NativeInventoryWorkBudget): boolean {
	return (
		Number.isSafeInteger(budget.maxRuns) &&
		budget.maxRuns >= 1 &&
		budget.maxRuns <= 8 &&
		Number.isSafeInteger(budget.maxConcurrent) &&
		budget.maxConcurrent >= 1 &&
		budget.maxConcurrent <= 2 &&
		Number.isSafeInteger(budget.maxPagesPerRun) &&
		budget.maxPagesPerRun >= 1 &&
		budget.maxPagesPerRun <= 20 &&
		Number.isSafeInteger(budget.pageSize) &&
		budget.pageSize >= 1 &&
		budget.pageSize <= 500 &&
		Number.isSafeInteger(budget.maxDurationMs) &&
		budget.maxDurationMs >= 1 &&
		budget.maxDurationMs <= 60_000 &&
		Number.isSafeInteger(budget.retryDelayMs) &&
		budget.retryDelayMs >= 0 &&
		budget.retryDelayMs <= 60 * 60_000
	);
}

function unavailableAdapter(domain: NativeInventoryWorkKey) {
	return {
		domain,
		async discoverScopes() {
			return { status: "unavailable" as const, reason: "provider-unavailable" as const };
		},
		async readPage() {
			return { status: "unavailable" as const, reason: "provider-unavailable" as const };
		},
	};
}

function nativeIdentityCheck(
	app: Pick<FastifyInstance, "prisma">,
	instance: ServiceInstance,
	readRawIdentity: () => Promise<string>,
): () => Promise<"verified" | "unavailable" | "superseded"> {
	return async () => {
		try {
			await verifyLiveProviderIdentity(
				app.prisma,
				createProviderPublicationAuthority(instance),
				readRawIdentity,
			);
			return "verified";
		} catch (error) {
			if (
				error instanceof ProviderIdentityGuardError &&
				(error.code === "IDENTITY_MISMATCH" ||
					error.code === "IDENTITY_UNVERIFIED" ||
					error.code === "PUBLICATION_SUPERSEDED")
			)
				return "superseded";
			return "unavailable";
		}
	};
}

async function executeNativeInventoryRun(
	app: Pick<FastifyInstance, "prisma" | "encryptor" | "log">,
	run: DueNativeInventoryRun,
	options: {
		signal?: AbortSignal;
		deadlineAt: number;
		maxPages: number;
		pageSize: number;
		retryDelayMs: number;
		reportPhase?: (phase: NativeInventorySlicePhase) => void;
	},
): Promise<NativeInventorySliceResult> {
	if (run.workKey !== "paired" && run.workKey !== "library" && run.workKey !== "episode") {
		return { status: "superseded", pagesCommitted: 0 };
	}
	if (run.instance.service === "PLEX" && run.workKey === "paired") {
		let credentials: { baseUrl: string; apiKey: string; httpAuthHeaders: Record<string, string> };
		try {
			credentials = {
				baseUrl: run.instance.baseUrl,
				apiKey: app.encryptor.decrypt({
					value: run.instance.encryptedApiKey,
					iv: run.instance.encryptionIv,
				}),
				httpAuthHeaders: getStoredHttpAuthHeaders(app.encryptor, run.instance),
			};
		} catch {
			return await runNativeInventoryJobSlice(app.prisma, run.id, unavailableAdapter(run.workKey), {
				...options,
				verifyIdentity: async () => "unavailable",
			});
		}
		return await runNativeInventoryJobSlice(
			app.prisma,
			run.id,
			createPlexNativeJobAdapter(
				{
					readNativeInventoryPage: (input) =>
						runPlexNativePageWorker({ ...input, ...credentials }, { signal: options.signal }),
				},
				{
					discoverScopes: (deadlineAt) =>
						runNativeControlWorker(
							{
								...credentials,
								provider: "plex",
								workKey: "paired",
								operation: "discovery",
								deadlineAt,
							},
							{ signal: options.signal },
						),
				},
			),
			{
				...options,
				verifyIdentity: nativeIdentityCheck(app, run.instance, async () => {
					const result = await runNativeControlWorker(
						{
							...credentials,
							provider: "plex",
							workKey: "paired",
							operation: "identity",
							deadlineAt: options.deadlineAt,
						},
						{ signal: options.signal },
					);
					if (result.status !== "identity") throw new Error("Native identity unavailable");
					return result.identity;
				}),
			},
		);
	}
	if (run.instance.service === "JELLYFIN" || run.instance.service === "EMBY") {
		if (run.workKey === "paired") return { status: "superseded", pagesCommitted: 0 };
		let credentials: { baseUrl: string; apiKey: string; httpAuthHeaders: Record<string, string> };
		try {
			credentials = {
				baseUrl: run.instance.baseUrl,
				apiKey: app.encryptor.decrypt({
					value: run.instance.encryptedApiKey,
					iv: run.instance.encryptionIv,
				}),
				httpAuthHeaders: getStoredHttpAuthHeaders(app.encryptor, run.instance),
			};
		} catch {
			return await runNativeInventoryJobSlice(app.prisma, run.id, unavailableAdapter(run.workKey), {
				...options,
				verifyIdentity: async () => "unavailable",
			});
		}
		const workKey = run.workKey;
		const pageReader = {
			readNativeInventoryPage: (
				input: Omit<
					Parameters<typeof runJellyfinNativePageWorker>[0],
					"baseUrl" | "apiKey" | "httpAuthHeaders"
				>,
			) => runJellyfinNativePageWorker({ ...input, ...credentials }, { signal: options.signal }),
		};
		const discovery = {
			discoverScopes: (deadlineAt: number) =>
				runNativeControlWorker(
					{ ...credentials, provider: "jellyfin", workKey, operation: "discovery", deadlineAt },
					{ signal: options.signal },
				),
		};
		const adapter =
			run.workKey === "library"
				? createJellyfinNativeLibraryJobAdapter(pageReader, discovery)
				: createJellyfinNativeEpisodeJobAdapter(pageReader, discovery);
		return await runNativeInventoryJobSlice(app.prisma, run.id, adapter, {
			...options,
			pageSize: run.instance.service === "JELLYFIN" ? JELLYFIN_NATIVE_PAGE_SIZE : options.pageSize,
			verifyIdentity: nativeIdentityCheck(app, run.instance, async () => {
				const result = await runNativeControlWorker(
					{
						...credentials,
						provider: "jellyfin",
						workKey,
						operation: "identity",
						deadlineAt: options.deadlineAt,
					},
					{ signal: options.signal },
				);
				if (result.status !== "identity") throw new Error("Native identity unavailable");
				return result.identity;
			}),
		});
	}
	return await runNativeInventoryJobSlice(app.prisma, run.id, unavailableAdapter(run.workKey), {
		...options,
		verifyIdentity: async () => "superseded",
	});
}

/** Resume bounded due work after startup, interval ticks, or a process replacement. */
export async function runDueNativeInventoryWork(
	app: Pick<FastifyInstance, "prisma" | "encryptor" | "log">,
	budget: NativeInventoryWorkBudget,
	dependencies: NativeInventoryWorkDependencies = {},
): Promise<{ completed: number; retryable: number; superseded: number; incomplete: number }> {
	const totals = { completed: 0, retryable: 0, superseded: 0, incomplete: 0 };
	if (!validBudget(budget) || dependencies.signal?.aborted) return totals;
	const now = new Date();
	const due = await app.prisma.providerNativeInventoryRun.findMany({
		where: {
			activeSlotKey: { not: null },
			state: { in: ["pending", "running", "ready"] },
			OR: [{ leaseUntil: null }, { leaseUntil: { lte: now } }],
			AND: [{ OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }] }],
			instance: {
				enabled: true,
				identityStatus: "VERIFIED",
				service: { in: ["PLEX", "JELLYFIN", "EMBY"] },
			},
		},
		include: { instance: true },
		orderBy: [{ updatedAt: "asc" }, { id: "asc" }],
	});
	const candidates = due.filter(
		(run) =>
			run.connectionGeneration === run.instance.connectionGeneration &&
			run.identityGeneration === run.instance.identityGeneration &&
			(run.workKey === "paired" || run.workKey === "library" || run.workKey === "episode"),
	);
	const selected = selectDueNativeInventoryRuns(candidates, budget.maxRuns, fairnessOffset++);
	const execute =
		dependencies.executeRun ?? ((run, options) => executeNativeInventoryRun(app, run, options));
	for (let offset = 0; offset < selected.length; offset += budget.maxConcurrent) {
		if (dependencies.signal?.aborted) break;
		const batch = selected.slice(offset, offset + budget.maxConcurrent);
		const results = await Promise.all(
			batch.map(async (run) => {
				if (dependencies.signal?.aborted) return { status: "yielded" as const, pagesCommitted: 0 };
				const startedAt = Date.now();
				let phase: NativeInventorySlicePhase | "dispatch" = "dispatch";
				const watchdog = setTimeout(() => {
					try {
						app.log.warn(
							{
								category: "native-inventory-slice-overdue",
								workKey: run.workKey,
								phase,
								elapsedMs: Math.max(0, Date.now() - startedAt),
							},
							"Native inventory slice exceeded its bounded work window",
						);
					} catch {
						// Diagnostics must not change the work result.
					}
				}, budget.maxDurationMs + 60_000);
				try {
					return await execute(run, {
						signal: dependencies.signal,
						deadlineAt: Date.now() + budget.maxDurationMs,
						maxPages: budget.maxPagesPerRun,
						pageSize: budget.pageSize,
						retryDelayMs: budget.retryDelayMs,
						reportPhase: (next) => {
							phase = next;
						},
					});
				} catch {
					app.log.warn(
						{ category: "unexpected-execution-error" },
						"Native inventory execution could not be persisted",
					);
					return { status: "retryable" as const, pagesCommitted: 0 };
				} finally {
					clearTimeout(watchdog);
				}
			}),
		);
		for (const result of results) {
			if (result.status === "published") totals.completed++;
			else if (result.status === "superseded") totals.superseded++;
			else if (result.status === "incomplete") totals.incomplete++;
			else totals.retryable++;
		}
	}
	return totals;
}
