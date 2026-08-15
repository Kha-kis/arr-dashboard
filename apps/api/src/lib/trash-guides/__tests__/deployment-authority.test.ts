import { describe, expect, it, vi } from "vitest";
import { DeploymentExecutorService } from "../deployment-executor.js";
import {
	createAutomationCatchUpTemplateStateToken,
	createDeploymentConnectionStateToken,
	createDeploymentMappingAuthorityState,
	createDeploymentStateToken,
} from "../deployment-target.js";
import { TemplateService } from "../template-service.js";

const instance = {
	id: "instance-1",
	userId: "user-1",
	label: "Radarr",
	service: "RADARR",
	enabled: true,
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
	lastSyncedAt: new Date("2026-08-10T12:00:00.000Z"),
	trashGuidesCommitHash: "current",
	hasUserModifications: false,
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
		trashTemplate: { findUnique: vi.fn().mockResolvedValue(template) },
		templateQualityProfileMapping: {
			findMany: vi
				.fn()
				.mockImplementation((args?: { where?: { instanceId?: { in?: string[] } } }) => {
					const instanceIds = args?.where?.instanceId?.in;
					return Promise.resolve(
						instanceIds
							? mappings.filter((mapping) => instanceIds.includes(mapping.instanceId))
							: mappings,
					);
				}),
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
	it("rejects automation without an exact template-state token", async () => {
		const { executor, createBackup } = createFixture([currentMapping()]);

		await expect(
			executor.deploySingleInstanceFromAutomation(
				"template-1",
				"instance-1",
				"user-1",
				undefined,
				undefined,
				undefined as never,
			),
		).rejects.toThrow("template-state token");
		expect(createBackup).not.toHaveBeenCalled();
	});

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
			executor.deploySingleInstanceFromAutomation(
				"template-1",
				"instance-1",
				"user-1",
				undefined,
				undefined,
				createAutomationCatchUpTemplateStateToken(template),
			),
		).rejects.toThrow(/Automatic deployment|older connection|conflicting deployment authority/);
		expect(createBackup).not.toHaveBeenCalled();
	});

	it("accepts only a current auto mapping inside the mutation lease", async () => {
		const { executor, createBackup } = createFixture([currentMapping()]);

		await expect(
			executor.deploySingleInstanceFromAutomation(
				"template-1",
				"instance-1",
				"user-1",
				undefined,
				undefined,
				createAutomationCatchUpTemplateStateToken(template),
			),
		).resolves.toMatchObject({ success: false, errors: ["authority accepted"] });
		expect(createBackup).toHaveBeenCalledOnce();
	});

	it("blocks automation when the instance is disabled after scheduler selection", async () => {
		const { executor, client, createBackup } = createFixture([currentMapping()]);
		const privateExecutor = executor as unknown as {
			validateAndPrepareDeployment: (...args: unknown[]) => Promise<unknown>;
		};
		vi.mocked(privateExecutor.validateAndPrepareDeployment).mockResolvedValue({
			template,
			instance: { ...instance, enabled: false },
			templateConfig: { customFormats: [] },
			templateCFs: [],
			overridesForInstance: {},
			effectiveQualityConfig: undefined,
			usingQualityOverride: false,
		} as never);

		await expect(
			executor.deploySingleInstanceFromAutomation(
				"template-1",
				"instance-1",
				"user-1",
				undefined,
				undefined,
				createAutomationCatchUpTemplateStateToken(template),
			),
		).rejects.toThrow("disabled");
		expect(client.system.get).not.toHaveBeenCalled();
		expect(createBackup).not.toHaveBeenCalled();
	});

	it("ignores a disabled equivalent alias during automation authorization", async () => {
		const disabledAlias = {
			...instance,
			id: "instance-disabled",
			baseUrl: "HTTP://RADARR:7878/",
			enabled: false,
		};
		const disabledMapping = currentMapping({
			id: "mapping-disabled",
			instanceId: disabledAlias.id,
			connectionStateToken: createDeploymentConnectionStateToken(disabledAlias),
			syncStrategy: "notify",
		});
		const { executor, prisma, createBackup } = createFixture([currentMapping(), disabledMapping]);
		prisma.serviceInstance.findMany.mockResolvedValue([instance, disabledAlias]);

		await expect(
			executor.deploySingleInstanceFromAutomation(
				"template-1",
				"instance-1",
				"user-1",
				undefined,
				undefined,
				createAutomationCatchUpTemplateStateToken(template),
			),
		).resolves.toMatchObject({ success: false, errors: ["authority accepted"] });
		expect(createBackup).toHaveBeenCalledOnce();
	});

	it("blocks automation when a disabled equivalent alias has unresolved recovery state", async () => {
		const disabledAlias = {
			...instance,
			id: "instance-disabled",
			baseUrl: "HTTP://RADARR:7878/",
			enabled: false,
		};
		const { executor, prisma, createBackup } = createFixture([currentMapping()]);
		prisma.serviceInstance.findMany.mockResolvedValue([instance, disabledAlias]);
		prisma.templateDeploymentHistory.findMany.mockImplementation(
			(args?: { where?: { instanceId?: { in?: string[] } } }) =>
				Promise.resolve(
					args?.where?.instanceId?.in?.includes(disabledAlias.id)
						? [
								{
									status: "UNCERTAIN",
									undeployStatus: null,
									backupId: null,
									backup: null,
								},
							]
						: [],
				),
		);

		await expect(
			executor.deploySingleInstanceFromAutomation(
				"template-1",
				"instance-1",
				"user-1",
				undefined,
				undefined,
				createAutomationCatchUpTemplateStateToken(template),
			),
		).resolves.toMatchObject({
			success: false,
			status: "FAILED",
			errors: [expect.stringContaining("uncertain upstream result")],
		});
		expect(createBackup).not.toHaveBeenCalled();
	});

	it("skips catch-up when the endpoint became current before the mutation lease", async () => {
		const { executor, createBackup } = createFixture([
			currentMapping({ lastSyncedAt: new Date("2026-08-10T12:01:00.000Z") }),
		]);

		await expect(
			executor.deploySingleInstanceFromAutomation(
				"template-1",
				"instance-1",
				"user-1",
				undefined,
				undefined,
				createAutomationCatchUpTemplateStateToken(template),
				true,
			),
		).resolves.toMatchObject({ success: true, status: "SUCCESS" });
		expect(createBackup).not.toHaveBeenCalled();
	});

	it("uses the current alias authority when a re-enabled alias has an expected stale snapshot", async () => {
		const alias = {
			...instance,
			id: "instance-alias",
			baseUrl: "HTTP://RADARR:7878/",
		};
		const currentAuthority = currentMapping({
			lastSyncedAt: new Date("2026-08-10T12:01:00.000Z"),
			managedCustomFormats: "[]",
		});
		const staleAliasAuthority = currentMapping({
			id: "mapping-alias",
			instanceId: alias.id,
			connectionStateToken: createDeploymentConnectionStateToken(alias),
			lastSyncedAt: new Date("2026-08-10T11:00:00.000Z"),
			managedCustomFormats: JSON.stringify([
				{
					trashId: "removed-format",
					name: "Removed Format",
					resourceId: 41,
					stateToken: "old-state",
					profileId: 4,
					appliedScore: 100,
				},
			]),
		});
		const { executor, prisma, createBackup } = createFixture([
			currentAuthority,
			staleAliasAuthority,
		]);
		prisma.serviceInstance.findMany.mockResolvedValue([instance, alias]);

		await expect(
			executor.deploySingleInstanceFromAutomation(
				"template-1",
				"instance-1",
				"user-1",
				undefined,
				undefined,
				createAutomationCatchUpTemplateStateToken(template),
				true,
			),
		).resolves.toMatchObject({ success: false, errors: ["authority accepted"] });
		expect(createBackup).toHaveBeenCalledOnce();
	});

	it("blocks catch-up when the template changes before the mutation lease", async () => {
		const selectedTemplate = { ...template };
		const { executor, createBackup } = createFixture([
			currentMapping({ lastSyncedAt: new Date("2026-08-10T11:00:00.000Z") }),
		]);
		const privateExecutor = executor as unknown as {
			validateAndPrepareDeployment: (...args: unknown[]) => Promise<unknown>;
		};
		vi.mocked(privateExecutor.validateAndPrepareDeployment).mockResolvedValue({
			template: {
				...template,
				configData: '{"customFormats":[{"name":"edited while queued"}]}',
			},
			instance,
			templateConfig: { customFormats: [{ name: "edited while queued" }] },
			templateCFs: [],
			overridesForInstance: {},
			effectiveQualityConfig: undefined,
			usingQualityOverride: false,
		} as never);

		await expect(
			executor.deploySingleInstanceFromAutomation(
				"template-1",
				"instance-1",
				"user-1",
				undefined,
				undefined,
				createAutomationCatchUpTemplateStateToken(selectedTemplate),
				true,
			),
		).rejects.toThrow("template changed after target selection");
		expect(createBackup).not.toHaveBeenCalled();
	});

	it("rechecks catch-up template authority at the mutation boundary", async () => {
		const { executor, prisma, createBackup } = createFixture([
			currentMapping({ lastSyncedAt: new Date("2026-08-10T11:00:00.000Z") }),
		]);
		prisma.trashTemplate.findUnique.mockResolvedValue({
			...template,
			configData: '{"customFormats":[{"name":"edited during preparation"}]}',
		});

		await expect(
			executor.deploySingleInstanceFromAutomation(
				"template-1",
				"instance-1",
				"user-1",
				undefined,
				undefined,
				createAutomationCatchUpTemplateStateToken(template),
				true,
			),
		).rejects.toThrow("template changed after target selection");
		expect(createBackup).not.toHaveBeenCalled();
	});

	it("holds template edits until catch-up leaves the mutation boundary", async () => {
		const { executor, prisma, createBackup } = createFixture([
			currentMapping({ lastSyncedAt: new Date("2026-08-10T11:00:00.000Z") }),
		]);
		const templateDelegate = Object.assign(prisma.trashTemplate, {
			findFirst: vi.fn().mockResolvedValue(template),
			update: vi.fn().mockResolvedValue({ ...template, deletedAt: new Date() }),
		});
		const templateService = new TemplateService(prisma as never);
		const privateExecutor = executor as unknown as {
			assertAutomationCatchUpTemplateState: (...args: unknown[]) => Promise<void>;
		};
		const originalBoundaryCheck =
			privateExecutor.assertAutomationCatchUpTemplateState.bind(executor);
		let releaseBoundary!: () => void;
		const boundaryPaused = new Promise<void>((resolve) => {
			releaseBoundary = resolve;
		});
		let boundaryReached!: () => void;
		const atBoundary = new Promise<void>((resolve) => {
			boundaryReached = resolve;
		});
		vi.spyOn(privateExecutor, "assertAutomationCatchUpTemplateState").mockImplementation(
			async (...args: unknown[]) => {
				await originalBoundaryCheck(...args);
				boundaryReached();
				await boundaryPaused;
			},
		);

		const deployment = executor.deploySingleInstanceFromAutomation(
			"template-1",
			"instance-1",
			"user-1",
			undefined,
			undefined,
			createAutomationCatchUpTemplateStateToken(template),
			true,
		);
		await atBoundary;
		const deletion = templateService.deleteTemplate("template-1", "user-1");
		await Promise.resolve();
		expect(templateDelegate.findFirst).not.toHaveBeenCalled();

		releaseBoundary();
		await expect(deployment).resolves.toMatchObject({
			success: false,
			errors: ["authority accepted"],
		});
		await expect(deletion).resolves.toBe(true);
		expect(createBackup).toHaveBeenCalledOnce();
		expect(templateDelegate.findFirst).toHaveBeenCalledOnce();
	});

	it("blocks catch-up when the template is soft-deleted before the mutation lease", async () => {
		const findUnique = vi
			.fn()
			.mockImplementation((args: { where: { deletedAt?: null } }) =>
				Promise.resolve(args.where.deletedAt === null ? null : template),
			);
		const prisma = {
			libraryCleanupConfig: {
				upsert: vi.fn().mockResolvedValue({ id: "cleanup-config" }),
				updateMany: vi.fn().mockResolvedValue({ count: 1 }),
			},
			trashTemplate: { findUnique },
			serviceInstance: { findFirst: vi.fn().mockResolvedValue(instance) },
		};
		const createClient = vi.fn();
		const executor = new DeploymentExecutorService(
			prisma as never,
			{
				create: createClient,
			} as never,
		);
		const privateExecutor = executor as unknown as {
			createBackupAndHistory: (...args: unknown[]) => Promise<unknown>;
		};
		const createBackup = vi.spyOn(privateExecutor, "createBackupAndHistory");

		await expect(
			executor.deploySingleInstanceFromAutomation(
				"template-1",
				"instance-1",
				"user-1",
				undefined,
				undefined,
				createAutomationCatchUpTemplateStateToken(template),
				true,
			),
		).resolves.toMatchObject({
			success: false,
			status: "FAILED",
			errors: [expect.stringContaining("Template not found")],
		});
		expect(findUnique).toHaveBeenCalledWith({
			where: { id: "template-1", userId: "user-1", deletedAt: null },
		});
		expect(createClient).not.toHaveBeenCalled();
		expect(createBackup).not.toHaveBeenCalled();
	});

	it("blocks catch-up when equivalent enabled aliases have conflicting overrides", async () => {
		const alias = {
			...instance,
			id: "instance-alias",
			baseUrl: "HTTP://RADARR:7878/",
		};
		const aliasMapping = currentMapping({
			id: "mapping-alias",
			instanceId: alias.id,
			connectionStateToken: createDeploymentConnectionStateToken(alias),
			lastSyncedAt: new Date("2026-08-10T11:00:00.000Z"),
		});
		const { executor, prisma, createBackup } = createFixture([
			currentMapping({ lastSyncedAt: new Date("2026-08-10T12:01:00.000Z") }),
			aliasMapping,
		]);
		prisma.serviceInstance.findMany.mockResolvedValue([instance, alias]);
		const conflictingOverridesTemplate = {
			...template,
			instanceOverrides: JSON.stringify({
				[instance.id]: { cfScoreOverrides: { extras: -10000 } },
				[alias.id]: { cfScoreOverrides: { extras: 0 } },
			}),
		};
		const privateExecutor = executor as unknown as {
			validateAndPrepareDeployment: (...args: unknown[]) => Promise<unknown>;
		};
		vi.mocked(privateExecutor.validateAndPrepareDeployment).mockResolvedValue({
			template: conflictingOverridesTemplate,
			instance,
			templateConfig: { customFormats: [] },
			templateCFs: [],
			overridesForInstance: {},
			effectiveQualityConfig: undefined,
			usingQualityOverride: false,
		} as never);
		prisma.trashTemplate.findUnique.mockResolvedValue(conflictingOverridesTemplate);

		await expect(
			executor.deploySingleInstanceFromAutomation(
				"template-1",
				"instance-1",
				"user-1",
				undefined,
				undefined,
				createAutomationCatchUpTemplateStateToken(conflictingOverridesTemplate),
				true,
			),
		).rejects.toThrow("conflicting instance overrides");
		expect(createBackup).not.toHaveBeenCalled();
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
