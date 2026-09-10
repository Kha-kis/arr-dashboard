import type { FastifyBaseLogger } from "fastify";
import pino from "pino";
import { describe, expect, it, vi } from "vitest";
import { Prisma, type PrismaClient, type ServiceInstance } from "../prisma.js";
import {
	buildObservationActiveSlotKey,
	buildObservationAuthorityKey,
	type ObservationRunAuthority,
} from "../provider-observation/observation-run-types.js";
import { ProviderIdentityGuardError } from "../services/provider-identity-guard.js";
import { UpstreamValidationError } from "../validation/parse-upstream.js";
import type { JellyfinClient } from "./jellyfin-client.js";
import {
	classifyJellyfinEpisodeScopeFailure,
	logJellyfinEpisodePrePageFailure,
	refreshOwnedJellyfinEpisodeCache,
} from "./jellyfin-episode-cache-refresher.js";
import {
	encodeJellyfinLibraryGenerationMetadata,
	fingerprintJellyfinLibraryRows,
} from "./jellyfin-generation-metadata.js";

const publication = vi.hoisted(() => ({
	client: undefined as JellyfinClient | undefined,
	snapshotError: false,
}));

const durable = vi.hoisted(() => ({
	outer: undefined as unknown,
	run: undefined as
		| undefined
		| {
				state: string;
				completedUnits: number;
				completedWork: number;
				[id: string]: unknown;
		  },
	units: [] as Array<Record<string, unknown> & { expectedTargets?: number }>,
	stage: vi.fn(),
	finalize: vi.fn(),
	invalidate: vi.fn(),
	invalidateAttempt: vi.fn(),
	claimUnit: vi.fn(),
	failUnit: vi.fn(),
	exhausted: vi.fn(),
	guard: vi.fn(),
	finishFailure: vi.fn(),
	recordedFailureCount: 0,
}));

vi.mock("../services/provider-identity-guard.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../services/provider-identity-guard.js")>();
	return {
		...actual,
		withGuardedProviderPublication: durable.guard,
	};
});

vi.mock("../services/provider-cache-status.js", () => ({
	claimProviderCacheRefreshAttempt: vi.fn(async () => durable.outer),
	finishProviderCacheRefreshAttemptFailure: durable.finishFailure,
}));

vi.mock("./jellyfin-episode-attempt-recovery.js", () => ({
	invalidateJellyfinEpisodeAttempt: durable.invalidateAttempt,
}));

vi.mock("../provider-observation/observation-run-repository.js", () => ({
	createOrLoadObservationRun: vi.fn(
		async (_prisma: unknown, input: { authority: ObservationRunAuthority; units: unknown[] }) => {
			if (durable.run) return durable.run;
			durable.units = input.units.map((unit, ordinal) => ({
				...(unit as Record<string, unknown>),
				id: `unit-${ordinal}`,
				state: "pending",
				cursor: 0,
				expectedRawCount: null,
				observedRawCount: 0,
				claimToken: null,
			}));
			durable.run = {
				id: "run-1",
				...input.authority,
				authorityKey: buildObservationAuthorityKey(input.authority),
				activeSlotKey: buildObservationActiveSlotKey(input.authority),
				targetCount: durable.units.filter((unit) => unit.expectedTargets === 1).length,
				state: "running",
				completedUnits: 0,
				totalUnits: durable.units.length,
				completedWork: 0,
				totalWork: durable.units.filter((unit) => unit.expectedTargets === 1).length,
			};
			return durable.run;
		},
	),
	claimObservationUnit: durable.claimUnit,
	failObservationUnit: durable.failUnit,
	hasExhaustedObservationRunRetries: durable.exhausted,
}));

vi.mock("./jellyfin-episode-refresh-repository.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./jellyfin-episode-refresh-repository.js")>();
	return {
		...actual,
		stageJellyfinEpisodePage: durable.stage,
		finalizeJellyfinEpisodeRun: durable.finalize,
		invalidateJellyfinEpisodeRun: durable.invalidate,
	};
});

vi.mock("./jellyfin-cache-refresher.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./jellyfin-cache-refresher.js")>();
	return {
		...actual,
		createOwnedJellyfinPublicationSnapshot: vi.fn((_encryptor, instance: ServiceInstance) => {
			if (publication.snapshotError) throw new Error("credential unavailable");
			return {
				id: instance.id,
				userId: instance.userId,
				service: instance.service,
				expectedIdentity: instance.expectedIdentity,
				connectionGeneration: instance.connectionGeneration,
				identityGeneration: instance.identityGeneration,
				baseUrl: "https://provider.invalid",
				apiKey: "plain-api-key",
				httpAuthHeaders: {},
			};
		}),
	};
});

vi.mock("./jellyfin-client.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./jellyfin-client.js")>();
	return {
		...actual,
		JellyfinClient: class {
			constructor() {
				if (!publication.client) throw new Error("Episode test client was not configured");
				Object.assign(this, publication.client);
			}
		},
	};
});

const log = {
	warn: vi.fn(),
	info: vi.fn(),
	error: vi.fn(),
} as unknown as FastifyBaseLogger;

function ownedFixture(
	service: "JELLYFIN" | "EMBY",
	options: { parentMediaType?: "movie" | "series" } = {},
) {
	const parentRow = {
		id: "library-row-1",
		instanceId: "jellyfin-1",
		tmdbId: 42,
		mediaType: options.parentMediaType ?? "series",
		libraryId: "library-1",
		libraryName: "Library",
		title: "Show",
		jellyfinId: "series-1",
		lastWatchedAt: new Date("2026-01-02T00:00:00.000Z"),
		watchCount: 1,
		watchedByUsers: JSON.stringify(["Alice"]),
		onDeck: false,
		userRating: null,
		collections: JSON.stringify([]),
		addedAt: new Date("2025-01-01T00:00:00.000Z"),
		thumb: null,
		connectionGeneration: 7,
		identityGeneration: 2,
	};
	const parentReceipt = {
		version: 1 as const,
		provider: service === "EMBY" ? ("emby" as const) : ("jellyfin" as const),
		attemptStartedAt: "2026-01-01T00:00:00.000Z",
		observedAt: "2026-01-02T00:00:00.000Z",
		evidence: "complete" as const,
		units: [
			{
				scopeKey: "library:library-1/user:user-1",
				expectedRawCount: 1,
				pagesAttempted: 1,
				pagesCompleted: 1,
				rawObserved: 1,
				sourceBindings: 1,
				canonicalEntities: 1,
				acceptedSkips: [],
				fatalCount: 0,
			},
		],
		publishedCanonicalEntities: 1,
	};
	const parentPublishedAt = new Date(Date.now() - 1_000);
	const parentStatus = {
		lastResult: "success",
		itemCount: 1,
		generationId: "library-generation-1",
		generationMetadata: encodeJellyfinLibraryGenerationMetadata({
			version: 1,
			provider: parentReceipt.provider,
			cacheType: "jellyfin",
			publicationLevel: "authoritative",
			completeness: "complete",
			canonicalizationVersion: 1,
			itemCount: 1,
			connectionGeneration: 7,
			identityGeneration: 2,
			contentFingerprint: fingerprintJellyfinLibraryRows([parentRow]),
			coverageReceipt: parentReceipt,
		}),
		lastRefreshedAt: parentPublishedAt,
		lastAttemptAt: parentPublishedAt,
		lastAttemptResult: "success",
		connectionGeneration: 7,
		identityGeneration: 2,
	};
	const instance: ServiceInstance = {
		id: "jellyfin-1",
		userId: "user-owner",
		service,
		label: "Provider",
		baseUrl: "https://provider.invalid",
		externalUrl: null,
		encryptedApiKey: "api-cipher",
		encryptionIv: "api-iv",
		encryptedHttpAuthCredentials: "http-cipher",
		httpAuthEncryptionIv: "http-iv",
		isDefault: false,
		enabled: true,
		storageGroupId: null,
		hasLocalFilesystemAccess: false,
		pathPrefix: null,
		expectedIdentity: "jellyfin-a",
		identityKind: "JELLYFIN_SERVER_ID",
		identityStatus: "VERIFIED",
		connectionGeneration: 7,
		identityGeneration: 2,
		identityVerifiedAt: null,
		identityLastCheckedAt: null,
		createdAt: new Date("2025-01-01T00:00:00.000Z"),
		updatedAt: new Date("2025-01-01T00:00:00.000Z"),
	};
	const prisma = {
		serviceInstance: { findFirst: vi.fn().mockResolvedValue(instance) },
		cacheRefreshStatus: { findUnique: vi.fn().mockResolvedValue(parentStatus) },
		jellyfinCache: { findMany: vi.fn().mockResolvedValue([parentRow]) },
	} as unknown as PrismaClient;
	return { prisma, instance, parentStatus, parentRow };
}

describe("refreshOwnedJellyfinEpisodeCache durable page runner", () => {
	it("serializes only closed pre-page failure categories", () => {
		const canaries = [
			"https://private.invalid/Secret-Show?token=secret",
			"Private Instance Label",
			"private-user-id",
		];
		const lines: string[] = [];
		const logger = pino(
			{ level: "trace", base: null, timestamp: false },
			{ write: (line: string) => lines.push(line) },
		);
		const categories = [
			"parent-admission-failed",
			"current-authority-failed",
			"client-preparation-failed",
			"scope-discovery-failed",
			"scope-plan-failed",
			"run-admission-failed",
		] as const;
		for (const category of categories) logJellyfinEpisodePrePageFailure(logger, category);
		const serialized = lines.join("");
		for (const category of categories) expect(serialized).toContain(category);
		for (const canary of canaries) expect(serialized).not.toContain(canary);
	});

	function configureDurableRun(state: ReturnType<typeof ownedFixture>, totalRecordCount = 1) {
		(state.parentRow as unknown as { lastWatchedAt: Date | null }).lastWatchedAt = null;
		state.parentStatus.generationMetadata = encodeJellyfinLibraryGenerationMetadata({
			...(JSON.parse(state.parentStatus.generationMetadata) as Record<string, unknown>),
			contentFingerprint: fingerprintJellyfinLibraryRows([state.parentRow]),
		} as Parameters<typeof encodeJellyfinLibraryGenerationMetadata>[0]);
		(state.prisma.serviceInstance.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(
			state.instance,
		);
		(state.prisma as unknown as { providerObservationRun: unknown }).providerObservationRun = {
			findUnique: vi.fn(async () => durable.run),
			findFirst: vi.fn(async (query: { where?: Record<string, unknown>; include?: unknown }) => {
				const matches = (where: Record<string, unknown>): boolean =>
					Object.entries(where).every(([key, expected]) => {
						if (key === "OR") return (expected as Record<string, unknown>[]).some(matches);
						const actual = durable.run?.[key];
						if (expected && typeof expected === "object") {
							const filter = expected as Record<string, unknown>;
							if (Array.isArray(filter.in)) return filter.in.includes(actual);
							if (typeof filter.startsWith === "string")
								return typeof actual === "string" && actual.startsWith(filter.startsWith);
							if ("not" in filter) return actual !== filter.not;
						}
						return actual === expected;
					});
				if (!durable.run || !matches(query.where ?? {})) return null;
				return { ...durable.run, ...(query.include ? { units: durable.units } : {}) };
			}),
		};
		durable.outer = {
			status: "acquired",
			attempt: {
				attemptedAt: new Date("2026-09-07T00:00:00.000Z"),
				resultMarker: "in_progress:test",
			},
		};
		durable.units = [];
		durable.run = undefined;
		durable.stage.mockImplementation(async (_prisma, claim, _scope, page) => {
			const unit = durable.units.find((candidate) => candidate.id === claim.unitId);
			if (!unit || !durable.run) return false;
			const cursor = page.startIndex + page.items.length;
			unit.cursor = cursor;
			unit.expectedRawCount = page.totalRecordCount;
			unit.observedRawCount = cursor;
			if (cursor === page.totalRecordCount) {
				unit.state = "complete";
				durable.run.completedUnits += 1;
				durable.run.completedWork += unit.expectedTargets ?? 0;
			} else unit.state = "pending";
			return true;
		});
		durable.finalize.mockImplementation(async () => {
			if (durable.run) durable.run.state = "complete";
			return { published: true, itemCount: totalRecordCount === 0 ? 0 : 1 };
		});
		durable.invalidate.mockImplementation(async () => {
			if (durable.run) durable.run.state = "invalidated";
			return true;
		});
		durable.invalidateAttempt.mockReset();
		durable.invalidateAttempt.mockResolvedValue("recorded");
		durable.finishFailure.mockReset();
		durable.recordedFailureCount = 0;
		durable.exhausted.mockReset();
		durable.exhausted.mockResolvedValue(false);
		durable.finishFailure.mockImplementation(async (...args: unknown[]) => {
			const precondition = args[7];
			if (typeof precondition === "function" && !(await precondition({ transaction: true }))) {
				return "superseded";
			}
			durable.recordedFailureCount += 1;
			return "recorded";
		});
		durable.claimUnit.mockReset();
		durable.claimUnit.mockImplementation(async () => {
			const unit = durable.units.find((candidate) => candidate.state === "pending");
			if (!unit || !durable.run) return null;
			durable.run.state = "running";
			unit.state = "running";
			unit.claimToken = `claim-${unit.id}`;
			return {
				runId: "run-1",
				unitId: unit.id,
				claimToken: unit.claimToken,
				authorityKey: "authority",
				phase: unit.phase,
				scopeKey: unit.scopeKey,
				scopePayload: unit.scopePayload,
				cursor: unit.cursor,
				expectedRawCount: unit.expectedRawCount,
				observedRawCount: unit.observedRawCount,
			};
		});
		durable.failUnit.mockReset();
		durable.failUnit.mockImplementation(async (_prisma, input) => {
			const unit = durable.units.find((candidate) => candidate.id === input.claim.unitId);
			if (!unit || !durable.run) return false;
			unit.state = "failed";
			unit.claimToken = null;
			durable.run.state = "failed";
			durable.run.lastReasonCode = input.reasonCode;
			return true;
		});
		durable.guard.mockReset();
		durable.guard.mockImplementation(
			async (_prisma, _snapshot, _log, collect, publish) =>
				await publish({ transaction: true }, await collect()),
		);
		durable.stage.mockClear();
		durable.finalize.mockClear();
		durable.invalidate.mockClear();
		publication.snapshotError = false;
		const client = {
			getUsers: vi.fn().mockResolvedValue([{ id: "user-1", name: "Alice" }]),
			getLibraries: vi.fn().mockResolvedValue([{ id: "library-1" }]),
			getEpisodeItemsPageWithCoverage: vi.fn(async (_userId, _libraryId, cursor) => ({
				items: Array.from({ length: Math.min(1_000, totalRecordCount - cursor) }, (_, index) => ({
					type: "Episode",
					id: `episode-${cursor + index}`,
					seriesId: "series-1",
					name: `Episode ${cursor + index}`,
					seasonNumber: 1,
					episodeNumber: cursor + index,
					played: true,
					playCount: 1,
					lastPlayedDate: "2026-09-01T00:00:00Z",
				})),
				startIndex: cursor,
				totalRecordCount,
			})),
		};
		publication.client = client as unknown as JellyfinClient;
		return client;
	}

	it("fetches and stages exactly one page per invocation, then finalizes only after collect and verify", async () => {
		const state = ownedFixture("JELLYFIN");
		const client = configureDurableRun(state);
		const context = {
			prisma: state.prisma,
			encryptor: { decrypt: vi.fn() },
			instance: state.instance,
			log,
		};

		const first = await refreshOwnedJellyfinEpisodeCache(context);
		expect(first).toMatchObject({ complete: false, errors: 0, progressed: true });
		expect(client.getEpisodeItemsPageWithCoverage).toHaveBeenCalledTimes(1);
		expect(durable.finalize).not.toHaveBeenCalled();

		const second = await refreshOwnedJellyfinEpisodeCache(context);
		expect(second).toMatchObject({ complete: false, errors: 0, progressed: true });
		expect(client.getEpisodeItemsPageWithCoverage).toHaveBeenCalledTimes(2);
		expect(durable.finalize).not.toHaveBeenCalled();

		const finished = await refreshOwnedJellyfinEpisodeCache(context);
		expect(finished).toMatchObject({ complete: true, errors: 0, upserted: 1, progressed: false });
		expect(durable.finalize).toHaveBeenCalledOnce();
		expect((client as { getEpisodes?: unknown }).getEpisodes).toBeUndefined();
	});

	it("uses current libraries even when the authoritative parent contains no series", async () => {
		const state = ownedFixture("JELLYFIN", { parentMediaType: "movie" });
		const client = configureDurableRun(state, 0);
		const context = {
			prisma: state.prisma,
			encryptor: { decrypt: vi.fn() },
			instance: state.instance,
			log,
		};

		await expect(refreshOwnedJellyfinEpisodeCache(context)).resolves.toMatchObject({
			complete: false,
			errors: 0,
		});
		await expect(refreshOwnedJellyfinEpisodeCache(context)).resolves.toMatchObject({
			complete: false,
			errors: 0,
		});
		await expect(refreshOwnedJellyfinEpisodeCache(context)).resolves.toMatchObject({
			complete: true,
			errors: 0,
		});
		expect(client.getLibraries).toHaveBeenCalled();
		expect(client.getEpisodeItemsPageWithCoverage).toHaveBeenCalledTimes(2);
		expect(durable.finalize).toHaveBeenCalledOnce();
	});

	it("runs the same durable page contract for an owned Emby instance", async () => {
		const state = ownedFixture("EMBY");
		const client = configureDurableRun(state);
		const context = {
			prisma: state.prisma,
			encryptor: { decrypt: vi.fn() },
			instance: state.instance,
			log,
		};

		await refreshOwnedJellyfinEpisodeCache(context);
		await refreshOwnedJellyfinEpisodeCache(context);
		await expect(refreshOwnedJellyfinEpisodeCache(context)).resolves.toMatchObject({
			complete: true,
			errors: 0,
		});
		expect(client.getEpisodeItemsPageWithCoverage).toHaveBeenCalledTimes(2);
	});

	it("fails the acquired attempt without provider reads when credential preparation fails", async () => {
		const state = ownedFixture("JELLYFIN");
		const client = configureDurableRun(state);
		publication.snapshotError = true;
		const context = {
			prisma: state.prisma,
			encryptor: { decrypt: vi.fn() },
			instance: state.instance,
			log,
		};

		await expect(refreshOwnedJellyfinEpisodeCache(context)).resolves.toMatchObject({
			complete: false,
			errors: 1,
			progressed: false,
		});
		expect(client.getUsers).not.toHaveBeenCalled();
		expect(durable.finishFailure).toHaveBeenCalledOnce();
		expect(durable.invalidate).not.toHaveBeenCalled();
		publication.snapshotError = false;
	});

	it("rejects a same-generation endpoint or credential replacement before provider reads", async () => {
		const state = ownedFixture("JELLYFIN");
		const client = configureDurableRun(state);
		(state.prisma.serviceInstance.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({
			...state.instance,
			baseUrl: "https://replacement.invalid",
			encryptedApiKey: "replacement-cipher",
		});

		const result = await refreshOwnedJellyfinEpisodeCache({
			prisma: state.prisma,
			encryptor: { decrypt: vi.fn() },
			instance: state.instance,
			log,
		});

		expect(result).toMatchObject({ complete: false, errors: 1, upserted: 0 });
		expect(client.getUsers).not.toHaveBeenCalled();
		expect(client.getLibraries).not.toHaveBeenCalled();
		expect(client.getEpisodeItemsPageWithCoverage).not.toHaveBeenCalled();
		expect(durable.guard).not.toHaveBeenCalled();
		expect(durable.finishFailure).toHaveBeenCalledOnce();
	});

	it("treats an empty current user inventory as unavailable instead of publishing absence", async () => {
		const state = ownedFixture("JELLYFIN");
		const client = configureDurableRun(state);
		client.getUsers.mockResolvedValueOnce([]);
		const context = {
			prisma: state.prisma,
			encryptor: { decrypt: vi.fn() },
			instance: state.instance,
			log,
		};

		await expect(refreshOwnedJellyfinEpisodeCache(context)).resolves.toMatchObject({
			complete: false,
			errors: 1,
		});
		expect(client.getEpisodeItemsPageWithCoverage).not.toHaveBeenCalled();
		expect(durable.finishFailure).toHaveBeenCalledOnce();
	});

	it("keeps a continuation retryable when the exact attempt's provider page is unavailable", async () => {
		const state = ownedFixture("JELLYFIN");
		const client = configureDurableRun(state, 1_001);
		const context = {
			prisma: state.prisma,
			encryptor: { decrypt: vi.fn() },
			instance: state.instance,
			log,
		};

		await refreshOwnedJellyfinEpisodeCache(context);
		durable.outer = {
			status: "already-running",
			attempt: {
				attemptedAt: new Date("2026-09-07T00:00:00.000Z"),
				resultMarker: "in_progress:test",
			},
		};
		client.getEpisodeItemsPageWithCoverage.mockRejectedValueOnce(new Error("unavailable"));

		await expect(refreshOwnedJellyfinEpisodeCache(context)).resolves.toMatchObject({
			complete: false,
			errors: 1,
		});
		expect(durable.failUnit).toHaveBeenCalledWith(state.prisma, {
			claim: expect.objectContaining({ runId: "run-1", unitId: "unit-0" }),
			reasonCode: "provider-unavailable",
			now: expect.any(Date),
		});
		expect(durable.invalidate).not.toHaveBeenCalled();
		expect(durable.recordedFailureCount).toBe(0);
	});

	it("logs only a bounded schema category when a private provider page is rejected", async () => {
		const state = ownedFixture("JELLYFIN");
		const client = configureDurableRun(state);
		const warn = log.warn as unknown as ReturnType<typeof vi.fn>;
		warn.mockClear();
		client.getEpisodeItemsPageWithCoverage.mockRejectedValueOnce(
			new UpstreamValidationError("PRIVATE_RESPONSE_DETAIL", "jellyfin", "provider-response", [
				"Items.0.UserData.Played: PRIVATE_FIELD_DETAIL",
			]),
		);

		const result = await refreshOwnedJellyfinEpisodeCache({
			prisma: state.prisma,
			encryptor: { decrypt: vi.fn() },
			instance: state.instance,
			log,
		});

		expect(warn).toHaveBeenCalledWith(
			{ category: "episode-row-schema" },
			"Jellyfin episode page unavailable",
		);
		expect(JSON.stringify(warn.mock.calls)).not.toContain("PRIVATE");
		expect(durable.failUnit).toHaveBeenCalledOnce();
		expect(result.progressed).toBe(false);
	});

	it.each([
		["P2002", "episode-stage-conflict"],
		["P2028", "episode-stage-timeout"],
		["P2034", "episode-stage-contention"],
		["P9999", "episode-stage-unavailable"],
	])("separates %s staging failures without exposing database details", async (code, category) => {
		const state = ownedFixture("JELLYFIN");
		configureDurableRun(state);
		const warn = log.warn as unknown as ReturnType<typeof vi.fn>;
		warn.mockClear();
		durable.stage.mockRejectedValueOnce(
			new Prisma.PrismaClientKnownRequestError("PRIVATE_DATABASE_DETAIL", {
				code,
				clientVersion: "test",
				meta: { target: "PRIVATE_COLUMN" },
			}),
		);
		const result = await refreshOwnedJellyfinEpisodeCache({
			prisma: state.prisma,
			encryptor: { decrypt: vi.fn() },
			instance: state.instance,
			log,
		});
		expect(warn).toHaveBeenCalledWith({ category }, "Jellyfin episode page unavailable");
		expect(JSON.stringify(warn.mock.calls)).not.toContain("PRIVATE");
		expect(durable.failUnit).toHaveBeenCalledWith(state.prisma, {
			claim: expect.any(Object),
			reasonCode: "provider-unavailable",
			now: expect.any(Date),
		});
		expect(durable.invalidate).not.toHaveBeenCalled();
		expect(result.progressed).toBe(false);
	});

	it.each(["recorded", "superseded"] as const)(
		"settles an inherited catalog-drift attempt atomically before requesting replan (%s)",
		async (settlement) => {
			const state = ownedFixture("JELLYFIN");
			const client = configureDurableRun(state, 1_001);
			const context = {
				prisma: state.prisma,
				encryptor: { decrypt: vi.fn() },
				instance: state.instance,
				log,
			};
			await refreshOwnedJellyfinEpisodeCache(context);
			const originalParent = durable.run!.parentGenerationId;
			durable.outer = {
				status: "already-running",
				attempt: {
					attemptedAt: new Date("2026-09-07T00:00:00.000Z"),
					resultMarker: "in_progress:test",
				},
			};
			const addedRow = {
				...state.parentRow,
				id: "row-added",
				jellyfinId: "series-added",
				tmdbId: 43,
			};
			const rows = [state.parentRow, addedRow];
			const metadata = JSON.parse(state.parentStatus.generationMetadata);
			metadata.itemCount = 2;
			metadata.contentFingerprint = fingerprintJellyfinLibraryRows(rows);
			metadata.coverageReceipt.publishedCanonicalEntities = 2;
			Object.assign(metadata.coverageReceipt.units[0], {
				expectedRawCount: 2,
				rawObserved: 2,
				sourceBindings: 2,
				canonicalEntities: 2,
			});
			state.parentStatus.itemCount = 2;
			state.parentStatus.generationId = "library-generation-added";
			state.parentStatus.generationMetadata = encodeJellyfinLibraryGenerationMetadata(metadata);
			vi.mocked(state.prisma.jellyfinCache.findMany).mockResolvedValue(rows as never);
			durable.invalidateAttempt.mockResolvedValueOnce(settlement);
			client.getEpisodeItemsPageWithCoverage.mockClear();

			const result = await refreshOwnedJellyfinEpisodeCache(context);

			expect(durable.invalidateAttempt).toHaveBeenCalledOnce();
			expect(durable.invalidateAttempt).toHaveBeenCalledWith(
				expect.objectContaining({
					prisma: state.prisma,
					runId: "run-1",
					attempt: expect.objectContaining({ resultMarker: "in_progress:test" }),
					authority: expect.objectContaining({
						id: state.instance.id,
						userId: state.instance.userId,
					}),
				}),
			);
			expect(result).toMatchObject({ complete: false, errors: 1, progressed: false });
			expect(result.replanRequired).toBe(settlement === "recorded" ? true : undefined);
			expect(result.superseded).toBe(settlement === "superseded" ? true : undefined);
			expect(durable.run!.parentGenerationId).toBe(originalParent);
			expect(durable.invalidate).not.toHaveBeenCalled();
			expect(durable.finishFailure).not.toHaveBeenCalled();
			expect(client.getEpisodeItemsPageWithCoverage).not.toHaveBeenCalled();
		},
	);

	it("rediscovers failed-run scopes without terminalizing an attempt it cannot bind after drift", async () => {
		const state = ownedFixture("JELLYFIN");
		const client = configureDurableRun(state, 1_001);
		const context = {
			prisma: state.prisma,
			encryptor: { decrypt: vi.fn() },
			instance: state.instance,
			log,
		};

		await refreshOwnedJellyfinEpisodeCache(context);
		durable.outer = {
			status: "already-running",
			attempt: {
				attemptedAt: new Date("2026-09-07T00:00:00.000Z"),
				resultMarker: "in_progress:test",
			},
		};
		client.getLibraries.mockResolvedValueOnce([{ id: "library-replacement" }]);
		durable.run!.state = "failed";

		await expect(refreshOwnedJellyfinEpisodeCache(context)).resolves.toMatchObject({
			complete: false,
			errors: 1,
		});
		expect(durable.invalidate).toHaveBeenCalledWith(state.prisma, "run-1", expect.any(Date));
		expect(durable.finishFailure).not.toHaveBeenCalled();
	});

	it("treats a superseded page-stage claim as a no-op", async () => {
		const state = ownedFixture("JELLYFIN");
		configureDurableRun(state);
		durable.stage.mockResolvedValueOnce(false);
		durable.failUnit.mockResolvedValueOnce(false);
		(log.warn as unknown as ReturnType<typeof vi.fn>).mockClear();
		const context = {
			prisma: state.prisma,
			encryptor: { decrypt: vi.fn() },
			instance: state.instance,
			log,
		};

		await expect(refreshOwnedJellyfinEpisodeCache(context)).resolves.toMatchObject({
			complete: false,
			errors: 0,
			progressed: false,
		});
		expect(durable.invalidate).not.toHaveBeenCalled();
		expect(durable.failUnit).toHaveBeenCalledWith(state.prisma, {
			claim: expect.objectContaining({ runId: "run-1", unitId: "unit-0" }),
			reasonCode: "coverage-incomplete",
			now: expect.any(Date),
			resetProgress: true,
		});
		expect(log.warn).toHaveBeenCalledWith(
			{ category: "episode-page-rejected" },
			"Jellyfin episode page unavailable",
		);
		expect(durable.finishFailure).not.toHaveBeenCalled();
	});

	it("terminalizes only an acquired attempt when scope discovery fails", async () => {
		const state = ownedFixture("JELLYFIN");
		const client = configureDurableRun(state);
		client.getUsers.mockRejectedValueOnce(new Error("unavailable"));
		const context = {
			prisma: state.prisma,
			encryptor: { decrypt: vi.fn() },
			instance: state.instance,
			log,
		};

		const result = await refreshOwnedJellyfinEpisodeCache(context);
		expect(result).toMatchObject({ complete: false, errors: 1, progressed: false });
		expect(durable.finishFailure).toHaveBeenCalledOnce();
		expect(durable.invalidate).not.toHaveBeenCalled();

		durable.outer = {
			status: "already-running",
			attempt: {
				attemptedAt: new Date("2026-09-07T00:00:00.000Z"),
				resultMarker: "in_progress:other",
			},
		};
		client.getUsers.mockRejectedValueOnce(new Error("unavailable"));
		await refreshOwnedJellyfinEpisodeCache(context);
		expect(durable.finishFailure).toHaveBeenCalledOnce();
	});

	it("resumes 4,163 items at provider cursors without any per-series call", async () => {
		const state = ownedFixture("JELLYFIN");
		const client = configureDurableRun(state, 4_163);
		const context = {
			prisma: state.prisma,
			encryptor: { decrypt: vi.fn() },
			instance: state.instance,
			log,
		};

		for (let invocation = 0; invocation < 10; invocation += 1) {
			const result = await refreshOwnedJellyfinEpisodeCache(context);
			expect(result).toMatchObject({ complete: false, errors: 0 });
		}
		const completed = await refreshOwnedJellyfinEpisodeCache(context);
		expect(completed).toMatchObject({ complete: true, errors: 0 });
		expect(client.getEpisodeItemsPageWithCoverage).toHaveBeenCalledTimes(10);
		expect(client.getEpisodeItemsPageWithCoverage.mock.calls.map((call) => call[2])).toEqual([
			0, 1_000, 2_000, 3_000, 4_000, 0, 1_000, 2_000, 3_000, 4_000,
		]);
		expect((client as { getEpisodes?: unknown }).getEpisodes).toBeUndefined();
	});

	it("retains staged work and the acquired outer attempt while a failed page backs off", async () => {
		const state = ownedFixture("JELLYFIN");
		const client = configureDurableRun(state);
		client.getEpisodeItemsPageWithCoverage.mockRejectedValueOnce(new Error("unavailable"));
		const context = {
			prisma: state.prisma,
			encryptor: { decrypt: vi.fn() },
			instance: state.instance,
			log,
		};

		const result = await refreshOwnedJellyfinEpisodeCache(context);
		expect(result).toMatchObject({ complete: false, errors: 1 });
		expect(durable.failUnit).toHaveBeenCalledOnce();
		expect(durable.invalidate).not.toHaveBeenCalled();
		expect(durable.recordedFailureCount).toBe(0);
	});

	it("terminalizes the bound outer attempt on the fourth consecutive page failure", async () => {
		const state = ownedFixture("JELLYFIN");
		const client = configureDurableRun(state);
		client.getEpisodeItemsPageWithCoverage.mockRejectedValue(new Error("unavailable"));
		const context = {
			prisma: state.prisma,
			encryptor: { decrypt: vi.fn() },
			instance: state.instance,
			log,
		};
		durable.failUnit.mockImplementation(async (_prisma, input) => {
			const unit = durable.units.find((candidate) => candidate.id === input.claim.unitId);
			if (!unit || !durable.run) return false;
			unit.state = "failed";
			unit.claimToken = null;
			const attemptCount = Number(unit.attemptCount ?? 0) + 1;
			unit.attemptCount = attemptCount;
			unit.nextAttemptAt = attemptCount > 3 ? null : new Date("2026-09-08T00:00:00.000Z");
			durable.run.state = "failed";
			durable.run.nextAttemptAt = unit.nextAttemptAt;
			durable.run.lastReasonCode = input.reasonCode;
			return true;
		});
		durable.claimUnit.mockImplementation(async () => {
			const unit = durable.units.find((candidate) =>
				["pending", "failed"].includes(String(candidate.state)),
			);
			if (!unit || !durable.run) return null;
			unit.state = "running";
			unit.claimToken = `claim-${unit.id}`;
			return {
				runId: "run-1",
				unitId: unit.id,
				claimToken: unit.claimToken,
				authorityKey: "authority",
				phase: unit.phase,
				scopeKey: unit.scopeKey,
				scopePayload: unit.scopePayload,
				cursor: unit.cursor,
				expectedRawCount: unit.expectedRawCount,
				observedRawCount: unit.observedRawCount,
			};
		});
		durable.exhausted.mockImplementation(async () => {
			const failedUnit = durable.units.find((unit) => unit.state === "failed");
			return Number(failedUnit?.attemptCount ?? 0) > 3 && failedUnit?.nextAttemptAt === null;
		});

		for (let failure = 0; failure < 4; failure += 1) {
			const result = await refreshOwnedJellyfinEpisodeCache(context);
			expect(result).toMatchObject({ complete: false, errors: 1 });
			durable.outer = {
				status: "already-running",
				attempt: {
					attemptedAt: new Date("2026-09-07T00:00:00.000Z"),
					resultMarker: "in_progress:test",
				},
			};
		}

		expect(durable.failUnit).toHaveBeenCalledTimes(4);
		expect(durable.recordedFailureCount).toBe(1);
		expect(durable.invalidate).not.toHaveBeenCalled();
		expect(durable.run).toMatchObject({ state: "failed", nextAttemptAt: null });
	});

	it("guards resumed scope discovery before any new provider data read", async () => {
		const state = ownedFixture("JELLYFIN");
		const client = configureDurableRun(state);
		const context = {
			prisma: state.prisma,
			encryptor: { decrypt: vi.fn() },
			instance: state.instance,
			log,
		};
		await refreshOwnedJellyfinEpisodeCache(context);
		durable.outer = {
			status: "already-running",
			attempt: {
				attemptedAt: new Date("2026-09-07T00:00:00.000Z"),
				resultMarker: "in_progress:test",
			},
		};
		client.getUsers.mockClear();
		client.getLibraries.mockClear();
		client.getEpisodeItemsPageWithCoverage.mockClear();
		durable.stage.mockClear();
		durable.finalize.mockClear();
		durable.invalidate.mockClear();
		durable.guard.mockRejectedValueOnce(
			new ProviderIdentityGuardError(
				"IDENTITY_MISMATCH",
				"Provider identity changed; cache publication was not attempted.",
			),
		);

		const result = await refreshOwnedJellyfinEpisodeCache(context);

		expect(result).toMatchObject({ complete: false, errors: 1, upserted: 0 });
		expect(client.getUsers).not.toHaveBeenCalled();
		expect(client.getLibraries).not.toHaveBeenCalled();
		expect(client.getEpisodeItemsPageWithCoverage).not.toHaveBeenCalled();
		expect(durable.stage).not.toHaveBeenCalled();
		expect(durable.finalize).not.toHaveBeenCalled();
		expect(durable.invalidate).toHaveBeenCalledWith(state.prisma, "run-1", expect.any(Date));
	});

	it("retains failed-run staged evidence when resumed scope identity is temporarily unavailable", async () => {
		const state = ownedFixture("JELLYFIN");
		const client = configureDurableRun(state);
		const context = {
			prisma: state.prisma,
			encryptor: { decrypt: vi.fn() },
			instance: state.instance,
			log,
		};
		await refreshOwnedJellyfinEpisodeCache(context);
		durable.run!.state = "failed";
		durable.outer = {
			status: "already-running",
			attempt: {
				attemptedAt: new Date("2026-09-07T00:00:00.000Z"),
				resultMarker: "in_progress:test",
			},
		};
		durable.guard.mockRejectedValueOnce(
			new ProviderIdentityGuardError(
				"IDENTITY_UNAVAILABLE",
				"Provider identity could not be read; cache publication was not attempted.",
			),
		);

		await expect(refreshOwnedJellyfinEpisodeCache(context)).resolves.toMatchObject({
			complete: false,
			errors: 1,
			upserted: 0,
		});
		expect(durable.run).toMatchObject({ id: "run-1", state: "failed", completedUnits: 1 });
		expect(durable.invalidate).not.toHaveBeenCalled();
		expect(durable.finishFailure).not.toHaveBeenCalled();

		await expect(refreshOwnedJellyfinEpisodeCache(context)).resolves.toMatchObject({
			complete: false,
			errors: 0,
		});
		expect(client.getEpisodeItemsPageWithCoverage).toHaveBeenCalledTimes(2);
	});

	it("invalidates staged evidence when identity changes between scope discovery and a page read", async () => {
		const state = ownedFixture("JELLYFIN");
		const client = configureDurableRun(state);
		const defaultGuard = async (
			_prisma: unknown,
			_snapshot: unknown,
			_log: unknown,
			collect: () => Promise<unknown>,
			publish: (tx: unknown, collected: unknown) => Promise<unknown>,
		) => await publish({ transaction: true }, await collect());
		durable.guard
			.mockImplementationOnce(defaultGuard)
			.mockRejectedValueOnce(
				new ProviderIdentityGuardError(
					"IDENTITY_MISMATCH",
					"Provider identity changed; cache publication was not attempted.",
				),
			);

		const result = await refreshOwnedJellyfinEpisodeCache({
			prisma: state.prisma,
			encryptor: { decrypt: vi.fn() },
			instance: state.instance,
			log,
		});

		expect(result).toMatchObject({ complete: false, errors: 1, upserted: 0 });
		expect(client.getUsers).toHaveBeenCalledOnce();
		expect(client.getLibraries).toHaveBeenCalledOnce();
		expect(client.getEpisodeItemsPageWithCoverage).not.toHaveBeenCalled();
		expect(durable.stage).not.toHaveBeenCalled();
		expect(durable.failUnit).not.toHaveBeenCalled();
		expect(durable.invalidate).toHaveBeenCalledWith(state.prisma, "run-1", expect.any(Date));
	});

	it("invalidates staged evidence when live identity changes immediately before final publication", async () => {
		const state = ownedFixture("JELLYFIN");
		const client = configureDurableRun(state, 0);
		let guardCall = 0;
		durable.guard.mockImplementation(async (_prisma, _snapshot, _log, collect, publish) => {
			guardCall += 1;
			if (guardCall === 5) {
				throw new ProviderIdentityGuardError(
					"IDENTITY_MISMATCH",
					"Provider identity changed; cache publication was not attempted.",
				);
			}
			return await publish({ transaction: true }, await collect());
		});
		const context = {
			prisma: state.prisma,
			encryptor: { decrypt: vi.fn() },
			instance: state.instance,
			log,
		};

		await refreshOwnedJellyfinEpisodeCache(context);
		await refreshOwnedJellyfinEpisodeCache(context);
		const result = await refreshOwnedJellyfinEpisodeCache(context);

		expect(result).toMatchObject({ complete: false, errors: 1, upserted: 0 });
		expect(client.getEpisodeItemsPageWithCoverage).toHaveBeenCalledTimes(2);
		expect(durable.finalize).not.toHaveBeenCalled();
		expect(durable.invalidate).toHaveBeenCalledWith(state.prisma, "run-1", expect.any(Date));
	});

	it("retains a fully staged run when final identity proof is temporarily unavailable", async () => {
		const state = ownedFixture("JELLYFIN");
		configureDurableRun(state, 0);
		let guardCall = 0;
		durable.guard.mockImplementation(async (_prisma, _snapshot, _log, collect, publish) => {
			guardCall += 1;
			if (guardCall === 5) {
				throw new ProviderIdentityGuardError(
					"IDENTITY_UNAVAILABLE",
					"Provider identity could not be read; cache publication was not attempted.",
				);
			}
			return await publish({ transaction: true }, await collect());
		});
		const context = {
			prisma: state.prisma,
			encryptor: { decrypt: vi.fn() },
			instance: state.instance,
			log,
		};

		await refreshOwnedJellyfinEpisodeCache(context);
		await refreshOwnedJellyfinEpisodeCache(context);
		await expect(refreshOwnedJellyfinEpisodeCache(context)).resolves.toMatchObject({
			complete: false,
			errors: 1,
			upserted: 0,
		});
		expect(durable.run).toMatchObject({ state: "running", completedUnits: 2, totalUnits: 2 });
		expect(durable.finalize).not.toHaveBeenCalled();
		expect(durable.invalidate).not.toHaveBeenCalled();
		expect(durable.finishFailure).not.toHaveBeenCalled();

		await expect(refreshOwnedJellyfinEpisodeCache(context)).resolves.toMatchObject({
			complete: true,
			errors: 0,
			upserted: 0,
		});
		expect(durable.finalize).toHaveBeenCalledOnce();
	});

	it("reports the finalizer's committed item count and preserves a genuine zero", async () => {
		const populated = ownedFixture("JELLYFIN");
		configureDurableRun(populated);
		durable.finalize.mockImplementation(async () => {
			if (durable.run) durable.run.state = "complete";
			return { published: true, itemCount: 37 };
		});
		const populatedContext = {
			prisma: populated.prisma,
			encryptor: { decrypt: vi.fn() },
			instance: populated.instance,
			log,
		};
		await refreshOwnedJellyfinEpisodeCache(populatedContext);
		await refreshOwnedJellyfinEpisodeCache(populatedContext);
		await expect(refreshOwnedJellyfinEpisodeCache(populatedContext)).resolves.toMatchObject({
			complete: true,
			upserted: 37,
		});

		const empty = ownedFixture("JELLYFIN");
		configureDurableRun(empty, 0);
		const emptyContext = {
			prisma: empty.prisma,
			encryptor: { decrypt: vi.fn() },
			instance: empty.instance,
			log,
		};
		await refreshOwnedJellyfinEpisodeCache(emptyContext);
		await refreshOwnedJellyfinEpisodeCache(emptyContext);
		await expect(refreshOwnedJellyfinEpisodeCache(emptyContext)).resolves.toMatchObject({
			complete: true,
			upserted: 0,
		});
	});

	it("invalidates and releases the durable run when final publication loses its exact CAS", async () => {
		const state = ownedFixture("JELLYFIN");
		const client = configureDurableRun(state);
		const context = {
			prisma: state.prisma,
			encryptor: { decrypt: vi.fn() },
			instance: state.instance,
			log,
		};
		durable.finalize.mockRejectedValueOnce(new Error("publication superseded"));

		await refreshOwnedJellyfinEpisodeCache(context);
		await refreshOwnedJellyfinEpisodeCache(context);
		await expect(refreshOwnedJellyfinEpisodeCache(context)).resolves.toMatchObject({
			complete: false,
			errors: 1,
		});

		expect(durable.invalidate).toHaveBeenCalledWith(state.prisma, "run-1", expect.any(Date));
		expect(durable.finishFailure).toHaveBeenCalledOnce();
		expect(client.getEpisodeItemsPageWithCoverage).toHaveBeenCalledTimes(2);
	});
});

describe("scope discovery diagnostic privacy", () => {
	it.each([
		[
			Object.assign(new Error("private provider response"), { name: "TimeoutError" }),
			"scope-discovery-timeout",
		],
		[
			new Error("Jellyfin library inventory was not returned completely"),
			"scope-inventory-incomplete",
		],
		[new Error("Jellyfin API returned invalid JSON"), "scope-response-schema"],
		[new Error("Jellyfin API returned an unexpected response type"), "scope-response-schema"],
		[new Error("private provider address and account data"), "scope-discovery-failed"],
		[{ name: "TimeoutError", message: "private untrusted value" }, "scope-discovery-failed"],
	])("logs only a closed discovery category", (error, expected) => {
		const warn = vi.fn();
		logJellyfinEpisodePrePageFailure({ warn } as never, classifyJellyfinEpisodeScopeFailure(error));
		expect(warn).toHaveBeenCalledWith(
			{ category: expected },
			"Jellyfin episode refresh pre-page dependency unavailable",
		);
		expect(JSON.stringify(warn.mock.calls)).not.toContain("private");
	});
});
