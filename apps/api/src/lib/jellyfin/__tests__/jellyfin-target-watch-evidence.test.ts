import type { ProviderObservationStatus } from "@arr/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { JellyfinObservation } from "../jellyfin-evidence-repository.js";

const seams = vi.hoisted(() => ({
	readObservation: vi.fn(),
	readNative: vi.fn(),
	createClient: vi.fn(),
}));

vi.mock("../jellyfin-evidence-repository.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../jellyfin-evidence-repository.js")>();
	return { ...actual, readOwnedJellyfinObservation: seams.readObservation };
});
vi.mock("../../provider-observation/inventory-connection-repository.js", () => ({
	readCompleteNativeLibrary: seams.readNative,
}));
vi.mock("../jellyfin-client.js", () => ({ createJellyfinClient: seams.createClient }));

import {
	readJellyfinTargetWatchEvidence,
	revalidateJellyfinTargetWatchEvidence,
} from "../jellyfin-target-watch-evidence.js";

const now = new Date("2026-09-15T12:00:00.000Z");
const status = {
	availability: "current",
	evidence: "positive-only",
	observedAt: now,
	ageSeconds: 0,
	latestAttempt: "successful",
	reasonCodes: [],
	domains: [
		{
			domain: "watch-count",
			availability: "current",
			evidence: "positive-only",
			valueSemantics: "lower-bound",
			observedAt: now.toISOString(),
			reasonCodes: ["positive-only"],
		},
	],
} as unknown as ProviderObservationStatus;

function row(overrides: Record<string, unknown> = {}) {
	return {
		id: "cache-row-1",
		instanceId: "jf-1",
		tmdbId: 123,
		mediaType: "movie" as const,
		libraryId: "library-1",
		libraryName: "Movies",
		title: "private title",
		jellyfinId: "item-1",
		lastWatchedAt: now,
		watchCount: 3,
		watchedByUsers: '["alice"]',
		onDeck: false,
		userRating: null,
		collections: "[]",
		addedAt: now,
		thumb: null,
		connectionGeneration: 1,
		identityGeneration: 1,
		...overrides,
	};
}

function observation(overrides: Record<string, unknown> = {}): JellyfinObservation {
	return {
		available: true,
		instanceId: "jf-1",
		service: "JELLYFIN",
		cacheType: "jellyfin",
		generationId: "watch-generation-1",
		publishedAt: now,
		metadata: { connectionGeneration: 1, identityGeneration: 1 } as never,
		rows: [row()],
		providerStatus: status,
		mutationAvailable: false,
		authority: null,
		...overrides,
	} as JellyfinObservation;
}

const catalog = {
	status: "available" as const,
	instanceId: "jf-1",
	generationId: "native-generation-1",
	observedAt: now,
	itemCount: 1,
	scopeCount: 1,
	lastAttemptAt: now,
	lastAttemptResult: "success",
	lastAttemptReason: null,
	freshness: "current" as const,
	complete: true,
	rows: [
		{
			nativeId: "item-1",
			mediaType: "movie" as const,
			libraryIds: ["library-1"],
			parentNativeId: null,
			seasonNumber: null,
			episodeNumber: null,
			title: "private title",
			externalIds: { tmdb: [123] },
		},
	],
	nextNativeId: null,
};

const prisma = {
	serviceInstance: {
		findFirst: vi.fn().mockResolvedValue({
			id: "jf-1",
			userId: "owner-1",
			service: "JELLYFIN",
			enabled: true,
			expectedIdentity: "server-1",
			identityStatus: "VERIFIED",
			connectionGeneration: 1,
			identityGeneration: 1,
			baseUrl: "https://jellyfin.example",
			encryptedApiKey: "encrypted",
			encryptionIv: "iv",
		}),
	},
};

beforeEach(() => {
	seams.readObservation.mockReset();
	seams.readNative.mockReset().mockResolvedValue(catalog);
	seams.createClient.mockReset();
	seams.readObservation.mockResolvedValue(observation());
});

describe("Jellyfin target-watch evidence", () => {
	it("accepts a current watch-count domain within a partial overall observation", async () => {
		seams.readObservation.mockResolvedValue(
			observation({ providerStatus: { ...status, availability: "partial" } }),
		);
		const proofs = await readJellyfinTargetWatchEvidence({
			prisma: prisma as never,
			userId: "owner-1",
			instanceId: "jf-1",
			targets: [{ mediaType: "movie", tmdbId: 123 }],
			now,
		});
		expect(proofs).toHaveLength(1);
		expect(proofs[0]?.providerStatus.availability).toBe("partial");
	});

	it.each(["last-known", "unavailable"] as const)(
		"rejects a %s watch-count domain even with a partial observation",
		async (availability) => {
			seams.readObservation.mockResolvedValue(
				observation({
					providerStatus: {
						...status,
						availability: "partial",
						domains: status.domains?.map((domain) => ({ ...domain, availability })),
					},
				}),
			);
			await expect(
				readJellyfinTargetWatchEvidence({
					prisma: prisma as never,
					userId: "owner-1",
					instanceId: "jf-1",
					targets: [{ mediaType: "movie", tmdbId: 123 }],
					now,
				}),
			).resolves.toEqual([]);
		},
	);

	it("binds one positive cache row to one current native target", async () => {
		const [proof] = await readJellyfinTargetWatchEvidence({
			prisma: prisma as never,
			userId: "owner-1",
			instanceId: "jf-1",
			targets: [{ mediaType: "movie", tmdbId: 123 }],
			now,
		});

		expect(proof).toMatchObject({
			userId: "owner-1",
			instanceId: "jf-1",
			generationId: "watch-generation-1",
			nativeGenerationId: "native-generation-1",
			nativeId: "item-1",
			libraryId: "library-1",
			observedValue: 3,
		});
		expect(proof?.coordinate).toMatch(/^[a-f0-9]{64}$/);
	});

	it("retains unrelated positive targets when another candidate is absent or unwatched", async () => {
		seams.readObservation.mockResolvedValue(
			observation({
				rows: [
					row(),
					row({ id: "cache-row-2", tmdbId: 456, watchCount: 0 }),
					row({ id: "cache-row-3", tmdbId: 789 }),
				],
			}),
		);

		const proofs = await readJellyfinTargetWatchEvidence({
			prisma: prisma as never,
			userId: "owner-1",
			instanceId: "jf-1",
			targets: [
				{ mediaType: "movie", tmdbId: 123 },
				{ mediaType: "movie", tmdbId: 456 },
				{ mediaType: "movie", tmdbId: 999 },
			],
			now,
		});

		expect(proofs).toHaveLength(1);
		expect(proofs[0]?.tmdbId).toBe(123);
	});

	it.each([
		["provider alias", { service: "EMBY" }],
		["zero count", { rows: [row({ watchCount: 0 })] }],
		["missing positive user", { rows: [row({ watchedByUsers: "[]" })] }],
		["duplicate cache target", { rows: [row(), row({ id: "cache-row-2" })] }],
	] as const)("rejects %s", async (_name, overrides) => {
		seams.readObservation.mockResolvedValue(observation(overrides));
		await expect(
			readJellyfinTargetWatchEvidence({
				prisma: prisma as never,
				userId: "owner-1",
				instanceId: "jf-1",
				targets: [{ mediaType: "movie", tmdbId: 123 }],
				now,
			}),
		).resolves.toEqual([]);
	});

	it("reproves the coordinate and live count before authorizing a threshold", async () => {
		const [proof] = await readJellyfinTargetWatchEvidence({
			prisma: prisma as never,
			userId: "owner-1",
			instanceId: "jf-1",
			targets: [{ mediaType: "movie", tmdbId: 123 }],
			now,
		});
		seams.createClient.mockReturnValue({
			readTargetWatchCount: vi.fn().mockResolvedValue({
				serverId: "server-1",
				itemId: "item-1",
				mediaType: "movie",
				tmdbId: 123,
				libraryId: "library-1",
				observedValue: 4,
			}),
		});

		await expect(
			revalidateJellyfinTargetWatchEvidence({
				prisma: prisma as never,
				encryptor: {} as never,
				userId: "owner-1",
				instanceId: "jf-1",
				mediaType: "movie",
				tmdbId: 123,
				coordinate: proof!.coordinate,
				generationId: proof!.generationId,
				threshold: 2,
				now,
			}),
		).resolves.toBe(true);
	});

	it("keeps the coordinate stable as diagnostic age changes within freshness", async () => {
		const [proof] = await readJellyfinTargetWatchEvidence({
			prisma: prisma as never,
			userId: "owner-1",
			instanceId: "jf-1",
			targets: [{ mediaType: "movie", tmdbId: 123 }],
			now,
		});
		const laterStatus = {
			...status,
			observedAt: new Date(now.getTime() + 1_000),
			ageSeconds: 1,
			latestAttempt: "successful",
			domains: status.domains?.map((domain) => ({
				...domain,
				observedAt: new Date(now.getTime() + 1_000).toISOString(),
				reasonCodes: ["fresh"],
			})),
		} as unknown as ProviderObservationStatus;
		seams.readObservation
			.mockResolvedValueOnce(observation({ providerStatus: laterStatus }))
			.mockResolvedValueOnce(observation({ providerStatus: laterStatus }));
		seams.createClient.mockReturnValue({
			readTargetWatchCount: vi.fn().mockResolvedValue({
				serverId: "server-1",
				itemId: "item-1",
				mediaType: "movie",
				tmdbId: 123,
				libraryId: "library-1",
				observedValue: 4,
			}),
		});

		await expect(
			revalidateJellyfinTargetWatchEvidence({
				prisma: prisma as never,
				encryptor: {} as never,
				userId: "owner-1",
				instanceId: "jf-1",
				mediaType: "movie",
				tmdbId: 123,
				coordinate: proof!.coordinate,
				generationId: proof!.generationId,
				threshold: 2,
				now: new Date(now.getTime() + 1_000),
			}),
		).resolves.toBe(true);
	});

	it("fails closed when the cached observation is outside freshness", async () => {
		const [proof] = await readJellyfinTargetWatchEvidence({
			prisma: prisma as never,
			userId: "owner-1",
			instanceId: "jf-1",
			targets: [{ mediaType: "movie", tmdbId: 123 }],
			now,
		});
		seams.readObservation.mockResolvedValue(
			observation({
				available: false,
				providerStatus: { ...status, availability: "last-known" },
			}),
		);
		seams.createClient.mockReturnValue({
			readTargetWatchCount: vi.fn().mockResolvedValue({
				serverId: "server-1",
				itemId: "item-1",
				mediaType: "movie",
				tmdbId: 123,
				libraryId: "library-1",
				observedValue: 4,
			}),
		});

		await expect(
			revalidateJellyfinTargetWatchEvidence({
				prisma: prisma as never,
				encryptor: {} as never,
				userId: "owner-1",
				instanceId: "jf-1",
				mediaType: "movie",
				tmdbId: 123,
				coordinate: proof!.coordinate,
				generationId: proof!.generationId,
				threshold: 2,
				now: new Date(now.getTime() + 86_400_001),
			}),
		).resolves.toBe(false);
		expect(seams.createClient).not.toHaveBeenCalled();
	});

	it("requires the live server identity to match the persisted raw identity", async () => {
		const [proof] = await readJellyfinTargetWatchEvidence({
			prisma: prisma as never,
			userId: "owner-1",
			instanceId: "jf-1",
			targets: [{ mediaType: "movie", tmdbId: 123 }],
			now,
		});
		seams.createClient.mockReturnValue({
			readTargetWatchCount: vi.fn().mockResolvedValue({
				serverId: "different-server",
				itemId: "item-1",
				mediaType: "movie",
				tmdbId: 123,
				libraryId: "library-1",
				observedValue: 4,
			}),
		});

		await expect(
			revalidateJellyfinTargetWatchEvidence({
				prisma: prisma as never,
				encryptor: {} as never,
				userId: "owner-1",
				instanceId: "jf-1",
				mediaType: "movie",
				tmdbId: 123,
				coordinate: proof!.coordinate,
				generationId: proof!.generationId,
				threshold: 2,
				now,
			}),
		).resolves.toBe(false);
	});
});
