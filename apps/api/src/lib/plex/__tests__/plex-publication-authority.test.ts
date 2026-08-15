import type { FastifyBaseLogger } from "fastify";
import { beforeEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import type { PrismaClient } from "../../prisma.js";
import type { OwnedProviderPublicationSnapshot } from "../../services/provider-identity-guard.js";
import { refreshPlexCache } from "../plex-cache-refresher.js";
import type { PlexClient } from "../plex-client.js";
import { refreshPlexEpisodeCache } from "../plex-episode-cache-refresher.js";

const authority = vi.hoisted(() => ({
	client: undefined as PlexClient | undefined,
	clientConnections: [] as unknown[][],
	identityReads: [] as OwnedProviderPublicationSnapshot[],
	identities: [] as string[],
	identityError: undefined as Error | undefined,
	events: [] as string[],
}));

vi.mock("../plex-client.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../plex-client.js")>();
	return {
		...actual,
		PlexClient: class {
			constructor(...args: unknown[]) {
				authority.clientConnections.push(args);
				if (!authority.client) throw new Error("Plex test client was not configured");
				Object.assign(this, authority.client);
			}
		},
	};
});

vi.mock("../../services/service-identity.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../services/service-identity.js")>();
	return {
		...actual,
		readProviderIdentity: vi.fn(async (instance: OwnedProviderPublicationSnapshot) => {
			authority.events.push("identity");
			authority.identityReads.push(instance);
			if (authority.identityError) throw authority.identityError;
			return {
				service: "PLEX",
				identityKind: "plex-machine-identifier",
				rawIdentity: authority.identities.shift() ?? "plex-a",
				confirmationDigest: "digest",
				fingerprint: "fingerprint",
			};
		}),
	};
});

const log = {
	warn: vi.fn(),
	info: vi.fn(),
	error: vi.fn(),
	debug: vi.fn(),
} as unknown as FastifyBaseLogger;

function ownedSnapshot(
	overrides: Partial<OwnedProviderPublicationSnapshot> = {},
): OwnedProviderPublicationSnapshot {
	return {
		id: "plex-1",
		userId: "user-1",
		service: "PLEX",
		label: "Primary Plex",
		baseUrl: "https://plex-a.invalid",
		apiKey: "decrypted-token-a",
		httpAuthHeaders: { Authorization: "Basic proxy-a" },
		enabled: true,
		encryptedApiKey: "encrypted-token-a",
		encryptionIv: "token-iv-a",
		encryptedHttpAuthCredentials: "encrypted-proxy-a",
		httpAuthEncryptionIv: "proxy-iv-a",
		expectedIdentity: "plex-a",
		identityStatus: "VERIFIED",
		connectionGeneration: 4,
		identityGeneration: 9,
		...overrides,
	};
}

function dataClient(itemCount = 1): PlexClient {
	return {
		getAccounts: vi.fn(async () => {
			authority.events.push("collect");
			return [{ id: 1, name: "Alice" }];
		}),
		getLibrarySections: vi
			.fn()
			.mockResolvedValue([{ key: "movies", title: "Movies", type: "movie" }]),
		getLibraryItems: vi.fn().mockResolvedValue(
			Array.from({ length: itemCount }, (_, index) => ({
				ratingKey: `movie-${index + 1}`,
				title: `Movie ${index + 1}`,
				type: "movie",
				Guid: [{ id: `tmdb://${index + 42}` }],
			})),
		),
		getHistory: vi.fn().mockResolvedValue([]),
		verifyHistorySnapshot: vi.fn().mockResolvedValue(undefined),
		getOnDeck: vi.fn().mockResolvedValue([]),
	} as unknown as PlexClient;
}

function prisma(finalPredicateMatches = true) {
	const rows: unknown[] = [];
	const tx = {
		serviceInstance: {
			findFirst: vi.fn(async () => {
				authority.events.push("predicate");
				return finalPredicateMatches ? { id: "plex-1" } : null;
			}),
			updateMany: vi.fn().mockResolvedValue({ count: 1 }),
		},
		plexCache: {
			deleteMany: vi.fn(async () => {
				authority.events.push("delete");
				return { count: 0 };
			}),
			createMany: vi.fn(async ({ data }: { data: unknown[] }) => {
				authority.events.push("create");
				rows.push(...data);
				return { count: data.length };
			}),
		},
		plexEpisodeCache: {
			deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
			createMany: vi.fn().mockResolvedValue({ count: 1 }),
		},
		cacheRefreshStatus: {
			upsert: vi.fn(async () => {
				authority.events.push("status");
				return {};
			}),
		},
	};
	const db = {
		$transaction: vi.fn(async (callback: (transaction: typeof tx) => Promise<unknown>) =>
			callback(tx),
		),
	} as unknown as PrismaClient;
	return { db, tx, rows };
}

describe("Plex publication authority", () => {
	beforeEach(() => {
		authority.client = dataClient();
		authority.clientConnections = [];
		authority.identityReads = [];
		authority.identities = [];
		authority.identityError = undefined;
		authority.events = [];
		vi.stubEnv("DATABASE_URL", "file:test.db");
	});

	it("publishes through a normal proxy from the guarded snapshot and tags rows and status", async () => {
		const instance = ownedSnapshot();
		const fixture = prisma();
		authority.client = dataClient(205);

		const result = await refreshPlexCache({ prisma: fixture.db, instance, log });

		expect(result).toMatchObject({ complete: true, errors: 0, upserted: 205 });
		expect(authority.clientConnections).toEqual([
			[instance.baseUrl, instance.apiKey, log, undefined, instance.httpAuthHeaders],
		]);
		expect(authority.identityReads).toEqual([instance, instance]);
		expect(authority.events).toEqual([
			"identity",
			"collect",
			"identity",
			"predicate",
			"delete",
			"create",
			"create",
			"create",
			"status",
		]);
		expect(fixture.rows).toHaveLength(205);
		expect(fixture.rows[0]).toEqual(
			expect.objectContaining({
				instanceId: "plex-1",
				connectionGeneration: 4,
				identityGeneration: 9,
			}),
		);
		expect(fixture.tx.plexCache.createMany).toHaveBeenCalledTimes(3);
		for (const [call] of fixture.tx.plexCache.createMany.mock.calls) {
			expect(call.data.length).toBeLessThanOrEqual(100);
		}
		expect(fixture.tx.cacheRefreshStatus.upsert).toHaveBeenCalledWith(
			expect.objectContaining({
				create: expect.objectContaining({ connectionGeneration: 4, identityGeneration: 9 }),
				update: expect.objectContaining({ connectionGeneration: 4, identityGeneration: 9 }),
			}),
		);
	});

	it("rejects a stable wrong server before data collection or publication", async () => {
		authority.identities = ["plex-b"];
		const fixture = prisma();

		const result = await refreshPlexCache({
			prisma: fixture.db,
			instance: ownedSnapshot(),
			log,
		});

		expect(result).toMatchObject({ complete: false, upserted: 0, errors: 1 });
		expect(authority.clientConnections).toHaveLength(0);
		expect(fixture.tx.plexCache.deleteMany).not.toHaveBeenCalled();
		expect(fixture.tx.cacheRefreshStatus.upsert).not.toHaveBeenCalled();
	});

	it("rejects an identity switch after collection without publishing", async () => {
		authority.identities = ["plex-a", "plex-b"];
		const fixture = prisma();

		const result = await refreshPlexCache({
			prisma: fixture.db,
			instance: ownedSnapshot(),
			log,
		});

		expect(result).toMatchObject({ complete: false, upserted: 0, errors: 1 });
		expect(authority.events).toEqual(["identity", "collect", "identity"]);
		expect(fixture.tx.plexCache.deleteMany).not.toHaveBeenCalled();
		expect(fixture.tx.cacheRefreshStatus.upsert).not.toHaveBeenCalled();
	});

	it("preserves enrolled identity state when the identity dependency is unavailable", async () => {
		authority.identityError = new Error(
			"connect ECONNREFUSED https://secret.invalid?token=plaintext",
		);
		const fixture = prisma();

		const result = await refreshPlexCache({
			prisma: fixture.db,
			instance: ownedSnapshot(),
			log,
		});

		expect(result).toMatchObject({ complete: false, errors: 1, upserted: 0 });
		expect(result.errorMessages.join(" ")).not.toMatch(/secret|plaintext|ECONNREFUSED/);
		expect(fixture.tx.serviceInstance.updateMany).not.toHaveBeenCalled();
		expect(fixture.tx.plexCache.deleteMany).not.toHaveBeenCalled();
		expect(fixture.tx.cacheRefreshStatus.upsert).not.toHaveBeenCalled();
	});

	it("rejects a concurrent service update at the final exact predicate", async () => {
		const fixture = prisma(false);

		const result = await refreshPlexCache({
			prisma: fixture.db,
			instance: ownedSnapshot(),
			log,
		});

		expect(result).toMatchObject({ complete: false, superseded: true, upserted: 0, errors: 0 });
		expect(authority.events).toEqual(["identity", "collect", "identity", "predicate"]);
		expect(fixture.tx.plexCache.deleteMany).not.toHaveBeenCalled();
		expect(fixture.tx.cacheRefreshStatus.upsert).not.toHaveBeenCalled();
	});

	it("fences an in-flight refresh superseded only by identityGeneration", async () => {
		const fixture = prisma(false);
		const instance = ownedSnapshot({ connectionGeneration: 4, identityGeneration: 8 });

		const result = await refreshPlexCache({ prisma: fixture.db, instance, log });

		expect(result).toMatchObject({ complete: false, superseded: true, upserted: 0, errors: 0 });
		expect(fixture.tx.serviceInstance.findFirst).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({ connectionGeneration: 4, identityGeneration: 8 }),
			}),
		);
		expect(fixture.tx.plexCache.deleteMany).not.toHaveBeenCalled();
	});

	it("publishes episode rows and status with the same two generations", async () => {
		const fixture = prisma();
		(fixture.db as never as { plexCache: { findMany: ReturnType<typeof vi.fn> } }).plexCache = {
			findMany: vi.fn().mockResolvedValue([{ tmdbId: 42, ratingKey: "show-1" }]),
		};
		authority.client = {
			getHistory: vi.fn().mockResolvedValue([
				{
					type: "episode",
					ratingKey: "episode-1",
					accountID: 1,
					viewedAt: 1_700_000_000,
				},
			]),
			getAccounts: vi.fn().mockResolvedValue([{ id: 1, name: "Alice" }]),
			getEpisodes: vi.fn().mockResolvedValue([
				{
					ratingKey: "episode-1",
					title: "Pilot",
					seasonNumber: 1,
					episodeNumber: 1,
					viewCount: 1,
				},
			]),
			verifyHistorySnapshot: vi.fn().mockResolvedValue(undefined),
		} as unknown as PlexClient;

		const result = await refreshPlexEpisodeCache({
			prisma: fixture.db,
			instance: ownedSnapshot(),
			log,
		});

		expect(result).toMatchObject({ complete: true, upserted: 1 });
		expect(fixture.tx.plexEpisodeCache.createMany).toHaveBeenCalledWith({
			data: [expect.objectContaining({ connectionGeneration: 4, identityGeneration: 9 })],
		});
		expect(fixture.tx.cacheRefreshStatus.upsert).toHaveBeenLastCalledWith(
			expect.objectContaining({
				create: expect.objectContaining({ connectionGeneration: 4, identityGeneration: 9 }),
				update: expect.objectContaining({ connectionGeneration: 4, identityGeneration: 9 }),
			}),
		);
	});

	it("does not expose a caller-supplied Plex client in the publication API", () => {
		type PublicationArgument = Parameters<typeof refreshPlexCache>[0];
		type HasClient = "client" extends keyof PublicationArgument ? true : false;
		expectTypeOf<HasClient>().toEqualTypeOf<false>();
	});
});
