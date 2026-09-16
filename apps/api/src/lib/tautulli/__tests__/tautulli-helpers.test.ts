import type { FastifyInstance } from "fastify";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ServiceInstance } from "../../prisma.js";

const clientFactory = vi.hoisted(() => ({
	createTautulliClient: vi.fn(),
}));

vi.mock("../tautulli-client.js", () => clientFactory);

import { executeOnTautulliInstances, requireTautulliClient } from "../tautulli-helpers.js";

function instance(
	id: string,
	identityStatus: ServiceInstance["identityStatus"],
	expectedIdentity: string | null,
): ServiceInstance {
	return {
		id,
		service: "TAUTULLI",
		label: id,
		baseUrl: `http://${id}.test`,
		externalUrl: null,
		encryptedApiKey: `encrypted-${id}`,
		encryptionIv: `iv-${id}`,
		encryptedHttpAuthCredentials: null,
		httpAuthEncryptionIv: null,
		isDefault: false,
		enabled: true,
		storageGroupId: null,
		hasLocalFilesystemAccess: false,
		pathPrefix: null,
		connectionGeneration: 0,
		expectedIdentity,
		identityKind: "TAUTULLI_PMS_IDENTIFIER",
		identityStatus,
		identityGeneration: 0,
		identityVerifiedAt: null,
		identityLastCheckedAt: null,
		userId: "user-1",
		createdAt: new Date("2026-01-01T00:00:00.000Z"),
		updatedAt: new Date("2026-01-01T00:00:00.000Z"),
	};
}

function app(instances: ServiceInstance[]) {
	const findMany = vi.fn().mockResolvedValue(instances);
	const findFirst = vi.fn().mockImplementation(async (query: { where?: { id?: string } }) => {
		return instances.find((candidate) => candidate.id === query.where?.id) ?? null;
	});
	const app = {
		prisma: { serviceInstance: { findMany, findFirst } },
		encryptor: {},
		log: { error: vi.fn() },
	};
	return { app: app as unknown as FastifyInstance, findMany, findFirst };
}

describe("Tautulli identity-gated helpers", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		clientFactory.createTautulliClient.mockImplementation((_encryptor, serviceInstance) => ({
			instanceId: serviceInstance.id,
		}));
	});

	it("queries only enabled verified instances with a nonempty expected identity", async () => {
		const verified = instance("verified", "VERIFIED", "pms-verified");
		const unverified = instance("unverified", "UNVERIFIED", null);
		const mismatch = instance("mismatch", "MISMATCH", "pms-mismatch");
		const blank = instance("blank", "VERIFIED", "   ");
		const { app: fastify, findMany } = app([verified, unverified, mismatch, blank]);
		const operation = vi.fn().mockImplementation(async (client) => ({ client }));

		const result = await executeOnTautulliInstances(fastify, "user-1", operation);

		expect(findMany).toHaveBeenCalledWith({
			where: {
				userId: "user-1",
				service: "TAUTULLI",
				enabled: true,
				identityStatus: "VERIFIED",
				expectedIdentity: { not: "" },
			},
			select: { id: true },
			orderBy: { label: "asc" },
		});
		expect(operation).toHaveBeenCalledOnce();
		expect(operation.mock.calls[0]?.[1]).toBe(verified);
		expect(clientFactory.createTautulliClient).toHaveBeenCalledOnce();
		expect(result.instances).toHaveLength(1);
		expect(result.errorCount).toBe(0);
	});

	it("does not return a single-instance client when identity authority is unavailable", async () => {
		const unverified = instance("unverified", "UNVERIFIED", null);
		const { app: fastify, findFirst } = app([unverified]);

		await expect(requireTautulliClient(fastify, "user-1", unverified.id)).rejects.toMatchObject({
			name: "InstanceNotFoundError",
		});
		expect(findFirst).toHaveBeenCalledWith({
			where: {
				id: unverified.id,
				userId: "user-1",
				enabled: true,
				identityStatus: "VERIFIED",
				expectedIdentity: { not: "" },
			},
		});
		expect(clientFactory.createTautulliClient).not.toHaveBeenCalled();
	});

	it.each([
		["disabled", { enabled: false }],
		["mismatched", { identityStatus: "MISMATCH" as const }],
		["blank", { expectedIdentity: "   " }],
	] as const)(
		"skips a candidate that becomes %s before client construction",
		async (_label, change) => {
			const candidate = instance("candidate", "VERIFIED", "pms-candidate");
			const changed = { ...candidate, ...change } as ServiceInstance;
			const { app: fastify, findFirst } = app([candidate]);
			findFirst.mockResolvedValueOnce(changed);
			const operation = vi.fn();

			const result = await executeOnTautulliInstances(fastify, "user-1", operation);

			expect(findFirst).toHaveBeenCalledWith({
				where: {
					id: candidate.id,
					userId: "user-1",
					service: "TAUTULLI",
					enabled: true,
					identityStatus: "VERIFIED",
					expectedIdentity: { not: "" },
				},
			});
			expect(clientFactory.createTautulliClient).not.toHaveBeenCalled();
			expect(operation).not.toHaveBeenCalled();
			expect(result.instances).toEqual([]);
			expect(result.aggregated).toEqual([]);
		},
	);

	it("excludes an observation when provider authority changes during the operation", async () => {
		const candidate = instance("candidate", "VERIFIED", "pms-candidate");
		const changed = {
			...candidate,
			connectionGeneration: candidate.connectionGeneration + 1,
			identityGeneration: candidate.identityGeneration + 1,
		};
		const { app: fastify, findFirst } = app([candidate]);
		findFirst.mockReset();
		findFirst.mockResolvedValueOnce(candidate).mockResolvedValueOnce(changed);
		let release!: () => void;
		const operation = vi.fn().mockImplementation(
			async () =>
				await new Promise<string[]>((resolve) => {
					release = () => resolve(["stale-observation"]);
				}),
		);

		const pending = executeOnTautulliInstances(fastify, "user-1", operation);
		await vi.waitFor(() => expect(operation).toHaveBeenCalledOnce());
		release();
		const result = await pending;

		expect(findFirst).toHaveBeenCalledTimes(2);
		expect(result.instances).toEqual([]);
		expect(result.aggregated).toEqual([]);
		expect(result.totalCount).toBe(0);
		expect(result.errorCount).toBe(0);
	});
});
