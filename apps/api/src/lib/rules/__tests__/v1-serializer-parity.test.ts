/**
 * Round-trip parity between the v0→v1 mappers (read side) and the v1→v0
 * serializers (write side). This is the correctness contract for the
 * composer's down-convert-on-save: an authored document must serialize to a
 * v0 payload that maps back to the identical document, and a stored v0 rule
 * must map to a document that serializes back to the identical payload.
 *
 * The serializer emits the API PAYLOAD shape (params/conditions as objects);
 * the mapper consumes the STORAGE shape (stringified). The tiny `toRow`/
 * `toConditionsJson` helpers bridge the two exactly as the routes do.
 */

import {
	type CriteriaV0Payload,
	type RuleDocument,
	serializeCriteriaDocumentToV0,
	serializeNotificationsDocumentToV0,
} from "@arr/shared";
import { describe, expect, it } from "vitest";
import {
	type CriteriaV0Row,
	mapCriteriaV0ToDocument,
	mapNotificationsV0ToDocument,
} from "../v0-mappers.js";

/** Bridge a criteria payload (objects) to the storage row (strings). */
function toRow(p: CriteriaV0Payload): CriteriaV0Row {
	return {
		ruleType: p.ruleType,
		parameters: JSON.stringify(p.parameters),
		operator: p.operator,
		conditions: p.conditions ? JSON.stringify(p.conditions) : null,
	};
}

describe("criteria round-trip: v1 → serialize → map → v1", () => {
	const documents: Array<[string, RuleDocument]> = [
		[
			"single predicate",
			{
				version: 1,
				root: { kind: "age", params: { field: "arrAddedAt", operator: "older_than", days: 30 } },
			},
		],
		[
			"AND composite",
			{
				version: 1,
				root: {
					all: [
						{ kind: "age", params: { days: 30 } },
						{ kind: "no_file", params: {} },
					],
				},
			},
		],
		[
			"OR composite",
			{
				version: 1,
				root: {
					any: [
						{ kind: "size", params: { gb: 10 } },
						{ kind: "rating", params: { max: 5 } },
					],
				},
			},
		],
	];

	it.each(documents)("%s survives the round trip unchanged", (_label, doc) => {
		const payload = serializeCriteriaDocumentToV0(doc);
		const remapped = mapCriteriaV0ToDocument(toRow(payload));
		expect(remapped).toEqual(doc);
	});
});

describe("criteria round-trip: v0 → map → serialize → v0", () => {
	const rows: Array<[string, CriteriaV0Row]> = [
		[
			"single",
			{
				ruleType: "age",
				parameters: JSON.stringify({ days: 30 }),
				operator: null,
				conditions: null,
			},
		],
		[
			"composite",
			{
				ruleType: "composite",
				parameters: "{}",
				operator: "AND",
				conditions: JSON.stringify([
					{ ruleType: "age", parameters: { days: 30 } },
					{ ruleType: "no_file", parameters: {} },
				]),
			},
		],
	];

	it.each(rows)("%s survives the round trip unchanged", (_label, row) => {
		const doc = mapCriteriaV0ToDocument(row);
		const payload = serializeCriteriaDocumentToV0(doc);
		// Compare against the row's canonical object form.
		expect(payload).toEqual({
			ruleType: row.ruleType,
			parameters: JSON.parse(row.parameters),
			operator: row.operator,
			conditions: row.conditions ? JSON.parse(row.conditions) : null,
		});
	});
});

describe("notifications round-trip", () => {
	it("v1 → serialize → map → v1 is unchanged", () => {
		const doc: RuleDocument = {
			version: 1,
			root: {
				all: [
					{
						kind: "field_match",
						params: { field: "eventType", operator: "equals", value: "GRAB" },
					},
					{ kind: "field_match", params: { field: "title", operator: "contains", value: "4K" } },
				],
			},
		};
		const conditions = serializeNotificationsDocumentToV0(doc);
		expect(mapNotificationsV0ToDocument(conditions)).toEqual(doc);
	});

	it("empty conditions (matches every event) round-trips", () => {
		const doc: RuleDocument = { version: 1, root: { all: [] } };
		expect(mapNotificationsV0ToDocument(serializeNotificationsDocumentToV0(doc))).toEqual(doc);
	});
});
