import { describe, expect, it } from "vitest";
import { buildCleanupNotification } from "../cleanup-scheduler.js";
import type { CleanupRunResult } from "../types.js";

function result(overrides: Partial<CleanupRunResult>): CleanupRunResult {
	return {
		isDryRun: false,
		status: "partial",
		itemsEvaluated: 1,
		itemsFlagged: 1,
		itemsRemoved: 0,
		itemsUnmonitored: 0,
		itemsFilesDeleted: 0,
		itemsSkipped: 1,
		details: [
			{
				instanceId: "radarr-4k",
				arrItemId: 101,
				title: "Example",
				ruleId: "rule-1",
				rule: "4K cleanup",
				reason: "Safety blocked",
				action: "skipped",
			},
		],
		durationMs: 10,
		...overrides,
	};
}

describe("cleanup scheduler notifications", () => {
	it("reports blocked-only direct runs without claiming items were queued", () => {
		const notification = buildCleanupNotification(result({}));

		expect(notification).toMatchObject({
			eventType: "CLEANUP_ITEMS_FLAGGED",
			title: "Library cleanup needs review",
			body: "1 safety-blocked or skipped",
			url: "/library-cleanup",
		});
		expect(notification?.body).not.toContain("queued");
	});

	it("reports both queued and blocked approval items", () => {
		const notification = buildCleanupNotification(
			result({
				itemsFlagged: 1,
				details: [
					{ ...result({}).details[0]!, action: "queued_for_approval" },
					result({}).details[0]!,
				],
			}),
		);

		expect(notification?.body).toBe("1 queued for review, 1 safety-blocked or skipped");
	});

	it("includes skipped items alongside completed actions", () => {
		const notification = buildCleanupNotification(result({ itemsRemoved: 1 }));

		expect(notification).toMatchObject({
			eventType: "CLEANUP_ITEMS_REMOVED",
			title: "Library cleanup needs review",
			body: "1 removed, 1 skipped",
		});
	});

	it("marks a partial file deletion for review even when skipped count is zero", () => {
		const notification = buildCleanupNotification(
			result({
				status: "partial",
				itemsFilesDeleted: 1,
				itemsSkipped: 0,
			}),
		);

		expect(notification).toMatchObject({
			eventType: "CLEANUP_ITEMS_REMOVED",
			title: "Library cleanup needs review",
			body: "1 files deleted",
		});
	});
});
