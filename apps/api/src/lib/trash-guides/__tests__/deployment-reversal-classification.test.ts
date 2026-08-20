import { describe, expect, it, vi } from "vitest";
import { classifyTargetReversal } from "../deployment-reversal-classification.js";
import type { DeploymentBackupState } from "../deployment-backup-state.js";

type CFMutation = DeploymentBackupState["customFormatDeployments"][number];

function cfMutation(overrides: Partial<CFMutation> = {}): CFMutation {
	return {
		beforeFormat: null,
		action: "created",
		resourceId: null,
		name: "CF",
		status: "applied",
		postStateToken: null,
		intendedPostStateToken: null,
		...overrides,
	};
}

function baseState(overrides: Partial<DeploymentBackupState> = {}): DeploymentBackupState {
	return {
		schemaVersion: 2,
		endpointKey: "endpoint",
		connectionStateToken: "connection",
		customFormats: [],
		customFormatDeployments: [],
		managedCustomFormats: [],
		managedCustomFormatsCaptured: true,
		qualityProfileDeployment: {
			beforeProfile: null,
			status: "not_started",
			action: "created",
			profileId: null,
			profileName: "Profile",
			postStateToken: null,
			intendedPostStateToken: null,
		},
		namingDeployment: null,
		...overrides,
	};
}

function client(overrides: Record<string, unknown> = {}) {
	return {
		customFormat: {
			getAll: vi.fn().mockResolvedValue([]),
			getById: vi.fn().mockResolvedValue({}),
		},
		qualityProfile: {
			getAll: vi.fn().mockResolvedValue([]),
			getById: vi.fn().mockResolvedValue({}),
		},
		...overrides,
	} as never;
}

function clientFactory(rawRequest = vi.fn()) {
	return { rawRequest } as never;
}

describe("classifyTargetReversal", () => {
	it("classifies a created CF as already_reversed when the exact resourceId is absent", async () => {
		const state = baseState({
			customFormatDeployments: [cfMutation({ resourceId: 123, postStateToken: "post" })],
		});
		const c = client({ customFormat: { getAll: vi.fn().mockResolvedValue([]), getById: vi.fn() } });

		await expect(
			classifyTargetReversal(c, clientFactory(), { service: "RADARR" } as never, state),
		).resolves.toBe("already_reversed");
	});

	it("classifies a created CF as needs_write when the exact resourceId exists", async () => {
		const state = baseState({
			customFormatDeployments: [cfMutation({ resourceId: 123, postStateToken: "post" })],
		});
		const c = client({
			customFormat: { getAll: vi.fn().mockResolvedValue([{ id: 123 }]), getById: vi.fn() },
		});

		await expect(
			classifyTargetReversal(c, clientFactory(), { service: "RADARR" } as never, state),
		).resolves.toBe("needs_write");
	});

	it("classifies a created CF read failure as unknown, not absence", async () => {
		const state = baseState({
			customFormatDeployments: [cfMutation({ resourceId: 123, postStateToken: "post" })],
		});
		const c = client({
			customFormat: { getAll: vi.fn().mockRejectedValue(new Error("network")), getById: vi.fn() },
		});

		await expect(
			classifyTargetReversal(c, clientFactory(), { service: "RADARR" } as never, state),
		).resolves.toBe("unknown");
	});

	it("classifies a created CF with null resourceId as unknown", async () => {
		const state = baseState({
			customFormatDeployments: [cfMutation({ resourceId: null, postStateToken: null })],
		});

		await expect(
			classifyTargetReversal(client(), clientFactory(), { service: "RADARR" } as never, state),
		).resolves.toBe("unknown");
	});

	it("classifies an updated CF as already_reversed when current state matches beforeFormat", async () => {
		const before = { id: 7, name: "CF", specifications: [] };
		const state = baseState({
			customFormatDeployments: [
				cfMutation({
					beforeFormat: before,
					action: "updated",
					resourceId: 7,
					postStateToken: "post",
				}),
			],
		});
		const c = client({
			customFormat: { getAll: vi.fn(), getById: vi.fn().mockResolvedValue(before) },
		});

		await expect(
			classifyTargetReversal(c, clientFactory(), { service: "RADARR" } as never, state),
		).resolves.toBe("already_reversed");
	});

	it("classifies an updated CF as needs_write when current state differs from beforeFormat", async () => {
		const before = { id: 7, name: "CF", specifications: [] };
		const state = baseState({
			customFormatDeployments: [
				cfMutation({
					beforeFormat: before,
					action: "updated",
					resourceId: 7,
					postStateToken: "post",
				}),
			],
		});
		const c = client({
			customFormat: {
				getAll: vi.fn(),
				getById: vi.fn().mockResolvedValue({ id: 7, name: "CF", specifications: [{ name: "x" }] }),
			},
		});

		await expect(
			classifyTargetReversal(c, clientFactory(), { service: "RADARR" } as never, state),
		).resolves.toBe("needs_write");
	});

	it("classifies a created profile as already_reversed when the exact profileId is absent", async () => {
		const state = baseState({
			qualityProfileDeployment: {
				beforeProfile: null,
				status: "applied",
				action: "created",
				profileId: 4,
				profileName: "Profile",
				postStateToken: "post",
				intendedPostStateToken: null,
			},
		});
		const c = client({
			qualityProfile: { getAll: vi.fn().mockResolvedValue([]), getById: vi.fn() },
		});

		await expect(
			classifyTargetReversal(c, clientFactory(), { service: "RADARR" } as never, state),
		).resolves.toBe("already_reversed");
	});

	it("classifies a created profile as needs_write when the exact profileId exists", async () => {
		const state = baseState({
			qualityProfileDeployment: {
				beforeProfile: null,
				status: "applied",
				action: "created",
				profileId: 4,
				profileName: "Profile",
				postStateToken: "post",
				intendedPostStateToken: null,
			},
		});
		const c = client({
			qualityProfile: { getAll: vi.fn().mockResolvedValue([{ id: 4 }]), getById: vi.fn() },
		});

		await expect(
			classifyTargetReversal(c, clientFactory(), { service: "RADARR" } as never, state),
		).resolves.toBe("needs_write");
	});

	it("classifies a created profile read failure as unknown", async () => {
		const state = baseState({
			qualityProfileDeployment: {
				beforeProfile: null,
				status: "applied",
				action: "created",
				profileId: 4,
				profileName: "Profile",
				postStateToken: "post",
				intendedPostStateToken: null,
			},
		});
		const c = client({
			qualityProfile: { getAll: vi.fn().mockRejectedValue(new Error("network")), getById: vi.fn() },
		});

		await expect(
			classifyTargetReversal(c, clientFactory(), { service: "RADARR" } as never, state),
		).resolves.toBe("unknown");
	});

	it("classifies a created profile with null profileId as unknown", async () => {
		const state = baseState({
			qualityProfileDeployment: {
				beforeProfile: null,
				status: "applied",
				action: "created",
				profileId: null,
				profileName: "Profile",
				postStateToken: null,
				intendedPostStateToken: null,
			},
		});

		await expect(
			classifyTargetReversal(client(), clientFactory(), { service: "RADARR" } as never, state),
		).resolves.toBe("unknown");
	});

	it("classifies an updated profile as already_reversed when current matches beforeProfile", async () => {
		const before = { id: 4, name: "Profile", formatItems: [] };
		const state = baseState({
			qualityProfileDeployment: {
				beforeProfile: before,
				status: "applied",
				action: "updated",
				profileId: 4,
				profileName: "Profile",
				postStateToken: "post",
				intendedPostStateToken: null,
			},
		});
		const c = client({
			qualityProfile: { getAll: vi.fn(), getById: vi.fn().mockResolvedValue(before) },
		});

		await expect(
			classifyTargetReversal(c, clientFactory(), { service: "RADARR" } as never, state),
		).resolves.toBe("already_reversed");
	});

	it("classifies an updated profile as needs_write when current differs from beforeProfile", async () => {
		const before = { id: 4, name: "Profile", formatItems: [] };
		const state = baseState({
			qualityProfileDeployment: {
				beforeProfile: before,
				status: "applied",
				action: "updated",
				profileId: 4,
				profileName: "Profile",
				postStateToken: "post",
				intendedPostStateToken: null,
			},
		});
		const c = client({
			qualityProfile: {
				getAll: vi.fn(),
				getById: vi
					.fn()
					.mockResolvedValue({ id: 4, name: "Profile", formatItems: [{ format: 1, score: 1 }] }),
			},
		});

		await expect(
			classifyTargetReversal(c, clientFactory(), { service: "RADARR" } as never, state),
		).resolves.toBe("needs_write");
	});

	it("classifies naming as already_reversed when current matches beforeConfig", async () => {
		const before = { renameMovies: false };
		const state = baseState({
			namingDeployment: {
				beforeConfig: before,
				status: "applied",
				postStateToken: "post",
				intendedPostStateToken: null,
			},
		});
		const rawRequest = vi.fn().mockResolvedValue({
			ok: true,
			json: vi.fn().mockResolvedValue(before),
		});

		await expect(
			classifyTargetReversal(
				client(),
				clientFactory(rawRequest),
				{ service: "RADARR" } as never,
				state,
			),
		).resolves.toBe("already_reversed");
	});

	it("classifies naming as needs_write when current differs from beforeConfig", async () => {
		const before = { renameMovies: false };
		const state = baseState({
			namingDeployment: {
				beforeConfig: before,
				status: "applied",
				postStateToken: "post",
				intendedPostStateToken: null,
			},
		});
		const rawRequest = vi.fn().mockResolvedValue({
			ok: true,
			json: vi.fn().mockResolvedValue({ renameMovies: true }),
		});

		await expect(
			classifyTargetReversal(
				client(),
				clientFactory(rawRequest),
				{ service: "RADARR" } as never,
				state,
			),
		).resolves.toBe("needs_write");
	});

	it("classifies naming read failure as unknown", async () => {
		const state = baseState({
			namingDeployment: {
				beforeConfig: { renameMovies: false },
				status: "applied",
				postStateToken: "post",
				intendedPostStateToken: null,
			},
		});
		const rawRequest = vi.fn().mockRejectedValue(new Error("network"));

		await expect(
			classifyTargetReversal(
				client(),
				clientFactory(rawRequest),
				{ service: "RADARR" } as never,
				state,
			),
		).resolves.toBe("unknown");
	});

	it("authorizes no-write completion when all mutations are already reversed", async () => {
		const before = { id: 7, name: "CF", specifications: [] };
		const state = baseState({
			customFormatDeployments: [
				cfMutation({
					beforeFormat: before,
					action: "updated",
					resourceId: 7,
					postStateToken: "post",
				}),
			],
		});
		const c = client({
			customFormat: { getAll: vi.fn(), getById: vi.fn().mockResolvedValue(before) },
		});

		await expect(
			classifyTargetReversal(c, clientFactory(), { service: "RADARR" } as never, state),
		).resolves.toBe("already_reversed");
	});

	it("does not authorize no-write completion when one mutation needs a write", async () => {
		const before = { id: 7, name: "CF", specifications: [] };
		const state = baseState({
			customFormatDeployments: [
				cfMutation({
					beforeFormat: before,
					action: "updated",
					resourceId: 7,
					postStateToken: "post",
				}),
				cfMutation({ resourceId: 8, name: "CF2", postStateToken: "post" }),
			],
		});
		const c = client({
			customFormat: {
				getAll: vi.fn().mockResolvedValue([{ id: 8 }]),
				getById: vi.fn().mockResolvedValue(before),
			},
		});

		await expect(
			classifyTargetReversal(c, clientFactory(), { service: "RADARR" } as never, state),
		).resolves.toBe("needs_write");
	});

	it("does not authorize no-write completion when one mutation is unknown", async () => {
		const before = { id: 7, name: "CF", specifications: [] };
		const state = baseState({
			customFormatDeployments: [
				cfMutation({
					beforeFormat: before,
					action: "updated",
					resourceId: 7,
					postStateToken: "post",
				}),
				cfMutation({ resourceId: null, name: "CF2", postStateToken: null }),
			],
		});
		const c = client({
			customFormat: { getAll: vi.fn(), getById: vi.fn().mockResolvedValue(before) },
		});

		await expect(
			classifyTargetReversal(c, clientFactory(), { service: "RADARR" } as never, state),
		).resolves.toBe("unknown");
	});

	it("classifies a ledger with no mutations as already_reversed", async () => {
		const state = baseState();

		await expect(
			classifyTargetReversal(client(), clientFactory(), { service: "RADARR" } as never, state),
		).resolves.toBe("already_reversed");
	});
});
