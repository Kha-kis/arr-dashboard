import { describe, expect, it } from "vitest";
import {
	PLEX_CANONICALIZATION_VERSION,
	createPlexSelectionProjection,
} from "../plex-canonical-projection.js";

const baseRows = [
	{
		sectionId: "movies",
		mediaType: "movie" as const,
		tmdbId: 1,
		ratingKey: "101",
		title: "Selected",
		labels: ["Keep", "Favorite"],
		collections: ["A"],
		watchCount: 2,
		watchedByUsers: ["admin"],
		lastWatchedAt: "2026-08-20T12:00:00.000Z",
		onDeck: false,
		userRating: 8,
		addedAt: "2026-08-01T12:00:00.000Z",
		thumb: "/library/metadata/101/thumb/1",
	},
	{
		sectionId: "movies",
		mediaType: "movie" as const,
		tmdbId: 2,
		ratingKey: "102",
		title: "Unrelated",
		labels: ["Other"],
		collections: [],
		watchCount: 0,
		watchedByUsers: [],
		lastWatchedAt: null,
		onDeck: false,
		userRating: null,
		addedAt: null,
		thumb: null,
	},
];

const selected = {
	kind: "targets" as const,
	targets: [{ mediaType: "movie" as const, tmdbId: 1 }],
};

describe("Plex canonical selection projections", () => {
	it("uses a stable explicit algorithm and set ordering", () => {
		const first = createPlexSelectionProjection({
			rows: baseRows,
			selection: selected,
			domains: ["membership", "labels", "collections", "watch"],
		});
		const reordered = createPlexSelectionProjection({
			rows: [
				{ ...baseRows[1]!, labels: [...baseRows[1]!.labels].reverse() },
				{ ...baseRows[0]!, labels: [...baseRows[0]!.labels].reverse() },
			],
			selection: selected,
			domains: ["watch", "collections", "labels", "membership"],
		});

		expect(PLEX_CANONICALIZATION_VERSION).toBe(1);
		expect(first).toEqual(reordered);
		expect(first.digest).toMatch(/^[a-f0-9]{64}$/);
	});

	it("isolates unrelated targets and unrelated domains", () => {
		const original = createPlexSelectionProjection({
			rows: baseRows,
			selection: selected,
			domains: ["membership", "labels"],
		});
		const unrelatedTargetChanged = createPlexSelectionProjection({
			rows: [baseRows[0]!, { ...baseRows[1]!, labels: ["Changed"] }],
			selection: selected,
			domains: ["membership", "labels"],
		});
		const unrelatedDomainChanged = createPlexSelectionProjection({
			rows: [{ ...baseRows[0]!, watchCount: 99 }, baseRows[1]!],
			selection: selected,
			domains: ["membership", "labels"],
		});

		expect(unrelatedTargetChanged).toEqual(original);
		expect(unrelatedDomainChanged).toEqual(original);
	});

	it("changes only the meaningful selected domain", () => {
		const original = createPlexSelectionProjection({
			rows: baseRows,
			selection: selected,
			domains: ["membership", "labels", "watch"],
		});
		const labelChanged = createPlexSelectionProjection({
			rows: [{ ...baseRows[0]!, labels: ["Keep"] }, baseRows[1]!],
			selection: selected,
			domains: ["membership", "labels", "watch"],
		});
		const watchChanged = createPlexSelectionProjection({
			rows: [{ ...baseRows[0]!, watchCount: 3 }, baseRows[1]!],
			selection: selected,
			domains: ["membership", "labels", "watch"],
		});

		expect(labelChanged.domains.membership).toBe(original.domains.membership);
		expect(labelChanged.domains.watch).toBe(original.domains.watch);
		expect(labelChanged.domains.labels).not.toBe(original.domains.labels);
		expect(watchChanged.domains.membership).toBe(original.domains.membership);
		expect(watchChanged.domains.labels).toBe(original.domains.labels);
		expect(watchChanged.domains.watch).not.toBe(original.domains.watch);
	});

	it("detects selected additions and deletions through membership", () => {
		const selection = { kind: "all" as const };
		const original = createPlexSelectionProjection({
			rows: baseRows,
			selection,
			domains: ["membership"],
		});
		const deleted = createPlexSelectionProjection({
			rows: [baseRows[0]!],
			selection,
			domains: ["membership"],
		});
		const added = createPlexSelectionProjection({
			rows: [...baseRows, { ...baseRows[0]!, tmdbId: 3, ratingKey: "103", title: "Added" }],
			selection,
			domains: ["membership"],
		});

		expect(deleted.domains.membership).not.toBe(original.domains.membership);
		expect(added.domains.membership).not.toBe(original.domains.membership);
	});
});
