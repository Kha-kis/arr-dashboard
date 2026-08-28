import type { FastifyBaseLogger } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ServiceInstance } from "../../prisma.js";

const repositoryMocks = vi.hoisted(() => ({
	loadInstanceSelectedEvidence: vi.fn(),
}));

vi.mock("../../plex/plex-evidence-repository.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../plex/plex-evidence-repository.js")>();
	return {
		...actual,
		loadInstanceSelectedEvidence: repositoryMocks.loadInstanceSelectedEvidence,
	};
});

import { plexDestWriter } from "../dest-writers/plex-writer.js";
import { executeLabelSyncRule } from "../execute-rule.js";

const canaries = {
	title: "CANARY_SOURCE_TITLE_787",
	tmdbId: 987_654_321,
	ratingKey: "CANARY_SOURCE_RATING_KEY_787",
	sectionId: "CANARY_SOURCE_SECTION_ID_787",
	sectionTitle: "CANARY_SOURCE_SECTION_TITLE_787",
	guid: "plex://CANARY_SOURCE_GUID_787",
	username: "CANARY_SOURCE_USERNAME_787",
	baseUrl: "https://CANARY_SOURCE_HOST_787.invalid",
	hostname: "CANARY_SOURCE_HOST_787.invalid",
	token: "CANARY_SOURCE_TOKEN_787",
	statusText: "CANARY_SOURCE_STATUS_TEXT_787",
	rawError: "CANARY_SOURCE_RAW_ERROR_787",
	responseBody: "CANARY_SOURCE_RESPONSE_BODY_787",
	requestPath: "/library/sections/CANARY_SOURCE_PATH_787/all?private=CANARY_SOURCE_QUERY_787",
} as const;

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

function allLogText(log: FastifyBaseLogger, diagnostics: unknown): string {
	const calls = [log.info, log.warn, log.error, log.debug, log.trace, log.fatal].flatMap(
		(method) => (method as unknown as ReturnType<typeof vi.fn>).mock.calls,
	);
	return JSON.stringify({ calls, diagnostics });
}

function instance(id: string): ServiceInstance {
	return {
		id,
		userId: "user-1",
		service: "PLEX",
		label: id,
		baseUrl: canaries.baseUrl,
		externalUrl: null,
		encryptedApiKey: "encrypted-token",
		encryptionIv: "token-iv",
		enabled: true,
		isDefault: false,
		storageGroupId: null,
		expectedIdentity: "plex-machine-787",
		identityKind: "PLEX_MACHINE_IDENTIFIER",
		identityStatus: "VERIFIED",
		identityVerifiedAt: new Date("2026-08-28T00:00:00.000Z"),
		connectionGeneration: 4,
		identityGeneration: 9,
		createdAt: new Date("2026-08-28T00:00:00.000Z"),
		updatedAt: new Date("2026-08-28T00:00:00.000Z"),
	} as ServiceInstance;
}

function jsonResponse(value: unknown): Response {
	return new Response(JSON.stringify(value), {
		status: 200,
		headers: { "content-type": "application/json" },
	});
}

describe("Plex label-sync whole-execution source logging", () => {
	beforeEach(() => {
		repositoryMocks.loadInstanceSelectedEvidence.mockReset().mockResolvedValue({
			available: true,
			instanceId: "plex-source",
			instanceName: canaries.username,
			generationId: "generation-787",
			publishedAt: new Date("2026-08-28T00:00:00.000Z"),
			itemCount: 1,
			connectionGeneration: 4,
			identityGeneration: 9,
			metadata: {
				version: 3,
				publicationLevel: "authoritative",
				completeness: "complete",
				itemCount: 1,
				canonicalizationVersion: 1,
				sections: [
					{
						key: canaries.sectionId,
						uuid: "section-uuid-787",
						title: canaries.sectionTitle,
						type: "movie",
						refreshing: false,
						scannedAt: 1_777_000_000,
						updatedAt: 1_777_000_100,
					},
				],
				roots: [],
			},
			generationStatus: {},
			sections: [],
			rows: [
				{
					instanceId: "plex-source",
					tmdbId: canaries.tmdbId,
					mediaType: "movie",
					sectionId: canaries.sectionId,
					sectionTitle: canaries.sectionTitle,
					title: canaries.title,
					ratingKey: canaries.ratingKey,
					labels: '["Private"]',
					guid: canaries.guid,
				},
			],
			evidence: {
				availability: "current",
				authority: "authoritative",
				attemptState: "success",
				publicationLevel: "authoritative",
				completeness: "complete",
				reasonCodes: [],
			},
		});

		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: string | URL | Request) => {
				const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
				if (url.pathname === "/activities") {
					return jsonResponse({
						MediaContainer: { offset: 0, size: 0, totalSize: 0, Activity: [] },
					});
				}
				if (url.pathname === "/library/sections") {
					return jsonResponse({
						MediaContainer: {
							offset: 0,
							size: 1,
							totalSize: 1,
							Directory: [
								{
									key: canaries.sectionId,
									uuid: "section-uuid-787",
									title: canaries.sectionTitle,
									type: "movie",
									agent: "tv.plex.agents.movie",
									refreshing: false,
									scannedAt: 1_777_000_000,
									updatedAt: 1_777_000_100,
								},
							],
						},
					});
				}
				if (url.pathname === "/accounts") {
					return jsonResponse({
						MediaContainer: {
							offset: 0,
							size: 1,
							totalSize: 1,
							Account: [{ id: 1, name: canaries.username }],
						},
					});
				}
				if (url.pathname.startsWith("/library/sections/") && url.pathname.endsWith("/all")) {
					return new Response(canaries.responseBody, {
						status: 503,
						statusText: `${canaries.statusText} ${canaries.rawError} ${canaries.requestPath}`,
					});
				}
				throw new Error(`Unhandled Plex test URL: ${url.toString()}`);
			}),
		);
	});

	afterEach(() => {
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
	});

	it("contains nested provider diagnostics and emits one bounded source terminal event", async () => {
		const source = instance("plex-source");
		const destination = instance("plex-dest");
		const prisma = {
			serviceInstance: {
				findMany: vi.fn().mockResolvedValue([source]),
				findFirst: vi.fn(async ({ where }: { where: { id: string } }) =>
					where.id === source.id ? source : destination,
				),
			},
		};
		const log = createLogger();
		const destinationSpy = vi.spyOn(plexDestWriter, "applyLabels");

		const result = await executeLabelSyncRule({
			rule: {
				id: "rule-787",
				userId: "user-1",
				sourceService: "plex",
				sourceInstanceId: source.id,
				sourceTagName: "Private",
				destService: "plex",
				destInstanceId: destination.id,
				destTagName: "Private destination",
			},
			prisma: prisma as never,
			arrClientFactory: {} as never,
			encryptor: { decrypt: vi.fn().mockReturnValue(canaries.token) } as never,
			log,
		});

		expect(result).toMatchObject({
			status: "failed",
			totals: { labelsApplied: 0, failures: 1 },
		});
		expect(destinationSpy).not.toHaveBeenCalled();
		const serialized = allLogText(log, result);
		for (const value of Object.values(canaries)) {
			expect(serialized).not.toContain(String(value));
		}
		const terminalEvents = (log.warn as unknown as ReturnType<typeof vi.fn>).mock.calls.filter(
			([fields, message]) =>
				(fields as { operation?: string })?.operation === "source_read" &&
				message === "Plex label-sync source read failed",
		);
		expect(terminalEvents).toHaveLength(1);
		expect(terminalEvents[0]).toEqual([
			{
				operation: "source_read",
				state: "failed",
				stage: "source_authority",
				reasonCode: "source_evidence_changed",
			},
			"Plex label-sync source read failed",
		]);
	});
});
