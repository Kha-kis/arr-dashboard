import { describe, expect, it } from "vitest";
import { manualImportOperationStatusSchema } from "../manual-import.js";

const status = {
	operationId: "opaque-attempt",
	state: "pending",
	reason: null,
	selectedFileCount: 2,
	verifiedFileCount: 0,
	canConsiderNewAttempt: false,
};

describe("cached manual import status contract", () => {
	it.each(["preparing", "submitting", "pending", "unknown", "partial", "failed", "not-submitted"])(
		"accepts generic %s progress",
		(state) => {
			expect(
				manualImportOperationStatusSchema.safeParse({
					...status,
					state,
					verifiedFileCount: state === "partial" ? 1 : 0,
				}).success,
			).toBe(true);
		},
	);
	it("accepts verified completion but not aggregate command success", () => {
		expect(
			manualImportOperationStatusSchema.safeParse({
				...status,
				state: "completed",
				verifiedFileCount: 2,
			}).success,
		).toBe(true);
		expect(
			manualImportOperationStatusSchema.safeParse({ ...status, state: "completed" }).success,
		).toBe(false);
	});
	it.each([
		"encryptedSources",
		"sourcesEncryptionIv",
		"command",
		"files",
		"downloadId",
		"instanceLabel",
		"error",
	])("rejects extra private %s fields", (field) => {
		expect(
			manualImportOperationStatusSchema.safeParse({ ...status, [field]: "synthetic-private" })
				.success,
		).toBe(false);
	});
	it.each([
		{ selectedFileCount: 0 },
		{ selectedFileCount: 1001 },
		{ verifiedFileCount: 3 },
		{ verifiedFileCount: -1 },
		{ verifiedFileCount: 0.5 },
		{ reason: "synthetic-provider-detail" },
		{ state: "future-state" },
		{ operationId: "" },
		{ canConsiderNewAttempt: true },
		{ state: "completed", verifiedFileCount: 2, canConsiderNewAttempt: true },
		{ state: "partial", verifiedFileCount: 0 },
		{ state: "failed", verifiedFileCount: 1 },
		{ state: "not-submitted", verifiedFileCount: 1 },
	])("rejects invalid or unsafe status $state $reason", (change) => {
		expect(manualImportOperationStatusSchema.safeParse({ ...status, ...change }).success).toBe(
			false,
		);
	});
	it.each(["partial", "unknown", "failed", "not-submitted"])(
		"permits explicit reconsideration for %s without authorizing submission",
		(state) => {
			expect(
				manualImportOperationStatusSchema.safeParse({
					...status,
					state,
					verifiedFileCount: state === "partial" ? 1 : 0,
					canConsiderNewAttempt: true,
				}).success,
			).toBe(true);
		},
	);
});
