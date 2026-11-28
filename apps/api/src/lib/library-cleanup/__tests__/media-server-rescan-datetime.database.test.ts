import { lstatSync, mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import pino from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Encryptor } from "../../auth/encryption.js";
import {
	loadRuntimeSchemaRegistry,
	prepareRuntimeSchemaExecution,
} from "../../backup/runtime-schema-registry.js";
import { PrismaClient } from "../../prisma.js";
import {
	providerIdentityAuthorityFingerprint,
	providerInstanceAuthorityFingerprint,
} from "../../services/service-identity.js";
import { createRecoverableSqliteAdapter } from "../../sqlite-adapter.js";
import { triggerMediaServerRescansForApproval } from "../media-server-rescan.js";
import {
	createSanitizedProviderEvidence,
	serializeProviderScanAuthority,
} from "../shared-plex-safety.js";
import type { CleanupExecutorDeps } from "../types.js";

type LeaseSnapshot = {
	operationKey: string;
	userId: string;
	executionToken: string;
	createdAt: string;
	updatedAt: string;
};
type ScanSnapshot = {
	status: string;
	executionToken: string | null;
	requestStartedAt: string | null;
	nextAttemptAt: string | null;
	updatedAt: string;
};
const resources: Array<{
	directory: string;
	client: PrismaClient;
	db: Database.Database;
	server: Server;
}> = [];
const canonical = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}\+00:00$/;

afterEach(async () => {
	for (const fixture of resources.splice(0)) {
		await fixture.client.$disconnect();
		fixture.db.close();
		fixture.server.closeAllConnections();
		await new Promise<void>((resolve, reject) =>
			fixture.server.close((error) => (error ? reject(error) : resolve())),
		);
		expect(fixture.directory.startsWith(join(tmpdir(), "arr-rescan-date-"))).toBe(true);
		expect(lstatSync(fixture.directory).isSymbolicLink()).toBe(false);
		rmSync(fixture.directory, { recursive: true });
	}
	vi.unstubAllEnvs();
});

async function createFixture(scanStatus = 204, attemptCount = 0) {
	const routes: string[] = [];
	const server = createServer((request, response) => {
		routes.push(`${request.method} ${request.url}`);
		if (!request.headers.authorization?.startsWith('MediaBrowser Token="fixture-only-token",')) {
			response.statusCode = 401;
		} else if (request.method === "GET" && request.url === "/System/Info") {
			response.setHeader("content-type", "application/json");
			response.end(JSON.stringify({ Id: "fixture-server", ServerName: "Fixture", Version: "1.0" }));
			return;
		} else if (request.method === "POST" && request.url === "/Library/Refresh") {
			response.statusCode = scanStatus;
		} else {
			response.statusCode = 404;
		}
		response.end();
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	const directory = mkdtempSync(join(tmpdir(), "arr-rescan-date-"));
	const path = join(directory, "rescan.db");
	vi.stubEnv("DATABASE_URL", `file:${path}`);
	const db = new Database(path);
	db.pragma("foreign_keys=ON");
	db.pragma("journal_mode=WAL");
	await prepareRuntimeSchemaExecution(loadRuntimeSchemaRegistry("sqlite"), {
		provider: "sqlite",
		tables: [],
	}).execute((sql) => {
		db.exec(sql);
	});
	const client = new PrismaClient({
		adapter: createRecoverableSqliteAdapter({ url: path, timeout: 5_000 }),
	});
	resources.push({ directory, db, client, server });
	await client.$connect();
	await client.user.create({
		data: { id: "owner", username: "fixture-owner", hashedPassword: "opaque-fixture" },
	});
	const encryptor = new Encryptor("a".repeat(64));
	const encrypted = encryptor.encrypt("fixture-only-token");
	const instance = await client.serviceInstance.create({
		data: {
			id: "fixture-jellyfin",
			userId: "owner",
			service: "JELLYFIN",
			label: "Fixture",
			baseUrl,
			encryptedApiKey: encrypted.value,
			encryptionIv: encrypted.iv,
			expectedIdentity: "fixture-server",
			identityKind: "JELLYFIN_SERVER_ID",
			identityStatus: "VERIFIED",
			identityVerifiedAt: new Date(),
			identityGeneration: 7,
			connectionGeneration: 3,
		},
	});
	await client.libraryCleanupConfig.create({ data: { id: "config", userId: "owner" } });
	await client.libraryCleanupApproval.create({
		data: {
			id: "approval",
			configId: "config",
			instanceId: "fixture-arr",
			arrItemId: 42,
			itemType: "movie",
			title: "Fixture",
			matchedRuleId: "fixture-rule",
			matchedRuleName: "Fixture",
			reason: "Fixture",
			sizeOnDisk: 1n,
			status: "executed",
			terminalAuditRecordedAt: new Date(),
			expiresAt: new Date(Date.now() + 60_000),
		},
	});
	const identityFingerprint = providerIdentityAuthorityFingerprint(instance);
	const serverIdentity = serializeProviderScanAuthority(
		{ instanceId: instance.id, service: "JELLYFIN", mediaType: "movie" },
		createSanitizedProviderEvidence(
			["jellyfin"],
			[
				{
					service: "JELLYFIN",
					identityKind: "JELLYFIN_SERVER_ID",
					identityFingerprint,
					instanceFingerprint: providerInstanceAuthorityFingerprint(instance.id),
					connectionGeneration: 3,
					identityGeneration: 7,
					cacheType: "jellyfin",
					completedAt: new Date().toISOString(),
					itemCount: 1,
					verifiedAt: instance.identityVerifiedAt!.toISOString(),
					statusFingerprint: "b".repeat(64),
					rowFingerprint: "c".repeat(64),
				},
			],
		),
	);
	await client.libraryCleanupMediaServerScan.create({
		data: {
			id: "scan",
			approvalId: "approval",
			instanceId: instance.id,
			service: "JELLYFIN",
			serverIdentity,
			mediaType: "movie",
			targetKey: "fixture-jellyfin-movie",
			attemptCount,
		},
	});
	const leases: LeaseSnapshot[] = [];
	const scans: ScanSnapshot[] = [];
	// Forward every actual statement unchanged. Observe committed native state
	// before the real workflow releases leases or prunes successful scan jobs.
	const prisma = new Proxy(client, {
		get(target, key) {
			if (key === "$executeRawUnsafe") {
				return async (sql: string, ...values: unknown[]) => {
					const changed = await target.$executeRawUnsafe(sql, ...values);
					if (changed > 0 && sql.includes('"library_cleanup_media_server_scan_leases"')) {
						leases.push(
							...(db
								.prepare("SELECT * FROM library_cleanup_media_server_scan_leases")
								.all() as LeaseSnapshot[]),
						);
					}
					if (changed > 0 && sql.includes('"library_cleanup_media_server_scans"')) {
						scans.push(
							...(db
								.prepare(
									"SELECT status,executionToken,CAST(requestStartedAt AS TEXT) AS requestStartedAt,CAST(nextAttemptAt AS TEXT) AS nextAttemptAt,CAST(updatedAt AS TEXT) AS updatedAt FROM library_cleanup_media_server_scans",
								)
								.all() as ScanSnapshot[]),
						);
					}
					return changed;
				};
			}
			const value = Reflect.get(target, key, target);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
	const deps: CleanupExecutorDeps = {
		prisma,
		encryptor,
		arrClientFactory: {} as CleanupExecutorDeps["arrClientFactory"],
		log: pino({ level: "silent" }),
	};
	return {
		client,
		deps,
		leases,
		scans,
		routes,
		db,
		operationKey: `JELLYFIN:${identityFingerprint}:global-library-refresh`,
	};
}

describe("real media-server scan SQLite date writers", () => {
	it.each([
		{ attemptCount: 0, delay: 60_000 },
		{ attemptCount: 1, delay: 120_000 },
		{ attemptCount: 20, delay: 21_600_000 },
	])("persists exact canonical retry delay $delay after a real provider failure", async (input) => {
		const fixture = await createFixture(400, input.attemptCount);
		const result = await triggerMediaServerRescansForApproval(fixture.deps, "owner", "approval");
		expect(result).toMatchObject({ targets: 1, triggered: 0, failed: 1 });
		expect(fixture.routes).toEqual(["GET /System/Info", "POST /Library/Refresh"]);
		const failed = fixture.scans.find((row) => row.status === "failed");
		if (!failed) throw new Error("expected durable scan failure");
		expect(failed.requestStartedAt).toMatch(canonical);
		expect(failed.nextAttemptAt).toMatch(canonical);
		expect(failed.updatedAt).toMatch(canonical);
		expect(Date.parse(failed.nextAttemptAt!) - Date.parse(failed.updatedAt)).toBe(input.delay);
		expect(failed.executionToken).toBeNull();
		for (const lease of fixture.leases) {
			expect(lease.createdAt).toMatch(canonical);
			expect(lease.updatedAt).toMatch(canonical);
			expect(lease.userId).toBe("owner");
		}
		expect(fixture.leases.length).toBeGreaterThanOrEqual(3);
		expect(await fixture.client.libraryCleanupMediaServerScanLease.count()).toBe(0);
		// Database eligibility prevents an immediate retry and another HTTP scan.
		expect(
			await triggerMediaServerRescansForApproval(fixture.deps, "owner", "approval"),
		).toMatchObject({ targets: 0, triggered: 0, failed: 0 });
		expect(fixture.routes).toHaveLength(2);
	});

	it("reclaims only a stale operation lease, renews canonical dates and releases the exact owner", async () => {
		const fixture = await createFixture();
		await fixture.client.libraryCleanupMediaServerScanLease.create({
			data: {
				operationKey: fixture.operationKey,
				userId: "abandoned-owner",
				executionToken: "abandoned-token",
				createdAt: new Date("2000-01-01T00:00:00.123Z"),
				updatedAt: new Date("2000-01-01T00:00:00.123Z"),
			},
		});
		expect(
			await triggerMediaServerRescansForApproval(fixture.deps, "owner", "approval"),
		).toMatchObject({ targets: 1, triggered: 1, failed: 0 });
		expect(fixture.routes).toEqual(["GET /System/Info", "POST /Library/Refresh"]);
		expect(fixture.leases.length).toBeGreaterThanOrEqual(4);
		const tokens = new Set(fixture.leases.map((lease) => lease.executionToken));
		expect(tokens.size).toBe(1);
		expect(tokens.has("abandoned-token")).toBe(false);
		for (const lease of fixture.leases) {
			expect(lease.createdAt).toBe("2000-01-01T00:00:00.123+00:00");
			expect(lease.updatedAt).toMatch(canonical);
			expect(lease.userId).toBe("owner");
		}
		expect(fixture.scans[0]?.requestStartedAt).toMatch(canonical);
		expect(await fixture.client.libraryCleanupMediaServerScanLease.count()).toBe(0);
		expect(await fixture.client.libraryCleanupMediaServerScan.count()).toBe(0);
	});

	it("does not steal a live lease or issue a provider request", async () => {
		const fixture = await createFixture();
		await fixture.client.libraryCleanupMediaServerScanLease.create({
			data: {
				operationKey: fixture.operationKey,
				userId: "live-owner",
				executionToken: "live-token",
			},
		});
		const before = await fixture.client.libraryCleanupMediaServerScanLease.findMany();
		expect(
			await triggerMediaServerRescansForApproval(fixture.deps, "owner", "approval"),
		).toMatchObject({ targets: 1, triggered: 0, failed: 0 });
		expect(fixture.routes).toEqual([]);
		expect(fixture.leases).toEqual([]);
		expect(await fixture.client.libraryCleanupMediaServerScanLease.findMany()).toEqual(before);
	});
});
