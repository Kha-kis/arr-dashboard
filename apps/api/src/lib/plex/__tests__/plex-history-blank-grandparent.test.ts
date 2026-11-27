import { afterEach, expect, it, vi } from "vitest";
import { PlexClient } from "../plex-client.js";

type HistoryRow = Record<string, unknown>;

function historyRow(overrides: HistoryRow = {}): HistoryRow {
	return {
		historyKey: "/status/sessions/history/1",
		ratingKey: "142",
		parentRatingKey: "141",
		parentKey: "/library/metadata/141",
		grandparentRatingKey: "",
		grandparentKey: "/library/metadata/140",
		type: "episode",
		title: "Episode",
		viewedAt: 1_700_000_000,
		accountID: 1,
		librarySectionID: "7",
		...overrides,
	};
}

function page(row: HistoryRow): Response {
	return new Response(
		JSON.stringify({
			MediaContainer: { offset: 0, size: 1, totalSize: 1, Metadata: [row] },
		}),
		{ headers: { "Content-Type": "application/json" } },
	);
}

function clientFor(...rows: HistoryRow[]): PlexClient {
	const fetchMock = vi.fn();
	for (const row of rows) fetchMock.mockResolvedValueOnce(page(row));
	vi.stubGlobal("fetch", fetchMock);
	return new PlexClient("http://plex.invalid", "synthetic-token", { warn: vi.fn() } as never);
}

afterEach(() => {
	vi.unstubAllGlobals();
});

it("derives a blank episode show ID only from its canonical same-level key", async () => {
	const history = await clientFor(historyRow()).getHistory({
		maxResults: 100_000,
		requireComplete: true,
	});
	expect(history[0]).toMatchObject({
		grandparentRatingKey: "140",
		grandparentKeyFallback: true,
	});
});

it.each(["/library/metadata/140/children", "/library/metadata/140?x=1", "/library/metadata/0"])(
	"leaves a blank show ID unresolved for a noncanonical key: %s",
	async (grandparentKey) => {
		const history = await clientFor(historyRow({ grandparentKey })).getHistory({
			maxResults: 100_000,
			requireComplete: true,
		});
		expect(history[0]?.grandparentRatingKey).toBe("");
		expect(history[0]?.grandparentKeyFallback).toBeUndefined();
	},
);

it("preserves ordinary omitted-field fallback behavior", async () => {
	const row = historyRow({
		grandparentRatingKey: undefined,
		grandparentKey: "/library/metadata/140/children",
	});
	const history = await clientFor(row).getHistory({ maxResults: 100_000, requireComplete: true });
	expect(history[0]?.grandparentRatingKey).toBe("140");
	expect(history[0]?.grandparentKeyFallback).toBeUndefined();
});

it("preserves a nonblank direct show ID even when the canonical path differs", async () => {
	const history = await clientFor(historyRow({ grandparentRatingKey: "141" })).getHistory({
		maxResults: 100_000,
		requireComplete: true,
	});
	expect(history[0]?.grandparentRatingKey).toBe("141");
	expect(history[0]?.grandparentKeyFallback).toBeUndefined();
});

it("rejects a changed fallback identity on complete history readback", async () => {
	const client = clientFor(historyRow(), historyRow({ grandparentKey: "/library/metadata/143" }));
	const history = await client.getHistory({ maxResults: 100_000, requireComplete: true });
	await expect(client.verifyHistorySnapshot(history)).rejects.toThrow("changed");
});
