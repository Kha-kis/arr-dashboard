import { describe, expect, it } from "vitest";
import { serializeApproval } from "../library-cleanup.js";

describe("library cleanup approval serialization", () => {
	it("returns the persisted execution error for an actionable retry", () => {
		const timestamp = new Date("2026-07-27T12:00:00.000Z");

		expect(
			serializeApproval({
				id: "approval-1",
				instanceId: "radarr-4k",
				arrItemId: 101,
				itemType: "movie",
				title: "Example Movie",
				matchedRuleId: "rule-1",
				matchedRuleName: "4K cleanup",
				reason: "Matched 4K profile",
				action: "delete",
				sizeOnDisk: 1000n,
				year: 2024,
				rating: 8,
				status: "pending",
				lastExecutionError: "Skipped for safety: shared Plex risk",
				reviewedAt: null,
				executedAt: null,
				createdAt: timestamp,
				expiresAt: timestamp,
			}),
		).toMatchObject({
			id: "approval-1",
			status: "pending",
			lastExecutionError: "Skipped for safety: shared Plex risk",
		});
	});

	it("normalizes approvals without an execution error to null", () => {
		const timestamp = new Date("2026-07-27T12:00:00.000Z");

		expect(
			serializeApproval({
				id: "approval-1",
				sizeOnDisk: 0n,
				createdAt: timestamp,
				expiresAt: timestamp,
			}).lastExecutionError,
		).toBeNull();
	});
});
