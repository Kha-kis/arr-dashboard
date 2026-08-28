import { describe, expect, it, vi } from "vitest";
import {
	publishAuthoritativeTautulliGeneration,
	TautulliRefreshAttemptSupersededError,
} from "../tautulli-cache-storage.js";
import { encodeTautulliGenerationMetadata } from "../tautulli-generation-metadata.js";
import {
	createTautulliAggregateRoot,
	createTautulliGenerationObservationRoot,
	createTautulliTargetCatalogRoot,
	type TautulliAggregateGenerationRow,
	type TautulliGenerationObservation,
} from "../tautulli-generation-observations.js";

const instance = { id: "tautulli-1", connectionGeneration: 4, identityGeneration: 2 };
const attempt = {
	attemptedAt: new Date("2026-08-27T12:00:00Z"),
	resultMarker: "in_progress:attempt-a",
};
const aggregateRows: TautulliAggregateGenerationRow[] = [
	{
		instanceId: "tautulli-1",
		generationId: "generation-1",
		tmdbId: 55,
		mediaType: "movie",
		lastWatchedAt: null,
		watchCount: 0,
		watchedByUsers: "[]",
		connectionGeneration: 4,
		identityGeneration: 2,
	},
];
const exactRows: TautulliGenerationObservation[] = [
	{
		instanceId: "tautulli-1",
		generationId: "generation-1",
		sectionId: "1",
		ratingKey: "100",
		providerGuidFingerprint: "a".repeat(64),
		mediaType: "movie",
		tmdbId: 55,
		observedWatchCount: 0,
		lastWatchedAt: null,
		connectionGeneration: 4,
		identityGeneration: 2,
	},
];
const publicationScope = {
	instanceId: "tautulli-1",
	generationId: "generation-1",
	connectionGeneration: 4,
	identityGeneration: 2,
};
const generationMetadata = encodeTautulliGenerationMetadata({
	version: 1,
	provider: "tautulli",
	generationId: "generation-1",
	publicationLevel: "authoritative",
	completeness: {
		targetCatalog: createTautulliTargetCatalogRoot({
			...publicationScope,
			rows: exactRows,
		}),
		observations: createTautulliGenerationObservationRoot({
			...publicationScope,
			rows: exactRows,
		}),
		aggregate: createTautulliAggregateRoot({
			...publicationScope,
			rows: aggregateRows,
		}),
	},
	connectionGeneration: 4,
	identityGeneration: 2,
	capabilities: ["exact-target-observations"],
	partialReasons: [],
});

function fixture(updateCount = 1) {
	const tx = {
		cacheRefreshStatus: { updateMany: vi.fn().mockResolvedValue({ count: updateCount }) },
		tautulliCache: {
			deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
			createMany: vi.fn().mockResolvedValue({ count: 1 }),
		},
		tautulliGenerationObservation: {
			deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
			createMany: vi.fn().mockResolvedValue({ count: 1 }),
		},
	};
	return tx;
}

describe("atomic Tautulli generation publication", () => {
	it("replaces aggregate, exact rows, metadata, generation, and attempt result under one token", async () => {
		const tx = fixture();
		await publishAuthoritativeTautulliGeneration(tx as never, {
			instance,
			attempt,
			completedAt: attempt.attemptedAt,
			generationId: "generation-1",
			generationMetadata,
			aggregateRows: aggregateRows as never,
			exactRows: exactRows as never,
		});
		expect(tx.cacheRefreshStatus.updateMany).toHaveBeenCalledWith({
			where: expect.objectContaining({
				instanceId: "tautulli-1",
				cacheType: "tautulli",
				lastAttemptResult: attempt.resultMarker,
			}),
			data: expect.objectContaining({
				generationId: "generation-1",
				generationMetadata,
				lastAttemptResult: "success",
				itemCount: 1,
			}),
		});
		expect(tx.tautulliCache.deleteMany).toHaveBeenCalledWith({
			where: { instanceId: "tautulli-1" },
		});
		expect(tx.tautulliGenerationObservation.deleteMany).toHaveBeenCalledWith({
			where: { instanceId: "tautulli-1" },
		});
		expect(tx.tautulliCache.createMany).toHaveBeenCalledWith({ data: aggregateRows });
		expect(tx.tautulliGenerationObservation.createMany).toHaveBeenCalledWith({ data: exactRows });
	});

	it("writes nothing when a newer attempt owns the status", async () => {
		const tx = fixture(0);
		await expect(
			publishAuthoritativeTautulliGeneration(tx as never, {
				instance,
				attempt,
				completedAt: attempt.attemptedAt,
				generationId: "generation-1",
				generationMetadata,
				aggregateRows: aggregateRows as never,
				exactRows: exactRows as never,
			}),
		).rejects.toBeInstanceOf(TautulliRefreshAttemptSupersededError);
		expect(tx.tautulliCache.deleteMany).not.toHaveBeenCalled();
		expect(tx.tautulliGenerationObservation.deleteMany).not.toHaveBeenCalled();
	});

	it("publishes positive-only rows with partial attempt state and a bounded reason", async () => {
		const tx = fixture();
		await publishAuthoritativeTautulliGeneration(tx as never, {
			instance,
			attempt,
			completedAt: attempt.attemptedAt,
			generationId: "generation-1",
			generationMetadata,
			aggregateRows: aggregateRows as never,
			exactRows: exactRows as never,
			publicationLevel: "positive-only",
			reasonCode: "metadata_tmdb_unmapped",
		});
		expect(tx.cacheRefreshStatus.updateMany).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					lastResult: "success",
					lastErrorMessage: null,
					lastAttemptResult: "partial",
					lastAttemptErrorMessage: "metadata_tmdb_unmapped",
				}),
			}),
		);
	});

	it.each([
		["aggregate watch count", [{ ...aggregateRows[0]!, watchCount: -0 }], exactRows],
		["exact observed watch count", aggregateRows, [{ ...exactRows[0]!, observedWatchCount: -0 }]],
	] as const)(
		"rejects negative zero in %s before any Prisma write",
		async (_label, aggregate, exact) => {
			const tx = fixture();

			await expect(
				publishAuthoritativeTautulliGeneration(tx as never, {
					instance,
					attempt,
					completedAt: attempt.attemptedAt,
					generationId: "generation-1",
					generationMetadata,
					aggregateRows: aggregate as never,
					exactRows: exact as never,
				}),
			).rejects.toThrow("Invalid Tautulli generation publication");
			expect(tx.cacheRefreshStatus.updateMany).not.toHaveBeenCalled();
			expect(tx.tautulliCache.createMany).not.toHaveBeenCalled();
			expect(tx.tautulliGenerationObservation.createMany).not.toHaveBeenCalled();
		},
	);

	it("rejects negative-zero metadata before CacheRefreshStatus receives it", async () => {
		const tx = fixture();
		const negativeZeroMetadata = generationMetadata.replace(
			/"targetCatalog":\{"version":1,"count":1/,
			'"targetCatalog":{"version":1,"count":-0',
		);

		await expect(
			publishAuthoritativeTautulliGeneration(tx as never, {
				instance,
				attempt,
				completedAt: attempt.attemptedAt,
				generationId: "generation-1",
				generationMetadata: negativeZeroMetadata,
				aggregateRows: aggregateRows as never,
				exactRows: exactRows as never,
			}),
		).rejects.toThrow("Invalid Tautulli generation publication");
		expect(tx.cacheRefreshStatus.updateMany).not.toHaveBeenCalled();
	});

	it("rejects a negative-zero publication generation before any Prisma write", async () => {
		const tx = fixture();

		await expect(
			publishAuthoritativeTautulliGeneration(tx as never, {
				instance: { ...instance, connectionGeneration: -0 },
				attempt,
				completedAt: attempt.attemptedAt,
				generationId: "generation-1",
				generationMetadata,
				aggregateRows: aggregateRows as never,
				exactRows: exactRows as never,
			}),
		).rejects.toThrow("Invalid Tautulli generation publication");
		expect(tx.cacheRefreshStatus.updateMany).not.toHaveBeenCalled();
		expect(tx.tautulliCache.createMany).not.toHaveBeenCalled();
		expect(tx.tautulliGenerationObservation.createMany).not.toHaveBeenCalled();
	});
});
