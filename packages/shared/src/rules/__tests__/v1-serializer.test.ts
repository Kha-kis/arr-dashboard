import { describe, expect, it } from "vitest";
import type { RuleDocument } from "../grammar.js";
import {
	serializeCriteriaDocumentToV0,
	serializeNotificationsDocumentToV0,
	V1SerializerError,
} from "../v1-serializer.js";

describe("serializeCriteriaDocumentToV0", () => {
	it("down-converts a single-predicate document to a single rule", () => {
		const doc: RuleDocument = {
			version: 1,
			root: { kind: "age", params: { field: "arrAddedAt", operator: "older_than", days: 30 } },
		};
		expect(serializeCriteriaDocumentToV0(doc)).toEqual({
			ruleType: "age",
			parameters: { field: "arrAddedAt", operator: "older_than", days: 30 },
			operator: null,
			conditions: null,
		});
	});

	it("down-converts an all-group to an AND composite", () => {
		const doc: RuleDocument = {
			version: 1,
			root: {
				all: [
					{ kind: "age", params: { days: 30 } },
					{ kind: "no_file", params: {} },
				],
			},
		};
		expect(serializeCriteriaDocumentToV0(doc)).toEqual({
			ruleType: "composite",
			parameters: {},
			operator: "AND",
			conditions: [
				{ ruleType: "age", parameters: { days: 30 } },
				{ ruleType: "no_file", parameters: {} },
			],
		});
	});

	it("down-converts an any-group to an OR composite", () => {
		const doc: RuleDocument = {
			version: 1,
			root: { any: [{ kind: "size", params: { gb: 10 } }] },
		};
		expect(serializeCriteriaDocumentToV0(doc).operator).toBe("OR");
	});

	it("rejects an empty composite (no conditions)", () => {
		const doc: RuleDocument = { version: 1, root: { all: [] } };
		expect(() => serializeCriteriaDocumentToV0(doc)).toThrow(V1SerializerError);
	});

	it("rejects a nested group (v1 is depth-1)", () => {
		const doc: RuleDocument = {
			version: 1,
			root: { all: [{ any: [{ kind: "age", params: {} }] }] },
		};
		expect(() => serializeCriteriaDocumentToV0(doc)).toThrow(/depth-1/);
	});
});

describe("serializeNotificationsDocumentToV0", () => {
	it("down-converts an all-group of field_match to a flat conditions array", () => {
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
		expect(serializeNotificationsDocumentToV0(doc)).toEqual([
			{ field: "eventType", operator: "equals", value: "GRAB" },
			{ field: "title", operator: "contains", value: "4K" },
		]);
	});

	it("maps an empty all-group to [] (matches every event)", () => {
		const doc: RuleDocument = { version: 1, root: { all: [] } };
		expect(serializeNotificationsDocumentToV0(doc)).toEqual([]);
	});

	it("accepts a lone field_match predicate root", () => {
		const doc: RuleDocument = {
			version: 1,
			root: { kind: "field_match", params: { field: "body", operator: "contains", value: "x" } },
		};
		expect(serializeNotificationsDocumentToV0(doc)).toEqual([
			{ field: "body", operator: "contains", value: "x" },
		]);
	});

	it("rejects an OR (any) group — notifications are implicit-AND only", () => {
		const doc: RuleDocument = {
			version: 1,
			root: {
				any: [{ kind: "field_match", params: { field: "a", operator: "equals", value: "b" } }],
			},
		};
		expect(() => serializeNotificationsDocumentToV0(doc)).toThrow(/OR/);
	});

	it("rejects a non-field_match predicate", () => {
		const doc: RuleDocument = {
			version: 1,
			root: { all: [{ kind: "age", params: { days: 30 } }] },
		};
		expect(() => serializeNotificationsDocumentToV0(doc)).toThrow(/field_match/);
	});
});
