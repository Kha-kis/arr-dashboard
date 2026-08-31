import type { FastifyBaseLogger } from "fastify";
import pino from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Encryptor } from "../../../auth/encryption.js";
import type { ServiceInstance } from "../../../prisma.js";
import type { LabelSyncRuleInput } from "../../execute-rule.js";
import type { DestWriter, MatchCandidate } from "../../strategy-types.js";
import { embyDestWriter, jellyfinDestWriter } from "../jellyfin-writer.js";

const PRIVATE = {
	tag: "CANARY_PRIVATE_DEST_TAG_836",
	tmdbId: 123,
	providerItemId: "CANARY_PROVIDER_ITEM_836",
	libraryId: "CANARY_LIBRARY_ID_836",
	libraryTitle: "CANARY_LIBRARY_TITLE_836",
	mediaTitle: "CANARY_MEDIA_TITLE_836",
	baseUrl: "http://CANARY_PRIVATE_PROVIDER_836.invalid",
	username: "CANARY_PRIVATE_USER_836",
	token: "CANARY_PRIVATE_TOKEN_836",
	rawError: "CANARY_RAW_PROVIDER_ERROR_836",
	requestPath: "/Items/CANARY_PROVIDER_ITEM_836",
	responseBody: "CANARY_RAW_RESPONSE_BODY_836",
} as const;

const encryptor = new Encryptor("0123456789abcdef0123456789abcdef");
const encrypted = encryptor.encrypt(PRIVATE.token);

function makeRule(destService: "jellyfin" | "emby"): LabelSyncRuleInput {
	return {
		id: "CANARY_PRIVATE_RULE_ID_836",
		userId: "user-836",
		sourceService: "sonarr",
		sourceInstanceId: "source-836",
		sourceTagName: "CANARY_PRIVATE_SOURCE_TAG_836",
		destService,
		destInstanceId: "CANARY_PRIVATE_DEST_INSTANCE_836",
		destTagName: PRIVATE.tag,
	};
}

function makeInstance(service: "JELLYFIN" | "EMBY"): ServiceInstance {
	return {
		id: "CANARY_PRIVATE_DEST_INSTANCE_836",
		userId: "user-836",
		service,
		label: PRIVATE.libraryTitle,
		baseUrl: PRIVATE.baseUrl,
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

function candidate(tmdbId: number = PRIVATE.tmdbId): MatchCandidate {
	return { tmdbId, title: PRIVATE.mediaTitle, mediaType: "movie" };
}

function createPinoCapture(): { log: FastifyBaseLogger; serialized: () => string } {
	const lines: string[] = [];
	const log = pino(
		{ level: "trace", base: null, timestamp: false },
		{ write: (line: string) => lines.push(line) },
	) as unknown as FastifyBaseLogger;
	return { log, serialized: () => lines.join("") };
}

function expectNoPrivateCanary(value: string): void {
	for (const canary of Object.values(PRIVATE)) {
		expect(value).not.toContain(String(canary));
	}
}

async function runWriter(
	writer: DestWriter,
	service: "jellyfin" | "emby",
	prismaService: "JELLYFIN" | "EMBY",
	candidates: MatchCandidate[],
	log: FastifyBaseLogger,
) {
	const cacheRead = vi.fn().mockResolvedValue([
		{
			jellyfinId: PRIVATE.providerItemId,
			title: PRIVATE.mediaTitle,
			tmdbId: PRIVATE.tmdbId,
			mediaType: "movie",
			libraryId: PRIVATE.libraryId,
		},
	]);
	const result = await writer.applyLabels({
		rule: makeRule(service),
		destInstance: makeInstance(prismaService),
		candidates,
		prisma: {
			jellyfinCache: {
				findMany: cacheRead,
			},
		} as never,
		arrClientFactory: {} as never,
		encryptor,
		log,
	});
	return { result, cacheRead };
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe.each([
	["Jellyfin", "jellyfin", "JELLYFIN", jellyfinDestWriter],
	["Emby", "emby", "EMBY", embyDestWriter],
] as const)("%s destination containment", (_label, service, prismaService, writer) => {
	it("contains the stale-cache/reused-item mutation before any provider request", async () => {
		const requests: Array<{ path: string; method: string }> = [];
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
					Name: "CANARY_REUSED_MEDIA_TITLE_836",
					Type: "Movie",
					ParentId: "CANARY_DIFFERENT_LIBRARY_836",
					ProviderIds: { Tmdb: "999" },
					Tags: [],
				});
			}
			if (url.pathname === PRIVATE.requestPath && init?.method === "POST") {
				return new Response(null, { status: 204 });
			}
			throw new Error(`${PRIVATE.rawError}: ${url.pathname}: ${PRIVATE.responseBody}`);
		});
		const capture = createPinoCapture();

		const { result, cacheRead } = await runWriter(
			writer,
			service,
			prismaService,
			[candidate()],
			capture.log,
		);

		expect(requests).toEqual([]);
		expect(cacheRead).not.toHaveBeenCalled();
		expect(result).toEqual({ matchesFound: 0, labelsApplied: 0, failures: 1 });
		expectNoPrivateCanary(capture.serialized());
	});

	it("does not double-count mixed or duplicate blocked candidates", async () => {
		const fetchSpy = vi.fn(() => {
			throw new Error(PRIVATE.rawError);
		});
		vi.stubGlobal("fetch", fetchSpy);
		const capture = createPinoCapture();
		const candidates = [candidate(123), candidate(123), candidate(456)];

		const { result, cacheRead } = await runWriter(
			writer,
			service,
			prismaService,
			candidates,
			capture.log,
		);

		expect(fetchSpy).not.toHaveBeenCalled();
		expect(cacheRead).not.toHaveBeenCalled();
		expect(result).toEqual({ matchesFound: 0, labelsApplied: 0, failures: candidates.length });
		expectNoPrivateCanary(capture.serialized());
	});

	it("preserves the empty-candidate no-op without constructing a client", async () => {
		const fetchSpy = vi.fn(() => {
			throw new Error(PRIVATE.rawError);
		});
		vi.stubGlobal("fetch", fetchSpy);

		const { result, cacheRead } = await runWriter(
			writer,
			service,
			prismaService,
			[],
			createPinoCapture().log,
		);

		expect(fetchSpy).not.toHaveBeenCalled();
		expect(cacheRead).not.toHaveBeenCalled();
		expect(result).toEqual({ matchesFound: 0, labelsApplied: 0, failures: 0 });
	});
});
