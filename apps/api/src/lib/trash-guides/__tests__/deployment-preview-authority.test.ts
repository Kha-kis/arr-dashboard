import { describe, expect, it, vi } from "vitest";
import { DeploymentPreviewService } from "../deployment-preview.js";

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
	name: "Any",
	serviceType: "RADARR",
	configData: JSON.stringify({
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
		instances?: (typeof instance)[];
	} = {},
) {
	const existingFormat = {
		id: 42,
		name: `Different ARR name [${trashId.toUpperCase()}]`,
		specifications: [],
	};
	const profile = { id: 4, name: "Any", formatItems: [{ format: 42, score: 100 }] };
	const prisma = {
		trashTemplate: { findUnique: vi.fn().mockResolvedValue(template) },
		serviceInstance: {
			findFirst: vi.fn().mockResolvedValue(instance),
			findMany: vi.fn().mockResolvedValue(options.instances ?? [instance]),
		},
		templateQualityProfileMapping: {
			findMany: vi.fn().mockResolvedValue(options.mappings ?? []),
		},
		instanceQualityProfileOverride: { findMany: vi.fn().mockResolvedValue([]) },
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
});
