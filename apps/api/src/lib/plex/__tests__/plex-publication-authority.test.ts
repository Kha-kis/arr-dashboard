import type { FastifyBaseLogger } from "fastify";
import pino from "pino";
import { beforeEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import type { PrismaClient } from "../../prisma.js";
import { evaluateProviderCoverageReceipt } from "../../provider-observation/coverage-receipt.js";
import {
	authorizeProviderEvidenceUse,
	authorizeTargetScopedWatchCountMutation,
} from "../../provider-observation/evidence-capabilities.js";
import type { OwnedProviderPublicationSnapshot } from "../../services/provider-identity-guard.js";
import { UpstreamValidationError } from "../../validation/parse-upstream.js";
import { collectSettledPlexCacheLiveEvidence, refreshPlexCache } from "../plex-cache-refresher.js";
import { publishPositivePlexCacheGeneration } from "../plex-cache-storage.js";
import type { PlexClient } from "../plex-client.js";
import { classifyPlexCatalogChanges } from "../plex-collection-diagnostics.js";
import { refreshPlexEpisodeCache } from "../plex-episode-cache-refresher.js";
import {
	decodePlexGenerationMetadata,
	evaluatePublishedPlexGeneration,
} from "../plex-generation-metadata.js";

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

function receiptFrom(result: unknown): unknown {
	return (result as { receipt?: unknown }).receipt;
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
	const items = Array.from({ length: itemCount }, (_, index) => ({
		ratingKey: `movie-${index + 1}`,
		title: `Movie ${index + 1}`,
		type: "movie",
		viewCount: 0,
		Guid: [{ id: `tmdb://${index + 42}` }],
	}));
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
		getLibraryItems: vi.fn().mockResolvedValue(items),
		getLibraryItemsWithCoverage: vi.fn().mockResolvedValue({
			items,
			expectedRawCount: items.length,
			pagesAttempted: 1,
			pagesCompleted: 1,
			rawObserved: items.length,
			reason: null,
		}),
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
	const itemsBySection = {
		movies: [
			{
				ratingKey: "movie-1",
				title: "Mapped Movie",
				type: "movie",
				Guid: [{ id: "tmdb://1" }],
			},
			{ ratingKey: "legacy-1", title: "Legacy Movie", type: "movie", Guid: [] },
		],
		shows: [
			{
				ratingKey: "show-1",
				title: "Mapped Show",
				type: "show",
				Guid: [{ id: "tmdb://42" }, { id: "tvdb://42" }],
			},
		],
	};
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
		getLibraryItems: vi.fn(
			async (sectionId: string) => itemsBySection[sectionId as "movies" | "shows"] ?? [],
		),
		getLibraryItemsWithCoverage: vi.fn(async (sectionId: string) => {
			const items = itemsBySection[sectionId as "movies" | "shows"] ?? [];
			return {
				items,
				expectedRawCount: items.length,
				pagesAttempted: 1,
				pagesCompleted: 1,
				rawObserved: items.length,
				reason: null,
			};
		}),
		getHistory: vi.fn().mockResolvedValue([]),
		verifyHistorySnapshot: vi.fn().mockResolvedValue(undefined),
		getOnDeck: vi.fn().mockResolvedValue([]),
	} as unknown as PlexClient;
}

function prisma(finalPredicateMatches = true, publicationClaimMatches = true) {
	const rows: unknown[] = [];
	const targetRows: unknown[] = [];
	let attemptedAt: Date | undefined;
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
				if (create.lastAttemptResult?.startsWith("in_progress:") && "lastAttemptAt" in create) {
					attemptedAt = (create as { lastAttemptAt: Date }).lastAttemptAt;
				}
				return {};
			}),
			updateMany: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
				const isAttempt =
					typeof data.lastAttemptResult === "string" &&
					data.lastAttemptResult.startsWith("in_progress:");
				authority.events.push(
					isAttempt ? "attempt" : data.lastAttemptResult === "success" ? "status" : "failure",
				);
				if (isAttempt && "lastAttemptAt" in data) {
					attemptedAt = data.lastAttemptAt as Date;
				}
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
		getAttemptedAt: () => attemptedAt,
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

	it.each([
		[1, "start-probe"],
		[2, "end-probe"],
		[3, "final-probe"],
		[4, "terminal-probe"],
		[5, "terminal-post-probe"],
	] as const)(
		"reports a safe rejection stage for settlement probe %i",
		async (failedProbe, stage) => {
			const lines: string[] = [];
			const captured = pino(
				{ base: null, timestamp: false },
				{ write: (line: string) => lines.push(line) },
			);
			const fixture = prisma();
			fixture.rows.push({ generation: "previous" });
			const client = dataClient();
			let probes = 0;
			client.getActivities = vi.fn(async () =>
				++probes === failedProbe
					? [
							{
								type: "library.update.item.metadata",
								Context: { librarySectionID: "private-section-canary" },
							},
						]
					: [],
			);
			authority.client = client;
			const result = await refreshPlexCache({
				prisma: fixture.db,
				instance: ownedSnapshot(),
				log: captured,
			});
			expect(result).toMatchObject({ kind: "unpublished", complete: false });
			expect(fixture.rows).toEqual([{ generation: "previous" }]);
			const events = lines
				.map((line) => JSON.parse(line))
				.filter((event) => event.category === "plex-canonical-collection-rejected");
			expect(events).toEqual([
				expect.objectContaining({ stage, reason: "plex_metadata_refresh_in_progress" }),
			]);
			expect(lines.join("")).not.toContain("private-section-canary");
			client.getActivities = vi.fn(async () => []);
			await expect(
				refreshPlexCache({ prisma: fixture.db, instance: ownedSnapshot(), log: captured }),
			).resolves.toMatchObject({ complete: true, upserted: 1 });
		},
	);

	it.each([
		["getActivities", "activity-read-failed"],
		["getLibrarySettlementSections", "section-read-failed"],
	] as const)("does not serialize rejected %s payloads", async (method, reason) => {
		const lines: string[] = [];
		const captured = pino(
			{ base: null, timestamp: false },
			{ write: (line: string) => lines.push(line) },
		);
		const client = dataClient();
		vi.mocked(client[method]).mockRejectedValue(
			new Error("https://private.invalid/title?token=secret-canary"),
		);
		const result = await collectSettledPlexCacheLiveEvidence(
			client,
			"private-instance-canary",
			captured,
		);
		expect(result).toMatchObject({ kind: "unpublished", errorMessages: [], complete: false });
		expect(lines.map((line) => JSON.parse(line))).toEqual([
			expect.objectContaining({
				category: "plex-canonical-collection-rejected",
				stage: "start-probe",
				reason,
			}),
		]);
		expect(lines.join("")).not.toMatch(/private|secret-canary|token=/);
	});

	it("retains fail-closed settlement results even when the diagnostic sink throws", async () => {
		const client = dataClient();
		client.getActivities = vi.fn(async () => [{ type: "library.update.item.metadata" }]);
		await expect(
			collectSettledPlexCacheLiveEvidence(client, "private-instance", {
				...log,
				warn: () => {
					throw new Error("sink failure");
				},
			}),
		).resolves.toMatchObject({ kind: "unpublished", complete: false, errorMessages: [] });
	});

	it("does not emit a new diagnostic through an authenticated request logger's private bindings", async () => {
		const lines: string[] = [];
		const root = pino(
			{ base: null, timestamp: false },
			{ write: (line: string) => lines.push(line) },
		);
		const bound = root.child({ reqId: "request-1", userId: "private-user-canary" });
		const client = dataClient();
		client.getActivities = vi.fn(async () => [{ type: "library.update.item.metadata" }]);
		await expect(
			collectSettledPlexCacheLiveEvidence(client, "instance", bound),
		).resolves.toMatchObject({ kind: "unpublished", complete: false });
		expect(lines).toEqual([]);
	});

	it.each([
		["getActivities", "activity-schema-invalid"],
		["getLibrarySettlementSections", "section-schema-invalid"],
	] as const)(
		"distinguishes malformed %s responses without reading validation details",
		async (method, reason) => {
			const client = dataClient();
			const failure = new UpstreamValidationError(
				"private-message",
				"private-provider",
				"private-url",
				["private-issue"],
			);
			vi.mocked(client[method]).mockRejectedValue(failure);
			const lines: string[] = [];
			const captured = pino(
				{ base: null, timestamp: false },
				{ write: (line: string) => lines.push(line) },
			);
			await expect(
				collectSettledPlexCacheLiveEvidence(client, "private-instance", captured),
			).resolves.toMatchObject({ kind: "unpublished", complete: false, errorMessages: [] });
			expect(lines.map((line) => JSON.parse(line))).toEqual([
				expect.objectContaining({
					category: "plex-canonical-collection-rejected",
					stage: "start-probe",
					reason,
				}),
			]);
			expect(lines.join("")).not.toContain("private-");
		},
	);

	it.each([
		[2, "end-probe"],
		[3, "final-probe"],
		[4, "terminal-probe"],
		[5, "terminal-post-probe"],
	] as const)(
		"distinguishes catalog drift at probe %i from a failed request",
		async (changedProbe, stage) => {
			const client = dataClient();
			const sections = await client.getLibrarySettlementSections();
			let probes = 0;
			client.getLibrarySettlementSections = vi.fn(async () =>
				++probes >= changedProbe
					? sections.map((section) => ({ ...section, uuid: "private-replacement-canary" }))
					: sections,
			);
			const warning = vi.fn();
			const result = await collectSettledPlexCacheLiveEvidence(client, "instance", {
				...log,
				warn: warning,
			});
			expect(result).toMatchObject({ kind: "unpublished", complete: false });
			expect(warning).toHaveBeenCalledWith(
				{
					category: "plex-canonical-collection-rejected",
					stage,
					reason: "catalog-changed",
					catalogChanges: ["identity"],
				},
				expect.any(String),
			);
			expect(JSON.stringify(warning.mock.calls)).not.toContain("private-replacement-canary");
		},
	);

	it.each([
		["scannedAt", 1_777_000_001, "scan-revision"],
		["updatedAt", 1_777_000_101, "update-revision"],
		["title", "private-renamed-library", "display-name"],
		["uuid", "private-replaced-uuid", "identity"],
		["key", "private-replaced-key", "section-membership"],
	] as const)(
		"reports only the catalog category for changed %s",
		async (field, value, category) => {
			const client = dataClient();
			const sections = await client.getLibrarySettlementSections();
			let probes = 0;
			client.getLibrarySettlementSections = vi.fn(async () =>
				++probes === 1 ? sections : sections.map((section) => ({ ...section, [field]: value })),
			);
			const lines: string[] = [];
			const captured = pino(
				{ base: null, timestamp: false },
				{ write: (line: string) => lines.push(line) },
			);
			const result = await collectSettledPlexCacheLiveEvidence(
				client,
				"private-instance",
				captured,
			);
			expect(result).toMatchObject({ kind: "unpublished", complete: false });
			const events = lines
				.map((line) => JSON.parse(line))
				.filter((event) => event.category === "plex-canonical-collection-rejected");
			expect(events).toEqual([
				expect.objectContaining({
					stage: "end-probe",
					reason: "catalog-changed",
					catalogChanges: [category],
				}),
			]);
			expect(lines.join("")).not.toContain("private-");
		},
	);

	it("classifies simultaneous catalog differences without treating order as membership", async () => {
		const sections = await dataClient().getLibrarySettlementSections();
		const before = [...sections, { ...sections[0]!, key: "other", uuid: "other-uuid" }];
		expect(classifyPlexCatalogChanges(before, [...before].reverse())).toEqual([]);
		expect(
			classifyPlexCatalogChanges(
				before,
				before.map((section) => ({ ...section, type: "show", scannedAt: 3, updatedAt: 4 })),
			),
		).toEqual(["media-type", "scan-revision", "update-revision"]);
		expect(classifyPlexCatalogChanges(before, [before[0]!, before[0]!])).toEqual(["unknown"]);
		const throwing = {
			...before[0]!,
			get uuid(): string {
				throw new Error("private-diagnostic-failure");
			},
		};
		expect(classifyPlexCatalogChanges([throwing], before)).toEqual(["unknown"]);
	});

	it.each([
		["Plex history changed while it was being paged", "history-pagination-changed"],
		[
			"Plex history changed before its complete snapshot could be verified",
			"history-verification-changed",
		],
		["private-upstream-error", "unclassified"],
	] as const)("reports a fixed read-failure category for %s", async (message, reason) => {
		const client = dataClient();
		client.verifyHistorySnapshot = vi.fn().mockRejectedValue(new Error(message));
		const lines: string[] = [];
		const captured = pino(
			{ base: null, timestamp: false },
			{ write: (line: string) => lines.push(line) },
		);
		const result = await collectSettledPlexCacheLiveEvidence(client, "private-instance", captured);
		expect(result).toMatchObject({
			kind: reason === "unclassified" ? "unpublished" : "positive-observation",
			complete: false,
		});
		const failures = lines
			.map((line) => JSON.parse(line))
			.filter((event) => event.category === "plex-cache-refresh-failed");
		expect(failures).toEqual(
			reason === "unclassified" ? [expect.objectContaining({ reason })] : [],
		);
		expect(lines.join("")).not.toContain("private-");
	});

	it.each([
		[1, "preliminary-collection"],
		[3, "terminal-collection"],
	] as const)(
		"reports which collection could not complete its pages",
		async (failedRead, stage) => {
			const client = dataClient();
			const complete = await client.getLibraryItemsWithCoverage("movies");
			let reads = 0;
			client.getLibraryItemsWithCoverage = vi.fn(async () =>
				++reads >= failedRead
					? { ...complete, items: [], reason: "page-failure" as const }
					: complete,
			);
			const warning = vi.fn();
			const result = await collectSettledPlexCacheLiveEvidence(client, "instance", {
				...log,
				warn: warning,
			});
			expect(result).toMatchObject({ kind: "unpublished", complete: false });
			expect(warning).toHaveBeenCalledWith(
				{
					category: "plex-canonical-collection-rejected",
					stage,
					reason: "collection-incomplete",
				},
				expect.any(String),
			);
		},
	);

	it("settles a stalled canonical collection without publishing its late result and allows retry", async () => {
		vi.useFakeTimers();
		const fixture = prisma();
		fixture.rows.push({ generation: "previous" });
		let release!: (value: Awaited<ReturnType<PlexClient["getAccounts"]>>) => void;
		authority.client = dataClient();
		vi.mocked(authority.client.getAccounts).mockReturnValueOnce(
			new Promise((resolve) => {
				release = resolve;
			}),
		);
		let settled = false;
		const running = refreshPlexCache({ prisma: fixture.db, instance: ownedSnapshot(), log }).then(
			(result) => {
				settled = true;
				return result;
			},
		);
		try {
			await vi.advanceTimersByTimeAsync(10 * 60 * 1000 + 1);
			expect(settled).toBe(true);
			const result = await running;
			expect(result).toMatchObject({ complete: false, upserted: 0 });
			expect(authority.events).toContain("failure");
			expect(fixture.rows).toEqual([{ generation: "previous" }]);
			release([{ id: 1, name: "Synthetic account" }]);
			await vi.advanceTimersByTimeAsync(0);
			expect(fixture.rows).toEqual([{ generation: "previous" }]);
			expect(authority.events).not.toContain("create");
			authority.client = dataClient();
			await expect(
				refreshPlexCache({ prisma: fixture.db, instance: ownedSnapshot(), log }),
			).resolves.toMatchObject({ complete: true, errors: 0, upserted: 1 });
		} finally {
			release?.([{ id: 1, name: "Synthetic account" }]);
			await running;
			vi.useRealTimers();
		}
	});

	it("serializes both publication-rejected boundaries without provider canaries", async () => {
		const canaries = [
			"https://private.invalid/Private-Title?token=secret",
			"Private Instance Label",
			"private-instance-id",
			"private-section-id",
		];
		for (const boundary of ["attempt", "guard"] as const) {
			const lines: string[] = [];
			const captured = pino(
				{ level: "trace", base: null, timestamp: false },
				{ write: (line: string) => lines.push(line) },
			) as unknown as FastifyBaseLogger;
			const fixture = prisma();
			const instance = ownedSnapshot({
				id: canaries[2],
				label: canaries[1],
				baseUrl: canaries[0],
			});
			if (boundary === "attempt") {
				(fixture.db.$transaction as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
					new Error(canaries.join(" ")),
				);
			} else {
				authority.identityError = new Error(canaries.join(" "));
			}
			await refreshPlexCache({ prisma: fixture.db, instance, log: captured });
			const serialized = lines.join("");
			expect(serialized).toContain("plex-cache-publication-rejected");
			for (const canary of canaries) expect(serialized).not.toContain(canary);
		}
	});

	it("publishes through a normal proxy from the guarded snapshot and tags rows and status", async () => {
		const instance = ownedSnapshot();
		const fixture = prisma();
		authority.client = dataClient(205);

		const result = await refreshPlexCache({ prisma: fixture.db, instance, log });

		expect(result).toMatchObject({ complete: true, errors: 0, upserted: 205 });
		const receipt = receiptFrom(result);
		expect(receipt).toBeDefined();
		expect(evaluateProviderCoverageReceipt(receipt)).toMatchObject({
			evidence: "complete",
			complete: true,
		});
		const persistedMetadata = JSON.parse(fixture.status.generationMetadata as string) as Record<
			string,
			unknown
		>;
		expect(persistedMetadata).toMatchObject({
			version: 6,
			coverageReceipt: receipt,
			targetLedgerVersion: 1,
			targetCount: 205,
			targetDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
		});
		expect(authority.clientConnections).toEqual([
			[
				instance.baseUrl,
				instance.apiKey,
				log,
				undefined,
				instance.httpAuthHeaders,
				expect.objectContaining({
					signal: expect.any(AbortSignal),
					onRequest: expect.any(Function),
				}),
			],
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
		expect(fixture.tx.cacheRefreshStatus.updateMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({
					instanceId: "plex-1",
					cacheType: "plex",
					connectionGeneration: 4,
					identityGeneration: 9,
				}),
				data: expect.objectContaining({
					lastAttemptAt: expect.any(Date),
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

	it("publishes only bounded V6 settlement metadata with a receipt", async () => {
		const fixture = prisma();
		const result = await refreshPlexCache({ prisma: fixture.db, instance: ownedSnapshot(), log });

		expect(result).toMatchObject({ complete: true, errors: 0, upserted: 1 });
		const receipt = receiptFrom(result);
		expect(receipt).toBeDefined();
		expect(evaluateProviderCoverageReceipt(receipt)).toMatchObject({
			evidence: "complete",
			complete: true,
		});
		const successCall = fixture.tx.cacheRefreshStatus.updateMany.mock.calls.find(
			([call]) => call.data.lastAttemptResult === "success",
		)?.[0];
		expect(successCall).toBeDefined();
		const metadata = JSON.parse(
			(successCall as unknown as { data: { generationMetadata: string } }).data.generationMetadata,
		) as Record<string, unknown>;
		expect(metadata).toMatchObject({
			version: 6,
			canonicalizationVersion: 1,
			publicationLevel: "authoritative",
			completeness: "complete",
			coverageReceipt: receipt,
			targetLedgerVersion: 1,
			targetCount: 1,
			targetDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
		});
		expect(metadata).toHaveProperty("roots");
		expect(metadata).not.toHaveProperty("targets");
		expect(metadata).not.toHaveProperty("ratingKeys");
	});

	it("atomically replaces V3 cache and ledger state with settled V6 positive-only evidence", async () => {
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
			upserted: 2,
			completedAt: expect.any(Date),
		});
		const receipt = receiptFrom(result);
		expect(receipt).toBeDefined();
		expect(evaluateProviderCoverageReceipt(receipt)).toMatchObject({
			evidence: "positive-only",
			complete: false,
		});
		const persistedMetadata = JSON.parse(fixture.status.generationMetadata as string) as Record<
			string,
			unknown
		>;
		expect(persistedMetadata).toMatchObject({
			version: 6,
			coverageReceipt: receipt,
			targetLedgerVersion: 1,
			targetCount: 2,
			targetDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
		});
		expect(fixture.status).toMatchObject({
			lastResult: "success",
			lastErrorMessage: null,
			lastAttemptResult: "partial",
			lastAttemptErrorMessage: null,
			itemCount: 2,
		});
		expect(fixture.status.generationId).not.toBe(previousGeneration);
		expect(fixture.rows).toEqual([
			expect.objectContaining({ mediaType: "movie", ratingKey: "movie-1" }),
			expect.objectContaining({ mediaType: "series", ratingKey: "show-1" }),
		]);
		expect(fixture.targetRows).toEqual([
			expect.objectContaining({
				generationId: fixture.status.generationId,
				mediaType: "movie",
				ratingKey: "movie-1",
			}),
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
				version: 6,
				publicationLevel: "positive-only",
				completeness: "partial",
				itemCount: 2,
				coverageReceipt: receipt,
				targetLedgerVersion: 1,
				targetCount: 2,
				targetDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
			},
		});
		const mismatched = JSON.parse(fixture.status.generationMetadata as string) as {
			coverageReceipt: { domains: Array<Record<string, unknown>> };
		};
		const mappingDomain = mismatched.coverageReceipt.domains.find(
			(domain) => domain.domain === "mapping",
		);
		if (!mappingDomain) throw new Error("Expected mapping domain");
		mappingDomain.publishedCanonicalEntities = 1;
		expect(decodePlexGenerationMetadata(JSON.stringify(mismatched))).toEqual({
			ok: false,
			reasonCode: "metadata_invalid",
		});
	});

	it("rejects a V6 row-domain count mismatch before atomic publication writes", async () => {
		const fixture = prisma();
		authority.client = positiveDataClient();
		const published = await refreshPlexCache({
			prisma: fixture.db,
			instance: ownedSnapshot(),
			log,
		});
		expect(published.kind).toBe("positive-observation");
		const persistedData = fixture.tx.cacheRefreshStatus.updateMany.mock.calls.find(
			([call]) => typeof call.data.generationMetadata === "string",
		)?.[0].data as Record<string, unknown> | undefined;
		if (!persistedData) throw new Error("Expected persisted V6 metadata");
		const metadata = JSON.parse(persistedData.generationMetadata as string) as {
			coverageReceipt: {
				domains: Array<Record<string, unknown>>;
				attemptStartedAt: string;
				observedAt: string;
			};
		};
		const mappingDomain = metadata.coverageReceipt.domains.find(
			(domain) => domain.domain === "mapping",
		);
		if (!mappingDomain) throw new Error("Expected mapping domain");
		mappingDomain.publishedCanonicalEntities = 1;
		expect(decodePlexGenerationMetadata(JSON.stringify(metadata))).toEqual({
			ok: false,
			reasonCode: "metadata_invalid",
		});

		const statusWrites = fixture.tx.cacheRefreshStatus.updateMany.mock.calls.length;
		const rowDeletes = fixture.tx.plexCache.deleteMany.mock.calls.length;
		const rowCreates = fixture.tx.plexCache.createMany.mock.calls.length;
		const targetDeletes = fixture.tx.plexGenerationTarget.deleteMany.mock.calls.length;
		const targetCreates = fixture.tx.plexGenerationTarget.createMany.mock.calls.length;
		await expect(
			publishPositivePlexCacheGeneration(fixture.tx as never, {
				instance: ownedSnapshot(),
				rows: fixture.rows as never,
				completedAt: new Date(metadata.coverageReceipt.observedAt),
				generationId: persistedData.generationId as string,
				generationMetadata: JSON.stringify(metadata),
				targets: fixture.targetRows as never,
				attempt: {
					attemptedAt: new Date(metadata.coverageReceipt.attemptStartedAt),
					resultMarker: "in_progress:guard-regression",
				},
			}),
		).rejects.toThrow("Invalid receipt-backed Plex generation publication");
		expect(fixture.tx.cacheRefreshStatus.updateMany).toHaveBeenCalledTimes(statusWrites);
		expect(fixture.tx.plexCache.deleteMany).toHaveBeenCalledTimes(rowDeletes);
		expect(fixture.tx.plexCache.createMany).toHaveBeenCalledTimes(rowCreates);
		expect(fixture.tx.plexGenerationTarget.deleteMany).toHaveBeenCalledTimes(targetDeletes);
		expect(fixture.tx.plexGenerationTarget.createMany).toHaveBeenCalledTimes(targetCreates);
	});

	it.each([-1, 1.5])(
		"normalizes invalid provider count %s before V6 publication",
		async (viewCount) => {
			const fixture = prisma();
			const client = dataClient();
			(client.getLibraryItemsWithCoverage as ReturnType<typeof vi.fn>).mockImplementation(
				async () => ({
					items: [
						{
							ratingKey: "movie-1",
							title: "Movie 1",
							type: "movie",
							viewCount,
							Guid: [{ id: "tmdb://42" }],
						},
					],
					expectedRawCount: 1,
					pagesAttempted: 1,
					pagesCompleted: 1,
					rawObserved: 1,
					reason: null,
				}),
			);
			(client.getLibraryItems as ReturnType<typeof vi.fn>).mockResolvedValue([
				{
					ratingKey: "movie-1",
					title: "Movie 1",
					type: "movie",
					viewCount,
					Guid: [{ id: "tmdb://42" }],
				},
			]);
			authority.client = client;

			const result = await refreshPlexCache({ prisma: fixture.db, instance: ownedSnapshot(), log });

			if (result.kind === "unpublished") throw new Error(JSON.stringify(result));
			expect(result).toMatchObject({ kind: "positive-observation", complete: false, upserted: 1 });
			expect(fixture.rows).toEqual([
				expect.objectContaining({ ratingKey: "movie-1", watchCount: 0 }),
			]);
			const persistedData = fixture.tx.cacheRefreshStatus.updateMany.mock.calls.find(
				([call]) => typeof call.data.generationMetadata === "string",
			)?.[0].data;
			if (!persistedData)
				throw new Error(
					JSON.stringify({ result, calls: fixture.tx.cacheRefreshStatus.updateMany.mock.calls }),
				);
			const persisted = evaluatePublishedPlexGeneration(
				{ ...fixture.status, ...persistedData } as never,
				{
					now: new Date(),
				},
			);
			expect(persisted).toMatchObject({
				available: true,
				providerStatus: {
					domains: expect.arrayContaining([
						expect.objectContaining({ domain: "watch-count", valueSemantics: "unknown" }),
					]),
				},
			});
		},
	);

	it.each([
		"inventory",
		"Plex history changed while it was being paged",
		"Plex history changed before its complete snapshot could be verified",
	])(
		"publishes stable inventory during %s drift without permitting watch predicates or mutation",
		async (drift) => {
			const fixture = prisma();
			const client = dataClient();
			let read = 0;
			if (drift !== "inventory") {
				client.verifyHistorySnapshot = vi.fn().mockRejectedValue(new Error(drift));
			} else
				client.getLibraryItemsWithCoverage = vi.fn(async () => ({
					items: [
						{
							ratingKey: "movie-1",
							title: "Movie 1",
							type: "movie",
							viewCount: read++,
							Guid: [{ id: "tmdb://42" }],
						},
					],
					expectedRawCount: 1,
					pagesAttempted: 1,
					pagesCompleted: 1,
					rawObserved: 1,
					reason: null,
				}));
			authority.client = client;
			const result = await refreshPlexCache({ prisma: fixture.db, instance: ownedSnapshot(), log });
			expect(result).toMatchObject({ kind: "positive-observation", complete: false, upserted: 1 });
			const persistedData = fixture.tx.cacheRefreshStatus.updateMany.mock.calls.find(
				([call]) => typeof call.data.generationMetadata === "string",
			)?.[0].data;
			expect(persistedData).toBeDefined();
			const published = evaluatePublishedPlexGeneration(
				{ ...fixture.status, ...persistedData } as never,
				{ now: new Date() },
			);
			expect(published).toMatchObject({
				available: true,
				providerStatus: {
					domains: expect.arrayContaining([
						expect.objectContaining({
							domain: "library-inventory",
							availability: "current",
							valueSemantics: "exact",
						}),
						expect.objectContaining({
							domain: "watch-count",
							availability: "unavailable",
							valueSemantics: "unknown",
						}),
					]),
				},
			});
			if (!published.providerStatus) throw new Error("Expected receipt-backed provider status");
			for (const use of [
				"display",
				"arithmetic",
				"positive-predicate",
				"negative-predicate",
				"mutation",
			] as const) {
				expect(
					authorizeProviderEvidenceUse(published.providerStatus, {
						domain: "watch-count",
						field: "watch-count",
						use,
						operator: "greater_than",
						threshold: 0,
						observedValue: 2,
						targetObserved: true,
					}).authorized,
				).toBe(false);
			}
			expect(
				authorizeTargetScopedWatchCountMutation(published.providerStatus, {
					domain: "watch-count",
					field: "watch-count",
					use: "mutation",
					operator: "greater_than",
					threshold: 0,
					observedValue: 2,
					targetObserved: true,
				}).authorized,
			).toBe(false);
			expect(fixture.rows).toHaveLength(1);
		},
	);

	it("persists account failure as attribution-only degradation", async () => {
		const fixture = prisma();
		const client = positiveDataClient();
		client.getAccounts = vi.fn().mockRejectedValue(new Error("accounts unavailable"));
		authority.client = client;

		const result = await refreshPlexCache({ prisma: fixture.db, instance: ownedSnapshot(), log });
		if (result.kind === "unpublished") throw new Error(JSON.stringify(result));
		const persistedData = fixture.tx.cacheRefreshStatus.updateMany.mock.calls.find(
			([call]) => typeof call.data.generationMetadata === "string",
		)?.[0].data;
		const persisted = evaluatePublishedPlexGeneration(
			{ ...fixture.status, ...persistedData } as never,
			{
				now: new Date(),
			},
		);
		expect(persisted).toMatchObject({
			available: true,
			providerStatus: {
				domains: expect.arrayContaining([
					expect.objectContaining({ domain: "library-inventory", availability: "current" }),
					expect.objectContaining({ domain: "watch-attribution", availability: "unavailable" }),
				]),
			},
		});
	});

	it("persists history failure without treating it as an empty exact history", async () => {
		const fixture = prisma();
		const client = positiveDataClient();
		client.getHistory = vi.fn().mockRejectedValue(new Error("history unavailable"));
		authority.client = client;

		const result = await refreshPlexCache({ prisma: fixture.db, instance: ownedSnapshot(), log });
		if (result.kind === "unpublished") throw new Error(JSON.stringify(result));
		expect(client.verifyHistorySnapshot).not.toHaveBeenCalled();
		const persistedData = fixture.tx.cacheRefreshStatus.updateMany.mock.calls.find(
			([call]) => typeof call.data.generationMetadata === "string",
		)?.[0].data;
		const persisted = evaluatePublishedPlexGeneration(
			{ ...fixture.status, ...persistedData } as never,
			{
				now: new Date(),
			},
		);
		expect(persisted).toMatchObject({
			available: true,
			providerStatus: {
				domains: expect.arrayContaining([
					expect.objectContaining({ domain: "library-inventory", availability: "current" }),
					expect.objectContaining({ domain: "on-deck", availability: "current" }),
					expect.objectContaining({ domain: "watch-attribution", availability: "unavailable" }),
				]),
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

	it.each([
		["positive", "observed-targets-changed"],
		["exact", "projection-changed"],
	] as const)("does not publish when the post-end %s collection changes", async (kind, reason) => {
		const fixture = prisma();
		const client = dataClient();
		const first = {
			ratingKey: "movie-1",
			title: "Movie 1",
			type: "movie",
			Guid: [{ id: "tmdb://42" }],
			...(kind === "exact" ? { viewCount: 0 } : {}),
		};
		const changed = { ...first, title: "Changed after end probe" };
		client.getLibraryItemsWithCoverage = vi
			.fn()
			.mockResolvedValueOnce({
				items: [first],
				expectedRawCount: 1,
				pagesAttempted: 1,
				pagesCompleted: 1,
				rawObserved: 1,
				reason: null,
			})
			.mockResolvedValueOnce({
				items: [first],
				expectedRawCount: 1,
				pagesAttempted: 1,
				pagesCompleted: 1,
				rawObserved: 1,
				reason: null,
			})
			.mockResolvedValueOnce({
				items: [changed],
				expectedRawCount: 1,
				pagesAttempted: 1,
				pagesCompleted: 1,
				rawObserved: 1,
				reason: null,
			})
			.mockResolvedValueOnce({
				items: [changed],
				expectedRawCount: 1,
				pagesAttempted: 1,
				pagesCompleted: 1,
				rawObserved: 1,
				reason: null,
			});
		authority.client = client;

		const result = await refreshPlexCache({ prisma: fixture.db, instance: ownedSnapshot(), log });

		expect(result).toMatchObject({ complete: false, upserted: 0 });
		expect(result.block?.reasons).toContain("settlement-unavailable");
		expect(result.errorMessages).toEqual([]);
		expect(log.warn).toHaveBeenCalledWith(
			{
				category: "plex-canonical-collection-rejected",
				stage: "collection-comparison",
				reason,
			},
			expect.any(String),
		);
		expect(fixture.tx.plexCache.deleteMany).not.toHaveBeenCalled();
	});

	it("brackets the terminal canonical collection with exact settlement probes", async () => {
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
		expect(events).toEqual(["probe", "collect", "probe", "probe", "probe", "collect", "probe"]);
		expect(events.at(-1)).toBe("probe");
	});

	it("durably revokes prior mutation authority before the first Plex identity read", async () => {
		authority.identityError = new Error("upstream unavailable");
		const fixture = prisma();

		await refreshPlexCache({ prisma: fixture.db, instance: ownedSnapshot(), log });

		expect(authority.events.indexOf("attempt")).toBeGreaterThanOrEqual(0);
		expect(authority.events.indexOf("attempt")).toBeLessThan(authority.events.indexOf("identity"));
		expect(fixture.tx.cacheRefreshStatus.updateMany).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					lastAttemptAt: expect.any(Date),
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
		expect(fixture.tx.cacheRefreshStatus.updateMany).toHaveBeenCalledTimes(2);
		expect(receiptFrom(result)).toMatchObject({
			attemptStartedAt: (fixture.getAttemptedAt() as Date).toISOString(),
			evidence: "unknown",
		});
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
		expect(fixture.tx.cacheRefreshStatus.updateMany).toHaveBeenCalledTimes(2);
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
		expect(fixture.tx.cacheRefreshStatus.updateMany).toHaveBeenCalledTimes(2);
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
		expect(fixture.tx.cacheRefreshStatus.updateMany).not.toHaveBeenCalled();
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
				{
					ratingKey: "edition-a",
					title: "Edition A",
					type: "movie",
					viewCount: 0,
					Guid: [{ id: "tmdb://42" }],
				},
				{
					ratingKey: "edition-b",
					title: "Edition B",
					type: "movie",
					viewCount: 0,
					Guid: [{ id: "tmdb://42" }],
				},
			]),
			getLibraryItemsWithCoverage: vi.fn().mockResolvedValue({
				items: [
					{
						ratingKey: "edition-a",
						title: "Edition A",
						type: "movie",
						viewCount: 0,
						Guid: [{ id: "tmdb://42" }],
					},
					{
						ratingKey: "edition-b",
						title: "Edition B",
						type: "movie",
						viewCount: 0,
						Guid: [{ id: "tmdb://42" }],
					},
				],
				expectedRawCount: 2,
				pagesAttempted: 1,
				pagesCompleted: 1,
				rawObserved: 2,
				reason: null,
			}),
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
					viewCount: 0,
					Guid: [{ id: "tmdb://43" }],
				},
			]),
			getLibraryItemsWithCoverage: vi.fn().mockResolvedValue({
				items: [
					{
						ratingKey: "movie-next",
						title: "Movie Next",
						type: "movie",
						viewCount: 0,
						Guid: [{ id: "tmdb://43" }],
					},
				],
				expectedRawCount: 1,
				pagesAttempted: 1,
				pagesCompleted: 1,
				rawObserved: 1,
				reason: null,
			}),
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
			getLibraryItemsWithCoverage: vi.fn(async (sectionId: string) => {
				const items =
					sectionId === "movies"
						? [{ ratingKey: "movie-1", title: "Movie", type: "movie", Guid: [{ id: "tmdb://42" }] }]
						: [
								{
									ratingKey: "show-1",
									title: "Show",
									type: "show",
									Guid: [{ id: "tmdb://43" }, { id: "tvdb://99" }],
								},
							];
				return {
					items,
					expectedRawCount: items.length,
					pagesAttempted: 1,
					pagesCompleted: 1,
					rawObserved: items.length,
					reason: null,
				};
			}),
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
