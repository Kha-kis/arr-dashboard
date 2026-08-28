import { describe, expect, it, vi } from "vitest";
import {
	publishAuthoritativeTautulliGeneration,
	TautulliRefreshAttemptSupersededError,
} from "../tautulli-cache-storage.js";

const instance = { id: "tautulli-1", connectionGeneration: 4, identityGeneration: 2 } as never;
const attempt = {
	attemptedAt: new Date("2026-08-27T12:00:00Z"),
	resultMarker: "in_progress:attempt-a",
};
const aggregateRows = [
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
const exactRows = [
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
			generationMetadata: "metadata-v1",
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
				generationMetadata: "metadata-v1",
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
				generationMetadata: "metadata-v1",
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
			generationMetadata: "metadata-v1",
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
});
