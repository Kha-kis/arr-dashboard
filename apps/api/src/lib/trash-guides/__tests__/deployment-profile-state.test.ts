import { describe, expect, it, vi } from "vitest";
import { rollbackQualityProfileDeployment } from "../deployment-profile-state.js";
import { createQualityProfileStateToken } from "../deployment-target.js";

function completeProfile(overrides: Record<string, unknown> = {}) {
	return {
		id: 4,
		name: "Existing",
		upgradeAllowed: true,
		cutoff: 1,
		items: [],
		minFormatScore: 0,
		cutoffFormatScore: 0,
		minUpgradeFormatScore: 0,
		formatItems: [],
		...overrides,
	};
}

describe("rollbackQualityProfileDeployment", () => {
	it("deletes a profile created by the deployment only while it is unchanged", async () => {
		const deployed = { id: 7, name: "Created profile", formatItems: [] };
		const remove = vi.fn().mockResolvedValue(undefined);
		const client = {
			qualityProfile: {
				getAll: vi.fn().mockResolvedValue([deployed]),
				getById: vi.fn().mockResolvedValue(deployed),
				delete: remove,
			},
		};

		await rollbackQualityProfileDeployment(client as never, {
			beforeProfile: null,
			action: "created",
			status: "applied",
			profileId: 7,
			postStateToken: createQualityProfileStateToken(deployed),
			intendedPostStateToken: null,
		});
		expect(remove).toHaveBeenCalledWith(7);
	});

	it("deletes an unchanged pending create from its verified created-state token", async () => {
		const created = { id: 7, name: "Created profile", formatItems: [] };
		const remove = vi.fn().mockResolvedValue(undefined);
		const client = {
			qualityProfile: {
				getAll: vi.fn().mockResolvedValue([created]),
				getById: vi.fn().mockResolvedValue(created),
				delete: remove,
			},
		};

		await rollbackQualityProfileDeployment(client as never, {
			beforeProfile: null,
			action: "created",
			status: "pending",
			profileId: 7,
			postStateToken: createQualityProfileStateToken(created),
			intendedPostStateToken: null,
		});

		expect(remove).toHaveBeenCalledWith(7);
	});

	it("refuses to delete a created profile changed after deployment", async () => {
		const remove = vi.fn();
		const client = {
			qualityProfile: {
				getAll: vi
					.fn()
					.mockResolvedValue([{ id: 7, name: "Created profile", formatItems: [{ score: 10 }] }]),
				getById: vi
					.fn()
					.mockResolvedValue({ id: 7, name: "Created profile", formatItems: [{ score: 10 }] }),
				delete: remove,
			},
		};

		await expect(
			rollbackQualityProfileDeployment(client as never, {
				beforeProfile: null,
				action: "created",
				status: "applied",
				profileId: 7,
				postStateToken: createQualityProfileStateToken({
					id: 7,
					name: "Created profile",
					formatItems: [],
				}),
				intendedPostStateToken: null,
			}),
		).rejects.toThrow("changed after deployment");
		expect(remove).not.toHaveBeenCalled();
	});

	it("restores an updated profile only from the recorded post-write state", async () => {
		const before = completeProfile({ formatItems: [{ format: 7, score: 0 }] });
		const deployed = completeProfile({ formatItems: [{ format: 7, score: 100 }] });
		const update = vi.fn().mockResolvedValue(undefined);
		const client = {
			qualityProfile: {
				getAll: vi.fn().mockResolvedValue([deployed]),
				getById: vi.fn().mockResolvedValue(deployed),
				update,
			},
		};

		await rollbackQualityProfileDeployment(client as never, {
			beforeProfile: before,
			action: "updated",
			status: "applied",
			profileId: 4,
			postStateToken: createQualityProfileStateToken(deployed),
			intendedPostStateToken: null,
		});
		expect(update).toHaveBeenCalledWith(4, before);
	});

	it("restores a valid profile containing ARR's Unknown quality ID zero", async () => {
		const before = completeProfile({
			cutoff: 0,
			items: [
				{
					id: 0,
					name: "Unknown",
					allowed: false,
					quality: { id: 0, name: "Unknown" },
					items: [],
				},
			],
		});
		const deployed = { ...before, formatItems: [{ format: 7, score: 100 }] };
		const update = vi.fn().mockResolvedValue(undefined);
		const client = {
			qualityProfile: {
				getAll: vi.fn().mockResolvedValue([deployed]),
				getById: vi.fn().mockResolvedValue(deployed),
				update,
			},
		};

		await expect(
			rollbackQualityProfileDeployment(client as never, {
				beforeProfile: before,
				action: "updated",
				status: "applied",
				profileId: 4,
				postStateToken: createQualityProfileStateToken(deployed),
				intendedPostStateToken: null,
			}),
		).resolves.toBeUndefined();
		expect(update).toHaveBeenCalledWith(4, before);
	});

	it.each([
		["incomplete", { id: 4, name: "Existing" }],
		["malformed nested item", completeProfile({ items: [{}] })],
		[
			"nested item with null children",
			completeProfile({
				items: [
					{
						id: 1,
						name: "HD",
						allowed: true,
						quality: { id: 1, name: "HD" },
						items: null,
					},
				],
			}),
		],
		[
			"nested item with omitted children",
			completeProfile({
				items: [
					{
						id: 1,
						name: "HD",
						allowed: true,
						quality: { id: 1, name: "HD" },
					},
				],
			}),
		],
		["same-title cross-wired", completeProfile({ id: 9 })],
	] as const)("rejects a %s persisted quality-profile snapshot", async (_label, beforeProfile) => {
		const deployed = { id: 4, name: "Existing", formatItems: [{ format: 7, score: 100 }] };
		const update = vi.fn();
		const client = {
			qualityProfile: {
				getAll: vi.fn().mockResolvedValue([deployed]),
				getById: vi.fn().mockResolvedValue(deployed),
				update,
			},
		};

		await expect(
			rollbackQualityProfileDeployment(client as never, {
				beforeProfile,
				action: "updated",
				status: "applied",
				profileId: 4,
				postStateToken: createQualityProfileStateToken(deployed),
				intendedPostStateToken: null,
			}),
		).rejects.toThrow("pre-deployment state");
		expect(update).not.toHaveBeenCalled();
	});

	it("treats an already-restored profile as an idempotent retry", async () => {
		const before = completeProfile({ formatItems: [{ format: 7, score: 0 }] });
		const update = vi.fn();
		const client = {
			qualityProfile: {
				getAll: vi.fn().mockResolvedValue([before]),
				getById: vi.fn().mockResolvedValue(before),
				update,
			},
		};

		await rollbackQualityProfileDeployment(client as never, {
			beforeProfile: before,
			action: "updated",
			status: "applied",
			profileId: 4,
			postStateToken: createQualityProfileStateToken({
				...before,
				formatItems: [{ format: 7, score: 100 }],
			}),
			intendedPostStateToken: null,
		});
		expect(update).not.toHaveBeenCalled();
	});

	it("treats a pending update still at its before-state as an idempotent retry", async () => {
		const before = completeProfile({ formatItems: [{ format: 7, score: 0 }] });
		const client = {
			qualityProfile: {
				getAll: vi.fn().mockResolvedValue([before]),
				getById: vi.fn().mockResolvedValue(before),
			},
		};

		await expect(
			rollbackQualityProfileDeployment(client as never, {
				beforeProfile: before,
				action: "updated",
				status: "pending",
				profileId: 4,
				postStateToken: null,
				intendedPostStateToken: null,
			}),
		).resolves.toBeUndefined();
	});

	it("fails closed when a pending update left an unknown current state", async () => {
		const before = completeProfile({ formatItems: [{ format: 7, score: 0 }] });
		const changed = { ...before, formatItems: [{ score: 50 }] };
		const client = {
			qualityProfile: {
				getAll: vi.fn().mockResolvedValue([changed]),
				getById: vi.fn().mockResolvedValue(changed),
			},
		};

		await expect(
			rollbackQualityProfileDeployment(client as never, {
				beforeProfile: before,
				action: "updated",
				status: "pending",
				profileId: 4,
				postStateToken: null,
				intendedPostStateToken: null,
			}),
		).rejects.toThrow("unverified deployment state");
	});

	it("restores a pending update when the upstream state matches the recorded intent", async () => {
		const before = completeProfile({ formatItems: [{ format: 7, score: 0 }] });
		const intended = completeProfile({ formatItems: [{ format: 7, score: 100 }] });
		const update = vi.fn().mockResolvedValue(undefined);
		const client = {
			qualityProfile: {
				getAll: vi.fn().mockResolvedValue([intended]),
				getById: vi.fn().mockResolvedValue(intended),
				update,
			},
		};
		const state = {
			beforeProfile: before,
			action: "updated" as const,
			status: "pending" as const,
			profileId: 4,
			postStateToken: null,
			intendedPostStateToken: createQualityProfileStateToken(intended),
		};

		await rollbackQualityProfileDeployment(client as never, state);
		expect(update).toHaveBeenCalledWith(4, before);
	});

	it("restores a pending update from its verified normalized post-write state", async () => {
		const before = completeProfile({ formatItems: [{ format: 7, score: 0 }] });
		const intended = completeProfile({ formatItems: [{ format: 7, score: 100 }] });
		const normalized = completeProfile({
			formatItems: [{ format: 7, score: 100, name: "Normalized by ARR" }],
		});
		const update = vi.fn().mockResolvedValue(undefined);
		const client = {
			qualityProfile: {
				getAll: vi.fn().mockResolvedValue([normalized]),
				getById: vi.fn().mockResolvedValue(normalized),
				update,
			},
		};

		await rollbackQualityProfileDeployment(client as never, {
			beforeProfile: before,
			action: "updated",
			status: "pending",
			profileId: 4,
			postStateToken: createQualityProfileStateToken(normalized),
			intendedPostStateToken: createQualityProfileStateToken(intended),
		});

		expect(update).toHaveBeenCalledWith(4, before);
	});

	it("keeps an unknown-ID create unresolved when the profile may have been renamed", async () => {
		const client = {
			qualityProfile: {
				getAll: vi.fn().mockResolvedValue([{ id: 12, name: "Renamed after create" }]),
			},
		};

		await expect(
			rollbackQualityProfileDeployment(client as never, {
				beforeProfile: null,
				action: "created",
				status: "pending",
				profileId: null,
				profileName: "Created profile",
				postStateToken: null,
				intendedPostStateToken: null,
			}),
		).rejects.toThrow("ID is unknown");
	});
});
