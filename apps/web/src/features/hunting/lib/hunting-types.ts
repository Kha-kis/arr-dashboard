/**
 * Hunting feature types
 */

export interface HuntingStatus {
	schedulerRunning: boolean;
	instances: InstanceHuntStatus[];
	recentActivityCount: number;
}

export interface InstanceHuntStatus {
	instanceId: string;
	instanceName: string;
	service: "sonarr" | "radarr";
	huntMissingEnabled: boolean;
	huntUpgradesEnabled: boolean;
	lastMissingHunt: string | null;
	lastUpgradeHunt: string | null;
	searchesToday: number;
	itemsFoundToday: number;
	apiCallsThisHour: number;
	hourlyApiCap: number;
}

export interface HuntConfig {
	id: string;
	instanceId: string;
	// Feature toggles
	huntMissingEnabled: boolean;
	huntUpgradesEnabled: boolean;
	// Batch settings
	missingBatchSize: number;
	missingIntervalMins: number;
	upgradeBatchSize: number;
	upgradeIntervalMins: number;
	// Rate limiting
	hourlyApiCap: number;
	queueThreshold: number;
	// Filter settings
	filterLogic: "AND" | "OR";
	monitoredOnly: boolean;
	includeTags: string | null; // JSON array
	excludeTags: string | null;
	includeQualityProfiles: string | null;
	excludeQualityProfiles: string | null;
	includeStatuses: string | null;
	yearMin: number | null;
	yearMax: number | null;
	ageThresholdDays: number | null;
	// Season pack preference (Sonarr only)
	preferSeasonPacks: boolean;
	// Re-search settings
	researchAfterDays: number;
	// State tracking
	lastMissingHunt: string | null;
	lastUpgradeHunt: string | null;
	apiCallsThisHour: number;
	apiCallsResetAt: string | null;
	createdAt: string;
	updatedAt: string;
}

export interface HuntConfigWithInstance extends HuntConfig {
	instanceName: string;
	service: "sonarr" | "radarr";
}

export interface HuntConfigUpdate {
	// Feature toggles
	huntMissingEnabled?: boolean;
	huntUpgradesEnabled?: boolean;
	// Batch settings
	missingBatchSize?: number;
	missingIntervalMins?: number;
	upgradeBatchSize?: number;
	upgradeIntervalMins?: number;
	// Rate limiting
	hourlyApiCap?: number;
	queueThreshold?: number;
	// Filter settings
	filterLogic?: "AND" | "OR";
	monitoredOnly?: boolean;
	includeTags?: string | null;
	excludeTags?: string | null;
	includeQualityProfiles?: string | null;
	excludeQualityProfiles?: string | null;
	includeStatuses?: string | null;
	yearMin?: number | null;
	yearMax?: number | null;
	ageThresholdDays?: number | null;
	// Season pack preference (Sonarr only)
	preferSeasonPacks?: boolean;
	// Re-search settings
	researchAfterDays?: number;
}

export interface GrabbedItem {
	title: string;
	quality?: string;
	indexer?: string;
	size?: number;
}

export interface HuntLog {
	id: string;
	instanceId: string;
	instanceName: string;
	service: "sonarr" | "radarr";
	huntType: "missing" | "upgrade";
	itemsSearched: number;
	itemsGrabbed: number;
	searchedItems: string[] | null;
	grabbedItems: GrabbedItem[] | null;
	status: "running" | "completed" | "partial" | "skipped" | "error";
	message: string | null;
	durationMs: number | null;
	startedAt: string;
	completedAt: string | null;
}

export interface InstanceSummary {
	id: string;
	label: string;
	service: "sonarr" | "radarr";
}

// Filter options fetched from instances
export interface FilterTag {
	id: number;
	label: string;
}

export interface FilterQualityProfile {
	id: number;
	name: string;
}

export interface FilterStatus {
	value: string;
	label: string;
}

export interface FilterOptions {
	service: "sonarr" | "radarr";
	tags: FilterTag[];
	qualityProfiles: FilterQualityProfile[];
	statuses: FilterStatus[];
}
