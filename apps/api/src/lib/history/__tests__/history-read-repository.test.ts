import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
	HISTORY_DISPLAY_TEXT_MAX_LENGTH,
	HISTORY_NORMALIZED_JSON_MAX_BYTES,
	historyNormalizedPayloadV1Schema,
	historyResponseV2Schema,
} from "@arr/shared";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PrismaClient } from "../../../generated/prisma/client.js";
import { Encryptor } from "../../auth/encryption.js";
import { type HistoryReadQuery, parseHistoryReadQuery } from "../history-read-contract.js";
import { readHistoryRepository } from "../history-read-repository.js";

const OWNER_A = "history-owner-a";
const OWNER_B = "history-owner-b";
const NOW = "2026-09-04T00:00:00.000Z";
const PUBLISHED_AT = "2026-09-03T23:00:00.000Z";
const KEY = "a".repeat(64);
const SERVICES = ["sonarr", "radarr", "prowlarr", "lidarr", "readarr"] as const;
const SERVICE_TYPES = {
	sonarr: "SONARR",
	radarr: "RADARR",
	prowlarr: "PROWLARR",
	lidarr: "LIDARR",
	readarr: "READARR",
} as const;

type Service = (typeof SERVICES)[number];

type TestSource = {
	id: string;
	userId: string;
	service: (typeof SERVICE_TYPES)[Service];
	label: string;
	enabled: boolean;
	connectionGeneration: number;
	historySourceStatus: TestStatus | null;
};

type TestStatus = {
	instanceId: string;
	connectionGeneration: number;
	publishedAt: Date | null;
	publicationMetadata: string | null;
	retainedObservationCount: number;
	lastAttemptAt: Date | null;
	lastAttemptResult: string | null;
	lastAttemptReason: string | null;
	publicationRevision: number;
	retentionEpoch: number;
};

type TestRow = {
	id: string;
	instanceId: string;
	connectionGeneration: number;
	providerEventId: number;
	eventAt: Date;
	eventTypeKey: string;
	searchText: string;
	normalizedPayload: string;
	firstObservedAt: Date;
	lastObservedAt: Date;
};

type ReaderTransactionSeams = {
	$queryRawUnsafe: ReturnType<typeof vi.fn>;
	serviceInstance: { findMany: ReturnType<typeof vi.fn> };
	historyObservation: {
		findFirst: ReturnType<typeof vi.fn>;
		findMany: ReturnType<typeof vi.fn>;
		count: ReturnType<typeof vi.fn>;
	};
};

type ReaderSeams = ReaderTransactionSeams & {
	$transaction: ReturnType<typeof vi.fn>;
};

function query(input: Record<string, unknown> = {}): HistoryReadQuery {
	const parsed = parseHistoryReadQuery(input);
	if (!parsed.ok) throw new Error("test query must be valid");
	return parsed.query;
}

function receipt(service: Service, count = 1): Record<string, unknown> {
	return {
		version: 1,
		provider: `${service}_history`,
		attemptStartedAt: PUBLISHED_AT,
		observedAt: PUBLISHED_AT,
		evidence: "positive-only",
		units: [
			{
				scopeKey: "history",
				expectedRawCount: null,
				pagesAttempted: 1,
				pagesCompleted: 1,
				rawObserved: count,
				sourceBindings: count,
				canonicalEntities: count,
				acceptedSkips: [],
				fatalCount: 0,
			},
		],
		publishedCanonicalEntities: count,
	};
}

function metadata(service: Service, count = 1): string {
	return JSON.stringify({
		version: 1,
		service,
		connectionGeneration: 1,
		publicationLevel: "positive-only",
		completeness: "partial",
		observedAt: PUBLISHED_AT,
		publishedObservationCount: count,
		coverageReceipt: receipt(service, count),
	});
}

function status(service: Service, overrides: Partial<TestStatus> = {}): TestStatus {
	return {
		instanceId: "instance-a",
		connectionGeneration: 1,
		publishedAt: new Date(PUBLISHED_AT),
		publicationMetadata: metadata(service),
		retainedObservationCount: 1,
		lastAttemptAt: null,
		lastAttemptResult: null,
		lastAttemptReason: null,
		publicationRevision: 1,
		retentionEpoch: 0,
		...overrides,
	};
}

function source(service: Service = "sonarr", overrides: Partial<TestSource> = {}): TestSource {
	const id = overrides.id ?? `instance-${service}`;
	return {
		id,
		userId: OWNER_A,
		service: SERVICE_TYPES[service],
		label: `${service} test instance`,
		enabled: true,
		connectionGeneration: 1,
		historySourceStatus: status(service, { instanceId: id }),
		...overrides,
	};
}

function payload(service: Service, providerEventId: number, eventAt: string): string {
	const common = {
		version: 1,
		providerEventId,
		eventAt,
		eventType: "download",
		title: `${service} title`,
	};
	const candidate =
		service === "sonarr"
			? { ...common, service, seriesId: 10, episodeId: 11 }
			: service === "radarr"
				? { ...common, service, movieId: 20, movieSlug: "movie" }
				: service === "prowlarr"
					? { ...common, service, indexerId: 30 }
					: service === "lidarr"
						? { ...common, service, artistId: 40, albumId: 41, trackId: 42 }
						: { ...common, service, authorId: 50, bookId: 51 };
	return JSON.stringify(historyNormalizedPayloadV1Schema.parse(candidate));
}

function row(service: Service = "sonarr", overrides: Partial<TestRow> = {}): TestRow {
	const eventAt = overrides.eventAt ?? new Date("2026-09-03T22:00:00.000Z");
	const instanceId = overrides.instanceId ?? `instance-${service}`;
	const providerEventId = overrides.providerEventId ?? 1;
	return {
		id: `${instanceId}-row-${providerEventId}`,
		instanceId,
		connectionGeneration: 1,
		providerEventId,
		eventAt,
		eventTypeKey: "download",
		searchText: `${service} title download`,
		normalizedPayload: payload(service, providerEventId, eventAt.toISOString()),
		firstObservedAt: new Date("2026-09-03T21:00:00.000Z"),
		lastObservedAt: new Date("2026-09-03T22:00:00.000Z"),
		...overrides,
	};
}

function reader(
	options: {
		sources?: TestSource[];
		rows?: TestRow[];
		now?: unknown;
		transactionError?: unknown;
	} = {},
): { prisma: ReaderSeams; tx: ReaderTransactionSeams } {
	const tx = {
		$queryRawUnsafe: vi.fn().mockResolvedValue([{ now: options.now ?? "2026-09-04 00:00:00" }]),
		serviceInstance: {
			findMany: vi.fn().mockResolvedValue(options.sources ?? [source()]),
		},
		historyObservation: {
			findFirst: vi.fn().mockResolvedValue((options.rows ?? [row()])[0] ?? null),
			findMany: vi.fn().mockResolvedValue(options.rows ?? [row()]),
			count: vi.fn().mockResolvedValue((options.rows ?? [row()]).length),
		},
	};
	const prisma = {
		...tx,
		$transaction: vi
			.fn()
			.mockImplementation(async (operation: (tx: ReaderTransactionSeams) => unknown) => {
				if (options.transactionError) throw options.transactionError;
				return operation(tx);
			}),
	};
	return { prisma, tx };
}

async function read(
	prisma: Parameters<typeof readHistoryRepository>[0]["prisma"],
	input: Partial<{
		ownerId: string;
		encryptor: Pick<Encryptor, "encrypt" | "decrypt">;
		dialect: "sqlite" | "postgresql";
		query: HistoryReadQuery;
	}> = {},
) {
	return readHistoryRepository({
		prisma,
		encryptor: input.encryptor ?? new Encryptor(KEY),
		dialect: input.dialect ?? "sqlite",
		ownerId: input.ownerId ?? OWNER_A,
		query: input.query ?? query(),
	});
}

function containsPredicate(value: unknown, expected: Record<string, unknown>): boolean {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const record = value as Record<string, unknown>;
	if (
		Object.entries(expected).every(([key, wanted]) => {
			const actual = record[key];
			if (actual instanceof Date && wanted instanceof Date)
				return actual.getTime() === wanted.getTime();
			return actual === wanted;
		})
	)
		return true;
	return Object.values(record).some((candidate) => containsPredicate(candidate, expected));
}

function expectPredicate(value: unknown, expected: Record<string, unknown>): void {
	expect(containsPredicate(value, expected)).toBe(true);
}

function hasProwlarrRssConjunction(value: unknown): boolean {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const record = value as Record<string, unknown>;
	const not = record.NOT;
	if (typeof not === "object" && not !== null && !Array.isArray(not)) {
		const notRecord = not as Record<string, unknown>;
		if (
			containsPredicate(notRecord.instance, { service: "PROWLARR" }) &&
			containsPredicate(notRecord.eventTypeKey, { contains: "rss" })
		)
			return true;
		if (Array.isArray(notRecord.AND)) {
			return (
				containsPredicate(notRecord.AND, { service: "PROWLARR" }) &&
				containsPredicate(notRecord.AND, { contains: "rss" })
			);
		}
		if (Object.hasOwn(notRecord, "OR")) return false;
	}
	return Object.values(record).some((candidate) => hasProwlarrRssConjunction(candidate));
}

function expectOwnerFence(value: unknown, ownerId = OWNER_A): void {
	const record = value as { instance?: unknown };
	expect(record.instance).toEqual({ userId: ownerId });
}

describe("owner-scoped History read repository", () => {
	it("uses database time and a bounded Serializable transaction, with an exact source owner fence", async () => {
		const { prisma, tx } = reader();
		await read(prisma);

		expect(prisma.$transaction).toHaveBeenCalledWith(expect.any(Function), {
			isolationLevel: "Serializable",
			timeout: expect.any(Number),
		});
		expect(tx.$queryRawUnsafe).toHaveBeenCalledWith(expect.stringContaining("CURRENT_TIMESTAMP"));
		const [sourceArgs] = tx.serviceInstance.findMany.mock.calls[0] ?? [];
		expect(sourceArgs).toMatchObject({
			where: { userId: OWNER_A, enabled: true },
			orderBy: { id: "asc" },
			take: 1001,
		});
	});

	it("repeats the relational owner predicate on anchor, page, and exact count queries", async () => {
		const first = reader({ rows: [row(), row("sonarr", { providerEventId: 2 })] });
		const initial = await read(first.prisma, { query: query({ limit: "1" }) });
		if (initial.kind !== "ok") throw new Error("expected a first page cursor");

		const next = reader({ rows: [row(), row("sonarr", { providerEventId: 2 })] });
		await read(next.prisma, {
			query: query({ limit: "1", cursor: initial.response.pageInfo.nextCursor! }),
		});
		const [anchorArgs] = next.tx.historyObservation.findFirst.mock.calls[0] ?? [];
		const [pageArgs] = next.tx.historyObservation.findMany.mock.calls[0] ?? [];
		const [countArgs] = next.tx.historyObservation.count.mock.calls[0] ?? [];
		expectOwnerFence(anchorArgs.where);
		expectOwnerFence(pageArgs.where);
		expectOwnerFence(countArgs.where);
	});

	it("does not query observations when every source lacks positive publication authority", async () => {
		const { prisma, tx } = reader({
			sources: [source("sonarr", { historySourceStatus: null })],
			rows: [row()],
		});
		const result = await read(prisma);
		expect(result).toMatchObject({
			kind: "ok",
			response: { items: [], pageInfo: { matchingObservedCount: 0, hasNextPage: false } },
		});
		expect(tx.historyObservation.findFirst).not.toHaveBeenCalled();
		expect(tx.historyObservation.findMany).not.toHaveBeenCalled();
		expect(tx.historyObservation.count).not.toHaveBeenCalled();
	});

	it("keeps an unavailable source in the catalog while retaining healthy rows", async () => {
		const unavailable = source("radarr", {
			id: "instance-unavailable",
			historySourceStatus: null,
		});
		const healthy = source("sonarr", { id: "instance-healthy" });
		const { prisma } = reader({
			sources: [unavailable, healthy],
			rows: [row("sonarr", { instanceId: "instance-healthy" })],
		});
		const result = await read(prisma);
		if (result.kind !== "ok") throw new Error("expected response");
		expect(result.response.items).toHaveLength(1);
		expect(result.response.sources).toHaveLength(2);
		expect(
			result.response.sources.find((item) => item.instanceId === "instance-unavailable"),
		).toMatchObject({
			retainedObservationCount: 0,
			providerStatus: { availability: "unavailable" },
		});
		expect(historyResponseV2Schema.safeParse(result.response).success).toBe(true);
	});

	it("returns exact v2 item/source/page keys without database payload fields", async () => {
		const { prisma } = reader({ rows: [row()] });
		const result = await read(prisma);
		if (result.kind !== "ok") throw new Error("expected response");
		expect(historyResponseV2Schema.safeParse(result.response).success).toBe(true);
		expect(Object.keys(result.response.items[0] ?? {}).sort()).toEqual(
			[
				"episodeId",
				"eventAt",
				"eventType",
				"id",
				"instanceId",
				"instanceName",
				"providerEventId",
				"seriesId",
				"service",
				"title",
			].sort(),
		);
		expect(Object.keys(result.response.sources[0] ?? {}).sort()).toEqual(
			[
				"instanceId",
				"instanceName",
				"providerStatus",
				"retainedObservationCount",
				"service",
			].sort(),
		);
		expect(Object.keys(result.response.pageInfo).sort()).toEqual(
			["hasNextPage", "matchingObservedCount", "nextCursor"].sort(),
		);
		for (const forbidden of ["normalizedPayload", "searchText", "lastObservedAt", "arbitrary"]) {
			expect(result.response).not.toHaveProperty(forbidden);
			expect(result.response.items[0]).not.toHaveProperty(forbidden);
			expect(result.response.sources[0]).not.toHaveProperty(forbidden);
		}
	});

	it("keeps prior positive publication authority after a later failed attempt", async () => {
		const { prisma } = reader({
			sources: [
				source("sonarr", {
					historySourceStatus: status("sonarr", {
						lastAttemptAt: new Date("2026-09-03T23:30:00.000Z"),
						lastAttemptResult: "error",
						lastAttemptReason: "provider-unavailable",
					}),
				}),
			],
			rows: [row()],
		});
		const result = await read(prisma);
		expect(result).toMatchObject({ kind: "ok", response: { items: [expect.any(Object)] } });
	});

	it.each([
		["malformed status", { publicationMetadata: "{" }],
		["mismatched-generation status", { connectionGeneration: 2 }],
		["future publication", { publishedAt: new Date("2026-09-05T00:00:00.000Z") }],
		["unverified publication", { publishedAt: null, publicationMetadata: null }],
	] as const)(
		"marks a source unavailable for %s and excludes its rows",
		async (_name, overrides) => {
			const { prisma, tx } = reader({
				sources: [source("sonarr", { historySourceStatus: status("sonarr", overrides) })],
				rows: [row()],
			});
			const result = await read(prisma);
			expect(result).toMatchObject({
				kind: "ok",
				response: { items: [], pageInfo: { matchingObservedCount: 0 } },
			});
			expect(tx.historyObservation.findMany).not.toHaveBeenCalled();
		},
	);

	it.each([
		["unsafe id", { id: "instance-unsafe\n" }],
		["unsafe label", { label: "unsafe\u0000label" }],
		["unsupported service", { service: "PLEX" as TestSource["service"] }],
		["negative generation", { connectionGeneration: -1 }],
		["fractional generation", { connectionGeneration: 1.5 }],
	] as const)("fails closed on malformed core source %s", async (_name, overrides) => {
		const { prisma, tx } = reader({ sources: [source("sonarr", overrides)] });
		expect(await read(prisma)).toEqual({ kind: "unavailable" });
		expect(tx.historyObservation.findMany).not.toHaveBeenCalled();
	});

	it.each([
		["negative retained count", { retainedObservationCount: -1 }],
		["fractional retained count", { retainedObservationCount: 1.5 }],
		["negative publication revision", { publicationRevision: -1 }],
		["fractional publication revision", { publicationRevision: 1.5 }],
		["negative retention epoch", { retentionEpoch: -1 }],
		["fractional retention epoch", { retentionEpoch: 1.5 }],
		["invalid publication date", { publishedAt: new Date("invalid") }],
		["malformed status object", { publicationMetadata: { bad: true } as never }],
	] as const)("sanitizes malformed source status %s as unavailable", async (_name, overrides) => {
		const { prisma, tx } = reader({
			sources: [source("sonarr", { historySourceStatus: status("sonarr", overrides) })],
			rows: [row()],
		});
		const result = await read(prisma);
		expect(result).toMatchObject({
			kind: "ok",
			response: {
				items: [],
				pageInfo: { matchingObservedCount: 0 },
				sources: [{ retainedObservationCount: 0, providerStatus: { availability: "unavailable" } }],
			},
		});
		expect(tx.historyObservation.findMany).not.toHaveBeenCalled();
	});

	it.each([
		["sonarr", { seriesId: 10, episodeId: 11 }],
		["radarr", { movieId: 20 }],
		["prowlarr", { indexerId: 30 }],
		["lidarr", { artistId: 40, albumId: 41, trackId: 42 }],
		["readarr", { authorId: 50, bookId: 51 }],
	] as const)("decodes and returns the strict %s item branch", async (service, fields) => {
		const instanceId = `instance-${service}`;
		const { prisma } = reader({
			sources: [source(service, { id: instanceId })],
			rows: [row(service, { instanceId })],
		});
		const result = await read(prisma);
		if (result.kind !== "ok") throw new Error("expected response");
		expect(result.response.items[0]).toMatchObject({ service, instanceId, ...fields });
		expect(result.response.items[0]).not.toHaveProperty("version");
	});

	it.each([
		["malformed normalized payload", { normalizedPayload: "{" }],
		[
			"cross-service payload",
			{ normalizedPayload: payload("radarr", 1, "2026-09-03T22:00:00.000Z") },
		],
		[
			"provider identity mismatch",
			{ normalizedPayload: payload("sonarr", 99, "2026-09-03T22:00:00.000Z") },
		],
		["event identity mismatch", { eventTypeKey: "grabbed" }],
		[
			"event time identity mismatch",
			{ normalizedPayload: payload("sonarr", 1, "2026-09-03T23:00:00.000Z") },
		],
		["future first observation", { firstObservedAt: new Date("2026-09-05T00:00:00.000Z") }],
	] as const)(
		"fails closed on %s rather than skipping a selected row",
		async (_name, overrides) => {
			const { prisma } = reader({ rows: [row("sonarr", overrides)] });
			expect(await read(prisma)).toEqual({ kind: "unavailable" });
		},
	);

	it("sorts equal event times by descending local observation ID and reads limit plus one", async () => {
		const rows = [
			row("sonarr", {
				id: "row-a",
				providerEventId: 1,
				eventAt: new Date("2026-09-03T22:00:00.000Z"),
			}),
			row("sonarr", {
				id: "row-b",
				providerEventId: 2,
				eventAt: new Date("2026-09-03T22:00:00.000Z"),
			}),
		];
		const { prisma, tx } = reader({ rows });
		const result = await read(prisma, { query: query({ limit: "1" }) });
		if (result.kind !== "ok") throw new Error("expected response");
		expect(tx.historyObservation.findMany.mock.calls[0]?.[0]).toMatchObject({ take: 2 });
		expect(tx.historyObservation.findMany.mock.calls[0]?.[0]).toMatchObject({
			orderBy: [{ eventAt: "desc" }, { id: "desc" }],
		});
		expect(result.response.items).toHaveLength(1);
		expect(result.response.pageInfo).toMatchObject({ hasNextPage: true, matchingObservedCount: 2 });
	});

	it("fails closed when the visible page has an inconsistent lookahead row", async () => {
		const { prisma } = reader({ rows: [row(), row("sonarr", { normalizedPayload: "{" })] });
		await expect(read(prisma, { query: query({ limit: "1" }) })).resolves.toEqual({
			kind: "unavailable",
		});

		const futureLookahead = reader({
			rows: [
				row(),
				row("sonarr", {
					firstObservedAt: new Date("2026-09-05T00:00:00.000Z"),
				}),
			],
		});
		await expect(read(futureLookahead.prisma, { query: query({ limit: "1" }) })).resolves.toEqual({
			kind: "unavailable",
		});
	});

	it("applies every filter alone and in one canonical composition, including only Prowlarr RSS exclusion", async () => {
		const filters = [
			[
				"start date",
				{ startDate: "2026-09-03T20:00:00.000Z" },
				{ gte: new Date("2026-09-03T20:00:00.000Z") },
			],
			[
				"end date",
				{ endDate: "2026-09-03T23:00:00.000Z" },
				{ lte: new Date("2026-09-03T23:00:00.000Z") },
			],
			["search", { search: "SONARR" }, { contains: "sonarr" }],
			["service", { service: "sonarr" }, { service: "SONARR" }],
			["instance", { instanceId: "instance-sonarr" }, { instanceId: "instance-sonarr" }],
			["event type", { eventType: "download" }, { eventTypeKey: "download" }],
		] as const;
		for (const [_name, filter, predicate] of filters) {
			const { prisma, tx } = reader({ rows: [row()] });
			await read(prisma, { query: query(filter) });
			const [findManyArgs] = tx.historyObservation.findMany.mock.calls[0] ?? [];
			expectPredicate(findManyArgs.where, predicate);
			const [countArgs] = tx.historyObservation.count.mock.calls[0] ?? [];
			expectPredicate(countArgs.where, predicate);
		}
		const { prisma, tx } = reader({
			sources: [source("sonarr"), source("prowlarr")],
			rows: [row("sonarr"), row("prowlarr")],
		});
		await read(prisma, {
			query: query({
				startDate: "2026-09-03T20:00:00.000Z",
				endDate: "2026-09-03T23:00:00.000Z",
				search: "  SONARR  ",
				service: "sonarr",
				instanceId: "instance-sonarr",
				eventType: " DOWNLOAD ",
				hideProwlarrRss: "true",
			}),
		});
		const [composedArgs] = tx.historyObservation.findMany.mock.calls[0] ?? [];
		expectPredicate(composedArgs.where, { gte: new Date("2026-09-03T20:00:00.000Z") });
		expectPredicate(composedArgs.where, { lte: new Date("2026-09-03T23:00:00.000Z") });
		expectPredicate(composedArgs.where, { contains: "sonarr" });
		expectPredicate(composedArgs.where, { service: "SONARR" });
		expectPredicate(composedArgs.where, { instanceId: "instance-sonarr" });
		expectPredicate(composedArgs.where, { eventTypeKey: "download" });
		expectPredicate(composedArgs.where, { service: "PROWLARR" });
		expectPredicate(composedArgs.where, { contains: "rss" });

		const hideOnly = reader({
			sources: [source("sonarr"), source("prowlarr")],
			rows: [
				row("sonarr", {
					eventTypeKey: "rss-import",
					normalizedPayload: payload("sonarr", 1, "2026-09-03T22:00:00.000Z").replace(
						'"eventType":"download"',
						'"eventType":"rss-import"',
					),
				}),
			],
		});
		const hideResult = await read(hideOnly.prisma, { query: query({ hideProwlarrRss: "true" }) });
		expect(hideResult).toMatchObject({ kind: "ok", response: { items: [expect.any(Object)] } });
		if (hideResult.kind === "ok") expect(hideResult.response.items[0]?.service).toBe("sonarr");
		const [hideArgs] = hideOnly.tx.historyObservation.findMany.mock.calls[0] ?? [];
		const hideWhere = hideArgs.where as Record<string, unknown>;
		expect(hasProwlarrRssConjunction(hideWhere)).toBe(true);
		expect(JSON.stringify(hideWhere)).not.toContain('"mode"');
		// The returned Sonarr rss-import row proves non-Prowlarr eligibility; the helper rejects NOT: OR.
	});

	it("accepts shared-bound display and payload text above the repository local limit", async () => {
		const longLabel = "L".repeat(300);
		const longTitle = "T".repeat(300);
		expect(longLabel.length).toBeGreaterThan(256);
		expect(longLabel.length).toBeLessThanOrEqual(HISTORY_DISPLAY_TEXT_MAX_LENGTH);
		const normalizedPayload = payload("sonarr", 1, "2026-09-03T22:00:00.000Z").replace(
			'"title":"sonarr title"',
			`"title":"${longTitle}"`,
		);
		expect(new TextEncoder().encode(normalizedPayload).byteLength).toBeLessThanOrEqual(
			HISTORY_NORMALIZED_JSON_MAX_BYTES,
		);
		const { prisma } = reader({
			sources: [source("sonarr", { label: longLabel })],
			rows: [
				row("sonarr", { searchText: `download ${longTitle.toLowerCase()}`, normalizedPayload }),
			],
		});
		const result = await read(prisma);
		expect(result).toMatchObject({ kind: "ok" });
		if (result.kind === "ok") {
			expect(result.response.sources[0]?.instanceName).toBe(longLabel);
			expect(result.response.items[0]?.title).toBe(longTitle);
		}
	});

	it("rejects URL-like source identifiers before any observation query", async () => {
		const { prisma, tx } = reader({ sources: [source("sonarr", { id: "https://private" })] });
		expect(await read(prisma)).toEqual({ kind: "unavailable" });
		expect(tx.historyObservation.findMany).not.toHaveBeenCalled();
	});

	it("sanitizes an arbitrary transaction root result", async () => {
		const { prisma } = reader();
		prisma.$transaction.mockResolvedValue({ arbitrary: true });
		expect(await read(prisma)).toEqual({ kind: "unavailable" });
	});

	it("reuses a fixed snapshot while resuming the keyset without duplicates", async () => {
		const rows = [
			row("sonarr", { id: "row-2", providerEventId: 2 }),
			row("sonarr", { id: "row-1", providerEventId: 1 }),
		];
		const first = reader({ rows });
		const firstResult = await read(first.prisma, { query: query({ limit: "1" }) });
		if (firstResult.kind !== "ok") throw new Error("expected first page");
		expect(firstResult.response.items.map((item) => item.id)).toEqual(["row-2"]);
		const resumed = reader({
			rows: [row("sonarr", { id: "row-1", providerEventId: 1 })],
		});
		const secondResult = await read(resumed.prisma, {
			query: query({ limit: "1", cursor: firstResult.response.pageInfo.nextCursor! }),
		});
		expect(secondResult).toMatchObject({ kind: "ok" });
		if (secondResult.kind === "ok")
			expect(secondResult.response.items.map((item) => item.id)).toEqual(["row-1"]);
	});

	it("binds issuedAt and snapshotAt to database CURRENT_TIMESTAMP and expires at exactly thirty minutes", async () => {
		let issuedPlaintext: string | null = null;
		const realEncryptor = new Encryptor(KEY);
		const encryptor = {
			encrypt: (plaintext: string) => {
				issuedPlaintext = plaintext;
				return realEncryptor.encrypt(plaintext);
			},
			decrypt: realEncryptor.decrypt.bind(realEncryptor),
		};
		const initial = reader({ rows: [row(), row("sonarr", { providerEventId: 2 })] });
		const firstResult = await read(initial.prisma, {
			encryptor,
			query: query({ limit: "1" }),
		});
		if (firstResult.kind !== "ok" || !issuedPlaintext)
			throw new Error("expected database-bound cursor");
		const plaintext = JSON.parse(issuedPlaintext) as Record<string, unknown>;
		expect(plaintext.issuedAt).toBe(NOW);
		expect(plaintext.snapshotAt).toBe(NOW);
		expect(plaintext.expiresAt).toBe("2026-09-04T00:30:00.000Z");

		const expired = reader({
			now: "2026-09-04 00:30:00",
			rows: [row("sonarr", { providerEventId: 2 })],
		});
		const expiredResult = await read(expired.prisma, {
			encryptor: realEncryptor,
			query: query({ limit: "1", cursor: firstResult.response.pageInfo.nextCursor! }),
		});
		expect(expiredResult).toEqual({ kind: "cursor-invalid" });
		expect(expired.tx.historyObservation.findFirst).not.toHaveBeenCalled();
	});

	it.each([
		["topology", (sources: TestSource[]) => [...sources, source("radarr", { id: "new-source" })]],
		[
			"service",
			(sources: TestSource[]) =>
				sources.map((item) => ({
					...item,
					service: "RADARR" as const,
					historySourceStatus: status("radarr", { instanceId: item.id }),
				})),
		],
		[
			"generation",
			(sources: TestSource[]) => sources.map((item) => ({ ...item, connectionGeneration: 2 })),
		],
		[
			"publication revision",
			(sources: TestSource[]) =>
				sources.map((item) => ({
					...item,
					historySourceStatus: status("sonarr", { instanceId: item.id, publicationRevision: 2 }),
				})),
		],
		[
			"retention epoch",
			(sources: TestSource[]) =>
				sources.map((item) => ({
					...item,
					historySourceStatus: status("sonarr", { instanceId: item.id, retentionEpoch: 1 }),
				})),
		],
		[
			"row authority",
			(sources: TestSource[]) => sources.map((item) => ({ ...item, historySourceStatus: null })),
		],
	] as const)(
		"returns cursor-stale when %s changes before anchor validation",
		async (_name, mutate) => {
			const initial = reader({ rows: [row(), row("sonarr", { providerEventId: 2 })] });
			const firstResult = await read(initial.prisma, { query: query({ limit: "1" }) });
			if (firstResult.kind !== "ok") throw new Error("expected cursor");
			const next = reader({ sources: mutate([source()]), rows: [row()] });
			const result = await read(next.prisma, {
				query: query({ limit: "1", cursor: firstResult.response.pageInfo.nextCursor! }),
			});
			expect(result).toEqual({ kind: "cursor-stale" });
			expect(next.tx.historyObservation.findFirst).not.toHaveBeenCalled();
		},
	);

	it("stales a prior cursor before anchor validation when re-observation changes row membership or payload", async () => {
		const initial = reader({ rows: [row(), row("sonarr", { providerEventId: 2 })] });
		const firstResult = await read(initial.prisma, { query: query({ limit: "1" }) });
		if (firstResult.kind !== "ok") throw new Error("expected cursor");
		const changedSource = source("sonarr", {
			historySourceStatus: status("sonarr", { publicationRevision: 2 }),
		});
		const changedRow = row("sonarr", {
			searchText: "changed membership",
			normalizedPayload: payload("sonarr", 1, "2026-09-03T22:00:00.000Z").replace(
				"sonarr title",
				"changed payload",
			),
		});
		const next = reader({ sources: [changedSource], rows: [changedRow] });
		const result = await read(next.prisma, {
			query: query({ limit: "1", cursor: firstResult.response.pageInfo.nextCursor! }),
		});
		expect(result).toEqual({ kind: "cursor-stale" });
		expect(next.tx.historyObservation.findFirst).not.toHaveBeenCalled();
	});

	it("stales when an unavailable source gains its first current positive status", async () => {
		const healthy = source("sonarr", { id: "healthy-source" });
		const absent = source("radarr", { id: "newly-published-source", historySourceStatus: null });
		const initial = reader({
			sources: [healthy, absent],
			rows: [
				row("sonarr", { instanceId: "healthy-source" }),
				row("sonarr", { instanceId: "healthy-source", providerEventId: 2 }),
			],
		});
		const firstResult = await read(initial.prisma, { query: query({ limit: "1" }) });
		if (firstResult.kind !== "ok") throw new Error("expected cursor");
		const nowPublished = source("radarr", {
			id: "newly-published-source",
			historySourceStatus: status("radarr", { instanceId: "newly-published-source" }),
		});
		const next = reader({
			sources: [healthy, nowPublished],
			rows: [row("sonarr", { instanceId: "healthy-source" })],
		});
		const result = await read(next.prisma, {
			query: query({ limit: "1", cursor: firstResult.response.pageInfo.nextCursor! }),
		});
		expect(result).toEqual({ kind: "cursor-stale" });
		expect(next.tx.historyObservation.findFirst).not.toHaveBeenCalled();
	});

	it("maps malformed, owner, filter, and limit cursor bindings to cursor-invalid", async () => {
		const initial = reader({ rows: [row(), row("sonarr", { providerEventId: 2 })] });
		const firstResult = await read(initial.prisma, { query: query({ limit: "1" }) });
		if (firstResult.kind !== "ok") throw new Error("expected cursor");
		const cursor = firstResult.response.pageInfo.nextCursor!;
		for (const [ownerId, requested] of [
			[OWNER_A, query({ limit: "1", cursor: "not-a-valid-cursor" })],
			[OWNER_B, query({ limit: "1", cursor })],
			[OWNER_A, query({ limit: "1", cursor, search: "other" })],
			[OWNER_A, query({ limit: "2", cursor })],
		] as const) {
			const result = await read(reader().prisma, { ownerId, query: requested });
			expect(result).toEqual({ kind: "cursor-invalid" });
		}
	});

	it("maps an impossible anchor to cursor-invalid after a matching source digest", async () => {
		const initial = reader({ rows: [row(), row("sonarr", { providerEventId: 2 })] });
		const firstResult = await read(initial.prisma, { query: query({ limit: "1" }) });
		if (firstResult.kind !== "ok") throw new Error("expected cursor");
		const next = reader({ rows: [] });
		const result = await read(next.prisma, {
			query: query({ limit: "1", cursor: firstResult.response.pageInfo.nextCursor! }),
		});
		expect(result).toEqual({ kind: "cursor-invalid" });
	});

	it("sanitizes database, encryption, projection, and malformed test-seam failures", async () => {
		const databaseFailure = await read(
			reader({ transactionError: new Error("secret database title https://private") }).prisma,
		);
		expect(databaseFailure).toEqual({ kind: "unavailable" });
		const encryptionFailure = await read(
			reader({ rows: [row(), row("sonarr", { providerEventId: 2 })] }).prisma,
			{
				encryptor: {
					encrypt: () => {
						throw new Error("secret cursor plaintext");
					},
					decrypt: () => {
						throw new Error("secret cursor ciphertext");
					},
				},
				query: query({ limit: "1" }),
			},
		);
		expect(encryptionFailure).toEqual({ kind: "unavailable" });
		expect(await read(reader({ now: [] }).prisma)).toEqual({ kind: "unavailable" });
	});

	it("uses the explicit PostgreSQL timestamp dialect and the same finite transaction contract", async () => {
		const { prisma, tx } = reader();
		await read(prisma, { dialect: "postgresql" });
		expect(tx.$queryRawUnsafe).toHaveBeenCalledWith(expect.stringContaining("CURRENT_TIMESTAMP"));
		expect(prisma.$transaction).toHaveBeenCalledWith(expect.any(Function), {
			isolationLevel: "Serializable",
			timeout: expect.any(Number),
		});
	});

	it("has no provider/client or logger seam in the repository module", () => {
		const implementation = readFileSync(
			resolve(process.cwd(), "src/lib/history/history-read-repository.ts"),
			"utf8",
		);
		expect(implementation).not.toMatch(
			/ArrClientFactory|executeOnInstances|historyCollector|providerRequest|console\.(log|error)/u,
		);
	});

	it("fails closed rather than truncating a 1,001-source catalog", async () => {
		const sources = Array.from({ length: 1001 }, (_, index) =>
			source("sonarr", { id: `instance-${index.toString().padStart(4, "0")}` }),
		);
		const { prisma, tx } = reader({ sources });
		const result = await read(prisma);
		expect(result).toEqual({ kind: "unavailable" });
		expect(tx.serviceInstance.findMany.mock.calls[0]?.[0]).toMatchObject({ take: 1001 });
	});
});

describe("History read repository disposable SQLite integration", { timeout: 30_000 }, () => {
	const schema = resolve(process.cwd(), "prisma/schema.prisma");
	let directory: string;
	let prisma: InstanceType<typeof PrismaClient>;

	beforeAll(async () => {
		directory = mkdtempSync(join(tmpdir(), "history-read-repository-"));
		const databasePath = join(directory, "history.db");
		execFileSync("pnpm", ["exec", "prisma", "db", "push", "--schema", schema], {
			cwd: process.cwd(),
			env: { ...process.env, DATABASE_URL: `file:${databasePath}` },
			stdio: "pipe",
		});
		prisma = new PrismaClient({
			adapter: new PrismaBetterSqlite3({ url: databasePath, timeout: 10_000 }),
		});
		await prisma.$connect();
	}, 120_000);

	beforeEach(async () => {
		await prisma.historyObservation.deleteMany();
		await prisma.historySourceStatus.deleteMany();
		await prisma.serviceInstance.deleteMany();
		await prisma.user.deleteMany();
	});

	afterAll(async () => {
		await prisma.$disconnect();
		rmSync(directory, { recursive: true, force: true });
	});

	it("proves owner/generation fences, deterministic two-page resume, exact count, and stale retention cursor", async () => {
		await prisma.user.createMany({
			data: [
				{ id: OWNER_A, username: OWNER_A, hashedPassword: "synthetic" },
				{ id: OWNER_B, username: OWNER_B, hashedPassword: "synthetic" },
			],
		});
		await prisma.serviceInstance.createMany({
			data: [
				{
					id: "sqlite-sonarr-a",
					userId: OWNER_A,
					service: "SONARR",
					label: "Sonarr A",
					baseUrl: "http://sonarr.invalid",
					encryptedApiKey: "x",
					encryptionIv: "x",
					connectionGeneration: 2,
				},
				{
					id: "sqlite-radarr-a",
					userId: OWNER_A,
					service: "RADARR",
					label: "Radarr A unavailable",
					baseUrl: "http://radarr.invalid",
					encryptedApiKey: "x",
					encryptionIv: "x",
					connectionGeneration: 1,
				},
				{
					id: "sqlite-sonarr-b",
					userId: OWNER_B,
					service: "SONARR",
					label: "Sonarr B",
					baseUrl: "http://sonarr-b.invalid",
					encryptedApiKey: "x",
					encryptionIv: "x",
					connectionGeneration: 2,
				},
			],
		});
		await prisma.historySourceStatus.create({
			data: {
				instanceId: "sqlite-sonarr-a",
				connectionGeneration: 2,
				publishedAt: new Date(PUBLISHED_AT),
				publicationMetadata: metadata("sonarr", 3).replace(
					'"connectionGeneration":1',
					'"connectionGeneration":2',
				),
				retainedObservationCount: 3,
				publicationRevision: 4,
				retentionEpoch: 7,
			},
		});
		await prisma.historySourceStatus.create({
			data: { instanceId: "sqlite-radarr-a", connectionGeneration: 1 },
		});
		await prisma.historySourceStatus.create({
			data: {
				instanceId: "sqlite-sonarr-b",
				connectionGeneration: 2,
				publishedAt: new Date(PUBLISHED_AT),
				publicationMetadata: metadata("sonarr", 1).replace(
					'"connectionGeneration":1',
					'"connectionGeneration":2',
				),
				retainedObservationCount: 1,
			},
		});
		await prisma.historyObservation.createMany({
			data: [
				row("sonarr", {
					id: "sqlite-row-a",
					instanceId: "sqlite-sonarr-a",
					connectionGeneration: 2,
					providerEventId: 1,
					eventAt: new Date("2026-09-03T22:00:00.000Z"),
					normalizedPayload: payload("sonarr", 1, "2026-09-03T22:00:00.000Z"),
				}),
				row("sonarr", {
					id: "sqlite-row-b",
					instanceId: "sqlite-sonarr-a",
					connectionGeneration: 2,
					providerEventId: 2,
					eventAt: new Date("2026-09-03T22:00:00.000Z"),
					normalizedPayload: payload("sonarr", 2, "2026-09-03T22:00:00.000Z"),
				}),
				row("sonarr", {
					id: "sqlite-row-c",
					instanceId: "sqlite-sonarr-a",
					connectionGeneration: 1,
					providerEventId: 3,
					eventAt: new Date("2026-09-03T21:00:00.000Z"),
					normalizedPayload: payload("sonarr", 3, "2026-09-03T21:00:00.000Z"),
				}),
				row("sonarr", {
					id: "sqlite-row-owner-b",
					instanceId: "sqlite-sonarr-b",
					connectionGeneration: 2,
					providerEventId: 4,
					eventAt: new Date("2026-09-03T23:00:00.000Z"),
					normalizedPayload: payload("sonarr", 4, "2026-09-03T23:00:00.000Z"),
				}),
			],
		});

		const first = await read(prisma, { query: query({ limit: "1" }) });
		expect(first).toMatchObject({ kind: "ok" });
		if (first.kind !== "ok") return;
		expect(first.response.items.map((item) => item.id)).toEqual(["sqlite-row-b"]);
		expect(first.response.pageInfo).toMatchObject({ matchingObservedCount: 2, hasNextPage: true });
		expect(
			first.response.sources.find((item) => item.instanceId === "sqlite-radarr-a"),
		).toMatchObject({
			retainedObservationCount: 0,
			providerStatus: { availability: "unavailable" },
		});

		const [databaseNow] = await prisma.$queryRawUnsafe<Array<{ now: string }>>(
			"SELECT CURRENT_TIMESTAMP AS now",
		);
		if (!databaseNow) throw new Error("expected database timestamp");
		const insertedAfterSnapshot = new Date(`${databaseNow.now.replace(" ", "T")}Z`);
		insertedAfterSnapshot.setSeconds(insertedAfterSnapshot.getSeconds() + 1);
		await prisma.historyObservation.create({
			data: {
				...row("sonarr", {
					id: "sqlite-row-later",
					instanceId: "sqlite-sonarr-a",
					connectionGeneration: 2,
					providerEventId: 5,
					eventAt: new Date("2026-09-03T21:30:00.000Z"),
					firstObservedAt: insertedAfterSnapshot,
					normalizedPayload: payload("sonarr", 5, "2026-09-03T21:30:00.000Z"),
				}),
			},
		});
		const restarted = new PrismaClient({
			adapter: new PrismaBetterSqlite3({ url: join(directory, "history.db"), timeout: 10_000 }),
		});
		await restarted.$connect();
		const second = await read(restarted, {
			query: query({ limit: "1", cursor: first.response.pageInfo.nextCursor! }),
		});
		expect(second).toMatchObject({ kind: "ok" });
		if (second.kind === "ok") {
			expect(second.response.items.map((item) => item.id)).toEqual(["sqlite-row-a"]);
			expect(second.response.pageInfo).toMatchObject({
				matchingObservedCount: 2,
				hasNextPage: false,
			});
		}
		await restarted.$disconnect();

		await prisma.historySourceStatus.update({
			where: { instanceId: "sqlite-sonarr-a" },
			data: { retentionEpoch: 8 },
		});
		const stale = await read(prisma, {
			query: query({ limit: "1", cursor: first.response.pageInfo.nextCursor! }),
		});
		expect(stale).toEqual({ kind: "cursor-stale" });
	});

	it("excludes only Prowlarr RSS events in populated SQLite", async () => {
		await prisma.user.create({
			data: { id: OWNER_A, username: OWNER_A, hashedPassword: "synthetic" },
		});
		await prisma.serviceInstance.createMany({
			data: [
				{
					id: "sqlite-rss-sonarr",
					userId: OWNER_A,
					service: "SONARR",
					label: "Sonarr RSS",
					baseUrl: "http://sonarr.invalid",
					encryptedApiKey: "x",
					encryptionIv: "x",
					connectionGeneration: 1,
				},
				{
					id: "sqlite-rss-prowlarr",
					userId: OWNER_A,
					service: "PROWLARR",
					label: "Prowlarr RSS",
					baseUrl: "http://prowlarr.invalid",
					encryptedApiKey: "x",
					encryptionIv: "x",
					connectionGeneration: 1,
				},
			],
		});
		await prisma.historySourceStatus.createMany({
			data: [
				{
					instanceId: "sqlite-rss-sonarr",
					connectionGeneration: 1,
					publishedAt: new Date(PUBLISHED_AT),
					publicationMetadata: metadata("sonarr"),
					retainedObservationCount: 1,
				},
				{
					instanceId: "sqlite-rss-prowlarr",
					connectionGeneration: 1,
					publishedAt: new Date(PUBLISHED_AT),
					publicationMetadata: metadata("prowlarr"),
					retainedObservationCount: 1,
				},
			],
		});
		await prisma.historyObservation.createMany({
			data: [
				row("sonarr", {
					id: "sqlite-rss-sonarr-row",
					instanceId: "sqlite-rss-sonarr",
					eventTypeKey: "rss-import",
					normalizedPayload: payload("sonarr", 1, "2026-09-03T22:00:00.000Z").replace(
						'"eventType":"download"',
						'"eventType":"rss-import"',
					),
				}),
				row("prowlarr", {
					id: "sqlite-rss-prowlarr-row",
					instanceId: "sqlite-rss-prowlarr",
					eventTypeKey: "rss-import",
					normalizedPayload: payload("prowlarr", 1, "2026-09-03T22:00:00.000Z").replace(
						'"eventType":"download"',
						'"eventType":"rss-import"',
					),
				}),
			],
		});

		const result = await read(prisma, { query: query({ hideProwlarrRss: "true" }) });
		expect(result).toMatchObject({ kind: "ok" });
		if (result.kind === "ok") {
			expect(result.response.items.map((item) => item.id)).toEqual(["sqlite-rss-sonarr-row"]);
		}
	});
});
