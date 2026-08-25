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
	/** Positive-only episode evidence is a lower bound, not an exact count. */
	lowerBound?: number;
	positiveProof?: {
		connectionGeneration: number;
		identityGeneration: number;
		parentGenerationId: string;
		parentPublicationLevel: "positive-only";
		parentTargetDigest: string;
		soleParentTargetFingerprint: string;
		episodeGenerationId: string;
		episodeDigest: string;
		showTmdbId: number;
		observedLowerBound: number;
		observedAt: Date;
		operator?: "greater_than";
		threshold?: number;
		ruleId?: string;
		ruleFingerprint?: string;
	};
	lastWatchedAt: Date | null;
	watchedByUsers: string[];
	refreshedAt: Date;
}

/**
 * Immutable identity carried from preview through approval and execution.
 *
 * `episodeFileConsumerIds` is part of the target rather than an incidental
 * lookup: a file consumed by more than one Sonarr episode is not an exact
 * episode deletion unit and must fail closed before a write is attempted.
 */
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
	scanMediaServerAfterDelete?: boolean;
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
 * Initial episode scope intentionally supports only a simple Plex watch-count
 * cleanup rule. Preview and explanation both use this predicate so unsupported
 * stored rule shapes cannot be represented as executable.
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
		Number.isFinite(params.count) &&
		params.count >= 0
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
			...(evidence.positiveProof ? { positiveProof: { ...evidence.positiveProof } } : {}),
			watchedByUsers: [...evidence.watchedByUsers],
		})),
		fileInfoHash: candidate.file.infoHash,
		fileTorrentState: candidate.file.torrentState,
		respectQuiSeeding: candidate.respectQuiSeeding,
	};
}

/**
 * A stable identity for deduplication, approval compare-and-set, and retries.
 * The series id remains present to prevent accidental cross-series collisions,
 * while the Sonarr episode id makes sibling episodes independent targets.
 */
export function buildEpisodeTargetKey(
	target: Pick<EpisodeCleanupCandidate, "instanceId" | "arrSeriesId" | "arrEpisodeId">,
): string {
	return `${target.instanceId}:series:${target.arrSeriesId}:episode:${target.arrEpisodeId}`;
}

export function evaluateEpisodeWatchCountRule(
	candidate: Pick<EpisodeCleanupCandidate, "watchCount"> &
		Partial<Pick<EpisodeCleanupCandidate, "plexWatchEvidence">>,
	rule: EpisodeWatchCountRule,
): RuleMatch | null {
	const params = safeJsonParse(rule.parameters) as PlexWatchCountParameters | null;
	if (
		params?.operator !== "greater_than" ||
		typeof params.count !== "number" ||
		!Number.isFinite(params.count) ||
		params.count < 0 ||
		(candidate.plexWatchEvidence !== undefined && candidate.plexWatchEvidence.length === 0)
	) {
		return null;
	}
	const threshold = params.count;
	const lowerBound = candidate.plexWatchEvidence
		?.map((evidence) => evidence.lowerBound)
		.filter(
			(value): value is number =>
				typeof value === "number" && Number.isSafeInteger(value) && value > 0,
		)
		.find((value) => value > threshold);
	const count = lowerBound ?? candidate.watchCount;
	if (count <= threshold) return null;

	if (rule.action !== "delete" && rule.action !== "delete_files" && rule.action !== "unmonitor") {
		return null;
	}
	const action = rule.action as RuleAction;
	return {
		ruleId: rule.id,
		ruleName: rule.name,
		reason: `Plex watch count ${count} > ${threshold}`,
		action,
		...(rule.scanMediaServerAfterDelete === true ? { scanMediaServerAfterDelete: true } : {}),
	};
}
