import { readFile } from "node:fs/promises";
import path from "node:path";
import type { ProviderCoverageReceiptV1 } from "@arr/shared";
import { describe, expect, it, vi } from "vitest";
import {
	encodeTautulliObservationMetadata,
	type TautulliObservationMetadataV1,
} from "../tautulli-observation-metadata.js";
import {
	readOwnedTautulliObservation,
	readOwnedTautulliObservationForTargets,
	readUserSelectedTautulliObservation,
	type TautulliObservationPrisma,
} from "../tautulli-observation-repository.js";

const USER_ID = "user-synthetic";
const INSTANCE_ID = "instance-tautulli";
const OTHER_INSTANCE_ID = "instance-other";
const CONNECTION_GENERATION = 4;
const IDENTITY_GENERATION = 8;
const WINDOW_STARTED_AT = "2026-09-03T11:50:00.000Z";
const OBSERVED_AT = "2026-09-03T12:00:00.000Z";
const NOW = new Date("2026-09-03T12:05:00.000Z");

type MockReader = {
	serviceInstance: {
		findFirst: ReturnType<typeof vi.fn>;
		findMany: ReturnType<typeof vi.fn>;
	};
	cacheRefreshStatus: { findUnique: ReturnType<typeof vi.fn> };
	tautulliCache: {
		count: ReturnType<typeof vi.fn>;
		findMany: ReturnType<typeof vi.fn>;
	};
};

function receipt(
	overrides: Partial<ProviderCoverageReceiptV1> = {},
	itemCount = 1,
): ProviderCoverageReceiptV1 {
	return {
		version: 1,
		provider: "tautulli",
		attemptStartedAt: WINDOW_STARTED_AT,
		observedAt: OBSERVED_AT,
		evidence: "positive-only",
		units: [
			{
				scopeKey: "library:synthetic",
				expectedRawCount: itemCount,
				pagesAttempted: 1,
				pagesCompleted: 1,
				rawObserved: itemCount,
				sourceBindings: itemCount,
				canonicalEntities: itemCount,
				acceptedSkips: [],
				fatalCount: 0,
			},
		],
		publishedCanonicalEntities: itemCount,
		...overrides,
	};
}

function metadata(itemCount = 1, overrides: Partial<TautulliObservationMetadataV1> = {}) {
	return {
		version: 1,
		publicationLevel: "positive-only",
		completeness: "partial",
		itemCount,
		windowStartedAt: WINDOW_STARTED_AT,
		windowEndedAt: OBSERVED_AT,
		coverageReceipt: receipt({}, itemCount),
		...overrides,
	} satisfies TautulliObservationMetadataV1;
}

function v2Metadata(itemCount = 1) {
	const base = metadata(itemCount);
	const baseReceipt = base.coverageReceipt;
	return {
		...base,
		coverageReceipt: {
			version: 2 as const,
			provider: "tautulli" as const,
			attemptStartedAt: WINDOW_STARTED_AT,
			observedAt: OBSERVED_AT,
			evidence: "positive-only" as const,
			units: baseReceipt.units,
			publishedCanonicalEntities: itemCount,
			domains: [
				{
					domain: "watch-count" as const,
					evidence: "positive-only" as const,
					valueSemantics: "lower-bound" as const,
					units: baseReceipt.units,
				},
			],
		},
	} as TautulliObservationMetadataV1;
}

function instance(overrides: Record<string, unknown> = {}) {
	return {
		id: INSTANCE_ID,
		service: "TAUTULLI",
		enabled: true,
		expectedIdentity: "tautulli-server-synthetic",
		identityStatus: "VERIFIED",
		connectionGeneration: CONNECTION_GENERATION,
		identityGeneration: IDENTITY_GENERATION,
		...overrides,
	};
}

function row(overrides: Record<string, unknown> = {}) {
	return {
		id: "row-synthetic-1",
		instanceId: INSTANCE_ID,
		tmdbId: 123,
		mediaType: "movie",
		lastWatchedAt: new Date("2026-09-03T11:55:00.000Z"),
		watchCount: 2,
		watchedByUsers: '["Alice","Bob"]',
		connectionGeneration: CONNECTION_GENERATION,
		identityGeneration: IDENTITY_GENERATION,
		...overrides,
	};
}

function publicRow(overrides: Record<string, unknown> = {}) {
	return { ...row(overrides), lastWatchedAt: null, watchedByUsers: "[]" };
}

function status(itemCount = 1, overrides: Record<string, unknown> = {}) {
	const encodedMetadata = encodeTautulliObservationMetadata(metadata(itemCount));
	return {
		instanceId: INSTANCE_ID,
		cacheType: "tautulli",
		lastRefreshedAt: new Date(OBSERVED_AT),
		lastResult: "success",
		lastErrorMessage: null,
		itemCount,
		generationId: null,
		generationMetadata: encodedMetadata,
		lastAttemptAt: new Date(OBSERVED_AT),
		lastAttemptResult: "success",
		lastAttemptErrorMessage: null,
		connectionGeneration: CONNECTION_GENERATION,
		identityGeneration: IDENTITY_GENERATION,
		...overrides,
	};
}

function reader(
	options: {
		instance?: unknown;
		instances?: unknown[];
		status?: unknown;
		pages?: unknown[][];
	} = {},
): {
	prisma: TautulliObservationPrisma;
	tx: MockReader;
} {
	const pages = options.pages ?? [[]];
	let pageIndex = 0;
	const tx: MockReader = {
		serviceInstance: {
			findFirst: vi
				.fn()
				.mockResolvedValue(options.instance === undefined ? instance() : options.instance),
			findMany: vi
				.fn()
				.mockResolvedValue(
					options.instances === undefined ? [{ id: INSTANCE_ID }] : options.instances,
				),
		},
		cacheRefreshStatus: {
			findUnique: vi
				.fn()
				.mockResolvedValue(options.status === undefined ? status() : options.status),
		},
		tautulliCache: {
			count: vi.fn().mockResolvedValue(1),
			findMany: vi.fn().mockImplementation(async () => pages[pageIndex++] ?? []),
		},
	};
	const prisma = {
		$transaction: vi.fn(async (operation: (transaction: MockReader) => Promise<unknown>) =>
			operation(tx),
		),
	};
	return { prisma: prisma as unknown as TautulliObservationPrisma, tx };
}

async function read(
	prisma: TautulliObservationPrisma,
	input: Partial<{ userId: string; instanceId: string; now: Date }> = {},
) {
	return readOwnedTautulliObservation(prisma, {
		userId: USER_ID,
		instanceId: INSTANCE_ID,
		now: NOW,
		...input,
	});
}

describe("readOwnedTautulliObservation", () => {
	it("selects the sole enabled owned Tautulli instance through the canonical guard", async () => {
		const selected = row();
		const { prisma, tx } = reader({ pages: [[selected]] });

		const result = await readUserSelectedTautulliObservation(prisma, {
			userId: USER_ID,
			targets: [{ tmdbId: 123, mediaType: "movie" }],
			now: NOW,
		});

		expect(result).toMatchObject({
			configured: true,
			available: true,
			rows: [
				{
					id: selected.id,
					watchCount: selected.watchCount,
					lastWatchedAt: null,
					watchedByUsers: "[]",
				},
			],
			providerStatus: { availability: "partial", evidence: "positive-only" },
		});
		expect(tx.serviceInstance.findMany).toHaveBeenCalledWith({
			where: { userId: USER_ID, service: "TAUTULLI", enabled: true },
			select: { id: true },
			orderBy: { id: "asc" },
		});
	});

	it("quarantines ambiguous enabled Tautulli topology before reading rows", async () => {
		const { prisma, tx } = reader({
			instances: [{ id: INSTANCE_ID }, { id: OTHER_INSTANCE_ID }],
		});

		const result = await readUserSelectedTautulliObservation(prisma, {
			userId: USER_ID,
			targets: [{ tmdbId: 123, mediaType: "movie" }],
			now: NOW,
		});

		expect(result).toMatchObject({
			configured: true,
			available: false,
			rows: [],
			reasonCodes: ["tautulli_mapping_required"],
			providerStatus: { availability: "unavailable" },
		});
		expect(tx.serviceInstance.findFirst).not.toHaveBeenCalled();
		expect(tx.tautulliCache.findMany).not.toHaveBeenCalled();
	});

	it("rejects an oversized display target set before opening a transaction", async () => {
		const { prisma } = reader();
		const targets = Array.from({ length: 201 }, (_, index) => ({
			tmdbId: index + 1,
			mediaType: "movie" as const,
		}));

		const result = await readUserSelectedTautulliObservation(prisma, {
			userId: USER_ID,
			targets,
			now: NOW,
		});

		expect(result).toMatchObject({
			configured: true,
			available: false,
			rows: [],
			providerStatus: { availability: "unavailable" },
		});
		expect(prisma.$transaction).not.toHaveBeenCalled();
	});

	it("reads only requested positive targets with the canonical partial status", async () => {
		const selected = row();
		const { prisma, tx } = reader({ pages: [[selected]] });

		const result = await readOwnedTautulliObservationForTargets(prisma, {
			userId: USER_ID,
			instanceId: INSTANCE_ID,
			targets: [
				{ tmdbId: 123, mediaType: "movie" },
				{ tmdbId: 999, mediaType: "series" },
			],
			now: NOW,
		});

		expect(result).toMatchObject({
			rows: [publicRow()],
			providerStatus: {
				availability: "partial",
				evidence: "positive-only",
				latestAttempt: "successful",
			},
		});
		expect(tx.tautulliCache.findMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({
					instanceId: INSTANCE_ID,
					instance: { userId: USER_ID },
					connectionGeneration: CONNECTION_GENERATION,
					identityGeneration: IDENTITY_GENERATION,
					watchCount: { gt: 0 },
					lastWatchedAt: { not: null },
					OR: [
						{ tmdbId: 123, mediaType: "movie" },
						{ tmdbId: 999, mediaType: "series" },
					],
				}),
				orderBy: { id: "asc" },
				take: 2,
			}),
		);
	});

	it("keeps deterministic selection when target ordering differs from row ids", async () => {
		const first = row({ id: "row-a", tmdbId: 999, mediaType: "series" });
		const second = row({ id: "row-z", tmdbId: 123, mediaType: "movie" });
		const { prisma, tx } = reader({ pages: [[first, second]], status: status(2) });
		tx.tautulliCache.count.mockResolvedValue(2);

		const result = await readOwnedTautulliObservationForTargets(prisma, {
			userId: USER_ID,
			instanceId: INSTANCE_ID,
			targets: [
				{ tmdbId: 123, mediaType: "movie" },
				{ tmdbId: 999, mediaType: "series" },
			],
			now: NOW,
		});

		expect(result?.rows).toEqual([
			publicRow({ id: "row-a", tmdbId: 999, mediaType: "series" }),
			publicRow({ id: "row-z" }),
		]);
	});

	it.each([
		[
			"identity transition",
			{ instance: instance({ identityStatus: "MISMATCH" }) },
			"identity-changed",
		],
		[
			"receipt transition",
			{ status: { ...status(), generationId: "stale-generation" } },
			"receipt-invalid",
		],
	])(
		"applies the same guard to full and selected readers for %s",
		async (_label, options, reason) => {
			const full = reader(options);
			const selected = reader(options);
			const fullResult = await read(full.prisma);
			const selectedResult = await readOwnedTautulliObservationForTargets(selected.prisma, {
				userId: USER_ID,
				instanceId: INSTANCE_ID,
				targets: [{ tmdbId: 123, mediaType: "movie" }],
				now: NOW,
			});

			expect(fullResult?.providerStatus).toMatchObject({
				availability: "unavailable",
				reasonCodes: [reason],
			});
			expect(selectedResult?.providerStatus).toMatchObject({
				availability: "unavailable",
				reasonCodes: [reason],
			});
		},
	);

	it("returns a valid one-row publication with a lower-bound watch-count domain", async () => {
		const { prisma } = reader({ pages: [[row()]] });

		const result = await read(prisma);

		expect(result).toMatchObject({
			instanceId: INSTANCE_ID,
			rows: [publicRow()],
			providerStatus: {
				availability: "partial",
				evidence: "positive-only",
				observedAt: OBSERVED_AT,
				ageSeconds: 300,
				latestAttempt: "successful",
				domains: [
					{
						domain: "watch-count",
						availability: "current",
						evidence: "positive-only",
						valueSemantics: "lower-bound",
					},
				],
			},
		});
		expect(result?.metadata).toEqual(metadata());
	});

	it("retains successful empty-window health without claiming complete watch evidence", async () => {
		const { prisma } = reader({ status: status(0), pages: [[]] });
		const result = await read(prisma);

		expect(result).toMatchObject({
			rows: [],
			providerStatus: {
				availability: "partial",
				evidence: "positive-only",
				latestAttempt: "successful",
				observedAt: OBSERVED_AT,
				ageSeconds: 300,
			},
		});
		expect(result?.metadata).toEqual(metadata(0));
		expect(result?.providerStatus.reasonCodes).toContain("coverage-incomplete");
	});

	it("retains successful empty-window health for selected targets without inventing zero rows", async () => {
		const { prisma, tx } = reader({ status: status(0), pages: [[]] });
		tx.tautulliCache.count.mockResolvedValue(0);

		const result = await readOwnedTautulliObservationForTargets(prisma, {
			userId: USER_ID,
			instanceId: INSTANCE_ID,
			targets: [{ tmdbId: 123, mediaType: "movie" }],
			now: NOW,
		});

		expect(result).toMatchObject({
			rows: [],
			providerStatus: {
				availability: "partial",
				evidence: "positive-only",
				latestAttempt: "successful",
				observedAt: OBSERVED_AT,
			},
		});
		expect(result?.metadata).toEqual(metadata(0));
		expect(result?.providerStatus.reasonCodes).toContain("coverage-incomplete");
	});

	it.each([
		["error", "failed", "refresh-failed"],
		["in_progress:123e4567-e89b-42d3-a456-426614174000", "running", "refresh-running"],
	] as const)(
		"preserves a newer %s attempt after an empty publication",
		async (attempt, state, reason) => {
			const { prisma } = reader({
				status: status(0, {
					lastAttemptAt: new Date("2026-09-03T12:01:00.000Z"),
					lastAttemptResult: attempt,
					lastAttemptErrorMessage: attempt === "error" ? "synthetic failure" : null,
				}),
				pages: [[]],
			});
			expect(await read(prisma)).toMatchObject({
				rows: [],
				providerStatus: {
					availability: "last-known",
					latestAttempt: state,
					observedAt: OBSERVED_AT,
					reasonCodes: expect.arrayContaining([reason]),
				},
			});
		},
	);

	it("rejects identity drift during an empty-window read", async () => {
		const { prisma, tx } = reader({ status: status(0), pages: [[]] });
		tx.serviceInstance.findFirst
			.mockResolvedValueOnce(instance())
			.mockResolvedValueOnce(instance({ identityGeneration: IDENTITY_GENERATION + 1 }));
		expect(await read(prisma)).toMatchObject({
			rows: [],
			metadata: null,
			providerStatus: { availability: "unavailable", evidence: "unknown" },
		});
	});

	it("projects a verified current V2 positive row into only a lower-bound watch-count domain", async () => {
		const { prisma } = reader({
			status: {
				...status(),
				generationMetadata: encodeTautulliObservationMetadata(v2Metadata()),
			},
			pages: [[row()]],
		});

		const result = await read(prisma);

		expect(result?.providerStatus).toMatchObject({
			availability: "partial",
			evidence: "positive-only",
			domains: [
				{
					domain: "watch-count",
					availability: "current",
					evidence: "positive-only",
					valueSemantics: "lower-bound",
				},
			],
		});
		expect(result?.providerStatus.domains).toHaveLength(1);
	});

	it("returns bounded truncation with positive-only and coverage reason codes", async () => {
		const truncated = metadata(1, {
			coverageReceipt: receipt(
				{
					units: [
						{
							scopeKey: "library:synthetic",
							expectedRawCount: null,
							pagesAttempted: 1,
							pagesCompleted: 1,
							rawObserved: 2,
							sourceBindings: 1,
							canonicalEntities: 1,
							acceptedSkips: [{ reason: "bounded-window-truncation", count: 1 }],
							fatalCount: 0,
						},
					],
				},
				1,
			),
		});
		const { prisma } = reader({
			status: { ...status(), generationMetadata: encodeTautulliObservationMetadata(truncated) },
			pages: [[row()]],
		});

		const result = await read(prisma);

		expect(result?.providerStatus).toMatchObject({
			availability: "partial",
			evidence: "positive-only",
			reasonCodes: expect.arrayContaining([
				"positive-only",
				"provider-limit",
				"accepted-skips",
				"coverage-incomplete",
			]),
		});
	});

	it.each([
		["failed", "error", "2026-09-03T12:01:00.000Z", "refresh-failed"],
		[
			"running",
			"in_progress:123e4567-e89b-42d3-a456-426614174000",
			"2026-09-03T12:01:00.000Z",
			"refresh-running",
		],
	] as const)(
		"preserves prior rows and metadata for a newer %s attempt",
		async (_label, attemptResult, attemptedAt, reasonCode) => {
			const priorMetadata = metadata();
			const { prisma } = reader({
				pages: [[row()]],
				status: {
					...status(),
					generationMetadata: encodeTautulliObservationMetadata(priorMetadata),
					lastAttemptAt: new Date(attemptedAt),
					lastAttemptResult: attemptResult,
					lastAttemptErrorMessage: attemptResult === "error" ? "synthetic bounded failure" : null,
				},
			});

			const result = await read(prisma);

			expect(result).toMatchObject({
				rows: [publicRow()],
				metadata: priorMetadata,
				providerStatus: {
					availability: "last-known",
					evidence: "positive-only",
					observedAt: OBSERVED_AT,
					latestAttempt: attemptResult === "error" ? "failed" : "running",
					reasonCodes: expect.arrayContaining([reasonCode]),
				},
			});
		},
	);

	it.each([
		["failed", "error", "2026-09-03T12:01:00.000Z", "failed", "refresh-failed"],
		[
			"running",
			"in_progress:123e4567-e89b-42d3-a456-426614174000",
			"2026-09-03T12:01:00.000Z",
			"running",
			"refresh-running",
		],
	] as const)(
		"preserves selected positive rows as last-known during a newer %s attempt",
		async (_label, attemptResult, attemptedAt, latestAttempt, reasonCode) => {
			const selected = row();
			const { prisma } = reader({
				pages: [[selected]],
				status: {
					...status(),
					lastAttemptAt: new Date(attemptedAt),
					lastAttemptResult: attemptResult,
					lastAttemptErrorMessage: attemptResult === "error" ? "synthetic bounded failure" : null,
				},
			});

			const result = await readUserSelectedTautulliObservation(prisma, {
				userId: USER_ID,
				targets: [{ tmdbId: 123, mediaType: "movie" }],
				now: NOW,
			});

			expect(result).toMatchObject({
				configured: true,
				available: true,
				rows: [publicRow()],
				providerStatus: {
					availability: "last-known",
					evidence: "positive-only",
					latestAttempt,
					reasonCodes: expect.arrayContaining([reasonCode]),
				},
			});
		},
	);

	it("keeps an older positive-only publication partial with exact age", async () => {
		const observedAt = new Date("2026-09-03T11:00:00.000Z");
		const olderMetadata = metadata(1, {
			windowStartedAt: "2026-09-03T10:50:00.000Z",
			windowEndedAt: observedAt.toISOString(),
			coverageReceipt: receipt({
				attemptStartedAt: "2026-09-03T10:50:00.000Z",
				observedAt: observedAt.toISOString(),
			}),
		});
		const { prisma } = reader({
			pages: [[row({ lastWatchedAt: new Date("2026-09-03T10:55:00.000Z") })]],
			status: {
				...status(),
				lastRefreshedAt: observedAt,
				lastAttemptAt: observedAt,
				generationMetadata: encodeTautulliObservationMetadata(olderMetadata),
			},
		});

		const result = await read(prisma, { now: NOW });

		expect(result?.providerStatus).toMatchObject({
			availability: "last-known",
			evidence: "positive-only",
			observedAt: observedAt.toISOString(),
			ageSeconds: 3900,
			reasonCodes: expect.arrayContaining(["publication-stale"]),
		});
	});

	it("returns null for foreign or non-Tautulli instances without status or row reads", async () => {
		const foreign = reader({ instance: null });
		const foreignResult = await read(foreign.prisma, { instanceId: OTHER_INSTANCE_ID });
		expect(foreignResult).toBeNull();
		expect(foreign.tx.cacheRefreshStatus.findUnique).not.toHaveBeenCalled();
		expect(foreign.tx.tautulliCache.findMany).not.toHaveBeenCalled();

		const nonTautulli = reader({ instance: instance({ service: "PLEX" }) });
		const nonTautulliResult = await read(nonTautulli.prisma);
		expect(nonTautulliResult).toBeNull();
		expect(nonTautulli.tx.cacheRefreshStatus.findUnique).not.toHaveBeenCalled();
		expect(nonTautulli.tx.tautulliCache.findMany).not.toHaveBeenCalled();
	});

	it.each([
		["disabled", { enabled: false }, "identity-unverified"],
		["unverified", { identityStatus: "UNVERIFIED" }, "identity-unverified"],
		["mismatched", { identityStatus: "MISMATCH" }, "identity-changed"],
		["missing expected identity", { expectedIdentity: "" }, "identity-unverified"],
	])("fails closed for %s identity", async (_label, overrides, reasonCode) => {
		const { prisma } = reader({ instance: instance(overrides), pages: [[row()]] });
		const result = await read(prisma);

		expect(result).toMatchObject({
			rows: [],
			metadata: null,
			providerStatus: { availability: "unavailable", reasonCodes: [reasonCode] },
		});
	});

	it.each([
		["missing status", null, "no-publication"],
		["wrong service status", { ...status(), cacheType: "plex" }, "receipt-invalid"],
		[
			"non-null generation id",
			{ ...status(), generationId: "forbidden-generation" },
			"receipt-invalid",
		],
		[
			"future publication",
			{ ...status(), lastRefreshedAt: new Date("2026-09-03T12:06:00.000Z") },
			"receipt-invalid",
		],
		["status count mismatch", { ...status(), itemCount: 2 }, "receipt-invalid"],
	])("fails closed for %s", async (_label, statusValue, reasonCode) => {
		const { prisma } = reader({ status: statusValue, pages: [[row()]] });
		const result = await read(prisma);

		expect(result).toMatchObject({
			rows: [],
			metadata: null,
			providerStatus: { availability: "unavailable", reasonCodes: [reasonCode] },
		});
	});

	it.each([
		["wrong generations", { connectionGeneration: 3 }, "receipt-invalid"],
		["malformed metadata", { generationMetadata: "{not-json" }, "receipt-invalid"],
		["future attempt", { lastAttemptAt: new Date("2026-09-03T12:06:00.000Z") }, "receipt-invalid"],
		[
			"bad attempt state",
			{ lastAttemptResult: "mystery", lastAttemptAt: new Date(OBSERVED_AT) },
			"receipt-invalid",
		],
		[
			"failed attempt without bounded reason",
			{
				lastAttemptResult: "error",
				lastAttemptAt: new Date(OBSERVED_AT),
				lastAttemptErrorMessage: null,
			},
			"receipt-invalid",
		],
		[
			"failed attempt not newer than publication",
			{
				lastAttemptResult: "error",
				lastAttemptAt: new Date(OBSERVED_AT),
				lastAttemptErrorMessage: "synthetic failure",
			},
			"receipt-invalid",
		],
		[
			"running attempt not newer than publication",
			{
				lastAttemptResult: "in_progress:123e4567-e89b-42d3-a456-426614174000",
				lastAttemptAt: new Date(OBSERVED_AT),
				lastAttemptErrorMessage: null,
			},
			"receipt-invalid",
		],
		[
			"running attempt with error",
			{
				lastAttemptResult: "in_progress:123e4567-e89b-42d3-a456-426614174000",
				lastAttemptAt: new Date(OBSERVED_AT),
				lastAttemptErrorMessage: "secret",
			},
			"receipt-invalid",
		],
	])("fails closed for %s", async (_label, overrides, reasonCode) => {
		const { prisma } = reader({ status: { ...status(), ...overrides }, pages: [[row()]] });
		const result = await read(prisma);
		expect(result).toMatchObject({
			rows: [],
			metadata: null,
			providerStatus: { availability: "unavailable", reasonCodes: [reasonCode] },
		});
	});

	it.each([
		["foreign row", { instanceId: "other-instance" }],
		["legacy generation row", { connectionGeneration: null, identityGeneration: null }],
		["mixed generation row", { identityGeneration: IDENTITY_GENERATION - 1 }],
		["unsupported media type", { mediaType: "episode" }],
		["zero TMDB id", { tmdbId: 0 }],
		["zero watch count", { watchCount: 0 }],
		["null watched timestamp", { lastWatchedAt: null }],
		["timestamp outside window", { lastWatchedAt: new Date("2026-09-03T10:00:00.000Z") }],
		["noncanonical usernames", { watchedByUsers: '["Bob","Alice"]' }],
		["duplicate usernames", { watchedByUsers: '["Alice","Alice"]' }],
		["empty username list", { watchedByUsers: "[]" }],
		["blank username", { watchedByUsers: '["Alice"," "]' }],
		["unbounded row id", { id: "x".repeat(501) }],
	])("fails closed for %s", async (_label, overrides) => {
		const { prisma } = reader({ pages: [[row(overrides)]] });
		const result = await read(prisma);
		expect(result).toMatchObject({
			rows: [],
			metadata: null,
			providerStatus: { availability: "unavailable", reasonCodes: ["rows-inconsistent"] },
		});
	});

	it("requires independent owner scoping on status, rows, and final lifecycle reads", async () => {
		const { prisma, tx } = reader({ pages: [[row()]] });
		await read(prisma);

		expect(tx.serviceInstance.findFirst).toHaveBeenNthCalledWith(
			1,
			expect.objectContaining({
				where: { id: INSTANCE_ID, userId: USER_ID, service: "TAUTULLI" },
			}),
		);
		expect(tx.serviceInstance.findFirst).toHaveBeenNthCalledWith(
			2,
			expect.objectContaining({
				where: { id: INSTANCE_ID, userId: USER_ID, service: "TAUTULLI" },
			}),
		);
		for (const call of tx.cacheRefreshStatus.findUnique.mock.calls) {
			expect(call[0].where).toMatchObject({ instance: { userId: USER_ID } });
		}
		for (const call of tx.tautulliCache.findMany.mock.calls) {
			expect(call[0].where).toEqual({ instanceId: INSTANCE_ID, instance: { userId: USER_ID } });
		}
	});

	it("rejects a status or instance changed during row collection", async () => {
		const tx: MockReader = {
			serviceInstance: {
				findFirst: vi
					.fn()
					.mockResolvedValueOnce(instance())
					.mockResolvedValueOnce(instance({ identityGeneration: 9 })),
				findMany: vi.fn(),
			},
			cacheRefreshStatus: {
				findUnique: vi.fn().mockResolvedValueOnce(status()).mockResolvedValueOnce(status()),
			},
			tautulliCache: {
				count: vi.fn(),
				findMany: vi.fn().mockResolvedValueOnce([row()]).mockResolvedValueOnce([]),
			},
		};
		const prisma = {
			$transaction: vi.fn(async (operation: (transaction: MockReader) => Promise<unknown>) =>
				operation(tx),
			),
		} as unknown as TautulliObservationPrisma;

		const result = await read(prisma);

		expect(result).toMatchObject({
			rows: [],
			metadata: null,
			providerStatus: { reasonCodes: ["rows-inconsistent"] },
		});
	});

	it("reads deterministic rows in pages of at most 500", async () => {
		const firstPage = Array.from({ length: 500 }, (_, index) =>
			row({ id: `row-${String(index).padStart(4, "0")}` }),
		);
		const allRows = [...firstPage, row({ id: "row-0500" })];
		const largeMetadata = metadata(501, {
			coverageReceipt: receipt({}, 501),
		});
		const { prisma, tx } = reader({
			status: {
				...status(501),
				generationMetadata: encodeTautulliObservationMetadata(largeMetadata),
			},
			pages: [firstPage, [allRows[500]]],
		});

		const result = await read(prisma);

		expect(result?.rows).toHaveLength(501);
		expect(tx.tautulliCache.findMany).toHaveBeenNthCalledWith(
			1,
			expect.objectContaining({ take: 500, orderBy: { id: "asc" } }),
		);
		expect(tx.tautulliCache.findMany).toHaveBeenNthCalledWith(
			2,
			expect.objectContaining({ skip: 1, cursor: { id: "row-0499" } }),
		);
	});

	it.each([
		[
			"repeated cursor",
			Array.from({ length: 500 }, (_, index) =>
				row({ id: `row-${String(index).padStart(4, "0")}` }),
			),
			[row({ id: "row-0000" })],
		],
		["declared-count overrun", [row(), row({ id: "row-synthetic-2" })], []],
	])("rejects %s while paging", async (_label, firstPage, secondPage) => {
		const itemCount = _label === "declared-count overrun" ? 1 : 501;
		const { prisma } = reader({
			status: {
				...status(itemCount),
				generationMetadata: encodeTautulliObservationMetadata(
					metadata(itemCount, { coverageReceipt: receipt({}, itemCount) }),
				),
			},
			pages: [firstPage, secondPage],
		});

		const result = await read(prisma);

		expect(result).toMatchObject({
			rows: [],
			metadata: null,
			providerStatus: { reasonCodes: ["rows-inconsistent"] },
		});
	});

	it("rejects a declared row count above the absolute cap before reading rows", async () => {
		const { prisma, tx } = reader({
			status: { ...status(10_001), generationMetadata: "not-read" },
		});
		const result = await read(prisma);

		expect(result).toMatchObject({
			rows: [],
			metadata: null,
			providerStatus: { reasonCodes: ["rows-inconsistent"] },
		});
		expect(tx.tautulliCache.findMany).not.toHaveBeenCalled();
	});

	it("rejects an over-cap page", async () => {
		const overCap = Array.from({ length: 501 }, (_, index) => row({ id: `row-${index}` }));
		const { prisma } = reader({ status: status(501), pages: [overCap] });
		const result = await read(prisma);
		expect(result).toMatchObject({
			rows: [],
			metadata: null,
			providerStatus: { reasonCodes: ["rows-inconsistent"] },
		});
	});

	it("retries one bounded transaction conflict from a fresh snapshot", async () => {
		const { prisma, tx } = reader({ pages: [[row()]] });
		const transaction = prisma.$transaction as ReturnType<typeof vi.fn>;
		transaction.mockReset();
		transaction.mockRejectedValueOnce(
			Object.assign(new Error("serialization failure"), { code: "P2034" }),
		);
		transaction.mockImplementationOnce(
			async (operation: (reader: MockReader) => Promise<unknown>) => operation(tx),
		);

		const result = await read(prisma);

		expect(result?.rows).toHaveLength(1);
		expect(transaction).toHaveBeenCalledTimes(2);
	});

	it("returns bounded unknown failure after three retryable conflicts", async () => {
		const { prisma } = reader();
		const transaction = prisma.$transaction as ReturnType<typeof vi.fn>;
		transaction.mockReset();
		transaction.mockRejectedValue(
			Object.assign(new Error("private database detail"), { code: "SQLITE_BUSY" }),
		);

		const result = await read(prisma);

		expect(result).toMatchObject({
			rows: [],
			metadata: null,
			providerStatus: { availability: "unavailable", reasonCodes: ["unknown-failure"] },
		});
		expect(JSON.stringify(result)).not.toContain("private");
		expect(transaction).toHaveBeenCalledTimes(3);
	});

	it("does not retry nonretryable transaction errors", async () => {
		const { prisma } = reader();
		const transaction = prisma.$transaction as ReturnType<typeof vi.fn>;
		transaction.mockReset();
		transaction.mockRejectedValue(new Error("private database detail"));

		const result = await read(prisma);

		expect(result).toMatchObject({
			rows: [],
			metadata: null,
			providerStatus: { reasonCodes: ["unknown-failure"] },
		});
		expect(transaction).toHaveBeenCalledOnce();
	});

	it("keeps the observation reader out of mutation and authority paths", async () => {
		const sourceFiles = [
			"src/lib/library-cleanup/cleanup-executor.ts",
			"src/lib/tautulli/tautulli-cache-authority.ts",
		];
		const sources = await Promise.all(
			sourceFiles.map((file) => readFile(path.resolve(process.cwd(), file), "utf8")),
		);

		for (const source of sources) {
			expect(source).not.toContain("tautulli-observation-repository");
		}
	});
});
