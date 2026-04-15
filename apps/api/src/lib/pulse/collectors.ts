/**
 * Pulse Signal Collectors
 *
 * Each collector gathers attention signals from a specific data source.
 * All collectors follow the same contract:
 *   (app, userId, log) → PulseItem[]
 *
 * Collectors never throw — internal errors are caught and surfaced as
 * warning-level PulseItems so partial failures don't block the response.
 */

import type { PulseItem } from "@arr/shared";
import { ARR_SERVICES_UPPER } from "@arr/shared";
import { LidarrClient, ProwlarrClient } from "arr-sdk";
import type { SonarrClient } from "arr-sdk";
import type { FastifyBaseLogger, FastifyInstance } from "fastify";
import {
	calculateDiskTotals,
	processHealthIssues,
	safeRequest,
	type InstanceInfo,
} from "../statistics/statistics-utils.js";
import { integrationHealth } from "../validation/integration-health.js";

// ============================================================================
// Helpers
// ============================================================================

const now = () => new Date().toISOString();

const STALE_CACHE_HOURS = 12;
const DISK_CRITICAL_PERCENT = 90;
const DISK_WARNING_PERCENT = 80;
const FAILURE_LOOKBACK_MS = 24 * 60 * 60 * 1000; // 24 hours

type Collector = (
	app: FastifyInstance,
	userId: string,
	log: FastifyBaseLogger,
) => Promise<PulseItem[]>;

// ============================================================================
// 1 & 2. ARR Health Issues + Disk Space (merged — shares client creation)
// ============================================================================

const collectArrSignals: Collector = async (app, userId, log) => {
	const instances = await app.prisma.serviceInstance.findMany({
		where: { enabled: true, userId },
	});

	const arrInstances = instances.filter((i) =>
		(ARR_SERVICES_UPPER as readonly string[]).includes(i.service),
	);

	if (arrInstances.length === 0) return [];

	const items: PulseItem[] = [];
	const seenStorageGroups = new Set<string>();

	await Promise.all(
		arrInstances.map(async (instance) => {
			const service = instance.service.toLowerCase();
			const client = app.arrClientFactory.create(instance);
			const info: InstanceInfo = {
				instanceId: instance.id,
				instanceName: instance.label,
				instanceBaseUrl: instance.baseUrl,
			};

			try {
				// Prowlarr has no disk space endpoint
				const hasDiskSpace = !(client instanceof ProwlarrClient);

				// Lidarr uses .get() instead of .getAll() for health and diskSpace
				// (older API convention); all other ARR services use .getAll()
				const isLidarr = client instanceof LidarrClient;
				const typedClient = client as SonarrClient;
				const lidarrClient = client as LidarrClient;

				// Normalize health/diskSpace results to a shared shape; Lidarr returns
				// .get() (string wikiUrl) while other services return .getAll() (object wikiUrl).
				// processHealthIssues accepts both via its HealthEntry constraint.
				type ArrHealth = Array<{
					type?: string | null;
					message?: string | null;
					source?: string | null;
					wikiUrl?: string | { toString(): string } | null;
				}>;
				type ArrDisk = Array<{ totalSpace?: number | null; freeSpace?: number | null }>;

				const [rawHealthUntyped, rawDiskUntyped] = await Promise.all([
					isLidarr
						? safeRequest(() => lidarrClient.health.get(), `${service} health`)
						: safeRequest(() => typedClient.health.getAll(), `${service} health`),
					hasDiskSpace
						? isLidarr
							? safeRequest(() => lidarrClient.diskSpace.get(), `${service} disk`)
							: safeRequest(() => typedClient.diskSpace.getAll(), `${service} disk`)
						: Promise.resolve([] as ArrDisk),
				]);
				const rawHealth = rawHealthUntyped as ArrHealth | undefined;
				const rawDisk = rawDiskUntyped as ArrDisk | undefined;

				// If health call failed, the instance is likely unreachable
				if (rawHealth === undefined) {
					items.push({
						id: `arr-unreachable-${instance.id}`,
						severity: "critical",
						category: "health",
						title: `${instance.label} is unreachable`,
						detail: `Could not connect to ${service.charAt(0).toUpperCase() + service.slice(1)} instance`,
						actionUrl: "/settings",
						actionLabel: "Check connection",
						source: service,
						timestamp: now(),
					});
					return;
				}

				const healthData = rawHealth;
				const diskData = rawDisk ?? [];

				// Health issues → pulse items
				const healthIssues = processHealthIssues(
					healthData,
					info,
					service as "sonarr" | "radarr" | "prowlarr" | "lidarr" | "readarr",
				);

				for (const issue of healthIssues) {
					items.push({
						id: `arr-health-${instance.id}-${issue.message.slice(0, 30)}`,
						severity: issue.type === "error" ? "critical" : "warning",
						category: "health",
						title: `${instance.label}: ${issue.message}`,
						detail: issue.source ? `Source: ${issue.source}` : "",
						actionUrl: "/statistics",
						actionLabel: "View health issues",
						source: service,
						timestamp: now(),
					});
				}

				// Disk space → pulse items (deduplicate by storage group)
				if (hasDiskSpace && diskData.length > 0) {
					const shouldCount =
						!instance.storageGroupId || !seenStorageGroups.has(instance.storageGroupId);

					if (instance.storageGroupId) {
						seenStorageGroups.add(instance.storageGroupId);
					}

					if (shouldCount) {
						const totals = calculateDiskTotals(diskData);
						if (totals.usagePercent >= DISK_CRITICAL_PERCENT) {
							items.push({
								id: `disk-${instance.id}`,
								severity: "critical",
								category: "storage",
								title: `${instance.label}: Disk ${Math.round(totals.usagePercent)}% full`,
								detail: `${formatBytes(totals.free)} free of ${formatBytes(totals.total)}`,
								actionUrl: "/statistics",
								actionLabel: "View storage",
								source: service,
								timestamp: now(),
							});
						} else if (totals.usagePercent >= DISK_WARNING_PERCENT) {
							items.push({
								id: `disk-${instance.id}`,
								severity: "warning",
								category: "storage",
								title: `${instance.label}: Disk ${Math.round(totals.usagePercent)}% full`,
								detail: `${formatBytes(totals.free)} free of ${formatBytes(totals.total)}`,
								actionUrl: "/statistics",
								actionLabel: "View storage",
								source: service,
								timestamp: now(),
							});
						}
					}
				}
			} catch (error) {
				log.warn({ err: error, instance: instance.id }, "pulse: ARR signal fetch failed");
				items.push({
					id: `arr-unreachable-${instance.id}`,
					severity: "critical",
					category: "health",
					title: `${instance.label} is unreachable`,
					detail: `Could not connect to ${service.charAt(0).toUpperCase() + service.slice(1)} instance`,
					actionUrl: "/settings",
					actionLabel: "Check connection",
					source: service,
					timestamp: now(),
				});
			}
		}),
	);

	return items;
};

// ============================================================================
// 3. Seerr Circuit Breaker
// ============================================================================

const collectSeerrCircuitBreaker: Collector = async (app, userId) => {
	const seerrInstances = await app.prisma.serviceInstance.findMany({
		where: { enabled: true, userId, service: "SEERR" },
	});

	if (seerrInstances.length === 0) return [];

	const items: PulseItem[] = [];
	for (const instance of seerrInstances) {
		const state = app.seerrCircuitBreaker.getState(instance.id);
		if (state === "OPEN") {
			items.push({
				id: `seerr-circuit-${instance.id}`,
				severity: "critical",
				category: "health",
				title: `${instance.label} is unreachable`,
				detail: "Multiple recent failures — requests are being blocked",
				actionUrl: "/requests",
				actionLabel: "View requests",
				source: "seerr",
				timestamp: now(),
			});
		} else if (state === "HALF_OPEN") {
			items.push({
				id: `seerr-circuit-${instance.id}`,
				severity: "warning",
				category: "health",
				title: `${instance.label} is recovering`,
				detail: "Testing connectivity after recent failures",
				actionUrl: "/requests",
				actionLabel: "View requests",
				source: "seerr",
				timestamp: now(),
			});
		}
	}
	return items;
};

// ============================================================================
// 4. Cache Staleness (Plex / Tautulli)
// ============================================================================

const collectCacheStaleness: Collector = async (app, userId) => {
	const cacheStatuses = await app.prisma.cacheRefreshStatus.findMany({
		where: { instance: { userId } },
		include: { instance: { select: { label: true } } },
	});

	if (cacheStatuses.length === 0) return [];

	const items: PulseItem[] = [];
	const staleThreshold = Date.now() - STALE_CACHE_HOURS * 60 * 60 * 1000;

	for (const status of cacheStatuses) {
		const label = status.instance.label;
		const cacheLabels: Record<string, string> = {
			plex: "Plex",
			tautulli: "Tautulli",
			plex_episode: "Plex episodes",
		};
		const cacheLabel = cacheLabels[status.cacheType] ?? status.cacheType;

		if (status.lastResult === "error") {
			items.push({
				id: `cache-error-${status.id}`,
				severity: "warning",
				category: "health",
				title: `${label}: ${cacheLabel} cache refresh failed`,
				detail: status.lastErrorMessage ?? "Unknown error",
				actionUrl: "/settings",
				actionLabel: "Check settings",
				source: status.cacheType === "tautulli" ? "tautulli" : "plex",
				timestamp: status.lastRefreshedAt.toISOString(),
			});
		} else if (status.lastRefreshedAt.getTime() < staleThreshold) {
			const hoursAgo = Math.round((Date.now() - status.lastRefreshedAt.getTime()) / (60 * 60 * 1000));
			items.push({
				id: `cache-stale-${status.id}`,
				severity: "warning",
				category: "health",
				title: `${label}: ${cacheLabel} cache is stale`,
				detail: `Last refreshed ${hoursAgo} hours ago`,
				actionUrl: "/settings",
				actionLabel: "Check settings",
				source: status.cacheType === "tautulli" ? "tautulli" : "plex",
				timestamp: status.lastRefreshedAt.toISOString(),
			});
		}
	}
	return items;
};

// ============================================================================
// 5. Validation Health
// ============================================================================

const collectValidationHealth: Collector = async () => {
	const health = integrationHealth.getAll();
	const items: PulseItem[] = [];

	for (const [name, integration] of Object.entries(health.integrations)) {
		if (integration.totals.total === 0) continue; // No data — skip

		const displayName = name.charAt(0).toUpperCase() + name.slice(1);

		if (integration.state === "failing") {
			items.push({
				id: `validation-${name}`,
				severity: "critical",
				category: "health",
				title: `${displayName} validation failing`,
				detail: `${integration.consecutiveFailures} consecutive failures`,
				actionUrl: "/settings#system",
				actionLabel: "View validation health",
				source: "system",
				timestamp: integration.lastFailureAt ?? now(),
			});
		} else if (integration.state === "degraded") {
			items.push({
				id: `validation-${name}`,
				severity: "warning",
				category: "health",
				title: `${displayName} validation degraded`,
				detail: `${integration.consecutiveFailures} recent failure(s)`,
				actionUrl: "/settings#system",
				actionLabel: "View validation health",
				source: "system",
				timestamp: integration.lastFailureAt ?? now(),
			});
		}
	}
	return items;
};

// ============================================================================
// 6. Library Insight Counts
// ============================================================================

const collectLibraryInsightCounts: Collector = async (app, userId) => {
	// Check which services are available for correlation
	const instances = await app.prisma.serviceInstance.findMany({
		where: { enabled: true, userId },
		select: { service: true },
	});

	const hasArr = instances.some((i) =>
		(ARR_SERVICES_UPPER as readonly string[]).includes(i.service),
	);

	if (!hasArr) return [];

	// Cutoff-unmet is a pure ARR concept — no Plex/Seerr dependency
	const count = await app.prisma.libraryCache.count({
		where: {
			instance: { userId },
			hasFile: true,
			cutoffUnmet: true,
		},
	});

	if (count === 0) return [];

	return [
		{
			id: "library-cutoff-unmet",
			severity: "info" as const,
			category: "quality" as const,
			title: `${count} item${count === 1 ? "" : "s"} below quality cutoff`,
			detail: "Quality upgrades available in your library",
			actionUrl: "/library?quality=cutoff-unmet",
			actionLabel: "View in library",
			source: "library",
			timestamp: now(),
		},
	];
};

// ============================================================================
// 7. Hunt Failures (last 24h)
// ============================================================================

const collectHuntFailures: Collector = async (app, userId) => {
	const hasConfigs = await app.prisma.huntConfig.count({
		where: { instance: { userId } },
	});
	if (hasConfigs === 0) return [];

	const since = new Date(Date.now() - FAILURE_LOOKBACK_MS);
	const failures = await app.prisma.huntLog.findMany({
		where: {
			instance: { userId },
			status: "error",
			startedAt: { gte: since },
		},
		include: { instance: { select: { label: true, service: true } } },
		orderBy: { startedAt: "desc" },
		take: 5,
	});

	return failures.map((f) => ({
		id: `hunt-error-${f.id}`,
		severity: "warning" as const,
		category: "operations" as const,
		title: `${f.instance.label}: Hunt failed`,
		detail: f.message ?? "Unknown error during content hunt",
		actionUrl: "/hunting",
		actionLabel: "View hunting",
		source: f.instance.service.toLowerCase(),
		timestamp: f.startedAt.toISOString(),
	}));
};

// ============================================================================
// 8. Queue Cleaner Failures (last 24h)
// ============================================================================

const collectQueueCleanerFailures: Collector = async (app, userId) => {
	const hasConfigs = await app.prisma.queueCleanerConfig.count({
		where: { instance: { userId } },
	});
	if (hasConfigs === 0) return [];

	const since = new Date(Date.now() - FAILURE_LOOKBACK_MS);
	const failures = await app.prisma.queueCleanerLog.findMany({
		where: {
			instance: { userId },
			status: "error",
			startedAt: { gte: since },
		},
		include: { instance: { select: { label: true, service: true } } },
		orderBy: { startedAt: "desc" },
		take: 5,
	});

	return failures.map((f) => ({
		id: `cleaner-error-${f.id}`,
		severity: "warning" as const,
		category: "operations" as const,
		title: `${f.instance.label}: Queue cleaner failed`,
		detail: f.message ?? "Unknown error during queue cleanup",
		actionUrl: "/queue-cleaner",
		actionLabel: "View queue cleaner",
		source: f.instance.service.toLowerCase(),
		timestamp: f.startedAt.toISOString(),
	}));
};

// ============================================================================
// 9. TRaSH Sync Failures (most recent per instance)
// ============================================================================

const collectTrashSyncFailures: Collector = async (app, userId) => {
	// Get the most recent sync per instance
	const recentSyncs = await app.prisma.trashSyncHistory.findMany({
		where: { userId },
		orderBy: { startedAt: "desc" },
		distinct: ["instanceId"],
		include: { instance: { select: { label: true } } },
		take: 20,
	});

	if (recentSyncs.length === 0) return [];

	return recentSyncs
		.filter((s) => s.status === "FAILED")
		.map((s) => ({
			id: `trash-sync-${s.id}`,
			severity: "warning" as const,
			category: "operations" as const,
			title: `${s.instance.label}: TRaSH sync failed`,
			detail: s.errorLog ? s.errorLog.slice(0, 120) : "Profile sync failed — check TRaSH guide settings",
			actionUrl: "/trash-guides",
			actionLabel: "View TRaSH guides",
			source: "trash",
			timestamp: s.startedAt.toISOString(),
		}));
};

// ============================================================================
// 10. Scheduler Health
// ============================================================================
//
// Surfaces background jobs that genuinely need operator attention.
//
// Two rules:
//   - `disabled: true` with a non-empty `disabledReason` → warning. Today the
//     registry only receives `markDisabled(...)` from real failure paths
//     (`runSchedulerInit` prefix "Init failed: ..." or legacy plugin catches),
//     so a disabled job is always an actionable problem. If future code ever
//     introduces an intentional-opt-out `markDisabled`, this rule needs to
//     learn to distinguish intent — today it cannot, and pretending otherwise
//     would overclaim.
//   - `consecutiveFailures >= 2` → warning. A single failure may be a
//     transient blip (network hiccup, momentary ARR restart); two in a row
//     is a pattern worth surfacing.
//
// When a job is both disabled and failing, we emit only the disabled item —
// it's the root cause; showing both would be duplicate noise.
//
// Healthy / idle jobs emit nothing. Severity stays at `warning`: the registry
// does not track whether a job is operationally critical vs nice-to-have, so
// escalating to `critical` would invent intent the data cannot support.

const FAILING_THRESHOLD = 2;
const DETAIL_MAX_LENGTH = 140;

function truncate(text: string, max = DETAIL_MAX_LENGTH): string {
	return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

const collectSchedulerHealth: Collector = async (app) => {
	// Scheduler state is a process-global registry — all jobs are system-wide
	// (backup, library-sync, trash-sync, etc.), not per-user. arr-dashboard is
	// a single-admin self-hosted app (see CLAUDE.md), so the one operator
	// should see every job's health. If this ever becomes multi-user, this
	// collector needs per-user gating or the registry needs userId tracking.
	const jobs = app.schedulerRegistry.list();
	const items: PulseItem[] = [];

	for (const job of jobs) {
		// Rule 1: disabled with a meaningful reason takes precedence.
		if (job.disabled) {
			if (!job.disabledReason) continue; // Defensive: no reason → nothing actionable to say.
			const id = `scheduler-disabled-${job.id}`;
			items.push({
				id,
				severity: "warning",
				category: "operations",
				title: `${job.label} is disabled`,
				detail: truncate(job.disabledReason),
				// /settings has no scheduler surface. Deep-link to /pulse with
				// the item id as a hash so the operator lands directly on the
				// matching row (pulse-client.tsx scrolls + highlights on hash)
				// instead of having to hunt in the full feed.
				actionUrl: `/pulse#${id}`,
				actionLabel: "View in Pulse",
				source: "system",
				timestamp: job.lastFailureAt ?? now(),
			});
			continue;
		}

		// Rule 2: repeated recent failures.
		if (job.consecutiveFailures >= FAILING_THRESHOLD) {
			const errorHint = job.lastError ? ` — last error: ${job.lastError}` : "";
			const id = `scheduler-failing-${job.id}`;
			items.push({
				id,
				severity: "warning",
				category: "operations",
				title: `${job.label} is failing`,
				detail: truncate(`${job.consecutiveFailures} consecutive failures${errorHint}`),
				actionUrl: `/pulse#${id}`,
				actionLabel: "View in Pulse",
				source: "system",
				timestamp: job.lastFailureAt ?? now(),
			});
		}
	}

	return items;
};

// ============================================================================
// 11. Cleanup Opportunities
// ============================================================================

const collectCleanupOpportunities: Collector = async (app, userId, _log) => {
	const config = await app.prisma.libraryCleanupConfig.findFirst({
		where: { userId },
		select: {
			enabled: true,
			rules: { where: { enabled: true }, select: { id: true } },
			logs: {
				where: { status: "completed" },
				orderBy: { startedAt: "desc" },
				take: 1,
				select: { itemsFlagged: true, itemsEvaluated: true, startedAt: true },
			},
		},
	});

	if (!config) return [];

	const items: PulseItem[] = [];
	const ruleCount = config.rules.length;
	const lastLog = config.logs[0];

	// Cleanup disabled but rules exist
	if (!config.enabled && ruleCount > 0) {
		items.push({
			id: "cleanup-disabled",
			severity: "info",
			category: "quality",
			title: "Library cleanup is paused",
			detail: `${ruleCount} rule${ruleCount === 1 ? "" : "s"} configured but cleanup is disabled`,
			actionUrl: "/cleanup",
			actionLabel: "Review cleanup",
			source: "cleanup",
			timestamp: now(),
		});
	}

	// Last run flagged items
	if (lastLog && lastLog.itemsFlagged > 0) {
		items.push({
			id: "cleanup-items-flagged",
			severity: "info",
			category: "quality",
			title: `${lastLog.itemsFlagged} item${lastLog.itemsFlagged === 1 ? "" : "s"} match cleanup rules`,
			detail: `Found in last run (${lastLog.itemsEvaluated} evaluated)`,
			actionUrl: "/cleanup",
			actionLabel: "Review in cleanup",
			source: "cleanup",
			timestamp: lastLog.startedAt.toISOString(),
		});
	}

	// No rules configured but has a meaningful library
	if (ruleCount === 0) {
		const libraryCount = await app.prisma.libraryCache.count({
			where: { instance: { userId } },
		});
		if (libraryCount > 50) {
			items.push({
				id: "cleanup-no-rules",
				severity: "info",
				category: "quality",
				title: "No cleanup rules configured",
				detail: `${libraryCount} items in library — templates available to get started`,
				actionUrl: "/cleanup",
				actionLabel: "Set up cleanup",
				source: "cleanup",
				timestamp: now(),
			});
		}
	}

	return items;
};

// ============================================================================
// Byte formatting utility
// ============================================================================

function formatBytes(bytes: number): string {
	if (bytes === 0) return "0 B";
	const units = ["B", "KB", "MB", "GB", "TB"];
	const i = Math.floor(Math.log(bytes) / Math.log(1024));
	const value = bytes / 1024 ** i;
	return `${value.toFixed(i > 1 ? 1 : 0)} ${units[i]!}`;
}

// ============================================================================
// Exported: all collectors
// ============================================================================

// Exported for testing
export { collectArrSignals, collectSchedulerHealth };

export const pulseCollectors: Collector[] = [
	collectArrSignals,
	collectSeerrCircuitBreaker,
	collectCacheStaleness,
	collectValidationHealth,
	collectLibraryInsightCounts,
	collectHuntFailures,
	collectQueueCleanerFailures,
	collectTrashSyncFailures,
	collectSchedulerHealth,
	collectCleanupOpportunities,
];
