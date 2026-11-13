import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createTestPrismaClient } from "../../__tests__/test-prisma.js";
import type { PrismaClient } from "../../prisma.js";
import * as snapshot from "../dashboard-statistics-snapshot.js";

async function fingerprintDashboardSources(
	sources: Array<{
		id: string;
		service: "RADARR" | "SONARR";
		enabled: boolean;
		updatedAt: Date;
	}>,
) {
	const module = await import("../dashboard-statistics-snapshot.js").catch(() => null);
	return module?.fingerprintDashboardSources(sources);
}

const first = {
	id: "synthetic-first",
	service: "RADARR" as const,
	enabled: true,
	updatedAt: new Date("2026-09-29T00:00:00.000Z"),
};
const second = {
	id: "synthetic-second",
	service: "SONARR" as const,
	enabled: true,
	updatedAt: new Date("2026-09-29T00:00:00.000Z"),
};

describe("Dashboard statistics source fingerprint", () => {
	it("is order-independent for the same enabled ARR connections", async () => {
		const forward = await fingerprintDashboardSources([first, second]);
		const reverse = await fingerprintDashboardSources([second, first]);

		expect(forward).toBe(reverse);
		expect(forward).toMatch(/^[a-f0-9]{64}$/);
	});

	it("changes when an enabled connection is edited", async () => {
		const before = await fingerprintDashboardSources([first, second]);
		const after = await fingerprintDashboardSources([
			first,
			{ ...second, updatedAt: new Date("2026-09-29T00:00:01.000Z") },
		]);

		expect(after).not.toBe(before);
	});
});

const databases: Array<{ directory: string; prisma: PrismaClient }> = [];
const NOW = new Date("2026-09-29T12:00:00.000Z");
const PAYLOAD = {
	sonarr: { instances: [] },
	radarr: { instances: [] },
	prowlarr: { instances: [] },
	lidarr: { instances: [] },
	readarr: { instances: [] },
};

afterEach(async () => {
	for (const database of databases.splice(0)) {
		await database.prisma.$disconnect();
		rmSync(database.directory, { recursive: true, force: true });
	}
});

async function database() {
	const directory = mkdtempSync(join(tmpdir(), "dashboard-statistics-snapshot-"));
	const dbPath = join(directory, "test.db");
	execFileSync("pnpm", ["exec", "prisma", "db", "push", "--schema", "prisma/schema.prisma"], {
		cwd: process.cwd(),
		env: { ...process.env, DATABASE_URL: `file:${dbPath}` },
		stdio: "ignore",
	});
	const prisma = createTestPrismaClient(dbPath);
	databases.push({ directory, prisma });
	await prisma.user.create({ data: { id: "owner", username: "synthetic-owner" } });
	return { prisma, dbPath };
}

describe("Dashboard statistics durable snapshot", { timeout: 30_000 }, () => {
	it("does not invent totals when no snapshot has been published", async () => {
		const { prisma } = await database();
		const read = Reflect.get(snapshot, "readDashboardSnapshot") as
			| ((...args: unknown[]) => Promise<unknown>)
			| undefined;
		const result = read ? await read(prisma, "owner", "synthetic-fingerprint", NOW) : undefined;

		expect(result).toEqual({
			availability: "unavailable",
			observedAt: null,
			data: null,
			refreshDue: true,
		});
	});

	it("grants only one first claim across concurrent database clients", async () => {
		const { prisma, dbPath } = await database();
		const fingerprint = snapshot.fingerprintDashboardSources([]);
		const secondClient = createTestPrismaClient(dbPath);
		const claim = Reflect.get(snapshot, "claimDashboardRefresh") as
			| ((...args: unknown[]) => Promise<boolean>)
			| undefined;
		try {
			const results = claim
				? await Promise.all([
						claim(prisma, "owner", fingerprint, "token-one", NOW),
						claim(secondClient, "owner", fingerprint, "token-two", NOW),
					])
				: [];
			expect(results.filter(Boolean)).toHaveLength(1);
			const row = await prisma.dashboardStatisticsSnapshot.findUnique({
				where: { userId: "owner" },
			});
			expect(["token-one", "token-two"]).toContain(row?.claimToken);
			expect(row?.leaseUntil).toEqual(new Date(NOW.getTime() + 120_000));
		} finally {
			await secondClient.$disconnect();
		}
	});

	it.each([
		{ ageMs: 60_000, result: "complete", availability: "current", refreshDue: false },
		{ ageMs: 16 * 60_000, result: "complete", availability: "last-known", refreshDue: true },
		{ ageMs: 60_000, result: "partial", availability: "partial", refreshDue: true },
		{ ageMs: 25 * 60 * 60_000, result: "complete", availability: "unavailable", refreshDue: true },
	])("classifies a $result snapshot aged $ageMs ms", async (scenario) => {
		const { prisma } = await database();
		const observedAt = new Date(NOW.getTime() - scenario.ageMs);
		await prisma.dashboardStatisticsSnapshot.create({
			data: {
				userId: "owner",
				sourceFingerprint: "fingerprint",
				payload: JSON.stringify(PAYLOAD),
				result: scenario.result,
				observedAt,
			},
		});
		const actual = await snapshot.readDashboardSnapshot(prisma, "owner", "fingerprint", NOW);
		expect(actual).toEqual({
			availability: scenario.availability,
			observedAt: scenario.availability === "unavailable" ? null : observedAt,
			data: scenario.availability === "unavailable" ? null : PAYLOAD,
			refreshDue: scenario.refreshDue,
		});
	});

	it("never serves an old source configuration or another user's publication", async () => {
		const { prisma } = await database();
		await prisma.user.create({ data: { id: "other", username: "synthetic-other" } });
		await prisma.dashboardStatisticsSnapshot.create({
			data: {
				userId: "owner",
				sourceFingerprint: "before-edit",
				payload: JSON.stringify(PAYLOAD),
				result: "complete",
				observedAt: NOW,
			},
		});
		const afterEdit = await snapshot.readDashboardSnapshot(prisma, "owner", "after-edit", NOW);
		const anotherUser = await snapshot.readDashboardSnapshot(prisma, "other", "before-edit", NOW);
		expect(afterEdit.data).toBeNull();
		expect(afterEdit.availability).toBe("unavailable");
		expect(anotherUser.data).toBeNull();
		expect(anotherUser.availability).toBe("unavailable");
	});

	it("retains a matching publication during a refresh without claiming it is current", async () => {
		const { prisma } = await database();
		const observedAt = new Date(NOW.getTime() - 16 * 60_000);
		await prisma.dashboardStatisticsSnapshot.create({
			data: {
				userId: "owner",
				sourceFingerprint: "fingerprint",
				payload: JSON.stringify(PAYLOAD),
				result: "complete",
				observedAt,
				claimFingerprint: "fingerprint",
				claimToken: "active",
				leaseUntil: new Date(NOW.getTime() + 30_000),
			},
		});
		const actual = await snapshot.readDashboardSnapshot(prisma, "owner", "fingerprint", NOW);
		expect(actual).toEqual({
			availability: "last-known",
			observedAt,
			data: PAYLOAD,
			refreshDue: false,
		});
	});

	it("publishes only for the exact live claim and unchanged source set", async () => {
		const { prisma } = await database();
		const source = await prisma.serviceInstance.create({
			data: {
				userId: "owner",
				service: "RADARR",
				label: "synthetic",
				baseUrl: "http://example.invalid",
				encryptedApiKey: "synthetic",
				encryptionIv: "synthetic",
			},
		});
		const fingerprint = snapshot.fingerprintDashboardSources([source]);
		const publish = Reflect.get(snapshot, "publishDashboardSnapshot") as
			| ((...args: unknown[]) => Promise<boolean>)
			| undefined;
		expect(await snapshot.claimDashboardRefresh(prisma, "owner", fingerprint, "first", NOW)).toBe(
			true,
		);
		const wrongToken = publish
			? await publish(prisma, "owner", fingerprint, "wrong", NOW, PAYLOAD, "complete", NOW)
			: undefined;
		expect(wrongToken).toBe(false);
		await prisma.serviceInstance.update({
			where: { id: source.id },
			data: { updatedAt: new Date(NOW.getTime() + 1_000) },
		});
		const editedSource = publish
			? await publish(prisma, "owner", fingerprint, "first", NOW, PAYLOAD, "complete", NOW)
			: undefined;
		expect(editedSource).toBe(false);
		expect(
			(await snapshot.readDashboardSnapshot(prisma, "owner", fingerprint, NOW)).data,
		).toBeNull();
		const updatedSource = await prisma.serviceInstance.findUniqueOrThrow({
			where: { id: source.id },
		});
		const updatedFingerprint = snapshot.fingerprintDashboardSources([updatedSource]);
		expect(
			await snapshot.claimDashboardRefresh(prisma, "owner", updatedFingerprint, "second", NOW),
		).toBe(true);
		const successful = publish
			? await publish(prisma, "owner", updatedFingerprint, "second", NOW, PAYLOAD, "complete", NOW)
			: undefined;
		expect(successful).toBe(true);
		expect(
			(await snapshot.readDashboardSnapshot(prisma, "owner", updatedFingerprint, NOW)).availability,
		).toBe("current");
	});

	it("rejects expired or superseded publication tokens", async () => {
		const { prisma } = await database();
		const fingerprint = snapshot.fingerprintDashboardSources([]);
		const publish = Reflect.get(snapshot, "publishDashboardSnapshot") as
			| ((...args: unknown[]) => Promise<boolean>)
			| undefined;
		expect(await snapshot.claimDashboardRefresh(prisma, "owner", fingerprint, "old", NOW)).toBe(
			true,
		);
		const later = new Date(NOW.getTime() + 121_000);
		const expired = publish
			? await publish(prisma, "owner", fingerprint, "old", later, PAYLOAD, "complete", later)
			: undefined;
		expect(expired).toBe(false);
		expect(await snapshot.claimDashboardRefresh(prisma, "owner", fingerprint, "new", later)).toBe(
			true,
		);
		const superseded = publish
			? await publish(prisma, "owner", fingerprint, "old", later, PAYLOAD, "complete", later)
			: undefined;
		expect(superseded).toBe(false);
	});

	it("preserves last-known data and delays retry after a failed exact claim", async () => {
		const { prisma } = await database();
		const fingerprint = snapshot.fingerprintDashboardSources([]);
		const observedAt = new Date(NOW.getTime() - 16 * 60_000);
		await prisma.dashboardStatisticsSnapshot.create({
			data: {
				userId: "owner",
				sourceFingerprint: fingerprint,
				payload: JSON.stringify(PAYLOAD),
				result: "complete",
				observedAt,
			},
		});
		const fail = Reflect.get(snapshot, "failDashboardRefresh") as
			| ((...args: unknown[]) => Promise<boolean>)
			| undefined;
		expect(await snapshot.claimDashboardRefresh(prisma, "owner", fingerprint, "active", NOW)).toBe(
			true,
		);
		const wrongToken = fail
			? await fail(prisma, "owner", fingerprint, "wrong", NOW, "provider-unavailable")
			: undefined;
		expect(wrongToken).toBe(false);
		const settled = fail
			? await fail(prisma, "owner", fingerprint, "active", NOW, "provider-unavailable")
			: undefined;
		expect(settled).toBe(true);
		expect(await snapshot.readDashboardSnapshot(prisma, "owner", fingerprint, NOW)).toEqual({
			availability: "last-known",
			observedAt,
			data: PAYLOAD,
			refreshDue: false,
		});
		expect(await snapshot.claimDashboardRefresh(prisma, "owner", fingerprint, "early", NOW)).toBe(
			false,
		);
		const retryAt = new Date(NOW.getTime() + 60_000);
		expect(
			await snapshot.claimDashboardRefresh(prisma, "owner", fingerprint, "retry", retryAt),
		).toBe(true);
	});

	it("does not let a stale request displace the current source claim", async () => {
		const { prisma } = await database();
		const source = await prisma.serviceInstance.create({
			data: {
				userId: "owner",
				service: "RADARR",
				label: "synthetic",
				baseUrl: "http://example.invalid",
				encryptedApiKey: "synthetic",
				encryptionIv: "synthetic",
			},
		});
		const oldFingerprint = snapshot.fingerprintDashboardSources([source]);
		await prisma.serviceInstance.update({
			where: { id: source.id },
			data: { updatedAt: new Date(source.updatedAt.getTime() + 1_000) },
		});
		const updated = await prisma.serviceInstance.findUniqueOrThrow({ where: { id: source.id } });
		const currentFingerprint = snapshot.fingerprintDashboardSources([updated]);
		expect(
			await snapshot.claimDashboardRefresh(prisma, "owner", currentFingerprint, "current", NOW),
		).toBe(true);
		expect(
			await snapshot.claimDashboardRefresh(prisma, "owner", oldFingerprint, "stale", NOW),
		).toBe(false);
		expect(
			(await prisma.dashboardStatisticsSnapshot.findUnique({ where: { userId: "owner" } }))
				?.claimToken,
		).toBe("current");
	});

	it("applies retry delay to the failed fingerprint but not to a newer source", async () => {
		const { prisma } = await database();
		const source = await prisma.serviceInstance.create({
			data: {
				userId: "owner",
				service: "RADARR",
				label: "synthetic",
				baseUrl: "http://example.invalid",
				encryptedApiKey: "synthetic",
				encryptionIv: "synthetic",
			},
		});
		const fingerprint = snapshot.fingerprintDashboardSources([source]);
		expect(await snapshot.claimDashboardRefresh(prisma, "owner", fingerprint, "failed", NOW)).toBe(
			true,
		);
		expect(
			await snapshot.failDashboardRefresh(
				prisma,
				"owner",
				fingerprint,
				"failed",
				NOW,
				"provider-unavailable",
			),
		).toBe(true);
		const early = new Date(NOW.getTime() + 10_000);
		expect(
			(await snapshot.readDashboardSnapshot(prisma, "owner", fingerprint, early)).refreshDue,
		).toBe(false);
		await prisma.serviceInstance.update({
			where: { id: source.id },
			data: { updatedAt: new Date(source.updatedAt.getTime() + 1_000) },
		});
		const updated = await prisma.serviceInstance.findUniqueOrThrow({ where: { id: source.id } });
		expect(
			(
				await snapshot.readDashboardSnapshot(
					prisma,
					"owner",
					snapshot.fingerprintDashboardSources([updated]),
					early,
				)
			).refreshDue,
		).toBe(true);
	});

	it("renews only the live token and permits a bounded longer collection to publish", async () => {
		const { prisma } = await database();
		const fingerprint = snapshot.fingerprintDashboardSources([]);
		const renew = Reflect.get(snapshot, "renewDashboardRefreshClaim") as
			| ((...args: unknown[]) => Promise<boolean>)
			| undefined;
		expect(await snapshot.claimDashboardRefresh(prisma, "owner", fingerprint, "live", NOW)).toBe(
			true,
		);
		const renewalAt = new Date(NOW.getTime() + 90_000);
		expect(renew ? await renew(prisma, "owner", fingerprint, "wrong", renewalAt) : undefined).toBe(
			false,
		);
		expect(renew ? await renew(prisma, "owner", fingerprint, "live", renewalAt) : undefined).toBe(
			true,
		);
		const publishAt = new Date(NOW.getTime() + 150_000);
		expect(
			await snapshot.publishDashboardSnapshot(
				prisma,
				"owner",
				fingerprint,
				"live",
				publishAt,
				PAYLOAD,
				"complete",
				publishAt,
			),
		).toBe(true);
	});
});
