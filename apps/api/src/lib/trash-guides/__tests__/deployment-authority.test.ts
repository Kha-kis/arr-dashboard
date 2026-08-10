import { describe, expect, it, vi } from "vitest";
import { DeploymentExecutorService } from "../deployment-executor.js";
import {
	createDeploymentConnectionStateToken,
	createDeploymentMappingAuthorityState,
	createDeploymentStateToken,
} from "../deployment-target.js";

const instance = {
	id: "instance-1",
	userId: "user-1",
	label: "Radarr",
	service: "RADARR",
	baseUrl: "http://radarr:7878",
	encryptedApiKey: "encrypted-key",
	encryptionIv: "iv",
	encryptedHttpAuthCredentials: null,
	httpAuthEncryptionIv: null,
	connectionGeneration: 2,
};

const template = {
	id: "template-1",
	name: "Any",
	serviceType: "RADARR",
	configData: '{"customFormats":[]}',
	instanceOverrides: null,
	sourceQualityProfileName: "Any",
};

const profile = { id: 4, name: "Any", formatItems: [] };

function currentMapping(overrides: Record<string, unknown> = {}) {
	return {
		id: "mapping-1",
		templateId: "template-1",
		instanceId: "instance-1",
		qualityProfileId: 4,
		qualityProfileName: "Any",
		connectionGeneration: 2,
		connectionStateToken: createDeploymentConnectionStateToken(instance),
		syncStrategy: "auto",
		managedCustomFormats: "[]",
		managedCustomFormatsCaptured: true,
		...overrides,
	};
}

function reviewedExecutionToken(mappingState: ReturnType<typeof currentMapping>) {
	return createDeploymentStateToken({
		template: {
			id: template.id,
			name: template.name,
			configData: template.configData,
			instanceOverrides: template.instanceOverrides,
			sourceQualityProfileName: template.sourceQualityProfileName,
		},
		instanceId: instance.id,
		connection: {
			service: instance.service,
			baseUrl: instance.baseUrl,
			credentialIdentity: "encrypted-key:iv::",
		},
		target: { profile, profileName: "Any", matchedBy: "mapping_id" },
		customFormats: [],
		mappingAuthority: createDeploymentMappingAuthorityState([mappingState]),
		savedScoreOverrides: [],
		orphanedFormatScoreChanges: [],
	});
}

function createFixture(
	mappings: Array<ReturnType<typeof currentMapping>>,
	customFormats: Array<Record<string, unknown>> = [],
) {
	const transaction = vi.fn();
	const prisma = {
		libraryCleanupConfig: {
			upsert: vi.fn().mockResolvedValue({ id: "cleanup-config" }),
			updateMany: vi.fn().mockResolvedValue({ count: 1 }),
		},
		serviceInstance: {
			findFirst: vi.fn().mockResolvedValue(instance),
			findMany: vi.fn().mockResolvedValue([instance]),
		},
		templateQualityProfileMapping: {
			findMany: vi.fn().mockResolvedValue(mappings),
			deleteMany: vi.fn(),
			upsert: vi.fn(),
		},
		instanceQualityProfileOverride: { findMany: vi.fn().mockResolvedValue([]) },
		trashSyncHistory: { findMany: vi.fn().mockResolvedValue([]) },
		templateDeploymentHistory: { findMany: vi.fn().mockResolvedValue([]) },
		$transaction: transaction,
	};
	const client = {
		system: { get: vi.fn().mockResolvedValue({ version: "5.0.0" }) },
		customFormat: { getAll: vi.fn().mockResolvedValue(customFormats) },
		qualityProfile: {
			getAll: vi.fn().mockResolvedValue([profile]),
			getById: vi.fn().mockResolvedValue(profile),
		},
	};
	const executor = new DeploymentExecutorService(
		prisma as never,
		{ create: vi.fn().mockReturnValue(client) } as never,
	);
	const privateExecutor = executor as unknown as {
		validateAndPrepareDeployment: (...args: unknown[]) => Promise<unknown>;
		createBackupAndHistory: (...args: unknown[]) => Promise<unknown>;
	};
	vi.spyOn(privateExecutor, "validateAndPrepareDeployment").mockResolvedValue({
		template,
		instance,
		templateConfig: { customFormats: [] },
		templateCFs: [],
		overridesForInstance: {},
		effectiveQualityConfig: undefined,
		usingQualityOverride: false,
	} as never);
	const createBackup = vi
		.spyOn(privateExecutor, "createBackupAndHistory")
		.mockRejectedValue(new Error("authority accepted"));
	return { executor, prisma, client, createBackup, transaction };
}

describe("deployment execution authority", () => {
	it("rejects tokenless user execution before reading deployment state", async () => {
		const { executor, prisma, client } = createFixture([]);

		await expect(
			executor.deploySingleInstance("template-1", "instance-1", "user-1"),
		).rejects.toThrow("preview token is required");
		expect(prisma.serviceInstance.findFirst).not.toHaveBeenCalled();
		expect(client.customFormat.getAll).not.toHaveBeenCalled();
	});

	it("rejects a stale preview token before backup or upstream mutation", async () => {
		const { executor, createBackup } = createFixture([]);

		await expect(
			executor.deploySingleInstance(
				"template-1",
				"instance-1",
				"user-1",
				"notify",
				undefined,
				"stale-preview-token",
			),
		).rejects.toThrow("changed after this preview");
		expect(createBackup).not.toHaveBeenCalled();
	});

	it("invalidates a reviewed token when deployment authority changes", async () => {
		const reviewedMapping = currentMapping({ updatedAt: new Date("2026-08-09T10:00:00.000Z") });
		const changedMapping = currentMapping({
			updatedAt: new Date("2026-08-09T10:01:00.000Z"),
			syncStrategy: "notify",
		});
		const { executor, createBackup } = createFixture([changedMapping]);

		await expect(
			executor.deploySingleInstance(
				"template-1",
				"instance-1",
				"user-1",
				undefined,
				undefined,
				reviewedExecutionToken(reviewedMapping),
			),
		).rejects.toThrow("changed after this preview");
		expect(createBackup).not.toHaveBeenCalled();
	});

	it("rejects ambiguous Custom Format identities before backup or upstream mutation", async () => {
		const duplicateTrashId = "a1b2c3d4-e5f6-47a8-9b0c-1d2e3f4a5b6c";
		const { executor, createBackup } = createFixture(
			[],
			[
				{ id: 42, name: `First [${duplicateTrashId}]`, specifications: [] },
				{ id: 43, name: `Second [${duplicateTrashId}]`, specifications: [] },
			],
		);

		await expect(
			executor.deploySingleInstance(
				"template-1",
				"instance-1",
				"user-1",
				"notify",
				undefined,
				"review-token",
			),
		).rejects.toThrow("ambiguous Custom Format identities");
		expect(createBackup).not.toHaveBeenCalled();
	});

	it("rejects a repointed cloned source before execution can use an original alias", async () => {
		const selectedAlias = { ...instance, id: "instance-alias" };
		const repointedSource = { ...instance, baseUrl: "http://other-radarr:7878" };
		const clonedTemplate = {
			...template,
			configData: JSON.stringify({
				customFormats: [],
				completeQualityProfile: {
					sourceInstanceId: instance.id,
					sourceConnectionStateToken: createDeploymentConnectionStateToken(instance),
					sourceProfileId: profile.id,
				},
			}),
		};
		const { executor, prisma, createBackup } = createFixture([]);
		prisma.serviceInstance.findFirst.mockResolvedValue(selectedAlias);
		prisma.serviceInstance.findMany.mockResolvedValue([repointedSource, selectedAlias]);
		const privateExecutor = executor as unknown as {
			validateAndPrepareDeployment: (...args: unknown[]) => Promise<unknown>;
		};
		vi.mocked(privateExecutor.validateAndPrepareDeployment).mockResolvedValue({
			template: clonedTemplate,
			instance: selectedAlias,
			templateConfig: JSON.parse(clonedTemplate.configData),
			templateCFs: [],
			overridesForInstance: {},
			effectiveQualityConfig: undefined,
			usingQualityOverride: false,
		} as never);

		await expect(
			executor.deploySingleInstance(
				clonedTemplate.id,
				selectedAlias.id,
				"user-1",
				"notify",
				undefined,
				"review-token",
			),
		).rejects.toThrow("source ARR connection changed");
		expect(createBackup).not.toHaveBeenCalled();
	});

	it("uses a current mapped target after the original cloned source record was removed", async () => {
		const clonedTemplate = {
			...template,
			configData: JSON.stringify({
				customFormats: [],
				completeQualityProfile: {
					sourceInstanceId: "removed-source",
					sourceConnectionStateToken: "removed-source-token",
					sourceProfileId: 99,
				},
			}),
		};
		const mapping = currentMapping({ syncStrategy: "notify" });
		const { executor, createBackup } = createFixture([mapping]);
		const privateExecutor = executor as unknown as {
			validateAndPrepareDeployment: (...args: unknown[]) => Promise<unknown>;
		};
		vi.mocked(privateExecutor.validateAndPrepareDeployment).mockResolvedValue({
			template: clonedTemplate,
			instance,
			templateConfig: JSON.parse(clonedTemplate.configData),
			templateCFs: [],
			overridesForInstance: {},
			effectiveQualityConfig: undefined,
			usingQualityOverride: false,
		} as never);
		const executionToken = createDeploymentStateToken({
			template: {
				id: clonedTemplate.id,
				name: clonedTemplate.name,
				configData: clonedTemplate.configData,
				instanceOverrides: clonedTemplate.instanceOverrides,
				sourceQualityProfileName: clonedTemplate.sourceQualityProfileName,
			},
			instanceId: instance.id,
			connection: {
				service: instance.service,
				baseUrl: instance.baseUrl,
				credentialIdentity: "encrypted-key:iv::",
			},
			target: { profile, profileName: "Any", matchedBy: "mapping_id" },
			customFormats: [],
			mappingAuthority: createDeploymentMappingAuthorityState([mapping]),
			savedScoreOverrides: [],
			orphanedFormatScoreChanges: [],
		});

		await expect(
			executor.deploySingleInstance(
				clonedTemplate.id,
				instance.id,
				"user-1",
				"notify",
				undefined,
				executionToken,
			),
		).resolves.toMatchObject({ success: false, errors: ["authority accepted"] });
		expect(createBackup).toHaveBeenCalledOnce();
	});

	it("does not rebind a legacy mapping before backup succeeds", async () => {
		const legacyMapping = currentMapping({
			connectionGeneration: 0,
			connectionStateToken: null,
			syncStrategy: "notify",
		});
		const { executor, createBackup, transaction } = createFixture([legacyMapping]);
		const executionToken = reviewedExecutionToken(legacyMapping);

		await expect(
			executor.deploySingleInstance(
				"template-1",
				"instance-1",
				"user-1",
				undefined,
				undefined,
				executionToken,
			),
		).resolves.toMatchObject({ success: false, errors: ["authority accepted"] });
		expect(createBackup).toHaveBeenCalledOnce();
		expect(transaction).not.toHaveBeenCalled();
	});

	it.each([
		["missing mapping", []],
		["non-auto mapping", [currentMapping({ syncStrategy: "notify" })]],
		["legacy mapping", [currentMapping({ connectionGeneration: 0, connectionStateToken: null })]],
		["stale connection mapping", [currentMapping({ connectionGeneration: 1 })]],
		[
			"changed alias strategy",
			[currentMapping(), currentMapping({ id: "mapping-2", syncStrategy: "notify" })],
		],
	])("blocks automation with a %s", async (_case, mappings) => {
		const { executor, createBackup } = createFixture(
			mappings as ReturnType<typeof currentMapping>[],
		);

		await expect(
			executor.deploySingleInstanceFromAutomation("template-1", "instance-1", "user-1"),
		).rejects.toThrow(/Automatic deployment|older connection|conflicting deployment authority/);
		expect(createBackup).not.toHaveBeenCalled();
	});

	it("accepts only a current auto mapping inside the mutation lease", async () => {
		const { executor, createBackup } = createFixture([currentMapping()]);

		await expect(
			executor.deploySingleInstanceFromAutomation("template-1", "instance-1", "user-1"),
		).resolves.toMatchObject({ success: false, errors: ["authority accepted"] });
		expect(createBackup).toHaveBeenCalledOnce();
	});

	it("rejects repeated bulk targets before acquiring deployment state", async () => {
		const executor = new DeploymentExecutorService({} as never, {} as never);

		await expect(
			executor.deployBulkInstances(
				"template-1",
				["instance-1", "instance-1"],
				"user-1",
				undefined,
				undefined,
				{ "instance-1": "review-token" },
			),
		).rejects.toThrow("same service instance more than once");
	});

	it("rejects equivalent endpoint aliases under the topology lease before any deployment", async () => {
		const prisma = {
			libraryCleanupConfig: {
				upsert: vi.fn().mockResolvedValue({ id: "cleanup-config" }),
				updateMany: vi.fn().mockResolvedValue({ count: 1 }),
			},
			trashTemplate: { findUnique: vi.fn().mockResolvedValue(template) },
			serviceInstance: {
				findMany: vi.fn().mockResolvedValue([
					{ id: "instance-1", service: "RADARR", baseUrl: "http://radarr/" },
					{ id: "instance-alias", service: "radarr", baseUrl: "HTTP://RADARR:80" },
				]),
			},
		};
		const executor = new DeploymentExecutorService(prisma as never, {} as never);
		const privateExecutor = executor as unknown as {
			executeSingleDeployment: (...args: unknown[]) => Promise<unknown>;
		};
		const executeSingle = vi.spyOn(privateExecutor, "executeSingleDeployment");

		await expect(
			executor.deployBulkInstances(
				"template-1",
				["instance-1", "instance-alias"],
				"user-1",
				undefined,
				undefined,
				{ "instance-1": "token-1", "instance-alias": "token-2" },
			),
		).rejects.toThrow("multiple service records for the same ARR endpoint");
		expect(executeSingle).not.toHaveBeenCalled();
	});
});
