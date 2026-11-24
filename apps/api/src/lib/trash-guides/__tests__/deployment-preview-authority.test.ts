import { describe, expect, it, vi } from "vitest";
import { describeQualityOrderChange } from "../deployment-quality-plan.js";
import { DeploymentPreviewService } from "../deployment-preview.js";
import { createDeploymentConnectionStateToken } from "../deployment-target.js";

const trashId = "a1b2c3d4-e5f6-47a8-9b0c-1d2e3f4a5b6c";
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
	userId: "user-1",
	name: "Radarr - Any",
	serviceType: "RADARR",
	configData: JSON.stringify({
		completeQualityProfile: {
			sourceInstanceId: "instance-1",
			sourceConnectionStateToken: createDeploymentConnectionStateToken(instance),
			sourceProfileId: 4,
		},
		customFormats: [
			{
				trashId,
				name: "Template display name",
				originalConfig: { specifications: [], trash_scores: { default: 100 } },
			},
		],
	}),
	instanceOverrides: null,
	sourceQualityProfileName: "Any",
};

function createService(
	options: {
		unreachable?: boolean;
		customFormats?: Array<{ id: number; name: string; specifications: unknown[] }>;
		mappings?: Array<Record<string, unknown>>;
		instance?: typeof instance;
		instances?: (typeof instance)[];
		savedOverrides?: Array<Record<string, unknown>>;
		templateConfig?: Record<string, unknown>;
		qualityItems?: Array<{ quality: { id: number; name: string }; allowed: boolean; items: [] }>;
		cutoff?: number;
		schemaItems?: Array<{ quality: { id: number; name: string }; allowed: boolean; items: [] }>;
	} = {},
) {
	const selectedInstance = options.instance ?? instance;
	const existingFormat = {
		id: 42,
		name: `Different ARR name [${trashId.toUpperCase()}]`,
		specifications: [],
	};
	const profile = {
		id: 4,
		name: "Any",
		formatItems: [{ format: 42, score: 100 }],
		cutoff: options.cutoff ?? 1,
		...(options.qualityItems ? { items: options.qualityItems } : {}),
	};
	const prisma = {
		trashTemplate: {
			findUnique: vi.fn().mockResolvedValue(
				options.templateConfig
					? {
							...template,
							serviceType: selectedInstance.service,
							name: "Any",
							configData: JSON.stringify(options.templateConfig),
						}
					: template,
			),
		},
		serviceInstance: {
			findFirst: vi.fn().mockResolvedValue(selectedInstance),
			findMany: vi.fn().mockResolvedValue(options.instances ?? [selectedInstance]),
		},
		templateQualityProfileMapping: {
			findMany: vi.fn().mockResolvedValue(options.mappings ?? []),
		},
		instanceQualityProfileOverride: {
			findMany: vi.fn().mockResolvedValue(options.savedOverrides ?? []),
		},
		trashCache: { findFirst: vi.fn().mockResolvedValue(null) },
	};
	const client = {
		system: {
			get: options.unreachable
				? vi.fn().mockRejectedValue(new Error("offline"))
				: vi.fn().mockResolvedValue({ version: "5.0.0" }),
		},
		customFormat: {
			getAll: vi.fn().mockResolvedValue(options.customFormats ?? [existingFormat]),
		},
		qualityProfile: {
			getAll: vi.fn().mockResolvedValue([profile]),
			getById: vi.fn().mockResolvedValue(profile),
			getSchema: vi
				.fn()
				.mockResolvedValue({ items: options.schemaItems ?? options.qualityItems ?? [] }),
		},
	};
	const logger = { warn: vi.fn(), error: vi.fn() };
	return new DeploymentPreviewService(
		prisma as never,
		{ create: vi.fn().mockReturnValue(client) } as never,
		logger as never,
	);
}

describe("deployment preview authority", () => {
	it.each(["RADARR", "SONARR"])(
		"previews actual quality order for %s and binds destination schema",
		async (service) => {
			const low = { quality: { id: 1, name: "SD" }, allowed: true, items: [] as [] };
			const high = { quality: { id: 2, name: "HD" }, allowed: true, items: [] as [] };
			const customQualityConfig = {
				useCustomQualities: true,
				items: [high, low].map(({ quality, allowed }) => ({
					type: "quality",
					item: { id: String(quality.id), name: quality.name, allowed },
				})),
				cutoffId: "1",
			};
			const options = {
				instance: { ...instance, service },
				templateConfig: { customQualityConfig },
				qualityItems: [low, high],
			};
			const preview = await createService(options).generatePreview(
				"template-1",
				"instance-1",
				"user-1",
			);
			expect(preview.qualityOrder).toMatchObject({
				before: [{ name: "HD" }, { name: "SD" }],
				after: [{ name: "SD" }, { name: "HD" }],
			});
			const unchanged = await createService({
				...options,
				qualityItems: [high, low],
			}).generatePreview("template-1", "instance-1", "user-1");
			expect(unchanged.qualityOrder).toBeUndefined();
			const cutoffOnly = await createService({
				...options,
				qualityItems: [high, low],
				cutoff: 2,
			}).generatePreview("template-1", "instance-1", "user-1");
			expect(cutoffOnly.qualityOrder).toMatchObject({ cutoffBefore: "HD", cutoffAfter: "SD" });
			const schemaDrift = await createService({
				...options,
				schemaItems: [low, { ...high, quality: { ...high.quality, id: 8 } }],
			}).generatePreview("template-1", "instance-1", "user-1");
			expect(schemaDrift.executionToken).not.toBe(preview.executionToken);
		},
	);

	it("distinguishes a grouped member cutoff from the group cutoff", () => {
		const items = [
			{
				id: 1000,
				name: "HD",
				allowed: true,
				items: [
					{ quality: { id: 1, name: "Web" }, allowed: false },
					{ quality: { id: 2, name: "BluRay" }, allowed: false },
				],
			},
		];
		const change = describeQualityOrderChange(items, { items, cutoff: 1000 }, 1);
		expect(change).toMatchObject({
			cutoffBefore: "HD / Web",
			cutoffAfter: "HD",
			after: [{ children: [{ name: "Web" }, { name: "BluRay" }] }],
		});
	});

	it("targets the cloned source profile when the template was renamed", async () => {
		const preview = await createService().generatePreview("template-1", "instance-1", "user-1");

		expect(preview.warnings).toContain(
			'Quality profile matched by cloned source ID ("Any", ID: 4) rather than a stored deployment mapping.',
		);
		expect(preview.warnings).not.toContain(
			'Quality profile "Radarr - Any" not found in instance. Deploying will create it with the template\'s quality settings and Custom Format scores.',
		);
	});

	it("blocks a cloned source deployment after the ARR connection changes", async () => {
		await expect(
			createService({
				instance: { ...instance, encryptedApiKey: "changed-key" },
			}).generatePreview("template-1", "instance-1", "user-1"),
		).rejects.toThrow("source ARR connection changed");
	});

	it("blocks a repointed source alias before falling back through an original alias", async () => {
		const selectedAlias = { ...instance, id: "instance-alias" };
		const repointedSource = { ...instance, baseUrl: "http://other-radarr:7878" };

		await expect(
			createService({
				instance: selectedAlias,
				instances: [repointedSource, selectedAlias],
			}).generatePreview("template-1", selectedAlias.id, "user-1"),
		).rejects.toThrow("source ARR connection changed");
	});

	it("uses a current mapped target after the original cloned source record was removed", async () => {
		const mappedInstance = {
			...instance,
			id: "mapped-instance",
			baseUrl: "http://mapped-radarr:7878",
		};
		const mapping = {
			id: "mapping-1",
			templateId: template.id,
			instanceId: mappedInstance.id,
			qualityProfileId: 4,
			qualityProfileName: "Any",
			connectionGeneration: mappedInstance.connectionGeneration,
			connectionStateToken: createDeploymentConnectionStateToken(mappedInstance),
			syncStrategy: "notify",
			managedCustomFormats: "[]",
			managedCustomFormatsCaptured: true,
		};

		const preview = await createService({
			instance: mappedInstance,
			instances: [mappedInstance],
			mappings: [mapping],
		}).generatePreview(template.id, mappedInstance.id, "user-1");

		expect(preview.warnings).not.toContainEqual(expect.stringContaining("cloned source"));
		expect(preview.executionToken).toMatch(/^[a-f0-9]{64}$/);
	});

	it("matches a differently named ARR Custom Format by the shared trailing UUID", async () => {
		const preview = await createService().generatePreview("template-1", "instance-1", "user-1");

		expect(preview.customFormats[0]).toMatchObject({ action: "update", trashId });
		expect(preview.summary.newCustomFormats).toBe(0);
		expect(preview.summary.updatedCustomFormats).toBe(1);
		expect(preview.executionToken).toMatch(/^[a-f0-9]{64}$/);
	});

	it("returns the same execution token for the same reviewed state", async () => {
		const service = createService();
		const first = await service.generatePreview("template-1", "instance-1", "user-1");
		const second = await service.generatePreview("template-1", "instance-1", "user-1");

		expect(second.executionToken).toBe(first.executionToken);
	});

	it("never issues an executable token when the instance is unreachable", async () => {
		const preview = await createService({ unreachable: true }).generatePreview(
			"template-1",
			"instance-1",
			"user-1",
		);

		expect(preview.canDeploy).toBe(false);
		expect(preview.executionToken).toBe("");
	});

	it("accepts a legacy saved override only when ARR still has its exact score", async () => {
		const preview = await createService({
			savedOverrides: [
				{
					instanceId: instance.id,
					qualityProfileId: 4,
					customFormatId: 42,
					score: 100,
					status: "APPLIED",
					connectionGeneration: 0,
					connectionStateToken: null,
				},
			],
		}).generatePreview("template-1", "instance-1", "user-1");

		expect(preview.executionToken).toMatch(/^[a-f0-9]{64}$/);
	});

	it("rejects a legacy saved override when ARR no longer has its recorded score", async () => {
		await expect(
			createService({
				savedOverrides: [
					{
						instanceId: instance.id,
						qualityProfileId: 4,
						customFormatId: 42,
						score: 200,
						status: "APPLIED",
						connectionGeneration: 0,
						connectionStateToken: null,
					},
				],
			}).generatePreview("template-1", "instance-1", "user-1"),
		).rejects.toThrow("unverified saved score override");
	});

	it("fails closed when ARR returns duplicate Custom Format identities", async () => {
		const duplicateFormats = [
			{ id: 42, name: `First [${trashId}]`, specifications: [] },
			{ id: 43, name: `Second [${trashId}]`, specifications: [] },
		];

		await expect(
			createService({ customFormats: duplicateFormats }).generatePreview(
				"template-1",
				"instance-1",
				"user-1",
			),
		).rejects.toThrow("ambiguous Custom Format identities");
	});

	it("fails closed when an equivalent alias carries a stale mapping", async () => {
		const alias = { ...instance, id: "instance-alias" };
		const staleMapping = {
			id: "mapping-alias",
			templateId: "template-1",
			instanceId: alias.id,
			qualityProfileId: 4,
			qualityProfileName: "Any",
			connectionGeneration: alias.connectionGeneration + 1,
			connectionStateToken: "stale-token",
			syncStrategy: "auto",
		};

		await expect(
			createService({ instances: [instance, alias], mappings: [staleMapping] }).generatePreview(
				"template-1",
				"instance-1",
				"user-1",
			),
		).rejects.toThrow("older connection");
	});

	it("fails closed when equivalent aliases disagree about their managed-format snapshot", async () => {
		const alias = { ...instance, id: "instance-alias" };
		const sharedMapping = {
			templateId: "template-1",
			qualityProfileId: 4,
			qualityProfileName: "Any",
			connectionGeneration: instance.connectionGeneration,
			connectionStateToken: createDeploymentConnectionStateToken(instance),
			syncStrategy: "auto",
			managedCustomFormatsCaptured: true,
		};

		await expect(
			createService({
				instances: [instance, alias],
				mappings: [
					{
						...sharedMapping,
						id: "mapping-primary",
						instanceId: instance.id,
						managedCustomFormats: '[{"resourceId":42}]',
					},
					{
						...sharedMapping,
						id: "mapping-alias",
						instanceId: alias.id,
						managedCustomFormats: '[{"resourceId":43}]',
					},
				],
			}).generatePreview("template-1", "instance-1", "user-1"),
		).rejects.toThrow("conflicting deployment authority");
	});
});
