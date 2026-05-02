/**
 * arr-writer regression tests.
 *
 * Locks in the fix for issue #384 — Radarr/Sonarr's PUT endpoints reject
 * partial bodies with "'Quality Profile Id' must be greater than '0'".
 * The writer must fetch the full item via getById and spread it into the
 * update payload so every field the *arr validator expects is preserved.
 */

import type { FastifyBaseLogger } from "fastify";
import { describe, expect, it, vi } from "vitest";
import type { LabelSyncRuleInput } from "../../execute-rule.js";
import type { DestWriterOpts, MatchCandidate } from "../../strategy-types.js";
import { radarrDestWriter, sonarrDestWriter } from "../arr-writer.js";

const log = {
	child: vi.fn().mockReturnThis(),
	info: vi.fn(),
	warn: vi.fn(),
	error: vi.fn(),
	debug: vi.fn(),
	trace: vi.fn(),
	fatal: vi.fn(),
} as unknown as FastifyBaseLogger;

const fullMovie = (id: number, tags: number[] = []) => ({
	id,
	title: `Movie ${id}`,
	tmdbId: id,
	qualityProfileId: 1,
	monitored: true,
	hasFile: true,
	tags,
	rootFolderPath: "/movies",
	minimumAvailability: "released",
});

const fullSeries = (id: number, tags: number[] = []) => ({
	id,
	title: `Series ${id}`,
	tvdbId: id,
	tmdbId: id, // arr-writer matches by tmdbId across both movies and series
	qualityProfileId: 1,
	monitored: true,
	tags,
	rootFolderPath: "/tv",
	seasonFolder: true,
	languageProfileId: 1,
});

function makeRule(overrides: Partial<LabelSyncRuleInput> = {}): LabelSyncRuleInput {
	return {
		id: "rule-1",
		userId: "user-1",
		name: "kids → kids",
		sourceService: "PLEX",
		destService: "RADARR",
		sourceInstanceId: "src-1",
		destInstanceId: "dest-1",
		sourceTagName: "kids",
		destTagName: "kids",
		strategy: "label-to-tag",
		direction: "source-to-dest",
		excludeFilters: null,
		includeFilters: null,
		...overrides,
	} as LabelSyncRuleInput;
}

function makeMatch(tmdbId: number, mediaType: "series" | "movie" = "movie"): MatchCandidate {
	return { tmdbId, mediaType, title: `Item ${tmdbId}` };
}

function makeOpts(over: Partial<DestWriterOpts>): DestWriterOpts {
	return {
		rule: makeRule(),
		destInstance: {
			id: "dest-1",
			service: "RADARR",
			label: "Radarr",
			baseUrl: "http://radarr",
			encryptedApiKey: "x",
			encryptionIv: "y",
		} as DestWriterOpts["destInstance"],
		candidates: [makeMatch(100)],
		prisma: {} as DestWriterOpts["prisma"],
		arrClientFactory: {} as DestWriterOpts["arrClientFactory"],
		encryptor: {} as DestWriterOpts["encryptor"],
		log,
		...over,
	};
}

describe("radarrDestWriter — issue #384 regression", () => {
	it("fetches full movie via getById and spreads it into the update body", async () => {
		const movieGetById = vi.fn((id: number) => Promise.resolve(fullMovie(id)));
		const movieUpdate = vi.fn().mockResolvedValue({});
		const arrClient = {
			tag: {
				getAll: vi.fn().mockResolvedValue([{ id: 7, label: "kids" }]),
				create: vi.fn(),
			},
			movie: {
				getAll: vi.fn().mockResolvedValue([fullMovie(100)]),
				getById: movieGetById,
				update: movieUpdate,
			},
		};
		const arrClientFactory = {
			create: vi.fn().mockReturnValue(arrClient),
		} as unknown as DestWriterOpts["arrClientFactory"];

		const result = await radarrDestWriter.applyLabels(makeOpts({ arrClientFactory }));

		expect(result).toEqual({ matchesFound: 1, labelsApplied: 1, failures: 0 });
		expect(movieGetById).toHaveBeenCalledWith(100);

		// The update body MUST include qualityProfileId (or any other strict
		// field the *arr validator checks). The original bug sent only
		// { id, tags } which Radarr rejected.
		expect(movieUpdate).toHaveBeenCalledWith(
			100,
			expect.objectContaining({
				id: 100,
				tags: [7],
				qualityProfileId: 1,
				rootFolderPath: "/movies",
			}),
		);
	});

	it("merges new tag id into existing tags rather than replacing", async () => {
		const movieGetById = vi.fn(() => Promise.resolve(fullMovie(100, [3, 5])));
		const movieUpdate = vi.fn().mockResolvedValue({});
		const arrClient = {
			tag: {
				getAll: vi.fn().mockResolvedValue([{ id: 7, label: "kids" }]),
				create: vi.fn(),
			},
			movie: {
				getAll: vi.fn().mockResolvedValue([fullMovie(100, [3, 5])]),
				getById: movieGetById,
				update: movieUpdate,
			},
		};
		const arrClientFactory = {
			create: vi.fn().mockReturnValue(arrClient),
		} as unknown as DestWriterOpts["arrClientFactory"];

		await radarrDestWriter.applyLabels(makeOpts({ arrClientFactory }));

		expect(movieUpdate).toHaveBeenCalledWith(
			100,
			expect.objectContaining({
				id: 100,
				tags: [3, 5, 7],
			}),
		);
	});

	it("skips items already carrying the tag (idempotent)", async () => {
		const movieGetById = vi.fn();
		const movieUpdate = vi.fn();
		const arrClient = {
			tag: {
				getAll: vi.fn().mockResolvedValue([{ id: 7, label: "kids" }]),
				create: vi.fn(),
			},
			movie: {
				getAll: vi.fn().mockResolvedValue([fullMovie(100, [7])]),
				getById: movieGetById,
				update: movieUpdate,
			},
		};
		const arrClientFactory = {
			create: vi.fn().mockReturnValue(arrClient),
		} as unknown as DestWriterOpts["arrClientFactory"];

		const result = await radarrDestWriter.applyLabels(makeOpts({ arrClientFactory }));

		expect(result.labelsApplied).toBe(1);
		expect(movieGetById).not.toHaveBeenCalled();
		expect(movieUpdate).not.toHaveBeenCalled();
	});

	it("counts a failure (and continues) when getById or update throws", async () => {
		const movieGetById = vi.fn().mockRejectedValue(new Error("Quality Profile Id"));
		const movieUpdate = vi.fn();
		const arrClient = {
			tag: {
				getAll: vi.fn().mockResolvedValue([{ id: 7, label: "kids" }]),
				create: vi.fn(),
			},
			movie: {
				getAll: vi.fn().mockResolvedValue([fullMovie(100), fullMovie(200), fullMovie(300)]),
				getById: movieGetById,
				update: movieUpdate,
			},
		};
		const arrClientFactory = {
			create: vi.fn().mockReturnValue(arrClient),
		} as unknown as DestWriterOpts["arrClientFactory"];

		const result = await radarrDestWriter.applyLabels(
			makeOpts({
				arrClientFactory,
				candidates: [makeMatch(100), makeMatch(200), makeMatch(300)],
			}),
		);

		expect(result.matchesFound).toBe(3);
		expect(result.labelsApplied).toBe(0);
		expect(result.failures).toBe(3);
	});
});

describe("sonarrDestWriter — issue #384 regression", () => {
	it("uses the series accessor (getById + update) with the full series body", async () => {
		const seriesGetById = vi.fn((id: number) => Promise.resolve(fullSeries(id)));
		const seriesUpdate = vi.fn().mockResolvedValue({});
		const arrClient = {
			tag: {
				getAll: vi.fn().mockResolvedValue([{ id: 7, label: "kids" }]),
				create: vi.fn(),
			},
			series: {
				getAll: vi.fn().mockResolvedValue([fullSeries(100)]),
				getById: seriesGetById,
				update: seriesUpdate,
			},
		};
		const arrClientFactory = {
			create: vi.fn().mockReturnValue(arrClient),
		} as unknown as DestWriterOpts["arrClientFactory"];

		await sonarrDestWriter.applyLabels(
			makeOpts({
				arrClientFactory,
				destInstance: {
					id: "dest-2",
					service: "SONARR",
					label: "Sonarr",
					baseUrl: "http://sonarr",
					encryptedApiKey: "x",
					encryptionIv: "y",
				} as DestWriterOpts["destInstance"],
				candidates: [makeMatch(100, "series")],
				rule: makeRule({ destService: "SONARR" }),
			}),
		);

		expect(seriesGetById).toHaveBeenCalledWith(100);
		expect(seriesUpdate).toHaveBeenCalledWith(
			100,
			expect.objectContaining({
				id: 100,
				tags: [7],
				qualityProfileId: 1,
				rootFolderPath: "/tv",
			}),
		);
	});
});
