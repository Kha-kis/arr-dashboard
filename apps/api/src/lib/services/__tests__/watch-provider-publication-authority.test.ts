import type { FastifyBaseLogger } from "fastify";
import { beforeEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import { refreshJellyfinCache } from "../../jellyfin/jellyfin-cache-refresher.js";
import type { JellyfinClient } from "../../jellyfin/jellyfin-client.js";
import { refreshJellyfinEpisodeCache } from "../../jellyfin/jellyfin-episode-cache-refresher.js";
import type { PrismaClient } from "../../prisma.js";
import { refreshTautulliCache } from "../../tautulli/tautulli-cache-refresher.js";
import type { TautulliClient } from "../../tautulli/tautulli-client.js";
import type { OwnedProviderPublicationSnapshot } from "../provider-identity-guard.js";

const authority = vi.hoisted(() => ({
	jellyfinClient: undefined as JellyfinClient | undefined,
	tautulliClient: undefined as TautulliClient | undefined,
	connections: [] as unknown[][],
	identities: [] as string[],
	events: [] as string[],
}));

vi.mock("../../jellyfin/jellyfin-client.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../jellyfin/jellyfin-client.js")>();
	return {
		...actual,
		JellyfinClient: class {
			constructor(...args: unknown[]) {
				authority.connections.push(args);
				if (!authority.jellyfinClient) throw new Error("Jellyfin client not configured");
				Object.assign(this, authority.jellyfinClient);
			}
		},
	};
});

vi.mock("../../tautulli/tautulli-client.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../tautulli/tautulli-client.js")>();
	return {
		...actual,
		TautulliClient: class {
			constructor(...args: unknown[]) {
				authority.connections.push(args);
				if (!authority.tautulliClient) throw new Error("Tautulli client not configured");
				Object.assign(this, authority.tautulliClient);
			}
		},
	};
});

vi.mock("../service-identity.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../service-identity.js")>();
	return {
		...actual,
		readProviderIdentity: vi.fn(async (instance: OwnedProviderPublicationSnapshot) => {
			authority.events.push("identity");
			return {
				service: instance.service,
				identityKind:
					instance.service === "TAUTULLI"
						? "tautulli-pms-identifier"
						: instance.service === "EMBY"
							? "emby-server-id"
							: "jellyfin-server-id",
				rawIdentity: authority.identities.shift() ?? instance.expectedIdentity,
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
const tautulliAttempt = {
	attemptedAt: new Date("2026-08-28T12:00:00.000Z"),
	resultMarker: "in_progress:test-publication",
};

function snapshot(
	service: "JELLYFIN" | "EMBY" | "TAUTULLI",
	overrides: Partial<OwnedProviderPublicationSnapshot> = {},
): OwnedProviderPublicationSnapshot {
	return {
		id: `${service.toLowerCase()}-1`,
		userId: "user-1",
		service,
		label: service,
		baseUrl: `https://${service.toLowerCase()}.invalid`,
		apiKey: "decrypted-token",
		httpAuthHeaders: { Authorization: "Basic proxy" },
		enabled: true,
		encryptedApiKey: "encrypted-token",
		encryptionIv: "token-iv",
		encryptedHttpAuthCredentials: "encrypted-proxy",
		httpAuthEncryptionIv: "proxy-iv",
		expectedIdentity: `${service.toLowerCase()}-server-a`,
		identityStatus: "VERIFIED",
		connectionGeneration: 4,
		identityGeneration: 9,
		...overrides,
	};
}

function jellyfinDataClient(): JellyfinClient {
	return {
		getUsers: vi.fn(async () => {
			authority.events.push("collect");
			return [{ id: "user-a", name: "Alice" }];
		}),
		getLibraries: vi
			.fn()
			.mockResolvedValue([{ id: "movies", name: "Movies", collectionType: "movies" }]),
		getLibraryItems: vi.fn().mockResolvedValue([
			{
				id: "movie-a",
				name: "Movie A",
				type: "Movie",
				tmdbId: 42,
				played: true,
				playCount: 1,
				lastPlayedDate: "2026-01-01T00:00:00.000Z",
				isFavorite: false,
			},
		]),
		getResumeItems: vi.fn().mockResolvedValue([]),
		getNextUp: vi.fn().mockResolvedValue([]),
	} as unknown as JellyfinClient;
}

function tautulliDataClient(): TautulliClient {
	return {
		getLibraries: vi.fn(async () => {
			authority.events.push("collect");
			return [{ section_id: "movies", section_type: "movie", section_name: "Movies" }];
		}),
		getHistory: vi.fn().mockResolvedValue({ data: [], recordsFiltered: 0, recordsTotal: 0 }),
		getMetadata: vi.fn(),
	} as unknown as TautulliClient;
}

function prisma(finalPredicateMatches = true) {
	const rows: unknown[] = [];
	const predicates: Array<Record<string, unknown>> = [];
	const tx = {
		libraryCleanupConfig: {
			upsert: vi.fn(async () => ({ id: "cleanup-user-1" })),
			findUnique: vi.fn(async () => ({ id: "cleanup-user-1", runClaimToken: null })),
		},
		serviceInstance: {
			findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
				authority.events.push("predicate");
				predicates.push(where);
				return finalPredicateMatches ? { id: "current" } : null;
			}),
			updateMany: vi.fn().mockResolvedValue({ count: 1 }),
		},
		jellyfinCache: {
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
		jellyfinEpisodeCache: {
			deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
			createMany: vi.fn(async ({ data }: { data: unknown[] }) => {
				rows.push(...data);
				return { count: data.length };
			}),
		},
		tautulliCache: {
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
		cacheRefreshStatus: {
			upsert: vi.fn(async () => {
				authority.events.push("status");
				return {};
			}),
			updateMany: vi.fn(async () => {
				authority.events.push("status");
				return { count: 1 };
			}),
		},
	};
	return {
		db: {
			jellyfinCache: {
				findMany: vi
					.fn()
					.mockResolvedValue([{ tmdbId: 42, jellyfinId: "show-a", title: "Show A" }]),
			},
			cacheRefreshStatus: {
				findUnique: vi.fn().mockResolvedValue({
					lastResult: "success",
					connectionGeneration: 4,
					identityGeneration: 9,
				}),
			},
			$transaction: vi.fn(async (callback: (transaction: typeof tx) => Promise<unknown>) =>
				callback(tx),
			),
		} as unknown as PrismaClient,
		tx,
		rows,
		predicates,
	};
}

describe("watch-provider publication authority", () => {
	beforeEach(() => {
		authority.jellyfinClient = jellyfinDataClient();
		authority.tautulliClient = tautulliDataClient();
		authority.connections = [];
		authority.identities = [];
		authority.events = [];
		vi.stubEnv("DATABASE_URL", "file:test.db");
	});

	it.each(["JELLYFIN", "EMBY"] as const)(
		"binds normal %s proxy collection and dual-generation publication to one snapshot",
		async (service) => {
			const instance = snapshot(service);
			const state = prisma();

			const result = await refreshJellyfinCache({ prisma: state.db, instance, log });

			expect(result).toMatchObject({ complete: true, upserted: 1 });
			expect(authority.connections).toEqual([
				[instance.baseUrl, instance.apiKey, log, undefined, instance.httpAuthHeaders],
			]);
			expect(authority.events).toEqual([
				"identity",
				"collect",
				"identity",
				"predicate",
				"delete",
				"create",
				"status",
			]);
			expect(state.rows[0]).toEqual(
				expect.objectContaining({ connectionGeneration: 4, identityGeneration: 9 }),
			);
			expect(state.tx.cacheRefreshStatus.upsert).toHaveBeenCalledWith(
				expect.objectContaining({
					create: expect.objectContaining({ connectionGeneration: 4, identityGeneration: 9 }),
					update: expect.objectContaining({ connectionGeneration: 4, identityGeneration: 9 }),
				}),
			);
		},
	);

	it.each(["JELLYFIN", "EMBY"] as const)(
		"rejects a stable wrong %s server before collection",
		async (service) => {
			authority.identities = ["wrong-server"];
			const state = prisma();

			const result = await refreshJellyfinCache({
				prisma: state.db,
				instance: snapshot(service, { httpAuthHeaders: {} }),
				log,
			});

			expect(result).toMatchObject({ complete: false, upserted: 0 });
			expect(authority.connections).toHaveLength(0);
			expect(state.tx.jellyfinCache.deleteMany).not.toHaveBeenCalled();
		},
	);

	it.each(["JELLYFIN", "EMBY"] as const)(
		"rejects a %s identity switch between reads",
		async (service) => {
			authority.identities = [
				`${service.toLowerCase()}-server-a`,
				`${service.toLowerCase()}-server-b`,
			];
			const state = prisma();

			const result = await refreshJellyfinCache({
				prisma: state.db,
				instance: snapshot(service, { httpAuthHeaders: {} }),
				log,
			});

			expect(result).toMatchObject({ complete: false, upserted: 0 });
			expect(authority.events).toEqual(["identity", "collect", "identity", "predicate"]);
			expect(state.tx.jellyfinCache.deleteMany).not.toHaveBeenCalled();
		},
	);

	it("fences a Tautulli identity-only replacement at the final predicate", async () => {
		const state = prisma(false);

		const result = await refreshTautulliCache({
			prisma: state.db,
			instance: snapshot("TAUTULLI"),
			log,
			attempt: tautulliAttempt,
		});

		expect(result).toMatchObject({ complete: false, superseded: true, upserted: 0 });
		expect(state.predicates[0]).toEqual(
			expect.objectContaining({ connectionGeneration: 4, identityGeneration: 9 }),
		);
		expect(state.tx.tautulliCache.deleteMany).not.toHaveBeenCalled();
	});

	it.each(["JELLYFIN", "EMBY"] as const)(
		"fences an in-flight %s refresh after an identity-only replacement",
		async (service) => {
			const state = prisma(false);

			const result = await refreshJellyfinCache({
				prisma: state.db,
				instance: snapshot(service, { httpAuthHeaders: {} }),
				log,
			});

			expect(result).toMatchObject({ complete: false, superseded: true, upserted: 0 });
			expect(state.predicates[0]).toEqual(
				expect.objectContaining({ connectionGeneration: 4, identityGeneration: 9 }),
			);
			expect(state.tx.jellyfinCache.deleteMany).not.toHaveBeenCalled();
		},
	);

	it("binds normal Tautulli proxy collection to the same snapshot", async () => {
		const instance = snapshot("TAUTULLI");
		const state = prisma();

		const result = await refreshTautulliCache({
			prisma: state.db,
			instance,
			log,
			attempt: tautulliAttempt,
		});

		expect(result).toMatchObject({ complete: true, upserted: 0 });
		expect(authority.connections).toEqual([
			[instance.baseUrl, instance.apiKey, log, undefined, instance.httpAuthHeaders],
		]);
		expect(state.tx.cacheRefreshStatus.updateMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({ connectionGeneration: 4, identityGeneration: 9 }),
			}),
		);
	});

	it("rejects disabled Tautulli publication before identity reads or collection", async () => {
		const state = prisma();

		const result = await refreshTautulliCache({
			prisma: state.db,
			instance: snapshot("TAUTULLI", { enabled: false }),
			log,
			attempt: tautulliAttempt,
		});

		expect(result).toMatchObject({ complete: false, upserted: 0 });
		expect(authority.events).toEqual([]);
		expect(authority.connections).toEqual([]);
	});

	it("rejects a Tautulli identity switch between reads", async () => {
		authority.identities = ["tautulli-server-a", "tautulli-server-b"];
		const state = prisma();

		const result = await refreshTautulliCache({
			prisma: state.db,
			instance: snapshot("TAUTULLI"),
			log,
			attempt: tautulliAttempt,
		});

		expect(result).toMatchObject({ complete: false, upserted: 0 });
		expect(authority.events).toEqual(["identity", "collect", "identity", "predicate"]);
		expect(state.tx.tautulliCache.deleteMany).not.toHaveBeenCalled();
	});

	it("does not send old-generation library IDs to Jellyfin episode collection", async () => {
		const state = prisma();
		(state.db.jellyfinCache.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
		authority.jellyfinClient = {
			getUsers: vi.fn().mockResolvedValue([{ id: "user-a", name: "Alice" }]),
			getEpisodes: vi.fn(),
		} as unknown as JellyfinClient;

		const result = await refreshJellyfinEpisodeCache({
			prisma: state.db,
			instance: snapshot("JELLYFIN", { httpAuthHeaders: {} }),
			log,
		});

		expect(result).toMatchObject({ complete: true, upserted: 0 });
		expect(authority.jellyfinClient.getEpisodes).not.toHaveBeenCalled();
		expect(state.db.jellyfinCache.findMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({ connectionGeneration: 4, identityGeneration: 9 }),
			}),
		);
	});

	it("fails closed when Tautulli resolves a different Plex machine identifier", async () => {
		authority.identities = ["other-plex-machine"];
		const state = prisma();

		const result = await refreshTautulliCache({
			prisma: state.db,
			instance: snapshot("TAUTULLI"),
			log,
			attempt: tautulliAttempt,
		});

		expect(result).toMatchObject({ complete: false, upserted: 0 });
		expect(authority.connections).toHaveLength(0);
		expect(state.tx.tautulliCache.deleteMany).not.toHaveBeenCalled();
	});

	it("does not expose caller-supplied clients in publishing APIs", () => {
		type JellyfinArgument = Parameters<typeof refreshJellyfinCache>[0];
		type TautulliArgument = Parameters<typeof refreshTautulliCache>[0];
		expectTypeOf<"client" extends keyof JellyfinArgument ? true : false>().toEqualTypeOf<false>();
		expectTypeOf<"client" extends keyof TautulliArgument ? true : false>().toEqualTypeOf<false>();
	});
});
