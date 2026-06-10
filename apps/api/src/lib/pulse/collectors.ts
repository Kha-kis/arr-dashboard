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

import type {
	PulseAction,
	PulseCacheType,
	PulseItem,
	QueueRetryService,
	SchedulerJobId,
} from "@arr/shared";
import { ARR_SERVICES_UPPER, LIBRARY_SERVICES_UPPER } from "@arr/shared";
import type { SonarrClient } from "arr-sdk";
import { LidarrClient, ProwlarrClient } from "arr-sdk";
import type { FastifyBaseLogger, FastifyInstance } from "fastify";
import type { ArrClient } from "../arr/client-factory.js";
import {
	isLidarrClient,
	isRadarrClient,
	isReadarrClient,
	isSonarrClient,
} from "../arr/client-helpers.js";
import { QuiApiError, QuiInstanceUnreachableError } from "../errors.js";
import { createJellyfinClient } from "../jellyfin/jellyfin-client.js";
import { createPlexClient } from "../plex/plex-client.js";
import { createQuiClient } from "../qui/client-factory.js";
import { listQuiInstances } from "../qui/instance-helpers.js";
import {
	calculateDiskTotals,
	type InstanceInfo,
	processHealthIssues,
	safeRequest,
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
// 2a. Media-Server Reachability (Plex / Jellyfin / Tautulli)
// ============================================================================
//
// Mirrors the `arr-unreachable-*` pattern in collectArrSignals above, but
// for the three non-ARR media services. Without this collector, an
// unreachable Plex/Jellyfin/Tautulli surfaces to operators only as a
// "cache refresh errors" row — which is technically accurate (the cache
// refresh did fail) but misdirects the operator toward retrying a cache
// refresh when the actual fix is to restore the upstream connection.
//
// Design choices:
//   - **Critical severity** matches `arr-unreachable-*`. An unreachable
//     media server means the operator sees stale or missing data in
//     downstream surfaces (/statistics, recently-added, now-playing) —
//     that's trust-breaking and deserves the highest severity.
//   - **Cheap ping endpoints** — `getPublicInfo()` on Jellyfin
//     (unauthenticated, no data returned), `getIdentity()` on Plex
//     (unauthenticated), `getInfo()` on Tautulli. Each uses the
//     client's built-in 10–15s AbortSignal.timeout so a dead instance
//     fails fast without hanging the /pulse response.
//   - **DB filter by service type** — fetching instances already
//     filtered to PLEX/JELLYFIN/TAUTULLI means we don't risk an
//     AppValidationError from the require*Client helpers (which would
//     look like "unreachable" when it's actually a data-integrity
//     issue). We use the plain `create*Client()` factories instead.
//   - **Per-instance parallelism + per-instance try/catch** — matches
//     collectArrSignals. One bad instance doesn't silence the others.

const collectMediaServerReachability: Collector = async (app, userId, log) => {
	const instances = await app.prisma.serviceInstance.findMany({
		where: {
			enabled: true,
			userId,
			service: { in: ["PLEX", "JELLYFIN"] },
		},
	});

	if (instances.length === 0) return [];

	const items: PulseItem[] = [];

	await Promise.all(
		instances.map(async (instance) => {
			const service = instance.service.toLowerCase() as "plex" | "jellyfin";
			const serviceLabel = service === "plex" ? "Plex" : "Jellyfin";
			try {
				if (service === "plex") {
					const client = createPlexClient(app.encryptor, instance, app.log);
					await client.getIdentity();
				} else {
					const client = createJellyfinClient(app.encryptor, instance, app.log);
					await client.getPublicInfo();
				}
				// Reachable — no row emitted.
			} catch (error) {
				log.warn(
					{ err: error, instanceId: instance.id, service },
					"pulse: media server unreachable",
				);
				items.push({
					id: `${service}-unreachable-${instance.id}`,
					severity: "critical",
					category: "health",
					title: `${instance.label} is unreachable`,
					detail: `Could not connect to ${serviceLabel} instance`,
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
// 2b. ARR Queue Failures (Sonarr / Radarr / Lidarr / Readarr)
// ============================================================================
//
// Surfaces per-queue-item failures — failed or stuck downloads — from each
// ARR instance the user owns, so operators can retry directly from the
// Pulse surface via the queue.retry action. Classification is intentionally
// tight: we flag only items the ARR app itself has reported as failed
// (trackedDownloadState=importFailed / status=failed / trackedDownloadStatus=error)
// or warned about *with an attached errorMessage* (trackedDownloadStatus=warning
// + non-empty errorMessage). Generic "warning" items without a concrete cause
// are deliberately left out — they risk emitting for items that just take
// longer than the ARR app's comfort threshold.
//
// **Fan-out control**: capped at QUEUE_FAILURE_CAP_PER_INSTANCE rows per
// instance. An instance with more matching items emits the capped set
// (prioritized failed-before-stuck, oldest-first) plus a single rollup
// row — with **no action** — pointing at the queue page. This keeps a bad
// download-client day from drowning Needs Attention with dozens of rows
// that push more-important system issues below the visible fold.
//
// **Performance**: relies entirely on the existing 60s per-user Pulse
// cache. One queue fetch per ARR instance per cache miss. Per-instance
// try/catch so one unreachable instance doesn't silence the others —
// collectArrSignals already emits the "unreachable" row separately, so we
// don't duplicate.

const QUEUE_FAILURE_CAP_PER_INSTANCE = 10;
const QUEUE_TITLE_MAX_LENGTH = 70;

type QueueItemRecord = Record<string, unknown>;
type QueueClassification = "failed" | "stuck";

interface ClassifiedQueueItem {
	id: string | number;
	title: string;
	added: string | null;
	classification: QueueClassification;
	errorMessage: string | null;
}

/** Exported for focused unit testing; pure function over the raw item fields. */
export function classifyQueueItem(item: QueueItemRecord): QueueClassification | null {
	const state = toLower(item.trackedDownloadState);
	const status = toLower(item.trackedDownloadStatus);
	const topStatus = toLower(item.status);
	const errorMessage = toStringField(item.errorMessage ?? item.error);

	// Failed: ARR explicitly declares the download failed. No ambiguity.
	if (state === "importfailed" || status === "error" || topStatus === "failed") {
		return "failed";
	}

	// Stuck: ARR flagged a warning AND attached a concrete error message.
	// Requiring the errorMessage keeps us out of the "this download is just
	// slow" false-positive trap — we only emit when ARR is actually
	// describing a problem.
	if (status === "warning" && errorMessage.length > 0) {
		return "stuck";
	}

	return null;
}

function toLower(v: unknown): string {
	return typeof v === "string" ? v.toLowerCase() : "";
}

function toStringField(v: unknown): string {
	return typeof v === "string" ? v : "";
}

function extractQueueTitle(item: QueueItemRecord, fallback: string): string {
	const direct = toStringField(item.title);
	if (direct) return direct;
	const series = (item.series as QueueItemRecord | undefined)?.title;
	const movie = (item.movie as QueueItemRecord | undefined)?.title;
	const artist = (item.artist as QueueItemRecord | undefined)?.artistName;
	const album = (item.album as QueueItemRecord | undefined)?.title;
	const author = (item.author as QueueItemRecord | undefined)?.authorName;
	const book = (item.book as QueueItemRecord | undefined)?.title;
	return toStringField(series ?? movie ?? artist ?? album ?? author ?? book) || fallback;
}

function truncateTitle(title: string): string {
	return title.length > QUEUE_TITLE_MAX_LENGTH
		? `${title.slice(0, QUEUE_TITLE_MAX_LENGTH - 1)}…`
		: title;
}

async function fetchRawQueue(client: ArrClient): Promise<QueueItemRecord[]> {
	if (isSonarrClient(client)) {
		const res = await client.queue.get({
			pageSize: 1000,
			includeUnknownSeriesItems: true,
		});
		return (res.records ?? []) as QueueItemRecord[];
	}
	if (isRadarrClient(client)) {
		const res = await client.queue.get({ pageSize: 1000 });
		return (res.records ?? []) as QueueItemRecord[];
	}
	if (isLidarrClient(client)) {
		const res = await client.queue.get({
			pageSize: 1000,
			includeUnknownArtistItems: true,
		});
		return (res.records ?? []) as QueueItemRecord[];
	}
	if (isReadarrClient(client)) {
		const res = await client.queue.get({
			pageSize: 1000,
			includeUnknownAuthorItems: true,
		});
		return (res.records ?? []) as QueueItemRecord[];
	}
	return [];
}

const collectArrQueueFailures: Collector = async (app, userId, log) => {
	const instances = await app.prisma.serviceInstance.findMany({
		where: {
			enabled: true,
			userId,
			service: { in: [...LIBRARY_SERVICES_UPPER] },
		},
	});

	if (instances.length === 0) return [];

	const items: PulseItem[] = [];

	await Promise.all(
		instances.map(async (instance) => {
			const service = instance.service.toLowerCase() as QueueRetryService;
			// Runtime-safe: we filtered `service: { in: LIBRARY_SERVICES_UPPER }`
			// above, so the factory returns a Sonarr/Radarr/Lidarr/Readarr client.
			// TS can't narrow the generic across the Prisma boundary, hence the cast.
			const client = app.arrClientFactory.create(instance) as ArrClient;

			let raw: QueueItemRecord[];
			try {
				raw = await fetchRawQueue(client);
			} catch (error) {
				// collectArrSignals emits the unreachable signal separately —
				// don't duplicate here.
				log.warn({ err: error, instanceId: instance.id, service }, "pulse: queue fetch failed");
				return;
			}

			const classified: ClassifiedQueueItem[] = [];
			for (const r of raw) {
				const classification = classifyQueueItem(r);
				if (!classification) continue;
				const rawId = r.id ?? r.queueId ?? r.queueItemId;
				if (typeof rawId !== "number" && typeof rawId !== "string") continue;
				classified.push({
					id: rawId,
					title: extractQueueTitle(r, "Unknown download"),
					added: typeof r.added === "string" ? r.added : null,
					classification,
					errorMessage: toStringField(r.errorMessage ?? r.error) || null,
				});
			}

			if (classified.length === 0) return;

			// Priority ordering: failed first (higher severity signal), then
			// stuck; within each group, oldest first (items that have been
			// sitting longest are more likely to genuinely need attention).
			classified.sort((a, b) => {
				if (a.classification !== b.classification) {
					return a.classification === "failed" ? -1 : 1;
				}
				return (a.added ?? "").localeCompare(b.added ?? "");
			});

			const visible = classified.slice(0, QUEUE_FAILURE_CAP_PER_INSTANCE);
			const overflow = classified.length - visible.length;

			for (const item of visible) {
				const titleStr = truncateTitle(item.title);
				const tag = item.classification === "failed" ? "failed" : "stuck";
				const suffix = item.classification === "failed" ? "failed" : "warning";
				const detail =
					item.errorMessage ??
					(item.classification === "failed"
						? "Download failed"
						: "Download has a tracked-download warning");

				items.push({
					id: `queue-${tag}-${instance.id}-${item.id}`,
					severity: "warning",
					category: "operations",
					title: `${instance.label}: ${titleStr} (${suffix})`,
					detail: truncate(detail),
					actionUrl: "/dashboard",
					actionLabel: "View in queue",
					source: service,
					timestamp: item.added ?? now(),
					action: {
						kind: "queue.retry",
						target: {
							instanceId: instance.id,
							queueItemId: String(item.id),
							service,
						},
						label: "Retry",
						destructive: false,
					},
				});
			}

			if (overflow > 0) {
				// Rollup row — intentionally NO `action` field. Exposing a
				// Retry button here would have to be ambiguous ("retry
				// which one?") and the whole point of the cap is to keep
				// the row count honest. Operators navigate to the queue
				// page to deal with the overflow in batch.
				items.push({
					id: `queue-overflow-${instance.id}`,
					severity: "warning",
					category: "operations",
					title: `${instance.label}: +${overflow} more failed items`,
					detail: "Open the queue to retry or clean them up",
					actionUrl: "/dashboard",
					actionLabel: "View queue",
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
// 4. Cache Staleness (Plex)
// ============================================================================

// Cache types the pulse-action dispatcher knows how to refresh. Must stay
// in sync with `pulseCacheTypeSchema` in @arr/shared and with the dispatcher
// in apps/api/src/lib/pulse/actions.ts. Stale cache rows for other
// cacheType values (e.g. "plex_episode", or pre-migration "tautulli" rows
// that linger until the 3.0 dialog deletes their instances) still emit a
// warning — just without an action button, so we don't ship a click the
// backend can't fulfil.
const REFRESHABLE_CACHE_TYPES = new Set<PulseCacheType>(["plex"]);

function actionForStaleCache(instanceId: string, cacheType: string): PulseAction | undefined {
	if (!REFRESHABLE_CACHE_TYPES.has(cacheType as PulseCacheType)) return undefined;
	return {
		kind: "cache.refresh",
		target: { instanceId, cacheType: cacheType as PulseCacheType },
		label: "Refresh now",
		destructive: false,
	};
}

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
			plex_episode: "Plex episodes",
		};
		const cacheLabel = cacheLabels[status.cacheType] ?? status.cacheType;

		if (status.lastResult === "error") {
			// Error items intentionally do NOT carry an inline action — a
			// failed refresh likely fails again on the same network/config
			// issue, so the "Check settings" link remains the right affordance.
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
			const hoursAgo = Math.round(
				(Date.now() - status.lastRefreshedAt.getTime()) / (60 * 60 * 1000),
			);
			const action = actionForStaleCache(status.instanceId, status.cacheType);
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
				...(action ? { action } : {}),
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
			detail: s.errorLog
				? s.errorLog.slice(0, 120)
				: "Profile sync failed — check TRaSH guide settings",
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

// Schedulers the pulse-action dispatcher knows how to re-enable. Must stay
// in sync with `schedulerJobIdSchema` in @arr/shared and with the dispatcher
// branch in apps/api/src/lib/pulse/actions.ts. A disabled scheduler whose
// id is not in this set still emits a warning — just without an action.
const ENABLEABLE_JOB_IDS = new Set<SchedulerJobId>(["hunting", "queue-cleaner"]);

function actionForDisabledScheduler(jobId: string): PulseAction | undefined {
	if (!ENABLEABLE_JOB_IDS.has(jobId as SchedulerJobId)) return undefined;
	return {
		kind: "scheduler.enable",
		target: { jobId: jobId as SchedulerJobId },
		label: "Enable",
		destructive: false,
	};
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
			// Inline re-enable action — only for schedulers the dispatcher
			// supports. Today `markDisabled` is only called from init/failure
			// paths (see comment above), so a disabled hunting/queue-cleaner
			// job is always auto-suspended and safely re-enableable. Other
			// job ids emit the warning without an action so we don't ship a
			// button the backend can't fulfil.
			const action = actionForDisabledScheduler(job.id);
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
				...(action ? { action } : {}),
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
export {
	collectArrQueueFailures,
	collectArrSignals,
	collectCacheStaleness,
	collectMediaServerReachability,
	collectSchedulerHealth,
};

// `collectQuiSignals` is declared after this block; re-exported below.

// ============================================================================
// 12. qui Seeding Health Domain (Phase 2.1b)
// ============================================================================
//
// Emits a single ROLLUP attention row per qui instance, NOT one row per
// disconnected qBit. The rollup uses the 5-state domain taxonomy
// (`domain-status-taxonomy.md`): healthy state emits nothing (Pulse is
// attention-only), `degraded` emits a warning rollup ("X of Y qBittorrent
// instances disconnected"), `offline` emits a critical rollup ("qui
// unreachable"). Settings → Services renders the per-instance
// `DomainStatusBadge` for the healthy case via `service-instance-card.tsx`.
//
// Pre-2.1b this emitted N per-qbit items, which scaled poorly: 3 qui × 5
// qBit each = 15 individual rows competing for attention with genuinely
// distinct problems elsewhere in the system. The rollup respects the
// operator's attention budget.
const collectQuiSignals: Collector = async (app, userId, log) => {
	const instances = await listQuiInstances(app, userId);

	if (instances.length === 0) return [];

	const items: PulseItem[] = [];

	// Webhook-drop signal: if QuiEventLog insert failed at the receiver, we
	// 200-suppress to qui so it doesn't retry-storm us, but we still log a
	// `qui_webhook_dropped` activity row. Surface as Pulse so the operator
	// sees the gap on their health dashboard, not just in pino logs.
	// Window: last 24h, matches the activity log retention floor.
	try {
		const dropCutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
		const droppedCount = await app.prisma.quiActivityLog.count({
			where: {
				userId,
				eventType: "qui_webhook_dropped",
				createdAt: { gte: dropCutoff },
			},
		});
		if (droppedCount > 0) {
			items.push({
				id: "qui-webhook-drops",
				severity: droppedCount >= 10 ? "critical" : "warning",
				category: "health",
				title: `${droppedCount} qui webhook event${droppedCount === 1 ? "" : "s"} dropped in the last 24h`,
				detail:
					"The dashboard acknowledged these events to qui (to stop retry storms) but couldn't persist them — usually a disk-full / schema-drift / migration issue. Check arr-dashboard logs for the underlying DB error.",
				actionUrl: "/qui-activity",
				actionLabel: "View qui Activity → Activity feed → qui_webhook_dropped",
				source: "qui",
				timestamp: new Date().toISOString(),
			});
		}
	} catch (countErr) {
		// Pulse collectors must be non-fatal — a count failure here just
		// means the operator won't see the drop signal this tick.
		log.warn(
			{ err: countErr, userId },
			"pulse: qui webhook-drop count failed; continuing without that signal",
		);
	}

	await Promise.all(
		instances.map(async (instance) => {
			try {
				const client = createQuiClient(app, instance);
				const qbitInstances = await client.listInstances();

				const totalQbit = qbitInstances.length;
				const disconnected = qbitInstances.filter((q) => !q.connected);

				// Healthy state: don't emit. Pulse is attention-only.
				if (disconnected.length === 0) return;

				// Degraded: some qBit disconnected, but qui itself is reachable.
				items.push({
					id: `qui-degraded-${instance.id}`,
					severity: "warning",
					category: "health",
					title: `${instance.label}: ${disconnected.length} of ${totalQbit} qBittorrent instances disconnected`,
					detail:
						disconnected.length === totalQbit
							? "All qBittorrent instances behind this qui are offline"
							: `qui itself is reachable; some qBittorrent instances need attention: ${disconnected.map((q) => q.name).join(", ")}`,
					actionUrl: "/settings#services",
					actionLabel: "Check connection",
					source: "qui",
					timestamp: new Date().toISOString(),
				});
			} catch (error) {
				// Distinguish three error classes so operators don't chase the
				// wrong rabbit hole during incidents:
				//
				// 1. `QuiInstanceUnreachableError` / `QuiApiError` — the documented
				//    qui transport contract. Real "qui unreachable" attention row.
				//
				// 2. Anything else (most importantly `app.encryptor.decrypt()`
				//    throwing on bad ciphertext or rotated `ENCRYPTION_KEY`) — NOT
				//    a qui networking issue. Surface as a config attention row so
				//    operators don't waste time on qui logs / network checks when
				//    the real fix is local config.
				const isQuiTransportError =
					error instanceof QuiInstanceUnreachableError || error instanceof QuiApiError;

				if (isQuiTransportError) {
					log.warn({ err: error, instanceId: instance.id }, "pulse: qui instance unreachable");
					items.push({
						id: `qui-offline-${instance.id}`,
						severity: "critical",
						category: "health",
						title: `${instance.label} is unreachable`,
						detail: "Could not connect to qui instance",
						actionUrl: "/settings#services",
						actionLabel: "Check connection",
						source: "qui",
						timestamp: new Date().toISOString(),
					});
				} else {
					// Local-config / programmer-error path. ENCRYPTION_KEY mismatch,
					// stale ciphertext after a key rotation, Prisma issues calling
					// listQuiInstances, etc. Distinct attention row + ERROR-level log.
					log.error(
						{ err: error, instanceId: instance.id, instanceLabel: instance.label },
						"pulse: qui collector hit local-config error (not a qui networking issue)",
					);
					items.push({
						id: `qui-config-error-${instance.id}`,
						severity: "critical",
						category: "health",
						title: `${instance.label}: configuration error`,
						detail:
							"qui instance config could not be used (likely encryption key mismatch or stale credential). Re-saving the qui API key in Settings → Services usually fixes this.",
						actionUrl: "/settings#services",
						actionLabel: "Re-save credentials",
						source: "qui",
						timestamp: new Date().toISOString(),
					});
				}
			}
		}),
	);

	return items;
};

export type { Collector };
// Test re-exports — collectQuiSignals + the Collector type alias.
export { collectQuiSignals };

export const pulseCollectors: Collector[] = [
	collectArrSignals,
	collectMediaServerReachability,
	collectArrQueueFailures,
	collectSeerrCircuitBreaker,
	collectCacheStaleness,
	collectValidationHealth,
	collectLibraryInsightCounts,
	collectHuntFailures,
	collectQueueCleanerFailures,
	collectTrashSyncFailures,
	collectSchedulerHealth,
	collectCleanupOpportunities,
	collectQuiSignals,
];
