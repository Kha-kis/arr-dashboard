import type { FastifyBaseLogger } from "fastify";
import { beforeEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import type { Encryptor } from "../../auth/encryption.js";
import {
	type JellyfinCacheRefreshResult,
	refreshJellyfinCache,
} from "../../jellyfin/jellyfin-cache-refresher.js";
import type { JellyfinClient } from "../../jellyfin/jellyfin-client.js";
import { refreshJellyfinEpisodeCache } from "../../jellyfin/jellyfin-episode-cache-refresher.js";
import {
	decodeJellyfinLibraryGenerationMetadata,
	fingerprintJellyfinLibraryRows,
	type JellyfinLibraryRowFingerprintInput,
} from "../../jellyfin/jellyfin-generation-metadata.js";
import type { PrismaClient, ServiceInstance } from "../../prisma.js";
import { refreshOwnedTautulliCache } from "../../tautulli/tautulli-cache-refresher.js";
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

function storedInstance(
	service: "JELLYFIN" | "EMBY" | "TAUTULLI",
	overrides: Partial<OwnedProviderPublicationSnapshot> = {},
): ServiceInstance {
	const stored = {
		...snapshot(service, {
			encryptedHttpAuthCredentials: null,
			httpAuthEncryptionIv: null,
			...overrides,
		}),
	} as Record<string, unknown>;
	delete stored.apiKey;
	delete stored.httpAuthHeaders;
	return stored as unknown as ServiceInstance;
}

async function refreshOwnedTautulli(
	state: ReturnType<typeof prisma>,
	instanceOverrides: Partial<OwnedProviderPublicationSnapshot> = {},
) {
	return await refreshOwnedTautulliCache({
		prisma: state.db,
		encryptor: decryptor(),
		instance: storedInstance("TAUTULLI", instanceOverrides),
		log,
	});
}

function decryptor(events: string[] = []): Pick<Encryptor, "decrypt"> {
	return {
		decrypt: vi.fn(() => {
			events.push("decrypt");
			return "decrypted-token";
		}),
	};
}

async function refreshOwnedJellyfinCache(context: {
	prisma: PrismaClient;
	encryptor: Pick<Encryptor, "decrypt">;
	instance: ServiceInstance;
	log: FastifyBaseLogger;
}): Promise<JellyfinCacheRefreshResult> {
	const module = await import("../../jellyfin/jellyfin-cache-refresher.js");
	const ownedRefresh = (
		module as typeof module & {
			refreshOwnedJellyfinCache: (input: typeof context) => Promise<JellyfinCacheRefreshResult>;
		}
	).refreshOwnedJellyfinCache;
	// Keep the absent production entrypoint an explicit RED boundary instead of
	// allowing a TypeError to obscure the begin-before-decrypt contract.
	expect(ownedRefresh).toEqual(expect.any(Function));
	return await ownedRefresh(context);
}

function jellyfinDataClient(): JellyfinClient {
	const items = [
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
	];
	return {
		getUsers: vi.fn(async () => {
			authority.events.push("collect");
			return [{ id: "user-a", name: "Alice" }];
		}),
		getLibraries: vi
			.fn()
			.mockResolvedValue([{ id: "movies", name: "Movies", collectionType: "movies" }]),
		getLibraryItems: vi.fn(() => {
			throw new Error("legacy Jellyfin item seam must not be used");
		}),
		getLibraryItemsWithCoverage: vi.fn().mockResolvedValue({
			items,
			expectedRawCount: items.length,
			pagesAttempted: 1,
			pagesCompleted: 1,
			rawObserved: items.length,
			reason: null,
		}),
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

function prisma(finalPredicateMatches = true, publicationClaimMatches = true) {
	const rows: unknown[] = [];
	const predicates: Array<Record<string, unknown>> = [];
	let predicateMatches = finalPredicateMatches;
	let claimMatches = publicationClaimMatches;
	let currentConnectionGeneration = 4;
	let currentIdentityGeneration = 9;
	let attemptedAt: Date | undefined;
	const status: Record<string, unknown> = {
		id: "status-1",
		lastRefreshedAt: new Date("2026-09-01T10:00:00.000Z"),
		lastResult: "success",
		lastAttemptAt: new Date("2026-09-01T10:00:00.000Z"),
		lastAttemptResult: "success",
		itemCount: 1,
		connectionGeneration: 4,
		identityGeneration: 9,
	};
	const tx = {
		libraryCleanupConfig: {
			upsert: vi.fn(async () => ({ id: "cleanup-user-1" })),
			findUnique: vi.fn(async () => ({ id: "cleanup-user-1", runClaimToken: null })),
		},
		serviceInstance: {
			findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
				authority.events.push("predicate");
				predicates.push(where);
				return predicateMatches &&
					where.connectionGeneration === currentConnectionGeneration &&
					where.identityGeneration === currentIdentityGeneration
					? { id: "current" }
					: null;
			}),
			updateMany: vi.fn().mockResolvedValue({ count: 1 }),
		},
		jellyfinCache: {
			deleteMany: vi.fn(async () => {
				authority.events.push("delete");
				rows.splice(0, rows.length);
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
				rows.splice(0, rows.length);
				return { count: 0 };
			}),
			createMany: vi.fn(async ({ data }: { data: unknown[] }) => {
				authority.events.push("create");
				rows.push(...data);
				return { count: data.length };
			}),
		},
		cacheRefreshStatus: {
			findUnique: vi.fn(async () => structuredClone(status)),
			upsert: vi.fn(async (input?: unknown) => {
				const payload = input as
					| { create?: Record<string, unknown>; update?: Record<string, unknown> }
					| undefined;
				const data = payload?.update ?? payload?.create ?? {};
				const marker = data.lastAttemptResult;
				authority.events.push(
					typeof marker === "string" && marker.startsWith("in_progress:") ? "attempt" : "status",
				);
				if (typeof marker === "string" && marker.startsWith("in_progress:")) {
					attemptedAt = data.lastAttemptAt as Date | undefined;
				}
				Object.assign(status, data);
				return {};
			}),
			updateMany: vi.fn(async (input?: unknown) => {
				const data =
					(input as { data?: Record<string, unknown> } | undefined)?.data ??
					({} as Record<string, unknown>);
				const marker = data.lastAttemptResult;
				const beginsAttempt = typeof marker === "string" && marker.startsWith("in_progress:");
				authority.events.push(
					beginsAttempt ? "attempt" : marker === "error" ? "failure" : "status",
				);
				if (beginsAttempt) attemptedAt = data.lastAttemptAt as Date | undefined;
				if (claimMatches) Object.assign(status, data);
				return { count: claimMatches ? 1 : 0 };
			}),
		},
	};
	const db = {
		jellyfinCache: {
			findMany: vi.fn().mockResolvedValue([{ tmdbId: 42, jellyfinId: "show-a", title: "Show A" }]),
		},
		cacheRefreshStatus: {
			findUnique: vi.fn(async () => structuredClone(status)),
		},
		$transaction: vi.fn(async (callback: (transaction: typeof tx) => Promise<unknown>) => {
			const before = structuredClone({ rows, status });
			try {
				return await callback(tx);
			} catch (error) {
				rows.splice(0, rows.length, ...before.rows);
				for (const key of Object.keys(status)) delete status[key];
				Object.assign(status, before.status);
				throw error;
			}
		}),
	} as unknown as PrismaClient;
	return {
		db,
		tx,
		rows,
		status,
		predicates,
		getAttemptedAt: () => attemptedAt,
		setClaimMatches: (value: boolean) => {
			claimMatches = value;
		},
		setPredicateMatches: (value: boolean) => {
			predicateMatches = value;
		},
		setCurrentGenerations: (value: {
			connectionGeneration?: number;
			identityGeneration?: number;
		}) => {
			currentConnectionGeneration = value.connectionGeneration ?? currentConnectionGeneration;
			currentIdentityGeneration = value.identityGeneration ?? currentIdentityGeneration;
		},
	};
}

describe("watch-provider publication authority", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		authority.jellyfinClient = jellyfinDataClient();
		authority.tautulliClient = tautulliDataClient();
		authority.connections = [];
		authority.identities = [];
		authority.events = [];
		vi.stubEnv("DATABASE_URL", "file:test.db");
	});

	it.each(["JELLYFIN", "EMBY"] as const)(
		"claims a %s attempt before credential decryption",
		async (service) => {
			const state = prisma();
			const encryptor: Pick<Encryptor, "decrypt"> = {
				decrypt: vi.fn(() => {
					authority.events.push("decrypt");
					return "decrypted-token";
				}),
			};

			await refreshOwnedJellyfinCache({
				prisma: state.db,
				encryptor,
				instance: storedInstance(service),
				log,
			});

			expect(authority.events.indexOf("attempt")).toBeGreaterThanOrEqual(0);
			expect(authority.events.indexOf("attempt")).toBeLessThan(authority.events.indexOf("decrypt"));
			expect(state.getAttemptedAt()).toBeInstanceOf(Date);
		},
	);

	it.each(["JELLYFIN", "EMBY"] as const)(
		"publishes a strict %s generation with one success CAS and canonical evidence",
		async (service) => {
			const events: string[] = [];
			const state = prisma();
			const encryptor: Pick<Encryptor, "decrypt"> = {
				decrypt: vi.fn(({ value }: { value: string }) => {
					if (value === "api-cipher") {
						authority.events.push("decrypt-api");
						events.push("decrypt-api");
						return "decrypted-token";
					}
					authority.events.push("decrypt-http");
					events.push("decrypt-http");
					return JSON.stringify({ v: 1, username: "generic-user", password: "generic-pass" });
				}),
			};

			const result = await refreshOwnedJellyfinCache({
				prisma: state.db,
				encryptor,
				instance: storedInstance(service, {
					encryptedApiKey: "api-cipher",
					encryptionIv: "api-iv",
					encryptedHttpAuthCredentials: "http-cipher",
					httpAuthEncryptionIv: "http-iv",
				}),
				log,
			});

			expect(result).toMatchObject({ complete: true, upserted: 1, errors: 0 });
			expect(authority.events.indexOf("attempt")).toBeLessThan(
				authority.events.indexOf("decrypt-api"),
			);
			expect(authority.events.indexOf("decrypt-api")).toBeLessThan(
				authority.events.indexOf("decrypt-http"),
			);
			expect(events).toEqual(["decrypt-api", "decrypt-http"]);
			expect(state.tx.cacheRefreshStatus.upsert).not.toHaveBeenCalled();
			expect(state.tx.cacheRefreshStatus.updateMany).toHaveBeenCalledTimes(2);

			const successInput = state.tx.cacheRefreshStatus.updateMany.mock.calls.find(
				([input]) =>
					(input as { data?: { lastAttemptResult?: string } }).data?.lastAttemptResult ===
					"success",
			)?.[0] as {
				where: Record<string, unknown>;
				data: Record<string, unknown>;
			};
			expect(successInput.data.lastAttemptResult).toBe("success");
			expect(successInput.data.generationId).toEqual(
				expect.stringMatching(
					/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
				),
			);
			expect(typeof successInput.data.generationMetadata).toBe("string");
			const decoded = decodeJellyfinLibraryGenerationMetadata(successInput.data.generationMetadata);
			expect(decoded.ok).toBe(true);
			if (!decoded.ok) return;
			const metadata = decoded.metadata;
			const provider = service === "EMBY" ? "emby" : "jellyfin";
			expect(metadata.provider).toBe(provider);
			expect(metadata.itemCount).toBe(state.rows.length);
			expect(metadata.connectionGeneration).toBe(4);
			expect(metadata.identityGeneration).toBe(9);
			expect(metadata.coverageReceipt.provider).toBe(provider);
			expect(metadata.coverageReceipt.publishedCanonicalEntities).toBe(state.rows.length);
			expect(metadata.coverageReceipt.attemptStartedAt).toBe(
				(state.getAttemptedAt() as Date).toISOString(),
			);
			expect(metadata.contentFingerprint).toBe(
				fingerprintJellyfinLibraryRows(state.rows as JellyfinLibraryRowFingerprintInput[]),
			);
		},
	);

	it.each(["JELLYFIN", "EMBY"] as const)(
		"publishes safe %s rows with positive-only metadata when semantic coverage is partial",
		async (service) => {
			const state = prisma();
			const valid = {
				id: "movie-a",
				name: "Movie A",
				type: "Movie",
				tmdbId: 42,
				played: true,
				playCount: 1,
				lastPlayedDate: "2026-01-01T00:00:00.000Z",
				isFavorite: false,
			};
			authority.jellyfinClient = {
				...jellyfinDataClient(),
				getLibraryItemsWithCoverage: vi.fn().mockResolvedValue({
					items: [valid, { ...valid, id: "playlist-a", type: "Playlist", tmdbId: undefined }],
					expectedRawCount: 2,
					pagesAttempted: 1,
					pagesCompleted: 1,
					rawObserved: 2,
					reason: null,
				}),
			} as unknown as JellyfinClient;

			const result = await refreshOwnedJellyfinCache({
				prisma: state.db,
				encryptor: decryptor(),
				instance: storedInstance(service),
				log,
			});

			expect(result).toMatchObject({ complete: false, upserted: 1, errors: 0 });
			expect(state.rows).toHaveLength(1);
			expect(state.tx.cacheRefreshStatus.updateMany).toHaveBeenCalledTimes(2);
			const successInput = state.tx.cacheRefreshStatus.updateMany.mock.calls.find(
				([input]) =>
					(input as { data?: { lastAttemptResult?: string } }).data?.lastAttemptResult ===
					"success",
			)?.[0] as { data: Record<string, unknown> } | undefined;
			expect(successInput?.data.lastAttemptResult).toBe("success");
			const metadata = decodeJellyfinLibraryGenerationMetadata(
				successInput?.data.generationMetadata,
			);
			expect(metadata).toMatchObject({ ok: true });
			if (!metadata.ok) return;
			expect(metadata.metadata).toMatchObject({
				provider: service === "EMBY" ? "emby" : "jellyfin",
				publicationLevel: "positive-only",
				completeness: "partial",
				itemCount: 1,
				coverageReceipt: {
					evidence: "positive-only",
					publishedCanonicalEntities: 1,
				},
			});
		},
	);

	it.each(["JELLYFIN", "EMBY"] as const)(
		"retains the last good %s generation after a credential failure without leaking details",
		async (service) => {
			const state = prisma();
			const priorRows = [
				{ jellyfinId: "prior-row", connectionGeneration: 4, identityGeneration: 9 },
			];
			state.rows.push(...priorRows);
			Object.assign(state.status, {
				generationId: "prior-generation",
				generationMetadata: "prior-metadata",
			});
			const priorRefreshedAt = state.status.lastRefreshedAt;
			const secret = "credential-sentinel-must-not-escape";
			const events: string[] = [];
			const encryptor: Pick<Encryptor, "decrypt"> = {
				decrypt: vi.fn(() => {
					authority.events.push("decrypt-api");
					events.push("decrypt-api");
					throw new Error(secret);
				}),
			};

			const result = await refreshOwnedJellyfinCache({
				prisma: state.db,
				encryptor,
				instance: storedInstance(service),
				log,
			});

			expect(authority.events.indexOf("attempt")).toBeLessThan(
				authority.events.indexOf("decrypt-api"),
			);
			expect(events).toEqual(["decrypt-api"]);
			expect(result).toEqual({
				upserted: 0,
				errors: 1,
				errorMessages: ["provider-unavailable"],
				complete: false,
			});
			expect(JSON.stringify(result)).not.toContain(secret);
			const logCalls = log as unknown as {
				warn: { mock: { calls: unknown[][] } };
				error: { mock: { calls: unknown[][] } };
			};
			expect(JSON.stringify(logCalls.warn.mock.calls)).not.toContain(secret);
			expect(JSON.stringify(logCalls.error.mock.calls)).not.toContain(secret);
			expect(state.rows).toEqual(priorRows);
			expect(state.status.lastRefreshedAt).toBe(priorRefreshedAt);
			expect(state.status.lastResult).toBe("success");
			expect(state.status.generationId).toBe("prior-generation");
			expect(state.status.generationMetadata).toBe("prior-metadata");
			const failureInput = state.tx.cacheRefreshStatus.updateMany.mock.calls.find(
				([input]) =>
					(input as { data?: { lastAttemptResult?: string } }).data?.lastAttemptResult === "error",
			)?.[0] as {
				where: Record<string, unknown>;
				data: Record<string, unknown>;
			};
			expect(failureInput.where.lastAttemptAt).toBe(state.getAttemptedAt());
			expect(failureInput.data.lastAttemptErrorMessage).toBe("provider-unavailable");
		},
	);

	it.each(["JELLYFIN", "EMBY"] as const)(
		"rolls back rows and success status for a superseded late %s attempt",
		async (service) => {
			const state = prisma();
			const priorRows = [
				{ jellyfinId: "prior-row", connectionGeneration: 4, identityGeneration: 9 },
			];
			state.rows.push(...priorRows);
			const client = jellyfinDataClient();
			client.getUsers = vi.fn(async () => {
				authority.events.push("collect");
				state.status.lastAttemptAt = new Date("2026-09-02T11:01:00.000Z");
				state.status.lastAttemptResult = "in_progress:00000000-0000-4000-8000-000000000002";
				state.setClaimMatches(false);
				return [{ id: "user-a", name: "Alice" }];
			});
			authority.jellyfinClient = client;

			const result = await refreshOwnedJellyfinCache({
				prisma: state.db,
				encryptor: decryptor(),
				instance: storedInstance(service),
				log,
			});

			expect(result).toMatchObject({ complete: false, superseded: true, upserted: 0 });
			expect(state.tx.cacheRefreshStatus.findUnique).toHaveBeenCalled();
			expect(state.tx.jellyfinCache.deleteMany).toHaveBeenCalledOnce();
			expect(state.tx.jellyfinCache.createMany).toHaveBeenCalledOnce();
			expect(state.rows).toEqual(priorRows);
			expect(state.status.lastAttemptResult).toBe(
				"in_progress:00000000-0000-4000-8000-000000000002",
			);
			const successCall = state.tx.cacheRefreshStatus.updateMany.mock.calls.find(
				([input]) =>
					(input as { data?: Record<string, unknown> } | undefined)?.data?.lastAttemptResult ===
					"success",
			)?.[0];
			expect(successCall).toMatchObject({
				where: {
					instanceId: `${service.toLowerCase()}-1`,
					cacheType: "jellyfin",
					lastAttemptResult: expect.stringMatching(/^in_progress:/),
					connectionGeneration: 4,
					identityGeneration: 9,
				},
				data: expect.objectContaining({ lastAttemptResult: "success" }),
			});
		},
	);

	it.each(["JELLYFIN", "EMBY"] as const)(
		"preserves the previous %s publication while recording a failed latest attempt",
		async (service) => {
			const state = prisma();
			const priorRefreshedAt = state.status.lastRefreshedAt as Date;
			const priorRows = [
				{ jellyfinId: "prior-row", connectionGeneration: 4, identityGeneration: 9 },
			];
			state.rows.push(...priorRows);
			authority.jellyfinClient = {
				...jellyfinDataClient(),
				getLibraryItemsWithCoverage: vi.fn().mockRejectedValue(new Error("provider unavailable")),
			} as unknown as JellyfinClient;

			const result = await refreshOwnedJellyfinCache({
				prisma: state.db,
				encryptor: decryptor(),
				instance: storedInstance(service),
				log,
			});

			expect(result).toMatchObject({ complete: false, upserted: 0 });
			expect(state.rows).toEqual(priorRows);
			expect(state.tx.jellyfinCache.deleteMany).not.toHaveBeenCalled();
			const failureCall = state.tx.cacheRefreshStatus.updateMany.mock.calls.find(
				([input]) =>
					(input as { data?: Record<string, unknown> } | undefined)?.data?.lastAttemptResult ===
					"error",
			)?.[0];
			expect(failureCall).toMatchObject({
				where: {
					instanceId: `${service.toLowerCase()}-1`,
					cacheType: "jellyfin",
					lastAttemptAt: state.getAttemptedAt(),
					lastAttemptResult: expect.stringMatching(/^in_progress:/),
					connectionGeneration: 4,
					identityGeneration: 9,
				},
				data: {
					lastAttemptResult: "error",
					lastAttemptErrorMessage: "provider-unavailable",
				},
			});
			expect(failureCall).not.toMatchObject({
				data: expect.objectContaining({ lastRefreshedAt: expect.anything() }),
			});
			expect(state.status.lastRefreshedAt).toEqual(priorRefreshedAt);
			expect(state.status.lastResult).toBe("success");
			expect(state.status.lastAttemptResult).toBe("error");
		},
	);

	it.each([
		["JELLYFIN", "identity", { identityGeneration: 10 }],
		["JELLYFIN", "connection", { connectionGeneration: 5 }],
		["EMBY", "identity", { identityGeneration: 10 }],
		["EMBY", "connection", { connectionGeneration: 5 }],
	] as const)(
		"blocks %s %s-generation rotation from current mutation authority",
		async (service, _kind, change) => {
			const state = prisma();
			const client = jellyfinDataClient();
			client.getUsers = vi.fn(async () => {
				authority.events.push("collect");
				state.setCurrentGenerations(change);
				return [{ id: "user-a", name: "Alice" }];
			});
			authority.jellyfinClient = client;

			const result = await refreshOwnedJellyfinCache({
				prisma: state.db,
				encryptor: decryptor(),
				instance: storedInstance(service),
				log,
			});

			expect(result).toMatchObject({ complete: false, superseded: true, upserted: 0 });
			expect(state.tx.jellyfinCache.deleteMany).not.toHaveBeenCalled();
			expect(state.tx.jellyfinCache.createMany).not.toHaveBeenCalled();
			expect(state.tx.cacheRefreshStatus.findUnique).toHaveBeenCalled();
			expect(state.predicates).toContainEqual(
				expect.objectContaining({ connectionGeneration: 4, identityGeneration: 9 }),
			);
		},
	);

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

		const result = await refreshOwnedTautulli(state);

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
		const instance = storedInstance("TAUTULLI");
		const state = prisma();

		const result = await refreshOwnedTautulli(state);

		expect(result).toMatchObject({ kind: "positive-observation", complete: false, upserted: 0 });
		expect(authority.connections).toEqual([
			[instance.baseUrl, "decrypted-token", log, undefined, {}],
		]);
		expect(state.tx.cacheRefreshStatus.updateMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({ connectionGeneration: 4, identityGeneration: 9 }),
			}),
		);
	});

	it("rejects disabled Tautulli publication before identity reads or collection", async () => {
		const state = prisma();

		const result = await refreshOwnedTautulli(state, { enabled: false });

		expect(result).toMatchObject({ complete: false, upserted: 0 });
		expect(authority.events).toEqual([]);
		expect(authority.connections).toEqual([]);
	});

	it("rejects a Tautulli identity switch between reads", async () => {
		authority.identities = ["tautulli-server-a", "tautulli-server-b"];
		const state = prisma();

		const result = await refreshOwnedTautulli(state);

		expect(result).toMatchObject({ complete: false, upserted: 0 });
		expect(authority.events).toEqual([
			"predicate",
			"attempt",
			"identity",
			"collect",
			"identity",
			"predicate",
			"predicate",
			"failure",
		]);
		expect(state.tx.tautulliCache.deleteMany).not.toHaveBeenCalled();
	});

	it("fails the legacy no-encryptor Jellyfin episode entrypoint closed before collection", async () => {
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

		expect(result).toMatchObject({
			complete: false,
			upserted: 0,
			errors: 1,
			errorMessages: ["provider-unavailable"],
		});
		expect(authority.jellyfinClient.getEpisodes).not.toHaveBeenCalled();
		expect(state.db.jellyfinCache.findMany).not.toHaveBeenCalled();
		expect(authority.connections).toEqual([]);
	});

	it("fails closed when Tautulli resolves a different Plex machine identifier", async () => {
		authority.identities = ["other-plex-machine"];
		const state = prisma();

		const result = await refreshOwnedTautulli(state);

		expect(result).toMatchObject({ complete: false, upserted: 0 });
		expect(authority.connections).toHaveLength(0);
		expect(state.tx.tautulliCache.deleteMany).not.toHaveBeenCalled();
	});

	it("does not expose caller-supplied clients in publishing APIs", () => {
		type JellyfinArgument = Parameters<typeof refreshJellyfinCache>[0];
		type TautulliArgument = Parameters<typeof refreshOwnedTautulliCache>[0];
		expectTypeOf<"client" extends keyof JellyfinArgument ? true : false>().toEqualTypeOf<false>();
		expectTypeOf<"client" extends keyof TautulliArgument ? true : false>().toEqualTypeOf<false>();
	});
});
