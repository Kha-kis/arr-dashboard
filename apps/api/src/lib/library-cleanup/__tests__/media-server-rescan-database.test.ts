import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestPrismaClient } from "../../__tests__/test-prisma.js";
import type { PrismaClient } from "../../prisma.js";
import {
	prepareMediaServerRescans,
	triggerCoalescedMediaServerRescans,
} from "../media-server-rescan.js";

const RUN_DB_TESTS = process.env.TEST_DB === "true";
const execFileAsync = promisify(execFile);
const log = { warn: vi.fn(), error: vi.fn() };

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

(RUN_DB_TESTS ? describe : describe.skip)("media-server rescan persistence (SQLite)", () => {
	let prisma: PrismaClient;
	let databaseDir: string;

	beforeAll(async () => {
		databaseDir = await mkdtemp(path.join(os.tmpdir(), "arr-media-rescan-"));
		const databasePath = path.join(databaseDir, "rescan.db");
		const schemaPath = path.resolve(import.meta.dirname, "../../../../prisma/schema.prisma");
		const prismaCli = path.resolve(
			import.meta.dirname,
			"../../../../node_modules/prisma/build/index.js",
		);
		await execFileAsync(process.execPath, [
			prismaCli,
			"db",
			"push",
			"--schema",
			schemaPath,
			"--url",
			`file:${databasePath}`,
		]);
		prisma = createTestPrismaClient(databasePath);
	});

	beforeEach(async () => {
		await prisma.libraryCleanupMediaServerScanLease.deleteMany();
		await prisma.user.deleteMany();
		await prisma.user.create({ data: { id: "rescan-user", username: "rescan-user" } });
		await prisma.libraryCleanupConfig.create({
			data: { id: "rescan-config", userId: "rescan-user" },
		});
		await prisma.serviceInstance.create({
			data: {
				id: "jellyfin-1",
				userId: "rescan-user",
				service: "JELLYFIN",
				label: "Primary Jellyfin",
				baseUrl: "http://jellyfin.internal:8096",
				encryptedApiKey: "encrypted",
				encryptionIv: "iv",
				expectedIdentity: "server-1",
				identityKind: "JELLYFIN_SERVER_ID",
				identityStatus: "VERIFIED",
				identityGeneration: 1,
				identityVerifiedAt: new Date(),
				identityLastCheckedAt: new Date(),
			},
		});
		for (const id of ["approval-1", "approval-2"]) {
			await prisma.libraryCleanupApproval.create({
				data: {
					id,
					configId: "rescan-config",
					instanceId: "radarr-1",
					arrItemId: id === "approval-1" ? 101 : 102,
					itemType: "movie",
					title: id,
					matchedRuleId: "rule-1",
					matchedRuleName: "Delete old media",
					reason: "Matched cleanup rule",
					sizeOnDisk: 1n,
					scanMediaServerAfterDelete: true,
					scanMediaServerInstanceIds: '["jellyfin-1"]',
					expiresAt: new Date("2027-01-01T00:00:00.000Z"),
				},
			});
		}
	});

	afterAll(async () => {
		await prisma.$disconnect();
		await rm(databaseDir, { recursive: true, force: true });
	});

	it("enforces unique scan targets and operation leases in the schema", async () => {
		await prisma.libraryCleanupMediaServerScan.create({
			data: {
				approvalId: "approval-1",
				instanceId: "jellyfin-1",
				service: "JELLYFIN",
				serverIdentity: "JELLYFIN:server-1",
				mediaType: "movie",
				targetKey: "JELLYFIN:jellyfin-1:movie",
			},
		});
		await expect(
			prisma.libraryCleanupMediaServerScan.create({
				data: {
					approvalId: "approval-1",
					instanceId: "jellyfin-1",
					service: "JELLYFIN",
					serverIdentity: "JELLYFIN:server-1",
					mediaType: "movie",
					targetKey: "JELLYFIN:jellyfin-1:movie",
				},
			}),
		).rejects.toMatchObject({ code: "P2002" });

		await prisma.libraryCleanupMediaServerScanLease.create({
			data: { operationKey: "operation-1", userId: "rescan-user", executionToken: "token-1" },
		});
		await expect(
			prisma.libraryCleanupMediaServerScanLease.create({
				data: {
					operationKey: "operation-2",
					userId: "rescan-user",
					executionToken: "token-1",
				},
			}),
		).rejects.toMatchObject({ code: "P2002" });
	});

	it("prepares idempotently and coalesces concurrent durable approvals into one refresh", async () => {
		const gate = deferred();
		const refreshLibrary = vi.fn(async () => await gate.promise);
		const deps = {
			prisma,
			log,
			jellyfinRescanClientFactory: () => ({
				getPublicInfo: vi.fn().mockResolvedValue({ id: "server-1" }),
				getServerInfo: vi.fn().mockResolvedValue({ id: "server-1" }),
				refreshLibrary,
			}),
		};
		const approval1 = await prisma.libraryCleanupApproval.findUniqueOrThrow({
			where: { id: "approval-1" },
		});
		const approval2 = await prisma.libraryCleanupApproval.findUniqueOrThrow({
			where: { id: "approval-2" },
		});

		await expect(prepareMediaServerRescans(deps, "rescan-user", approval1, "movie")).resolves.toBe(
			1,
		);
		await expect(prepareMediaServerRescans(deps, "rescan-user", approval1, "movie")).resolves.toBe(
			1,
		);
		await prepareMediaServerRescans(deps, "rescan-user", approval2, "movie");
		expect(await prisma.libraryCleanupMediaServerScan.count()).toBe(2);

		await prisma.libraryCleanupApproval.updateMany({
			where: { id: { in: ["approval-1", "approval-2"] } },
			data: { status: "executed", terminalAuditRecordedAt: new Date() },
		});

		const first = triggerCoalescedMediaServerRescans(deps, "rescan-user", ["approval-1"]);
		await vi.waitFor(() => expect(refreshLibrary).toHaveBeenCalledOnce());
		const second = await triggerCoalescedMediaServerRescans(deps, "rescan-user", ["approval-2"]);
		expect(second.triggered).toBe(0);
		gate.resolve();
		await expect(first).resolves.toMatchObject({ triggered: 2, failed: 0 });

		expect(refreshLibrary).toHaveBeenCalledOnce();
		expect(
			await prisma.libraryCleanupMediaServerScan.findMany({
				select: { status: true },
				orderBy: { approvalId: "asc" },
			}),
		).toEqual([{ status: "triggered" }, { status: "triggered" }]);
		expect(await prisma.libraryCleanupMediaServerScanLease.count()).toBe(0);
	});
});
