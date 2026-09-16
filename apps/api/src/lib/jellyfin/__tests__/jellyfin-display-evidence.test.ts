import type { ProviderObservationStatus } from "@arr/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	isArithmeticAuthoritativeProviderObservationStatus,
	readOwnedJellyfinEpisodeDisplaySources,
	readOwnedJellyfinLibraryDisplaySources,
} from "../jellyfin-display-evidence.js";
import type {
	JellyfinEpisodeObservation,
	JellyfinEpisodeRow,
	JellyfinLibraryObservation,
	JellyfinLibraryRow,
} from "../jellyfin-evidence-repository.js";

const repositoryMock = vi.hoisted(() => ({
	read: vi.fn(),
}));

vi.mock("../jellyfin-evidence-repository.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../jellyfin-evidence-repository.js")>()),
	readOwnedJellyfinObservation: repositoryMock.read,
}));

const now = new Date("2026-09-03T12:00:00.000Z");
const instances = [
	{ id: "jellyfin-1", label: "Library One", service: "JELLYFIN" as const },
	{ id: "emby-1", label: "Library Two", service: "EMBY" as const },
];

function status(
	availability: ProviderObservationStatus["availability"] = "current",
): ProviderObservationStatus {
	return {
		availability,
		evidence:
			availability === "current"
				? "complete"
				: availability === "partial"
					? "positive-only"
					: "unknown",
		observedAt: availability === "unavailable" ? null : now.toISOString(),
		ageSeconds: availability === "current" ? 0 : 60,
		latestAttempt: "successful" as const,
		reasonCodes:
			availability === "partial" ? (["positive-only", "coverage-incomplete"] as const) : [],
	};
}

function episodeStatusEnvelope(availability: "current" | "last-known") {
	return {
		availability,
		sources: [
			{
				instanceId: "jellyfin-1",
				service: "jellyfin" as const,
				cacheType: "jellyfin_episode" as const,
				status: {
					...status(availability),
					evidence: "complete" as const,
				},
			},
		],
	};
}

function libraryRow(instanceId: string, id = `${instanceId}-row`): JellyfinLibraryRow {
	return {
		id,
		instanceId,
		tmdbId: 42,
		mediaType: "movie",
		libraryId: "library-1",
		libraryName: "Movies",
		title: "Movie",
		jellyfinId: `${id}-provider`,
		lastWatchedAt: now,
		watchCount: 2,
		watchedByUsers: '["user-1"]',
		onDeck: true,
		userRating: 8,
		collections: "[]",
		addedAt: now,
		thumb: null,
		connectionGeneration: 1,
		identityGeneration: 1,
	};
}

function episodeRow(instanceId: string, id = `${instanceId}-episode`): JellyfinEpisodeRow {
	return {
		id,
		instanceId,
		showTmdbId: 42,
		seasonNumber: 1,
		episodeNumber: 1,
		jellyfinId: `${id}-provider`,
		title: "Episode",
		watched: true,
		watchedByUsers: '["user-1"]',
		lastWatchedAt: now,
		connectionGeneration: 1,
		identityGeneration: 1,
	};
}

function observation(
	instanceId: string,
	service: "JELLYFIN" | "EMBY",
	availability: "current" | "last-known" | "partial" = "current",
	rows: JellyfinLibraryRow[] = [libraryRow(instanceId)],
): JellyfinLibraryObservation {
	return {
		available: true,
		instanceId,
		service,
		cacheType: "jellyfin",
		generationId: "private-generation",
		publishedAt: now,
		metadata: null,
		rows,
		providerStatus: status(availability),
		mutationAvailable: false,
		authority: null,
	};
}

function episodeObservation(
	instanceId: string,
	service: "JELLYFIN" | "EMBY",
	availability: "current" | "last-known" | "partial" = "current",
	rows: JellyfinEpisodeRow[] = [episodeRow(instanceId)],
): JellyfinEpisodeObservation {
	return {
		available: availability !== "partial",
		instanceId,
		service,
		cacheType: "jellyfin_episode",
		generationId: "private-generation",
		publishedAt: now,
		metadata: null,
		rows,
		providerStatus: {
			...status(availability),
			evidence:
				availability === "current" || availability === "last-known" ? "complete" : "unknown",
		},
		mutationAvailable: false,
		authority: null,
	};
}

afterEach(() => vi.clearAllMocks());

describe("readOwnedJellyfinLibraryDisplaySources", () => {
	it("reads each owned source once in display mode with one shared now", async () => {
		repositoryMock.read
			.mockResolvedValueOnce(observation("jellyfin-1", "JELLYFIN"))
			.mockResolvedValueOnce(observation("emby-1", "EMBY"));

		const result = await readOwnedJellyfinLibraryDisplaySources({
			prisma: {} as never,
			userId: "user-1",
			instances,
			now,
			maxAgeMs: 1234,
		});

		expect(repositoryMock.read).toHaveBeenCalledTimes(2);
		expect(repositoryMock.read).toHaveBeenNthCalledWith(1, {
			prisma: {},
			userId: "user-1",
			instanceId: "jellyfin-1",
			cacheType: "jellyfin",
			mode: "display",
			now,
			maxAgeMs: 1234,
		});
		expect(repositoryMock.read).toHaveBeenNthCalledWith(2, {
			prisma: {},
			userId: "user-1",
			instanceId: "emby-1",
			cacheType: "jellyfin",
			mode: "display",
			now,
			maxAgeMs: 1234,
		});
		expect(result.sources).toHaveLength(2);
		expect(result.providerStatus).toMatchObject({
			availability: "current",
			sources: [
				{ instanceId: "emby-1", service: "emby", cacheType: "jellyfin" },
				{ instanceId: "jellyfin-1", service: "jellyfin", cacheType: "jellyfin" },
			],
		});
	});

	it("admits current, last-known, and positive-only partial rows", async () => {
		repositoryMock.read
			.mockResolvedValueOnce(observation("jellyfin-1", "JELLYFIN", "current"))
			.mockResolvedValueOnce(observation("emby-1", "EMBY", "last-known"))
			.mockResolvedValueOnce(observation("partial-1", "JELLYFIN", "partial"));

		const result = await readOwnedJellyfinLibraryDisplaySources({
			prisma: {} as never,
			userId: "user-1",
			instances: [
				...instances,
				{ id: "partial-1", label: "Partial", service: "JELLYFIN" as const },
			],
			now,
		});

		expect(result.sources.map((source) => source.rows.length)).toEqual([1, 1, 1]);
		expect(result.providerStatus?.availability).toBe("partial");
		expect(result.providerStatus?.sources).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					instanceId: "emby-1",
					status: expect.objectContaining({ availability: "last-known" }),
				}),
			]),
		);
		expect(result.providerStatus?.sources).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					instanceId: "partial-1",
					status: expect.objectContaining({
						availability: "partial",
						evidence: "positive-only",
					}),
				}),
			]),
		);
	});

	it("does not admit rows when V2 library inventory evidence is unknown", async () => {
		repositoryMock.read.mockResolvedValueOnce({
			...observation("jellyfin-1", "JELLYFIN", "partial"),
			providerStatus: {
				...status("partial"),
				domains: [
					{
						domain: "library-inventory",
						availability: "unavailable",
						evidence: "unknown",
						valueSemantics: "unknown",
						observedAt: null,
						reasonCodes: ["receipt-invalid" as const],
					},
				],
			},
		});

		const result = await readOwnedJellyfinLibraryDisplaySources({
			prisma: {} as never,
			userId: "user-1",
			instances: [instances[0]!],
			now,
		});

		expect(result.sources[0]?.rows).toEqual([]);
	});

	it("keeps null results as unavailable source slots without rows", async () => {
		repositoryMock.read.mockResolvedValueOnce(null).mockResolvedValueOnce(null);

		const result = await readOwnedJellyfinLibraryDisplaySources({
			prisma: {} as never,
			userId: "user-1",
			instances,
			now,
		});

		expect(result.sources).toEqual([
			{ instanceId: "jellyfin-1", instanceName: "Library One", rows: [] },
			{ instanceId: "emby-1", instanceName: "Library Two", rows: [] },
		]);
		expect(result.providerStatus).toMatchObject({
			availability: "unavailable",
			sources: [
				{
					instanceId: "emby-1",
					service: "emby",
					status: {
						availability: "unavailable",
						evidence: "unknown",
						observedAt: null,
						ageSeconds: null,
						latestAttempt: "idle",
						reasonCodes: ["unknown-failure"],
					},
				},
				{
					instanceId: "jellyfin-1",
					service: "jellyfin",
				},
			],
		});
	});

	it("omits status for an empty topology and does no repository reads", async () => {
		const result = await readOwnedJellyfinLibraryDisplaySources({
			prisma: {} as never,
			userId: "user-1",
			instances: [],
			now,
		});

		expect(result).toEqual({ sources: [], providerStatus: undefined });
		expect(repositoryMock.read).not.toHaveBeenCalled();
	});

	it("returns only sanitized public source data", async () => {
		repositoryMock.read.mockResolvedValueOnce({
			...observation("jellyfin-1", "JELLYFIN"),
			metadata: { scopeKey: "private-scope", credential: "private-secret" },
			authority: { generationId: "private-generation", rowFingerprint: "private-fingerprint" },
		});

		const result = await readOwnedJellyfinLibraryDisplaySources({
			prisma: {} as never,
			userId: "user-1",
			instances: [instances[0]!],
			now,
		});

		const encoded = JSON.stringify(result.providerStatus);
		expect(encoded).not.toMatch(
			/receipt|scopeKey|generationId|fingerprint|metadata|authority|credential|error/i,
		);
	});
});

describe("readOwnedJellyfinEpisodeDisplaySources", () => {
	it("reads each episode source once and admits current and complete last-known rows", async () => {
		repositoryMock.read
			.mockResolvedValueOnce(episodeObservation("jellyfin-1", "JELLYFIN"))
			.mockResolvedValueOnce(episodeObservation("emby-1", "EMBY", "last-known"));

		const result = await readOwnedJellyfinEpisodeDisplaySources({
			prisma: {} as never,
			userId: "user-1",
			instances,
			now,
		});

		expect(repositoryMock.read).toHaveBeenCalledTimes(2);
		expect(repositoryMock.read).toHaveBeenNthCalledWith(1, {
			prisma: {},
			userId: "user-1",
			instanceId: "jellyfin-1",
			cacheType: "jellyfin_episode",
			mode: "display",
			now,
		});
		expect(result.sources.map((source) => source.rows)).toEqual([
			[expect.objectContaining({ id: "jellyfin-1-episode" })],
			[expect.objectContaining({ id: "emby-1-episode" })],
		]);
		expect(result.providerStatus?.availability).toBe("partial");
	});

	it.each([
		["partial", "partial"],
		["unknown", "current"],
		["unknown", "unavailable"],
	] as const)(
		"does not admit %s or incomplete episode evidence",
		async (evidence, availability) => {
			repositoryMock.read.mockResolvedValueOnce({
				...episodeObservation("jellyfin-1", "JELLYFIN"),
				available: availability !== "unavailable",
				cacheType: "jellyfin_episode",
				providerStatus: {
					...status(availability),
					evidence,
				},
			});

			const result = await readOwnedJellyfinEpisodeDisplaySources({
				prisma: {} as never,
				userId: "user-1",
				instances: [instances[0]!],
				now,
			});

			expect(result.sources[0]?.rows).toEqual([]);
		},
	);

	it("keeps thrown and null episode reads as unavailable source slots", async () => {
		repositoryMock.read.mockRejectedValueOnce(new Error("provider secret"));
		const first = await readOwnedJellyfinEpisodeDisplaySources({
			prisma: {} as never,
			userId: "user-1",
			instances: [instances[0]!],
			now,
		});
		expect(first.sources[0]?.rows).toEqual([]);
		expect(first.providerStatus?.sources[0]?.status).toMatchObject({
			availability: "unavailable",
			evidence: "unknown",
		});

		repositoryMock.read.mockResolvedValueOnce(null);
		const second = await readOwnedJellyfinEpisodeDisplaySources({
			prisma: {} as never,
			userId: "user-1",
			instances: [instances[1]!],
			now,
		});
		expect(second.providerStatus?.sources[0]?.service).toBe("emby");
		expect(second.providerStatus?.sources[0]?.status.availability).toBe("unavailable");
	});

	it("authorizes arithmetic only for uniform complete evidence", () => {
		const current = episodeStatusEnvelope("current");
		expect(isArithmeticAuthoritativeProviderObservationStatus(current)).toBe(true);
		expect(
			isArithmeticAuthoritativeProviderObservationStatus({
				...current,
				sources: [
					current.sources[0]!,
					{
						...current.sources[0]!,
						instanceId: "emby-1",
						service: "emby",
						status: { ...current.sources[0]!.status, availability: "last-known" },
					},
				],
			}),
		).toBe(false);
		expect(isArithmeticAuthoritativeProviderObservationStatus(undefined)).toBe(false);
	});

	it("does not grant library arithmetic authority to legacy status without V2 domains", () => {
		expect(
			isArithmeticAuthoritativeProviderObservationStatus({
				availability: "current",
				sources: [
					{
						instanceId: "jellyfin-1",
						service: "jellyfin",
						cacheType: "jellyfin",
						status: status("current"),
					},
				],
			}),
		).toBe(false);
	});
});

describe("positive-only episode detail display", () => {
	it.each(["current", "partial", "last-known"] as const)(
		"admits positive watched details from %s evidence without exact arithmetic",
		async (availability) => {
			const positive = episodeRow("jellyfin-1");
			const unproven = {
				...episodeRow("jellyfin-1", "unproven"),
				watched: false,
				watchedByUsers: "[]",
				lastWatchedAt: null,
			};
			const observed = episodeObservation("jellyfin-1", "JELLYFIN", "current", [
				positive,
				unproven,
			]);
			observed.providerStatus = { ...status(availability), evidence: "positive-only" };
			repositoryMock.read.mockResolvedValue(observed);
			const result = await readOwnedJellyfinEpisodeDisplaySources({
				prisma: {} as never,
				userId: "user-1",
				instances: [instances[0]!],
				now,
			});
			expect(result.sources[0]?.rows).toEqual([positive]);
			expect(result.providerStatus?.sources[0]?.status.evidence).toBe("positive-only");
			expect(isArithmeticAuthoritativeProviderObservationStatus(result.providerStatus)).toBe(false);
		},
	);
});
