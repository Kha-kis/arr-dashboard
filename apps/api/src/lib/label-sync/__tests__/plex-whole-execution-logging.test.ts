import type { FastifyBaseLogger } from "fastify";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ServiceInstance } from "../../prisma.js";

const mocks = vi.hoisted(() => {
	class PlexMetadataTagWriteError extends Error {
		readonly code = "upstream_write_failed" as const;
		readonly responseCategory: "client_error" | "server_error" | "timeout" | "unavailable";

		constructor(
			responseCategory: "client_error" | "server_error" | "timeout" | "unavailable" = "unavailable",
		) {
			super("Plex metadata tag write failed");
			this.name = "PlexMetadataTagWriteError";
			this.responseCategory = responseCategory;
			delete this.stack;
		}
	}
	return {
		readInstanceSelected: vi.fn(),
		mutateMetadataTag: vi.fn(),
		emitNestedReadLog: vi.fn(),
		emitNestedMutationLog: vi.fn(),
		PlexMetadataTagWriteError,
	};
});

vi.mock("../../plex/plex-authority-service.js", () => ({
	PlexMetadataTagWriteError: mocks.PlexMetadataTagWriteError,
	PlexAuthorityService: class {
		private readonly log: FastifyBaseLogger;

		constructor(input: { log: FastifyBaseLogger }) {
			this.log = input.log;
		}

		async readInstanceSelected(input: unknown) {
			await mocks.emitNestedReadLog(this.log, input);
			return await mocks.readInstanceSelected(input);
		}

		async mutateMetadataTag(input: unknown) {
			await mocks.emitNestedMutationLog(this.log, input);
			return await mocks.mutateMetadataTag(input);
		}
	},
}));

import { executeLabelSyncRule } from "../execute-rule.js";

const canaries = {
	title: "CANARY_RULE_TITLE_787",
	tmdbId: 987_654_321,
	ratingKey: "987650123456789",
	sectionId: "CANARY_RULE_SECTION_ID_787",
	sectionTitle: "CANARY_RULE_SECTION_TITLE_787",
	guid: "plex://CANARY_RULE_GUID_787",
	username: "CANARY_RULE_USERNAME_787",
	url: "https://CANARY_RULE_HOST_787.invalid/private",
	token: "CANARY_RULE_TOKEN_787",
	statusText: "CANARY_RULE_STATUS_TEXT_787",
	rawError: "CANARY_RULE_RAW_ERROR_787",
	responseBody: "CANARY_RULE_RESPONSE_BODY_787",
	path: "/library/metadata/CANARY_RULE_PATH_787?token=CANARY_RULE_QUERY_787",
} as const;

const rule = {
	id: "rule-787",
	userId: "user-1",
	sourceService: "plex",
	sourceInstanceId: "plex-source",
	sourceTagName: "Private source",
	destService: "plex",
	destInstanceId: "plex-dest",
	destTagName: "Private destination",
};

function instance(id: string): ServiceInstance {
	return {
		id,
		userId: "user-1",
		service: "PLEX",
		label: id,
		baseUrl: "http://plex.invalid",
		externalUrl: null,
		encryptedApiKey: "encrypted",
		encryptionIv: "iv",
		enabled: true,
		isDefault: false,
		storageGroupId: null,
		createdAt: new Date("2026-08-28T00:00:00.000Z"),
		updatedAt: new Date("2026-08-28T00:00:00.000Z"),
	} as ServiceInstance;
}

function createLogger(): FastifyBaseLogger {
	const logger = {
		child: vi.fn(),
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		debug: vi.fn(),
		trace: vi.fn(),
		fatal: vi.fn(),
	} as unknown as FastifyBaseLogger;
	(logger.child as unknown as ReturnType<typeof vi.fn>).mockReturnValue(logger);
	return logger;
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
				tmdbId: canaries.tmdbId,
				mediaType: "movie",
				title: canaries.title,
				labels: '["Private source"]',
				ratingKey: canaries.ratingKey,
				thumb: `/library/metadata/${canaries.ratingKey}/thumb/1`,
				sectionId: canaries.sectionId,
				sectionTitle: canaries.sectionTitle,
				guid: canaries.guid,
			},
		],
	};
}

function destinationEvidence() {
	return sourceEvidence();
}

function unavailableEvidence(reasonCode: string) {
	return {
		available: false,
		evidence: {
			publicationLevel: "unavailable",
			completeness: "unknown",
			reasonCodes: [reasonCode],
		},
		rows: [],
	};
}

function nestedPrivateLog(log: FastifyBaseLogger) {
	log.warn(
		{
			err: new Error(`${canaries.rawError} ${canaries.statusText} ${canaries.url}`),
			sectionId: canaries.sectionId,
			sectionTitle: canaries.sectionTitle,
			path: canaries.path,
			response: canaries.responseBody,
			token: canaries.token,
		},
		`${canaries.rawError} ${canaries.statusText}`,
	);
}

function terminalEvents(log: FastifyBaseLogger): unknown[][] {
	return [log.info, log.warn, log.error, log.debug, log.trace, log.fatal]
		.flatMap((method) => (method as unknown as ReturnType<typeof vi.fn>).mock.calls)
		.filter(([fields]) => {
			const operation = (fields as { operation?: string } | undefined)?.operation;
			return operation === "source_read" || operation === "destination_write";
		});
}

function expectNoCanary(log: FastifyBaseLogger, diagnostics: unknown): void {
	const serialized = JSON.stringify({
		logs: [log.info, log.warn, log.error, log.debug, log.trace, log.fatal].flatMap(
			(method) => (method as unknown as ReturnType<typeof vi.fn>).mock.calls,
		),
		diagnostics,
	});
	for (const value of Object.values(canaries)) {
		expect(serialized).not.toContain(String(value));
	}
}

async function execute(log: FastifyBaseLogger) {
	const source = instance("plex-source");
	const destination = instance("plex-dest");
	return await executeLabelSyncRule({
		rule,
		prisma: {
			serviceInstance: {
				findMany: vi.fn().mockResolvedValue([source]),
				findFirst: vi.fn().mockResolvedValue(destination),
			},
		} as never,
		arrClientFactory: {} as never,
		encryptor: {} as never,
		log,
	});
}

function sourceSelection(input: unknown): boolean {
	return (input as { selection?: { kind?: string } })?.selection?.kind === "label-membership";
}

describe("complete Plex-to-Plex label-sync terminal logging", () => {
	beforeEach(() => {
		mocks.readInstanceSelected
			.mockReset()
			.mockImplementation(async (input: unknown) =>
				sourceSelection(input) ? sourceEvidence() : destinationEvidence(),
			);
		mocks.mutateMetadataTag.mockReset().mockResolvedValue({ ok: true });
		mocks.emitNestedReadLog.mockReset().mockResolvedValue(undefined);
		mocks.emitNestedMutationLog.mockReset().mockResolvedValue(undefined);
	});

	it("emits one source-authority failure and never invokes the destination", async () => {
		mocks.readInstanceSelected.mockImplementation(async (input: unknown) =>
			sourceSelection(input) ? unavailableEvidence("missing_status") : destinationEvidence(),
		);
		const log = createLogger();
		const result = await execute(log);

		expect(result).toMatchObject({ status: "failed", totals: { labelsApplied: 0, failures: 1 } });
		expect(result.totals).toEqual({
			sourceInstancesScanned: 1,
			taggedItemsFound: 0,
			destMatchesFound: 0,
			labelsApplied: 0,
			failures: 1,
		});
		expect(mocks.readInstanceSelected).toHaveBeenCalledOnce();
		expect(mocks.mutateMetadataTag).not.toHaveBeenCalled();
		expect(terminalEvents(log)).toEqual([
			[
				{
					operation: "source_read",
					state: "failed",
					stage: "source_authority",
					reasonCode: "source_authority_unavailable",
				},
				"Plex label-sync source read failed",
			],
		]);
		expectNoCanary(log, result);
	});

	it("emits one source-read failure and contains a thrown provider error", async () => {
		mocks.readInstanceSelected.mockImplementation(async (input: unknown) => {
			if (!sourceSelection(input)) return destinationEvidence();
			throw new Error(
				`${canaries.rawError} ${canaries.statusText} ${canaries.url} ${canaries.path} ${canaries.token}`,
			);
		});
		const log = createLogger();
		const result = await execute(log);

		expect(result).toMatchObject({ status: "failed", totals: { labelsApplied: 0, failures: 1 } });
		expect(result.totals).toEqual({
			sourceInstancesScanned: 1,
			taggedItemsFound: 0,
			destMatchesFound: 0,
			labelsApplied: 0,
			failures: 1,
		});
		expect(mocks.readInstanceSelected).toHaveBeenCalledOnce();
		expect(mocks.mutateMetadataTag).not.toHaveBeenCalled();
		expect(terminalEvents(log)).toEqual([
			[
				{
					operation: "source_read",
					state: "failed",
					stage: "source_read",
					reasonCode: "source_read_failed",
				},
				"Plex label-sync source read failed",
			],
		]);
		expectNoCanary(log, result);
	});

	it("emits one destination cached-authority failure", async () => {
		mocks.readInstanceSelected.mockImplementation(async (input: unknown) =>
			sourceSelection(input) ? sourceEvidence() : unavailableEvidence("missing_status"),
		);
		const log = createLogger();
		const result = await execute(log);

		expect(result).toMatchObject({ status: "failed", totals: { labelsApplied: 0, failures: 1 } });
		expect(result.totals).toEqual({
			sourceInstancesScanned: 1,
			taggedItemsFound: 1,
			destMatchesFound: 0,
			labelsApplied: 0,
			failures: 1,
		});
		expect(mocks.mutateMetadataTag).not.toHaveBeenCalled();
		expect(terminalEvents(log)).toEqual([
			[
				{
					operation: "destination_write",
					state: "failed",
					stage: "destination_authority",
					reasonCode: "provider_attempt_unavailable",
					candidateCount: 1,
				},
				"Plex label-sync destination write failed",
			],
		]);
		expectNoCanary(log, result);
	});

	it("emits one destination live-authority failure despite nested diagnostics", async () => {
		mocks.emitNestedMutationLog.mockImplementation(async (log: FastifyBaseLogger) =>
			nestedPrivateLog(log),
		);
		mocks.mutateMetadataTag.mockResolvedValue({
			ok: false,
			reasonCode: "live_target_changed",
			evidence: unavailableEvidence("plex_content_digest_changed").evidence,
		});
		const log = createLogger();
		const result = await execute(log);

		expect(result).toMatchObject({ status: "failed", totals: { labelsApplied: 0, failures: 1 } });
		expect(result.totals).toEqual({
			sourceInstancesScanned: 1,
			taggedItemsFound: 1,
			destMatchesFound: 1,
			labelsApplied: 0,
			failures: 1,
		});
		expect(terminalEvents(log)).toEqual([
			[
				{
					operation: "destination_write",
					state: "failed",
					stage: "destination_authority",
					reasonCode: "live_target_changed",
					mediaCategory: "movie",
				},
				"Plex label-sync destination write failed",
			],
		]);
		expectNoCanary(log, result);
	});

	it("emits one upstream-write failure after authority succeeds", async () => {
		mocks.emitNestedMutationLog.mockImplementation(async (log: FastifyBaseLogger) =>
			nestedPrivateLog(log),
		);
		mocks.mutateMetadataTag.mockRejectedValue(new mocks.PlexMetadataTagWriteError("unavailable"));
		const log = createLogger();
		const result = await execute(log);

		expect(result).toMatchObject({ status: "failed", totals: { labelsApplied: 0, failures: 1 } });
		expect(result.totals).toEqual({
			sourceInstancesScanned: 1,
			taggedItemsFound: 1,
			destMatchesFound: 1,
			labelsApplied: 0,
			failures: 1,
		});
		expect(mocks.mutateMetadataTag).toHaveBeenCalledOnce();
		expect(terminalEvents(log)).toEqual([
			[
				{
					operation: "destination_write",
					state: "failed",
					stage: "upstream_write",
					reasonCode: "upstream_write_failed",
					mediaCategory: "movie",
					upstreamCategory: "unavailable",
				},
				"Plex label-sync destination write failed",
			],
		]);
		expectNoCanary(log, result);
	});

	it("writes once and keeps the successful rule private", async () => {
		const log = createLogger();
		const result = await execute(log);

		expect(result).toMatchObject({
			status: "success",
			totals: { destMatchesFound: 1, labelsApplied: 1, failures: 0 },
		});
		expect(result.totals).toEqual({
			sourceInstancesScanned: 1,
			taggedItemsFound: 1,
			destMatchesFound: 1,
			labelsApplied: 1,
			failures: 0,
		});
		expect(mocks.mutateMetadataTag).toHaveBeenCalledOnce();
		expect(terminalEvents(log)).toHaveLength(0);
		expectNoCanary(log, result);
	});
});
