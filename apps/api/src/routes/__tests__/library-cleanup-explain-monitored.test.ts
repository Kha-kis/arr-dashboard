import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerLibraryCleanupRoutes } from "../library-cleanup.js";
import { createInjectAuthenticated, setupAuthInjection } from "./test-helpers.js";

const USER_ID = "user-monitored-explain";
const INSTANCE_ID = "radarr-1";
const NOW = new Date("2026-08-03T00:00:00.000Z");
const instance = {
	id: INSTANCE_ID,
	userId: USER_ID,
	service: "RADARR",
	label: "Radarr",
	baseUrl: "http://radarr",
	encryptedApiKey: "key",
	encryptionIv: "iv",
	enabled: true,
	updatedAt: NOW,
};
const monitoredRule = {
	id: "rule-monitored",
	configId: "cleanup-config",
	name: "Currently monitored",
	enabled: true,
	priority: 0,
	ruleType: "monitored",
	parameters: "{}",
	serviceFilter: null,
	instanceFilter: null,
	excludeTags: null,
	excludeTitles: null,
	plexLibraryFilter: null,
	targetScope: "series",
	action: "delete",
	operator: null,
	conditions: null,
	retentionMode: false,
	createdAt: NOW,
	updatedAt: NOW,
};

function cacheItem(evidence: boolean) {
	return {
		id: "cache-1",
		instanceId: INSTANCE_ID,
		arrItemId: 101,
		itemType: "movie",
		title: "Example Movie",
		year: 2024,
		monitored: true,
		hasFile: true,
		status: "released",
		qualityProfileId: 1,
		qualityProfileName: "HD",
		sizeOnDisk: 1_000n,
		arrAddedAt: NOW,
		data: JSON.stringify({
			service: "radarr",
			monitored: evidence ? true : undefined,
			_arrDashboardEvidence: { monitored: evidence },
		}),
	};
}

describe("POST /library-cleanup/explain monitored evidence", () => {
	let app: FastifyInstance;
	let libraryCacheFindFirst: ReturnType<typeof vi.fn>;

	beforeEach(async () => {
		libraryCacheFindFirst = vi.fn().mockResolvedValue(cacheItem(true));
		app = Fastify({ logger: false });
		setupAuthInjection(app, { id: USER_ID, username: "admin" });
		app.decorate("prisma", {
			serviceInstance: {
				findFirst: vi.fn().mockResolvedValue(instance),
				findMany: vi.fn().mockResolvedValue([instance]),
			},
			libraryCache: { findFirst: libraryCacheFindFirst },
			libraryCleanupConfig: {
				findUnique: vi.fn().mockResolvedValue({
					id: "cleanup-config",
					userId: USER_ID,
					rules: [monitoredRule],
				}),
			},
		} as never);
		app.decorate("arrClientFactory", {} as never);
		await app.register(registerLibraryCleanupRoutes);
		await app.ready();
	});

	afterEach(async () => app.close());

	it("reports an explicit monitored match", async () => {
		const response = await createInjectAuthenticated(app)("POST", "/library-cleanup/explain", {
			body: { instanceId: INSTANCE_ID, arrItemId: 101 },
		});
		expect(response.statusCode).toBe(200);
		expect(JSON.parse(response.payload).results[0]).toMatchObject({
			matched: true,
			reason: "Item is monitored",
			filteredBy: null,
		});
	});

	it("reports missing monitoring evidence as unavailable, not a negative match", async () => {
		libraryCacheFindFirst.mockResolvedValue(cacheItem(false));
		const response = await createInjectAuthenticated(app)("POST", "/library-cleanup/explain", {
			body: { instanceId: INSTANCE_ID, arrItemId: 101 },
		});
		expect(response.statusCode).toBe(200);
		expect(JSON.parse(response.payload).results[0]).toMatchObject({
			matched: false,
			reason: null,
			filteredBy: "evidence_unavailable",
		});
	});
});
