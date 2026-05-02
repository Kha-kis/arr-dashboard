import type { QuiCrossSeedMatch, QuiTorrent } from "@arr/shared";
import { describe, expect, it } from "vitest";
import {
	groupTorrentsByLibraryItem,
	hasUnregisteredSibling,
	isItemSeeding,
	type LibraryItemRef,
	type TorrentGroup,
} from "../correlation.js";

const torrent = (over: Partial<QuiTorrent>): QuiTorrent => ({
	hash: "h1",
	name: "T",
	state: "uploading",
	ratio: 1,
	progress: 1,
	numSeeds: 1,
	numLeechs: 0,
	tags: [],
	category: "",
	savePath: "/x",
	addedOn: 0,
	completedOn: 0,
	seedingTime: 0,
	eta: 0,
	dlSpeed: 0,
	upSpeed: 0,
	priority: 0,
	size: 100,
	...over,
});

const sibling = (over: Partial<QuiCrossSeedMatch>): QuiCrossSeedMatch => ({
	hash: "h-sib",
	name: "T",
	instanceId: 1,
	instanceName: "qb",
	state: "uploading",
	progress: 1,
	size: 100,
	category: "",
	savePath: "/x",
	contentPath: "/x/file",
	tracker: "tr",
	matchType: "release",
	tags: "",
	...over,
});

const ITEM: LibraryItemRef = { infoHash: "h1", arrItemId: 42, title: "Test" };

describe("groupTorrentsByLibraryItem", () => {
	it("attaches matched torrents and siblings to each item", () => {
		const items = [ITEM, { infoHash: "h2" } satisfies LibraryItemRef];
		const torrentsByHash = new Map([["h1", torrent({ hash: "h1" })]]);
		const siblingsByHash = new Map([["h1", [sibling({ hash: "h1-cross" })]]]);

		const groups = groupTorrentsByLibraryItem(items, torrentsByHash, siblingsByHash);

		expect(groups).toHaveLength(2);
		expect(groups[0]?.primary?.hash).toBe("h1");
		expect(groups[0]?.siblings).toHaveLength(1);
		expect(groups[1]?.primary).toBeNull();
		expect(groups[1]?.siblings).toEqual([]);
	});

	it("preserves item order in the output", () => {
		const items = [
			{ infoHash: "a" },
			{ infoHash: "b" },
			{ infoHash: "c" },
		] satisfies LibraryItemRef[];
		const groups = groupTorrentsByLibraryItem(items, new Map(), new Map());
		expect(groups.map((g) => g.item.infoHash)).toEqual(["a", "b", "c"]);
	});
});

describe("hasUnregisteredSibling", () => {
	it("returns true when any sibling reports unregistered", () => {
		expect(
			hasUnregisteredSibling([
				sibling({ trackerHealth: undefined }),
				sibling({ trackerHealth: "unregistered" }),
			]),
		).toBe(true);
	});

	it("returns false when no sibling is unregistered", () => {
		expect(
			hasUnregisteredSibling([
				sibling({ trackerHealth: undefined }),
				sibling({ trackerHealth: "tracker_down" }),
			]),
		).toBe(false);
	});

	it("returns false on empty input", () => {
		expect(hasUnregisteredSibling([])).toBe(false);
	});
});

describe("isItemSeeding", () => {
	const group = (primary: QuiTorrent | null, siblings: QuiCrossSeedMatch[]): TorrentGroup => ({
		item: ITEM,
		primary,
		siblings,
	});

	it("returns true when the primary torrent is uploading", () => {
		expect(isItemSeeding(group(torrent({ state: "uploading" }), []))).toBe(true);
		expect(isItemSeeding(group(torrent({ state: "forcedUP" }), []))).toBe(true);
	});

	it("returns true when a sibling is seeding even if primary is paused", () => {
		expect(
			isItemSeeding(group(torrent({ state: "pausedUP" }), [sibling({ state: "uploading" })])),
		).toBe(true);
	});

	it("returns true for stalledUP siblings (peers may return)", () => {
		expect(isItemSeeding(group(null, [sibling({ state: "stalledUP" })]))).toBe(true);
	});

	it("returns false when nothing is seeding anywhere", () => {
		expect(
			isItemSeeding(group(torrent({ state: "pausedUP" }), [sibling({ state: "pausedUP" })])),
		).toBe(false);
	});

	it("returns false with no primary and no siblings", () => {
		expect(isItemSeeding(group(null, []))).toBe(false);
	});
});
