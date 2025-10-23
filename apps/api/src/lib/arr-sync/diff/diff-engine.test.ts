/**
 * Diff Engine Tests
 * Tests for the sync plan computation logic
 */

import { describe, it, expect } from "vitest";
import { computeSyncPlan, verifyIdempotency } from "./diff-engine";
import type { RemoteState, TrashCustomFormat } from "../types";

describe("Diff Engine", () => {
	const mockInstanceId = "test-instance";
	const mockInstanceLabel = "Test Instance";

	describe("computeSyncPlan", () => {
		it("should detect new custom formats to create", () => {
			const remoteState: RemoteState = {
				customFormats: [],
				qualityProfiles: [],
			};

			const desiredCustomFormats: TrashCustomFormat[] = [
				{
					trash_id: "cf-1",
					name: "Test Format",
					includeCustomFormatWhenRenaming: false,
					specifications: [],
				},
			];

			const plan = computeSyncPlan({
				instanceId: mockInstanceId,
				instanceLabel: mockInstanceLabel,
				remoteState,
				desiredCustomFormats,
				overrides: {},
				allowDeletes: false,
			});

			expect(plan.customFormats.creates).toHaveLength(1);
			expect(plan.customFormats.creates[0].name).toBe("Test Format");
			expect(plan.customFormats.updates).toHaveLength(0);
			expect(plan.customFormats.deletes).toHaveLength(0);
		});

		it("should detect existing custom formats requiring updates", () => {
			const remoteState: RemoteState = {
				customFormats: [
					{
						id: 1,
						name: "Test Format",
						includeCustomFormatWhenRenaming: false,
						specifications: [],
					},
				],
				qualityProfiles: [],
			};

			const desiredCustomFormats: TrashCustomFormat[] = [
				{
					trash_id: "cf-1",
					name: "Test Format",
					includeCustomFormatWhenRenaming: true, // Changed
					specifications: [],
				},
			];

			const plan = computeSyncPlan({
				instanceId: mockInstanceId,
				instanceLabel: mockInstanceLabel,
				remoteState,
				desiredCustomFormats,
				overrides: {},
				allowDeletes: false,
			});

			expect(plan.customFormats.creates).toHaveLength(0);
			expect(plan.customFormats.updates).toHaveLength(1);
			expect(plan.customFormats.updates[0].name).toBe("Test Format");
			expect(plan.customFormats.deletes).toHaveLength(0);
		});

		it("should skip disabled formats via overrides", () => {
			const remoteState: RemoteState = {
				customFormats: [],
				qualityProfiles: [],
			};

			const desiredCustomFormats: TrashCustomFormat[] = [
				{
					trash_id: "cf-1",
					name: "Test Format",
					includeCustomFormatWhenRenaming: false,
					specifications: [],
				},
			];

			const plan = computeSyncPlan({
				instanceId: mockInstanceId,
				instanceLabel: mockInstanceLabel,
				remoteState,
				desiredCustomFormats,
				overrides: {
					customFormats: {
						"Test Format": { enabled: false },
					},
					scores: {},
					profiles: {},
				},
				allowDeletes: false,
			});

			expect(plan.customFormats.creates).toHaveLength(0);
			expect(plan.customFormats.updates).toHaveLength(0);
			expect(plan.customFormats.deletes).toHaveLength(0);
		});

		it("should only delete when explicitly allowed", () => {
			const remoteState: RemoteState = {
				customFormats: [
					{
						id: 1,
						name: "Old Format",
						includeCustomFormatWhenRenaming: false,
						specifications: [],
					},
				],
				qualityProfiles: [],
			};

			const desiredCustomFormats: TrashCustomFormat[] = [];

			// Without allowDeletes
			const planNoDeletes = computeSyncPlan({
				instanceId: mockInstanceId,
				instanceLabel: mockInstanceLabel,
				remoteState,
				desiredCustomFormats,
				overrides: {},
				allowDeletes: false,
			});

			expect(planNoDeletes.customFormats.deletes).toHaveLength(0);

			// With allowDeletes
			const planWithDeletes = computeSyncPlan({
				instanceId: mockInstanceId,
				instanceLabel: mockInstanceLabel,
				remoteState,
				desiredCustomFormats,
				overrides: {},
				allowDeletes: true,
			});

			expect(planWithDeletes.customFormats.deletes).toHaveLength(1);
			expect(planWithDeletes.customFormats.deletes[0].name).toBe("Old Format");
		});
	});

	describe("verifyIdempotency", () => {
		it("should return true when plan has no changes", () => {
			const plan = {
				instanceId: mockInstanceId,
				instanceLabel: mockInstanceLabel,
				customFormats: {
					creates: [],
					updates: [],
					deletes: [],
				},
				qualityProfiles: {
					creates: [],
					updates: [],
				},
				warnings: [],
				errors: [],
			};

			const remoteState: RemoteState = {
				customFormats: [],
				qualityProfiles: [],
			};

			const isIdempotent = verifyIdempotency(plan, remoteState);
			expect(isIdempotent).toBe(true);
		});

		it("should return false when plan has pending changes", () => {
			const plan = {
				instanceId: mockInstanceId,
				instanceLabel: mockInstanceLabel,
				customFormats: {
					creates: [
						{
							name: "New Format",
							action: "create" as const,
							changes: ["New custom format"],
						},
					],
					updates: [],
					deletes: [],
				},
				qualityProfiles: {
					creates: [],
					updates: [],
				},
				warnings: [],
				errors: [],
			};

			const remoteState: RemoteState = {
				customFormats: [],
				qualityProfiles: [],
			};

			const isIdempotent = verifyIdempotency(plan, remoteState);
			expect(isIdempotent).toBe(false);
		});
	});
});
