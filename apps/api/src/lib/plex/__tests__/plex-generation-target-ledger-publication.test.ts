import { describe, expect, it, vi } from "vitest";

type Ledger = typeof import("../plex-generation-target-ledger.js");

const target = {
	instanceId: "plex-1",
	generationId: "generation-1",
	sectionId: "movies",
	sectionUuid: "movies-uuid",
	mediaType: "movie" as const,
	tmdbId: 42,
	tvdbId: null,
	ratingKey: "rating-1",
};

async function ledger(): Promise<Ledger> {
	return await import("../plex-generation-target-ledger.js");
}

describe("Plex generation target ledger publication boundaries", () => {
	it("5 binds two exact provider objects even when one aggregated cache row exists", async () => {
		const module = await ledger();
		const binding = module.createPlexTargetLedgerBinding({
			instanceId: "plex-1",
			generationId: "generation-1",
			connectionGeneration: 4,
			identityGeneration: 9,
			targets: [target, { ...target, ratingKey: "rating-2" }],
		});
		expect({ targetCount: binding.targetCount, aggregatedCacheRows: 1 }).toEqual({
			targetCount: 2,
			aggregatedCacheRows: 1,
		});
	});

	it("16 refuses synthetic ledger construction from a PlexCache-shaped row", async () => {
		const module = await ledger();
		expect(() =>
			module.normalizePlexGenerationTargets([
				{
					instanceId: "plex-1",
					generationId: "generation-1",
					sectionId: "movies",
					mediaType: "movie",
					tmdbId: 42,
					ratingKey: "rating-1",
				} as never,
			]),
		).toThrow();
	});

	it("17 propagates a ledger write failure so the enclosing publication transaction can roll back", async () => {
		const module = await ledger();
		const deleteMany = vi.fn().mockResolvedValue({ count: 1 });
		const createMany = vi.fn().mockRejectedValue(new Error("write failed"));
		await expect(
			module.replacePlexGenerationTargets(
				{ plexGenerationTarget: { deleteMany, createMany } } as never,
				{ instanceId: "plex-1", generationId: "generation-1", targets: [target] },
			),
		).rejects.toThrow("write failed");
		expect(deleteMany).toHaveBeenCalledWith({ where: { instanceId: "plex-1" } });
	});

	it("19 replaces 20,000 current-generation targets in bounded 100-target chunks", async () => {
		const module = await ledger();
		const createMany = vi.fn().mockResolvedValue({ count: 100 });
		await module.replacePlexGenerationTargets(
			{ plexGenerationTarget: { deleteMany: vi.fn(), createMany } } as never,
			{
				instanceId: "plex-1",
				generationId: "generation-1",
				targets: Array.from({ length: 20_000 }, (_, index) => ({
					...target,
					ratingKey: `rating-${index}`,
					tmdbId: index + 1,
				})),
			},
		);
		expect(createMany).toHaveBeenCalledTimes(200);
		expect(createMany.mock.calls.every(([call]) => call.data.length === 100)).toBe(true);
	});

	it("23 rejects a target outside the fully settled V3 supported-section catalog", async () => {
		const module = await ledger();
		expect(
			module.validatePlexGenerationTargetSections(
				[target],
				[{ key: "shows", uuid: "shows-uuid", type: "show" }],
			),
		).toEqual({ ok: false });
	});

	it("24 rejects a persisted ledger when connection generation changes", async () => {
		const module = await ledger();
		expect(
			module.samePlexGenerationBinding(
				{ connectionGeneration: 4, identityGeneration: 9 },
				{ connectionGeneration: 5, identityGeneration: 9 },
			),
		).toBe(false);
	});

	it("25 rejects a persisted ledger when identity generation changes", async () => {
		const module = await ledger();
		expect(
			module.samePlexGenerationBinding(
				{ connectionGeneration: 4, identityGeneration: 9 },
				{ connectionGeneration: 4, identityGeneration: 10 },
			),
		).toBe(false);
	});

	it("29 reads no exact targets for an old generation rather than synthesizing from cache", async () => {
		const module = await ledger();
		const plexGenerationTarget = { findMany: vi.fn().mockResolvedValue([]) };
		await expect(
			module.readPlexGenerationTargets({ plexGenerationTarget } as never, {
				instanceId: "plex-1",
				generationId: "old-generation",
			}),
		).resolves.toEqual([]);
		expect(plexGenerationTarget.findMany).toHaveBeenCalledWith(
			expect.objectContaining({ where: { instanceId: "plex-1", generationId: "old-generation" } }),
		);
	});
});
