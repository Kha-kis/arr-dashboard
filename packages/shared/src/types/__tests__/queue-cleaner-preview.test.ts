import { describe, expect, it } from "vitest";
import { enhancedPreviewItemSchema, enhancedPreviewResultSchema } from "../queue-cleaner.js";

const item = {
	id: 42,
	title: "Synthetic",
	action: "import",
	rule: "import_pending",
	reason: "Would attempt import; source retained",
	detailedReason: "Current provider verification is required; source retained",
	queueAge: 60,
};
const result = {
	instanceId: "synthetic-instance",
	instanceLabel: "Synthetic",
	instanceService: "radarr",
	instanceReachable: true,
	queueSummary: {
		totalItems: 1,
		downloading: 0,
		paused: 0,
		queued: 0,
		seeding: 0,
		importPending: 1,
		failed: 0,
	},
	wouldRemove: 0,
	wouldImport: 1,
	wouldWarn: 0,
	wouldSkip: 0,
	previewItems: [item],
	ruleSummary: { import_pending: 1 },
	previewGeneratedAt: "2026-10-01T12:00:00.000Z",
	configSnapshot: {
		dryRunMode: false,
		strikeSystemEnabled: false,
		maxStrikes: 2,
		maxRemovalsPerRun: 10,
	},
};
describe("Cleaner import-attempt preview contract", () => {
	it("preserves import actions and the separate attempt count across parsing", () => {
		expect(enhancedPreviewItemSchema.parse(item).action).toBe("import");
		expect(enhancedPreviewResultSchema.parse(result)).toMatchObject({
			wouldImport: 1,
			wouldRemove: 0,
		});
	});
	it.each([-1, 0.5, "1", undefined])(
		"rejects an invalid or missing attempt count (%s)",
		(wouldImport) => {
			expect(
				enhancedPreviewResultSchema.safeParse({ ...result, previewItems: [], wouldImport }).success,
			).toBe(false);
		},
	);
});
