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
			emitProviderCanaries(this.log);
			return await mocks.readInstanceSelected(input);
		}

		async mutateMetadataTag(input: unknown) {
			emitProviderCanaries(this.log);
			return await mocks.mutateMetadataTag(input);
		}
	},
}));

import { executeLabelSyncRule } from "../execute-rule.js";

const CANARIES = {
	title: "CANARY_TITLE_787",
	filename: "CANARY_FILENAME_787.mkv",
	filePath: "/media/CANARY_PATH_787/CANARY_FILENAME_787.mkv",
	tmdbId: 787_987_654,
	tvdbId: 787_123_456,
	ratingKey: "787987654321",
	guid: "plex://CANARY_GUID_787",
	sectionId: "CANARY_SECTION_ID_787",
	sectionTitle: "CANARY_SECTION_TITLE_787",
	username: "CANARY_USERNAME_787",
	baseUrl: "https://CANARY_HOST_787.invalid:32400",
	hostname: "CANARY_HOST_787.invalid",
	token: "CANARY_TOKEN_787",
	apiKey: "CANARY_API_KEY_787",
	authorization: "Bearer CANARY_AUTHORIZATION_787",
	requestPath: "/library/metadata/CANARY_REQUEST_PATH_787?token=CANARY_QUERY_787",
	statusText: "CANARY_STATUS_TEXT_787",
	responseBody: "CANARY_RESPONSE_BODY_787",
	rawPayload: "CANARY_RAW_PAYLOAD_787",
	errorMessage: "CANARY_ERROR_MESSAGE_787",
	stack: "CANARY_STACK_787",
	cause: "CANARY_CAUSE_787",
} as const;

const RULE = {
	id: "CANARY_RULE_ID_787",
	userId: "user-787",
	sourceService: "plex",
	sourceInstanceId: "CANARY_SOURCE_INSTANCE_ID_787",
	sourceTagName: "Private source label",
	destService: "plex",
	destInstanceId: "CANARY_DEST_INSTANCE_ID_787",
	destTagName: "Private destination label",
} as const;

function emitProviderCanaries(log: FastifyBaseLogger): void {
	const cause = new Error(CANARIES.cause);
	const error = new Error(CANARIES.errorMessage, { cause });
	error.stack = CANARIES.stack;
	log.warn(
		{
			err: error,
			title: CANARIES.title,
			filename: CANARIES.filename,
			filePath: CANARIES.filePath,
			tmdbId: CANARIES.tmdbId,
			tvdbId: CANARIES.tvdbId,
			ratingKey: CANARIES.ratingKey,
			guid: CANARIES.guid,
			sectionId: CANARIES.sectionId,
			sectionTitle: CANARIES.sectionTitle,
			username: CANARIES.username,
			baseUrl: CANARIES.baseUrl,
			hostname: CANARIES.hostname,
			token: CANARIES.token,
			apiKey: CANARIES.apiKey,
			authorization: CANARIES.authorization,
			path: CANARIES.requestPath,
			statusText: CANARIES.statusText,
			responseBody: CANARIES.responseBody,
			payload: CANARIES.rawPayload,
		},
		CANARIES.errorMessage,
	);
}

function createPinoCapture(): {
	log: FastifyBaseLogger;
	serialized: () => string;
	records: () => Array<Record<string, unknown>>;
} {
	const lines: string[] = [];
	const destination = {
		write(line: string) {
			lines.push(line);
		},
	};
	const log = pino(
		{
			level: "trace",
			base: null,
			timestamp: false,
		},
		destination,
	) as unknown as FastifyBaseLogger;
	return {
		log,
		serialized: () => lines.join(""),
		records: () =>
			lines
				.join("")
				.split("\n")
				.filter(Boolean)
				.map((line) => JSON.parse(line) as Record<string, unknown>),
	};
}

function serviceInstance(id: string): ServiceInstance {
	return {
		id,
		userId: RULE.userId,
		service: "PLEX",
		label: id,
		baseUrl: CANARIES.baseUrl,
		externalUrl: null,
		encryptedApiKey: CANARIES.token,
		encryptionIv: "iv-787",
		enabled: true,
		isDefault: false,
		storageGroupId: null,
		createdAt: new Date("2026-08-29T00:00:00.000Z"),
		updatedAt: new Date("2026-08-29T00:00:00.000Z"),
	} as ServiceInstance;
}

function prismaForRule() {
	return {
		serviceInstance: {
			findMany: vi.fn().mockResolvedValue([serviceInstance(RULE.sourceInstanceId)]),
			findFirst: vi.fn().mockResolvedValue(serviceInstance(RULE.destInstanceId)),
		},
	};
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
				tmdbId: CANARIES.tmdbId,
				mediaType: "movie",
				title: CANARIES.title,
				labels: '["Private source label"]',
			},
		],
	};
}

function destinationEvidence() {
	return {
		...sourceEvidence(),
		rows: [
			{
				tmdbId: CANARIES.tmdbId,
				mediaType: "movie",
				title: CANARIES.title,
				ratingKey: CANARIES.ratingKey,
				thumb: `/library/metadata/${CANARIES.ratingKey}/thumb/1`,
			},
		],
	};
}

function unavailableEvidence() {
	return {
		available: false,
		evidence: {
			publicationLevel: "unavailable",
			completeness: "unknown",
			reasonCodes: ["missing_status"],
		},
		rows: [],
	};
}

function expectNoPlexOperationLog(capture: ReturnType<typeof createPinoCapture>): void {
	expect(capture.records()).toEqual([]);
	const serialized = capture.serialized();
	for (const value of [...Object.values(CANARIES), ...Object.values(RULE)]) {
		expect(serialized).not.toContain(String(value));
	}
}

async function runRule(log: FastifyBaseLogger) {
	return await executeLabelSyncRule({
		rule: RULE,
		prisma: prismaForRule() as never,
		arrClientFactory: {} as never,
		encryptor: {} as never,
		log,
	});
}

describe("Plex label-sync whole-execution log containment", () => {
	beforeEach(() => {
		mocks.readInstanceSelected.mockReset();
		mocks.mutateMetadataTag.mockReset();
	});

	it("uses a binding-aware real Pino capture", () => {
		const capture = createPinoCapture();
		capture.log
			.child({ ruleId: RULE.id })
			.child({ sourceInstanceId: RULE.sourceInstanceId })
			.child({ destInstanceId: RULE.destInstanceId })
			.warn("ordinary bound record");

		expect(capture.records()).toEqual([
			expect.objectContaining({
				ruleId: RULE.id,
				sourceInstanceId: RULE.sourceInstanceId,
				destInstanceId: RULE.destInstanceId,
				msg: "ordinary bound record",
			}),
		]);
	});

	it("contains a Plex source provider failure and does not invoke the destination", async () => {
		const capture = createPinoCapture();
		mocks.readInstanceSelected.mockRejectedValueOnce(new Error(CANARIES.errorMessage));

		const result = await runRule(capture.log);

		expect(result).toEqual({
			status: "failed",
			message: "Source reads failed on 1 instance — no candidates collected.",
			totals: {
				sourceInstancesScanned: 1,
				taggedItemsFound: 0,
				destMatchesFound: 0,
				labelsApplied: 0,
				failures: 1,
			},
		});
		expect(mocks.readInstanceSelected).toHaveBeenCalledOnce();
		expect(mocks.mutateMetadataTag).not.toHaveBeenCalled();
		expectNoPlexOperationLog(capture);
	});

	it("contains unavailable Plex destination authority with exact failure accounting", async () => {
		const capture = createPinoCapture();
		mocks.readInstanceSelected
			.mockResolvedValueOnce(sourceEvidence())
			.mockResolvedValueOnce(unavailableEvidence());

		const result = await runRule(capture.log);

		expect(result).toEqual({
			status: "failed",
			message: "All 1 attempts failed.",
			totals: {
				sourceInstancesScanned: 1,
				taggedItemsFound: 1,
				destMatchesFound: 0,
				labelsApplied: 0,
				failures: 1,
			},
		});
		expect(mocks.mutateMetadataTag).not.toHaveBeenCalled();
		expectNoPlexOperationLog(capture);
	});

	it("contains a Plex metadata write failure without recording success", async () => {
		const capture = createPinoCapture();
		mocks.readInstanceSelected
			.mockResolvedValueOnce(sourceEvidence())
			.mockResolvedValueOnce(destinationEvidence());
		mocks.mutateMetadataTag.mockRejectedValueOnce(new Error(CANARIES.errorMessage));

		const result = await runRule(capture.log);

		expect(result).toEqual({
			status: "failed",
			message: "All 1 attempts failed.",
			totals: {
				sourceInstancesScanned: 1,
				taggedItemsFound: 1,
				destMatchesFound: 1,
				labelsApplied: 0,
				failures: 1,
			},
		});
		expect(mocks.mutateMetadataTag).toHaveBeenCalledOnce();
		expectNoPlexOperationLog(capture);
	});

	it("performs one successful Plex write without a per-target success event", async () => {
		const capture = createPinoCapture();
		mocks.readInstanceSelected
			.mockResolvedValueOnce(sourceEvidence())
			.mockResolvedValueOnce(destinationEvidence());
		mocks.mutateMetadataTag.mockResolvedValueOnce({ ok: true });

		const result = await runRule(capture.log);

		expect(result.status).toBe("success");
		expect(result.totals).toEqual({
			sourceInstancesScanned: 1,
			taggedItemsFound: 1,
			destMatchesFound: 1,
			labelsApplied: 1,
			failures: 0,
		});
		expect(mocks.mutateMetadataTag).toHaveBeenCalledOnce();
		expectNoPlexOperationLog(capture);
	});
});
