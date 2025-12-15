/**
 * Hunting feature types
 */

export interface HuntingStatus {
	schedulerRunning: boolean;
	instances: InstanceHuntStatus[];
	recentActivityCount: number;
	totalExclusions: number;
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
	huntMissingEnabled: boolean;
	huntUpgradesEnabled: boolean;
	missingBatchSize: number;
	missingIntervalMins: number;
	upgradeBatchSize: number;
	upgradeIntervalMins: number;
	hourlyApiCap: number;
	queueThreshold: number;
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
	huntMissingEnabled?: boolean;
	huntUpgradesEnabled?: boolean;
	missingBatchSize?: number;
	missingIntervalMins?: number;
	upgradeBatchSize?: number;
	upgradeIntervalMins?: number;
	hourlyApiCap?: number;
	queueThreshold?: number;
}

export interface HuntLog {
	id: string;
	instanceId: string;
	instanceName: string;
	service: "sonarr" | "radarr";
	huntType: "missing" | "upgrade";
	itemsSearched: number;
	itemsFound: number;
	searchedItems: string[] | null;
	foundItems: string[] | null;
	status: "completed" | "partial" | "skipped" | "error";
	message: string | null;
	durationMs: number | null;
	startedAt: string;
	completedAt: string | null;
}

export interface HuntExclusion {
	id: string;
	configId: string;
	instanceName: string;
	service: "sonarr" | "radarr";
	mediaType: "series" | "movie";
	mediaId: number;
	title: string;
	reason: string | null;
	createdAt: string;
}

export interface InstanceSummary {
	id: string;
	label: string;
	service: "sonarr" | "radarr";
}
