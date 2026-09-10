import type { ProviderObservationStatus } from "@arr/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	DEFAULT_JELLYFIN_CACHE_HEALTH_MAX_AGE_MS,
	readOwnedJellyfinCacheHealthSources,
} from "../jellyfin-cache-health.js";
import type { JellyfinObservation } from "../jellyfin-evidence-repository.js";

const repositoryMock = vi.hoisted(() => ({ read: vi.fn() }));

vi.mock("../jellyfin-evidence-repository.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../jellyfin-evidence-repository.js")>()),
	readOwnedJellyfinObservation: repositoryMock.read,
}));

const now = new Date("2026-09-03T12:00:00.000Z");
const observedAt = new Date("2026-09-03T10:00:00.000Z");
const instances = [
	{
		id: "jellyfin-2",
		label: "Jellyfin Two",
		service: "JELLYFIN" as const,
		createdAt: new Date("2026-01-02T00:00:00.000Z"),
	},
	{
		id: "emby-1",
		label: "Emby One",
		service: "EMBY" as const,
		createdAt: new Date("2026-01-01T00:00:00.000Z"),
	},
];

function status(
	availability: ProviderObservationStatus["availability"],
	overrides: Partial<ProviderObservationStatus> = {},
): ProviderObservationStatus {
	return {
		availability,
		evidence: availability === "current" || availability === "last-known" ? "complete" : "unknown",
		observedAt: availability === "unavailable" ? null : observedAt.toISOString(),
		ageSeconds: availability === "unavailable" ? null : 7200,
		latestAttempt: "idle",
		reasonCodes: [],
		...overrides,
	};
}

function observation(
	instanceId: string,
	service: "JELLYFIN" | "EMBY",
	cacheType: "jellyfin" | "jellyfin_episode",
	providerStatus: ProviderObservationStatus,
	rows: unknown[] = [{ id: "row-1" }],
	available = providerStatus.availability !== "unavailable",
): JellyfinObservation {
	return {
		available,
		instanceId,
		service,
		cacheType,
		generationId: "private",
		publishedAt: observedAt,
		metadata: null,
		rows: rows as never,
		providerStatus,
		mutationAvailable: false,
		authority: null,
	} as JellyfinObservation;
}

afterEach(() => vi.clearAllMocks());

describe("readOwnedJellyfinCacheHealthSources", () => {
	it("reads two stable slots per owned instance with one shared now", async () => {
		repositoryMock.read.mockImplementation(async ({ cacheType, instanceId }) =>
			observation(
				instanceId,
				instanceId === "emby-1" ? "EMBY" : "JELLYFIN",
				cacheType,
				status("current"),
			),
		);

		const result = await readOwnedJellyfinCacheHealthSources({
			prisma: {} as never,
			userId: "user-1",
			instances,
			now,
		});

		expect(repositoryMock.read).toHaveBeenCalledTimes(4);
		expect(repositoryMock.read).toHaveBeenNthCalledWith(1, {
			prisma: {},
			userId: "user-1",
			instanceId: "emby-1",
			cacheType: "jellyfin",
			mode: "display",
			now,
			maxAgeMs: DEFAULT_JELLYFIN_CACHE_HEALTH_MAX_AGE_MS,
		});
		expect(repositoryMock.read).toHaveBeenNthCalledWith(2, {
			prisma: {},
			userId: "user-1",
			instanceId: "emby-1",
			cacheType: "jellyfin_episode",
			mode: "display",
			now,
			maxAgeMs: DEFAULT_JELLYFIN_CACHE_HEALTH_MAX_AGE_MS,
		});
		expect(result.map(({ item }) => [item.instanceId, item.cacheType])).toEqual([
			["emby-1", "emby"],
			["emby-1", "emby_episode"],
			["jellyfin-2", "jellyfin"],
			["jellyfin-2", "jellyfin_episode"],
		]);
		expect(result[0]?.fallbackObservedAt).toBe("2026-01-01T00:00:00.000Z");
	});

	it("reports exact current counts, including an empty publication", async () => {
		repositoryMock.read
			.mockResolvedValueOnce(
				observation("jellyfin-2", "JELLYFIN", "jellyfin", status("current"), []),
			)
			.mockResolvedValueOnce(
				observation("jellyfin-2", "JELLYFIN", "jellyfin_episode", status("current"), [
					{ id: "episode" },
				]),
			);

		const [library, episode] = await readOwnedJellyfinCacheHealthSources({
			prisma: {} as never,
			userId: "user-1",
			instances: [instances[0]!],
			now,
		});

		expect(library?.item).toMatchObject({
			cacheType: "jellyfin",
			lastResult: "success",
			itemCount: 0,
			lastRefreshedAt: observedAt.toISOString(),
			lastErrorMessage: null,
			isStale: false,
		});
		expect(library?.item).not.toHaveProperty("observedItemCount");
		expect(episode?.item.itemCount).toBe(1);
	});

	it.each([
		[
			"refresh-running",
			"in_progress",
			false,
			"Cache refresh is in progress; current values are unavailable",
		],
		["refresh-failed", "error", false, "Cache refresh failed; last-known values are retained"],
		["publication-stale", "partial", true, "Published cache evidence is stale or degraded"],
	] as const)(
		"retains complete last-known counts for %s",
		async (reason, lastResult, isStale, message) => {
			repositoryMock.read.mockResolvedValue(
				observation(
					"jellyfin-2",
					"JELLYFIN",
					"jellyfin",
					status("last-known", { reasonCodes: [reason] }),
					[{ id: "one" }, { id: "two" }],
				),
			);

			const [result] = await readOwnedJellyfinCacheHealthSources({
				prisma: {} as never,
				userId: "user-1",
				instances: [instances[0]!],
				now,
			});

			expect(result?.item).toMatchObject({
				lastResult,
				itemCount: 2,
				isStale,
				lastErrorMessage: message,
			});
		},
	);

	it("bounds partial and positive-only observations to observed counts", async () => {
		repositoryMock.read
			.mockResolvedValueOnce(
				observation(
					"jellyfin-2",
					"JELLYFIN",
					"jellyfin",
					status("partial", { evidence: "partial", reasonCodes: ["coverage-incomplete"] }),
					[{ id: "one" }],
				),
			)
			.mockResolvedValueOnce(
				observation(
					"jellyfin-2",
					"JELLYFIN",
					"jellyfin_episode",
					status("partial", { evidence: "positive-only", reasonCodes: ["positive-only"] }),
					[{ id: "episode" }, { id: "episode-2" }],
				),
			);

		const result = await readOwnedJellyfinCacheHealthSources({
			prisma: {} as never,
			userId: "user-1",
			instances: [instances[0]!],
			now,
		});

		expect(result.map(({ item }) => item)).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ itemCount: null, observedItemCount: 1, lastResult: "partial" }),
				expect.objectContaining({ itemCount: null, observedItemCount: 2, lastResult: "partial" }),
			]),
		);
	});

	it("fails closed for unavailable, malformed, and mismatched observations", async () => {
		repositoryMock.read
			.mockResolvedValueOnce(null)
			.mockResolvedValueOnce(observation("other", "EMBY", "jellyfin", status("current")))
			.mockResolvedValueOnce(
				observation("jellyfin-2", "JELLYFIN", "jellyfin", {
					...status("current"),
					evidence: "unknown",
				}),
			)
			.mockRejectedValueOnce(new Error("private provider failure"));

		const result = await readOwnedJellyfinCacheHealthSources({
			prisma: {} as never,
			userId: "user-1",
			instances: [instances[0]!, instances[1]!],
			now,
		});

		for (const { item } of result.slice(0, 2)) {
			expect(item).toMatchObject({ itemCount: null, lastRefreshedAt: null, lastResult: "error" });
			expect(item).not.toHaveProperty("observedItemCount");
			expect(item.lastErrorMessage).toBe("Published cache evidence is unavailable");
		}
		expect(result[2]?.item).toMatchObject({
			itemCount: null,
			lastRefreshedAt: null,
			lastResult: "error",
		});
		expect(result[3]?.item).toMatchObject({
			itemCount: null,
			lastRefreshedAt: null,
			lastResult: "error",
		});
	});

	it.each([
		[
			"running",
			{
				latestAttempt: "running" as const,
				reasonCodes: [
					"identity-unverified",
					"refresh-running",
				] as ProviderObservationStatus["reasonCodes"],
			},
			"in_progress",
		],
		[
			"failed",
			{
				latestAttempt: "failed" as const,
				reasonCodes: [
					"receipt-invalid",
					"refresh-failed",
				] as ProviderObservationStatus["reasonCodes"],
			},
			"error",
		],
	] as const)(
		"preserves unavailable %s attempt and public reasons",
		async (_name, unavailableStatus, lastResult) => {
			repositoryMock.read.mockResolvedValue(
				observation(
					"jellyfin-2",
					"JELLYFIN",
					"jellyfin",
					status("unavailable", unavailableStatus),
					[{ id: "must-not-escape" }],
				),
			);

			const [result] = await readOwnedJellyfinCacheHealthSources({
				prisma: {} as never,
				userId: "user-1",
				instances: [instances[0]!],
				now,
			});

			expect(result?.item).toMatchObject({
				lastResult,
				lastRefreshedAt: null,
				itemCount: null,
				isStale: false,
			});
			expect(result?.item).not.toHaveProperty("observedItemCount");
			expect(result?.item.providerStatus).toMatchObject({
				availability: "unavailable",
				sources: [
					expect.objectContaining({
						status: expect.objectContaining(unavailableStatus),
					}),
				],
			});
		},
	);

	it("uses a generic fallback for unavailable observations with contradictory current status", async () => {
		repositoryMock.read.mockResolvedValue(
			observation(
				"jellyfin-2",
				"JELLYFIN",
				"jellyfin",
				status("current"),
				[{ id: "must-not-escape" }],
				false,
			),
		);

		const [result] = await readOwnedJellyfinCacheHealthSources({
			prisma: {} as never,
			userId: "user-1",
			instances: [instances[0]!],
			now,
		});

		expect(result?.item).toMatchObject({
			lastResult: "error",
			lastErrorMessage: "Published cache evidence is unavailable",
			itemCount: null,
			lastRefreshedAt: null,
		});
		expect(result?.item.providerStatus?.sources[0]?.status.reasonCodes).toEqual([
			"unknown-failure",
		]);
	});

	it("admits legacy last-known unknown evidence as an observed-only lower bound", async () => {
		const legacyStatus = status("last-known", {
			evidence: "unknown",
			observedAt: null,
			ageSeconds: null,
			reasonCodes: ["receipt-invalid"],
		});
		repositoryMock.read.mockResolvedValue(
			observation("jellyfin-2", "JELLYFIN", "jellyfin", legacyStatus, [
				{ id: "one" },
				{ id: "two" },
			]),
		);

		const [result] = await readOwnedJellyfinCacheHealthSources({
			prisma: {} as never,
			userId: "user-1",
			instances: [instances[0]!],
			now,
		});

		expect(result?.item).toMatchObject({
			lastResult: "partial",
			lastRefreshedAt: null,
			itemCount: null,
			observedItemCount: 2,
		});
		expect(result?.item.providerStatus?.sources[0]?.status).toEqual(legacyStatus);
		expect(result?.item).not.toHaveProperty("fallbackObservedAt");
	});

	it.each([
		["running", "in_progress", "refresh-running"],
		["failed", "error", "refresh-failed"],
	] as const)(
		"classifies legacy last-known unknown %s reasons",
		async (_name, lastResult, reason) => {
			repositoryMock.read.mockResolvedValue(
				observation(
					"jellyfin-2",
					"JELLYFIN",
					"jellyfin",
					status("last-known", {
						evidence: "unknown",
						observedAt: null,
						ageSeconds: null,
						reasonCodes: ["receipt-invalid", reason],
						latestAttempt: _name,
					}),
					[{ id: "one" }],
				),
			);

			const [result] = await readOwnedJellyfinCacheHealthSources({
				prisma: {} as never,
				userId: "user-1",
				instances: [instances[0]!],
				now,
			});

			expect(result?.item).toMatchObject({ lastResult, itemCount: null, observedItemCount: 1 });
		},
	);

	it("preserves superseded legacy status without exposing private fields", async () => {
		repositoryMock.read.mockResolvedValue(
			observation(
				"jellyfin-2",
				"JELLYFIN",
				"jellyfin",
				status("last-known", {
					evidence: "unknown",
					observedAt: null,
					ageSeconds: null,
					reasonCodes: ["receipt-invalid", "publication-superseded"],
				}),
				[{ id: "one" }],
			),
		);

		const [result] = await readOwnedJellyfinCacheHealthSources({
			prisma: {} as never,
			userId: "user-1",
			instances: [instances[0]!],
			now,
		});
		const encoded = JSON.stringify(result?.item);
		expect(result?.item).toMatchObject({
			lastResult: "partial",
			itemCount: null,
			observedItemCount: 1,
		});
		expect(encoded).not.toContain("must-not-escape");
		expect(encoded).not.toContain("private");
		expect(encoded).not.toContain("https://");
		expect(encoded).not.toContain("fallbackObservedAt");
	});

	it("does not create alerts from inactive attempt markers", async () => {
		repositoryMock.read.mockResolvedValue(
			observation(
				"jellyfin-2",
				"JELLYFIN",
				"jellyfin",
				status("current", { latestAttempt: "failed" }),
				[{ id: "one" }],
			),
		);

		const [result] = await readOwnedJellyfinCacheHealthSources({
			prisma: {} as never,
			userId: "user-1",
			instances: [instances[0]!],
			now,
		});

		expect(result?.item).toMatchObject({
			lastResult: "success",
			lastErrorMessage: null,
			itemCount: 1,
		});
	});

	it("returns no slots or repository reads for an empty topology", async () => {
		const result = await readOwnedJellyfinCacheHealthSources({
			prisma: {} as never,
			userId: "user-1",
			instances: [],
			now,
		});
		expect(result).toEqual([]);
		expect(repositoryMock.read).not.toHaveBeenCalled();
	});
});
