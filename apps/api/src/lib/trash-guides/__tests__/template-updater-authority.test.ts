import { describe, expect, it, vi } from "vitest";
import {
	createAutomationCatchUpTemplateStateToken,
	createDeploymentConnectionStateToken,
} from "../deployment-target.js";
import { TemplateUpdater } from "../template-updater.js";

const template = {
	id: "template-1",
	userId: "user-1",
	name: "Any",
	configData: '{"customFormats":[]}',
	instanceOverrides: null as string | null,
	trashGuidesCommitHash: "current" as string | null,
	lastSyncedAt: null as Date | null,
	hasUserModifications: false,
};

function instance(id: string, baseUrl: string, enabled = true) {
	return {
		id,
		userId: "user-1",
		label: id,
		service: "RADARR",
		enabled,
		baseUrl,
		encryptedApiKey: "encrypted-key",
		encryptionIv: "iv",
		encryptedHttpAuthCredentials: null,
		httpAuthEncryptionIv: null,
		connectionGeneration: 2,
	};
}

function mapping(target: ReturnType<typeof instance>, overrides: Record<string, unknown> = {}) {
	return {
		id: `mapping-${target.id}`,
		templateId: template.id,
		instanceId: target.id,
		qualityProfileId: 4,
		qualityProfileName: "Any",
		syncStrategy: "auto",
		connectionGeneration: target.connectionGeneration,
		connectionStateToken: createDeploymentConnectionStateToken(target),
		instance: target,
		managedCustomFormatsCaptured: true,
		managedCustomFormats: "[]",
		...overrides,
	};
}

function createUpdater(
	mappings: Array<ReturnType<typeof mapping>>,
	deploymentResult: {
		success: boolean;
		errors: string[];
		status?: "SUCCESS" | "FAILED" | "UNCERTAIN";
	} = { success: true, errors: [], status: "SUCCESS" },
) {
	const deploySingleInstanceFromAutomation = vi.fn().mockResolvedValue({
		...deploymentResult,
	});
	const createEndpointMutationKey = vi
		.fn()
		.mockImplementation(
			(userId: string, target: ReturnType<typeof instance>) =>
				`${userId}:${target.service}:credential-1`,
		);
	const prisma = {
		trashTemplate: { findUnique: vi.fn().mockResolvedValue(template) },
		templateQualityProfileMapping: { findMany: vi.fn().mockResolvedValue(mappings) },
	};
	const updater = new TemplateUpdater(
		prisma as never,
		{} as never,
		{} as never,
		{} as never,
		{ deploySingleInstanceFromAutomation, createEndpointMutationKey } as never,
	);
	const privateUpdater = updater as unknown as {
		deployToMappedInstances: (
			templateId: string,
			catchUpOnly?: boolean,
		) => Promise<
			Array<{
				endpointKey: string;
				instanceId: string;
				instanceLabel: string;
				success: boolean;
				status: "SUCCESS" | "FAILED" | "UNCERTAIN";
				errors: string[];
			}>
		>;
	};
	return {
		updater,
		privateUpdater,
		deploySingleInstanceFromAutomation,
		createEndpointMutationKey,
		prisma,
	};
}

describe("TemplateUpdater automation authority", () => {
	it("recovers an auto-sync template whose initial commit could not be recorded", async () => {
		const storedTemplate = {
			id: template.id,
			name: template.name,
			serviceType: "RADARR",
			sourceQualityProfileTrashId: "trash-profile",
			trashGuidesCommitHash: null,
			hasUserModifications: false,
			configData: '{"customFormats":[],"customFormatGroups":[]}',
			changeLog: null,
			lastSyncedAt: null,
			qualityProfileMappings: [
				{
					syncStrategy: "auto",
					lastSyncedAt: new Date("2026-08-09T12:00:00.000Z"),
					instance: { enabled: true },
				},
			],
		};
		const findMany = vi.fn().mockResolvedValue([storedTemplate]);
		const prisma = {
			trashTemplate: {
				findMany,
			},
		};
		const updater = new TemplateUpdater(
			prisma as never,
			{
				getLatestCommit: vi.fn().mockResolvedValue({
					commitHash: "current",
					commitDate: "2026-08-10",
					commitMessage: "current",
					commitUrl: "https://example.com/commit/current",
				}),
			} as never,
			{ get: vi.fn().mockResolvedValue([]) } as never,
			{} as never,
		);

		const result = await updater.checkForUpdates(template.userId);

		expect(result.templatesWithUpdates).toEqual([
			expect.objectContaining({
				templateId: template.id,
				currentCommit: null,
				latestCommit: "current",
				canAutoSync: true,
			}),
		]);
		expect(result.outdatedTemplates).toBe(1);

		findMany.mockResolvedValueOnce([{ ...storedTemplate, hasUserModifications: true }]);
		const modifiedResult = await updater.checkForUpdates(template.userId);
		expect(modifiedResult.templatesWithUpdates).toEqual([
			expect.objectContaining({ templateId: template.id, canAutoSync: false }),
		]);

		findMany.mockResolvedValueOnce([{ ...storedTemplate, sourceQualityProfileTrashId: null }]);
		const untrackedResult = await updater.checkForUpdates(template.userId);
		expect(untrackedResult.templatesWithUpdates).toEqual([]);

		findMany.mockResolvedValueOnce([{ ...storedTemplate, qualityProfileMappings: [] }]);
		const unauthorizedResult = await updater.checkForUpdates(template.userId);
		expect(unauthorizedResult.templatesWithUpdates).toEqual([]);
	});

	it("reports deployment catch-up after a disabled auto target is re-enabled", async () => {
		const templateSyncedAt = new Date("2026-08-10T12:00:00.000Z");
		const prisma = {
			trashTemplate: {
				findMany: vi.fn().mockResolvedValue([
					{
						id: template.id,
						name: template.name,
						serviceType: "RADARR",
						trashGuidesCommitHash: "current",
						hasUserModifications: false,
						configData: '{"customFormats":[]}',
						changeLog: null,
						lastSyncedAt: templateSyncedAt,
						qualityProfileMappings: [
							{
								syncStrategy: "auto",
								lastSyncedAt: new Date("2026-08-09T12:00:00.000Z"),
								instance: { enabled: true },
							},
						],
					},
				]),
			},
		};
		const updater = new TemplateUpdater(
			prisma as never,
			{
				getLatestCommit: vi.fn().mockResolvedValue({
					commitHash: "current",
					commitDate: "2026-08-10",
					commitMessage: "current",
					commitUrl: "https://example.com/commit/current",
				}),
			} as never,
			{} as never,
			{} as never,
		);

		const result = await updater.checkForUpdates(template.userId);

		expect(result.templatesWithUpdates).toEqual([
			expect.objectContaining({
				templateId: template.id,
				currentCommit: "current",
				latestCommit: "current",
				canAutoSync: true,
				deploymentCatchUp: true,
			}),
		]);
		expect(result.outdatedTemplates).toBe(1);
	});

	it("does not invoke automation for a disabled instance", async () => {
		const target = instance("instance-1", "http://radarr:7878", false);
		const { privateUpdater, deploySingleInstanceFromAutomation } = createUpdater([mapping(target)]);

		const outcomes = await privateUpdater.deployToMappedInstances(template.id);

		expect(deploySingleInstanceFromAutomation).not.toHaveBeenCalled();
		expect(outcomes).toEqual([]);
	});

	it("does not invoke automation for a stale connection binding", async () => {
		const target = instance("instance-1", "http://radarr:7878");
		const { privateUpdater, deploySingleInstanceFromAutomation } = createUpdater([
			mapping(target, { connectionGeneration: 1 }),
		]);

		const outcomes = await privateUpdater.deployToMappedInstances(template.id);

		expect(deploySingleInstanceFromAutomation).not.toHaveBeenCalled();
		expect(outcomes).toEqual([
			expect.objectContaining({
				instanceId: target.id,
				success: false,
				errors: [expect.stringContaining("stale or legacy")],
			}),
		]);
	});

	it("blocks an entire endpoint when one equivalent alias has a stale binding", async () => {
		const primary = instance("a-primary", "http://radarr/");
		const staleAlias = instance("z-stale-alias", "HTTP://RADARR:80");
		const { privateUpdater, deploySingleInstanceFromAutomation } = createUpdater([
			mapping(primary),
			mapping(staleAlias, { connectionGeneration: 1 }),
		]);

		const outcomes = await privateUpdater.deployToMappedInstances(template.id);

		expect(deploySingleInstanceFromAutomation).not.toHaveBeenCalled();
		expect(outcomes).toEqual([
			expect.objectContaining({
				endpointKey: "user-1:RADARR:credential-1",
				instanceId: primary.id,
				success: false,
				errors: [expect.stringContaining("stale or legacy")],
			}),
		]);
	});

	it("deduplicates equivalent aliases to one deterministic automation call", async () => {
		const primary = instance("a-primary", "http://radarr/");
		const alias = instance("z-alias", "HTTP://RADARR:80");
		const { privateUpdater, deploySingleInstanceFromAutomation } = createUpdater([
			mapping(alias),
			mapping(primary),
		]);

		const outcomes = await privateUpdater.deployToMappedInstances(template.id);

		expect(deploySingleInstanceFromAutomation).toHaveBeenCalledOnce();
		expect(deploySingleInstanceFromAutomation).toHaveBeenCalledWith(
			template.id,
			primary.id,
			template.userId,
		);
		expect(outcomes).toEqual([
			expect.objectContaining({ instanceId: primary.id, success: true, errors: [] }),
		]);
	});

	it("blocks conflicting profile mappings for equivalent aliases", async () => {
		const primary = instance("a-primary", "http://radarr/");
		const alias = instance("z-alias", "HTTP://RADARR:80");
		const { privateUpdater, deploySingleInstanceFromAutomation } = createUpdater([
			mapping(primary),
			mapping(alias, { qualityProfileId: 5 }),
		]);

		const outcomes = await privateUpdater.deployToMappedInstances(template.id);

		expect(deploySingleInstanceFromAutomation).not.toHaveBeenCalled();
		expect(outcomes).toEqual([
			expect.objectContaining({
				instanceId: primary.id,
				success: false,
				errors: [expect.stringContaining("conflicting quality profile")],
			}),
		]);
	});

	it("blocks equivalent aliases with different managed-format snapshots", async () => {
		const primary = instance("a-primary", "http://radarr/");
		const alias = instance("z-alias", "HTTP://RADARR:80");
		const { privateUpdater, deploySingleInstanceFromAutomation } = createUpdater([
			mapping(primary, { managedCustomFormats: '[{"resourceId":42}]' }),
			mapping(alias, { managedCustomFormats: '[{"resourceId":43}]' }),
		]);

		const outcomes = await privateUpdater.deployToMappedInstances(template.id);

		expect(deploySingleInstanceFromAutomation).not.toHaveBeenCalled();
		expect(outcomes).toEqual([
			expect.objectContaining({
				instanceId: primary.id,
				status: "FAILED",
				errors: [expect.stringContaining("conflicting deployment authority")],
			}),
		]);
	});

	it("blocks equivalent aliases with different instance overrides", async () => {
		const primary = instance("a-primary", "http://radarr/");
		const alias = instance("z-alias", "HTTP://RADARR:80");
		const previousOverrides = template.instanceOverrides;
		template.instanceOverrides = JSON.stringify({
			[primary.id]: { cfScoreOverrides: { "trash-cf": 100 } },
			[alias.id]: { cfScoreOverrides: { "trash-cf": 200 } },
		});
		try {
			const { privateUpdater, deploySingleInstanceFromAutomation } = createUpdater([
				mapping(primary),
				mapping(alias),
			]);

			const outcomes = await privateUpdater.deployToMappedInstances(template.id);

			expect(deploySingleInstanceFromAutomation).not.toHaveBeenCalled();
			expect(outcomes).toEqual([
				expect.objectContaining({
					instanceId: primary.id,
					status: "FAILED",
					errors: [expect.stringContaining("conflicting instance overrides")],
				}),
			]);
		} finally {
			template.instanceOverrides = previousOverrides;
		}
	});

	it("reports a resolved executor failure as an endpoint failure", async () => {
		const target = instance("instance-1", "http://radarr:7878");
		const { privateUpdater } = createUpdater([mapping(target)], {
			success: false,
			errors: ["ARR rejected the deployment"],
		});

		const outcomes = await privateUpdater.deployToMappedInstances(template.id);

		expect(outcomes).toEqual([
			expect.objectContaining({
				instanceId: target.id,
				success: false,
				errors: [expect.stringContaining("ARR rejected the deployment")],
			}),
		]);
	});

	it("reports a thrown executor failure as an endpoint failure", async () => {
		const target = instance("instance-1", "http://radarr:7878");
		const { privateUpdater, deploySingleInstanceFromAutomation } = createUpdater([mapping(target)]);
		deploySingleInstanceFromAutomation.mockRejectedValueOnce(new Error("ARR unavailable"));

		const outcomes = await privateUpdater.deployToMappedInstances(template.id);

		expect(outcomes).toEqual([
			expect.objectContaining({
				instanceId: target.id,
				success: false,
				errors: [expect.stringContaining("ARR unavailable")],
			}),
		]);
	});

	it("marks a synced template failed when any endpoint deployment fails", async () => {
		const target = instance("instance-1", "http://radarr:7878");
		const { updater } = createUpdater([mapping(target)], {
			success: false,
			errors: ["ARR rejected the deployment"],
		});
		vi.spyOn(updater, "checkForUpdates").mockResolvedValue({
			templatesWithUpdates: [
				{
					templateId: template.id,
					templateName: template.name,
					currentCommit: "old",
					latestCommit: "new",
					hasUserModifications: false,
					autoSyncInstanceCount: 1,
					canAutoSync: true,
					serviceType: "RADARR",
					automationStateToken: "selected-template-state",
				},
			],
			latestCommit: {
				commitHash: "new",
				commitDate: "2026-08-09",
				commitMessage: "update",
				commitUrl: "https://example.com/commit/new",
			},
			totalTemplates: 1,
			outdatedTemplates: 1,
		});
		vi.spyOn(updater, "syncTemplate").mockResolvedValue({
			success: true,
			templateId: template.id,
			previousCommit: "old",
			newCommit: "new",
			automationStateToken: "synced-template-state",
		});

		const result = await updater.processAutoUpdates(template.userId);

		expect(result).toMatchObject({ processed: 1, successful: 0, failed: 1 });
		expect(result.results).toEqual([
			expect.objectContaining({
				templateId: template.id,
				success: false,
				errors: [expect.stringContaining("ARR rejected the deployment")],
			}),
		]);
	});

	it("binds automatic sync and deployment to the selected template states", async () => {
		const target = instance("instance-1", "http://radarr:7878");
		const { updater, privateUpdater } = createUpdater([mapping(target)]);
		vi.spyOn(updater, "checkForUpdates").mockResolvedValue({
			templatesWithUpdates: [
				{
					templateId: template.id,
					templateName: template.name,
					currentCommit: null,
					latestCommit: "new",
					hasUserModifications: false,
					autoSyncInstanceCount: 1,
					canAutoSync: true,
					serviceType: "RADARR",
					automationStateToken: "selected-template-state",
				},
			],
			latestCommit: {
				commitHash: "new",
				commitDate: "2026-08-09",
				commitMessage: "update",
				commitUrl: "https://example.com/commit/new",
			},
			totalTemplates: 1,
			outdatedTemplates: 1,
		} as never);
		const syncTemplate = vi.spyOn(updater, "syncTemplate").mockResolvedValue({
			success: true,
			templateId: template.id,
			previousCommit: null,
			newCommit: "new",
			automationStateToken: "synced-template-state",
		} as never);
		const deployToMappedInstances = vi
			.spyOn(privateUpdater, "deployToMappedInstances")
			.mockResolvedValue([]);

		await updater.processAutoUpdates(template.userId);

		expect(syncTemplate).toHaveBeenCalledWith(template.id, "new", template.userId, {
			includeQualityProfileCFs: true,
			applyScoreUpdates: true,
			expectedAutomationStateToken: "selected-template-state",
		});
		expect(deployToMappedInstances).toHaveBeenCalledWith(
			template.id,
			false,
			"synced-template-state",
		);
	});

	it("blocks automatic sync when the template changes after selection", async () => {
		const selectedTemplate = { ...template, deletedAt: null };
		const changedTemplate = {
			...selectedTemplate,
			configData: '{"customFormats":[{"name":"edited while queued"}]}',
		};
		const prisma = {
			trashTemplate: {
				findUnique: vi.fn().mockResolvedValue(changedTemplate),
				update: vi.fn(),
			},
			templateQualityProfileMapping: {
				findFirst: vi.fn().mockResolvedValue({ id: "mapping-1" }),
			},
		};
		const updater = new TemplateUpdater(prisma as never, {} as never, {} as never, {} as never);

		const result = await updater.syncTemplate(template.id, "new", template.userId, {
			expectedAutomationStateToken: createAutomationCatchUpTemplateStateToken(selectedTemplate),
		});

		expect(result).toMatchObject({
			success: false,
			errors: [expect.stringContaining("template or Auto mapping changed")],
		});
		expect(prisma.trashTemplate.update).not.toHaveBeenCalled();
	});

	it("blocks initial automatic sync when TRaSH provenance is removed after selection", async () => {
		const selectedTemplate = {
			...template,
			deletedAt: null,
			trashGuidesCommitHash: null,
			sourceQualityProfileTrashId: "trash-profile",
		};
		const prisma = {
			trashTemplate: {
				findUnique: vi
					.fn()
					.mockResolvedValue({ ...selectedTemplate, sourceQualityProfileTrashId: null }),
				update: vi.fn(),
			},
			templateQualityProfileMapping: {
				findFirst: vi.fn().mockResolvedValue({ id: "mapping-1" }),
			},
		};
		const updater = new TemplateUpdater(prisma as never, {} as never, {} as never, {} as never);

		const result = await updater.syncTemplate(template.id, "new", template.userId, {
			expectedAutomationStateToken: createAutomationCatchUpTemplateStateToken(selectedTemplate),
		});

		expect(result).toMatchObject({
			success: false,
			errors: [expect.stringContaining("template or Auto mapping changed")],
		});
		expect(prisma.trashTemplate.update).not.toHaveBeenCalled();
	});

	it("blocks automatic sync when the last Auto mapping is revoked before persistence", async () => {
		const storedTemplate = {
			...template,
			serviceType: "RADARR",
			sourceQualityProfileTrashId: "trash-profile",
			deletedAt: null,
			changeLog: null,
		};
		const update = vi.fn();
		const transactionUpdate = vi.fn();
		const transaction = {
			trashTemplate: {
				findUnique: vi.fn().mockResolvedValue(storedTemplate),
				update: transactionUpdate,
			},
			templateQualityProfileMapping: {
				findFirst: vi.fn().mockResolvedValue(null),
			},
		};
		const prisma = {
			trashTemplate: {
				findUnique: vi.fn().mockResolvedValue(storedTemplate),
				update,
			},
			templateQualityProfileMapping: {
				findFirst: vi.fn().mockResolvedValue({ id: "mapping-1" }),
			},
			$transaction: vi.fn(async (action: (tx: typeof transaction) => Promise<unknown>) =>
				action(transaction),
			),
		};
		const updater = new TemplateUpdater(
			prisma as never,
			{
				getCommitInfo: vi.fn().mockResolvedValue({
					commitHash: "new",
					commitDate: "2026-08-16",
					commitMessage: "update",
					commitUrl: "https://example.com/commit/new",
				}),
			} as never,
			{
				get: vi.fn().mockResolvedValue([]),
				getCommitHash: vi.fn().mockResolvedValue("new"),
			} as never,
			{ fetchConfigs: vi.fn() } as never,
		);

		const result = await updater.syncTemplate(template.id, "new", template.userId, {
			expectedAutomationStateToken: createAutomationCatchUpTemplateStateToken(storedTemplate),
		});

		expect(result).toMatchObject({
			success: false,
			errors: [expect.stringContaining("no longer authorized")],
		});
		expect(prisma.$transaction).toHaveBeenCalledWith(expect.any(Function), {
			isolationLevel: "Serializable",
			timeout: 10000,
		});
		expect(update).not.toHaveBeenCalled();
		expect(transactionUpdate).not.toHaveBeenCalled();
	});

	it("blocks null-commit recovery when cache commit provenance is unavailable", async () => {
		const storedTemplate = {
			...template,
			serviceType: "RADARR",
			sourceQualityProfileTrashId: "trash-profile",
			trashGuidesCommitHash: null,
			deletedAt: null,
			changeLog: null,
		};
		const update = vi.fn();
		const fetchConfigs = vi.fn().mockRejectedValue(new Error("cache refresh unavailable"));
		const prisma = {
			trashTemplate: {
				findUnique: vi.fn().mockResolvedValue(storedTemplate),
				update,
			},
			templateQualityProfileMapping: {
				findFirst: vi.fn().mockResolvedValue({ id: "mapping-1" }),
			},
		};
		const updater = new TemplateUpdater(
			prisma as never,
			{
				getCommitInfo: vi.fn().mockResolvedValue({
					commitHash: "new",
					commitDate: "2026-08-16",
					commitMessage: "update",
					commitUrl: "https://example.com/commit/new",
				}),
			} as never,
			{
				get: vi.fn().mockResolvedValue([]),
				getCommitHash: vi.fn().mockResolvedValue(null),
				set: vi.fn(),
			} as never,
			{ fetchConfigs } as never,
		);

		const result = await updater.syncTemplate(template.id, "new", template.userId, {
			expectedAutomationStateToken: createAutomationCatchUpTemplateStateToken(storedTemplate),
		});

		expect(result).toMatchObject({
			success: false,
			errors: [expect.stringContaining("Failed to refresh CUSTOM_FORMATS cache")],
		});
		expect(fetchConfigs).toHaveBeenCalledWith("RADARR", "CUSTOM_FORMATS");
		expect(update).not.toHaveBeenCalled();
	});

	it("preserves an uncertain auto-deployment as needing review", async () => {
		const target = instance("instance-1", "http://radarr:7878");
		const { updater } = createUpdater([mapping(target)], {
			success: false,
			status: "UNCERTAIN",
			errors: ["ARR write could not be verified"],
		});
		vi.spyOn(updater, "checkForUpdates").mockResolvedValue({
			templatesWithUpdates: [
				{
					templateId: template.id,
					templateName: template.name,
					currentCommit: "old",
					latestCommit: "new",
					hasUserModifications: false,
					autoSyncInstanceCount: 1,
					canAutoSync: true,
					serviceType: "RADARR",
					automationStateToken: "selected-template-state",
				},
			],
			latestCommit: {
				commitHash: "new",
				commitDate: "2026-08-09",
				commitMessage: "update",
				commitUrl: "https://example.com/commit/new",
			},
			totalTemplates: 1,
			outdatedTemplates: 1,
		});
		vi.spyOn(updater, "syncTemplate").mockResolvedValue({
			success: true,
			templateId: template.id,
			previousCommit: "old",
			newCommit: "new",
			automationStateToken: "synced-template-state",
		});

		const result = await updater.processAutoUpdates(template.userId);

		expect(result).toMatchObject({ processed: 1, successful: 0, failed: 0, uncertain: 1 });
		expect(result.results).toEqual([
			expect.objectContaining({
				templateId: template.id,
				success: false,
				errors: [expect.stringContaining("needs review")],
			}),
		]);
	});

	it("preserves uncertainty when another endpoint also fails", async () => {
		const target = instance("instance-1", "http://radarr:7878");
		const { updater, privateUpdater } = createUpdater([mapping(target)]);
		vi.spyOn(privateUpdater, "deployToMappedInstances").mockResolvedValue([
			{
				endpointKey: "failed-endpoint",
				instanceId: "failed-instance",
				instanceLabel: "Failed Radarr",
				success: false,
				status: "FAILED",
				errors: ["ARR rejected the deployment"],
			},
			{
				endpointKey: "uncertain-endpoint",
				instanceId: "uncertain-instance",
				instanceLabel: "Uncertain Radarr",
				success: false,
				status: "UNCERTAIN",
				errors: ["ARR write could not be verified"],
			},
		]);
		vi.spyOn(updater, "checkForUpdates").mockResolvedValue({
			templatesWithUpdates: [
				{
					templateId: template.id,
					templateName: template.name,
					currentCommit: "old",
					latestCommit: "new",
					hasUserModifications: false,
					autoSyncInstanceCount: 2,
					canAutoSync: true,
					serviceType: "RADARR",
					automationStateToken: "selected-template-state",
				},
			],
			latestCommit: {
				commitHash: "new",
				commitDate: "2026-08-09",
				commitMessage: "update",
				commitUrl: "https://example.com/commit/new",
			},
			totalTemplates: 1,
			outdatedTemplates: 1,
		});
		vi.spyOn(updater, "syncTemplate").mockResolvedValue({
			success: true,
			templateId: template.id,
			previousCommit: "old",
			newCommit: "new",
			automationStateToken: "synced-template-state",
		});

		const result = await updater.processAutoUpdates(template.userId);

		expect(result).toMatchObject({ processed: 1, successful: 0, failed: 1, uncertain: 1 });
		expect(result.uncertainDeployments).toEqual([
			expect.objectContaining({ instanceId: "uncertain-instance", status: "UNCERTAIN" }),
		]);
		expect(result.results[0]?.errors).toEqual([
			expect.stringContaining("ARR rejected"),
			expect.stringContaining("could not be verified"),
		]);
	});

	it("keeps a refreshed template successful when it has no auto mappings", async () => {
		const { updater } = createUpdater([]);
		vi.spyOn(updater, "checkForUpdates").mockResolvedValue({
			templatesWithUpdates: [
				{
					templateId: template.id,
					templateName: template.name,
					currentCommit: "old",
					latestCommit: "new",
					hasUserModifications: false,
					autoSyncInstanceCount: 1,
					canAutoSync: true,
					serviceType: "RADARR",
					automationStateToken: "selected-template-state",
				},
			],
			latestCommit: {
				commitHash: "new",
				commitDate: "2026-08-09",
				commitMessage: "update",
				commitUrl: "https://example.com/commit/new",
			},
			totalTemplates: 1,
			outdatedTemplates: 1,
		});
		vi.spyOn(updater, "syncTemplate").mockResolvedValue({
			success: true,
			templateId: template.id,
			previousCommit: "old",
			newCommit: "new",
			automationStateToken: "synced-template-state",
		});

		const result = await updater.processAutoUpdates(template.userId);

		expect(result).toMatchObject({ processed: 1, successful: 1, failed: 0 });
		expect(result.results).toEqual([expect.objectContaining({ success: true })]);
		expect(result.results[0]).not.toHaveProperty("errors");
	});

	it("deploys a current template to a re-enabled target without syncing the template again", async () => {
		const target = instance("instance-1", "http://radarr:7878");
		const { updater, privateUpdater } = createUpdater([mapping(target)]);
		vi.spyOn(updater, "checkForUpdates").mockResolvedValue({
			templatesWithUpdates: [
				{
					templateId: template.id,
					templateName: template.name,
					currentCommit: "current",
					latestCommit: "current",
					hasUserModifications: false,
					autoSyncInstanceCount: 1,
					canAutoSync: true,
					serviceType: "RADARR",
					deploymentCatchUp: true,
				},
			],
			latestCommit: {
				commitHash: "current",
				commitDate: "2026-08-10",
				commitMessage: "current",
				commitUrl: "https://example.com/commit/current",
			},
			totalTemplates: 1,
			outdatedTemplates: 1,
		});
		const syncTemplate = vi.spyOn(updater, "syncTemplate");
		const deployToMappedInstances = vi.spyOn(privateUpdater, "deployToMappedInstances");

		const result = await updater.processAutoUpdates(template.userId);

		expect(syncTemplate).not.toHaveBeenCalled();
		expect(deployToMappedInstances).toHaveBeenCalledWith(template.id, true);
		expect(result).toMatchObject({ processed: 1, successful: 1, failed: 0 });
	});

	it("limits catch-up to endpoint groups that are still behind", async () => {
		const behind = instance("a-behind", "http://radarr-a:7878");
		const current = instance("z-current", "http://radarr-b:7878");
		const templateSyncedAt = new Date("2026-08-10T12:00:00.000Z");
		const {
			privateUpdater,
			deploySingleInstanceFromAutomation,
			createEndpointMutationKey,
			prisma,
		} = createUpdater([
			mapping(behind, { lastSyncedAt: new Date("2026-08-10T11:00:00.000Z") }),
			mapping(current, { lastSyncedAt: new Date("2026-08-10T12:01:00.000Z") }),
		]);
		createEndpointMutationKey.mockImplementation(
			(userId: string, target: ReturnType<typeof instance>) =>
				`${userId}:${target.service}:${new URL(target.baseUrl).origin.toLowerCase()}`,
		);
		prisma.trashTemplate.findUnique.mockResolvedValue({
			...template,
			lastSyncedAt: templateSyncedAt,
		});
		const selectedTemplate = { ...template, lastSyncedAt: templateSyncedAt };

		await privateUpdater.deployToMappedInstances(template.id, true);

		expect(deploySingleInstanceFromAutomation).toHaveBeenCalledOnce();
		expect(deploySingleInstanceFromAutomation).toHaveBeenCalledWith(
			template.id,
			behind.id,
			template.userId,
			undefined,
			undefined,
			createAutomationCatchUpTemplateStateToken(selectedTemplate),
		);
	});

	it("keeps current aliases in a selected catch-up endpoint group", async () => {
		const currentAlias = instance("a-current", "http://radarr:7878");
		const behindAlias = instance("z-behind", "HTTP://RADARR:7878/");
		const templateSyncedAt = new Date("2026-08-10T12:00:00.000Z");
		const { privateUpdater, deploySingleInstanceFromAutomation, prisma } = createUpdater([
			mapping(currentAlias, {
				lastSyncedAt: new Date("2026-08-10T12:01:00.000Z"),
			}),
			mapping(behindAlias, {
				lastSyncedAt: new Date("2026-08-10T11:00:00.000Z"),
			}),
		]);
		prisma.trashTemplate.findUnique.mockResolvedValue({
			...template,
			lastSyncedAt: templateSyncedAt,
		});
		const selectedTemplate = { ...template, lastSyncedAt: templateSyncedAt };

		await privateUpdater.deployToMappedInstances(template.id, true);

		expect(deploySingleInstanceFromAutomation).toHaveBeenCalledOnce();
		expect(deploySingleInstanceFromAutomation).toHaveBeenCalledWith(
			template.id,
			currentAlias.id,
			template.userId,
			undefined,
			undefined,
			createAutomationCatchUpTemplateStateToken(selectedTemplate),
		);
	});
});
