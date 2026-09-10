import type { ProviderObservationStatus } from "@arr/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
	JellyfinLibraryDisplayEvidence,
	JellyfinLibraryDisplaySource,
} from "../../jellyfin/jellyfin-display-evidence.js";
import type { JellyfinLibraryRow } from "../../jellyfin/jellyfin-evidence-repository.js";

const displayMock = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock("../../jellyfin/jellyfin-display-evidence.js", () => ({
	readOwnedJellyfinLibraryDisplaySources: displayMock.read,
	isArithmeticAuthoritativeProviderObservationStatus: (providerStatus: {
		sources: Array<{ status: ProviderObservationStatus }>;
	}) =>
		providerStatus.sources.length > 0 &&
		providerStatus.sources.every(
			({ status }) =>
				status.evidence === "complete" &&
				(status.availability === "current" || status.availability === "last-known"),
		),
}));

import { readOwnedJellyfinInsightWatchEvidence } from "../watch-evidence.js";

const observedAt = new Date("2026-09-03T12:00:00.000Z");
const instances = [
	{ id: "jellyfin-1", label: "Library One", service: "JELLYFIN" as const },
	{ id: "emby-1", label: "Library Two", service: "EMBY" as const },
];

function status(
	availability: ProviderObservationStatus["availability"] = "current",
): ProviderObservationStatus {
	return {
		availability,
		evidence: availability === "current" ? "complete" : "unknown",
		observedAt: availability === "unavailable" ? null : observedAt.toISOString(),
		ageSeconds: availability === "current" ? 0 : 60,
		latestAttempt: "successful",
		reasonCodes: availability === "partial" ? ["coverage-incomplete"] : [],
	};
}

function row(instanceId: string, watchCount = 2): JellyfinLibraryRow {
	return {
		id: `${instanceId}-private-row`,
		instanceId,
		tmdbId: 42,
		mediaType: "movie",
		libraryId: "private-library",
		libraryName: "Private Movies",
		title: "Private Title",
		jellyfinId: "private-provider-id",
		lastWatchedAt: observedAt,
		watchCount,
		watchedByUsers: '["private-user"]',
		onDeck: false,
		userRating: null,
		collections: "[]",
		addedAt: observedAt,
		thumb: "https://private.invalid/image",
		connectionGeneration: 1,
		identityGeneration: 1,
	};
}

function display(
	sources: JellyfinLibraryDisplaySource[],
	statuses: Array<{ instanceId: string; status: ProviderObservationStatus }>,
): JellyfinLibraryDisplayEvidence {
	return {
		sources,
		providerStatus: {
			availability: statuses.every(
				({ status: sourceStatus }) => sourceStatus.availability === "current",
			)
				? "current"
				: statuses.every(({ status: sourceStatus }) => sourceStatus.availability === "unavailable")
					? "unavailable"
					: "partial",
			sources: statuses.map(({ instanceId, status: sourceStatus }) => ({
				instanceId,
				service: instanceId.startsWith("emby") ? ("emby" as const) : ("jellyfin" as const),
				cacheType: "jellyfin" as const,
				status: sourceStatus,
			})),
		},
	};
}

afterEach(() => vi.clearAllMocks());

describe("readOwnedJellyfinInsightWatchEvidence", () => {
	it("returns the empty legacy-compatible state without reading an empty topology", async () => {
		const result = await readOwnedJellyfinInsightWatchEvidence({
			prisma: {} as never,
			userId: "user-1",
			instances: [],
		});

		expect(result).toEqual({
			configured: false,
			rows: [],
			providerStatus: undefined,
			hasPositiveEvidence: false,
			negativeClaimsAuthoritative: false,
		});
		expect(displayMock.read).not.toHaveBeenCalled();
	});

	it("projects only public watch fields and authorizes a current complete topology", async () => {
		displayMock.read.mockResolvedValueOnce(
			display(
				[{ instanceId: "jellyfin-1", instanceName: "Library One", rows: [row("jellyfin-1")] }],
				[{ instanceId: "jellyfin-1", status: status() }],
			),
		);

		const result = await readOwnedJellyfinInsightWatchEvidence({
			prisma: {} as never,
			userId: "user-1",
			instances: [instances[0]!],
		});

		expect(result).toMatchObject({
			configured: true,
			hasPositiveEvidence: true,
			negativeClaimsAuthoritative: true,
			rows: [{ tmdbId: 42, mediaType: "movie", watchCount: 2, lastWatchedAt: observedAt }],
		});
		expect(JSON.stringify(result)).not.toMatch(
			/private-row|private-library|Private Title|private-provider|private-user|private.invalid|connectionGeneration|identityGeneration/i,
		);
		expect(displayMock.read).toHaveBeenCalledTimes(1);
		expect(displayMock.read).toHaveBeenCalledWith({
			prisma: {},
			userId: "user-1",
			instances: [instances[0]],
		});
	});

	it("retains positive rows from last-known evidence but withholds negative authority", async () => {
		displayMock.read.mockResolvedValueOnce(
			display(
				[{ instanceId: "jellyfin-1", instanceName: "Library One", rows: [row("jellyfin-1")] }],
				[{ instanceId: "jellyfin-1", status: { ...status("last-known"), evidence: "complete" } }],
			),
		);

		const result = await readOwnedJellyfinInsightWatchEvidence({
			prisma: {} as never,
			userId: "user-1",
			instances: [instances[0]!],
		});

		expect(result.hasPositiveEvidence).toBe(true);
		expect(result.negativeClaimsAuthoritative).toBe(false);
		expect(result.rows).toHaveLength(1);
	});

	it("retains usable rows from a mixed topology while rejecting negative authority", async () => {
		displayMock.read.mockResolvedValueOnce(
			display(
				[
					{ instanceId: "jellyfin-1", instanceName: "Library One", rows: [row("jellyfin-1")] },
					{ instanceId: "emby-1", instanceName: "Library Two", rows: [] },
				],
				[
					{ instanceId: "jellyfin-1", status: status() },
					{ instanceId: "emby-1", status: status("unavailable") },
				],
			),
		);

		const result = await readOwnedJellyfinInsightWatchEvidence({
			prisma: {} as never,
			userId: "user-1",
			instances,
		});

		expect(result.providerStatus?.availability).toBe("partial");
		expect(result.hasPositiveEvidence).toBe(true);
		expect(result.negativeClaimsAuthoritative).toBe(false);
		expect(result.rows).toHaveLength(1);
	});

	it("excludes published positive-only rows from arithmetic watch evidence", async () => {
		displayMock.read.mockResolvedValueOnce(
			display(
				[{ instanceId: "jellyfin-1", instanceName: "Library One", rows: [row("jellyfin-1", 3)] }],
				[
					{
						instanceId: "jellyfin-1",
						status: {
							...status(),
							evidence: "positive-only",
							reasonCodes: ["positive-only"],
						},
					},
				],
			),
		);

		const result = await readOwnedJellyfinInsightWatchEvidence({
			prisma: {} as never,
			userId: "user-1",
			instances: [instances[0]!],
		});

		expect(result.rows).toEqual([]);
		expect(result.hasPositiveEvidence).toBe(false);
		expect(result.negativeClaimsAuthoritative).toBe(false);
	});

	it("keeps authoritative rows while excluding a positive-only source in a mixed topology", async () => {
		displayMock.read.mockResolvedValueOnce(
			display(
				[
					{ instanceId: "jellyfin-1", instanceName: "Library One", rows: [row("jellyfin-1", 2)] },
					{ instanceId: "emby-1", instanceName: "Library Two", rows: [row("emby-1", 9)] },
				],
				[
					{ instanceId: "jellyfin-1", status: status() },
					{
						instanceId: "emby-1",
						status: {
							...status(),
							evidence: "positive-only",
							reasonCodes: ["positive-only"],
						},
					},
				],
			),
		);

		const result = await readOwnedJellyfinInsightWatchEvidence({
			prisma: {} as never,
			userId: "user-1",
			instances,
		});

		expect(result.rows).toEqual([
			{ tmdbId: 42, mediaType: "movie", watchCount: 2, lastWatchedAt: observedAt },
		]);
	});

	it("returns no rows or positive authority when every source is unavailable", async () => {
		displayMock.read.mockResolvedValueOnce(
			display(
				[
					{ instanceId: "jellyfin-1", instanceName: "Library One", rows: [] },
					{ instanceId: "emby-1", instanceName: "Library Two", rows: [] },
				],
				[
					{ instanceId: "jellyfin-1", status: status("unavailable") },
					{ instanceId: "emby-1", status: status("unavailable") },
				],
			),
		);

		const result = await readOwnedJellyfinInsightWatchEvidence({
			prisma: {} as never,
			userId: "user-1",
			instances,
		});

		expect(result.rows).toEqual([]);
		expect(result.hasPositiveEvidence).toBe(false);
		expect(result.negativeClaimsAuthoritative).toBe(false);
		expect(result.providerStatus?.availability).toBe("unavailable");
	});

	it("rejects missing, duplicate, and mismatched public source coverage", async () => {
		for (const statuses of [
			[{ instanceId: "jellyfin-1", status: status() }],
			[
				{ instanceId: "jellyfin-1", status: status() },
				{ instanceId: "jellyfin-1", status: status() },
			],
			[
				{ instanceId: "jellyfin-1", status: status() },
				{ instanceId: "foreign", status: status() },
			],
		]) {
			displayMock.read.mockResolvedValueOnce(
				display([{ instanceId: "jellyfin-1", instanceName: "Library One", rows: [] }], statuses),
			);
			const result = await readOwnedJellyfinInsightWatchEvidence({
				prisma: {} as never,
				userId: "user-1",
				instances,
			});
			expect(result.negativeClaimsAuthoritative).toBe(false);
		}
	});
});
