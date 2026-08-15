import { describe, expect, it, vi } from "vitest";
import { createDeploymentConnectionStateToken } from "../deployment-target.js";
import { TemplateUpdater } from "../template-updater.js";

const template = {
	id: "template-1",
	userId: "user-1",
	name: "Any",
	instanceOverrides: null as string | null,
};

function instance(id: string, baseUrl: string) {
	return {
		id,
		userId: "user-1",
		label: id,
		service: "RADARR",
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
		deployToMappedInstances: (templateId: string) => Promise<
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
	return { updater, privateUpdater, deploySingleInstanceFromAutomation };
}

describe("TemplateUpdater automation authority", () => {
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
		});

		const result = await updater.processAutoUpdates(template.userId);

		expect(result).toMatchObject({ processed: 1, successful: 1, failed: 0 });
		expect(result.results).toEqual([expect.objectContaining({ success: true })]);
		expect(result.results[0]).not.toHaveProperty("errors");
	});
});
