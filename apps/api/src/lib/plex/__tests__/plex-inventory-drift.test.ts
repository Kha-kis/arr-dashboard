import { describe, expect, it } from "vitest";
import { classifyPlexInventoryDrift } from "../plex-inventory-drift.js";

function signature(overrides: Record<number, unknown> = {}) {
	const fields: unknown[] = [
		"section",
		"show",
		"item",
		"show",
		"title",
		null,
		1,
		2,
		3,
		"thumb",
		["guid"],
		["collection"],
		["label"],
	];
	for (const [index, value] of Object.entries(overrides)) fields[Number(index)] = value;
	return JSON.stringify(fields);
}

describe("Plex inventory drift diagnostics", () => {
	it("ignores item order without reporting any drift", () => {
		const a = signature();
		const b = signature({ 2: "other" });
		expect(classifyPlexInventoryDrift([a, b], [b, a])).toEqual([]);
	});

	it.each([
		[4, "updated", "display"],
		[5, 3, "watch"],
		[7, 4, "watch"],
		[8, 5, "watch"],
		[9, "updated", "display"],
		[10, ["other-guid"], "membership"],
		[11, ["other-collection"], "collections"],
		[12, ["other-label"], "labels"],
	] as const)("classifies field %s without returning its value", (index, value, expected) => {
		expect(classifyPlexInventoryDrift([signature()], [signature({ [index]: value })])).toEqual([
			expected,
		]);
	});

	it("classifies additions and removals as membership drift", () => {
		expect(classifyPlexInventoryDrift([], [signature()])).toEqual(["membership"]);
		expect(classifyPlexInventoryDrift([signature()], [])).toEqual(["membership"]);
	});

	it("preserves missing versus zero watch-count drift", () => {
		expect(classifyPlexInventoryDrift([signature({ 7: null })], [signature({ 7: 0 })])).toEqual([
			"watch",
		]);
	});

	it("reports every changed domain once in stable order", () => {
		expect(
			classifyPlexInventoryDrift([signature()], [signature({ 4: "new", 7: 9, 12: [] })]),
		).toEqual(["display", "watch", "labels"]);
	});

	it.each(["invalid-json", "{}", "[]", signature({ 2: null })])(
		"treats malformed signatures as unknown",
		(malformed) => {
			expect(classifyPlexInventoryDrift([signature()], [malformed])).toEqual(["unknown"]);
		},
	);

	it("does not infer domains from ambiguous duplicate source identities", () => {
		expect(classifyPlexInventoryDrift([signature(), signature()], [signature()])).toEqual([
			"unknown",
		]);
	});
});
