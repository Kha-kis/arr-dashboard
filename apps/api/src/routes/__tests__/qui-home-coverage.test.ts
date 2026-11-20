import Fastify, { type FastifyRequest } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	createInjectAuthenticated,
	registerTestErrorHandler,
	setupAuthInjection,
} from "./test-helpers.js";

const mocks = vi.hoisted(() => ({
	instances: vi.fn(),
	observation: vi.fn(),
	createClient: vi.fn(),
	listInstances: vi.fn(),
	transfer: vi.fn(),
	candidates: vi.fn(),
	fileCoverage: vi.fn(),
}));

vi.mock("../../lib/qui/instance-helpers.js", () => ({
	listQuiInstances: mocks.instances,
}));
vi.mock("../../lib/qui/client-factory.js", () => ({
	createQuiClient: mocks.createClient,
}));
vi.mock("../../lib/qui/torrent-list-cache.js", () => ({
	getTorrentListObservation: mocks.observation,
	getCachedAllTorrents: vi.fn(),
}));
vi.mock("../../lib/library-sync/infohash-backfill-by-inode.js", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("../../lib/library-sync/infohash-backfill-by-inode.js")
	>()),
	readCachedFileIdCoverage: mocks.fileCoverage,
}));

import { fingerprintQuiTorrentInventory } from "../../lib/library-sync/infohash-backfill-by-inode.js";
import { registerLibraryRoutes } from "../qui/library-routes.js";

const torrent = {
	hash: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
	name: "synthetic",
	state: "uploading",
	ratio: 2,
	size: 100,
	instanceId: 1,
	savePath: "/synthetic",
};
const instance = (id: string) => ({
	id,
	userId: "user-1",
	service: "QUI",
	enabled: true,
	hasLocalFilesystemAccess: true,
	connectionGeneration: 0,
});
const at = 1_800_000_000_000;

let app: ReturnType<typeof Fastify>;
let warn: ReturnType<typeof vi.fn>;
beforeEach(async () => {
	vi.clearAllMocks();
	mocks.instances.mockResolvedValue([instance("qui-1")]);
	mocks.listInstances.mockResolvedValue([{ id: 1, name: "synthetic", connected: true }]);
	mocks.transfer.mockResolvedValue({ dlSpeed: 1, upSpeed: 2 });
	mocks.candidates.mockResolvedValue([]);
	mocks.fileCoverage.mockReturnValue(null);
	mocks.createClient.mockImplementation(() => ({
		listInstances: mocks.listInstances,
		getTransferInfo: mocks.transfer,
		getReannounceCandidates: mocks.candidates,
	}));
	mocks.observation.mockResolvedValue({
		availability: "current",
		torrents: [torrent],
		fetchedAtMs: at,
		complete: true,
	});
	app = Fastify();
	warn = vi.fn();
	app.addHook("onRequest", async (request: FastifyRequest) => {
		request.log.warn = warn as unknown as typeof request.log.warn;
	});
	app.decorate("prisma", {
		quiActivityLog: { findFirst: vi.fn().mockResolvedValue(null) },
		libraryCache: { findMany: vi.fn().mockResolvedValue([]) },
	} as never);
	setupAuthInjection(app);
	registerTestErrorHandler(app);
	await app.register(registerLibraryRoutes);
	await app.ready();
});

afterEach(async () => {
	await app?.close();
});

async function home(route: "/qui/summary" | "/qui/attention") {
	return createInjectAuthenticated(app)("GET", route);
}

describe("qUI home inventory coverage", () => {
	it("does not call an absent file index an all-clear", async () => {
		const attention = await home("/qui/attention");
		expect(attention.statusCode).toBe(200);
		expect(attention.json()).toMatchObject({
			totalCount: 0,
			fileCoverage: { status: "unavailable", issueCount: 0, oldestBuiltAt: null },
		});
	});

	it("calls a fresh complete matching FileID listing current", async () => {
		mocks.fileCoverage.mockReturnValue({
			builtAtMs: Date.now(),
			inventoryComplete: true,
			skippedUnstatable: 0,
			incompleteDirectoryWalks: 0,
			issues: [],
			torrentInventoryFingerprint: fingerprintQuiTorrentInventory([torrent]),
		});
		const attention = await home("/qui/attention");
		expect(attention.statusCode).toBe(200);
		expect(attention.json()).toMatchObject({
			fileCoverage: { status: "current", issueCount: 0 },
		});
	});

	it("labels an aged complete FileID snapshot last-known", async () => {
		mocks.fileCoverage.mockReturnValue({
			builtAtMs: Date.now() - 31 * 60 * 1000,
			inventoryComplete: true,
			skippedUnstatable: 0,
			incompleteDirectoryWalks: 0,
			issues: [],
			torrentInventoryFingerprint: fingerprintQuiTorrentInventory([torrent]),
		});
		const attention = await home("/qui/attention");
		expect(attention.statusCode).toBe(200);
		expect(attention.json()).toMatchObject({
			fileCoverage: { status: "last-known", issueCount: 0 },
		});
	});

	it("does not call a new torrent covered by an older FileID scan", async () => {
		mocks.fileCoverage.mockReturnValue({
			builtAtMs: Date.now(),
			inventoryComplete: true,
			skippedUnstatable: 0,
			incompleteDirectoryWalks: 0,
			issues: [],
			torrentInventoryFingerprint: "a".repeat(64),
		});
		const attention = await home("/qui/attention");
		expect(attention.statusCode).toBe(200);
		expect(attention.json()).toMatchObject({
			fileCoverage: { status: "partial", issueCount: 0 },
		});
	});

	it("keeps eleven file issues visible ahead of twenty critical transfer rows", async () => {
		const critical = Array.from({ length: 20 }, (_, i) => ({
			...torrent,
			hash: i.toString(16).padStart(40, "0"),
			state: "error",
		}));
		const fileTorrents = Array.from({ length: 11 }, (_, i) => ({
			...torrent,
			hash: `a${i.toString(16).padStart(39, "0")}`,
		}));
		mocks.observation.mockResolvedValue({
			availability: "current",
			torrents: [...critical, ...fileTorrents],
			fetchedAtMs: at,
			complete: true,
		});
		mocks.fileCoverage.mockReturnValue({
			builtAtMs: Date.now(),
			inventoryComplete: false,
			skippedUnstatable: 0,
			incompleteDirectoryWalks: 11,
			issues: fileTorrents.map((fileTorrent) => ({
				hash: fileTorrent.hash,
				qbitInstanceId: 1,
				missingFiles: 1,
				sizeMismatches: 0,
				otherFailures: 0,
			})),
		});
		const attention = await home("/qui/attention");
		expect(attention.statusCode).toBe(200);
		expect(attention.json().items).toHaveLength(20);
		expect(
			attention
				.json()
				.items.slice(0, 11)
				.map((item: { hash: string }) => item.hash),
		).toEqual(fileTorrents.map((fileTorrent) => fileTorrent.hash));
		expect(attention.json().totalCount).toBe(31);
		expect(attention.json().fileCoverage.issueCount).toBe(11);
	});

	it("promotes a seeding torrent with a persisted file-size discrepancy", async () => {
		mocks.fileCoverage.mockReturnValue({
			builtAtMs: Date.now(),
			inventoryComplete: false,
			skippedUnstatable: 0,
			incompleteDirectoryWalks: 1,
			issues: [
				{
					hash: torrent.hash,
					qbitInstanceId: 1,
					missingFiles: 0,
					sizeMismatches: 1,
					otherFailures: 0,
				},
			],
		});
		const attention = await home("/qui/attention");
		expect(attention.statusCode).toBe(200);
		expect(attention.json()).toMatchObject({
			totalCount: 1,
			fileCoverage: { status: "partial", issueCount: 1 },
			items: [
				{
					quiInstanceId: "qui-1",
					hash: torrent.hash,
					state: "seeding",
					severity: "warning",
				},
			],
		});
		expect(attention.json().items[0].reason).toMatch(/file size/i);
	});

	it("does not attribute the same hash to a different qUI connection", async () => {
		mocks.instances.mockResolvedValue([instance("qui-1"), instance("qui-2")]);
		mocks.fileCoverage.mockImplementation((entry: { id: string }) => ({
			builtAtMs: Date.now(),
			inventoryComplete: entry.id === "qui-2",
			skippedUnstatable: 0,
			incompleteDirectoryWalks: entry.id === "qui-1" ? 1 : 0,
			issues:
				entry.id === "qui-1"
					? [
							{
								hash: torrent.hash,
								qbitInstanceId: 1,
								missingFiles: 1,
								sizeMismatches: 0,
								otherFailures: 0,
							},
						]
					: [],
		}));
		const attention = await home("/qui/attention");
		expect(attention.statusCode).toBe(200);
		expect(attention.json()).toMatchObject({
			totalCount: 1,
			fileCoverage: { status: "partial", issueCount: 1 },
			items: [{ quiInstanceId: "qui-1", hash: torrent.hash }],
		});
	});

	it("does not call mixed local-file configuration complete", async () => {
		mocks.instances.mockResolvedValue([
			instance("qui-1"),
			{ ...instance("qui-2"), hasLocalFilesystemAccess: false },
		]);
		mocks.fileCoverage.mockReturnValue({
			builtAtMs: Date.now(),
			inventoryComplete: true,
			skippedUnstatable: 0,
			incompleteDirectoryWalks: 0,
			issues: [],
		});
		const attention = await home("/qui/attention");
		expect(attention.statusCode).toBe(200);
		expect(attention.json()).toMatchObject({
			fileCoverage: { status: "partial", issueCount: 0 },
		});
		expect(mocks.fileCoverage).toHaveBeenCalledTimes(1);
	});

	it("reports current coverage for a complete observation", async () => {
		const summary = await home("/qui/summary");
		const attention = await home("/qui/attention");
		expect(summary.statusCode).toBe(200);
		expect(attention.statusCode).toBe(200);
		expect(summary.json()).toMatchObject({
			totalTorrents: 1,
			inventoryCoverage: {
				status: "current",
				currentInstances: 1,
				lastKnownInstances: 0,
				unavailableInstances: 0,
			},
		});
		expect(attention.json()).toMatchObject({
			inventoryCoverage: {
				status: "current",
				currentInstances: 1,
				lastKnownInstances: 0,
				unavailableInstances: 0,
			},
		});
	});

	it("distinguishes a cold provider failure from an exact empty library", async () => {
		mocks.observation.mockResolvedValue({
			availability: "unavailable",
			torrents: [],
			fetchedAtMs: null,
		});
		const summary = await home("/qui/summary");
		const attention = await home("/qui/attention");
		expect(summary.json()).toMatchObject({
			totalTorrents: 0,
			inventoryCoverage: {
				status: "unavailable",
				currentInstances: 0,
				lastKnownInstances: 0,
				unavailableInstances: 1,
			},
		});
		expect(attention.json()).toMatchObject({
			totalCount: 0,
			inventoryCoverage: {
				status: "unavailable",
				currentInstances: 0,
				lastKnownInstances: 0,
				unavailableInstances: 1,
			},
		});
	});

	it("keeps known rows but labels missing second-instance coverage partial", async () => {
		mocks.instances.mockResolvedValue([instance("qui-1"), instance("qui-2")]);
		mocks.observation.mockImplementation(async (id: string) =>
			id === "qui-1"
				? { availability: "last-known", torrents: [torrent], fetchedAtMs: at }
				: { availability: "unavailable", torrents: [], fetchedAtMs: null },
		);
		const summary = await home("/qui/summary");
		expect(summary.json()).toMatchObject({
			totalTorrents: 1,
			inventoryCoverage: {
				status: "partial",
				currentInstances: 0,
				lastKnownInstances: 1,
				unavailableInstances: 1,
			},
		});
	});

	it("treats a successful but unproven provider inventory as partial", async () => {
		mocks.observation.mockResolvedValue({
			availability: "current",
			torrents: [torrent],
			fetchedAtMs: at,
			complete: false,
		});
		const summary = await home("/qui/summary");
		const attention = await home("/qui/attention");
		expect(summary.json()).toMatchObject({
			totalTorrents: 1,
			inventoryCoverage: { status: "partial", incompleteInstances: 1, unavailableInstances: 0 },
		});
		expect(attention.json()).toMatchObject({
			inventoryCoverage: { status: "partial", incompleteInstances: 1, unavailableInstances: 0 },
		});
	});

	it("does not call failed topology, throughput, or tracker reads complete", async () => {
		mocks.listInstances.mockRejectedValueOnce(new Error("topology unavailable"));
		mocks.candidates.mockRejectedValueOnce(new Error("tracker signal unavailable"));
		const summary = await home("/qui/summary");
		const attention = await home("/qui/attention");
		expect(summary.json()).toMatchObject({
			inventoryCoverage: { status: "current" },
			topologyCoverage: "unavailable",
			throughputCoverage: "unavailable",
		});
		expect(attention.json()).toMatchObject({
			inventoryCoverage: { status: "current" },
			trackerCoverage: "unavailable",
		});
	});

	it("logs a cold provider failure while returning only generic availability", async () => {
		mocks.observation.mockResolvedValue({
			availability: "unavailable",
			torrents: [],
			fetchedAtMs: null,
			failure: new Error("synthetic provider page failed"),
		});
		const summary = await home("/qui/summary");
		const attention = await home("/qui/attention");
		expect(summary.statusCode).toBe(200);
		expect(attention.statusCode).toBe(200);
		expect(warn).toHaveBeenCalledWith(
			expect.objectContaining({ err: expect.any(Error), instanceId: "qui-1" }),
			expect.stringContaining("torrent inventory"),
		);
		expect(JSON.stringify(summary.json())).not.toContain("synthetic provider page failed");
	});

	it("does not mix equal qBittorrent IDs across two qUI services", async () => {
		mocks.instances.mockResolvedValue([instance("qui-1"), instance("qui-2")]);
		mocks.observation.mockImplementation(async (id: string) => ({
			availability: "current",
			complete: true,
			fetchedAtMs: at,
			torrents:
				id === "qui-1"
					? [torrent]
					: [
							{ ...torrent, hash: "b".repeat(40) },
							{ ...torrent, hash: "c".repeat(40) },
						],
		}));
		const summary = await home("/qui/summary");
		expect(summary.statusCode).toBe(200);
		expect(summary.json()).toMatchObject({
			totalTorrents: 3,
			inventoryCoverage: { status: "current" },
			qbitInstances: [
				{ id: 1, torrentCount: 1 },
				{ id: 1, torrentCount: 2 },
			],
		});
	});
});
