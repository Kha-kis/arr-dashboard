import { describe, expect, it } from "vitest";
import {
	manualImportLegacyStatusSchema,
	manualImportSourceQuerySchema,
	manualImportSourceStatusSchema,
} from "../manual-import.js";

const operation = {
	operationId: "opaque-operation",
	state: "unknown",
	reason: null,
	selectedFileCount: 2,
	verifiedFileCount: 0,
	canConsiderNewAttempt: true,
};
describe("closed legacy import status", () => {
	it.each([
		{ kind: "none" },
		{ kind: "unavailable", reason: "evidence-unavailable" },
		{ kind: "observed", operation },
	])("accepts $kind without invented legacy counts", (value) => {
		expect(manualImportLegacyStatusSchema.safeParse(value).success).toBe(true);
	});
	it.each([
		{ kind: "none", selectedFileCount: 0 },
		{ kind: "unavailable", reason: "evidence-unavailable", verifiedFileCount: 0 },
		{ kind: "unavailable", reason: "provider-private-detail" },
		{ kind: "observed", operation: { ...operation, selectedFileCount: 0 } },
		{ kind: "observed", operation: { ...operation, state: "completed" } },
		{ kind: "future" },
		{ kind: "none", downloadId: "private-source" },
		{ kind: "observed", operation, encryptedSources: "private-cipher" },
	])("rejects unsafe legacy payload %#", (value) => {
		expect(manualImportLegacyStatusSchema.safeParse(value).success).toBe(false);
	});
});

describe("bounded cached source history contract", () => {
	it.each([
		{ kind: "history", operations: [], nextCursor: null },
		{ kind: "history", operations: [operation], nextCursor: null },
		{ kind: "history", operations: [operation], nextCursor: operation.operationId },
	])("accepts explicit history without selecting a current attempt %#", (value) => {
		expect(manualImportSourceStatusSchema.safeParse(value).success).toBe(true);
		expect(manualImportLegacyStatusSchema.safeParse(value).success).toBe(false);
	});
	it.each([
		{ kind: "history", operations: [], nextCursor: "missing" },
		{ kind: "history", operations: [operation, operation], nextCursor: null },
		{ kind: "history", operations: [operation], nextCursor: "different" },
		{
			kind: "history",
			operations: Array.from({ length: 21 }, (_, i) => ({
				...operation,
				operationId: `operation-${i}`,
			})),
			nextCursor: null,
		},
		{ kind: "history", operations: [{ ...operation, path: "/private" }], nextCursor: null },
		{ kind: "history", operations: [operation], nextCursor: null, total: 0 },
	])("rejects unbounded, duplicate, inconsistent or private history %#", (value) => {
		expect(manualImportSourceStatusSchema.safeParse(value).success).toBe(false);
	});
	it("accepts only a bounded optional source cursor", () => {
		const query = { instanceId: "instance", service: "radarr", downloadId: "source" };
		expect(
			manualImportSourceQuerySchema.safeParse({ ...query, cursor: "operation/+&?" }).success,
		).toBe(true);
		for (const cursor of ["", "x".repeat(129)])
			expect(manualImportSourceQuerySchema.safeParse({ ...query, cursor }).success).toBe(false);
	});
});
