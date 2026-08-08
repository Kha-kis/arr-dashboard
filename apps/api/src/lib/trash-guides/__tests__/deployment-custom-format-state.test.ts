import { describe, expect, it, vi } from "vitest";
import {
	type CustomFormatRollbackState,
	rollbackCustomFormatDeployment,
} from "../deployment-custom-format-state.js";
import { createUpstreamResourceStateToken } from "../deployment-target.js";

const appliedState = (
	overrides: Partial<CustomFormatRollbackState> = {},
): CustomFormatRollbackState => ({
	beforeFormat: null,
	action: "created",
	resourceId: 7,
	name: "Created CF",
	status: "applied",
	postStateToken: createUpstreamResourceStateToken({
		id: 7,
		name: "Created CF",
		specifications: [],
	}),
	intendedPostStateToken: null,
	...overrides,
});

describe("rollbackCustomFormatDeployment", () => {
	it("deletes only the exact unchanged Custom Format created by deployment", async () => {
		const deployed = { id: 7, name: "Created CF", specifications: [] };
		const remove = vi.fn().mockResolvedValue(undefined);
		const client = {
			customFormat: {
				getAll: vi.fn().mockResolvedValue([deployed]),
				getById: vi.fn().mockResolvedValue(deployed),
				delete: remove,
			},
			qualityProfile: { getAll: vi.fn().mockResolvedValue([]) },
		};

		await expect(rollbackCustomFormatDeployment(client as never, appliedState())).resolves.toBe(
			"deleted",
		);
		expect(remove).toHaveBeenCalledWith(7);
	});

	it("refuses to delete a created Custom Format that changed after deployment", async () => {
		const changed = { id: 7, name: "Operator CF", specifications: [] };
		const remove = vi.fn();
		const client = {
			customFormat: {
				getAll: vi.fn().mockResolvedValue([changed]),
				getById: vi.fn().mockResolvedValue(changed),
				delete: remove,
			},
		};

		await expect(rollbackCustomFormatDeployment(client as never, appliedState())).rejects.toThrow(
			"changed after deployment",
		);
		expect(remove).not.toHaveBeenCalled();
	});

	it("refuses to delete an unchanged created Custom Format reused by a live profile", async () => {
		const deployed = { id: 7, name: "Created CF", specifications: [] };
		const remove = vi.fn();
		const client = {
			customFormat: {
				getAll: vi.fn().mockResolvedValue([deployed]),
				getById: vi.fn().mockResolvedValue(deployed),
				delete: remove,
			},
			qualityProfile: {
				getAll: vi
					.fn()
					.mockResolvedValue([{ id: 3, name: "Manually reused", formatItems: [{ format: 7 }] }]),
			},
		};

		await expect(rollbackCustomFormatDeployment(client as never, appliedState())).rejects.toThrow(
			"referenced by quality profile",
		);
		expect(remove).not.toHaveBeenCalled();
	});

	it("restores an updated Custom Format only from its exact post-write state", async () => {
		const before = { id: 4, name: "Existing CF", specifications: [{ name: "old" }] };
		const deployed = { id: 4, name: "Existing CF", specifications: [{ name: "new" }] };
		const update = vi.fn().mockResolvedValue(undefined);
		const client = {
			customFormat: {
				getAll: vi.fn().mockResolvedValue([deployed]),
				getById: vi.fn().mockResolvedValue(deployed),
				update,
			},
		};

		await expect(
			rollbackCustomFormatDeployment(
				client as never,
				appliedState({
					beforeFormat: before,
					action: "updated",
					resourceId: 4,
					name: "Existing CF",
					postStateToken: createUpstreamResourceStateToken(deployed),
				}),
			),
		).resolves.toBe("restored");
		expect(update).toHaveBeenCalledWith(4, before);
	});

	it("treats a pending update still at its before-state as an idempotent no-op", async () => {
		const before = { id: 4, name: "Existing CF", specifications: [] };
		const client = {
			customFormat: {
				getAll: vi.fn().mockResolvedValue([before]),
				getById: vi.fn().mockResolvedValue(before),
			},
		};

		await expect(
			rollbackCustomFormatDeployment(
				client as never,
				appliedState({
					beforeFormat: before,
					action: "updated",
					resourceId: 4,
					name: "Existing CF",
					status: "pending",
					postStateToken: null,
				}),
			),
		).resolves.toBe("noop");
	});

	it("fails closed when a pending write left an unknown current state", async () => {
		const before = { id: 4, name: "Existing CF", specifications: [] };
		const changed = { ...before, specifications: [{ name: "unknown" }] };
		const client = {
			customFormat: {
				getAll: vi.fn().mockResolvedValue([changed]),
				getById: vi.fn().mockResolvedValue(changed),
			},
		};

		await expect(
			rollbackCustomFormatDeployment(
				client as never,
				appliedState({
					beforeFormat: before,
					action: "updated",
					resourceId: 4,
					name: "Existing CF",
					status: "pending",
					postStateToken: null,
				}),
			),
		).rejects.toThrow("unverified deployment state");
	});

	it("restores a pending update when the upstream state matches the recorded intent", async () => {
		const before = { id: 4, name: "Existing CF", specifications: [{ name: "old" }] };
		const intended = { id: 4, name: "Existing CF", specifications: [{ name: "new" }] };
		const update = vi.fn().mockResolvedValue(undefined);
		const client = {
			customFormat: {
				getAll: vi.fn().mockResolvedValue([intended]),
				getById: vi.fn().mockResolvedValue(intended),
				update,
			},
		};
		const state = {
			...appliedState({
				beforeFormat: before,
				action: "updated",
				resourceId: 4,
				name: "Existing CF",
				status: "pending",
				postStateToken: null,
			}),
			intendedPostStateToken: createUpstreamResourceStateToken(intended),
		};

		await expect(rollbackCustomFormatDeployment(client as never, state)).resolves.toBe("restored");
		expect(update).toHaveBeenCalledWith(4, before);
	});

	it("reconciles a pending create after the unknown resource is manually removed", async () => {
		const client = { customFormat: { getAll: vi.fn().mockResolvedValue([]) } };

		await expect(
			rollbackCustomFormatDeployment(
				client as never,
				appliedState({
					action: "created",
					resourceId: null,
					name: "Created CF",
					status: "pending",
					postStateToken: null,
				}),
			),
		).resolves.toBe("noop");
	});
});
