import { afterEach, describe, expect, it, vi } from "vitest";
import type { Encryptor } from "../../auth/encryption.js";
import type { PrismaClient } from "../../prisma.js";
import { TargetWatchReadBudget } from "../target-watch-read-budget.js";

const nativeCatalog = vi.hoisted(() => ({
	value: {
		status: "available" as const,
		complete: true,
		freshness: "current" as const,
		generationId: "native-generation-1",
		observedAt: new Date("2026-09-15T11:00:00.000Z"),
		rows: [
			{
				nativeId: "movie-1",
				mediaType: "movie" as "movie" | "series",
				libraryIds: ["movies"],
				parentNativeId: null,
				seasonNumber: null,
				episodeNumber: null,
				title: "Movie",
				externalIds: { tmdb: [42] },
			},
		],
	},
}));
const fixtureMode = vi.hoisted(() => ({ value: "movie" as "movie" | "series" }));
vi.mock("../../provider-observation/inventory-connection-repository.js", () => ({
	readCompleteNativeLibrary: vi.fn(async () => nativeCatalog.value),
}));

import {
	readTautulliTargetWatchEvidence,
	revalidateTautulliTargetWatchEvidence,
} from "../tautulli-target-watch-evidence.js";

const userId = "user-1";
const plexId = "plex-1";
const tautulliId = "tautulli-1";
const machineId = "pms-machine-1";
const plex = {
	id: plexId,
	userId,
	service: "PLEX",
	label: "Plex",
	baseUrl: "http://plex.test",
	enabled: true,
	encryptedApiKey: "plex-key",
	encryptionIv: "plex-iv",
	encryptedHttpAuthCredentials: null,
	httpAuthEncryptionIv: null,
	connectionGeneration: 4,
	identityGeneration: 8,
	expectedIdentity: machineId,
	identityKind: "PLEX_MACHINE_IDENTIFIER",
	identityStatus: "VERIFIED",
} as const;

const tautulli = {
	id: tautulliId,
	userId,
	service: "TAUTULLI",
	label: "Tautulli",
	baseUrl: "http://tautulli.test",
	enabled: true,
	encryptedApiKey: "tautulli-key",
	encryptionIv: "tautulli-iv",
	encryptedHttpAuthCredentials: null,
	httpAuthEncryptionIv: null,
	connectionGeneration: 3,
	identityGeneration: 7,
	expectedIdentity: machineId,
	identityKind: "TAUTULLI_PMS_IDENTIFIER",
	identityStatus: "VERIFIED",
} as const;

function jsonResponse(value: unknown): Response {
	return new Response(JSON.stringify(value), {
		status: 200,
		headers: { "content-type": "application/json" },
	});
}

function providerResponse(
	provider: "plex" | "tautulli",
	path: string,
	command?: string,
	host = "",
): Response {
	if (provider === "plex" && path === "/identity") {
		return jsonResponse({
			MediaContainer: {
				machineIdentifier: host === "plex-unrelated.test" ? "other-machine" : machineId,
				version: "1",
			},
		});
	}
	if (provider === "plex" && path === "/library/sections") {
		return jsonResponse({
			MediaContainer: {
				offset: 0,
				size: 1,
				totalSize: 1,
				Directory: [{ key: "movies", title: "Movies", type: "movie" }],
			},
		});
	}
	if (provider === "plex" && path === "/library/sections/movies/all") {
		return jsonResponse({
			MediaContainer: {
				offset: 0,
				size: 1,
				totalSize: 1,
				Metadata: [
					fixtureMode.value === "movie"
						? { ratingKey: "movie-1", type: "movie", title: "Movie", Guid: [{ id: "tmdb://42" }] }
						: { ratingKey: "show-1", type: "show", title: "Show", Guid: [{ id: "tmdb://42" }] },
				],
			},
		});
	}
	if (
		provider === "plex" &&
		(path === "/library/metadata/movie-1" ||
			path === "/library/metadata/show-1" ||
			path === "/library/metadata/episode-1")
	) {
		const episode = path.endsWith("episode-1");
		return jsonResponse({
			MediaContainer: {
				Metadata: [
					{
						ratingKey: episode ? "episode-1" : fixtureMode.value === "movie" ? "movie-1" : "show-1",
						type: episode ? "episode" : fixtureMode.value === "movie" ? "movie" : "show",
						guid: episode
							? "plex://episode/1"
							: fixtureMode.value === "movie"
								? "plex://movie/1"
								: "plex://show/1",
						Guid: [{ id: "tmdb://42" }],
						librarySectionID: "movies",
						...(episode ? { parentRatingKey: "season-1", grandparentRatingKey: "show-1" } : {}),
					},
				],
			},
		});
	}
	if (provider === "tautulli" && path === "/api/v2" && command === "get_server_info") {
		return jsonResponse({
			response: {
				result: "success",
				message: null,
				data: { pms_identifier: machineId, pms_name: "Plex" },
			},
		});
	}
	if (provider === "tautulli" && path === "/api/v2" && command === "get_history") {
		return jsonResponse({
			response: {
				result: "success",
				message: null,
				data: {
					data: [
						...([3, 2, 1] as const).map((row_id, index) => ({
							row_id,
							reference_id: index === 1 ? "reference-1" : `reference-${index + 1}`,
							rating_key: fixtureMode.value === "movie" ? "movie-1" : "episode-1",
							parent_rating_key: fixtureMode.value === "movie" ? "0" : "season-1",
							grandparent_rating_key: fixtureMode.value === "movie" ? "0" : "show-1",
							guid: fixtureMode.value === "movie" ? "plex://movie/1" : "plex://episode/1",
							stopped: 1_700_000_000 + row_id,
							section_id: "movies",
							media_type: fixtureMode.value === "movie" ? "movie" : "episode",
						})),
					],
					recordsFiltered: 3,
					recordsTotal: 3,
				},
			},
		});
	}
	throw new Error(`unexpected fixture request ${provider}:${path}`);
}

function setup() {
	const findMany = vi.fn().mockResolvedValue([tautulli, plex]);
	const cacheFindMany = vi.fn().mockRejectedValue(new Error("cache unavailable"));
	const prisma = {
		serviceInstance: { findMany },
		tautulliCache: {
			findMany: cacheFindMany,
		},
	} as unknown as PrismaClient;
	const encryptor = {
		decrypt: vi.fn(({ value }: { value: string }) => value),
	} as unknown as Encryptor;
	const fetchMock = vi.fn().mockImplementation(async (request: string | URL) => {
		const url = new URL(String(request));
		return providerResponse(
			url.hostname.startsWith("plex") ? "plex" : "tautulli",
			url.pathname,
			url.searchParams.get("cmd") ?? undefined,
			url.hostname,
		);
	});
	vi.stubGlobal("fetch", fetchMock);
	return { prisma, encryptor, fetchMock, findMany, cacheFindMany };
}

afterEach(() => {
	vi.unstubAllGlobals();
	vi.clearAllMocks();
	fixtureMode.value = "movie";
	nativeCatalog.value.rows = [
		{
			nativeId: "movie-1",
			mediaType: "movie",
			libraryIds: ["movies"],
			parentNativeId: null,
			seasonNumber: null,
			episodeNumber: null,
			title: "Movie",
			externalIds: { tmdb: [42] },
		},
	];
	nativeCatalog.value.generationId = "native-generation-1";
	nativeCatalog.value.observedAt = new Date("2026-09-15T11:00:00.000Z");
});

describe("Tautulli target watch evidence", () => {
	it("bounds 200 series with 100 historical episodes each and shares the operation limit across batches", async () => {
		const { prisma, encryptor, fetchMock } = setup();
		const targets = Array.from({ length: 200 }, (_, index) => ({
			mediaType: "series" as const,
			tmdbId: index + 42,
		}));
		nativeCatalog.value.rows = targets.map((target, index) => ({
			nativeId: `show-${index}`,
			mediaType: "series",
			libraryIds: ["movies"],
			parentNativeId: null,
			seasonNumber: null,
			episodeNumber: null,
			title: "Fixture",
			externalIds: { tmdb: [target.tmdbId] },
		}));
		fetchMock.mockImplementation(async (request: string | URL) => {
			const url = new URL(String(request));
			if (url.pathname.startsWith("/library/metadata/")) {
				const keys = decodeURIComponent(url.pathname.slice("/library/metadata/".length)).split(",");
				expect(keys.length).toBeLessThanOrEqual(100);
				return jsonResponse({
					MediaContainer: {
						Metadata: keys.map((ratingKey) => {
							const index = Number(ratingKey.split("-")[1]);
							const episode = ratingKey.startsWith("episode-");
							return {
								ratingKey,
								type: episode ? "episode" : "show",
								guid: `plex://${ratingKey}`,
								Guid: [{ id: `tmdb://${index + 42}` }],
								librarySectionID: "movies",
								...(episode
									? { parentRatingKey: `season-${index}`, grandparentRatingKey: `show-${index}` }
									: {}),
							};
						}),
					},
				});
			}
			if (url.searchParams.get("cmd") === "get_history") {
				const show = url.searchParams.get("grandparent_rating_key")!;
				const index = Number(show.split("-")[1]);
				return jsonResponse({
					response: {
						result: "success",
						message: null,
						data: {
							data: Array.from({ length: 100 }, (_, episode) => ({
								row_id: index * 100 + episode + 1,
								reference_id: index * 100 + episode + 1,
								rating_key: `episode-${index}-${episode}`,
								grandparent_rating_key: show,
								parent_rating_key: `season-${index}`,
								guid: `plex://episode-${index}-${episode}`,
								stopped: 1_700_000_000,
								media_type: "episode",
							})),
							recordsFiltered: 100,
							recordsTotal: 20_000,
						},
					},
				});
			}
			return providerResponse(
				url.hostname.startsWith("plex") ? "plex" : "tautulli",
				url.pathname,
				url.searchParams.get("cmd") ?? undefined,
			);
		});
		const readBudget = new TargetWatchReadBudget(1_100);
		const input = {
			prisma,
			encryptor,
			userId,
			targets,
			now: new Date("2026-09-15T12:00:00.000Z"),
			readBudget,
		};
		const first = await readTautulliTargetWatchEvidence(input);
		expect(first).toHaveLength(200);
		expect(first.every((proof) => proof.observedValue === 99)).toBe(true);
		expect(fetchMock).toHaveBeenCalledTimes(406);
		expect(await readTautulliTargetWatchEvidence(input)).toHaveLength(200);
		expect(await readTautulliTargetWatchEvidence(input)).toEqual([]);
		expect(readBudget.exhausted).toBe(true);
		expect(readBudget.requestsUsed).toBeLessThanOrEqual(825);
		expect(fetchMock.mock.calls.length).toBeLessThanOrEqual(825);
		const count = fetchMock.mock.calls.length;
		expect(await readTautulliTargetWatchEvidence(input)).toEqual([]);
		expect(fetchMock).toHaveBeenCalledTimes(count);
	});

	it.each([false, true])(
		"binds standard history rows and rejects a conflicting returned section (conflict=%s)",
		async (conflict) => {
			const { prisma, encryptor, fetchMock } = setup();
			fetchMock.mockImplementation(async (request: string | URL) => {
				const url = new URL(String(request));
				const response = providerResponse(
					url.hostname.startsWith("plex") ? "plex" : "tautulli",
					url.pathname,
					url.searchParams.get("cmd") ?? undefined,
				);
				if (url.searchParams.get("cmd") !== "get_history") return response;
				expect(url.searchParams.get("section_id")).toBe("movies");
				const body = await response.json();
				for (const row of body.response.data.data) {
					row.reference_id = row.reference_id === "reference-1" ? 1 : 3;
					row.parent_rating_key = null;
					row.grandparent_rating_key = "";
					if (conflict) row.section_id = "other-section";
					else delete row.section_id;
				}
				return jsonResponse(body);
			});
			const proofs = await readTautulliTargetWatchEvidence({
				prisma,
				encryptor,
				userId,
				targets: [{ mediaType: "movie", tmdbId: 42 }],
				now: new Date("2026-09-15T12:00:00.000Z"),
			});
			expect(proofs).toHaveLength(conflict ? 0 : 1);
			if (!conflict) expect(proofs[0]?.observedValue).toBe(2);
		},
	);

	it("counts positive completed plays once per reference ID and returns a bound proof", async () => {
		const { prisma, encryptor, fetchMock, cacheFindMany } = setup();
		const result = await readTautulliTargetWatchEvidence({
			prisma,
			encryptor,
			userId,
			targets: [{ mediaType: "movie", tmdbId: 42 }],
			now: new Date("2026-09-15T12:00:00.000Z"),
		});

		expect(result, JSON.stringify(fetchMock.mock.calls)).toHaveLength(1);
		expect(result[0]).toMatchObject({
			userId,
			instanceId: tautulliId,
			plexInstanceId: plexId,
			mediaType: "movie",
			tmdbId: 42,
			observedValue: 2,
			providerStatus: expect.objectContaining({
				availability: "current",
				evidence: "positive-only",
				domains: [
					expect.objectContaining({ domain: "watch-count", valueSemantics: "lower-bound" }),
				],
			}),
		});
		expect(result[0]!.generationId).toMatch(/^[a-f0-9]{64}$/);
		expect(result[0]!.coordinate).toMatch(/^[a-f0-9]{64}$/);
		expect(fetchMock).toHaveBeenCalled();
		expect(cacheFindMany).not.toHaveBeenCalled();
		const requestUrls = fetchMock.mock.calls.map(([request]) => new URL(String(request)));
		expect(requestUrls.filter((url) => url.searchParams.get("cmd") === "get_history")).toHaveLength(
			1,
		);
		expect(requestUrls.filter((url) => url.pathname.startsWith("/library/metadata/"))).toHaveLength(
			1,
		);
	});

	it("fails closed when the history GUID is for a recycled rating key", async () => {
		const { prisma, encryptor } = setup();
		const originalFetch = globalThis.fetch;
		vi.stubGlobal(
			"fetch",
			vi.fn().mockImplementation(async (request: string | URL) => {
				const url = new URL(String(request));
				if (url.hostname === "tautulli.test") {
					const response = providerResponse(
						"tautulli",
						url.pathname,
						url.searchParams.get("cmd") ?? undefined,
					);
					const body = (await response.json()) as {
						response: { data: { data: Array<Record<string, unknown>> } };
					};
					body.response.data.data[0]!.guid = "plex://movie/recycled";
					return jsonResponse(body);
				}
				return originalFetch(request);
			}),
		);

		expect(
			await readTautulliTargetWatchEvidence({
				prisma,
				encryptor,
				userId,
				targets: [{ mediaType: "movie", tmdbId: 42 }],
			}),
		).toEqual([]);
	});

	it("keeps unavailable history unknown when the live prefix has no rows", async () => {
		const { prisma, encryptor, fetchMock } = setup();
		fetchMock.mockImplementation(async (request: string | URL) => {
			const url = new URL(String(request));
			const response = providerResponse(
				url.hostname.startsWith("plex") ? "plex" : "tautulli",
				url.pathname,
				url.searchParams.get("cmd") ?? undefined,
				url.hostname,
			);
			if (url.hostname !== "tautulli.test" || url.searchParams.get("cmd") !== "get_history") {
				return response;
			}
			const body = (await response.json()) as {
				response: { data: { data: unknown[]; recordsFiltered: number; recordsTotal: number } };
			};
			body.response.data = { data: [], recordsFiltered: 0, recordsTotal: 0 };
			return jsonResponse(body);
		});
		await expect(
			readTautulliTargetWatchEvidence({
				prisma,
				encryptor,
				userId,
				targets: [{ mediaType: "movie", tmdbId: 42 }],
			}),
		).resolves.toEqual([]);
	});

	it("binds series plays to each episode's current Plex GUID and ancestry", async () => {
		fixtureMode.value = "series";
		nativeCatalog.value.rows = [
			{
				nativeId: "show-1",
				mediaType: "series",
				libraryIds: ["movies"],
				parentNativeId: null,
				seasonNumber: null,
				episodeNumber: null,
				title: "Show",
				externalIds: { tmdb: [42] },
			},
		];
		const { prisma, encryptor } = setup();
		const result = await readTautulliTargetWatchEvidence({
			prisma,
			encryptor,
			userId,
			targets: [{ mediaType: "series", tmdbId: 42 }],
		});
		expect(result).toHaveLength(1);
		expect(result[0]).toMatchObject({ mediaType: "series", observedValue: 2 });
	});

	it("fails closed for a different owner and a changed native generation", async () => {
		const { prisma, encryptor } = setup();
		await expect(
			readTautulliTargetWatchEvidence({
				prisma,
				encryptor,
				userId: "other-owner",
				targets: [{ mediaType: "movie", tmdbId: 42 }],
			}),
		).resolves.toEqual([]);
		const first = await readTautulliTargetWatchEvidence({
			prisma,
			encryptor,
			userId,
			targets: [{ mediaType: "movie", tmdbId: 42 }],
		});
		nativeCatalog.value.generationId = "native-generation-2";
		await expect(
			revalidateTautulliTargetWatchEvidence({
				prisma,
				encryptor,
				userId,
				instanceId: tautulliId,
				mediaType: "movie",
				tmdbId: 42,
				coordinate: first[0]!.coordinate,
				generationId: first[0]!.generationId,
				threshold: 0,
			}),
		).resolves.toBe(false);
	});

	it("rejects stale native catalogs and conflicting native target rows", async () => {
		const { prisma, encryptor } = setup();
		nativeCatalog.value.observedAt = new Date("2026-09-01T12:00:00.000Z");
		await expect(
			readTautulliTargetWatchEvidence({
				prisma,
				encryptor,
				userId,
				targets: [{ mediaType: "movie", tmdbId: 42 }],
				now: new Date("2026-09-15T12:00:00.000Z"),
				maxAgeMs: 60 * 60 * 1000,
			}),
		).resolves.toEqual([]);
		nativeCatalog.value.observedAt = new Date("2026-09-15T11:00:00.000Z");
		nativeCatalog.value.rows.push({
			nativeId: "movie-duplicate",
			mediaType: "movie",
			libraryIds: ["movies"],
			parentNativeId: null,
			seasonNumber: null,
			episodeNumber: null,
			title: "Duplicate",
			externalIds: { tmdb: [42] },
		});
		await expect(
			readTautulliTargetWatchEvidence({
				prisma,
				encryptor,
				userId,
				targets: [{ mediaType: "movie", tmdbId: 42 }],
			}),
		).resolves.toEqual([]);
	});

	it("fails closed on provider failure and rejects an over-bounded target batch", async () => {
		const { prisma, encryptor, fetchMock } = setup();
		fetchMock.mockRejectedValue(new Error("provider unavailable"));
		await expect(
			readTautulliTargetWatchEvidence({
				prisma,
				encryptor,
				userId,
				targets: [{ mediaType: "movie", tmdbId: 42 }],
			}),
		).resolves.toEqual([]);
		const callsAfterProviderFailure = fetchMock.mock.calls.length;
		const boundedTargets = Array.from({ length: 201 }, (_, index) => ({
			mediaType: "movie" as const,
			tmdbId: index + 1,
		}));
		await expect(
			readTautulliTargetWatchEvidence({
				prisma,
				encryptor,
				userId,
				targets: boundedTargets,
			}),
		).resolves.toEqual([]);
		expect(fetchMock).toHaveBeenCalledTimes(callsAfterProviderFailure);
	});

	it("accepts one matching Plex alongside an independently verified unrelated Plex", async () => {
		const { prisma, encryptor, findMany } = setup();
		findMany.mockResolvedValue([
			tautulli,
			plex,
			{
				...plex,
				id: "plex-unrelated",
				label: "Other Plex",
				baseUrl: "http://plex-unrelated.test",
				expectedIdentity: "other-machine",
			},
		]);
		const result = await readTautulliTargetWatchEvidence({
			prisma,
			encryptor,
			userId,
			targets: [{ mediaType: "movie", tmdbId: 42 }],
		});
		expect(result).toHaveLength(1);
		expect(result[0]).toMatchObject({ instanceId: tautulliId, plexInstanceId: plexId });
	});

	it("fails closed when a matching Plex enrollment is unverified", async () => {
		const { prisma, encryptor, findMany } = setup();
		findMany.mockResolvedValue([tautulli, { ...plex, identityStatus: "MISMATCH" as const }]);
		await expect(
			readTautulliTargetWatchEvidence({
				prisma,
				encryptor,
				userId,
				targets: [{ mediaType: "movie", tmdbId: 42 }],
			}),
		).resolves.toEqual([]);
	});

	it("fails closed when a second matching Plex instance appears before final fencing", async () => {
		const { prisma, encryptor, findMany } = setup();
		let reads = 0;
		findMany.mockImplementation(async () => {
			reads += 1;
			return reads === 1
				? [tautulli, plex]
				: [tautulli, plex, { ...plex, id: "plex-2", label: "Plex duplicate" }];
		});
		await expect(
			readTautulliTargetWatchEvidence({
				prisma,
				encryptor,
				userId,
				targets: [{ mediaType: "movie", tmdbId: 42 }],
			}),
		).resolves.toEqual([]);
	});

	it("fails closed when provider identity generation drifts before final fencing", async () => {
		const { prisma, encryptor, findMany } = setup();
		let reads = 0;
		findMany.mockImplementation(async () => {
			reads += 1;
			return reads === 1 ? [tautulli, plex] : [{ ...tautulli, identityGeneration: 8 }, plex];
		});
		await expect(
			readTautulliTargetWatchEvidence({
				prisma,
				encryptor,
				userId,
				targets: [{ mediaType: "movie", tmdbId: 42 }],
			}),
		).resolves.toEqual([]);
	});

	it("re-reads the same generation and coordinate before accepting a threshold", async () => {
		const { prisma, encryptor } = setup();
		const first = await readTautulliTargetWatchEvidence({
			prisma,
			encryptor,
			userId,
			targets: [{ mediaType: "movie", tmdbId: 42 }],
		});
		const proof = first[0]!;
		await expect(
			revalidateTautulliTargetWatchEvidence({
				prisma,
				encryptor,
				userId,
				instanceId: tautulliId,
				mediaType: "movie",
				tmdbId: 42,
				coordinate: proof.coordinate,
				generationId: proof.generationId,
				threshold: 1,
			}),
		).resolves.toBe(true);
		await expect(
			revalidateTautulliTargetWatchEvidence({
				prisma,
				encryptor,
				userId,
				instanceId: tautulliId,
				mediaType: "movie",
				tmdbId: 42,
				coordinate: "0".repeat(64),
				generationId: proof.generationId,
				threshold: 2,
			}),
		).resolves.toBe(false);
	});
});
