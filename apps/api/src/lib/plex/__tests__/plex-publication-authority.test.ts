import type { FastifyBaseLogger } from "fastify";
import { beforeEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import type { PrismaClient } from "../../prisma.js";
import type { OwnedProviderPublicationSnapshot } from "../../services/provider-identity-guard.js";
import { refreshPlexCache } from "../plex-cache-refresher.js";
import type { PlexClient } from "../plex-client.js";
import { refreshPlexEpisodeCache } from "../plex-episode-cache-refresher.js";
import { decodePlexGenerationMetadata } from "../plex-generation-metadata.js";

const authority = vi.hoisted(() => ({
	client: undefined as PlexClient | undefined,
	clientConnections: [] as unknown[][],
	identityReads: [] as OwnedProviderPublicationSnapshot[],
	identities: [] as string[],
	identityError: undefined as Error | undefined,
	events: [] as string[],
	parentScans: [] as Array<Record<string, unknown>>,
}));

vi.mock("../plex-authority-service.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../plex-authority-service.js")>();
	return {
		...actual,
		PlexAuthorityService: class {
			async scanInstancePolicy(input: {
				onBatch?: (batch: { rows: Array<Record<string, unknown>> }) => void;
			}) {
				const result = authority.parentScans.shift();
				if (!result) throw new Error("Parent authority scan was not configured");
				input.onBatch?.({
					rows: [{ tmdbId: 42, ratingKey: "show-1" }],
				});
				return result;
			}

			async scanInstanceEpisodeParentPolicy(input: {
				onBatch?: (batch: { rows: Array<Record<string, unknown>> }) => void;
				onTargets?: (
					targets: Array<{ mediaType: "series"; tmdbId: number; ratingKey: string }>,
				) => void;
			}) {
				const result = await this.scanInstancePolicy(input);
				input.onTargets?.([{ mediaType: "series", tmdbId: 42, ratingKey: "show-1" }]);
				return result;
			}
		},
	};
});

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
	const settlementSections = [
		{
			key: "movies",
			uuid: "movies-uuid",
			title: "Movies",
			type: "movie",
			refreshing: false,
			scannedAt: 1_777_000_000,
			updatedAt: 1_777_000_100,
		},
	];
	return {
		getActivities: vi.fn().mockResolvedValue([]),
		getLibrarySettlementSections: vi.fn().mockResolvedValue(settlementSections),
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

function positiveDataClient(): PlexClient {
	const settlementSections = [
		{
			key: "movies",
			uuid: "movies-uuid",
			title: "Movies",
			type: "movie",
			refreshing: false,
			scannedAt: 1_777_000_000,
			updatedAt: 1_777_000_100,
		},
		{
			key: "shows",
			uuid: "shows-uuid",
			title: "Shows",
			type: "show",
			refreshing: false,
			scannedAt: 1_777_000_000,
			updatedAt: 1_777_000_100,
		},
	];
	return {
		getActivities: vi.fn().mockResolvedValue([]),
		getLibrarySettlementSections: vi.fn().mockResolvedValue(settlementSections),
		getAccounts: vi.fn(async () => {
			authority.events.push("collect");
			return [{ id: 1, name: "Alice" }];
		}),
		getLibrarySections: vi.fn().mockResolvedValue([
			{ key: "movies", title: "Movies", type: "movie" },
			{ key: "shows", title: "Shows", type: "show" },
		]),
		getLibraryItems: vi.fn(async (sectionId: string) =>
			sectionId === "movies"
				? [
						{
							ratingKey: "movie-1",
							title: "Mapped Movie",
							type: "movie",
							Guid: [{ id: "tmdb://1" }],
						},
						{ ratingKey: "legacy-1", title: "Legacy Movie", type: "movie", Guid: [] },
					]
				: [
						{
							ratingKey: "show-1",
							title: "Mapped Show",
							type: "show",
							Guid: [{ id: "tmdb://42" }, { id: "tvdb://42" }],
						},
					],
		),
		getHistory: vi.fn().mockResolvedValue([]),
		verifyHistorySnapshot: vi.fn().mockResolvedValue(undefined),
		getOnDeck: vi.fn().mockResolvedValue([]),
	} as unknown as PlexClient;
}

function prisma(finalPredicateMatches = true, publicationClaimMatches = true) {
	const rows: unknown[] = [];
	const targetRows: unknown[] = [];
	let claimMatches = publicationClaimMatches;
	let targetWriteError: Error | undefined;
	const status: Record<string, unknown> = {
		generationId: "previous-generation",
		generationMetadata: "previous-metadata",
		lastResult: "success",
		lastAttemptResult: "success",
	};
	const tx = {
		libraryCleanupConfig: {
			upsert: vi.fn().mockResolvedValue({ id: "cleanup-config-1" }),
			findUnique: vi.fn().mockResolvedValue({ runClaimToken: null }),
		},
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
				rows.splice(0, rows.length);
				return { count: 0 };
			}),
			createMany: vi.fn(async ({ data }: { data: unknown[] }) => {
				authority.events.push("create");
				rows.push(...data);
				return { count: data.length };
			}),
		},
		plexGenerationTarget: {
			deleteMany: vi.fn(async () => {
				authority.events.push("target-delete");
				targetRows.splice(0, targetRows.length);
				return { count: 0 };
			}),
			createMany: vi.fn(async ({ data }: { data: unknown[] }) => {
				authority.events.push("target-create");
				if (targetWriteError) throw targetWriteError;
				targetRows.push(...data);
				return { count: data.length };
			}),
		},
		plexEpisodeCache: {
			deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
			createMany: vi.fn().mockResolvedValue({ count: 1 }),
		},
		cacheRefreshStatus: {
			findUnique: vi.fn().mockResolvedValue({
				connectionGeneration: 4,
				identityGeneration: 9,
			}),
			upsert: vi.fn(async ({ create }: { create: { lastAttemptResult?: string } }) => {
				authority.events.push(
					create.lastAttemptResult?.startsWith("in_progress:") ? "attempt" : "status",
				);
				return {};
			}),
			updateMany: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
				authority.events.push(data.lastAttemptResult === "success" ? "status" : "failure");
				if (
					(data.lastAttemptResult === "success" || data.lastAttemptResult === "partial") &&
					claimMatches
				) {
					Object.assign(status, data);
				}
				return { count: claimMatches ? 1 : 0 };
			}),
		},
	};
	const db = {
		$transaction: vi.fn(async (callback: (transaction: typeof tx) => Promise<unknown>) => {
			const snapshot = structuredClone({ rows, targetRows, status });
			try {
				return await callback(tx);
			} catch (error) {
				rows.splice(0, rows.length, ...snapshot.rows);
				targetRows.splice(0, targetRows.length, ...snapshot.targetRows);
				for (const key of Object.keys(status)) delete status[key];
				Object.assign(status, snapshot.status);
				throw error;
			}
		}),
	} as unknown as PrismaClient;
	return {
		db,
		tx,
		rows,
		targetRows,
		status,
		setClaimMatches: (value: boolean) => {
			claimMatches = value;
		},
		setTargetWriteError: (error: Error | undefined) => {
			targetWriteError = error;
		},
	};
}

describe("Plex publication authority", () => {
	beforeEach(() => {
		authority.client = dataClient();
		authority.clientConnections = [];
		authority.identityReads = [];
		authority.identities = [];
		authority.identityError = undefined;
		authority.events = [];
		authority.parentScans = [];
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
			"predicate",
			"attempt",
			"identity",
			"collect",
			"collect",
			"identity",
			"predicate",
			"status",
			"delete",
			"create",
			"create",
			"create",
			"target-delete",
			"target-create",
			"target-create",
			"target-create",
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
				update: expect.objectContaining({
					lastAttemptResult: expect.stringMatching(/^in_progress:/),
				}),
			}),
		);
		expect(fixture.tx.cacheRefreshStatus.updateMany).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					lastAttemptResult: "success",
					connectionGeneration: 4,
					identityGeneration: 9,
				}),
			}),
		);
	});

	it("publishes only bounded V3 settlement metadata", async () => {
		const fixture = prisma();
		const result = await refreshPlexCache({ prisma: fixture.db, instance: ownedSnapshot(), log });

		expect(result).toMatchObject({ complete: true, errors: 0, upserted: 1 });
		const successCall = fixture.tx.cacheRefreshStatus.updateMany.mock.calls.find(
			([call]) => call.data.lastAttemptResult === "success",
		)?.[0];
		expect(successCall).toBeDefined();
		const metadata = JSON.parse(
			(successCall as unknown as { data: { generationMetadata: string } }).data.generationMetadata,
		) as Record<string, unknown>;
		expect(metadata).toMatchObject({
			version: 3,
			canonicalizationVersion: 1,
			publicationLevel: "authoritative",
			completeness: "complete",
		});
		expect(metadata).toHaveProperty("roots");
		expect(metadata).not.toHaveProperty("targets");
		expect(metadata).not.toHaveProperty("ratingKeys");
	});

	it("atomically replaces V3 cache and ledger state with settled V4 positive-only evidence", async () => {
		const fixture = prisma();
		await expect(
			refreshPlexCache({ prisma: fixture.db, instance: ownedSnapshot(), log }),
		).resolves.toMatchObject({ kind: "authoritative-snapshot", complete: true, upserted: 1 });
		const previousGeneration = fixture.status.generationId;
		authority.client = positiveDataClient();

		const result = await refreshPlexCache({ prisma: fixture.db, instance: ownedSnapshot(), log });

		expect(result).toMatchObject({
			kind: "positive-observation",
			complete: false,
			upserted: 1,
			completedAt: expect.any(Date),
		});
		expect(fixture.status).toMatchObject({
			lastResult: "success",
			lastErrorMessage: null,
			lastAttemptResult: "partial",
			lastAttemptErrorMessage: null,
			itemCount: 1,
		});
		expect(fixture.status.generationId).not.toBe(previousGeneration);
		expect(fixture.rows).toEqual([
			expect.objectContaining({ mediaType: "series", ratingKey: "show-1" }),
		]);
		expect(fixture.targetRows).toEqual([
			expect.objectContaining({
				generationId: fixture.status.generationId,
				mediaType: "series",
				ratingKey: "show-1",
			}),
		]);
		const decoded = decodePlexGenerationMetadata(fixture.status.generationMetadata as string);
		expect(decoded).toMatchObject({
			ok: true,
			metadata: {
				version: 4,
				publicationLevel: "positive-only",
				completeness: "partial",
				itemCount: 1,
				targetCount: 1,
			},
		});
	});

	it("rolls back V4 rows, ledger, metadata, and status when positive target replacement fails", async () => {
		const fixture = prisma();
		await refreshPlexCache({ prisma: fixture.db, instance: ownedSnapshot(), log });
		const previous = structuredClone({
			rows: fixture.rows,
			targetRows: fixture.targetRows,
			status: fixture.status,
		});
		fixture.setTargetWriteError(new Error("target write failed"));
		authority.client = positiveDataClient();

		await expect(
			refreshPlexCache({ prisma: fixture.db, instance: ownedSnapshot(), log }),
		).resolves.toMatchObject({ kind: "unpublished", complete: false });

		expect(fixture.rows).toEqual(previous.rows);
		expect(fixture.targetRows).toEqual(previous.targetRows);
		expect(fixture.status).toMatchObject(previous.status);
	});

	it("does not publish while a supported section scan is active", async () => {
		const fixture = prisma();
		authority.client = {
			...dataClient(),
			getActivities: vi
				.fn()
				.mockResolvedValue([
					{ type: "library.update.section", Context: { librarySectionID: "movies" } },
				]),
		} as unknown as PlexClient;

		const result = await refreshPlexCache({ prisma: fixture.db, instance: ownedSnapshot(), log });

		expect(result).toMatchObject({ complete: false, upserted: 0 });
		expect(fixture.tx.plexCache.deleteMany).not.toHaveBeenCalled();
		expect(fixture.tx.cacheRefreshStatus.updateMany).not.toHaveBeenCalledWith(
			expect.objectContaining({ data: expect.objectContaining({ lastAttemptResult: "success" }) }),
		);
	});

	it("does not publish when the post-end final canonical pass changes", async () => {
		const fixture = prisma();
		const client = dataClient();
		const first = {
			ratingKey: "movie-1",
			title: "Movie 1",
			type: "movie",
			Guid: [{ id: "tmdb://42" }],
		};
		const changed = { ...first, title: "Changed after end probe" };
		client.getLibraryItems = vi
			.fn()
			.mockResolvedValueOnce([first])
			.mockResolvedValueOnce([first])
			.mockResolvedValueOnce([changed])
			.mockResolvedValueOnce([changed]);
		authority.client = client;

		const result = await refreshPlexCache({ prisma: fixture.db, instance: ownedSnapshot(), log });

		expect(result).toMatchObject({ complete: false, upserted: 0 });
		expect(result.errorMessages.join(" ")).toMatch(/canonical.*changed/i);
		expect(fixture.tx.plexCache.deleteMany).not.toHaveBeenCalled();
	});

	it("makes the final canonical collection the terminal upstream observation", async () => {
		const fixture = prisma();
		const events: string[] = [];
		const client = dataClient();
		client.getLibrarySettlementSections = vi.fn(async () => {
			events.push("probe");
			return [
				{
					key: "movies",
					uuid: "movies-uuid",
					title: "Movies",
					type: "movie",
					refreshing: false,
					scannedAt: 1_777_000_000,
					updatedAt: 1_777_000_100,
				},
			];
		});
		client.getAccounts = vi.fn(async () => {
			events.push("collect");
			return [{ id: 1, name: "Alice" }];
		});
		authority.client = client;

		const result = await refreshPlexCache({ prisma: fixture.db, instance: ownedSnapshot(), log });

		expect(result).toMatchObject({ complete: true, upserted: 1 });
		expect(events).toEqual(["probe", "collect", "probe", "probe", "collect"]);
	});

	it("durably revokes prior mutation authority before the first Plex identity read", async () => {
		authority.identityError = new Error("upstream unavailable");
		const fixture = prisma();

		await refreshPlexCache({ prisma: fixture.db, instance: ownedSnapshot(), log });

		expect(authority.events.indexOf("attempt")).toBeGreaterThanOrEqual(0);
		expect(authority.events.indexOf("attempt")).toBeLessThan(authority.events.indexOf("identity"));
		expect(fixture.tx.cacheRefreshStatus.upsert).toHaveBeenCalledWith(
			expect.objectContaining({
				update: expect.objectContaining({
					lastAttemptResult: expect.stringMatching(/^in_progress:/),
				}),
			}),
		);
		expect(fixture.tx.plexCache.deleteMany).not.toHaveBeenCalled();
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
		expect(fixture.tx.cacheRefreshStatus.upsert).toHaveBeenCalledOnce();
		expect(fixture.tx.cacheRefreshStatus.updateMany).not.toHaveBeenCalledWith(
			expect.objectContaining({ data: expect.objectContaining({ lastAttemptResult: "success" }) }),
		);
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
		expect(authority.events).toEqual([
			"predicate",
			"attempt",
			"identity",
			"collect",
			"collect",
			"identity",
			"predicate",
			"predicate",
			"failure",
		]);
		expect(fixture.tx.plexCache.deleteMany).not.toHaveBeenCalled();
		expect(fixture.tx.cacheRefreshStatus.upsert).toHaveBeenCalledOnce();
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
		expect(fixture.tx.cacheRefreshStatus.upsert).toHaveBeenCalledOnce();
	});

	it("rejects a concurrent service update at the final exact predicate", async () => {
		const fixture = prisma(false);

		const result = await refreshPlexCache({
			prisma: fixture.db,
			instance: ownedSnapshot(),
			log,
		});

		expect(result).toMatchObject({ complete: false, superseded: true, upserted: 0, errors: 0 });
		expect(authority.events).toEqual(["predicate"]);
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

	it("does not let an older same-identity attempt publish after its marker is superseded", async () => {
		const fixture = prisma(true, false);

		const result = await refreshPlexCache({
			prisma: fixture.db,
			instance: ownedSnapshot(),
			log,
		});

		expect(result).toMatchObject({ complete: false, superseded: true, upserted: 0, errors: 0 });
		expect(fixture.tx.plexCache.deleteMany).not.toHaveBeenCalled();
		expect(fixture.tx.plexCache.createMany).not.toHaveBeenCalled();
	});

	it("5. publishes two exact targets when duplicate provider objects aggregate into one PlexCache row", async () => {
		const fixture = prisma();
		authority.client = {
			...dataClient(),
			getLibraryItems: vi.fn().mockResolvedValue([
				{ ratingKey: "edition-a", title: "Edition A", type: "movie", Guid: [{ id: "tmdb://42" }] },
				{ ratingKey: "edition-b", title: "Edition B", type: "movie", Guid: [{ id: "tmdb://42" }] },
			]),
		} as unknown as PlexClient;

		const result = await refreshPlexCache({ prisma: fixture.db, instance: ownedSnapshot(), log });

		expect(result).toMatchObject({ complete: true, upserted: 1 });
		expect(fixture.rows).toHaveLength(1);
		expect(fixture.targetRows).toEqual([
			expect.objectContaining({ ratingKey: "edition-a", tmdbId: 42 }),
			expect.objectContaining({ ratingKey: "edition-b", tmdbId: 42 }),
		]);
	});

	it("17. rolls back cache, status, attempt, and ledger state when the target write fails", async () => {
		const fixture = prisma();
		fixture.rows.push({ id: "old-cache" });
		fixture.targetRows.push({ id: "old-target", generationId: "previous-generation" });
		fixture.setTargetWriteError(new Error("target write failed"));

		const result = await refreshPlexCache({ prisma: fixture.db, instance: ownedSnapshot(), log });

		expect(result).toMatchObject({ complete: false, upserted: 0 });
		expect(fixture.rows).toEqual([{ id: "old-cache" }]);
		expect(fixture.targetRows).toEqual([{ id: "old-target", generationId: "previous-generation" }]);
		expect(fixture.status).toMatchObject({
			generationId: "previous-generation",
			generationMetadata: "previous-metadata",
			lastAttemptResult: "success",
		});
		expect(fixture.tx.plexGenerationTarget.createMany).toHaveBeenCalled();
	});

	it("18. invokes the real lost-CAS path without replacing the previously published ledger", async () => {
		const fixture = prisma();
		await expect(
			refreshPlexCache({ prisma: fixture.db, instance: ownedSnapshot(), log }),
		).resolves.toMatchObject({ complete: true });
		const firstLedger = structuredClone(fixture.targetRows);
		expect(firstLedger).toHaveLength(1);
		const targetCallsAfterFirstPublication =
			fixture.tx.plexGenerationTarget.createMany.mock.calls.length;
		fixture.setClaimMatches(false);
		authority.client = dataClient(2);

		await expect(
			refreshPlexCache({ prisma: fixture.db, instance: ownedSnapshot(), log }),
		).resolves.toMatchObject({ superseded: true, complete: false });

		expect(fixture.targetRows).toEqual(firstLedger);
		expect(fixture.tx.plexGenerationTarget.createMany).toHaveBeenCalledTimes(
			targetCallsAfterFirstPublication,
		);
	});

	it("19. atomically replaces the current cache and exact ledger with the next generation", async () => {
		const fixture = prisma();
		await expect(
			refreshPlexCache({ prisma: fixture.db, instance: ownedSnapshot(), log }),
		).resolves.toMatchObject({ complete: true });
		const firstGeneration = fixture.status.generationId;
		authority.client = {
			...dataClient(),
			getLibraryItems: vi.fn().mockResolvedValue([
				{
					ratingKey: "movie-next",
					title: "Movie Next",
					type: "movie",
					Guid: [{ id: "tmdb://43" }],
				},
			]),
		} as unknown as PlexClient;

		await expect(
			refreshPlexCache({ prisma: fixture.db, instance: ownedSnapshot(), log }),
		).resolves.toMatchObject({ complete: true });

		expect(fixture.status.generationId).not.toBe(firstGeneration);
		expect(fixture.rows).toEqual([
			expect.objectContaining({ tmdbId: 43, ratingKey: "movie-next" }),
		]);
		expect(fixture.targetRows).toEqual([
			expect.objectContaining({
				generationId: fixture.status.generationId,
				tmdbId: 43,
				ratingKey: "movie-next",
			}),
		]);
	});

	it("23. rejects a complete collection whose exact target is absent from the settled supported-section catalog", async () => {
		const fixture = prisma();
		authority.client = {
			...dataClient(),
			getLibrarySettlementSections: vi.fn().mockResolvedValue([
				{
					key: "movies",
					uuid: "movies-uuid",
					title: "Movies",
					type: "movie",
					refreshing: false,
					scannedAt: 1_777_000_000,
					updatedAt: 1_777_000_100,
				},
			]),
			getLibrarySections: vi.fn().mockResolvedValue([
				{ key: "movies", title: "Movies", type: "movie" },
				{ key: "shows", title: "Shows", type: "show" },
			]),
			getLibraryItems: vi.fn(async (sectionId: string) =>
				sectionId === "movies"
					? [{ ratingKey: "movie-1", title: "Movie", type: "movie", Guid: [{ id: "tmdb://42" }] }]
					: [
							{
								ratingKey: "show-1",
								title: "Show",
								type: "show",
								Guid: [{ id: "tmdb://43" }, { id: "tvdb://99" }],
							},
						],
			),
		} as unknown as PlexClient;

		const result = await refreshPlexCache({ prisma: fixture.db, instance: ownedSnapshot(), log });

		expect(result).toMatchObject({ complete: false, upserted: 0 });
		expect(fixture.tx.plexGenerationTarget.createMany).not.toHaveBeenCalled();
	});

	it("publishes episode rows and status with the same two generations", async () => {
		const fixture = prisma();
		const parentPublishedAt = new Date();
		const parentRow = {
			id: "plex-row-1",
			instanceId: "plex-1",
			tmdbId: 42,
			mediaType: "series",
			sectionId: "shows",
			sectionTitle: "Shows",
			title: "Example Show",
			ratingKey: "show-1",
			lastWatchedAt: null,
			watchCount: 0,
			watchedByUsers: "[]",
			onDeck: false,
			userRating: null,
			collections: "[]",
			labels: "[]",
			addedAt: null,
			thumb: null,
			connectionGeneration: 4,
			identityGeneration: 9,
		};
		const parentStatus = {
			instanceId: "plex-1",
			cacheType: "plex",
			lastRefreshedAt: parentPublishedAt,
			lastResult: "success",
			lastErrorMessage: null,
			lastAttemptAt: parentPublishedAt,
			lastAttemptResult: "success",
			lastAttemptErrorMessage: null,
			itemCount: 1,
			connectionGeneration: 4,
			identityGeneration: 9,
			generationId: "parent-generation-1",
			generationMetadata: JSON.stringify({
				version: 3,
				publicationLevel: "authoritative",
				completeness: "complete",
				itemCount: 1,
				canonicalizationVersion: 1,
				sections: [
					{
						key: "shows",
						uuid: "shows-uuid",
						title: "Shows",
						type: "show",
						refreshing: false,
						scannedAt: 1_777_000_000,
						updatedAt: 1_777_000_100,
					},
				],
				roots: [{ sectionKey: "shows", domain: "membership", digest: "a".repeat(64) }],
			}),
		};
		const parentInstance = {
			...ownedSnapshot(),
			identityKind: "PLEX_MACHINE_IDENTIFIER",
			identityVerifiedAt: new Date(0),
			updatedAt: new Date(0),
		};
		authority.parentScans = [
			{
				available: true,
				evidence: { publicationLevel: "authoritative", completeness: "complete" },
				generationId: "parent-generation-1",
				connectionGeneration: 4,
				identityGeneration: 9,
			},
			{
				available: true,
				evidence: { publicationLevel: "authoritative", completeness: "complete" },
				generationId: "parent-generation-1",
				connectionGeneration: 4,
				identityGeneration: 9,
			},
		];
		const db = fixture.db as never as {
			serviceInstance: { findFirst: ReturnType<typeof vi.fn> };
			cacheRefreshStatus: { findMany: ReturnType<typeof vi.fn> };
			plexCache: { findMany: ReturnType<typeof vi.fn>; count: ReturnType<typeof vi.fn> };
		};
		db.serviceInstance = { findFirst: vi.fn().mockResolvedValue(parentInstance) };
		db.cacheRefreshStatus = { findMany: vi.fn().mockResolvedValue([parentStatus]) };
		db.plexCache = {
			findMany: vi.fn().mockResolvedValue([parentRow]),
			count: vi.fn().mockResolvedValue(1),
		};
		const parentClient = dataClient();
		authority.client = {
			...parentClient,
			getLibrarySettlementSections: vi.fn().mockResolvedValue([
				{
					key: "shows",
					uuid: "shows-uuid",
					title: "Shows",
					type: "show",
					refreshing: false,
					scannedAt: 1_777_000_000,
					updatedAt: 1_777_000_100,
				},
			]),
			getLibrarySections: vi
				.fn()
				.mockResolvedValue([{ key: "shows", title: "Shows", type: "show" }]),
			getLibraryItems: vi.fn().mockResolvedValue([
				{
					ratingKey: "show-1",
					title: "Example Show",
					type: "show",
					Guid: [{ id: "tmdb://42" }],
				},
			]),
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

		expect(result.errorMessages).toEqual([]);
		expect(result).toMatchObject({ complete: true, upserted: 1 });
		expect(fixture.tx.plexEpisodeCache.createMany).toHaveBeenCalledWith({
			data: [expect.objectContaining({ connectionGeneration: 4, identityGeneration: 9 })],
		});
		expect(fixture.tx.cacheRefreshStatus.updateMany).toHaveBeenLastCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({ connectionGeneration: 4, identityGeneration: 9 }),
			}),
		);
	});

	it("does not expose a caller-supplied Plex client in the publication API", () => {
		type PublicationArgument = Parameters<typeof refreshPlexCache>[0];
		type HasClient = "client" extends keyof PublicationArgument ? true : false;
		expectTypeOf<HasClient>().toEqualTypeOf<false>();
	});
});
