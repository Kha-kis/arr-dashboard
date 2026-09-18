import type { FastifyBaseLogger } from "fastify";
import pino from "pino";
import { describe, expect, it, vi } from "vitest";
import type { PlexClient, PlexSettlementLibrary } from "../plex-client.js";
import { collectPlexNativeInventory } from "../plex-native-inventory.js";

function section(key: string, type: "movie" | "show"): PlexSettlementLibrary {
	return {
		key,
		uuid: `uuid-${key}`,
		type,
		title: "Library",
		refreshing: false,
		scannedAt: 10,
		updatedAt: 10,
	};
}

function page<T>(items: T[]) {
	return {
		items,
		expectedRawCount: items.length,
		rawObserved: items.length,
		pagesAttempted: 1,
		pagesCompleted: 1,
		reason: null as "page-failure" | null,
	};
}

function fixture(sections = [section("movies", "movie"), section("shows", "show")]) {
	const library = vi.fn(async (key: string) =>
		page([
			{
				ratingKey: key === "movies" ? "movie-unmapped" : "show-unmapped",
				type: key === "movies" ? "movie" : "show",
				title: "Native item",
			},
		]),
	);
	const episodes = vi.fn(async () =>
		page([
			{
				ratingKey: "episode-unknown",
				type: "episode",
				title: "",
				grandparentRatingKey: null,
				seasonNumber: null,
				episodeNumber: null,
			},
			{
				ratingKey: "episode-unwatched",
				type: "episode",
				title: "Episode",
				grandparentRatingKey: "show-unmapped",
				seasonNumber: 0,
				episodeNumber: 0,
			},
		]),
	);
	const probe = vi.fn(async () => sections);
	const activities = vi.fn<PlexClient["getActivities"]>(async () => []);
	const history = vi.fn(() => {
		throw new Error("Watch data is unavailable");
	});
	const client = {
		getNativeLibraryItemsWithCoverage: library,
		getNativeEpisodeItemsWithCoverage: episodes,
		getLibrarySettlementSections: probe,
		getActivities: activities,
		getHistory: history,
		getAccounts: history,
	} as unknown as PlexClient;
	return { client, library, episodes, probe, activities, history };
}

describe("Plex complete native inventory", () => {
	it("retains unmapped and unwatched native objects without watch or mapping dependencies", async () => {
		const f = fixture();
		const result = await collectPlexNativeInventory(f.client);
		expect(result.complete).toBe(true);
		if (!result.complete) return;
		expect(result.snapshots.map((s) => [s.domain, s.rows.length])).toEqual([
			["library", 2],
			["episode", 2],
		]);
		expect(result.snapshots[1]!.rows).toContainEqual({
			nativeId: "episode-unknown",
			mediaType: "episode",
			libraryIds: ["shows"],
			parentNativeId: null,
			seasonNumber: null,
			episodeNumber: null,
			title: "",
		});
		expect(result.snapshots[1]!.rows.find((r) => r.nativeId === "episode-unwatched")).toMatchObject(
			{ parentNativeId: "show-unmapped", seasonNumber: 0, episodeNumber: 0 },
		);
		expect(f.library).toHaveBeenCalledTimes(4);
		expect(f.episodes).toHaveBeenCalledTimes(2);
		expect(f.history).not.toHaveBeenCalled();
	});

	it("proves an empty supported catalog from complete probes", async () => {
		const f = fixture([]);
		const result = await collectPlexNativeInventory(f.client);
		expect(result).toMatchObject({
			complete: true,
			snapshots: [
				{ domain: "library", rows: [], scopeKeys: [] },
				{ domain: "episode", rows: [], scopeKeys: [] },
			],
		});
		expect(f.library).not.toHaveBeenCalled();
	});

	it("accounts for known containers without treating them as media", async () => {
		const f = fixture([section("movies", "movie")]);
		f.library.mockResolvedValue(
			page([
				{ ratingKey: "container", type: "collection", title: "Container" },
				{ ratingKey: "movie", type: "movie", title: "Movie" },
			]),
		);
		const result = await collectPlexNativeInventory(f.client);
		expect(result).toMatchObject({
			complete: true,
			snapshots: [
				{ domain: "library", rows: [{ nativeId: "movie" }] },
				{ domain: "episode", rows: [] },
			],
		});
	});

	it("retains competing native external identifiers on a library row", async () => {
		const f = fixture([section("movies", "movie")]);
		f.library.mockResolvedValue(
			page([
				{
					ratingKey: "movie-1",
					type: "movie",
					title: "Movie",
					externalIds: { tmdb: [100, 200], tvdb: [300, 400] },
				},
			]),
		);

		const result = await collectPlexNativeInventory(f.client);
		expect(result.complete).toBe(true);
		if (!result.complete) return;
		expect(result.snapshots[0]?.rows[0]?.externalIds).toEqual({
			tmdb: [100, 200],
			tvdb: [300, 400],
		});
	});

	it("retains native membership with unknown matching when identifiers disappear between passes", async () => {
		const f = fixture([section("movies", "movie")]);
		f.library
			.mockResolvedValueOnce(
				page([
					{ ratingKey: "movie-1", type: "movie", title: "Movie", externalIds: { tmdb: [100] } },
				]),
			)
			.mockResolvedValue(page([{ ratingKey: "movie-1", type: "movie", title: "Movie" }]));
		const result = await collectPlexNativeInventory(f.client);
		expect(result.complete).toBe(true);
		if (!result.complete) return;
		expect(result.snapshots[0]?.rows).toHaveLength(1);
		expect(result.snapshots[0]?.rows[0]?.externalIds).toBeUndefined();
	});

	it("publishes native items and preserves ambiguity when identifier metadata changes between passes", async () => {
		const f = fixture([section("movies", "movie")]);
		f.library
			.mockResolvedValueOnce(
				page([
					{ ratingKey: "movie-1", type: "movie", title: "Movie", externalIds: { tmdb: [100] } },
				]),
			)
			.mockResolvedValue(
				page([
					{ ratingKey: "movie-1", type: "movie", title: "Movie", externalIds: { tmdb: [200] } },
				]),
			);

		const result = await collectPlexNativeInventory(f.client);
		expect(result.complete).toBe(true);
		if (!result.complete) return;
		expect(result.snapshots[0]?.rows[0]?.externalIds).toEqual({ tmdb: [100, 200] });
	});

	it("does not publish a partial page or accept a changed total", async () => {
		const f = fixture();
		f.episodes.mockResolvedValue({ ...page([]), expectedRawCount: 5 });
		expect(await collectPlexNativeInventory(f.client)).toEqual({
			complete: false,
			reason: "coverage-incomplete",
		});
	});

	it("rejects same-count replacement between complete passes", async () => {
		const f = fixture();
		const original = await f.episodes();
		f.episodes
			.mockReset()
			.mockResolvedValueOnce(original)
			.mockResolvedValueOnce({
				...original,
				items: original.items.map((r, i) => (i === 0 ? { ...r, ratingKey: "replacement" } : r)),
			});
		expect(await collectPlexNativeInventory(f.client)).toEqual({
			complete: false,
			reason: "coverage-incomplete",
		});
	});

	it("does not let unrelated watch state or titles determine inventory identity", async () => {
		const f = fixture();
		const original = await f.episodes();
		f.episodes
			.mockReset()
			.mockResolvedValueOnce(original)
			.mockResolvedValueOnce({
				...original,
				items: original.items.map((r) => ({ ...r, title: "Updated title" })),
			});
		expect((await collectPlexNativeInventory(f.client)).complete).toBe(true);
	});

	it("rejects catalog revision changes during collection", async () => {
		const f = fixture();
		f.probe
			.mockResolvedValueOnce([section("shows", "show")])
			.mockResolvedValue([{ ...section("shows", "show"), updatedAt: 11 }]);
		expect(await collectPlexNativeInventory(f.client)).toEqual({
			complete: false,
			reason: "coverage-incomplete",
		});
	});

	it("rejects native IDs reused across libraries", async () => {
		const f = fixture([section("a", "movie"), section("b", "movie")]);
		f.library.mockResolvedValue(
			page([{ ratingKey: "same-id", type: "movie", title: "Same title" }]),
		);
		expect(await collectPlexNativeInventory(f.client)).toEqual({
			complete: false,
			reason: "coverage-incomplete",
		});
	});

	it("includes personal movie libraries without requiring a metadata agent", async () => {
		const f = fixture([{ ...section("personal", "movie"), agent: "com.plexapp.agents.none" }]);
		f.library.mockResolvedValue(page([{ ratingKey: "personal-item", type: "movie", title: "" }]));
		expect(await collectPlexNativeInventory(f.client)).toMatchObject({
			complete: true,
			snapshots: [{ rows: [{ nativeId: "personal-item" }] }, { rows: [] }],
		});
		expect(f.library).toHaveBeenCalledTimes(2);
	});

	it("returns only a bounded reason on provider failure", async () => {
		const f = fixture();
		f.episodes.mockRejectedValue(new Error("private upstream details"));
		expect(await collectPlexNativeInventory(f.client)).toEqual({
			complete: false,
			reason: "provider-unavailable",
		});
	});

	it("emits one sanitized warning for a transport failure at the first episode read", async () => {
		const lines: string[] = [];
		const log = pino(
			{ base: null, timestamp: false },
			{ write: (line: string) => lines.push(line) },
		);
		const f = fixture();
		f.episodes.mockRejectedValue(new Error("https://private.invalid/library/title?token=secret"));

		expect(await collectPlexNativeInventory(f.client, log as unknown as FastifyBaseLogger)).toEqual(
			{
				complete: false,
				reason: "provider-unavailable",
			},
		);
		expect(lines.map((line) => JSON.parse(line))).toEqual([
			expect.objectContaining({
				category: "plex-native-collection-rejected",
				stage: "first-episodes",
				reason: "provider-read-failed",
			}),
		]);
		expect(lines.join(" ")).not.toMatch(/private|secret|token=|title/);
	});

	it("keeps a page transport failure distinct from an incomplete page", async () => {
		const warn = vi.fn();
		const f = fixture();
		f.episodes.mockResolvedValue({ ...page([]), reason: "page-failure" as const });

		expect(
			await collectPlexNativeInventory(f.client, { warn } as unknown as FastifyBaseLogger),
		).toEqual({ complete: false, reason: "provider-unavailable" });
		expect(warn).toHaveBeenCalledWith(
			expect.objectContaining({
				category: "plex-native-collection-rejected",
				stage: "first-episodes",
				reason: "provider-read-failed",
			}),
			"Plex native inventory collection rejected",
		);
	});

	it("reports settlement reason codes without serializing provider payloads", async () => {
		const warn = vi.fn();
		const f = fixture();
		f.activities.mockResolvedValue([
			{ type: "library.update.item.metadata", Context: { librarySectionID: "private-section" } },
		]);

		expect(
			await collectPlexNativeInventory(f.client, { warn } as unknown as FastifyBaseLogger),
		).toEqual({ complete: false, reason: "coverage-incomplete" });
		expect(warn).toHaveBeenCalledTimes(1);
		expect(warn).toHaveBeenCalledWith(
			{
				category: "plex-native-collection-rejected",
				stage: "start-probe",
				reason: "plex_metadata_refresh_in_progress",
			},
			"Plex native inventory collection rejected",
		);
	});

	it.each([
		["between-probe", 2],
		["end-probe", 3],
	] as const)("reports a provider read failure at the %s", async (stage, read) => {
		const warn = vi.fn();
		const f = fixture();
		f.activities.mockReset();
		for (let i = 1; i < read; i++) f.activities.mockResolvedValueOnce([]);
		f.activities.mockRejectedValueOnce(new Error("transport canary"));

		expect(
			await collectPlexNativeInventory(f.client, { warn } as unknown as FastifyBaseLogger),
		).toMatchObject({ complete: false, reason: "provider-unavailable" });
		expect(warn).toHaveBeenCalledWith(
			expect.objectContaining({
				category: "plex-native-collection-rejected",
				stage,
				reason: "provider-read-failed",
			}),
			"Plex native inventory collection rejected",
		);
	});

	it.each([
		["invalid section id", "invalid-id", () => [section("", "movie")]],
		[
			"duplicate section id",
			"duplicate-id",
			() => [section("same", "movie"), section("same", "show")],
		],
	] as const)("reports %s without exposing the identifier", async (_name, reason, sections) => {
		const warn = vi.fn();
		const f = fixture(sections());
		expect(
			await collectPlexNativeInventory(f.client, { warn } as unknown as FastifyBaseLogger),
		).toMatchObject({ complete: false, reason: "coverage-incomplete" });
		expect(warn).toHaveBeenCalledWith(
			expect.objectContaining({
				category: "plex-native-collection-rejected",
				stage: "start-probe",
				reason,
			}),
			"Plex native inventory collection rejected",
		);
	});

	it("reports an unexpected provider item type at the library read", async () => {
		const warn = vi.fn();
		const f = fixture([section("movies", "movie")]);
		f.library.mockResolvedValue(
			page([{ ratingKey: "episode", type: "episode", title: "private title" }]),
		);
		expect(
			await collectPlexNativeInventory(f.client, { warn } as unknown as FastifyBaseLogger),
		).toMatchObject({ complete: false, reason: "coverage-incomplete" });
		expect(warn).toHaveBeenCalledWith(
			expect.objectContaining({
				category: "plex-native-collection-rejected",
				stage: "first-library",
				reason: "unexpected-item-type",
			}),
			"Plex native inventory collection rejected",
		);
	});

	it.each([
		["incomplete page", "first-episodes", "incomplete-page"],
		["changed catalog", "catalog-comparison", "catalog-changed"],
		["same-count replacement", "inventory-comparison", "inventory-changed"],
	] as const)("reports %s with a fixed reason", async (name, stage, reason) => {
		const warn = vi.fn();
		const f = fixture();
		if (name === "incomplete page") {
			f.episodes.mockResolvedValue({ ...page([]), expectedRawCount: 1 });
		} else if (name === "changed catalog") {
			f.probe
				.mockResolvedValueOnce([section("shows", "show")])
				.mockResolvedValue([{ ...section("shows", "show"), updatedAt: 11 }]);
		} else {
			const original = await f.episodes();
			f.episodes
				.mockReset()
				.mockResolvedValueOnce(original)
				.mockResolvedValueOnce({
					...original,
					items: original.items.map((r, i) => (i === 0 ? { ...r, ratingKey: "replacement" } : r)),
				});
		}

		expect(
			await collectPlexNativeInventory(f.client, { warn } as unknown as FastifyBaseLogger),
		).toMatchObject({ complete: false });
		expect(warn).toHaveBeenCalledWith(
			expect.objectContaining({ category: "plex-native-collection-rejected", stage, reason }),
			"Plex native inventory collection rejected",
		);
	});

	it("keeps the fail-closed result when the diagnostic logger throws", async () => {
		const f = fixture();
		f.episodes.mockRejectedValue(new Error("private upstream details"));
		const log = {
			warn: vi.fn(() => {
				throw new Error("logger failure");
			}),
		};

		await expect(
			collectPlexNativeInventory(f.client, log as unknown as FastifyBaseLogger),
		).resolves.toEqual({ complete: false, reason: "provider-unavailable" });
	});

	it("does not emit diagnostics with inherited authenticated user bindings", async () => {
		const lines: string[] = [];
		const root = pino(
			{ base: null, timestamp: false },
			{ write: (line: string) => lines.push(line) },
		);
		const f = fixture();
		f.episodes.mockRejectedValue(new Error("private upstream details"));
		await expect(
			collectPlexNativeInventory(f.client, root.child({ userId: "private-user-canary" })),
		).resolves.toEqual({ complete: false, reason: "provider-unavailable" });
		expect(lines).toEqual([]);
	});

	it("allows a successful recovery after a rejected collection", async () => {
		const warn = vi.fn();
		const f = fixture();
		f.episodes.mockRejectedValueOnce(new Error("transport canary")).mockResolvedValue(page([]));
		await expect(
			collectPlexNativeInventory(f.client, { warn } as unknown as FastifyBaseLogger),
		).resolves.toEqual({ complete: false, reason: "provider-unavailable" });
		expect((await collectPlexNativeInventory(f.client)).complete).toBe(true);
		expect(warn).toHaveBeenCalledTimes(1);
	});
});
