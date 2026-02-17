/**
 * Hunt filter system.
 *
 * Parses HuntConfig into structured filters and evaluates
 * media items against them. Supports hierarchical status expansion
 * (e.g., selecting "announced" in Radarr includes "inCinemas" + "released"),
 * AND/OR filter logic, and include/exclude for tags and quality profiles.
 */

import type { HuntConfig } from "../prisma.js";
import type { FastifyBaseLogger } from "fastify";

/**
 * Logger type for hunt functions.
 * Uses Fastify's base logger for structured logging.
 */
export type HuntLogger = FastifyBaseLogger;

/** Hunt service types */
export type HuntService = "sonarr" | "radarr" | "lidarr" | "readarr";

/** Filter configuration parsed from HuntConfig */
export interface ParsedFilters {
	filterLogic: "AND" | "OR";
	monitoredOnly: boolean;
	includeTags: number[];
	excludeTags: number[];
	includeQualityProfiles: number[];
	excludeQualityProfiles: number[];
	includeStatuses: string[];
	expandedStatuses: Set<string>; // Pre-expanded for hierarchical matching
	yearMin: number | null;
	yearMax: number | null;
	ageThresholdDays: number | null;
}

/**
 * Radarr status hierarchy for filtering.
 * Selecting a status includes all statuses further in the release pipeline.
 * Order: tba → announced → inCinemas → released
 */
const RADARR_STATUS_HIERARCHY: Record<string, string[]> = {
	tba: ["tba", "announced", "inCinemas", "released"],
	announced: ["announced", "inCinemas", "released"],
	inCinemas: ["inCinemas", "released"],
	released: ["released"],
};

/**
 * Sonarr status hierarchy for filtering.
 * Selecting a status includes all statuses further in the lifecycle.
 * Order: upcoming → continuing → ended
 */
const SONARR_STATUS_HIERARCHY: Record<string, string[]> = {
	upcoming: ["upcoming", "continuing", "ended"],
	continuing: ["continuing", "ended"],
	ended: ["ended"],
};

/**
 * Lidarr/Readarr status hierarchy for filtering.
 * Artists and authors use: continuing → ended
 */
const LIDARR_STATUS_HIERARCHY: Record<string, string[]> = {
	continuing: ["continuing", "ended"],
	ended: ["ended"],
};

/** Maps each service to its status hierarchy for filter expansion */
const STATUS_HIERARCHY_MAP: Record<HuntService, Record<string, string[]>> = {
	sonarr: SONARR_STATUS_HIERARCHY,
	radarr: RADARR_STATUS_HIERARCHY,
	lidarr: LIDARR_STATUS_HIERARCHY,
	readarr: LIDARR_STATUS_HIERARCHY,
};

/**
 * Expand a list of status keys to include lifecycle-related statuses for the specified service.
 *
 * Unknown statuses are preserved (converted to lowercase) so they can still be matched.
 *
 * @param statuses - Status keys selected by the user
 * @param service - The service type which determines the expansion hierarchy
 * @returns A `Set` of lowercased statuses containing the original statuses and any hierarchically related statuses
 */
export function expandStatusFilters(statuses: string[], service: HuntService): Set<string> {
	const hierarchy = STATUS_HIERARCHY_MAP[service];
	const expanded = new Set<string>();

	for (const status of statuses) {
		const related = hierarchy[status.toLowerCase()];
		if (related) {
			for (const s of related) {
				expanded.add(s);
			}
		} else {
			// Unknown status, include as-is
			expanded.add(status.toLowerCase());
		}
	}

	return expanded;
}

/**
 * Create a ParsedFilters object from a HuntConfig by parsing JSON-encoded arrays
 * and expanding statuses for the target service.
 *
 * @param config - Hunt configuration containing raw filter values
 * @param service - Target service used to expand statuses
 * @param logger - Fastify logger for structured logging
 * @returns A ParsedFilters object with parsed filter arrays and expanded statuses
 */
export function parseFilters(
	config: HuntConfig,
	service: HuntService,
	logger: HuntLogger,
): ParsedFilters {
	const parseJsonArray = (
		value: string | null | undefined,
		fieldName: string,
	): number[] | string[] => {
		if (!value) return [];
		try {
			return JSON.parse(value);
		} catch (error) {
			logger.warn(
				{ err: error, field: fieldName, value, configId: config.id },
				"Failed to parse hunt filter JSON - filter will be ignored",
			);
			return [];
		}
	};

	const includeStatuses = parseJsonArray(config.includeStatuses, "includeStatuses") as string[];

	return {
		filterLogic: (config.filterLogic as "AND" | "OR") || "AND",
		monitoredOnly: config.monitoredOnly ?? true,
		includeTags: parseJsonArray(config.includeTags, "includeTags") as number[],
		excludeTags: parseJsonArray(config.excludeTags, "excludeTags") as number[],
		includeQualityProfiles: parseJsonArray(
			config.includeQualityProfiles,
			"includeQualityProfiles",
		) as number[],
		excludeQualityProfiles: parseJsonArray(
			config.excludeQualityProfiles,
			"excludeQualityProfiles",
		) as number[],
		includeStatuses,
		expandedStatuses: expandStatusFilters(includeStatuses, service),
		yearMin: config.yearMin,
		yearMax: config.yearMax,
		ageThresholdDays: config.ageThresholdDays,
	};
}

/**
 * Evaluate whether a single filter condition is satisfied for a candidate item.
 *
 * @param item - Candidate item's relevant fields
 * @param filters - ParsedFilters containing the filter criteria
 * @param conditionName - The filter condition to check
 * @returns `true` if the item satisfies the specified condition
 */
export function checkFilterCondition(
	item: {
		tags: number[];
		qualityProfileId: number;
		status: string;
		year: number;
		monitored: boolean;
		releaseDate?: string;
	},
	filters: ParsedFilters,
	conditionName: string,
): boolean {
	switch (conditionName) {
		case "monitored":
			return !filters.monitoredOnly || item.monitored;

		case "includeTags":
			if (filters.includeTags.length === 0) return true;
			return filters.includeTags.some((tagId) => item.tags.includes(tagId));

		case "excludeTags":
			if (filters.excludeTags.length === 0) return true;
			return !filters.excludeTags.some((tagId) => item.tags.includes(tagId));

		case "includeQualityProfiles":
			if (filters.includeQualityProfiles.length === 0) return true;
			return filters.includeQualityProfiles.includes(item.qualityProfileId);

		case "excludeQualityProfiles":
			if (filters.excludeQualityProfiles.length === 0) return true;
			return !filters.excludeQualityProfiles.includes(item.qualityProfileId);

		case "includeStatuses":
			if (filters.includeStatuses.length === 0) return true;
			// Use expanded statuses for hierarchical matching
			return filters.expandedStatuses.has(item.status.toLowerCase());

		case "yearMin":
			if (filters.yearMin === null) return true;
			return item.year >= filters.yearMin;

		case "yearMax":
			if (filters.yearMax === null) return true;
			return item.year <= filters.yearMax;

		case "ageThreshold": {
			if (filters.ageThresholdDays === null || !item.releaseDate) return true;
			const releaseDate = new Date(item.releaseDate);
			const thresholdDate = new Date();
			thresholdDate.setDate(thresholdDate.getDate() - filters.ageThresholdDays);
			return releaseDate <= thresholdDate; // Only hunt content older than threshold
		}

		default:
			return true;
	}
}

/**
 * Determine whether a media item satisfies the provided filters.
 *
 * @param item - Metadata for the media item
 * @param filters - ParsedFilters that define inclusion/exclusion criteria
 * @returns `true` if the item passes the filters and is not excluded
 */
export function passesFilters(
	item: {
		tags: number[];
		qualityProfileId: number;
		status: string;
		year: number;
		monitored: boolean;
		releaseDate?: string;
	},
	filters: ParsedFilters,
): boolean {
	// Exclude conditions always use AND logic (they're blockers)
	const excludeResults = [
		checkFilterCondition(item, filters, "excludeTags"),
		checkFilterCondition(item, filters, "excludeQualityProfiles"),
	];

	if (!excludeResults.every((r) => r)) {
		return false; // Excluded items are always filtered out
	}

	// For include filters, apply the selected logic
	const includeConditions = [
		"monitored",
		"includeTags",
		"includeQualityProfiles",
		"includeStatuses",
		"yearMin",
		"yearMax",
		"ageThreshold",
	];

	const includeResults = includeConditions.map((condition) =>
		checkFilterCondition(item, filters, condition),
	);

	if (filters.filterLogic === "OR") {
		// At least one condition must pass (but skip conditions that have no filter set)
		const activeConditions = includeConditions.filter((condition) => {
			switch (condition) {
				case "monitored":
					return filters.monitoredOnly;
				case "includeTags":
					return filters.includeTags.length > 0;
				case "includeQualityProfiles":
					return filters.includeQualityProfiles.length > 0;
				case "includeStatuses":
					return filters.includeStatuses.length > 0;
				case "yearMin":
					return filters.yearMin !== null;
				case "yearMax":
					return filters.yearMax !== null;
				case "ageThreshold":
					return filters.ageThresholdDays !== null;
				default:
					return false;
			}
		});

		if (activeConditions.length === 0) return true; // No active filters
		return activeConditions.some((condition) => checkFilterCondition(item, filters, condition));
	}

	// AND logic: all conditions must pass
	return includeResults.every((r) => r);
}
