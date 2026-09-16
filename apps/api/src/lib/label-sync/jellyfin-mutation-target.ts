import type { NativeInventoryRow } from "../provider-observation/native-inventory.js";

type MutationIdentity = { mediaType: "movie" | "series"; tmdbId: number };
export type JellyfinMutationTarget = MutationIdentity & {
	available: true;
	generationId: string;
	nativeId: string;
	libraryId: string;
};
type TargetResolution =
	| JellyfinMutationTarget
	| {
			available: false;
			reason: "generation_changed" | "target_missing" | "target_ambiguous";
	  };
type Catalog = {
	generationId: string;
	freshness: "current" | "last-known";
	complete: boolean;
	itemCount: number;
	rows: readonly NativeInventoryRow[];
};
type TargetIndex = ReadonlyMap<string, readonly TargetResolution[]> | undefined;

function key(identity: MutationIdentity): string {
	return `${identity.mediaType}:${identity.tmdbId}`;
}

/** Build only from an entire current native publication. Keep every conflict in the index. */
export function createJellyfinMutationTargetIndex(catalog: Catalog | undefined): TargetIndex {
	if (
		!catalog ||
		catalog.freshness !== "current" ||
		!catalog.complete ||
		!catalog.generationId ||
		catalog.rows.length !== catalog.itemCount
	)
		return undefined;
	const index = new Map<string, TargetResolution[]>();
	for (const row of catalog.rows) {
		if (row.mediaType !== "movie" && row.mediaType !== "series") continue;
		const ids = row.externalIds?.tmdb ?? [];
		for (const tmdbId of new Set(ids)) {
			const identity = { mediaType: row.mediaType, tmdbId };
			const entry: TargetResolution =
				ids.length === 1 && row.libraryIds.length === 1
					? {
							available: true,
							generationId: catalog.generationId,
							nativeId: row.nativeId,
							libraryId: row.libraryIds[0]!,
							...identity,
						}
					: { available: false, reason: "target_ambiguous" };
			const existing = index.get(key(identity)) ?? [];
			existing.push(entry);
			index.set(key(identity), existing);
		}
	}
	return index;
}

/** Native identity selects the target; a title or another media type never does. */
export function resolveJellyfinMutationTarget(
	index: TargetIndex,
	identity: MutationIdentity,
): TargetResolution {
	if (!index) return { available: false, reason: "generation_changed" };
	const matches = index.get(key(identity)) ?? [];
	if (matches.length === 0) return { available: false, reason: "target_missing" };
	if (matches.length !== 1) return { available: false, reason: "target_ambiguous" };
	return matches[0]!;
}
