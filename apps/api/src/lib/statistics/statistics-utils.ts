/**
 * Statistics Utility Functions
 *
 * Shared utilities for processing statistics across all ARR services.
 * These functions extract common patterns from service-specific fetch/aggregate functions.
 */

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
 * Sums an array of numbers, filtering out undefined and non-finite values
 */
export const sumNumbers = (values: Array<number | undefined>): number => {
	let total = 0;
	for (const value of values) {
		if (typeof value === "number" && Number.isFinite(value)) {
			total += value;
		}
	}
	return total;
};

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

/**
 * Safely converts an unknown value to a trimmed string
 */
export const toStringValue = (value: unknown): string | undefined => {
	if (typeof value === "string") {
		const trimmed = value.trim();
		return trimmed.length > 0 ? trimmed : undefined;
	}
	if (typeof value === "number" && Number.isFinite(value)) {
		return value.toString();
	}
	return undefined;
};

// ============================================================================
// Safe Request Utilities
// ============================================================================

/**
 * Safely makes a request and parses JSON, returning undefined on error
 */
export const safeRequestJson = async <T>(
	fetcher: (path: string, init?: RequestInit) => Promise<Response>,
	path: string,
	init?: RequestInit,
): Promise<T | undefined> => {
	try {
		const response = await fetcher(path, init);
		return (await response.json()) as T;
	} catch {
		return undefined;
	}
};

/**
 * Safely execute an SDK call and return undefined on error
 */
export const safeRequest = async <T>(operation: () => Promise<T>): Promise<T | undefined> => {
	try {
		return await operation();
	} catch {
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
			acc.total += (entry?.totalSpace ?? 0);
			acc.free += (entry?.freeSpace ?? 0);
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
export const createBaseAggregator = <T extends HealthIssue>() => ({
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
 * Accumulates common fields during aggregation
 */
export const accumulateCommonFields = <TData extends {
	diskTotal?: number;
	diskFree?: number;
	diskUsed?: number;
	healthIssues?: number;
	healthIssuesList?: HealthIssue[];
	qualityBreakdown?: Record<string, number>;
	tagBreakdown?: Record<string, number>;
	recentlyAdded7Days?: number;
	recentlyAdded30Days?: number;
	cutoffUnmetCount?: number;
}>(
	acc: ReturnType<typeof createBaseAggregator>,
	data: TData,
	shouldCountDisk: boolean,
): void => {
	if (shouldCountDisk) {
		acc.diskTotal += data.diskTotal ?? 0;
		acc.diskFree += data.diskFree ?? 0;
		acc.diskUsed += data.diskUsed ?? 0;
	}

	acc.healthIssues += data.healthIssues ?? 0;
	if (data.healthIssuesList) {
		acc.healthIssuesList.push(...data.healthIssuesList);
	}

	acc.recentlyAdded7Days += data.recentlyAdded7Days ?? 0;
	acc.recentlyAdded30Days += data.recentlyAdded30Days ?? 0;
	acc.cutoffUnmetCount += data.cutoffUnmetCount ?? 0;

	mergeBreakdown(data.qualityBreakdown, acc.qualityBreakdown);
	mergeBreakdown(data.tagBreakdown, acc.tagBreakdown);
};

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
