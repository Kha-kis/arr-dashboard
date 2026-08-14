/**
 * HTTP contract tests for the non-blocking Tautulli provider notices.
 *
 * These tests deliberately keep provider, cache, and rule fixtures as real
 * in-memory rows. The system route may inspect provider state and persist a
 * user-scoped notice dismissal, but it must never mutate those rows.
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TAUTULLI_PASS_REPORT_FILE } from "../../lib/rules-migration/tautulli-pass.js";
import schedulerRegistryPlugin from "../../plugins/scheduler-registry.js";
import { registerSystemRoutes } from "../system.js";
import { AUTH_HEADER, createInjectAuthenticated, setupAuthInjection } from "./test-helpers.js";

let app: ReturnType<typeof Fastify>;
let injectAuthenticated: ReturnType<typeof createInjectAuthenticated>;
let dataDir: string;

type InstanceRow = { id: string; label: string; userId: string; service: "TAUTULLI" | "TRACEARR" };
type DismissalRow = { id: string; userId: string; noticeKey: string; dismissedAt: Date };
type RuleRow = { id: string; userId: string; name: string };

let instanceRows: InstanceRow[];
let dismissalRows: DismissalRow[];
let ruleRows: RuleRow[];
let settings: {
	analyticsProvider: "tracearr" | "tautulli" | null;
	analyticsProviderSource: string | null;
};

const serviceInstanceFindMany = vi.fn(
	async ({ where }: { where: { userId: string; service: "TAUTULLI" | "TRACEARR" } }) =>
		instanceRows.filter((row) => row.userId === where.userId && row.service === where.service),
);
const serviceInstanceCount = vi.fn(
	async ({
		where,
	}: {
		where: { userId: string; service: "TAUTULLI" | "TRACEARR"; enabled?: boolean };
	}) =>
		instanceRows.filter(
			(row) =>
				row.userId === where.userId &&
				row.service === where.service &&
				(where.enabled === undefined || where.enabled === true),
		).length,
);
const systemSettingsFindUnique = vi.fn(async () => ({ ...settings }));
const systemSettingsUpsert = vi.fn(async ({ create, update }: any) => {
	settings = {
		analyticsProvider: update.analyticsProvider ?? create.analyticsProvider,
		analyticsProviderSource: update.analyticsProviderSource ?? create.analyticsProviderSource,
	};
	return { ...settings };
});
const dismissalFindMany = vi.fn(async ({ where }: { where: { userId: string } }) =>
	dismissalRows.filter((row) => row.userId === where.userId),
);
const dismissalUpsert = vi.fn(
	async ({
		where,
		create,
	}: {
		where: { userId_noticeKey: { userId: string; noticeKey: string } };
		create: { userId: string; noticeKey: string };
	}) => {
		const existing = dismissalRows.find(
			(row) =>
				row.userId === where.userId_noticeKey.userId &&
				row.noticeKey === where.userId_noticeKey.noticeKey,
		);
		if (existing) return existing;
		const row = { id: `dismissal-${dismissalRows.length + 1}`, ...create, dismissedAt: new Date() };
		dismissalRows.push(row);
		return row;
	},
);
const affectedRuleFindMany = vi.fn(
	async ({
		where,
	}: {
		where: { userId?: string; config?: { userId: string }; id: { in: string[] } };
	}) => {
		const userId = where.userId ?? where.config?.userId;
		return ruleRows.filter((row) => where.id.in.includes(row.id) && row.userId === userId);
	},
);

beforeEach(async () => {
	dataDir = await mkdtemp(path.join(tmpdir(), "tautulli-notice-route-"));
	instanceRows = [];
	dismissalRows = [];
	ruleRows = [{ id: "rule-1", userId: "user-1", name: "Keep my Tautulli rule" }];
	settings = { analyticsProvider: null, analyticsProviderSource: null };
	serviceInstanceFindMany.mockClear();
	serviceInstanceCount.mockClear();
	systemSettingsFindUnique.mockClear();
	systemSettingsUpsert.mockClear();
	dismissalFindMany.mockClear();
	dismissalUpsert.mockClear();
	affectedRuleFindMany.mockClear();

	app = Fastify();
	const prisma = {
		systemSettings: {
			findUnique: systemSettingsFindUnique,
			create: vi.fn(),
			upsert: systemSettingsUpsert,
		},
		serviceInstance: { findMany: serviceInstanceFindMany, count: serviceInstanceCount },
		systemNoticeDismissal: { findMany: dismissalFindMany, upsert: dismissalUpsert },
		libraryCleanupRule: { findMany: affectedRuleFindMany },
		autoTagRule: { findMany: affectedRuleFindMany },
	};
	app.decorate("prisma", {
		...prisma,
		$transaction: async (callback: (transaction: typeof prisma) => unknown) => callback(prisma),
	} as never);
	app.decorate("config", {
		TRUST_PROXY: false,
		COOKIE_SECURE: false,
		DATABASE_URL: `file:${path.join(dataDir, "prod.db")}`,
	} as never);
	app.decorate("dbProvider", "sqlite" as never);
	app.decorate("lifecycle", { getRestartMessage: () => "ok", restart: vi.fn() } as never);

	setupAuthInjection(app);
	app.addHook("preHandler", async (request: any) => {
		if (request.headers[AUTH_HEADER] && request.headers["x-test-user"] === "user-2") {
			request.currentUser = { id: "user-2", username: "other-admin" };
		}
	});
	await app.register(schedulerRegistryPlugin);
	await app.register(registerSystemRoutes, { prefix: "/system" });
	await app.ready();

	injectAuthenticated = createInjectAuthenticated(app);
});

afterEach(async () => {
	await app?.close();
	await rm(dataDir, { recursive: true, force: true });
});

async function seedPriorRemovalReport(acknowledged = true) {
	const backupDir = path.join(dataDir, "rules-pre-3.0");
	await mkdir(backupDir, { recursive: true });
	await writeFile(
		path.join(backupDir, TAUTULLI_PASS_REPORT_FILE),
		JSON.stringify({
			ranAt: "2026-06-10T00:00:00.000Z",
			surfaces: {
				"library-cleanup": {
					rulesScanned: 1,
					rulesDisabled: [{ id: "rule-1", name: "Private rule", reason: "tautulli-orphaned" }],
					rulesModified: [],
					rulesUnparseable: [],
				},
				"auto-tag": { rulesScanned: 0, rulesDisabled: [], rulesModified: [], rulesUnparseable: [] },
			},
			totalAffectedRules: 1,
			...(acknowledged ? { acknowledgedAt: "2026-06-10T01:00:00.000Z" } : {}),
		}),
		"utf-8",
	);
}

async function seedPartialPassReport() {
	const backupDir = path.join(dataDir, "rules-pre-3.0");
	await mkdir(backupDir, { recursive: true });
	await writeFile(
		path.join(backupDir, TAUTULLI_PASS_REPORT_FILE),
		JSON.stringify({
			ranAt: "2026-06-10T00:00:00.000Z",
			surfaces: {
				"library-cleanup": {
					rulesScanned: 1,
					rulesDisabled: [],
					rulesModified: [],
					rulesUnparseable: [],
				},
			},
			totalAffectedRules: 0,
		}),
		"utf-8",
	);
}

async function getNoticesForUser(userId = "user-1") {
	const response = await app.inject({
		method: "GET",
		url: "/system/migrations/tautulli",
		headers: { [AUTH_HEADER]: "1", ...(userId === "user-2" ? { "x-test-user": "user-2" } : {}) },
	});
	expect(response.statusCode).toBe(200);
	return JSON.parse(response.payload);
}

describe("GET /system/migrations/tautulli", () => {
	it.each([
		["neither provider", [], []],
		[
			"Tautulli only",
			[{ id: "ta-1", label: "private-tautulli", userId: "user-1", service: "TAUTULLI" }],
			[],
		],
		[
			"Tracearr only",
			[{ id: "tr-1", label: "private-tracearr", userId: "user-1", service: "TRACEARR" }],
			[],
		],
	] as const)("returns no notice when %s is configured", async (_state, instances, expected) => {
		instanceRows = [...instances];

		await expect(getNoticesForUser()).resolves.toEqual({ notices: expected });
	});

	it("returns a safe both-configured notice without provider labels or URLs", async () => {
		instanceRows = [
			{
				id: "ta-1",
				label: "Tautulli at https://secret.example",
				userId: "user-1",
				service: "TAUTULLI",
			},
			{
				id: "tr-1",
				label: "Tracearr https://user:password@example",
				userId: "user-1",
				service: "TRACEARR",
			},
		];

		const response = await app.inject({
			method: "GET",
			url: "/system/migrations/tautulli",
			headers: { [AUTH_HEADER]: "1" },
		});

		expect(response.statusCode).toBe(200);
		expect(JSON.parse(response.payload)).toEqual({
			notices: [
				{
					key: "tautulli-both-configured",
					kind: "both-configured",
					selected: "tracearr",
					actionUrl: "/settings/services#analytics-provider",
				},
			],
		});
		expect(response.payload).not.toContain("secret.example");
		expect(response.payload).not.toContain("password");
	});

	it("does not attribute acknowledged rules-only migration state to a provider removal", async () => {
		await seedPriorRemovalReport();

		await expect(getNoticesForUser()).resolves.toEqual({ notices: [] });
	});

	it("does not attribute an installation-wide acknowledgment to another user", async () => {
		await seedPriorRemovalReport();

		await expect(getNoticesForUser("user-2")).resolves.toEqual({ notices: [] });
		await expect(getNoticesForUser("user-1")).resolves.toEqual({ notices: [] });
	});

	it("does not infer prior removal from a missing Tautulli row", async () => {
		await expect(getNoticesForUser()).resolves.toEqual({ notices: [] });
	});

	it("does not treat an unacknowledged rules report as proof that removal completed", async () => {
		await seedPriorRemovalReport(false);

		await expect(getNoticesForUser()).resolves.toEqual({ notices: [] });
	});

	it("keeps the independent both-configured notice available when a report is partial", async () => {
		instanceRows = [
			{ id: "ta-1", label: "Tautulli", userId: "user-1", service: "TAUTULLI" },
			{ id: "tr-1", label: "Tracearr", userId: "user-1", service: "TRACEARR" },
		];
		await seedPartialPassReport();

		await expect(getNoticesForUser()).resolves.toEqual({
			notices: [
				{
					key: "tautulli-both-configured",
					kind: "both-configured",
					selected: "tracearr",
					actionUrl: "/settings/services#analytics-provider",
				},
			],
		});
	});

	it("keeps the both-configured notice dormant after an explicit provider selection", async () => {
		instanceRows = [
			{ id: "ta-1", label: "Tautulli", userId: "user-1", service: "TAUTULLI" },
			{ id: "tr-1", label: "Tracearr", userId: "user-1", service: "TRACEARR" },
		];
		settings = { analyticsProvider: "tautulli", analyticsProviderSource: "explicit" };

		await expect(getNoticesForUser()).resolves.toEqual({ notices: [] });
	});

	it("hides only the current user's dismissed notice", async () => {
		instanceRows = [
			{ id: "ta-1", label: "Tautulli", userId: "user-1", service: "TAUTULLI" },
			{ id: "tr-1", label: "Tracearr", userId: "user-1", service: "TRACEARR" },
		];
		dismissalRows = [
			{
				id: "dismissal-1",
				userId: "user-1",
				noticeKey: "tautulli-both-configured",
				dismissedAt: new Date(),
			},
		];

		await expect(getNoticesForUser()).resolves.toEqual({ notices: [] });
	});
});

describe("POST /system/migrations/tautulli", () => {
	it("validates and idempotently persists the current user's dismissal without changing provider or rule rows", async () => {
		instanceRows = [
			{ id: "ta-1", label: "Tautulli", userId: "user-1", service: "TAUTULLI" },
			{ id: "tr-1", label: "Tracearr", userId: "user-1", service: "TRACEARR" },
			{ id: "ta-2", label: "Other Tautulli", userId: "user-2", service: "TAUTULLI" },
		];
		const providersBefore = structuredClone(instanceRows);
		const rulesBefore = structuredClone(ruleRows);

		const first = await injectAuthenticated("POST", "/system/migrations/tautulli", {
			body: { key: "tautulli-both-configured" },
		});
		const second = await injectAuthenticated("POST", "/system/migrations/tautulli", {
			body: { key: "tautulli-both-configured" },
		});

		expect(first.statusCode).toBe(200);
		expect(JSON.parse(first.payload)).toEqual({ success: true });
		expect(second.statusCode).toBe(200);
		expect(JSON.parse(second.payload)).toEqual({ success: true });
		expect(dismissalRows).toHaveLength(1);
		expect(dismissalRows[0]).toMatchObject({
			userId: "user-1",
			noticeKey: "tautulli-both-configured",
		});
		expect(instanceRows).toEqual(providersBefore);
		expect(ruleRows).toEqual(rulesBefore);
	});

	it("keeps dismissals isolated between users", async () => {
		instanceRows = [
			{ id: "ta-1", label: "Tautulli", userId: "user-1", service: "TAUTULLI" },
			{ id: "tr-1", label: "Tracearr", userId: "user-1", service: "TRACEARR" },
			{ id: "ta-2", label: "Other Tautulli", userId: "user-2", service: "TAUTULLI" },
			{ id: "tr-2", label: "Other Tracearr", userId: "user-2", service: "TRACEARR" },
		];

		await injectAuthenticated("POST", "/system/migrations/tautulli", {
			body: { key: "tautulli-both-configured" },
		});

		await expect(getNoticesForUser("user-2")).resolves.toEqual({
			notices: [
				{
					key: "tautulli-both-configured",
					kind: "both-configured",
					selected: "tracearr",
					actionUrl: "/settings/services#analytics-provider",
				},
			],
		});
	});

	it("rejects a malformed notice key without persisting a dismissal", async () => {
		const response = await injectAuthenticated("POST", "/system/migrations/tautulli", {
			body: { key: "arbitrary-key" },
		});

		expect(response.statusCode).toBe(400);
		expect(dismissalRows).toEqual([]);
	});
});
