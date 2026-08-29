import type { FastifyBaseLogger } from "fastify";
import pino from "pino";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ServiceInstance } from "../../prisma.js";

const mocks = vi.hoisted(() => ({
	readInstanceSelected: vi.fn(),
	mutateMetadataTag: vi.fn(),
}));

vi.mock("../../plex/plex-authority-service.js", () => ({
	PlexAuthorityService: class {
		private readonly log: FastifyBaseLogger;

		constructor(input: { log: FastifyBaseLogger }) {
			this.log = input.log;
		}

		async readInstanceSelected(input: unknown) {
			this.log.warn(
				{
					err: new Error(PROVIDER_ERROR),
					token: PROVIDER_TOKEN,
					path: PROVIDER_PATH,
					responseBody: PROVIDER_BODY,
				},
				PROVIDER_ERROR,
			);
			return await mocks.readInstanceSelected(input);
		}

		async mutateMetadataTag(input: unknown) {
			return await mocks.mutateMetadataTag(input);
		}
	},
}));

import { LabelSyncScheduler } from "../label-sync-scheduler.js";
import { triggerLabelSyncForItem } from "../trigger-for-item.js";

const PROVIDER_ERROR = "CANARY_OUTER_PROVIDER_ERROR_787";
const PROVIDER_TOKEN = "CANARY_OUTER_PROVIDER_TOKEN_787";
const PROVIDER_PATH = "/library/metadata/CANARY_OUTER_PATH_787?token=secret";
const PROVIDER_BODY = "CANARY_OUTER_RESPONSE_BODY_787";

const RULE = {
	id: "CANARY_OUTER_RULE_ID_787",
	userId: "user-787",
	name: "Private Plex rule",
	enabled: true,
	sourceService: "plex",
	sourceInstanceId: "CANARY_OUTER_SOURCE_INSTANCE_787",
	sourceTagName: "Private source label",
	destService: "plex",
	destInstanceId: "CANARY_OUTER_DEST_INSTANCE_787",
	destTagName: "Private destination label",
	lastRunAt: null,
	lastRunStatus: null,
	lastRunMessage: null,
	createdAt: new Date("2026-08-29T00:00:00.000Z"),
	updatedAt: new Date("2026-08-29T00:00:00.000Z"),
} as const;

function serviceInstance(id: string): ServiceInstance {
	return {
		id,
		userId: RULE.userId,
		service: "PLEX",
		label: id,
		baseUrl: "https://CANARY_OUTER_HOST_787.invalid",
		externalUrl: null,
		encryptedApiKey: PROVIDER_TOKEN,
		encryptionIv: "iv-787",
		enabled: true,
		isDefault: false,
		storageGroupId: null,
		createdAt: RULE.createdAt,
		updatedAt: RULE.updatedAt,
	} as ServiceInstance;
}

function sourceEvidence() {
	return {
		available: true,
		connectionGeneration: 4,
		identityGeneration: 9,
		evidence: {
			publicationLevel: "authoritative",
			completeness: "complete",
			reasonCodes: [],
		},
		rows: [
			{
				tmdbId: 787,
				mediaType: "movie",
				title: "CANARY_OUTER_TITLE_787",
				labels: '["Private source label"]',
			},
		],
	};
}

function createPinoCapture(): { log: FastifyBaseLogger; serialized: () => string } {
	const lines: string[] = [];
	const log = pino(
		{ level: "trace", base: null, timestamp: false },
		{ write: (line: string) => lines.push(line) },
	) as unknown as FastifyBaseLogger;
	return { log, serialized: () => lines.join("") };
}

function expectNoProviderCanary(serialized: string): void {
	for (const value of [
		PROVIDER_ERROR,
		PROVIDER_TOKEN,
		PROVIDER_PATH,
		PROVIDER_BODY,
		RULE.id,
		RULE.sourceInstanceId,
		RULE.destInstanceId,
	]) {
		expect(serialized).not.toContain(value);
	}
}

function executionPrisma() {
	const update = vi.fn().mockImplementation(({ data }) => Promise.resolve({ ...RULE, ...data }));
	return {
		serviceInstance: {
			findMany: vi.fn().mockResolvedValue([serviceInstance(RULE.sourceInstanceId)]),
			findFirst: vi.fn().mockResolvedValue(serviceInstance(RULE.destInstanceId)),
		},
		labelSyncRule: {
			findMany: vi.fn().mockResolvedValue([RULE]),
			update,
		},
	};
}

describe("Plex label-sync outer exception containment", () => {
	beforeEach(() => {
		mocks.readInstanceSelected.mockReset();
		mocks.mutateMetadataTag.mockReset();
	});

	it("persists a bounded scheduler result when destination provider authority throws", async () => {
		const capture = createPinoCapture();
		const prisma = executionPrisma();
		mocks.readInstanceSelected
			.mockResolvedValueOnce(sourceEvidence())
			.mockRejectedValueOnce(new Error(PROVIDER_ERROR));
		const scheduler = new LabelSyncScheduler(
			prisma as never,
			{} as never,
			{} as never,
			capture.log,
		);

		await (scheduler as unknown as { tick(): Promise<void> }).tick();

		expect(prisma.labelSyncRule.update).toHaveBeenCalledOnce();
		expect(prisma.labelSyncRule.update).toHaveBeenCalledWith({
			where: { id: RULE.id },
			data: {
				lastRunAt: expect.any(Date),
				lastRunStatus: "failed",
				lastRunMessage: "All 1 attempts failed.",
			},
		});
		expect(mocks.mutateMetadataTag).not.toHaveBeenCalled();
		expectNoProviderCanary(capture.serialized());
	});

	it("returns a bounded event-trigger outcome when destination provider authority throws", async () => {
		const capture = createPinoCapture();
		const prisma = executionPrisma();
		mocks.readInstanceSelected
			.mockResolvedValueOnce(sourceEvidence())
			.mockRejectedValueOnce(new Error(PROVIDER_ERROR));

		const result = await triggerLabelSyncForItem({
			userId: RULE.userId,
			sourceService: "PLEX",
			sourceInstanceId: RULE.sourceInstanceId,
			arrItemId: 787,
			itemType: "movie",
			tmdbId: 787,
			prisma: prisma as never,
			arrClientFactory: {} as never,
			encryptor: {} as never,
			log: capture.log,
		});

		expect(result).toEqual({
			rulesFired: 1,
			results: [
				{
					ruleId: RULE.id,
					ruleName: RULE.name,
					outcome: {
						status: "failed",
						message: "All 1 attempts failed.",
						totals: {
							sourceInstancesScanned: 1,
							taggedItemsFound: 1,
							destMatchesFound: 0,
							labelsApplied: 0,
							failures: 1,
						},
					},
				},
			],
			totals: { labelsApplied: 0, failures: 1 },
		});
		expect(mocks.mutateMetadataTag).not.toHaveBeenCalled();
		expectNoProviderCanary(capture.serialized());
	});
});
