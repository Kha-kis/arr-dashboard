/**
 * v0 → v1 mapper tests (unified-rule-grammar §3 / §4 step 1).
 *
 * Fixtures are author-shaped v0 rows derived from the cleanup
 * RULE_TEMPLATES factories and the rule-dialog buildParams outputs
 * (§4 step 3 as amended — the dev DB holds no real rule rows), plus
 * structural edge cases. Mapping is structural: retired kinds
 * (tautulli_*) map like any other; legality is the engine's concern.
 */

import { describe, expect, it } from "vitest";
import {
	type CriteriaV0Row,
	detectDocumentVersion,
	mapCriteriaV0ToDocument,
	mapNotificationsV0ToDocument,
	V0MapperError,
} from "../v0-mappers.js";

function row(overrides: Partial<CriteriaV0Row> = {}): CriteriaV0Row {
	return {
		ruleType: "age",
		parameters: JSON.stringify({ field: "arrAddedAt", operator: "older_than", days: 365 }),
		operator: null,
		conditions: null,
		...overrides,
	};
}

describe("detectDocumentVersion", () => {
	it("detects v1 by the version field", () => {
		expect(detectDocumentVersion({ version: 1, root: { kind: "age", params: {} } })).toBe("v1");
	});

	it("detects v0 criteria by top-level ruleType", () => {
		expect(detectDocumentVersion({ ruleType: "age", parameters: {} })).toBe("v0-criteria");
	});

	it("detects v0 notifications by bare array", () => {
		expect(detectDocumentVersion([{ field: "eventType", operator: "equals", value: "X" }])).toBe(
			"v0-notifications",
		);
	});

	it("flags everything else unrecognized", () => {
		expect(detectDocumentVersion("nope")).toBe("unrecognized");
		expect(detectDocumentVersion(null)).toBe("unrecognized");
		expect(detectDocumentVersion({ version: 2 })).toBe("unrecognized");
	});
});

describe("mapCriteriaV0ToDocument — single rules", () => {
	it("maps a template-shaped single rule (staleness_score)", () => {
		const doc = mapCriteriaV0ToDocument(
			row({
				ruleType: "staleness_score",
				parameters: JSON.stringify({ operator: "greater_than", threshold: 75 }),
			}),
		);
		expect(doc).toEqual({
			version: 1,
			root: { kind: "staleness_score", params: { operator: "greater_than", threshold: 75 } },
		});
	});

	it("maps an empty-params rule (seerr_requester_watched template)", () => {
		const doc = mapCriteriaV0ToDocument(
			row({ ruleType: "seerr_requester_watched", parameters: "{}" }),
		);
		expect(doc.root).toEqual({ kind: "seerr_requester_watched", params: {} });
	});

	it("maps a RETIRED kind structurally — legality is not the mapper's job", () => {
		// A disabled tautulli rule whose document the 3.0 pass preserved.
		const doc = mapCriteriaV0ToDocument(
			row({
				ruleType: "tautulli_last_watched",
				parameters: JSON.stringify({ operator: "older_than", days: 90 }),
			}),
		);
		expect(doc.root).toEqual({
			kind: "tautulli_last_watched",
			params: { operator: "older_than", days: 90 },
		});
	});

	it("treats empty parameters string as {}", () => {
		const doc = mapCriteriaV0ToDocument(row({ ruleType: "no_file", parameters: "" }));
		expect(doc.root).toEqual({ kind: "no_file", params: {} });
	});

	it("throws V0MapperError on unparseable parameters", () => {
		expect(() => mapCriteriaV0ToDocument(row({ parameters: "not-json{{{" }))).toThrow(
			V0MapperError,
		);
	});
});

describe("mapCriteriaV0ToDocument — composites", () => {
	const sizeCond = { ruleType: "size", parameters: { operator: "greater_than", sizeGb: 50 } };
	const watchedCond = {
		ruleType: "plex_watched_by",
		parameters: { operator: "includes_any", userNames: ["alice"] },
	};

	it("maps AND composite to an all-group", () => {
		const doc = mapCriteriaV0ToDocument(
			row({
				ruleType: "composite",
				operator: "AND",
				conditions: JSON.stringify([sizeCond, watchedCond]),
			}),
		);
		expect(doc.root).toEqual({
			all: [
				{ kind: "size", params: sizeCond.parameters },
				{ kind: "plex_watched_by", params: watchedCond.parameters },
			],
		});
	});

	it("maps OR composite to an any-group", () => {
		const doc = mapCriteriaV0ToDocument(
			row({ ruleType: "composite", operator: "OR", conditions: JSON.stringify([sizeCond]) }),
		);
		expect(doc.root).toEqual({ any: [{ kind: "size", params: sizeCond.parameters }] });
	});

	it("maps an empty composite to an empty group (disabled-orphan shape from the 3.0 pass)", () => {
		const doc = mapCriteriaV0ToDocument(
			row({ ruleType: "composite", operator: "AND", conditions: "[]" }),
		);
		expect(doc.root).toEqual({ all: [] });
	});

	it("throws on invalid operator", () => {
		expect(() =>
			mapCriteriaV0ToDocument(row({ ruleType: "composite", operator: "XOR", conditions: "[]" })),
		).toThrow(/invalid operator/);
	});

	it("throws on unparseable conditions JSON", () => {
		expect(() =>
			mapCriteriaV0ToDocument(
				row({ ruleType: "composite", operator: "AND", conditions: "not-json{{{" }),
			),
		).toThrow(V0MapperError);
	});

	it("throws on a condition without ruleType", () => {
		expect(() =>
			mapCriteriaV0ToDocument(
				row({
					ruleType: "composite",
					operator: "AND",
					conditions: JSON.stringify([{ parameters: {} }]),
				}),
			),
		).toThrow(/no ruleType/);
	});
});

describe("mapNotificationsV0ToDocument", () => {
	it("maps a flat conditions array to one all-group of field_match predicates", () => {
		const doc = mapNotificationsV0ToDocument([
			{ field: "eventType", operator: "equals", value: "HUNT_COMPLETED" },
			{ field: "title", operator: "contains", value: "sonarr" },
		]);
		expect(doc.root).toEqual({
			all: [
				{
					kind: "field_match",
					params: { field: "eventType", operator: "equals", value: "HUNT_COMPLETED" },
				},
				{ kind: "field_match", params: { field: "title", operator: "contains", value: "sonarr" } },
			],
		});
	});

	it("maps an empty array to an empty all-group (matches every event — 2.x semantics)", () => {
		expect(mapNotificationsV0ToDocument([]).root).toEqual({ all: [] });
	});

	it("passes metadata.* fields and array values through structurally", () => {
		const doc = mapNotificationsV0ToDocument([
			{ field: "metadata.instanceName", operator: "in", value: ["Primary Sonarr"] },
		]);
		expect(doc.root).toEqual({
			all: [
				{
					kind: "field_match",
					params: { field: "metadata.instanceName", operator: "in", value: ["Primary Sonarr"] },
				},
			],
		});
	});

	it("throws on a non-array", () => {
		expect(() => mapNotificationsV0ToDocument({ field: "x" })).toThrow(V0MapperError);
	});

	it("throws on a condition missing field/operator", () => {
		expect(() => mapNotificationsV0ToDocument([{ value: "x" }])).toThrow(/missing field/);
	});
});
