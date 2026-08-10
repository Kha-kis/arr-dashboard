import { describe, expect, it, vi } from "vitest";
import { BulkScoreManager } from "../bulk-score-manager.js";
import { createDeploymentConnectionStateToken } from "../deployment-target.js";

const userId = "user-1";
const primary = {
	id: "primary",
	label: "Primary",
	service: "RADARR",
	baseUrl: "http://radarr-a:7878",
	encryptedApiKey: "key-a",
	encryptionIv: "iv-a",
	encryptedHttpAuthCredentials: null,
	httpAuthEncryptionIv: null,
	connectionGeneration: 2,
};
const alias = { ...primary, id: "alias", label: "Alias" };
const second = {
	...primary,
	id: "second",
	label: "Second",
	baseUrl: "http://radarr-b:7878",
	encryptedApiKey: "key-b",
	encryptionIv: "iv-b",
};

describe("BulkScoreManager canonical profile identity", () => {
	it("keeps different scores for same-title profiles on separate instances and finds alias mappings", async () => {
		const instances = new Map([
			[primary.id, primary],
			[alias.id, alias],
			[second.id, second],
		]);
		const findMappings = vi.fn(async ({ where }) => {
			const bindings = Array.isArray(where.OR) ? where.OR : [];
			const managedCustomFormats = JSON.stringify([
				{
					trashId: "trash-reject",
					name: "Reject",
					resourceId: 7,
					stateToken: "resource-state",
					profileId: 4,
					appliedScore: -10_000,
				},
			]);
			if (bindings.some((binding: { instanceId: string }) => binding.instanceId === alias.id)) {
				return [
					{
						templateId: "template-a",
						instanceId: alias.id,
						qualityProfileId: 4,
						connectionGeneration: alias.connectionGeneration,
						connectionStateToken: createDeploymentConnectionStateToken(alias),
						managedCustomFormatsCaptured: true,
						managedCustomFormats,
					},
				];
			}
			if (bindings.some((binding: { instanceId: string }) => binding.instanceId === second.id)) {
				return [
					{
						templateId: "template-b",
						instanceId: second.id,
						qualityProfileId: 4,
						connectionGeneration: second.connectionGeneration,
						connectionStateToken: createDeploymentConnectionStateToken(second),
						managedCustomFormatsCaptured: true,
						managedCustomFormats,
					},
				];
			}
			return [];
		});
		const prisma = {
			serviceInstance: {
				findFirst: vi.fn(async ({ where }) =>
					where.userId === userId ? (instances.get(where.id) ?? null) : null,
				),
				findMany: vi.fn(async ({ where }) =>
					[...instances.values()].filter((instance) => instance.service === where.service),
				),
			},
			templateQualityProfileMapping: { findMany: findMappings },
			trashTemplate: {
				findMany: vi.fn(async ({ where }) =>
					where.id.in.map((id: string) => ({
						id,
						configData: JSON.stringify({
							qualityProfile: { trash_score_set: "default" },
							customFormats: [
								{
									trashId: "trash-reject",
									name: "Reject",
									originalConfig: { trash_scores: { default: -10_000 } },
								},
							],
						}),
					})),
				),
			},
		};
		const clientFactory = {
			createConnectionCredentialIdentity: vi.fn().mockReturnValue("credentials"),
			create: vi.fn((instance: typeof primary) => ({
				qualityProfile: {
					getAll: vi.fn().mockResolvedValue([
						{
							id: 4,
							name: "Any",
							formatItems: [
								{ format: 7, score: instance.id === second.id ? 100 : -10_000 },
								{ format: 8, score: 50 },
							],
						},
					]),
				},
				customFormat: {
					getAll: vi.fn().mockResolvedValue([
						{ id: 7, name: "Reject" },
						{ id: 8, name: "Reject" },
					]),
				},
			})),
		};
		const manager = new BulkScoreManager(prisma as never, clientFactory as never);

		const [primaryScores, secondScores] = await Promise.all([
			manager.getAllScores(userId, { instanceId: primary.id }),
			manager.getAllScores(userId, { instanceId: second.id }),
		]);

		expect(primaryScores).toHaveLength(2);
		expect(
			primaryScores.find((score) => score.trashId === "cf-7")?.templateScores[0],
		).toMatchObject({
			qualityProfileName: "Any",
			currentScore: -10_000,
			defaultScore: -10_000,
			isTemplateManaged: true,
		});
		expect(
			primaryScores.find((score) => score.trashId === "cf-8")?.templateScores[0],
		).toMatchObject({
			currentScore: 50,
			defaultScore: 0,
		});
		expect(secondScores.find((score) => score.trashId === "cf-7")?.templateScores[0]).toMatchObject(
			{
				qualityProfileName: "Any",
				currentScore: 100,
				isTemplateManaged: true,
			},
		);
		expect(findMappings).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({ template: { userId } }),
			}),
		);

		findMappings.mockResolvedValueOnce([
			{
				templateId: "template-a",
				instanceId: primary.id,
				qualityProfileId: 4,
				connectionGeneration: primary.connectionGeneration,
				connectionStateToken: createDeploymentConnectionStateToken(primary),
				managedCustomFormatsCaptured: true,
				managedCustomFormats: JSON.stringify([
					{
						trashId: "trash-reject",
						name: "Reject",
						resourceId: 7,
						stateToken: "resource-7",
						profileId: 4,
						appliedScore: -10_000,
					},
				]),
			},
			{
				templateId: "template-a",
				instanceId: alias.id,
				qualityProfileId: 4,
				connectionGeneration: alias.connectionGeneration,
				connectionStateToken: createDeploymentConnectionStateToken(alias),
				managedCustomFormatsCaptured: true,
				managedCustomFormats: JSON.stringify([
					{
						trashId: "trash-reject",
						name: "Reject",
						resourceId: 8,
						stateToken: "resource-8",
						profileId: 4,
						appliedScore: 50,
					},
				]),
			},
		]);

		await expect(manager.getAllScores(userId, { instanceId: primary.id })).rejects.toThrow(
			"conflicting managed Custom Format snapshots",
		);
	});
});
