import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createTestPrismaClient } from "../../__tests__/test-prisma.js";
import type { PrismaClient, ServiceType } from "../../prisma.js";
import {
	readSessionSnapshotMetricsPages,
	readSessionSnapshotPages,
} from "../session-snapshot-pages.js";

const databases: Array<{ directory: string; prisma: PrismaClient }> = [];
const CAPTURED_AT = new Date("2026-09-01T00:00:00.000Z");

async function database() {
	const directory = mkdtempSync(join(tmpdir(), "session-snapshot-pages-"));
	const dbPath = join(directory, "test.db");
	execFileSync("pnpm", ["exec", "prisma", "db", "push", "--schema", "prisma/schema.prisma"], {
		cwd: process.cwd(),
		env: { ...process.env, DATABASE_URL: `file:${dbPath}` },
		stdio: "ignore",
	});
	const prisma = createTestPrismaClient(dbPath);
	databases.push({ directory, prisma });
	await prisma.user.create({ data: { id: "owner", username: "synthetic-owner" } });
	await prisma.user.create({ data: { id: "other-owner", username: "synthetic-other" } });
	return { prisma, dbPath };
}

async function instance(
	prisma: PrismaClient,
	id: string,
	userId: string,
	service: ServiceType = "PLEX",
	enabled = true,
) {
	return prisma.serviceInstance.create({
		data: {
			id,
			userId,
			service,
			label: id,
			baseUrl: "http://example.invalid",
			encryptedApiKey: "synthetic",
			encryptionIv: "synthetic",
			enabled,
		},
	});
}

function metricRow(id: string, instanceId: string, capturedAt: Date, concurrentStreams: number) {
	return {
		id,
		instanceId,
		capturedAt,
		concurrentStreams,
		totalBandwidth: concurrentStreams * 10,
		lanBandwidth: concurrentStreams * 6,
		wanBandwidth: concurrentStreams * 4,
		directPlayCount: concurrentStreams,
		transcodeCount: 0,
		directStreamCount: 0,
		sessionsJson: "[]",
	};
}

async function createSnapshotRows(prisma: PrismaClient, rows: ReturnType<typeof metricRow>[]) {
	for (let offset = 0; offset < rows.length; offset += 500) {
		await prisma.sessionSnapshot.createMany({ data: rows.slice(offset, offset + 500) });
	}
}

afterEach(async () => {
	for (const database of databases.splice(0)) {
		await database.prisma.$disconnect();
		rmSync(database.directory, { recursive: true, force: true });
	}
});

describe("session snapshot bounded reader on disposable SQLite", { timeout: 30_000 }, () => {
	it("carries verified receipts and collection counts without idle/failure dilution or early pagination termination", async () => {
		const { prisma } = await database();
		await instance(prisma, "owner-plex", "owner");
		const active = JSON.stringify({
			version: 1,
			provider: "PLEX",
			status: "active",
			bandwidthBasis: "provider-reported",
			observedSessions: 1,
			bandwidth: {
				status: "complete",
				observedSessions: 1,
				measuredSessions: 1,
				knownTotalKbps: 12.25,
			},
			methods: {
				directPlayCount: 1,
				transcodeCount: 0,
				directStreamCount: 0,
				unknownDecisionCount: 0,
			},
			network: { status: "unavailable", lanKbps: null, wanKbps: null },
		});
		const idle = JSON.stringify({
			version: 1,
			provider: "PLEX",
			status: "idle",
			bandwidthBasis: "provider-reported",
			observedSessions: 0,
			bandwidth: {
				status: "complete",
				observedSessions: 0,
				measuredSessions: 0,
				knownTotalKbps: 0,
			},
			methods: {
				directPlayCount: 0,
				transcodeCount: 0,
				directStreamCount: 0,
				unknownDecisionCount: 0,
			},
			network: { status: "complete", lanKbps: 0, wanKbps: 0 },
		});
		const failed = JSON.stringify({
			version: 1,
			provider: "PLEX",
			status: "failed",
			bandwidthBasis: "provider-reported",
			observedSessions: null,
			bandwidth: null,
			methods: null,
			network: { status: "unavailable", lanKbps: null, wanKbps: null },
		});
		await prisma.sessionSnapshot.createMany({
			data: [
				{ ...metricRow("00-legacy", "owner-plex", CAPTURED_AT, 2), measurementJson: null },
				...Array.from({ length: 502 }, (_, i) => ({
					...metricRow(`idle-${String(i).padStart(4, "0")}`, "owner-plex", CAPTURED_AT, 0),
					measurementJson: idle,
				})),
				{ ...metricRow("failed", "owner-plex", CAPTURED_AT, 0), measurementJson: failed },
				{ ...metricRow("invalid", "owner-plex", CAPTURED_AT, 8), measurementJson: "{}" },
				{ ...metricRow("mismatched", "owner-plex", CAPTURED_AT, 8), measurementJson: active },
				{ ...metricRow("zz-active", "owner-plex", CAPTURED_AT, 1), measurementJson: active },
				{
					...metricRow(
						"invalid-legacy-next-day",
						"owner-plex",
						new Date("2026-09-02T00:00:00Z"),
						-1,
					),
					measurementJson: null,
				},
			],
		});
		for (const read of [readSessionSnapshotPages, readSessionSnapshotMetricsPages]) {
			const received: Array<{ id: string; measurementJson?: string | null; instanceId?: string }> =
				[];
			const result = await read(prisma, {
				userId: "owner",
				services: ["PLEX"],
				cutoff: CAPTURED_AT,
				includeCollectionByDate: true,
				onPage: (page) => received.push(...page),
			});
			expect(received.map((row) => row.id)).toEqual(["00-legacy", "zz-active"]);
			expect(received[0]?.measurementJson).toBeNull();
			expect(received[1]?.measurementJson).toBe(active);
			if (read === readSessionSnapshotPages) {
				expect(received.map((row) => row.instanceId)).toEqual(["owner-plex", "owner-plex"]);
			}
			expect(result).toEqual({
				instanceCount: 1,
				snapshotCount: 2,
				collection: {
					activeSnapshots: 1,
					idleSnapshots: 502,
					failedSnapshots: 1,
					legacySnapshots: 1,
					invalidSnapshots: 3,
				},
				collectionByDate: {
					"2026-09-01": {
						activeSnapshots: 1,
						idleSnapshots: 502,
						failedSnapshots: 1,
						legacySnapshots: 1,
						invalidSnapshots: 2,
					},
					"2026-09-02": {
						activeSnapshots: 0,
						idleSnapshots: 0,
						failedSnapshots: 0,
						legacySnapshots: 0,
						invalidSnapshots: 1,
					},
				},
			});
		}
	});
	it("pages numeric projections across tied timestamps and scopes owned Jellyfin plus Emby instances", async () => {
		const { prisma } = await database();
		await instance(prisma, "owner-jellyfin", "owner", "JELLYFIN");
		await instance(prisma, "owner-emby", "owner", "EMBY");
		await instance(prisma, "owner-sonarr", "owner", "SONARR");
		await instance(prisma, "owner-disabled", "owner", "JELLYFIN", false);
		await instance(prisma, "other-jellyfin", "other-owner", "JELLYFIN");
		const snapshots = Array.from({ length: 1_001 }, (_, index) =>
			metricRow(
				`metric-${String(index).padStart(5, "0")}`,
				index % 2 === 0 ? "owner-jellyfin" : "owner-emby",
				CAPTURED_AT,
				index + 1,
			),
		);
		const excluded = [
			metricRow("wrong-service-metric", "owner-sonarr", CAPTURED_AT, 90_000),
			metricRow("disabled-metric", "owner-disabled", CAPTURED_AT, 90_000),
			metricRow("foreign-metric", "other-jellyfin", CAPTURED_AT, 90_000),
			metricRow(
				"before-cutoff-metric",
				"owner-jellyfin",
				new Date(CAPTURED_AT.getTime() - 1),
				90_000,
			),
		];
		await createSnapshotRows(prisma, [...snapshots, ...excluded]);
		const pages: Array<Array<{ id: string; concurrentStreams: number }>> = [];

		const result = await readSessionSnapshotMetricsPages(prisma, {
			userId: "owner",
			services: ["JELLYFIN", "EMBY"],
			cutoff: CAPTURED_AT,
			onPage: (page) =>
				pages.push(page.map(({ id, concurrentStreams }) => ({ id, concurrentStreams }))),
		});

		expect(result).toEqual({
			instanceCount: 2,
			snapshotCount: 1_001,
			collection: {
				activeSnapshots: 0,
				idleSnapshots: 0,
				failedSnapshots: 0,
				legacySnapshots: 1_001,
				invalidSnapshots: 0,
			},
		});
		expect(pages.map((page) => page.length)).toEqual([500, 500, 1]);
		expect(pages.flat().map((row) => row.id)).toEqual(
			snapshots.map((row) => row.id).sort((a, b) => a.localeCompare(b)),
		);
		expect(pages.flat()[0]).toEqual({ id: "metric-00000", concurrentStreams: 1 });
	});

	it("continues ranked count, timestamp, and ID ordering across SQLite page boundaries", async () => {
		const { prisma } = await database();
		await instance(prisma, "owner-plex", "owner");
		const snapshots = Array.from({ length: 1_001 }, (_, index) =>
			metricRow(
				`rank-${String(index).padStart(5, "0")}`,
				"owner-plex",
				CAPTURED_AT,
				index < 501 ? 10 : 9,
			),
		);
		await createSnapshotRows(prisma, snapshots);
		const pages: Array<Array<{ id: string; concurrentStreams: number }>> = [];

		const result = await readSessionSnapshotMetricsPages(
			prisma,
			{
				userId: "owner",
				services: ["PLEX"],
				cutoff: CAPTURED_AT,
				onPage: (page) =>
					pages.push(page.map(({ id, concurrentStreams }) => ({ id, concurrentStreams }))),
			},
			"most-concurrent",
		);

		expect(result).toEqual({
			instanceCount: 1,
			snapshotCount: 1_001,
			collection: {
				activeSnapshots: 0,
				idleSnapshots: 0,
				failedSnapshots: 0,
				legacySnapshots: 1_001,
				invalidSnapshots: 0,
			},
		});
		expect(pages.map((page) => page.length)).toEqual([500, 500, 1]);
		expect(pages.flat().slice(498, 503)).toEqual([
			{ id: "rank-00498", concurrentStreams: 10 },
			{ id: "rank-00499", concurrentStreams: 10 },
			{ id: "rank-00500", concurrentStreams: 10 },
			{ id: "rank-00501", concurrentStreams: 9 },
			{ id: "rank-00502", concurrentStreams: 9 },
		]);
	});

	it("keeps the first numeric page snapshot when another SQLite connection commits between pages", async () => {
		const { prisma, dbPath } = await database();
		await instance(prisma, "owner-plex", "owner");
		await prisma.$queryRawUnsafe("PRAGMA journal_mode = WAL");
		const secondClient = createTestPrismaClient(dbPath);
		try {
			const initialRows = Array.from({ length: 1_001 }, (_, index) =>
				metricRow(
					`numeric-initial-${String(index).padStart(5, "0")}`,
					"owner-plex",
					CAPTURED_AT,
					1,
				),
			);
			await createSnapshotRows(prisma, initialRows);
			let insertedBetweenPages = false;
			const instrumentedPrisma = {
				$transaction: (
					work: (tx: unknown) => Promise<unknown>,
					options: { isolationLevel: "Serializable"; maxWait: number; timeout: number },
				) =>
					prisma.$transaction(
						(tx) =>
							work({
								serviceInstance: tx.serviceInstance,
								sessionSnapshot: {
									findMany: async (args: Parameters<typeof tx.sessionSnapshot.findMany>[0]) => {
										const page = await tx.sessionSnapshot.findMany(args);
										if (!insertedBetweenPages && page.length > 0) {
											insertedBetweenPages = true;
											await secondClient.sessionSnapshot.create({
												data: metricRow(
													"numeric-committed-after-first-page",
													"owner-plex",
													new Date(CAPTURED_AT.getTime() + 1_000),
													99,
												),
											});
										}
										return page;
									},
								},
							}),
						options,
					),
			} as unknown as PrismaClient;
			const visitedIds: string[] = [];

			const result = await readSessionSnapshotMetricsPages(instrumentedPrisma, {
				userId: "owner",
				services: ["PLEX"],
				cutoff: CAPTURED_AT,
				onPage: (page) => visitedIds.push(...page.map((row) => row.id)),
			});

			expect(insertedBetweenPages).toBe(true);
			expect(result.snapshotCount).toBe(1_001);
			expect(visitedIds).toHaveLength(1_001);
			expect(visitedIds).not.toContain("numeric-committed-after-first-page");
			expect(
				await prisma.sessionSnapshot.count({ where: { id: "numeric-committed-after-first-page" } }),
			).toBe(1);
		} finally {
			await secondClient.$disconnect();
		}
	});

	it("pages the complete owner-scoped window in stable timestamp and ID order", async () => {
		const { prisma } = await database();
		await instance(prisma, "owner-plex-a", "owner");
		await instance(prisma, "owner-plex-b", "owner");
		await instance(prisma, "owner-jellyfin", "owner", "JELLYFIN");
		await instance(prisma, "owner-disabled", "owner", "PLEX", false);
		await instance(prisma, "other-plex", "other-owner");
		const snapshots = Array.from({ length: 20_001 }, (_, index) => ({
			id: `row-${String(index).padStart(5, "0")}`,
			instanceId: index % 2 === 0 ? "owner-plex-a" : "owner-plex-b",
			capturedAt: new Date(CAPTURED_AT.getTime() + Math.floor(index / 3) * 1_000),
			concurrentStreams: 1,
			sessionsJson: "[]",
		}));
		const excludedRows = [
			{
				id: "wrong-owner-row",
				instanceId: "other-plex",
				capturedAt: CAPTURED_AT,
				concurrentStreams: 1,
				sessionsJson: "[]",
			},
			{
				id: "wrong-service-row",
				instanceId: "owner-jellyfin",
				capturedAt: CAPTURED_AT,
				concurrentStreams: 1,
				sessionsJson: "[]",
			},
			{
				id: "disabled-instance-row",
				instanceId: "owner-disabled",
				capturedAt: CAPTURED_AT,
				concurrentStreams: 1,
				sessionsJson: "[]",
			},
		];
		const rows = [...snapshots.slice().reverse(), ...excludedRows];
		for (let offset = 0; offset < rows.length; offset += 500) {
			await prisma.sessionSnapshot.createMany({ data: rows.slice(offset, offset + 500) });
		}
		const pages: string[][] = [];

		const result = await readSessionSnapshotPages(prisma, {
			userId: "owner",
			services: ["PLEX"],
			cutoff: CAPTURED_AT,
			onPage: (page) => pages.push(page.map((row) => row.id)),
		});

		const expectedIds = snapshots
			.slice()
			.sort((a, b) => a.capturedAt.getTime() - b.capturedAt.getTime() || a.id.localeCompare(b.id))
			.map((row) => row.id);
		expect(result).toEqual({
			instanceCount: 2,
			snapshotCount: 20_001,
			collection: {
				activeSnapshots: 0,
				idleSnapshots: 0,
				failedSnapshots: 0,
				legacySnapshots: 20_001,
				invalidSnapshots: 0,
			},
		});
		expect(pages.map((page) => page.length)).toEqual([...Array.from({ length: 40 }, () => 500), 1]);
		expect(pages.flat()).toEqual(expectedIds);
	});

	it("pages reverse-chronological tied timestamps without omissions across SQLite boundaries", async () => {
		const { prisma } = await database();
		await instance(prisma, "owner-jellyfin", "owner", "JELLYFIN");
		await instance(prisma, "owner-emby", "owner", "EMBY");
		await instance(prisma, "other-jellyfin", "other-owner", "JELLYFIN");
		const snapshots = Array.from({ length: 1_001 }, (_, index) =>
			metricRow(
				`reverse-${String(index).padStart(5, "0")}`,
				index % 2 === 0 ? "owner-jellyfin" : "owner-emby",
				CAPTURED_AT,
				1,
			),
		);
		await createSnapshotRows(prisma, [...snapshots].reverse());
		const pages: string[][] = [];

		const result = await readSessionSnapshotPages(
			prisma,
			{
				userId: "owner",
				services: ["JELLYFIN", "EMBY"],
				cutoff: CAPTURED_AT,
				onPage: (page) => pages.push(page.map((row) => row.id)),
			},
			"reverse-chronological",
		);

		expect(result).toEqual({
			instanceCount: 2,
			snapshotCount: 1_001,
			collection: {
				activeSnapshots: 0,
				idleSnapshots: 0,
				failedSnapshots: 0,
				legacySnapshots: 1_001,
				invalidSnapshots: 0,
			},
		});
		expect(pages.map((page) => page.length)).toEqual([500, 500, 1]);
		expect(pages.flat()).toEqual(snapshots.map((row) => row.id).sort((a, b) => b.localeCompare(a)));
	});

	it("skips the snapshot query when the user has no enabled instance in scope", async () => {
		const { prisma } = await database();
		await instance(prisma, "other-plex", "other-owner");
		const result = await readSessionSnapshotPages(prisma, {
			userId: "owner",
			services: ["PLEX"],
			cutoff: CAPTURED_AT,
			onPage: () => {
				throw new Error("no snapshot page is expected");
			},
		});
		expect(result).toEqual({
			instanceCount: 0,
			snapshotCount: 0,
			collection: {
				activeSnapshots: 0,
				idleSnapshots: 0,
				failedSnapshots: 0,
				legacySnapshots: 0,
				invalidSnapshots: 0,
			},
		});
	});

	it("keeps the first page snapshot when another connection commits between pages", async () => {
		const { prisma, dbPath } = await database();
		await instance(prisma, "owner-plex", "owner");
		await prisma.$queryRawUnsafe("PRAGMA journal_mode = WAL");
		const secondClient = createTestPrismaClient(dbPath);
		try {
			const initialRows = Array.from({ length: 1_001 }, (_, index) => ({
				id: `initial-${String(index).padStart(5, "0")}`,
				instanceId: "owner-plex",
				capturedAt: CAPTURED_AT,
				concurrentStreams: 1,
				sessionsJson: "[]",
			}));
			await prisma.sessionSnapshot.createMany({ data: initialRows });
			let insertedBetweenPages = false;
			const instrumentedPrisma = {
				$transaction: (
					work: (tx: unknown) => Promise<unknown>,
					options: { isolationLevel: "Serializable"; maxWait: number; timeout: number },
				) =>
					prisma.$transaction(
						(tx) =>
							work({
								serviceInstance: tx.serviceInstance,
								sessionSnapshot: {
									findMany: async (args: Parameters<typeof tx.sessionSnapshot.findMany>[0]) => {
										const page = await tx.sessionSnapshot.findMany(args);
										if (!insertedBetweenPages && page.length > 0) {
											insertedBetweenPages = true;
											await secondClient.sessionSnapshot.create({
												data: {
													id: "committed-after-first-page",
													instanceId: "owner-plex",
													capturedAt: new Date(CAPTURED_AT.getTime() + 1_000),
													concurrentStreams: 1,
													sessionsJson: "[]",
												},
											});
										}
										return page;
									},
								},
							}),
						options,
					),
			} as unknown as PrismaClient;
			const visitedIds: string[] = [];

			const result = await readSessionSnapshotPages(instrumentedPrisma, {
				userId: "owner",
				services: ["PLEX"],
				cutoff: CAPTURED_AT,
				onPage: (page) => visitedIds.push(...page.map((row) => row.id)),
			});

			expect(insertedBetweenPages).toBe(true);
			expect(result.snapshotCount).toBe(1_001);
			expect(visitedIds).toHaveLength(1_001);
			expect(visitedIds).not.toContain("committed-after-first-page");
			expect(
				await prisma.sessionSnapshot.count({ where: { id: "committed-after-first-page" } }),
			).toBe(1);
		} finally {
			await secondClient.$disconnect();
		}
	});
});
