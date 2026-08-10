import { describe, expect, it, vi } from "vitest";
import { rebindLegacyDeploymentConnectionState } from "../deployment-legacy-rebind.js";
import { createDeploymentConnectionBinding } from "../deployment-target.js";

const reviewedMapping = {
	id: "mapping-1",
	templateId: "template-1",
	instanceId: "instance-1",
	qualityProfileId: 4,
	qualityProfileName: "HD-1080p",
	connectionGeneration: 0,
	connectionStateToken: null,
};

const currentInstance = {
	id: "instance-1",
	userId: "user-1",
	service: "RADARR",
	baseUrl: "http://radarr",
	encryptedApiKey: "encrypted-key",
	encryptionIv: "key-iv",
	encryptedHttpAuthCredentials: null,
	httpAuthEncryptionIv: null,
	connectionGeneration: 3,
};

const legacyOverride = {
	id: "override-1",
	userId: "user-1",
	instanceId: "instance-1",
	qualityProfileId: 4,
	customFormatId: 7,
	score: 100,
	status: "APPLIED",
	intentOperation: null,
	intendedScore: null,
	connectionGeneration: 0,
	connectionStateToken: null,
};

function createPrisma(
	options: {
		mappings?: (typeof reviewedMapping)[];
		instances?: (typeof currentInstance)[];
		templates?: Array<{ id: string }>;
		overrides?: (typeof legacyOverride)[];
		mappingUpdateCount?: number;
		overrideUpdateCount?: number;
		remainingLegacyOverrides?: number;
	} = {},
) {
	const mappingUpdateMany = vi.fn().mockResolvedValue({ count: options.mappingUpdateCount ?? 1 });
	const overrideUpdateMany = vi.fn().mockResolvedValue({ count: options.overrideUpdateCount ?? 1 });
	const overrideCount = vi.fn().mockResolvedValue(options.remainingLegacyOverrides ?? 0);
	const transaction = vi.fn(async (callback) =>
		callback({
			templateQualityProfileMapping: {
				findMany: vi.fn().mockResolvedValue(options.mappings ?? [reviewedMapping]),
				updateMany: mappingUpdateMany,
			},
			serviceInstance: {
				findMany: vi.fn().mockResolvedValue(options.instances ?? [currentInstance]),
			},
			trashTemplate: {
				findMany: vi.fn().mockResolvedValue(options.templates ?? [{ id: "template-1" }]),
			},
			instanceQualityProfileOverride: {
				findMany: vi.fn().mockResolvedValue(options.overrides ?? [legacyOverride]),
				updateMany: overrideUpdateMany,
				count: overrideCount,
			},
		}),
	);
	return {
		prisma: { $transaction: transaction },
		mappingUpdateMany,
		overrideUpdateMany,
		overrideCount,
	};
}

describe("legacy deployment connection rebind", () => {
	it("re-reads ownership and compare-and-sets every reviewed mapping and override identity", async () => {
		const { prisma, mappingUpdateMany, overrideUpdateMany, overrideCount } = createPrisma();
		const binding = createDeploymentConnectionBinding(currentInstance);

		await rebindLegacyDeploymentConnectionState(
			prisma as never,
			"user-1",
			[reviewedMapping],
			4,
			[legacyOverride],
			[binding],
		);

		expect(mappingUpdateMany).toHaveBeenCalledWith({
			where: {
				id: "mapping-1",
				templateId: "template-1",
				instanceId: "instance-1",
				qualityProfileId: 4,
				qualityProfileName: "HD-1080p",
				connectionGeneration: 0,
				connectionStateToken: null,
			},
			data: {
				connectionGeneration: 3,
				connectionStateToken: binding.connectionStateToken,
				updatedAt: expect.any(Date),
			},
		});
		expect(overrideUpdateMany).toHaveBeenCalledWith({
			where: {
				id: "override-1",
				userId: "user-1",
				instanceId: "instance-1",
				qualityProfileId: 4,
				customFormatId: 7,
				score: 100,
				status: "APPLIED",
				intentOperation: null,
				intendedScore: null,
				connectionGeneration: 0,
				connectionStateToken: null,
			},
			data: {
				connectionGeneration: 3,
				connectionStateToken: binding.connectionStateToken,
			},
		});
		expect(overrideCount).toHaveBeenCalledOnce();
		expect(overrideUpdateMany.mock.calls[0]?.[0].data).not.toHaveProperty("score");
	});

	it.each([
		{ relation: "instance", options: { instances: [] } },
		{ relation: "template", options: { templates: [] } },
	])("rejects a reviewed mapping whose $relation is owned by another user", async ({ options }) => {
		const { prisma, mappingUpdateMany } = createPrisma(options);

		await expect(
			rebindLegacyDeploymentConnectionState(
				prisma as never,
				"user-1",
				[reviewedMapping],
				4,
				[legacyOverride],
				[createDeploymentConnectionBinding(currentInstance)],
			),
		).rejects.toThrow("no longer authorized");
		expect(mappingUpdateMany).not.toHaveBeenCalled();
	});

	it("rejects a rebind when live credentials changed after review", async () => {
		const reviewedBinding = createDeploymentConnectionBinding(currentInstance);
		const { prisma, mappingUpdateMany } = createPrisma({
			instances: [{ ...currentInstance, encryptedApiKey: "rotated-key" }],
		});

		await expect(
			rebindLegacyDeploymentConnectionState(
				prisma as never,
				"user-1",
				[reviewedMapping],
				4,
				[legacyOverride],
				[reviewedBinding],
			),
		).rejects.toThrow("connection changed after preview");
		expect(mappingUpdateMany).not.toHaveBeenCalled();
	});

	it("accepts reviewed aliases with different URLs when their credential identity matches", async () => {
		const alias = {
			...currentInstance,
			id: "instance-2",
			baseUrl: "https://radarr.example.com",
			encryptedApiKey: "separately-encrypted-key",
			encryptionIv: "separate-iv",
		};
		const { prisma, mappingUpdateMany } = createPrisma({
			instances: [currentInstance, alias],
		});

		await expect(
			rebindLegacyDeploymentConnectionState(
				prisma as never,
				"user-1",
				[reviewedMapping],
				4,
				[legacyOverride],
				[
					createDeploymentConnectionBinding(currentInstance, "same-credentials"),
					createDeploymentConnectionBinding(alias, "same-credentials"),
				],
			),
		).resolves.toBeUndefined();
		expect(mappingUpdateMany).toHaveBeenCalledOnce();
	});

	it("rejects a user-owned binding that no longer represents the reviewed physical endpoint", async () => {
		const unrelatedInstance = {
			...currentInstance,
			id: "instance-2",
			baseUrl: "http://other-radarr",
		};
		const { prisma, mappingUpdateMany } = createPrisma({
			instances: [currentInstance, unrelatedInstance],
		});

		await expect(
			rebindLegacyDeploymentConnectionState(
				prisma as never,
				"user-1",
				[reviewedMapping],
				4,
				[legacyOverride],
				[
					createDeploymentConnectionBinding(currentInstance),
					createDeploymentConnectionBinding(unrelatedInstance),
				],
			),
		).rejects.toThrow("cannot be proven to belong to one ARR endpoint");
		expect(mappingUpdateMany).not.toHaveBeenCalled();
	});

	it.each([
		{ field: "ID", liveMapping: { ...reviewedMapping, qualityProfileId: 5 } },
		{
			field: "name",
			liveMapping: { ...reviewedMapping, qualityProfileName: "Reused profile" },
		},
	])("rejects a mapping whose reviewed quality-profile $field changed", async ({ liveMapping }) => {
		const { prisma, mappingUpdateMany } = createPrisma({ mappings: [liveMapping] });

		await expect(
			rebindLegacyDeploymentConnectionState(
				prisma as never,
				"user-1",
				[reviewedMapping],
				4,
				[legacyOverride],
				[createDeploymentConnectionBinding(currentInstance)],
			),
		).rejects.toThrow("mapping changed after preview");
		expect(mappingUpdateMany).not.toHaveBeenCalled();
	});

	it("rejects a score override whose reviewed value changed before the transaction", async () => {
		const { prisma, mappingUpdateMany } = createPrisma({
			overrides: [{ ...legacyOverride, score: 200 }],
		});

		await expect(
			rebindLegacyDeploymentConnectionState(
				prisma as never,
				"user-1",
				[reviewedMapping],
				4,
				[legacyOverride],
				[createDeploymentConnectionBinding(currentInstance)],
			),
		).rejects.toThrow("score overrides changed after preview");
		expect(mappingUpdateMany).not.toHaveBeenCalled();
	});

	it("fails the transaction when a mapping changes during its compare-and-set", async () => {
		const { prisma, overrideUpdateMany } = createPrisma({ mappingUpdateCount: 0 });

		await expect(
			rebindLegacyDeploymentConnectionState(
				prisma as never,
				"user-1",
				[reviewedMapping],
				4,
				[legacyOverride],
				[createDeploymentConnectionBinding(currentInstance)],
			),
		).rejects.toThrow("mapping changed after preview");
		expect(overrideUpdateMany).not.toHaveBeenCalled();
	});

	it("fails the transaction when an override changes during its compare-and-set", async () => {
		const { prisma } = createPrisma({ overrideUpdateCount: 0 });

		await expect(
			rebindLegacyDeploymentConnectionState(
				prisma as never,
				"user-1",
				[reviewedMapping],
				4,
				[legacyOverride],
				[createDeploymentConnectionBinding(currentInstance)],
			),
		).rejects.toThrow("score overrides changed");
	});

	it("rejects a concurrent override upsert that was not part of the reviewed set", async () => {
		const { prisma } = createPrisma({ remainingLegacyOverrides: 1 });

		await expect(
			rebindLegacyDeploymentConnectionState(
				prisma as never,
				"user-1",
				[reviewedMapping],
				4,
				[legacyOverride],
				[createDeploymentConnectionBinding(currentInstance)],
			),
		).rejects.toThrow("score overrides changed");
	});
});
