import { describe, expect, it, vi } from "vitest";
import type { PlexCanonicalObservation } from "../plex-canonical-projection.js";
import {
	plexEpisodeParentAuthorityChanged,
	PlexAuthorityService,
	PlexAuthorityUnavailableError,
	settlePlexAuthorityWindow,
	type PlexPersistedSelectionObservation,
} from "../plex-authority-service.js";

const section = {
	key: "movies",
	uuid: "movies-uuid",
	title: "Movies",
	type: "movie" as const,
	refreshing: false as const,
	scannedAt: 1_777_000_000,
	updatedAt: 1_777_000_100,
};
const musicSection = {
	key: "music",
	uuid: "music-uuid",
	title: "Music",
	type: "artist",
	refreshing: false,
	scannedAt: 1_777_000_000,
	updatedAt: 1_777_000_100,
};
const rowA: PlexCanonicalObservation = {
	sectionId: "movies",
	sectionTitle: "Movies",
	mediaType: "movie",
	tmdbId: 1,
	ratingKey: "101",
	title: "A",
	labels: ["Keep"],
	collections: [],
	watchCount: 1,
	watchedByUsers: ["admin"],
	lastWatchedAt: "2026-08-20T12:00:00.000Z",
	onDeck: false,
	userRating: null,
	addedAt: null,
	thumb: null,
};
const rowB: PlexCanonicalObservation = {
	...rowA,
	tmdbId: 2,
	ratingKey: "102",
	title: "B",
	labels: ["Other"],
	watchCount: 0,
	watchedByUsers: [],
	lastWatchedAt: null,
};

function persisted(
	overrides: Partial<PlexPersistedSelectionObservation> = {},
): PlexPersistedSelectionObservation {
	return {
		generationId: "generation-1",
		connectionGeneration: 4,
		identityGeneration: 9,
		providerIdentity: "plex-machine-a",
		metadata: {
			version: 3,
			publicationLevel: "authoritative",
			completeness: "complete",
			itemCount: 2,
			canonicalizationVersion: 1,
			sections: [section],
			roots: [{ sectionKey: "movies", domain: "membership", digest: "a".repeat(64) }],
		},
		rows: [rowA, rowB],
		...overrides,
	};
}

function probe(overrides: Record<string, unknown> = {}) {
	return {
		activities: [],
		sections: [section, musicSection],
		...overrides,
	};
}

async function settle(
	input: {
		persisted?: PlexPersistedSelectionObservation;
		probes?: Array<ReturnType<typeof probe> | Error>;
		fresh?: PlexCanonicalObservation[][];
		reread?: PlexPersistedSelectionObservation;
		selection?:
			| { kind: "all" }
			| { kind: "targets"; targets: Array<{ mediaType: string; tmdbId: number }> };
		domains?: Array<"membership" | "labels" | "watch">;
		mutation?: boolean;
		requireCompleteSectionCatalog?: boolean;
	} = {},
) {
	const before = input.persisted ?? persisted();
	const probes = [...(input.probes ?? [probe(), probe(), probe()])];
	const fresh = [
		...(input.fresh ?? [
			[rowA, rowB],
			[rowA, rowB],
		]),
	];
	return await settlePlexAuthorityWindow({
		persisted: before,
		selection: input.selection ?? { kind: "all" },
		domains: input.domains ?? ["membership", "labels", "watch"],
		selectedSectionKeys: ["movies"],
		mutation: input.mutation ?? false,
		requireCompleteSectionCatalog: input.requireCompleteSectionCatalog ?? false,
		loadProbe: vi.fn(async () => {
			const value = probes.shift();
			if (value instanceof Error) throw value;
			return value ?? probe();
		}),
		loadFreshRows: vi.fn(async () => fresh.shift() ?? [rowA, rowB]),
		rereadPersisted: vi.fn(async () => input.reread ?? before),
	});
}

describe("PlexAuthorityService settlement window", () => {
	it.each([
		[
			1,
			{
				version: 1,
				publicationLevel: "authoritative",
				completeness: "complete",
				itemCount: null,
				sections: [{ key: "movies", title: "Movies", type: "movie" }],
			},
		],
		[
			2,
			{
				version: 2,
				publicationLevel: "authoritative",
				completeness: "complete",
				itemCount: 2,
				sections: [{ key: "movies", title: "Movies", type: "movie" }],
			},
		],
	] as const)("%s. legacy metadata cannot authorize exact evidence", async (_case, metadata) => {
		await expect(
			settle({ persisted: persisted({ metadata: structuredClone(metadata) as never }) }),
		).resolves.toMatchObject({
			ok: false,
			reasonCode: "plex_settlement_metadata_missing",
		});
	});

	it("3. settled unchanged V3 becomes authoritative", async () => {
		await expect(settle()).resolves.toMatchObject({
			ok: true,
			persisted: { generationId: "generation-1" },
		});
	});

	it("4. a relevant section scan is unavailable", async () => {
		await expect(
			settle({
				probes: [
					probe({
						activities: [
							{ type: "library.update.section", Context: { librarySectionID: "movies" } },
						],
					}),
				],
			}),
		).resolves.toMatchObject({ ok: false, reasonCode: "plex_library_scan_in_progress" });
	});

	it("5. a refreshing selected section is unavailable", async () => {
		await expect(
			settle({ probes: [probe({ sections: [{ ...section, refreshing: true }, musicSection] })] }),
		).resolves.toMatchObject({ ok: false, reasonCode: "plex_library_scan_in_progress" });
	});

	it("6. unattributable metadata activity blocks the instance", async () => {
		await expect(
			settle({ probes: [probe({ activities: [{ type: "library.update.item.metadata" }] })] }),
		).resolves.toMatchObject({ ok: false, reasonCode: "plex_metadata_refresh_in_progress" });
	});

	it("7. an attributed music scan does not invalidate Movie authority", async () => {
		await expect(
			settle({
				probes: [
					probe({
						activities: [
							{ type: "library.update.section", Context: { librarySectionID: "music" } },
						],
					}),
					probe(),
					probe(),
				],
			}),
		).resolves.toMatchObject({ ok: true });
	});

	it("8. activities failure is unavailable", async () => {
		await expect(
			settle({ probes: [new PlexAuthorityUnavailableError("plex_activity_unavailable")] }),
		).resolves.toMatchObject({ ok: false, reasonCode: "plex_activity_unavailable" });
	});

	it("9. section-state failure is unavailable", async () => {
		await expect(
			settle({ probes: [new PlexAuthorityUnavailableError("plex_section_state_unavailable")] }),
		).resolves.toMatchObject({ ok: false, reasonCode: "plex_section_state_unavailable" });
	});

	it("10. section UUID change is unavailable", async () => {
		await expect(
			settle({
				probes: [probe(), probe({ sections: [{ ...section, uuid: "changed" }, musicSection] })],
			}),
		).resolves.toMatchObject({ ok: false, reasonCode: "plex_library_revision_changed" });
	});

	it("11. a scan that starts after publication is unavailable", async () => {
		await expect(
			settle({
				probes: [
					probe({
						activities: [
							{ type: "library.update.section", Context: { librarySectionID: "movies" } },
						],
					}),
				],
			}),
		).resolves.toMatchObject({ ok: false });
	});

	it("12. a missed completed scan with changed content is unavailable", async () => {
		await expect(settle({ fresh: [[rowA], [rowA]] })).resolves.toMatchObject({
			ok: false,
			reasonCode: "plex_content_digest_changed",
		});
	});

	it("13. same-second scannedAt cannot hide deletion", async () => {
		await expect(
			settle({ probes: [probe(), probe(), probe()], fresh: [[rowA], [rowA]] }),
		).resolves.toMatchObject({ ok: false, reasonCode: "plex_content_digest_changed" });
	});

	it("14. a completed no-op scan may regain authority", async () => {
		await expect(
			settle({
				probes: [
					probe({ sections: [{ ...section, scannedAt: section.scannedAt + 1 }, musicSection] }),
					probe({ sections: [{ ...section, scannedAt: section.scannedAt + 1 }, musicSection] }),
					probe({ sections: [{ ...section, scannedAt: section.scannedAt + 1 }, musicSection] }),
				],
			}),
		).resolves.toMatchObject({ ok: true });
	});

	it("15. an addition invalidates the old generation", async () => {
		const added = { ...rowA, tmdbId: 3, ratingKey: "103", title: "Added" };
		await expect(
			settle({
				fresh: [
					[rowA, rowB, added],
					[rowA, rowB, added],
				],
			}),
		).resolves.toMatchObject({ ok: false, reasonCode: "plex_content_digest_changed" });
	});

	it("16. a legitimate deletion invalidates the old generation until refresh", async () => {
		await expect(settle({ fresh: [[rowA], [rowA]] })).resolves.toMatchObject({ ok: false });
	});

	it("17. provider identity change during the window is unavailable", async () => {
		await expect(
			settle({ reread: persisted({ providerIdentity: "plex-machine-b" }) }),
		).resolves.toMatchObject({ ok: false, reasonCode: "identity_generation_mismatch" });
	});

	it("18. connection generation change during the window is unavailable", async () => {
		await expect(settle({ reread: persisted({ connectionGeneration: 5 }) })).resolves.toMatchObject(
			{ ok: false, reasonCode: "connection_generation_mismatch" },
		);
	});

	it("19. persisted generation change during the window is unavailable", async () => {
		await expect(
			settle({ reread: persisted({ generationId: "generation-2" }) }),
		).resolves.toMatchObject({ ok: false, reasonCode: "generation_changed" });
	});

	it("20. preliminary and final live projections must match", async () => {
		await expect(
			settle({
				fresh: [
					[rowA, rowB],
					[{ ...rowA, labels: ["Changed"] }, rowB],
				],
			}),
		).resolves.toMatchObject({ ok: false, reasonCode: "plex_content_digest_changed" });
	});

	it("21. final live projection must equal the persisted selection", async () => {
		await expect(settle({ fresh: [[rowA], [rowA]] })).resolves.toMatchObject({
			ok: false,
			reasonCode: "plex_content_digest_changed",
		});
	});

	it("22. unrelated target label changes preserve selected target authority", async () => {
		await expect(
			settle({
				selection: { kind: "targets", targets: [{ mediaType: "movie", tmdbId: 1 }] },
				domains: ["membership", "labels"],
				fresh: [
					[rowA, { ...rowB, labels: ["Changed"] }],
					[rowA, { ...rowB, labels: ["Changed"] }],
				],
			}),
		).resolves.toMatchObject({ ok: true });
	});

	it("23. unrelated watch-domain changes preserve selected label authority", async () => {
		await expect(
			settle({
				domains: ["membership", "labels"],
				fresh: [
					[{ ...rowA, watchCount: 99 }, rowB],
					[{ ...rowA, watchCount: 99 }, rowB],
				],
			}),
		).resolves.toMatchObject({ ok: true });
	});

	it.each([1, 2] as const)("24. V%s cannot authorize a mutation", async (version) => {
		const metadata =
			version === 1
				? {
						version: 1 as const,
						publicationLevel: "authoritative" as const,
						completeness: "complete" as const,
						itemCount: null,
						sections: [{ key: "movies", title: "Movies", type: "movie" as const }],
					}
				: {
						version: 2 as const,
						publicationLevel: "authoritative" as const,
						completeness: "complete" as const,
						itemCount: 2,
						sections: [{ key: "movies", title: "Movies", type: "movie" as const }],
					};
		await expect(
			settle({ persisted: persisted({ metadata }), mutation: true }),
		).resolves.toMatchObject({ ok: false });
	});

	it("25. mutation cannot proceed while live settlement is unavailable", async () => {
		await expect(
			settle({
				mutation: true,
				probes: [probe({ activities: [{ type: "library.update.item.metadata" }] })],
			}),
		).resolves.toMatchObject({ ok: false, reasonCode: "plex_metadata_refresh_in_progress" });
	});

	it("26. makes the final live projection the terminal upstream observation", async () => {
		const events: string[] = [];
		const before = persisted();
		const result = await settlePlexAuthorityWindow({
			persisted: before,
			selection: { kind: "all" },
			domains: ["membership"],
			selectedSectionKeys: ["movies"],
			mutation: true,
			loadProbe: vi.fn(async () => {
				events.push("probe");
				return probe();
			}),
			loadFreshRows: vi.fn(async () => {
				events.push("fresh");
				return [rowA, rowB];
			}),
			rereadPersisted: vi.fn(async () => {
				events.push("reread");
				return before;
			}),
		});

		expect(result).toMatchObject({ ok: true });
		expect(events).toEqual(["probe", "fresh", "probe", "probe", "fresh", "reread"]);
	});

	it("27. full section-catalog authority rejects a newly scanning supported section", async () => {
		const addedSection = {
			...section,
			key: "new-movies",
			uuid: "new-movies-uuid",
			title: "New Movies",
		};
		await expect(
			settle({
				requireCompleteSectionCatalog: true,
				probes: [
					probe({
						activities: [
							{
								type: "library.update.section",
								Context: { librarySectionID: "new-movies" },
							},
						],
						sections: [section, addedSection, musicSection],
					}),
				],
			}),
		).resolves.toMatchObject({ ok: false, reasonCode: "plex_library_scan_in_progress" });
	});

	it("28. full section-catalog authority rejects a newly idle supported section", async () => {
		const addedSection = {
			...section,
			key: "new-movies",
			uuid: "new-movies-uuid",
			title: "New Movies",
		};
		await expect(
			settle({
				requireCompleteSectionCatalog: true,
				probes: [probe({ sections: [section, addedSection, musicSection] })],
			}),
		).resolves.toMatchObject({ ok: false, reasonCode: "plex_library_revision_changed" });
	});

	it("29. episode parent comparison detects a changed live parent fixed point", () => {
		const after = {
			...persisted(),
			rows: [{ ...rowA, ratingKey: "changed-parent" }, rowB],
		};
		expect(
			plexEpisodeParentAuthorityChanged(persisted(), after, [{ tmdbId: 1, mediaType: "movie" }]),
		).toBe("plex_content_digest_changed");
	});

	it("30. a selected target with multiple live provider identities fails closed", async () => {
		const edition = { ...rowA, ratingKey: "edition-2" };
		await expect(
			settle({
				selection: { kind: "targets", targets: [{ mediaType: "movie", tmdbId: 1 }] },
				domains: ["membership"],
				fresh: [
					[rowA, edition, rowB],
					[rowA, edition, rowB],
				],
			}),
		).resolves.toMatchObject({ ok: false, reasonCode: "plex_content_digest_changed" });
	});

	it("31. the all-episodes path rejects a show added after its initial parent fixed point", async () => {
		const initialParent = {
			available: true,
			instanceId: "plex-1",
			instanceName: "Plex",
			generationId: "parent-1",
			publishedAt: new Date("2026-08-20T12:00:00.000Z"),
			itemCount: 1,
			connectionGeneration: 4,
			identityGeneration: 9,
			metadata: persisted().metadata,
			generationStatus: {},
			sections: [section],
			rows: [{ ...rowA, mediaType: "series" }],
			evidence: {
				availability: "current",
				authority: "current",
				attemptState: "success",
				publicationLevel: "authoritative",
				completeness: "complete",
				reasonCodes: [],
			},
		};
		const changedParent = {
			...initialParent,
			generationId: "parent-2",
			itemCount: 2,
			rows: [...initialParent.rows, { ...rowB, mediaType: "series", tmdbId: 3, ratingKey: "103" }],
		};
		const episodeEvidence = {
			...initialParent,
			generationId: "episode-1",
			parentGenerationId: "parent-1",
			rows: [],
		};
		const findFirst = vi.fn().mockResolvedValue({
			id: "plex-1",
			expectedIdentity: "plex-machine-a",
		});
		const service = new PlexAuthorityService({
			prisma: { serviceInstance: { findFirst } } as never,
			log: {} as never,
		});
		const readParent = vi
			.spyOn(service, "readInstance")
			.mockResolvedValueOnce(initialParent as never)
			.mockResolvedValueOnce(changedParent as never);
		vi.spyOn(service, "readInstanceSelectedEpisodes").mockResolvedValue(episodeEvidence as never);

		const result = await service.readInstanceEpisodes({
			userId: "user-1",
			instanceId: "plex-1",
		});

		expect(readParent).toHaveBeenCalledTimes(2);
		expect(result).toMatchObject({
			available: false,
			evidence: { reasonCodes: ["generation_changed"] },
		});
	});
});
