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
 * Generic disk space entry from ARR API.
 *
 * `path` is optional both because the SDK reports it as nullable and because
 * pre-#495 call sites carried this shape without it. Newer callers populate
 * `path` so the root-folder filter (see filterToRootFolderDisks) can decide
 * which disks belong in the media rollup. Treat `path` as sensitive text on
 * the wire — the frontend should anonymize it under incognito mode.
 */
interface DiskSpaceEntry {
	path?: string | null;
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
 * carried per-instance and later de-duplicated in `combineDiskStats`.
 *
 * `path` is preserved on the wire so the #495 root-folder filter can decide
 * which disks hold media. Raw mount paths do leak the operator's layout in
 * principle — the dashboard mitigates this on the frontend by passing `path`
 * through `useIncognitoMode()`-aware anonymization before render, matching the
 * pattern used for instance names and titles. Pre-#495 the path was dropped
 * here to avoid that wire-side leak; the trade-off shifted with the breakdown
 * UI, which needs to show users what's being included vs excluded by path.
 */
export const toDiskMounts = <T extends DiskSpaceEntry>(
	diskspace: T[],
): Array<{ path?: string; totalSpace: number; freeSpace: number }> =>
	diskspace.map((entry) => ({
		path: entry?.path ?? undefined,
		totalSpace: entry?.totalSpace ?? 0,
		freeSpace: entry?.freeSpace ?? 0,
	}));

/**
 * One disk-bearing instance's contribution to the combined disk total.
 *
 * `rootFolderPaths` and `instanceName` are optional and additive (issue #495):
 *   - When `rootFolderPaths` is provided, the contributor's disk entries are
 *     filtered to those holding media (see filterToRootFolderDisks). When
 *     absent or empty, the filter degrades to "keep everything" — preserving
 *     pre-#495 behavior for callers that don't supply root-folder context.
 *   - `instanceName` is plumbed through the breakdown so the UI can attribute
 *     each disk row to its source instance. Sensitive text — anonymize under
 *     incognito mode on the frontend.
 */
export interface DiskContributor {
	storageGroupId?: string | null;
	diskEntries: DiskSpaceEntry[];
	rootFolderPaths?: readonly string[];
	instanceName?: string;
}

/**
 * Why a disk did or didn't make it into the rollup. Drives the UI breakdown
 * panel's per-row reason text.
 *   - `"media"`           — included; holds at least one configured *arr root folder
 *   - `"no-matching-root-folder"` — excluded; no root folder lives on this disk
 *   - `"deduplicated"`    — excluded; another contributor already accounted for
 *                           this disk (via storage-group or fingerprint)
 */
export type DiskFilterReason = "media" | "no-matching-root-folder" | "deduplicated";

/**
 * Per-disk row used by the breakdown UI to explain how the rollup was computed.
 *
 * `path` is sensitive text — frontend renderers must use `useIncognitoMode()`
 * to anonymize it. The wire payload carries it unredacted so a) the breakdown
 * remains legible when incognito is off, b) the dashboard can compute aggregate
 * facts without depending on per-request privacy flags.
 */
export interface DiskBreakdownEntry {
	path?: string;
	totalSpace: number;
	freeSpace: number;
	includedInRollup: boolean;
	reason: DiskFilterReason;
	instanceName?: string;
}

/**
 * Combined disk totals plus transparency counts and the per-disk breakdown
 * the UI uses for its "Show all disks" expansion.
 */
export interface CombinedDiskTotals extends DiskTotals {
	diskCount: number;
	instanceCount: number;
	disks: DiskBreakdownEntry[];
}

/**
 * Normalize a mount path for prefix comparison: trim whitespace, convert
 * Windows backslashes to forward slashes (so `C:\Media\TV` and UNC
 * `\\server\share` compare uniformly with Unix paths — *arrs running
 * natively on Windows report `\`-separated paths from both diskspace and
 * rootfolder endpoints), then drop the trailing "/" except when the entire
 * path is "/" (which stays). Keeps "/data" and "/data/" identical without
 * collapsing the root, and turns `C:\` into `C:`.
 *
 * Casing is deliberately NOT folded: disk paths and root-folder paths for a
 * given contributor come from the same *arr instance, so their casing is
 * internally consistent — and folding would corrupt comparisons on
 * case-sensitive Linux filesystems.
 */
const normalizePath = (raw: string): string => {
	const trimmed = raw.trim().replace(/\\/g, "/");
	if (trimmed === "" || trimmed === "/") return trimmed;
	return trimmed.endsWith("/") ? trimmed.slice(0, -1) : trimmed;
};

/**
 * True when `diskPath` is a path-segment prefix of `rfPath` (or equal). This
 * is what makes "/data" match "/data/tv" but not "/dataother" — the next char
 * after the prefix has to be "/" or end-of-string. Windows paths arrive here
 * already slash-normalized (see normalizePath), so `C:` is a valid
 * path-segment prefix of `C:/Media/TV`.
 *
 * Both paths must already be normalized via `normalizePath`.
 */
const isPathPrefix = (rfPath: string, diskPath: string): boolean => {
	if (diskPath === rfPath) return true;
	if (diskPath === "/") return rfPath.startsWith("/");
	if (!rfPath.startsWith(diskPath)) return false;
	return rfPath.charAt(diskPath.length) === "/";
};

/**
 * Partition a contributor's disk entries into ones holding media (kept) and
 * ones that don't (excluded) using the **longest matching prefix wins** rule:
 *
 *   For each root folder, pick the disk whose normalized path is the longest
 *   prefix of the root folder's path. That disk is "kept"; everything else is
 *   "excluded". When more than one root folder lives on the same disk, that
 *   disk is kept once.
 *
 * Why "longest prefix wins"? It mirrors how `df` resolves a file to its mount
 * point and is shape-agnostic across containerized vs bare-metal deployments:
 *   - Containerized Sonarr with disks `/` and `/data` + root folder `/data/tv`
 *     → `/data` wins (longer prefix), `/` is excluded.
 *   - Bare-metal Sonarr with disk `/` only + root folder `/home/user/Media`
 *     → `/` wins (only candidate), kept.
 *
 * **Fallback when no root folders are supplied** (`rootFolderPaths` undefined,
 * null, or empty after trimming): degrade to current pre-#495 behavior — keep
 * everything as `"media"`. This means a misconfigured *arr (no root folders
 * yet) doesn't suddenly report 0 disks.
 */
export const filterToRootFolderDisks = (
	diskEntries: DiskSpaceEntry[],
	rootFolderPaths: readonly string[] | undefined,
): { included: DiskSpaceEntry[]; excluded: DiskSpaceEntry[] } => {
	const validRootFolderPaths = (rootFolderPaths ?? [])
		.map(normalizePath)
		.filter((p) => p.length > 0);

	if (validRootFolderPaths.length === 0) {
		return { included: [...diskEntries], excluded: [] };
	}

	const normalizedDiskPaths = diskEntries.map((entry) => normalizePath(entry.path ?? ""));
	const keptIndexes = new Set<number>();

	for (const rfPath of validRootFolderPaths) {
		let bestIdx = -1;
		let bestLen = -1;
		for (let i = 0; i < normalizedDiskPaths.length; i++) {
			const diskPath = normalizedDiskPaths[i];
			if (!diskPath) continue;
			if (isPathPrefix(rfPath, diskPath) && diskPath.length > bestLen) {
				bestIdx = i;
				bestLen = diskPath.length;
			}
		}
		if (bestIdx >= 0) keptIndexes.add(bestIdx);
	}

	const included: DiskSpaceEntry[] = [];
	const excluded: DiskSpaceEntry[] = [];
	diskEntries.forEach((entry, i) => {
		if (keptIndexes.has(i)) included.push(entry);
		else excluded.push(entry);
	});
	return { included, excluded };
};

/**
 * Combines disk stats across instances while avoiding the classic
 * "one physical array, many *arr instances" over-count, and (issue #495)
 * filtering out non-media disks (container `/`, config volumes, etc.) when
 * each contributor supplies its configured root folders.
 *
 * Pipeline per contributor (order matters):
 *   1. Storage-group dedup — if the operator declared `storageGroupId` and we
 *      already saw it on a prior contributor, mark every disk as
 *      `"deduplicated"` and skip the rest. (Existing PR #490 behavior.)
 *   2. Root-folder filter — partition into media/non-media via
 *      `filterToRootFolderDisks`. Non-media entries are recorded as
 *      `"no-matching-root-folder"`.
 *   3. Fingerprint dedup — for each surviving media entry, check
 *      `${totalSpace}:${freeSpace}` against `seenDisks`. Duplicates are
 *      recorded as `"deduplicated"`; first-sightings are summed into the
 *      rollup and marked `"media"`.
 *
 * The `disks` array in the return value carries every entry observed (in
 * encounter order across contributors) with its final include-reason — that
 * powers the UI's "Show all disks" breakdown without the frontend having to
 * re-derive the decision.
 *
 * `instanceCount` counts every instance that reports storage, regardless of
 * whether its disks were de-duplicated or filtered away — the UI can honestly
 * say "N disks across M instances" including for operators who configured
 * storage groups (the good-citizen path must not read as fewer instances than
 * the un-configured one).
 */
export const combineDiskStats = (contributors: DiskContributor[]): CombinedDiskTotals => {
	const seenGroups = new Set<string>();
	const seenDisks = new Set<string>();
	let total = 0;
	let free = 0;
	let diskCount = 0;
	let instanceCount = 0;
	const disks: DiskBreakdownEntry[] = [];

	const recordEntry = (
		entry: DiskSpaceEntry,
		includedInRollup: boolean,
		reason: DiskFilterReason,
		instanceName: string | undefined,
	): void => {
		disks.push({
			path: entry.path ?? undefined,
			totalSpace: entry.totalSpace ?? 0,
			freeSpace: entry.freeSpace ?? 0,
			includedInRollup,
			reason,
			instanceName,
		});
	};

	for (const contributor of contributors) {
		const usableEntries = (contributor.diskEntries ?? []).filter(
			(entry) => (entry?.totalSpace ?? 0) > 0,
		);
		if (usableEntries.length > 0) instanceCount += 1;

		const group = contributor.storageGroupId?.trim();
		const groupDuplicate = group ? seenGroups.has(group) : false;
		if (group && !groupDuplicate) seenGroups.add(group);

		if (groupDuplicate) {
			// Whole contributor is a known duplicate by operator declaration —
			// record every entry as `"deduplicated"` and move on. Don't bother
			// running the root-folder filter since the operator already told us
			// these instances share storage.
			for (const entry of usableEntries) {
				recordEntry(entry, false, "deduplicated", contributor.instanceName);
			}
			continue;
		}

		const { included: mediaEntries, excluded: nonMediaEntries } = filterToRootFolderDisks(
			usableEntries,
			contributor.rootFolderPaths,
		);

		for (const entry of nonMediaEntries) {
			recordEntry(entry, false, "no-matching-root-folder", contributor.instanceName);
		}

		for (const entry of mediaEntries) {
			const entryTotal = entry.totalSpace ?? 0;
			const entryFree = entry.freeSpace ?? 0;
			const key = `${entryTotal}:${entryFree}`;
			const fingerprintDuplicate = seenDisks.has(key);

			if (!fingerprintDuplicate) {
				seenDisks.add(key);
				total += entryTotal;
				free += entryFree;
				diskCount += 1;
			}
			recordEntry(
				entry,
				!fingerprintDuplicate,
				fingerprintDuplicate ? "deduplicated" : "media",
				contributor.instanceName,
			);
		}
	}

	const used = Math.max(0, total - free);
	const usagePercent = total > 0 ? clampPercentage((used / total) * 100) : 0;

	return { total, free, used, usagePercent, diskCount, instanceCount, disks };
};

/**
 * Minimal per-instance shape needed to compute combined disk stats.
 * Structurally compatible with the route's per-service instance arrays.
 *
 * `data.rootFolderPaths` and `instanceName` are optional and additive (#495):
 * when present, they're plumbed through `buildCombinedDiskPayload` into the
 * underlying `DiskContributor` so the root-folder filter has the signal it
 * needs and the breakdown can attribute each disk row to its source instance.
 */
export interface DiskBearingInstance {
	storageGroupId?: string | null;
	instanceName?: string;
	data: { diskEntries?: DiskSpaceEntry[]; rootFolderPaths?: readonly string[] };
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
 *
 * The four legacy `disk*` fields reflect the **filtered** rollup (post-#495):
 * they sum only disks that hold *arr root folders (when root folders are
 * configured) and have passed the storage-group / fingerprint dedup. The
 * `disks` array carries the per-disk breakdown for the UI's "Show all disks"
 * expansion — including disks that were excluded from the rollup, with a
 * machine-readable reason.
 */
export interface CombinedDiskPayload {
	diskTotal: number;
	diskFree: number;
	diskUsed: number;
	diskUsagePercent: number;
	diskCount: number;
	instanceCount: number;
	disks: DiskBreakdownEntry[];
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
		rootFolderPaths: entry.data.rootFolderPaths,
		instanceName: entry.instanceName,
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
		disks: combined.disks,
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
