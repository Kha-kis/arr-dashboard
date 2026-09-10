import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { HistoryService } from "@arr/shared";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { LidarrClient, ProwlarrClient, RadarrClient, ReadarrClient, SonarrClient } from "arr-sdk";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { PrismaClient } from "../../../generated/prisma/client.js";
import type { ArrClient } from "../../arr/client-factory.js";
import { Encryptor } from "../../auth/encryption.js";
import { normalizeHistoryObservation } from "../../dashboard/history-utils.js";
import { collectHistoryObservationsForOwner } from "../history-collector.js";
import { parseHistoryReadQuery } from "../history-read-contract.js";
import { readHistoryRepository } from "../history-read-repository.js";

const OWNER_ID = "history-five-provider-owner";
const DATABASE_KEY = "a".repeat(64);
const SYNTHETIC_CREDENTIAL = "encrypted-looking-history-credential";
const SYNTHETIC_URL = "http://history-five-provider.invalid";
const PRIVATE_SENTINEL = "private-provider-error-sentinel";
const PRIVATE_PAYLOAD = "raw-private-provider-payload-sentinel";
const EVENT_DATE = "2026-09-03T12:34:56-05:00";
const SONARR_ID = "history-five-sonarr";

const SERVICES = [
	{ id: "history-five-lidarr", service: "lidarr", type: "LIDARR" },
	{ id: "history-five-prowlarr", service: "prowlarr", type: "PROWLARR" },
	{ id: "history-five-radarr", service: "radarr", type: "RADARR" },
	{ id: "history-five-readarr", service: "readarr", type: "READARR" },
	{ id: "history-five-sonarr", service: "sonarr", type: "SONARR" },
] as const satisfies readonly { id: string; service: HistoryService; type: string }[];

type ServiceFixture = (typeof SERVICES)[number];

function rawRecord(fixture: ServiceFixture, providerEventId: number): Record<string, unknown> {
	const common = {
		id: providerEventId,
		date: EVENT_DATE,
		eventType: "Downloaded",
		title: `Synthetic ${fixture.service} observation`,
		sourceTitle: `Synthetic ${fixture.service} source`,
		downloadClient: "synthetic-client",
		protocol: "torrent",
		privatePayload: PRIVATE_PAYLOAD,
		error: PRIVATE_SENTINEL,
	};
	switch (fixture.service) {
		case "sonarr":
			return {
				...common,
				seriesId: 10,
				episodeId: 20,
				series: { id: 10, title: "Synthetic Series", titleSlug: "synthetic-series" },
				episode: { id: 20 },
			};
		case "radarr":
			return {
				...common,
				movieId: 30,
				movie: { id: 30, title: "Synthetic Movie", titleSlug: "synthetic-movie" },
			};
		case "prowlarr":
			return {
				...common,
				indexerId: 40,
				data: { releaseTitle: "Synthetic Release", indexer: "Synthetic Indexer" },
			};
		case "lidarr":
			return {
				...common,
				artistId: 50,
				albumId: 60,
				trackId: 70,
				artist: { id: 50, artistName: "Synthetic Artist" },
				album: { id: 60, title: "Synthetic Album" },
				track: { id: 70 },
			};
		case "readarr":
			return {
				...common,
				authorId: 80,
				bookId: 90,
				author: { id: 80, authorName: "Synthetic Author" },
				book: { id: 90, title: "Synthetic Book" },
			};
	}
}

function makeClient(fixture: ServiceFixture): ArrClient {
	const config = { baseUrl: SYNTHETIC_URL, apiKey: SYNTHETIC_CREDENTIAL };
	switch (fixture.service) {
		case "sonarr":
			return new SonarrClient(config);
		case "radarr":
			return new RadarrClient(config);
		case "prowlarr":
			return new ProwlarrClient(config);
		case "lidarr":
			return new LidarrClient(config);
		case "readarr":
			return new ReadarrClient(config);
	}
}

function parseQuery(input: Record<string, unknown>) {
	const parsed = parseHistoryReadQuery(input);
	if (!parsed.ok) throw new Error("synthetic query must be valid");
	return parsed.query;
}

function historyRequestOptions(service: HistoryService, page: number): Record<string, unknown> {
	const common = { page, pageSize: 100, sortKey: "date", sortDirection: "descending" };
	switch (service) {
		case "sonarr":
			return { ...common, includeEpisode: true, includeSeries: true };
		case "radarr":
			return { ...common, includeMovie: true };
		case "prowlarr":
			return common;
		case "lidarr":
			return { ...common, includeArtist: true, includeAlbum: true, includeTrack: true };
		case "readarr":
			return { ...common, includeAuthor: true, includeBook: true };
	}
}

describe("assembled five-provider History observation proof", { timeout: 30_000 }, () => {
	let directory = "";
	let prisma: InstanceType<typeof PrismaClient> | null = null;

	beforeAll(() => {
		directory = mkdtempSync(join(tmpdir(), "history-five-provider-"));
		const databasePath = join(directory, "history.db");
		const schemaPath = resolve(process.cwd(), "prisma/schema.prisma");
		try {
			execFileSync("pnpm", ["exec", "prisma", "db", "push", "--schema", schemaPath], {
				cwd: process.cwd(),
				env: { ...process.env, DATABASE_URL: `file:${databasePath}` },
				stdio: "pipe",
			});
			prisma = new PrismaClient({
				adapter: new PrismaBetterSqlite3({ url: databasePath, timeout: 10_000 }),
			});
		} catch (error) {
			rmSync(directory, { recursive: true, force: true });
			directory = "";
			throw error;
		}
	}, 120_000);

	afterAll(async () => {
		if (prisma) await prisma.$disconnect();
		if (directory) rmSync(directory, { recursive: true, force: true });
	});

	it("collects all five concrete SDK shapes and reads the sanitized result locally across pages", async () => {
		if (!prisma) throw new Error("database was not initialized");
		const database = prisma;
		const previousDatabaseUrl = process.env.DATABASE_URL;
		const clients = new Map<string, ArrClient>();
		const providerSpies = new Map<string, ReturnType<typeof vi.spyOn>>();
		const failedService = SERVICES[1]!;
		try {
			process.env.DATABASE_URL = `file:${join(directory, "history.db")}`;
			await database.user.create({
				data: { id: OWNER_ID, username: OWNER_ID, hashedPassword: "synthetic-password" },
			});
			await database.serviceInstance.createMany({
				data: SERVICES.map((fixture) => ({
					id: fixture.id,
					userId: OWNER_ID,
					service: fixture.type as never,
					label: `Synthetic ${fixture.service} instance`,
					baseUrl: SYNTHETIC_URL,
					encryptedApiKey: SYNTHETIC_CREDENTIAL,
					encryptionIv: "synthetic-api-key-iv",
					encryptedHttpAuthCredentials: null,
					httpAuthEncryptionIv: null,
					connectionGeneration: 1,
				})),
			});

			for (const [index, fixture] of SERVICES.entries()) {
				const client = makeClient(fixture);
				clients.set(fixture.id, client);
				const get = vi.spyOn(client.history, "get");
				if (fixture.id === failedService.id) {
					get.mockRejectedValue(new Error(PRIVATE_SENTINEL));
				} else if (fixture.id === SONARR_ID) {
					const firstPage = Array.from({ length: 100 }, (_, offset) =>
						rawRecord(fixture, 100 + offset),
					);
					const secondPage = [firstPage[0]!, rawRecord(fixture, 200)];
					get.mockImplementation(async (options?: { page?: number }) =>
						options?.page === 1
							? { records: firstPage, totalRecords: 102 }
							: { records: secondPage, totalRecords: 102 },
					);
				} else {
					get.mockResolvedValue({
						records: [rawRecord(fixture, index + 1)],
						totalRecords: 1,
					} as never);
				}
				providerSpies.set(fixture.id, get);
			}

			const clientFactory = {
				createAnyClient: vi.fn((instance: { id: string }) => {
					const client = clients.get(instance.id);
					if (!client) throw new Error("missing synthetic client");
					return client;
				}),
			};
			const collected = await collectHistoryObservationsForOwner(
				{ prisma: database, clientFactory, dialect: "sqlite" },
				OWNER_ID,
			);

			expect(collected).toMatchObject({
				status: "completed",
				candidateSourceCount: 5,
				sourceTurnCount: 7,
				providerRequestCount: 7,
				rawRecordCount: 105,
				publishedTurnCount: 5,
				failedTurnCount: 0,
				leaseReleased: true,
			});
			expect(JSON.stringify(collected)).not.toContain(PRIVATE_SENTINEL);
			expect(JSON.stringify(collected)).not.toContain(PRIVATE_PAYLOAD);
			expect(JSON.stringify(collected)).not.toContain(SYNTHETIC_CREDENTIAL);
			expect(JSON.stringify(collected)).not.toContain(SYNTHETIC_URL);
			for (const fixture of SERVICES) {
				expect(clientFactory.createAnyClient).toHaveBeenCalledWith(
					expect.objectContaining({ id: fixture.id, service: fixture.type }),
					expect.objectContaining({ timeout: 20_000 }),
				);
			}
			for (const fixture of SERVICES) {
				const get = providerSpies.get(fixture.id);
				expect(get).toBeDefined();
				expect(get).toHaveBeenNthCalledWith(1, historyRequestOptions(fixture.service, 1));
				if (fixture.id !== failedService.id) {
					expect(get).toHaveBeenCalledTimes(fixture.id === SONARR_ID ? 2 : 1);
					if (fixture.id === SONARR_ID)
						expect(get).toHaveBeenNthCalledWith(2, historyRequestOptions(fixture.service, 2));
				} else {
					expect(get).toHaveBeenNthCalledWith(2, historyRequestOptions(fixture.service, 2));
					expect(get).toHaveBeenCalledTimes(2);
				}
			}

			const statuses = await database.historySourceStatus.findMany({
				orderBy: { instanceId: "asc" },
			});
			expect(statuses).toHaveLength(5);
			const persistedPublicMetadata = statuses
				.map((status) => status.publicationMetadata ?? "")
				.join("\n");
			for (const privateValue of [
				PRIVATE_SENTINEL,
				PRIVATE_PAYLOAD,
				SYNTHETIC_CREDENTIAL,
				SYNTHETIC_URL,
			]) {
				expect(persistedPublicMetadata).not.toContain(privateValue);
			}
			for (const status of statuses) {
				if (status.instanceId === failedService.id) {
					expect(status.publishedAt).toBeNull();
					expect(status.publicationMetadata).toBeNull();
					expect(status.lastAttemptReason).toBe("provider-unavailable");
					continue;
				}
				expect(status.publicationMetadata).not.toBeNull();
				const publicMetadata = JSON.parse(status.publicationMetadata!) as {
					service: HistoryService;
					publishedObservationCount: number;
					coverageReceipt: {
						provider: string;
						evidence: string;
						units: Array<Record<string, unknown>>;
					};
				};
				const expectedPageCount = status.instanceId === SONARR_ID ? 2 : 1;
				expect(publicMetadata.publishedObservationCount).toBe(expectedPageCount);
				expect(publicMetadata.coverageReceipt.provider).toBe(`${publicMetadata.service}_history`);
				expect(publicMetadata.coverageReceipt.evidence).toBe("positive-only");
				const [unit] = publicMetadata.coverageReceipt.units;
				expect(unit).toMatchObject({
					scopeKey: "history",
					pagesAttempted: 1,
					pagesCompleted: 1,
					rawObserved: expectedPageCount === 2 ? 2 : 1,
					canonicalEntities: expectedPageCount === 2 ? 2 : 1,
					fatalCount: 0,
				});
				expect(status.retainedObservationCount).toBe(expectedPageCount === 2 ? 101 : 1);
				expect(status.lastAttemptResult).toBe("success");
				expect(status.activeCollectionPage).toBeNull();
				expect(status.collectHeadNext).toBe(true);
				expect(status.nextBackfillPage).toBe(2);
				expect(status.publicationRevision).toBe(expectedPageCount === 2 ? 2 : 1);
				expect(status.publicationMetadata).not.toContain(PRIVATE_SENTINEL);
				expect(status.publicationMetadata).not.toContain(PRIVATE_PAYLOAD);
				expect(status.publicationMetadata).not.toContain(SYNTHETIC_CREDENTIAL);
				expect(status.publicationMetadata).not.toContain(SYNTHETIC_URL);
			}
			expect(
				statuses.find((status) => status.instanceId === failedService.id)?.publicationMetadata,
			).toBeNull();
			expect(
				await database.historyObservation.count({ where: { instanceId: failedService.id } }),
			).toBe(0);
			expect(await database.historyObservation.count({ where: { instanceId: SONARR_ID } })).toBe(
				101,
			);
			const sonarrProviderEvents = await database.historyObservation.findMany({
				where: { instanceId: SONARR_ID },
				orderBy: { providerEventId: "asc" },
				select: { providerEventId: true },
			});
			expect(sonarrProviderEvents.map((row) => row.providerEventId)).toEqual([
				...Array.from({ length: 100 }, (_, offset) => 100 + offset),
				200,
			]);

			const readEncryptor = new Encryptor(DATABASE_KEY);
			const firstQuery = parseQuery({ limit: "100" });
			const first = await readHistoryRepository({
				prisma: database,
				encryptor: readEncryptor,
				dialect: "sqlite",
				ownerId: OWNER_ID,
				query: firstQuery,
			});
			expect(first).toMatchObject({ kind: "ok" });
			if (first.kind !== "ok") return;
			expect(first.response.sources).toHaveLength(5);
			expect(first.response.sources.map((source) => source.instanceId)).toEqual(
				SERVICES.map((fixture) => fixture.id),
			);
			expect(first.response.items).toHaveLength(100);
			expect(first.response.pageInfo).toMatchObject({
				hasNextPage: true,
				matchingObservedCount: 104,
			});
			const firstSource = first.response.sources.find(
				(source) => source.instanceId === failedService.id,
			);
			expect(firstSource).toMatchObject({
				retainedObservationCount: 0,
				providerStatus: { availability: "unavailable", evidence: "unknown" },
			});
			for (const source of first.response.sources.filter(
				(item) => item.instanceId !== failedService.id,
			)) {
				expect(source.retainedObservationCount).toBe(source.instanceId === SONARR_ID ? 101 : 1);
				expect(source.providerStatus.evidence).toBe("positive-only");
				expect(source.providerStatus.availability).not.toBe("unavailable");
			}

			const allPersistedRows = await database.historyObservation.findMany({
				orderBy: [{ eventAt: "desc" }, { id: "desc" }],
				select: { id: true, instanceId: true, connectionGeneration: true },
			});
			expect(allPersistedRows).toHaveLength(104);

			const lateRaw = rawRecord(SERVICES[4]!, 999);
			const lateNormalized = normalizeHistoryObservation(lateRaw, "sonarr");
			if (!lateNormalized.ok) throw new Error("late synthetic row did not normalize");
			const nowRows = await database.$queryRawUnsafe<Array<{ now: string }>>(
				"SELECT CURRENT_TIMESTAMP AS now",
			);
			const now = nowRows[0]?.now;
			if (!now) throw new Error("database timestamp unavailable");
			const lateFirstObservedAt = new Date(`${now.replace(" ", "T")}Z`);
			lateFirstObservedAt.setSeconds(lateFirstObservedAt.getSeconds() + 1);
			await database.historyObservation.create({
				data: {
					id: "history-five-late-observation",
					instanceId: SERVICES[4]!.id,
					connectionGeneration: 1,
					providerEventId: 999,
					eventAt: new Date(EVENT_DATE),
					eventTypeKey: lateNormalized.observation.payload.eventType,
					searchText: lateNormalized.observation.searchText,
					normalizedPayload: lateNormalized.observation.normalizedPayload,
					firstObservedAt: lateFirstObservedAt,
					lastObservedAt: lateFirstObservedAt,
				},
			});

			const second = await readHistoryRepository({
				prisma: database,
				encryptor: readEncryptor,
				dialect: "sqlite",
				ownerId: OWNER_ID,
				query: parseQuery({ limit: "100", cursor: first.response.pageInfo.nextCursor }),
			});
			expect(second).toMatchObject({ kind: "ok" });
			if (second.kind !== "ok") return;
			expect(second.response.sources.map((source) => source.instanceId)).toEqual(
				SERVICES.map((fixture) => fixture.id),
			);
			expect(second.response.pageInfo).toMatchObject({
				hasNextPage: false,
				matchingObservedCount: 104,
				nextCursor: null,
			});
			expect(second.response.items).toHaveLength(4);
			const expectedIds = allPersistedRows.map((row) => row.id);
			const pages = [first.response, second.response];
			expect(pages).toHaveLength(2);
			for (const page of pages) {
				expect(page.sources.map((source) => source.instanceId)).toEqual(
					SERVICES.map((fixture) => fixture.id),
				);
				expect(page.sources.find((source) => source.instanceId === failedService.id)).toMatchObject(
					{
						retainedObservationCount: 0,
						providerStatus: { availability: "unavailable", evidence: "unknown" },
					},
				);
				for (const source of page.sources.filter((item) => item.instanceId !== failedService.id)) {
					expect(source.retainedObservationCount).toBe(source.instanceId === SONARR_ID ? 101 : 1);
					expect(source.providerStatus.evidence).toBe("positive-only");
					expect(source.providerStatus.availability).not.toBe("unavailable");
				}
			}
			const pageIds = pages.flatMap((page) => page.items.map((item) => item.id));
			expect(pageIds).toEqual(expectedIds);
			expect(new Set(pageIds).size).toBe(pageIds.length);
			expect(pageIds).not.toContain("history-five-late-observation");
			const serializedPages = JSON.stringify(pages);
			for (const privateValue of [
				PRIVATE_SENTINEL,
				PRIVATE_PAYLOAD,
				SYNTHETIC_CREDENTIAL,
				SYNTHETIC_URL,
			]) {
				expect(serializedPages).not.toContain(privateValue);
			}
		} finally {
			if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
			else process.env.DATABASE_URL = previousDatabaseUrl;
		}
	});
});
