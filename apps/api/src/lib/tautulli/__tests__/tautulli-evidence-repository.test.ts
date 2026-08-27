import { describe, expect, it, vi } from "vitest";
import {
	createTautulliAggregateRoot,
	createTautulliGenerationObservationRoot,
	createTautulliTargetCatalogRoot,
	type TautulliAggregateGenerationRow,
	type TautulliGenerationObservation,
} from "../tautulli-generation-observations.js";
import {
	loadExactTautulliEvidence,
	loadPersistedTautulliGeneration,
	loadPositiveTautulliEvidence,
} from "../tautulli-evidence-repository.js";

const scope = {
	instanceId: "tautulli-1",
	generationId: "generation-1",
	connectionGeneration: 4,
	identityGeneration: 2,
};

function exactRow(index: number): TautulliGenerationObservation & { id: string } {
	return {
		id: `exact-${String(index).padStart(4, "0")}`,
		...scope,
		sectionId: "1",
		ratingKey: String(10_000 + index),
		providerGuidFingerprint: index.toString(16).padStart(64, "0"),
		mediaType: "movie",
		tmdbId: index + 1,
		observedWatchCount: index % 2,
		lastWatchedAt: null,
	};
}

function aggregateRow(index: number): TautulliAggregateGenerationRow & { id: string } {
	return {
		id: `aggregate-${String(index).padStart(4, "0")}`,
		...scope,
		mediaType: "movie",
		tmdbId: index + 1,
		lastWatchedAt: null,
		watchCount: index % 2,
		watchedByUsers: "[]",
	};
}

function pagedTable<Row extends { id: string }>(rows: Row[]) {
	return {
		findMany: vi.fn(async (input: { take: number; cursor?: { id: string } }) => {
			const offset = input.cursor ? rows.findIndex((row) => row.id === input.cursor?.id) + 1 : 0;
			return rows.slice(offset, offset + input.take);
		}),
	};
}

function fixture(
	exactRows: Array<ReturnType<typeof exactRow>>,
	aggregateRows: Array<ReturnType<typeof aggregateRow>>,
) {
	return {
		tautulliGenerationObservation: pagedTable(exactRows),
		tautulliCache: pagedTable(aggregateRows),
	};
}

function roots(
	exactRows: TautulliGenerationObservation[],
	aggregateRows: TautulliAggregateGenerationRow[],
) {
	return {
		targetCatalog: createTautulliTargetCatalogRoot({ ...scope, rows: exactRows }),
		observations: createTautulliGenerationObservationRoot({ ...scope, rows: exactRows }),
		aggregate: createTautulliAggregateRoot({ ...scope, rows: aggregateRows }),
	};
}

describe("persisted Tautulli generation reader", () => {
	it("cursor-pages exact and aggregate rows and verifies all three roots", async () => {
		const exactRows = Array.from({ length: 501 }, (_, index) => exactRow(index));
		const aggregateRows = Array.from({ length: 501 }, (_, index) => aggregateRow(index));
		const prisma = fixture(exactRows, aggregateRows);

		const result = await loadPersistedTautulliGeneration(prisma as never, {
			...scope,
			expected: roots(exactRows, aggregateRows),
		});

		expect(result.ok).toBe(true);
		expect(prisma.tautulliGenerationObservation.findMany).toHaveBeenCalledTimes(2);
		expect(prisma.tautulliCache.findMany).toHaveBeenCalledTimes(2);
		expect(prisma.tautulliGenerationObservation.findMany).toHaveBeenCalledWith(
			expect.objectContaining({ take: 500, orderBy: { id: "asc" } }),
		);
	});

	it.each([
		[
			"missing exact row",
			(exact: ReturnType<typeof exactRow>[], _aggregate: ReturnType<typeof aggregateRow>[]) =>
				exact.pop(),
		],
		[
			"extra exact row",
			(exact: ReturnType<typeof exactRow>[], _aggregate: ReturnType<typeof aggregateRow>[]) =>
				exact.push(exactRow(2)),
		],
		[
			"mixed exact generation",
			(exact: ReturnType<typeof exactRow>[], _aggregate: ReturnType<typeof aggregateRow>[]) => {
				exact[0] = { ...exact[0]!, generationId: "other" };
			},
		],
		[
			"mixed aggregate generation",
			(_exact: ReturnType<typeof exactRow>[], aggregate: ReturnType<typeof aggregateRow>[]) => {
				aggregate[0] = { ...aggregate[0]!, generationId: "other" };
			},
		],
		[
			"legacy aggregate row",
			(_exact: ReturnType<typeof exactRow>[], aggregate: ReturnType<typeof aggregateRow>[]) => {
				aggregate[0] = { ...aggregate[0]!, generationId: null as never };
			},
		],
	] as const)("fails closed for %s", async (_label, mutate) => {
		const publishedExact = [exactRow(0), exactRow(1)];
		const publishedAggregate = [aggregateRow(0), aggregateRow(1)];
		const expected = roots(publishedExact, publishedAggregate);
		const storedExact = publishedExact.map((row) => ({ ...row }));
		const storedAggregate = publishedAggregate.map((row) => ({ ...row }));
		mutate(storedExact, storedAggregate);

		const result = await loadPersistedTautulliGeneration(
			fixture(storedExact, storedAggregate) as never,
			{ ...scope, expected },
		);

		expect(result).toEqual({ ok: false, reasonCode: "publication_integrity_mismatch" });
	});

	it("keeps positive-only rows out of exact readers and exposes only proven positives", async () => {
		const exactRows = [
			{ ...exactRow(0), observedWatchCount: 2 },
			{ ...exactRow(1), observedWatchCount: 0 },
		];
		const aggregateRows = [
			{ ...aggregateRow(0), watchCount: 2 },
			{ ...aggregateRow(1), watchCount: 0 },
		];
		const prisma = fixture(exactRows, aggregateRows);
		const completeness = roots(exactRows, aggregateRows);
		const refreshedAt = new Date("2026-08-27T12:00:00.000Z");
		const status = {
			lastResult: "partial",
			lastRefreshedAt: refreshedAt,
			lastAttemptAt: refreshedAt,
			lastAttemptResult: "partial",
			lastAttemptErrorMessage: "metadata_tmdb_unmapped",
			generationId: scope.generationId,
			generationMetadata: JSON.stringify({
				version: 1,
				provider: "tautulli",
				generationId: scope.generationId,
				publicationLevel: "positive-only",
				completeness,
				connectionGeneration: scope.connectionGeneration,
				identityGeneration: scope.identityGeneration,
				capabilities: ["positive-watch-count"],
				partialReasons: [{ code: "metadata_tmdb_unmapped", count: 1 }],
			}),
			itemCount: aggregateRows.length,
			connectionGeneration: scope.connectionGeneration,
			identityGeneration: scope.identityGeneration,
		};
		const authority = {
			connectionGeneration: scope.connectionGeneration,
			identityGeneration: scope.identityGeneration,
		};

		expect(
			await loadExactTautulliEvidence(prisma as never, { ...scope, status, authority }),
		).toEqual({
			available: false,
			reasonCode: "publication_not_authoritative",
		});
		const positive = await loadPositiveTautulliEvidence(prisma as never, {
			...scope,
			status,
			authority,
		});
		expect(positive).toMatchObject({ available: true });
		if (positive.available) {
			expect(positive.rows).toEqual([
				expect.objectContaining({ mediaType: "movie", tmdbId: 1, observedWatchCount: 2 }),
			]);
			expect(JSON.stringify(positive.rows)).not.toMatch(/ratingKey|sectionId|providerGuid/);
		}
	});
});
