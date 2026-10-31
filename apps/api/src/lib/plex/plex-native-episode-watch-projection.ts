import type { ProviderNativeWatchDisplay } from "@arr/shared";
import type { NativeInventoryRow } from "../provider-observation/native-inventory.js";
import type { PositiveEpisodeDisplayAuthority } from "./plex-authority-service.js";

const UNKNOWN: ProviderNativeWatchDisplay = {
	state: "unknown",
	freshness: "unavailable",
	valueSemantics: "unknown",
	observedAt: null,
};

/** Display-only join. A missing positive observation never proves unwatched. */
export function projectPlexNativeEpisodeWatchPage(input: {
	rows: readonly NativeInventoryRow[];
	parents: readonly NativeInventoryRow[];
	evidence: PositiveEpisodeDisplayAuthority;
	inventoryFreshness: "current" | "last-known";
	parentFreshness: "current" | "last-known";
	inventoryObservedAt: Date;
	parentObservedAt: Date;
}): ReadonlyMap<string, ProviderNativeWatchDisplay> {
	const result = new Map(input.rows.map((row) => [row.nativeId, UNKNOWN]));
	if (!input.evidence.available) return result;
	if (
		input.evidence.evidence.availability !== "current" &&
		input.evidence.evidence.availability !== "last-known"
	)
		return result;
	const parents = new Map(input.parents.map((row) => [row.nativeId, row]));
	const positives = new Map<string, typeof input.evidence.rows>();
	for (const row of input.evidence.rows) {
		const group = positives.get(row.ratingKey) ?? [];
		group.push(row);
		positives.set(row.ratingKey, group);
	}
	const publishedAt = Date.parse(input.evidence.provenance.publishedAt);
	if (!Number.isFinite(publishedAt)) return result;
	const freshness =
		input.evidence.evidence.availability === "current" &&
		input.inventoryFreshness === "current" &&
		input.parentFreshness === "current" &&
		Number.isFinite(input.inventoryObservedAt.getTime()) &&
		Number.isFinite(input.parentObservedAt.getTime()) &&
		input.inventoryObservedAt.getTime() <= publishedAt &&
		input.parentObservedAt.getTime() <= publishedAt
			? "current"
			: "last-known";
	for (const inventory of input.rows) {
		const candidates = positives.get(inventory.nativeId);
		if (candidates?.length !== 1) continue;
		const positive = candidates[0]!;
		const parent = inventory.parentNativeId ? parents.get(inventory.parentNativeId) : undefined;
		const target = positive.soleParentTarget;
		if (
			inventory.mediaType !== "episode" ||
			!positive.watched ||
			inventory.seasonNumber !== positive.seasonNumber ||
			inventory.episodeNumber !== positive.episodeNumber ||
			!parent ||
			parent.mediaType !== "series" ||
			parent.nativeId !== target.ratingKey ||
			target.instanceId !== input.evidence.instanceId ||
			target.generationId !== input.evidence.provenance.parentPlexGenerationId ||
			target.showTmdbId !== positive.showTmdbId ||
			!parent.libraryIds.includes(target.sectionId) ||
			!inventory.libraryIds.includes(target.sectionId) ||
			parent.externalIds?.tmdb?.length !== 1 ||
			parent.externalIds.tmdb[0] !== positive.showTmdbId
		)
			continue;
		result.set(inventory.nativeId, {
			state: "watched",
			freshness,
			valueSemantics: "lower-bound",
			observedAt: input.evidence.provenance.publishedAt,
		});
	}
	return result;
}
