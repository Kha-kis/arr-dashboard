export type JellyfinMappedSeriesObservation = {
	jellyfinId: string;
	seriesId: string;
	seasonNumber: number;
	episodeNumber: number;
	played: boolean;
};

export type JellyfinSeriesProgressCoordinate = {
	seasonNumber: number;
	episodeNumber: number;
	watched: boolean;
};

export type JellyfinMappedSeriesScope = {
	userKeyDigest: string;
	libraryId: string;
	complete: boolean;
	collect: readonly JellyfinMappedSeriesObservation[];
	verify: readonly JellyfinMappedSeriesObservation[];
};

type Binding = { libraryId: string; seriesId: string; tmdbId: number };

type NativeIdentities = Map<string, JellyfinMappedSeriesObservation | null>;

function validId(value: unknown): value is string {
	return typeof value === "string" && value.trim() !== "" && !value.includes("\0");
}

function sameNativeCoordinate(
	left: JellyfinMappedSeriesObservation,
	right: JellyfinMappedSeriesObservation,
): boolean {
	return (
		left.seriesId === right.seriesId &&
		left.seasonNumber === right.seasonNumber &&
		left.episodeNumber === right.episodeNumber
	);
}

function indexObservations(
	rows: readonly JellyfinMappedSeriesObservation[],
	nativeIdentities: NativeIdentities,
): Map<string, JellyfinMappedSeriesObservation> | null {
	const byId = new Map<string, JellyfinMappedSeriesObservation>();
	let valid = true;
	for (const row of rows) {
		if (
			!validId(row.jellyfinId) ||
			!validId(row.seriesId) ||
			!Number.isSafeInteger(row.seasonNumber) ||
			row.seasonNumber < 0 ||
			!Number.isSafeInteger(row.episodeNumber) ||
			row.episodeNumber < 0
		) {
			valid = false;
			continue;
		}

		const prior = nativeIdentities.get(row.jellyfinId);
		if (prior === undefined) nativeIdentities.set(row.jellyfinId, row);
		else if (prior !== null && !sameNativeCoordinate(prior, row))
			nativeIdentities.set(row.jellyfinId, null);

		if (byId.has(row.jellyfinId) || typeof row.played !== "boolean") valid = false;
		byId.set(row.jellyfinId, row);
	}
	return valid ? byId : null;
}

function sameMembership(
	collect: ReadonlyMap<string, JellyfinMappedSeriesObservation>,
	verify: ReadonlyMap<string, JellyfinMappedSeriesObservation>,
): boolean {
	if (collect.size !== verify.size) return false;
	for (const [id, row] of collect) {
		const other = verify.get(id);
		if (!other || !sameNativeCoordinate(row, other)) return false;
	}
	return true;
}

function uniqueBindings(bindings: readonly Binding[]): Binding[] {
	const seriesCounts = new Map<string, number>();
	const tmdbCounts = new Map<number, number>();
	for (const { seriesId, tmdbId } of bindings) {
		seriesCounts.set(seriesId, (seriesCounts.get(seriesId) ?? 0) + 1);
		tmdbCounts.set(tmdbId, (tmdbCounts.get(tmdbId) ?? 0) + 1);
	}
	return bindings
		.filter(
			({ libraryId, seriesId, tmdbId }) =>
				validId(libraryId) &&
				validId(seriesId) &&
				Number.isSafeInteger(tmdbId) &&
				tmdbId > 0 &&
				seriesCounts.get(seriesId) === 1 &&
				tmdbCounts.get(tmdbId) === 1,
		)
		.sort((left, right) => left.tmdbId - right.tmdbId);
}

export function retainCurrentJellyfinMappedSeriesBindings(
	original: readonly Binding[],
	current: readonly Binding[],
): Binding[] {
	const byTmdbId = new Map(uniqueBindings(current).map((binding) => [binding.tmdbId, binding]));
	return original.filter(({ tmdbId, seriesId, libraryId }) => {
		const binding = byTmdbId.get(tmdbId);
		return binding?.seriesId === seriesId && binding.libraryId === libraryId;
	});
}

/**
 * Derives display-only coordinates from validated bindings and the full expected
 * scope plan. The caller must supply an incomplete scope for each missing pair.
 */
export function deriveJellyfinMappedSeriesProgress(input: {
	bindings: readonly Binding[];
	scopes: readonly JellyfinMappedSeriesScope[];
}): ReadonlyMap<number, readonly JellyfinSeriesProgressCoordinate[]> {
	const result = new Map<number, readonly JellyfinSeriesProgressCoordinate[]>();
	const bindings = uniqueBindings(input.bindings);
	if (bindings.length === 0) return result;

	const showsBySeries = new Map(
		bindings.map(({ libraryId, seriesId }) => [
			seriesId,
			{
				libraryId,
				ambiguous: false,
				coordinates: new Map<string, JellyfinMappedSeriesObservation>(),
			},
		]),
	);
	const nativeIdentities: NativeIdentities = new Map();
	const seenScopes = new Set<string>();
	const completeLibraries = new Set<string>();
	const invalidLibraries = new Set<string>();

	for (const scope of input.scopes) {
		const { libraryId, userKeyDigest } = scope;
		// Even an incomplete scope can contradict a native episode identity.
		const collect = indexObservations(scope.collect, nativeIdentities);
		const verify = indexObservations(scope.verify, nativeIdentities);
		const scopeKey = `${libraryId}\0${userKeyDigest}`;
		if (
			!validId(libraryId) ||
			!validId(userKeyDigest) ||
			scope.complete !== true ||
			seenScopes.has(scopeKey)
		) {
			invalidLibraries.add(libraryId);
			continue;
		}
		seenScopes.add(scopeKey);

		// Membership includes unmapped episodes. Played drift invalidates only
		// the affected show once library membership has been established.
		if (!collect || !verify || !sameMembership(collect, verify)) {
			invalidLibraries.add(libraryId);
			continue;
		}
		completeLibraries.add(libraryId);

		for (const row of collect.values()) {
			const show = showsBySeries.get(row.seriesId);
			if (show?.libraryId !== libraryId) continue;
			const key = `${row.seasonNumber}:${row.episodeNumber}`;
			const prior = show.coordinates.get(key);
			if (
				row.played !== verify.get(row.jellyfinId)?.played ||
				(prior !== undefined && prior.jellyfinId !== row.jellyfinId)
			) {
				show.ambiguous = true;
			} else if (prior === undefined || row.played) {
				show.coordinates.set(key, row);
			}
		}
	}

	for (const { libraryId, seriesId, tmdbId } of bindings) {
		const show = showsBySeries.get(seriesId)!;
		if (!completeLibraries.has(libraryId) || invalidLibraries.has(libraryId) || show.ambiguous)
			continue;

		const rows = [...show.coordinates.values()];
		if (rows.some((row) => nativeIdentities.get(row.jellyfinId) === null)) continue;

		rows.sort(
			(left, right) =>
				left.seasonNumber - right.seasonNumber || left.episodeNumber - right.episodeNumber,
		);
		result.set(
			tmdbId,
			rows.map(({ seasonNumber, episodeNumber, played }) => ({
				seasonNumber,
				episodeNumber,
				watched: played,
			})),
		);
	}
	return result;
}
