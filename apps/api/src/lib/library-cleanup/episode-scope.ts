import { safeJsonParse } from "../utils/json.js";
import type { RuleAction, RuleMatch } from "./types.js";

export interface EpisodeCleanupFile {
	arrEpisodeFileId: number;
	path: string;
	size: bigint;
	infoHash: string | null;
	torrentState: string | null;
}

export interface EpisodePlexWatchEvidence {
	plexInstanceId: string;
	sourceFingerprint: string;
	ratingKey: string;
	watchCount: number;
	lastWatchedAt: Date | null;
	watchedByUsers: string[];
	refreshedAt: Date;
}

/** Immutable episode/file identity retained from preview through approval. */
export interface EpisodeCleanupCandidate {
	instanceId: string;
	arrSeriesId: number;
	arrEpisodeId: number;
	seasonNumber: number;
	episodeNumber: number;
	episodeFileId: number;
	episodeFileConsumerIds: number[];
	seriesTitle: string;
	episodeTitle: string;
	monitored: boolean;
	respectQuiSeeding: boolean;
	watchCount: number;
	lastWatchedAt: Date | null;
	watchedByUsers: string[];
	plexWatchEvidence: EpisodePlexWatchEvidence[];
	file: EpisodeCleanupFile;
}

export interface EpisodeTargetMetadata {
	targetScope: "episode";
	arrEpisodeId: number;
	seasonNumber: number;
	episodeNumber: number;
	episodeFileId: number;
	episodeFileConsumerIds: number[];
	seriesTitle: string;
	episodeTitle: string;
	plexWatchEvidence: EpisodePlexWatchEvidence[];
	fileInfoHash: string | null;
	fileTorrentState: string | null;
	respectQuiSeeding: boolean;
}

interface EpisodeWatchCountRule {
	id: string;
	name: string;
	parameters: string;
	action: string | null;
}

interface PlexWatchCountParameters {
	operator?: unknown;
	count?: unknown;
}

interface EpisodeCleanupRuleShape extends EpisodeWatchCountRule {
	enabled: boolean;
	targetScope: string;
	retentionMode: boolean;
	ruleType: string;
	operator: string | null;
	conditions: string | null;
	plexLibraryFilter: string | null;
}

/**
 * Episode scope deliberately supports only simple Sonarr Plex watch-count
 * cleanup rules. Unsupported persisted shapes are never candidates.
 */
export function isSupportedEpisodeCleanupRule(rule: EpisodeCleanupRuleShape): boolean {
	const storedConditions = safeJsonParse(rule.conditions) as unknown;
	const storedPlexLibraryFilter = safeJsonParse(rule.plexLibraryFilter) as unknown;
	if (
		!rule.enabled ||
		rule.targetScope !== "episode" ||
		rule.retentionMode ||
		(rule.action !== "delete" && rule.action !== "delete_files" && rule.action !== "unmonitor") ||
		rule.ruleType !== "plex_watch_count" ||
		rule.operator !== null ||
		(rule.conditions !== null &&
			(!Array.isArray(storedConditions) || storedConditions.length > 0)) ||
		(rule.plexLibraryFilter !== null &&
			(!Array.isArray(storedPlexLibraryFilter) || storedPlexLibraryFilter.length > 0))
	) {
		return false;
	}
	const params = safeJsonParse(rule.parameters) as PlexWatchCountParameters | null;
	return (
		params?.operator === "greater_than" &&
		typeof params.count === "number" &&
		Number.isFinite(params.count)
	);
}

export function toEpisodeTargetMetadata(candidate: EpisodeCleanupCandidate): EpisodeTargetMetadata {
	return {
		targetScope: "episode",
		arrEpisodeId: candidate.arrEpisodeId,
		seasonNumber: candidate.seasonNumber,
		episodeNumber: candidate.episodeNumber,
		episodeFileId: candidate.episodeFileId,
		episodeFileConsumerIds: [...candidate.episodeFileConsumerIds],
		seriesTitle: candidate.seriesTitle,
		episodeTitle: candidate.episodeTitle,
		plexWatchEvidence: candidate.plexWatchEvidence.map((evidence) => ({
			...evidence,
			watchedByUsers: [...evidence.watchedByUsers],
		})),
		fileInfoHash: candidate.file.infoHash,
		fileTorrentState: candidate.file.torrentState,
		respectQuiSeeding: candidate.respectQuiSeeding,
	};
}

/** Stable target identity keeps sibling Sonarr episodes independent. */
export function buildEpisodeTargetKey(
	target: Pick<EpisodeCleanupCandidate, "instanceId" | "arrSeriesId" | "arrEpisodeId">,
): string {
	return `${target.instanceId}:series:${target.arrSeriesId}:episode:${target.arrEpisodeId}`;
}

export function evaluateEpisodeWatchCountRule(
	candidate: Pick<EpisodeCleanupCandidate, "watchCount">,
	rule: EpisodeWatchCountRule,
): RuleMatch | null {
	const params = safeJsonParse(rule.parameters) as PlexWatchCountParameters | null;
	if (
		params?.operator !== "greater_than" ||
		typeof params.count !== "number" ||
		!Number.isFinite(params.count) ||
		candidate.watchCount <= params.count ||
		(rule.action !== "delete" && rule.action !== "delete_files" && rule.action !== "unmonitor")
	) {
		return null;
	}
	return {
		ruleId: rule.id,
		ruleName: rule.name,
		reason: `Plex watch count ${candidate.watchCount} > ${params.count}`,
		action: rule.action as RuleAction,
	};
}
