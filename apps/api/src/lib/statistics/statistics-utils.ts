/**
 * Statistics Utility Functions
 *
 * Shared utilities for processing statistics across all ARR services.
 * These functions extract common patterns from service-specific fetch/aggregate functions.
 */

import { loggers } from "../logger.js";

// ============================================================================
// Type Definitions
// ============================================================================

/**
 * Instance metadata for health issues
 */
export interface InstanceInfo {
	instanceId: string;
	instanceName: string;
	instanceBaseUrl: string;
	instanceExternalUrl?: string;
}

/**
 * Time thresholds for recently added calculations
 */
export interface TimeThresholds {
	now: number;
	sevenDaysAgo: number;
	thirtyDaysAgo: number;
}

/**
 * Disk space totals
 */
export interface DiskTotals {
	total: number;
	free: number;
	used: number;
	usagePercent: number;
}

/**
 * Health issue entry (common across all services)
 */
export interface HealthIssue {
	type: "error" | "warning";
	message: string;
	source?: string;
	wikiUrl?: string;
	instanceId: string;
	instanceName: string;
	instanceBaseUrl: string;
	instanceExternalUrl?: string;
	service: "sonarr" | "radarr" | "prowlarr" | "lidarr" | "readarr";
}

/**
 * Generic health entry from ARR API
 * Note: SDK types use `null | undefined` so we accept both
 */
interface HealthEntry {
	type?: string | null;
	message?: string | null;
	source?: string | null;
	wikiUrl?: string | { toString(): string } | null;
}

/**
 * Generic disk space entry from ARR API
 */
interface DiskSpaceEntry {
	totalSpace?: number | null;
	freeSpace?: number | null;
}

/**
 * Generic quality profile entry
 * Note: SDK types use `null | undefined` so we accept both
 */
interface QualityProfileEntry {
	id?: number | null;
	name?: string | null;
}

/**
 * Generic tag entry
 * Note: SDK types use `null | undefined` so we accept both
 */
interface TagEntry {
	id?: number | null;
	label?: string | null;
}

// ============================================================================
// Number/String Conversion Utilities
// ============================================================================

/**
 * Clamps a percentage value between 0 and 100
 */
export const clampPercentage = (value: number): number => {
	if (!Number.isFinite(value)) {
		return 0;
	}
	if (value < 0) {
		return 0;
	}
	if (value > 100) {
		return 100;
	}
	return value;
};

/**
 * Safely converts an unknown value to a number
 */
export const toNumber = (value: unknown): number | undefined => {
	if (typeof value === "number" && Number.isFinite(value)) {
		return value;
	}
	if (typeof value === "string") {
		const parsed = Number(value);
		if (Number.isFinite(parsed)) {
			return parsed;
		}
	}
	return undefined;
};

// ============================================================================
// Safe Request Utilities
// ============================================================================

/**
 * Safely execute an SDK call and return undefined on error.
 * Logs failures so silent data gaps on the statistics page are diagnosable.
 */
export const safeRequest = async <T>(
	operation: () => Promise<T>,
	context?: string,
): Promise<T | undefined> => {
	try {
		return await operation();
	} catch (err) {
		if (context) {
			loggers.statistics.warn({ err, context }, "Statistics request failed");
		}
		return undefined;
	}
};

// ============================================================================
// Map Building Utilities
// ============================================================================

/**
 * Builds a map of profile ID to profile name from quality profiles
 */
export const buildProfileIdToNameMap = <T extends QualityProfileEntry>(
	profiles: T[],
): Map<number, string> => {
	const map = new Map<number, string>();
	for (const profile of profiles) {
		if (profile?.id != null && profile?.name) {
			map.set(profile.id, profile.name);
		}
	}
	return map;
};

/**
 * Builds a map of tag ID to tag label from tags
 */
export const buildTagIdToLabelMap = <T extends TagEntry>(tags: T[]): Map<number, string> => {
	const map = new Map<number, string>();
	for (const tag of tags) {
		if (tag?.id != null && tag?.label) {
			map.set(tag.id, tag.label);
		}
	}
	return map;
};

// ============================================================================
// Time Utilities
// ============================================================================

/**
 * Gets time thresholds for recently added calculations
 */
export const getTimeThresholds = (): TimeThresholds => {
	const now = Date.now();
	return {
		now,
		sevenDaysAgo: now - 7 * 24 * 60 * 60 * 1000,
		thirtyDaysAgo: now - 30 * 24 * 60 * 60 * 1000,
	};
};

/**
 * Checks if a date string falls within the recently added thresholds
 * Returns { within7Days, within30Days }
 */
export const checkRecentlyAdded = (
	addedStr: string | undefined | null,
	thresholds: TimeThresholds,
): { within7Days: boolean; within30Days: boolean } => {
	if (!addedStr) {
		return { within7Days: false, within30Days: false };
	}
	const addedTime = new Date(addedStr).getTime();
	if (Number.isNaN(addedTime)) {
		return { within7Days: false, within30Days: false };
	}
	return {
		within7Days: addedTime >= thresholds.sevenDaysAgo,
		within30Days: addedTime >= thresholds.thirtyDaysAgo,
	};
};

// ============================================================================
// Disk Space Utilities
// ============================================================================

/**
 * Calculates disk totals from disk space entries
 */
export const calculateDiskTotals = <T extends DiskSpaceEntry>(diskspace: T[]): DiskTotals => {
	const totals = diskspace.reduce(
		(acc, entry) => {
			acc.total += entry?.totalSpace ?? 0;
			acc.free += entry?.freeSpace ?? 0;
			return acc;
		},
		{ total: 0, free: 0 },
	);

	const used = Math.max(0, totals.total - totals.free);
	const usagePercent = totals.total > 0 ? clampPercentage((used / totals.total) * 100) : 0;

	return {
		total: totals.total,
		free: totals.free,
		used,
		usagePercent,
	};
};

/**
 * Normalizes raw *arr diskspace entries into a stable mount shape that can be
 * carried per-instance and later de-duplicated in `combineDiskStats`. Mount
 * `path` is intentionally dropped: it's never used for de-duplication (see
 * combineDiskStats) and shipping raw filesystem paths on the wire would leak
 * the operator's layout, which incognito mode cannot mask in an API body.
 */
export const toDiskMounts = <T extends DiskSpaceEntry>(
	diskspace: T[],
): Array<{ totalSpace: number; freeSpace: number }> =>
	diskspace.map((entry) => ({
		totalSpace: entry?.totalSpace ?? 0,
		freeSpace: entry?.freeSpace ?? 0,
	}));

/**
 * One disk-bearing instance's contribution to the combined disk total.
 */
export interface DiskContributor {
	storageGroupId?: string | null;
	diskEntries: DiskSpaceEntry[];
}

/**
 * Combined disk totals plus transparency counts.
 */
export interface CombinedDiskTotals extends DiskTotals {
	diskCount: number;
	instanceCount: number;
}

/**
 * Combines disk stats across instances while avoiding the classic
 * "one physical array, many *arr instances" over-count.
 *
 * De-duplication uses two signals, in order of trust:
 *   1. Storage group — an explicit operator declaration that instances share
 *      storage. Once a group is represented, later instances in the same group
 *      are skipped entirely (this also absorbs read-timing skew in free space).
 *   2. Disk fingerprint `${totalSpace}:${freeSpace}` — for instances with no
 *      group set. `freeSpace` drifts byte-by-byte as data is written, so an
 *      identical (total, free) pair across two instances is an extremely
 *      reliable "same filesystem" signal. The only realistic collision is
 *      near-empty disks of equal size (free ≈ total), where under-counting is
 *      harmless because the user has abundant space.
 *
 * Mount path is deliberately not consulted: under Docker/Unraid the same array
 * is bind-mounted under different container paths per service (/tv vs /movies),
 * so it can neither confirm nor split a shared disk — hence it isn't carried at
 * all (see toDiskMounts).
 *
 * `instanceCount` counts every instance that reports storage, regardless of
 * whether its disks were de-duplicated away by either signal, so the UI can
 * honestly say "N disks across M instances" — including for the operator who
 * configured storage groups (the good-citizen path must not read as fewer
 * instances than the un-configured one).
 */
export const combineDiskStats = (contributors: DiskContributor[]): CombinedDiskTotals => {
	const seenGroups = new Set<string>();
	const seenDisks = new Set<string>();
	let total = 0;
	let free = 0;
	let diskCount = 0;
	let instanceCount = 0;

	for (const contributor of contributors) {
		const usableEntries = (contributor.diskEntries ?? []).filter(
			(entry) => (entry?.totalSpace ?? 0) > 0,
		);
		if (usableEntries.length > 0) instanceCount += 1;

		const group = contributor.storageGroupId?.trim();
		if (group) {
			if (seenGroups.has(group)) continue;
			seenGroups.add(group);
		}

		for (const entry of usableEntries) {
			const entryTotal = entry.totalSpace ?? 0;
			const entryFree = entry.freeSpace ?? 0;

			const key = `${entryTotal}:${entryFree}`;
			if (seenDisks.has(key)) continue;
			seenDisks.add(key);

			total += entryTotal;
			free += entryFree;
			diskCount += 1;
		}
	}

	const used = Math.max(0, total - free);
	const usagePercent = total > 0 ? clampPercentage((used / total) * 100) : 0;

	return { total, free, used, usagePercent, diskCount, instanceCount };
};

/**
 * Minimal per-instance shape needed to compute combined disk stats.
 * Structurally compatible with the route's per-service instance arrays.
 */
export interface DiskBearingInstance {
	storageGroupId?: string | null;
	data: { diskEntries?: DiskSpaceEntry[] };
}

/**
 * The four *arr services that carry library storage. Prowlarr is intentionally
 * absent — it has no library storage and its statistics schema does not declare
 * `diskEntries`, so a future contributor cannot accidentally feed Prowlarr
 * instances into this helper without a deliberate type change.
 */
export interface DiskBearingServiceInstances {
	sonarr: DiskBearingInstance[];
	radarr: DiskBearingInstance[];
	lidarr: DiskBearingInstance[];
	readarr: DiskBearingInstance[];
}

/**
 * Shape returned to the API response under `combinedDisk`.
 */
export interface CombinedDiskPayload {
	diskTotal: number;
	diskFree: number;
	diskUsed: number;
	diskUsagePercent: number;
	diskCount: number;
	instanceCount: number;
}

/**
 * Assembles every disk-bearing instance into combineDiskStats contributors and
 * returns the combinedDisk payload, or `undefined` when no instance reports any
 * storage. This is the route-level assembly previously inlined in the dashboard
 * statistics handler; extracted so its behavior (Prowlarr exclusion via the
 * argument type, optional `diskEntries` fallback, empty-state guard) is
 * directly testable without a Fastify route harness.
 */
export const buildCombinedDiskPayload = (
	instances: DiskBearingServiceInstances,
): CombinedDiskPayload | undefined => {
	const contributors: DiskContributor[] = [
		...instances.sonarr,
		...instances.radarr,
		...instances.lidarr,
		...instances.readarr,
	].map((entry) => ({
		storageGroupId: entry.storageGroupId,
		diskEntries: entry.data.diskEntries ?? [],
	}));

	const combined = combineDiskStats(contributors);
	if (combined.total <= 0) return undefined;

	return {
		diskTotal: combined.total,
		diskFree: combined.free,
		diskUsed: combined.used,
		diskUsagePercent: combined.usagePercent,
		diskCount: combined.diskCount,
		instanceCount: combined.instanceCount,
	};
};

// ============================================================================
// Health Issues Utilities
// ============================================================================

/**
 * Processes health entries into a standardized health issues list
 */
export const processHealthIssues = <T extends HealthEntry>(
	health: T[],
	instanceInfo: InstanceInfo,
	service: HealthIssue["service"],
): HealthIssue[] => {
	return health
		.filter((item) => {
			const type = item?.type;
			return type === "error" || type === "warning";
		})
		.map((item) => ({
			type: item.type as "error" | "warning",
			message: item.message ?? "Unknown health issue",
			source: item.source ?? undefined,
			wikiUrl: item.wikiUrl ? String(item.wikiUrl) : undefined,
			instanceId: instanceInfo.instanceId,
			instanceName: instanceInfo.instanceName,
			instanceBaseUrl: instanceInfo.instanceBaseUrl,
			instanceExternalUrl: instanceInfo.instanceExternalUrl,
			service,
		}));
};

// ============================================================================
// Breakdown Utilities
// ============================================================================

/**
 * Updates tag breakdown with tag counts
 */
export const updateTagBreakdown = (
	tagIds: number[] | null | undefined,
	tagIdToLabel: Map<number, string>,
	breakdown: Record<string, number>,
): void => {
	if (!Array.isArray(tagIds)) return;
	for (const tagId of tagIds) {
		if (typeof tagId === "number" && tagIdToLabel.has(tagId)) {
			const tagLabel = tagIdToLabel.get(tagId);
			if (tagLabel !== undefined) {
				breakdown[tagLabel] = (breakdown[tagLabel] ?? 0) + 1;
			}
		}
	}
};

/**
 * Updates quality breakdown with quality profile counts
 */
export const updateQualityBreakdown = (
	profileId: number | undefined,
	profileIdToName: Map<number, string>,
	count: number,
	breakdown: Record<string, number>,
): void => {
	if (profileId !== undefined && profileIdToName.has(profileId)) {
		const profileName = profileIdToName.get(profileId);
		if (profileName !== undefined) {
			breakdown[profileName] = (breakdown[profileName] ?? 0) + count;
		}
	} else {
		breakdown.Unknown = (breakdown.Unknown ?? 0) + count;
	}
};

/**
 * Merges breakdown records (for aggregation)
 */
export const mergeBreakdown = (
	source: Record<string, number> | undefined,
	target: Record<string, number>,
): void => {
	if (!source) return;
	for (const [key, count] of Object.entries(source)) {
		target[key] = (target[key] ?? 0) + count;
	}
};

// ============================================================================
// Aggregation Utilities
// ============================================================================

/**
 * Creates base aggregation accumulators for content services
 * (shared by Sonarr, Radarr, Lidarr, Readarr)
 */
const createBaseAggregator = <T extends HealthIssue>() => ({
	diskTotal: 0,
	diskFree: 0,
	diskUsed: 0,
	healthIssues: 0,
	healthIssuesList: [] as T[],
	qualityBreakdown: {} as Record<string, number>,
	tagBreakdown: {} as Record<string, number>,
	recentlyAdded7Days: 0,
	recentlyAdded30Days: 0,
	cutoffUnmetCount: 0,
	totalFileSize: 0,
	totalFiles: 0,
});

/**
 * Finalizes disk statistics for aggregated results
 */
export const finalizeDiskStats = (acc: ReturnType<typeof createBaseAggregator>) => {
	const diskUsagePercent =
		acc.diskTotal > 0 ? clampPercentage((acc.diskUsed / acc.diskTotal) * 100) : 0;

	return {
		diskTotal: acc.diskTotal || undefined,
		diskFree: acc.diskFree || undefined,
		diskUsed: acc.diskUsed || undefined,
		diskUsagePercent,
	};
};

/**
 * Finalizes breakdown records (returns undefined if empty)
 */
export const finalizeBreakdown = (
	breakdown: Record<string, number>,
): Record<string, number> | undefined => {
	return Object.keys(breakdown).length > 0 ? breakdown : undefined;
};
