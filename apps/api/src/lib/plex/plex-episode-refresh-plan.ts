import { createHash } from "node:crypto";
import type { PlexPositiveEpisodeParentTarget } from "./plex-episode-live-collector.js";

export const PLEX_EPISODE_PARENT_COPIES_PER_UNIT = 50;

export interface PlannedPlexEpisodeUnit {
	ordinal: number;
	scopeKey: string;
	scopeDigest: string;
	targets: readonly PlexPositiveEpisodeParentTarget[];
}

function validNonempty(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0 && !value.includes("\0");
}

function validPositiveInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function validateTarget(
	target: PlexPositiveEpisodeParentTarget,
	instanceId: string | undefined,
	generationId: string | undefined,
): void {
	if (
		!validNonempty(target.instanceId) ||
		!validNonempty(target.generationId) ||
		!validNonempty(target.sectionId) ||
		!validNonempty(target.sectionUuid) ||
		target.mediaType !== "series" ||
		!validPositiveInteger(target.showTmdbId) ||
		(target.tvdbId !== null && !validPositiveInteger(target.tvdbId)) ||
		!validNonempty(target.ratingKey)
	) {
		throw new Error("Invalid Plex episode parent target");
	}
	if (
		(instanceId !== undefined && target.instanceId !== instanceId) ||
		(generationId !== undefined && target.generationId !== generationId)
	) {
		throw new Error("Plex episode parent target authority is mixed");
	}
}

function compareTargets(
	left: PlexPositiveEpisodeParentTarget,
	right: PlexPositiveEpisodeParentTarget,
): number {
	return (
		left.showTmdbId - right.showTmdbId ||
		left.sectionId.localeCompare(right.sectionId) ||
		left.sectionUuid.localeCompare(right.sectionUuid) ||
		left.ratingKey.localeCompare(right.ratingKey) ||
		(left.tvdbId ?? -1) - (right.tvdbId ?? -1)
	);
}

export function plexEpisodeTargetTuple(
	target: PlexPositiveEpisodeParentTarget,
): readonly [number, string, string, string, number | null] {
	return [target.showTmdbId, target.sectionId, target.sectionUuid, target.ratingKey, target.tvdbId];
}

export function digestPlexEpisodeTargets(
	targets: readonly PlexPositiveEpisodeParentTarget[],
): string {
	return createHash("sha256")
		.update(
			JSON.stringify({
				version: 1,
				targets: [...targets].sort(compareTargets).map(plexEpisodeTargetTuple),
			}),
			"utf8",
		)
		.digest("hex");
}

/** Hashes one canonical unit scope, including its immutable ordinal/key. */
export function digestPlexEpisodeUnit(
	ordinal: number,
	targets: readonly PlexPositiveEpisodeParentTarget[],
): string {
	return createHash("sha256")
		.update(
			JSON.stringify({
				version: 1,
				ordinal,
				scopeKey: `plex-episode-unit:${ordinal}`,
				targets: [...targets].sort(compareTargets).map(plexEpisodeTargetTuple),
			}),
			"utf8",
		)
		.digest("hex");
}

function normalizeTargets(
	targets: readonly PlexPositiveEpisodeParentTarget[],
): PlexPositiveEpisodeParentTarget[] {
	let instanceId: string | undefined;
	let generationId: string | undefined;
	const seenRatingKeys = new Set<string>();
	const normalized: PlexPositiveEpisodeParentTarget[] = [];
	for (const target of targets) {
		validateTarget(target, instanceId, generationId);
		instanceId ??= target.instanceId;
		generationId ??= target.generationId;
		if (seenRatingKeys.has(target.ratingKey)) {
			throw new Error("Duplicate Plex episode parent target rating key");
		}
		seenRatingKeys.add(target.ratingKey);
		normalized.push(target);
	}
	return normalized.sort(compareTargets);
}

export function planPlexEpisodeRefresh(targets: readonly PlexPositiveEpisodeParentTarget[]): {
	targetDigest: string;
	targetCount: number;
	units: readonly PlannedPlexEpisodeUnit[];
} {
	const normalized = normalizeTargets(targets);
	const units: PlannedPlexEpisodeUnit[] = [];
	for (
		let offset = 0, ordinal = 0;
		offset < normalized.length;
		offset += PLEX_EPISODE_PARENT_COPIES_PER_UNIT, ordinal++
	) {
		const unitTargets = normalized.slice(offset, offset + PLEX_EPISODE_PARENT_COPIES_PER_UNIT);
		units.push({
			ordinal,
			scopeKey: `plex-episode-unit:${ordinal}`,
			scopeDigest: digestPlexEpisodeUnit(ordinal, unitTargets),
			targets: unitTargets,
		});
	}
	return {
		targetDigest: digestPlexEpisodeTargets(normalized),
		targetCount: normalized.length,
		units,
	};
}
