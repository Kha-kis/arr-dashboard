import type { FastifyBaseLogger } from "fastify";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PlexMetadataTagWriteError } from "../../../plex/plex-label-sync-logging.js";
import type { LabelSyncRuleInput } from "../../execute-rule.js";
import type { DestWriterOpts } from "../../strategy-types.js";

const mocks = vi.hoisted(() => {
	return {
		readInstanceSelected: vi.fn(),
		mutateMetadataTag: vi.fn(),
		upstreamWrite: vi.fn(),
		emitProviderLog: vi.fn(),
	};
});

vi.mock("../../../plex/plex-authority-service.js", () => ({
	PlexAuthorityService: class {
		private readonly log: FastifyBaseLogger;

		constructor(input: { log: FastifyBaseLogger }) {
			this.log = input.log;
		}

		async readInstanceSelected(input: unknown) {
			return await mocks.readInstanceSelected(input);
		}

		async mutateMetadataTag(input: unknown) {
			await mocks.emitProviderLog(this.log);
			return await mocks.mutateMetadataTag(input);
		}
	},
}));

import { plexDestWriter } from "../plex-writer.js";

const canaries = {
	title: "CANARY_TITLE_A9F4",
	tmdbId: 987654321,
	ratingKey: "987650123456789",
	guid: "plex://CANARY_GUID_C3E8",
	sectionId: "CANARY_SECTION_ID_D6A1",
	sectionTitle: "CANARY_SECTION_TITLE_E5B9",
	username: "CANARY_USERNAME_F2C7",
	url: "https://CANARY_HOST_G8D4.invalid/library/metadata/private",
	hostname: "CANARY_HOST_G8D4.invalid",
	token: "CANARY_TOKEN_H1E6",
	apiKey: "CANARY_API_KEY_J4B3",
	rawError: "CANARY_RAW_ERROR_K7F5",
	responseBody: "CANARY_RESPONSE_BODY_L2A8",
} as const;

const rule = {
	id: "rule-1",
	userId: "user-1",
	sourceService: "plex",
	destService: "plex",
	sourceInstanceId: "plex-source",
	destInstanceId: "plex-dest",
	sourceTagName: "Kids",
	destTagName: "Family",
} as LabelSyncRuleInput;

const instance = {
	id: "plex-dest",
	userId: "user-1",
	service: "PLEX",
	label: "Plex",
} as DestWriterOpts["destInstance"];

function createLogger() {
	return {
		child: vi.fn().mockReturnThis(),
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		debug: vi.fn(),
		trace: vi.fn(),
		fatal: vi.fn(),
	} as unknown as FastifyBaseLogger;
}

function canaryRow(overrides: Record<string, unknown> = {}) {
	return {
		tmdbId: canaries.tmdbId,
		mediaType: "movie",
		title: canaries.title,
		ratingKey: canaries.ratingKey,
		thumb: `/library/metadata/${canaries.ratingKey}/thumb/1`,
		guid: canaries.guid,
		sectionId: canaries.sectionId,
		sectionTitle: canaries.sectionTitle,
		username: canaries.username,
		provider: {
			url: canaries.url,
			hostname: canaries.hostname,
			token: canaries.token,
			apiKey: canaries.apiKey,
			responseBody: canaries.responseBody,
		},
		...overrides,
	};
}

function authoritativeEvidence(rows: unknown[]) {
	return {
		available: true,
		connectionGeneration: 4,
		identityGeneration: 9,
		evidence: {
			publicationLevel: "authoritative",
			completeness: "complete",
			reasonCodes: [],
		},
		rows,
	};
}

function unavailableEvidence(reasonCode: string) {
	return {
		available: false,
		evidence: {
			publicationLevel: "unavailable",
			completeness: "unknown",
			reasonCodes: [reasonCode],
			provider: canaryRow(),
		},
	};
}

function allLogText(log: FastifyBaseLogger, diagnostics?: unknown): string {
	const calls = [log.info, log.warn, log.error, log.debug, log.trace, log.fatal].flatMap(
		(method) => (method as unknown as ReturnType<typeof vi.fn>).mock.calls,
	);
	return JSON.stringify({ calls, diagnostics });
}

function expectPrivate(log: FastifyBaseLogger, diagnostics?: unknown) {
	const allowedKeys = new Set([
		"operation",
		"state",
		"stage",
		"reasonCode",
		"mediaCategory",
		"candidateCount",
		"upstreamCategory",
	]);
	for (const method of [log.info, log.warn, log.error, log.debug, log.trace, log.fatal]) {
		for (const [fields] of (method as unknown as ReturnType<typeof vi.fn>).mock.calls) {
			if (!fields || typeof fields !== "object") continue;
			expect(Object.keys(fields).every((key) => allowedKeys.has(key))).toBe(true);
		}
	}
	const serialized = allLogText(log, diagnostics);
	for (const value of Object.values(canaries)) {
		expect(serialized).not.toContain(String(value));
	}
}

function expectReason(log: FastifyBaseLogger, reasonCode: string) {
	expect(log.warn).toHaveBeenCalledWith(
		expect.objectContaining({ operation: "destination_write", state: "failed", reasonCode }),
		"Plex label-sync destination write failed",
	);
}

async function apply(
	log: FastifyBaseLogger,
	candidates: DestWriterOpts["candidates"] = [
		{ tmdbId: canaries.tmdbId, mediaType: "movie", title: canaries.title },
	],
) {
	return await plexDestWriter.applyLabels({
		rule,
		destInstance: instance,
		candidates,
		prisma: {} as DestWriterOpts["prisma"],
		arrClientFactory: {} as DestWriterOpts["arrClientFactory"],
		encryptor: {} as DestWriterOpts["encryptor"],
		log,
	});
}

describe("Plex label writer privacy-safe mutation logging", () => {
	beforeEach(() => {
		mocks.readInstanceSelected.mockReset().mockResolvedValue(authoritativeEvidence([canaryRow()]));
		mocks.upstreamWrite.mockReset().mockResolvedValue(undefined);
		mocks.mutateMetadataTag.mockReset().mockImplementation(async () => {
			await mocks.upstreamWrite();
			return { ok: true };
		});
		mocks.emitProviderLog.mockReset().mockResolvedValue(undefined);
	});

	it("redacts missing cached target evidence", async () => {
		mocks.readInstanceSelected.mockResolvedValue(
			authoritativeEvidence([canaryRow({ ratingKey: null, thumb: null })]),
		);
		const log = createLogger();
		const result = await apply(log);

		expect(result).toEqual({ matchesFound: 1, labelsApplied: 0, failures: 1 });
		expectReason(log, "cached_target_unavailable");
		expectPrivate(log, result);
	});

	it("redacts inconsistent cached target evidence", async () => {
		mocks.readInstanceSelected.mockResolvedValue(
			authoritativeEvidence([canaryRow({ thumb: "/library/metadata/123456789/thumb/1" })]),
		);
		const log = createLogger();
		const result = await apply(log);

		expect(result).toEqual({ matchesFound: 1, labelsApplied: 0, failures: 1 });
		expectReason(log, "cached_target_inconsistent");
		expectPrivate(log, result);
	});

	it("logs ambiguous candidates without exposing either logical identity", async () => {
		const log = createLogger();
		const result = await apply(log, [
			{ tmdbId: canaries.tmdbId, mediaType: "movie", title: canaries.title },
			{ tmdbId: canaries.tmdbId, mediaType: "series", title: `${canaries.title}_SERIES` },
		]);

		expect(result).toEqual({ matchesFound: 0, labelsApplied: 0, failures: 2 });
		expectReason(log, "cached_target_ambiguous");
		expectPrivate(log, result);
	});

	it.each([
		["changed cached evidence", "live_target_changed", "live_target_changed"],
		["missing live target", "live_target_missing", "live_target_missing"],
		["ambiguous live target", "live_target_ambiguous", "live_target_ambiguous"],
		["changed or reused rating key", "live_target_changed", "live_target_changed"],
		["connection generation change", "provider_connection_changed", "provider_connection_changed"],
		["identity generation change", "provider_identity_changed", "provider_identity_changed"],
		[
			"disabled or unowned provider",
			"provider_authority_unavailable",
			"provider_attempt_unavailable",
		],
		["Plex read failure", "provider_authority_unavailable", "provider_attempt_unavailable"],
		["duplicate-edition ambiguity", "live_target_ambiguous", "live_target_ambiguous"],
	] as const)("redacts %s diagnostics", async (_name, authorityReason, terminalReason) => {
		mocks.mutateMetadataTag.mockResolvedValue({
			ok: false,
			reasonCode: authorityReason,
			evidence: unavailableEvidence("provider_private_reason").evidence,
		});
		mocks.emitProviderLog.mockImplementationOnce(async (providerLog: FastifyBaseLogger) => {
			providerLog.error(
				{
					err: new Error(`${canaries.rawError} ${canaries.url} ${canaries.token}`),
					response: canaries.responseBody,
					row: canaryRow(),
				},
				`${canaries.rawError} ${canaries.sectionTitle}`,
			);
		});
		const log = createLogger();
		const result = await apply(log);

		expect(result).toEqual({ matchesFound: 1, labelsApplied: 0, failures: 1 });
		expectReason(log, terminalReason);
		expectPrivate(log, result);
	});

	it.each([
		["failed", "latest_attempt_failed"],
		["in progress", "latest_attempt_in_progress"],
		["unavailable", "missing_status"],
	] as const)("redacts a %s publication attempt", async (_name, providerReason) => {
		mocks.readInstanceSelected.mockResolvedValue(unavailableEvidence(providerReason));
		const log = createLogger();
		const result = await apply(log);

		expect(result).toEqual({ matchesFound: 0, labelsApplied: 0, failures: 1 });
		expectReason(
			log,
			providerReason.startsWith("latest_attempt_")
				? "publication_superseded"
				: "provider_attempt_unavailable",
		);
		expectPrivate(log, result);
	});

	it("maps a changed Plex content digest to a changed live target", async () => {
		mocks.readInstanceSelected.mockResolvedValue(
			unavailableEvidence("plex_content_digest_changed"),
		);
		const log = createLogger();
		const result = await apply(log);

		expect(result).toEqual({ matchesFound: 0, labelsApplied: 0, failures: 1 });
		expectReason(log, "live_target_changed");
		expectPrivate(log, result);
	});

	it.each([
		["rejected response", "client_error"],
		["write exception", "unavailable"],
	] as const)("redacts an upstream metadata-tag %s", async (_name, responseCategory) => {
		mocks.emitProviderLog.mockImplementationOnce(async (providerLog: FastifyBaseLogger) => {
			providerLog.warn(
				{
					operation: "plex_api_request",
					responseCategory,
					path: `/library/metadata/${canaries.ratingKey}?token=${canaries.token}`,
					body: canaries.responseBody,
				},
				`${canaries.rawError} ${canaries.url}`,
			);
		});
		mocks.mutateMetadataTag.mockImplementationOnce(async () => {
			await mocks.upstreamWrite();
			throw new PlexMetadataTagWriteError(responseCategory);
		});
		const log = createLogger();
		const result = await apply(log);

		expect(result).toEqual({ matchesFound: 1, labelsApplied: 0, failures: 1 });
		expect(mocks.upstreamWrite).toHaveBeenCalledOnce();
		expect(log.warn).toHaveBeenCalledTimes(1);
		expect(log.warn).toHaveBeenCalledWith(
			{
				operation: "destination_write",
				state: "failed",
				stage: "upstream_write",
				reasonCode:
					responseCategory === "client_error" ? "upstream_write_rejected" : "upstream_write_failed",
				mediaCategory: "movie",
				upstreamCategory: responseCategory,
			},
			"Plex label-sync destination write failed",
		);
		expectPrivate(log, result);
	});

	it.each([
		["Error", new Error(`${canaries.rawError} ${canaries.url} ${canaries.responseBody}`)],
		["string", `${canaries.rawError} ${canaries.token}`],
		["object", { privatePath: canaries.url, privateBody: canaries.responseBody }],
		["null", null],
		["undefined", undefined],
	] as const)(
		"classifies a pre-write %s as an unknown authority failure",
		async (_name, thrown) => {
			mocks.mutateMetadataTag.mockImplementationOnce(async () => {
				throw thrown;
			});
			const log = createLogger();
			const result = await apply(log);

			expect(result).toEqual({ matchesFound: 1, labelsApplied: 0, failures: 1 });
			expect(mocks.upstreamWrite).not.toHaveBeenCalled();
			expect(log.warn).toHaveBeenCalledTimes(1);
			expect(log.warn).toHaveBeenCalledWith(
				{
					operation: "destination_write",
					state: "failed",
					stage: "destination_authority",
					reasonCode: "unknown_failure",
					mediaCategory: "movie",
				},
				"Plex label-sync destination write failed",
			);
			expectPrivate(log, result);
		},
	);

	it("keeps a successful write private and records exactly one success", async () => {
		const log = createLogger();
		const result = await apply(log);

		expect(result).toEqual({ matchesFound: 1, labelsApplied: 1, failures: 0 });
		expect(mocks.mutateMetadataTag).toHaveBeenCalledOnce();
		expect(mocks.upstreamWrite).toHaveBeenCalledOnce();
		expect(log.warn).not.toHaveBeenCalled();
		expect(log.error).not.toHaveBeenCalled();
		expectPrivate(log, result);
	});
});
