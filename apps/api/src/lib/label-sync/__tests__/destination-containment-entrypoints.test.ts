import Fastify, { type FastifyBaseLogger, type FastifyInstance } from "fastify";
import pino from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerLabelSyncRoutes } from "../../../routes/label-sync.js";
import { Encryptor } from "../../auth/encryption.js";
import type { ServiceInstance } from "../../prisma.js";
import { LabelSyncScheduler } from "../label-sync-scheduler.js";
import { triggerLabelSyncForItem } from "../trigger-for-item.js";

const UNAVAILABLE_MESSAGE =
	"Jellyfin and Emby label destinations are temporarily unavailable because the provider cannot yet be re-authorized safely at execution time.";

const PRIVATE = {
	ruleId: "CANARY_RULE_ID_836",
	ruleName: "CANARY_RULE_NAME_836",
	sourceInstanceId: "CANARY_SOURCE_INSTANCE_836",
	destInstanceId: "CANARY_DEST_INSTANCE_836",
	sourceTag: "CANARY_PRIVATE_SOURCE_TAG_836",
	destTag: "CANARY_PRIVATE_DEST_TAG_836",
	tmdbId: 836123,
	providerItemId: "CANARY_PROVIDER_ITEM_ID_836",
	libraryId: "CANARY_LIBRARY_ID_836",
	libraryTitle: "CANARY_LIBRARY_TITLE_836",
	mediaTitle: "CANARY_MEDIA_TITLE_836",
	baseUrl: "http://CANARY_PROVIDER_HOST_836.invalid",
	username: "CANARY_PROVIDER_USER_836",
	token: "CANARY_PROVIDER_TOKEN_836",
	rawError: "CANARY_RAW_PROVIDER_ERROR_836",
	requestPath: "/Items/CANARY_PROVIDER_ITEM_ID_836",
	responseBody: "CANARY_RAW_PROVIDER_BODY_836",
} as const;

const encryptor = new Encryptor("0123456789abcdef0123456789abcdef");
const encrypted = encryptor.encrypt(PRIVATE.token);

type DestService = "jellyfin" | "emby";
type PrismaDestService = "JELLYFIN" | "EMBY";

function makeRule(destService: DestService) {
	return {
		id: PRIVATE.ruleId,
		userId: "user-836",
		name: PRIVATE.ruleName,
		enabled: true,
		sourceService: "sonarr",
		sourceInstanceId: PRIVATE.sourceInstanceId,
		sourceTagName: PRIVATE.sourceTag,
		destService,
		destInstanceId: PRIVATE.destInstanceId,
		destTagName: PRIVATE.destTag,
		lastRunAt: null,
		lastRunStatus: null,
		lastRunMessage: null,
		createdAt: new Date("2026-08-31T00:00:00.000Z"),
		updatedAt: new Date("2026-08-31T00:00:00.000Z"),
	};
}

function makeInstance(
	id: string,
	service: "SONARR" | PrismaDestService,
	baseUrl: string,
): ServiceInstance {
	return {
		id,
		userId: "user-836",
		service,
		label: service === "SONARR" ? "Synthetic Sonarr" : PRIVATE.libraryTitle,
		baseUrl,
		externalUrl: null,
		encryptedApiKey: encrypted.value,
		encryptionIv: encrypted.iv,
		enabled: true,
		isDefault: false,
		storageGroupId: null,
		createdAt: new Date("2026-08-31T00:00:00.000Z"),
		updatedAt: new Date("2026-08-31T00:00:00.000Z"),
	} as ServiceInstance;
}

function createPinoCapture(): { log: FastifyBaseLogger; serialized: () => string } {
	const lines: string[] = [];
	const log = pino(
		{ level: "trace", base: null, timestamp: false },
		{ write: (line: string) => lines.push(line) },
	) as unknown as FastifyBaseLogger;
	return { log, serialized: () => lines.join("") };
}

function expectNoSensitiveCanary(value: string): void {
	for (const canary of [
		PRIVATE.sourceTag,
		PRIVATE.destTag,
		PRIVATE.tmdbId,
		PRIVATE.providerItemId,
		PRIVATE.libraryId,
		PRIVATE.libraryTitle,
		PRIVATE.mediaTitle,
		PRIVATE.baseUrl,
		PRIVATE.username,
		PRIVATE.token,
		PRIVATE.rawError,
		PRIVATE.requestPath,
		PRIVATE.responseBody,
	]) {
		expect(value).not.toContain(String(canary));
	}
}

function installUnsafeProviderCapture(requests: Array<{ path: string; method: string }>): void {
	vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
		const url = new URL(
			typeof input === "string" ? input : input instanceof URL ? input : input.url,
		);
		requests.push({ path: url.pathname, method: init?.method ?? "GET" });
		if (url.pathname === "/Users") {
			return Response.json([{ Id: PRIVATE.username, Name: PRIVATE.username }]);
		}
		if (url.pathname === `/Users/${PRIVATE.username}/Items/${PRIVATE.providerItemId}`) {
			return Response.json({
				Id: PRIVATE.providerItemId,
				Name: PRIVATE.mediaTitle,
				Type: "Movie",
				ParentId: PRIVATE.libraryId,
				ProviderIds: { Tmdb: String(PRIVATE.tmdbId) },
				Tags: [],
			});
		}
		if (url.pathname === PRIVATE.requestPath && init?.method === "POST") {
			return new Response(null, { status: 204 });
		}
		throw new Error(`${PRIVATE.rawError}: ${url.pathname}: ${PRIVATE.responseBody}`);
	});
}

function makeArrClientFactory() {
	return {
		create: vi.fn(() => ({
			tag: { getAll: vi.fn().mockResolvedValue([{ id: 8, label: PRIVATE.sourceTag }]) },
			series: {
				getAll: vi.fn().mockResolvedValue([
					{
						tmdbId: PRIVATE.tmdbId,
						tags: [8],
						title: PRIVATE.mediaTitle,
					},
				]),
			},
		})),
	};
}

function makePrisma(destService: DestService, prismaDestService: PrismaDestService) {
	const rule = makeRule(destService);
	const sourceInstance = makeInstance(
		PRIVATE.sourceInstanceId,
		"SONARR",
		"http://synthetic-sonarr.invalid",
	);
	const destInstance = makeInstance(PRIVATE.destInstanceId, prismaDestService, PRIVATE.baseUrl);
	const update = vi.fn().mockImplementation(({ data }) => {
		const persistedData = Object.fromEntries(
			Object.entries(data).filter(([, value]) => value !== undefined),
		);
		return Promise.resolve({
			...rule,
			...persistedData,
			updatedAt: new Date("2026-08-31T00:01:00.000Z"),
		});
	});
	const create = vi.fn().mockImplementation(({ data }) =>
		Promise.resolve({
			...rule,
			...data,
			id: "created-rule-836",
			lastRunAt: null,
			lastRunStatus: null,
			lastRunMessage: null,
		}),
	);
	return {
		serviceInstance: {
			findMany: vi.fn().mockResolvedValue([sourceInstance]),
			findFirst: vi
				.fn()
				.mockImplementation(({ where }) =>
					Promise.resolve(where.id === PRIVATE.sourceInstanceId ? sourceInstance : destInstance),
				),
		},
		labelSyncRule: {
			findMany: vi.fn().mockResolvedValue([rule]),
			findFirst: vi.fn().mockResolvedValue(rule),
			create,
			update,
		},
		libraryCache: { findFirst: vi.fn().mockResolvedValue(null) },
		jellyfinCache: {
			findMany: vi.fn().mockResolvedValue([
				{
					jellyfinId: PRIVATE.providerItemId,
					title: PRIVATE.mediaTitle,
					tmdbId: PRIVATE.tmdbId,
					mediaType: "movie",
					libraryId: PRIVATE.libraryId,
				},
			]),
		},
	};
}

async function buildManualApp(
	prisma: ReturnType<typeof makePrisma>,
	arrClientFactory: ReturnType<typeof makeArrClientFactory>,
	log: FastifyBaseLogger,
): Promise<FastifyInstance> {
	const app = Fastify({ loggerInstance: log });
	app.decorate("prisma", prisma as never);
	app.decorate("arrClientFactory", arrClientFactory as never);
	app.decorate("encryptor", encryptor as never);
	app.decorateRequest("currentUser", null);
	app.addHook("preHandler", async (request) => {
		(request as { currentUser: { id: string; username: string } }).currentUser = {
			id: "user-836",
			username: "admin",
		};
	});
	await app.register(registerLabelSyncRoutes, { prefix: "/api/label-sync" });
	await app.ready();
	return app;
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe.each([
	["Jellyfin", "jellyfin", "JELLYFIN"],
	["Emby", "emby", "EMBY"],
] as const)("%s destination entrypoints", (_label, destService, prismaDestService) => {
	it("keeps existing rules visible and editable without provider I/O or destination rewrites", async () => {
		const requests: Array<{ path: string; method: string }> = [];
		installUnsafeProviderCapture(requests);
		const prisma = makePrisma(destService, prismaDestService);
		const app = await buildManualApp(prisma, makeArrClientFactory(), createPinoCapture().log);

		try {
			const listed = await app.inject({ method: "GET", url: "/api/label-sync/rules" });
			const updated = await app.inject({
				method: "PATCH",
				url: `/api/label-sync/rules/${PRIVATE.ruleId}`,
				payload: { name: "Updated contained rule" },
			});
			const listedBody = JSON.parse(listed.payload) as {
				rules: Array<{ id: string; destService: string }>;
			};
			const updatedBody = JSON.parse(updated.payload) as {
				rule: { name: string; destService: string; destInstanceId: string };
			};

			expect(listed.statusCode).toBe(200);
			expect(listedBody.rules).toEqual([
				expect.objectContaining({ id: PRIVATE.ruleId, destService }),
			]);
			expect(updated.statusCode).toBe(200);
			expect(updatedBody.rule).toEqual(
				expect.objectContaining({
					name: "Updated contained rule",
					destService,
					destInstanceId: PRIVATE.destInstanceId,
				}),
			);
			expect(prisma.labelSyncRule.update).toHaveBeenCalledWith({
				where: { id: PRIVATE.ruleId },
				data: expect.objectContaining({
					name: "Updated contained rule",
					destService: undefined,
					destInstanceId: undefined,
					destTagName: undefined,
				}),
			});
			expect(requests).toEqual([]);
		} finally {
			await app.close();
		}
	});

	it("keeps new rule storage backward compatible while execution remains authoritative", async () => {
		const requests: Array<{ path: string; method: string }> = [];
		installUnsafeProviderCapture(requests);
		const prisma = makePrisma(destService, prismaDestService);
		const app = await buildManualApp(prisma, makeArrClientFactory(), createPinoCapture().log);

		try {
			const response = await app.inject({
				method: "POST",
				url: "/api/label-sync/rules",
				payload: {
					name: "Stored contained destination",
					sourceService: "sonarr",
					sourceInstanceId: PRIVATE.sourceInstanceId,
					sourceTagName: PRIVATE.sourceTag,
					destService,
					destInstanceId: PRIVATE.destInstanceId,
					destTagName: PRIVATE.destTag,
				},
			});

			expect(response.statusCode).toBe(201);
			expect(prisma.labelSyncRule.create).toHaveBeenCalledWith({
				data: expect.objectContaining({ destService, destInstanceId: PRIVATE.destInstanceId }),
			});
			expect(requests).toEqual([]);
		} finally {
			await app.close();
		}
	});

	it("manual execution persists and returns a bounded failed result before provider I/O", async () => {
		const requests: Array<{ path: string; method: string }> = [];
		installUnsafeProviderCapture(requests);
		const capture = createPinoCapture();
		const prisma = makePrisma(destService, prismaDestService);
		const app = await buildManualApp(prisma, makeArrClientFactory(), capture.log);

		try {
			const response = await app.inject({
				method: "POST",
				url: `/api/label-sync/rules/${PRIVATE.ruleId}/run`,
			});
			const body = JSON.parse(response.payload) as {
				rule: { lastRunStatus: string; lastRunMessage: string };
			};

			expect(response.statusCode).toBe(200);
			expect(requests).toEqual([]);
			expect(body.rule.lastRunStatus).toBe("failed");
			expect(body.rule.lastRunMessage).toBe(UNAVAILABLE_MESSAGE);
			expect(prisma.labelSyncRule.update).toHaveBeenCalledWith({
				where: { id: PRIVATE.ruleId },
				data: {
					lastRunAt: expect.any(Date),
					lastRunStatus: "failed",
					lastRunMessage: UNAVAILABLE_MESSAGE,
				},
			});
			expectNoSensitiveCanary(body.rule.lastRunMessage);
			expectNoSensitiveCanary(capture.serialized());
		} finally {
			await app.close();
		}
	});

	it("scheduled execution records failure and never retries a provider mutation", async () => {
		const requests: Array<{ path: string; method: string }> = [];
		installUnsafeProviderCapture(requests);
		const capture = createPinoCapture();
		const prisma = makePrisma(destService, prismaDestService);
		const scheduler = new LabelSyncScheduler(
			prisma as never,
			makeArrClientFactory() as never,
			encryptor,
			capture.log,
		);

		await (scheduler as unknown as { tick(): Promise<void> }).tick();
		await (scheduler as unknown as { tick(): Promise<void> }).tick();

		expect(requests).toEqual([]);
		expect(prisma.labelSyncRule.update).toHaveBeenCalledTimes(2);
		for (const call of prisma.labelSyncRule.update.mock.calls) {
			expect(call[0]?.data).toEqual({
				lastRunAt: expect.any(Date),
				lastRunStatus: "failed",
				lastRunMessage: UNAVAILABLE_MESSAGE,
			});
		}
		expectNoSensitiveCanary(capture.serialized());
	});

	it("event-triggered execution is acknowledged before TMDb resolution or provider I/O", async () => {
		const requests: Array<{ path: string; method: string }> = [];
		installUnsafeProviderCapture(requests);
		const capture = createPinoCapture();
		const prisma = makePrisma(destService, prismaDestService);

		const result = await triggerLabelSyncForItem({
			userId: "user-836",
			sourceService: "SONARR",
			sourceInstanceId: PRIVATE.sourceInstanceId,
			arrItemId: 836,
			itemType: "series",
			tagName: PRIVATE.sourceTag,
			prisma: prisma as never,
			arrClientFactory: makeArrClientFactory() as never,
			encryptor,
			log: capture.log,
		});

		expect(requests).toEqual([]);
		expect(prisma.libraryCache.findFirst).not.toHaveBeenCalled();
		expect(result.rulesFired).toBe(1);
		expect(result.totals).toEqual({ labelsApplied: 0, failures: 0 });
		expect(result.results[0]?.outcome).toEqual({
			status: "failed",
			message: UNAVAILABLE_MESSAGE,
			totals: {
				sourceInstancesScanned: 0,
				taggedItemsFound: 0,
				destMatchesFound: 0,
				labelsApplied: 0,
				failures: 0,
			},
		});
		expectNoSensitiveCanary(result.results[0]?.outcome.message ?? "");
		expectNoSensitiveCanary(capture.serialized());
	});
});
