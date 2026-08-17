import { beforeEach, describe, expect, it, vi } from "vitest";

const { assertNoPendingDeploymentOperation, withCleanupTopologyMutationLease } = vi.hoisted(() => ({
	assertNoPendingDeploymentOperation: vi.fn(),
	withCleanupTopologyMutationLease: vi.fn(
		async (_deps: unknown, _userId: string, action: () => Promise<unknown>) => action(),
	),
}));

vi.mock("../../../lib/trash-guides/deployment-operation-gate.js", () => ({
	assertNoPendingDeploymentOperation,
}));

vi.mock("../../../lib/library-cleanup/cleanup-run-lease.js", () => ({
	withCleanupTopologyMutationLease,
}));

import { createDeploymentEndpointKey } from "../../../lib/trash-guides/deployment-target.js";
import { runWithManualArrWriterGuard } from "../manual-arr-writer-guard.js";

function instance(id: string, credential = "credential-a") {
	return {
		id,
		userId: "user-1",
		service: "RADARR",
		label: id,
		baseUrl: "http://radarr:7878",
		enabled: true,
		encryptedApiKey: credential,
		encryptionIv: "iv",
		encryptedHttpAuthCredentials: null,
		httpAuthEncryptionIv: null,
		connectionGeneration: 1,
	};
}

describe("runWithManualArrWriterGuard", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("serializes the write and blocks on pending recovery for every physical endpoint alias", async () => {
		const target = instance("instance-1", "credential-a");
		const proxyAlias = instance("instance-2", "credential-b");
		const other = { ...instance("instance-3"), baseUrl: "http://other-radarr:7878" };
		const action = vi.fn(async () => "written");
		const runWithEndpointMutation = vi.fn(
			async (
				userId: string,
				lockedTarget: typeof target,
				_operation: string,
				lockedAction: (endpointKey: string) => Promise<unknown>,
			) =>
				lockedAction(
					createDeploymentEndpointKey(userId, {
						...lockedTarget,
						credentialIdentity: lockedTarget.encryptedApiKey,
					}),
				),
		);
		const app = {
			log: { warn: vi.fn(), error: vi.fn() },
			prisma: {
				serviceInstance: {
					findFirst: vi.fn().mockResolvedValue(target),
					findMany: vi.fn().mockResolvedValue([target, proxyAlias, other]),
				},
			},
			arrClientFactory: {
				createConnectionCredentialIdentity: vi.fn((value: typeof target) => value.encryptedApiKey),
			},
			deploymentExecutor: { runWithEndpointMutation },
		};

		await expect(
			runWithManualArrWriterGuard(
				app as never,
				"user-1",
				"instance-1",
				"Manual naming write",
				action,
			),
		).resolves.toBe("written");

		expect(withCleanupTopologyMutationLease).toHaveBeenCalledWith(
			{ prisma: app.prisma, log: app.log },
			"user-1",
			expect.any(Function),
		);
		expect(runWithEndpointMutation).toHaveBeenCalledWith(
			"user-1",
			target,
			"Manual naming write",
			expect.any(Function),
		);
		expect(assertNoPendingDeploymentOperation).toHaveBeenCalledWith(app.prisma, "user-1", [
			"instance-1",
			"instance-2",
		]);
		expect(action).toHaveBeenCalledWith(target);
	});
});
