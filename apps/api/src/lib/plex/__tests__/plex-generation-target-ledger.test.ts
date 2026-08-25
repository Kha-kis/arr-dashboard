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

describe("Plex generation target ledger", () => {
	it("1 requires one exact row for one mapped provider object", async () => {
		expect((await ledger()).normalizePlexGenerationTargets([target])).toEqual([target]);
	});

	it("2 preserves two rating keys for one TMDB identity", async () => {
		expect(
			(await ledger()).normalizePlexGenerationTargets([
				target,
				{ ...target, ratingKey: "rating-2" },
			]),
		).toHaveLength(2);
	});

	it("3 preserves same-section duplicate TMDB identities", async () => {
		expect(
			(await ledger()).normalizePlexGenerationTargets([
				target,
				{ ...target, ratingKey: "rating-2" },
			]),
		).toHaveLength(2);
	});

	it("4 preserves cross-section duplicate TMDB identities", async () => {
		expect(
			(await ledger()).normalizePlexGenerationTargets([
				target,
				{ ...target, sectionId: "movies-2", sectionUuid: "movies-2-uuid", ratingKey: "rating-2" },
			]),
		).toHaveLength(2);
	});

	it("5 keeps exact target count independent from aggregated cache count", async () => {
		expect(
			(await ledger()).normalizePlexGenerationTargets([
				target,
				{ ...target, ratingKey: "rating-2" },
			]),
		).toHaveLength(2);
	});

	it("6 rejects a missing persisted ledger row", async () => {
		expect(
			(await ledger()).verifyPlexGenerationTargetIntegrity({
				targets: [],
				expected: {
					instanceId: "plex-1",
					generationId: "generation-1",
					connectionGeneration: 1,
					identityGeneration: 1,
					targetLedgerVersion: 1,
					targetCount: 1,
					targetDigest: "a".repeat(64),
				},
			}).ok,
		).toBe(false);
	});

	it("7 rejects an extra persisted ledger row", async () => {
		expect(
			(await ledger()).verifyPlexGenerationTargetIntegrity({
				targets: [target, { ...target, ratingKey: "rating-2" }],
				expected: {
					instanceId: "plex-1",
					generationId: "generation-1",
					connectionGeneration: 1,
					identityGeneration: 1,
					targetLedgerVersion: 1,
					targetCount: 1,
					targetDigest: "a".repeat(64),
				},
			}).ok,
		).toBe(false);
	});

	it("8 rejects a wrong target digest", async () => {
		expect(
			(await ledger()).verifyPlexGenerationTargetIntegrity({
				targets: [target],
				expected: {
					instanceId: "plex-1",
					generationId: "generation-1",
					connectionGeneration: 1,
					identityGeneration: 1,
					targetLedgerVersion: 1,
					targetCount: 1,
					targetDigest: "a".repeat(64),
				},
			}).ok,
		).toBe(false);
	});

	it("9 rejects rows from another generation", async () => {
		const module = await ledger();
		expect(() =>
			module.normalizePlexGenerationTargets([{ ...target, generationId: "other-generation" }], {
				instanceId: "plex-1",
				generationId: "generation-1",
			}),
		).toThrow();
	});

	it("10 rejects rows from another instance", async () => {
		const module = await ledger();
		expect(() =>
			module.normalizePlexGenerationTargets([{ ...target, instanceId: "plex-2" }], {
				instanceId: "plex-1",
				generationId: "generation-1",
			}),
		).toThrow();
	});

	it("11 rejects a ledger section UUID not present in the V3 catalog", async () => {
		expect((await ledger()).validatePlexGenerationTargetSections([target], [])).toEqual({
			ok: false,
		});
	});

	it("12 rejects duplicate rating keys in one generation", async () => {
		const module = await ledger();
		expect(() => module.normalizePlexGenerationTargets([target, target])).toThrow();
	});

	it("13 denies ledger-dependent authority for an old V3 generation", async () => {
		expect((await ledger()).requirePlexTargetLedgerBinding(undefined)).toEqual({ ok: false });
	});

	it("14 rejects a partial V3 ledger binding", async () => {
		expect((await ledger()).decodePlexTargetLedgerBinding({ targetLedgerVersion: 1 })).toEqual({
			ok: false,
		});
	});

	it("15 preserves old V3 observation authority without a ledger binding", async () => {
		expect((await ledger()).decodePlexTargetLedgerBinding({})).toEqual({ ok: true, binding: null });
	});

	it("16 never creates a ledger from aggregated PlexCache rows", async () => {
		expect(await ledger()).not.toHaveProperty("createPlexGenerationTargetsFromCache");
	});

	it("20 rejects a changed fresh live target", async () => {
		expect(
			(await ledger()).samePlexGenerationTargetSet([target], [{ ...target, ratingKey: "changed" }]),
		).toBe(false);
	});

	it("21 rejects a missing fresh live target", async () => {
		expect((await ledger()).samePlexGenerationTargetSet([target], [])).toBe(false);
	});

	it("22 preserves two targets but rejects generic mutation ambiguity", async () => {
		expect(
			(await ledger()).selectSinglePlexGenerationTarget([
				target,
				{ ...target, ratingKey: "rating-2" },
			]),
		).toEqual({ ok: false });
	});

	it("24 rejects a connection-generation repoint", async () => {
		expect(
			(await ledger()).samePlexGenerationBinding(
				{ connectionGeneration: 1, identityGeneration: 1 },
				{ connectionGeneration: 2, identityGeneration: 1 },
			),
		).toBe(false);
	});

	it("25 rejects an identity-generation repoint", async () => {
		expect(
			(await ledger()).samePlexGenerationBinding(
				{ connectionGeneration: 1, identityGeneration: 1 },
				{ connectionGeneration: 1, identityGeneration: 2 },
			),
		).toBe(false);
	});

	it("26 rejects a target count mismatch", async () => {
		expect(
			(await ledger()).verifyPlexGenerationTargetIntegrity({
				targets: [target],
				expected: {
					instanceId: "plex-1",
					generationId: "generation-1",
					connectionGeneration: 1,
					identityGeneration: 1,
					targetLedgerVersion: 1,
					targetCount: 2,
					targetDigest: "a".repeat(64),
				},
			}).ok,
		).toBe(false);
	});

	it("27 hashes targets deterministically independent of insertion order", async () => {
		const module = await ledger();
		const second = { ...target, ratingKey: "rating-2" };
		expect(
			module.calculatePlexGenerationTargetDigest({
				instanceId: "plex-1",
				generationId: "generation-1",
				connectionGeneration: 1,
				identityGeneration: 1,
				targets: [target, second],
			}),
		).toBe(
			module.calculatePlexGenerationTargetDigest({
				instanceId: "plex-1",
				generationId: "generation-1",
				connectionGeneration: 1,
				identityGeneration: 1,
				targets: [second, target],
			}),
		);
	});

	it("28 canonicalizes nullable TVDB IDs deterministically", async () => {
		const module = await ledger();
		expect(
			module.calculatePlexGenerationTargetDigest({
				instanceId: "plex-1",
				generationId: "generation-1",
				connectionGeneration: 1,
				identityGeneration: 1,
				targets: [target],
			}),
		).toBe(
			module.calculatePlexGenerationTargetDigest({
				instanceId: "plex-1",
				generationId: "generation-1",
				connectionGeneration: 1,
				identityGeneration: 1,
				targets: [{ ...target, tvdbId: undefined } as never],
			}),
		);
	});

	it("29 does not backfill old generations from PlexCache", async () => {
		expect(await ledger()).not.toHaveProperty("backfillPlexGenerationTargets");
	});

	it("30 distinguishes a valid empty ledger from missing or corrupt ledger evidence", async () => {
		const module = await ledger();
		expect(
			module.verifyPlexGenerationTargetIntegrity({
				targets: [],
				expected: {
					instanceId: "plex-1",
					generationId: "generation-1",
					connectionGeneration: 1,
					identityGeneration: 1,
					targetLedgerVersion: 1,
					targetCount: 0,
					targetDigest: module.calculatePlexGenerationTargetDigest({
						instanceId: "plex-1",
						generationId: "generation-1",
						connectionGeneration: 1,
						identityGeneration: 1,
						targets: [],
					}),
				},
			}).ok,
		).toBe(true);
	});

	it("reads 20,000 exact targets through bounded 500-row pages without cache fallback", async () => {
		const module = await ledger();
		const rows = Array.from({ length: 20_000 }, (_, index) => ({
			id: `target-${index}`,
			...target,
			tmdbId: index + 1,
			ratingKey: `rating-${index}`,
		}));
		const findMany = vi.fn(async ({ cursor, take }: { cursor?: { id: string }; take: number }) => {
			expect(take).toBe(500);
			const start = cursor ? Number.parseInt(cursor.id.slice("target-".length), 10) + 1 : 0;
			return rows.slice(start, start + take);
		});

		await expect(
			module.readPlexGenerationTargets({ plexGenerationTarget: { findMany } } as never, {
				instanceId: "plex-1",
				generationId: "generation-1",
			}),
		).resolves.toHaveLength(20_000);
		expect(findMany).toHaveBeenCalledTimes(41);
	});

	it.each([0, 1, 501, 20_000])(
		"matches the batch digest during a bounded streamed integrity scan for %i targets",
		async (count) => {
			const module = await ledger();
			const rows = Array.from({ length: count }, (_, index) => ({
				id: `target-${index}`,
				...target,
				tmdbId: index + 1,
				ratingKey: `rating-${index}`,
			}));
			const targets = rows.map(({ id: _id, ...entry }) => entry);
			const expected = {
				instanceId: "plex-1",
				generationId: "generation-1",
				connectionGeneration: 1,
				identityGeneration: 1,
				...module.createPlexTargetLedgerBinding({
					instanceId: "plex-1",
					generationId: "generation-1",
					connectionGeneration: 1,
					identityGeneration: 1,
					targets,
				}),
			};
			const findMany = vi.fn(
				async ({ cursor, take }: { cursor?: { id: string }; take: number }) => {
					const start = cursor ? Number.parseInt(cursor.id.slice("target-".length), 10) + 1 : 0;
					return rows.slice(start, start + take);
				},
			);

			await expect(
				module.verifyPersistedPlexGenerationTargets(
					{ plexGenerationTarget: { findMany } } as never,
					{ expected, sections: [{ key: "movies", uuid: "movies-uuid", type: "movie" }] },
				),
			).resolves.toEqual({ ok: true });
			expect(findMany).toHaveBeenCalledTimes(
				count === 0 ? 1 : Math.ceil(count / 500) + (count % 500 === 0 ? 1 : 0),
			);
		},
	);

	it("rejects an instance ledger row from an older generation rather than filtering it away", async () => {
		const module = await ledger();
		const expected = {
			instanceId: "plex-1",
			generationId: "generation-1",
			connectionGeneration: 1,
			identityGeneration: 1,
			...module.createPlexTargetLedgerBinding({
				instanceId: "plex-1",
				generationId: "generation-1",
				connectionGeneration: 1,
				identityGeneration: 1,
				targets: [target],
			}),
		};
		await expect(
			module.verifyPersistedPlexGenerationTargets(
				{
					plexGenerationTarget: {
						findMany: vi.fn().mockResolvedValue([
							{ id: "current", ...target },
							{ id: "stale", ...target, generationId: "generation-0", ratingKey: "stale" },
						]),
					},
				} as never,
				{ expected, sections: [{ key: "movies", uuid: "movies-uuid", type: "movie" }] },
			),
		).resolves.toMatchObject({ ok: false, reason: "target_ledger_unavailable" });
	});

	it("uses NULLS FIRST canonical DB order for mixed nullable TVDB identities", async () => {
		const module = await ledger();
		const targets = [
			{ ...target, ratingKey: "null-tvdb", tvdbId: null },
			{ ...target, ratingKey: "tvdb-7", tvdbId: 7 },
		];
		const expected = {
			instanceId: "plex-1",
			generationId: "generation-1",
			connectionGeneration: 1,
			identityGeneration: 1,
			...module.createPlexTargetLedgerBinding({
				instanceId: "plex-1",
				generationId: "generation-1",
				connectionGeneration: 1,
				identityGeneration: 1,
				targets,
			}),
		};
		const findMany = vi
			.fn()
			.mockResolvedValue(targets.map((entry, index) => ({ id: `${index}`, ...entry })));

		await expect(
			module.verifyPersistedPlexGenerationTargets({ plexGenerationTarget: { findMany } } as never, {
				expected,
				sections: [{ key: "movies", uuid: "movies-uuid", type: "movie" }],
			}),
		).resolves.toEqual({ ok: true });
		expect(findMany.mock.calls[0]?.[0].orderBy).toContainEqual({
			tvdbId: { sort: "asc", nulls: "first" },
		});
	});
});
