/**
 * GET/POST /system/migrations/tautulli HTTP integration tests (ADR-0007).
 *
 * Pins the migration-dialog contract:
 *   - GET reports needed=true with instance labels while TAUTULLI rows linger
 *   - GET includes the rules-pass report when one exists, null when not
 *   - GET is needed=false (and skips the report read) once rows are gone
 *   - POST deletes only the current user's TAUTULLI rows and is idempotent
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TAUTULLI_PASS_REPORT_FILE } from "../../lib/rules-migration/tautulli-pass.js";
import schedulerRegistryPlugin from "../../plugins/scheduler-registry.js";
import { registerSystemRoutes } from "../system.js";
import { createInjectAuthenticated, setupAuthInjection } from "./test-helpers.js";

let app: ReturnType<typeof Fastify>;
let injectAuthenticated: ReturnType<typeof createInjectAuthenticated>;
let dataDir: string;

type InstanceRow = { id: string; label: string; userId: string; service: string };
let instanceRows: InstanceRow[];

const findMany = vi.fn(async ({ where }: { where: { userId: string; service: string } }) =>
	instanceRows
		.filter((r) => r.userId === where.userId && r.service === where.service)
		.map((r) => ({ id: r.id, label: r.label })),
);
const deleteMany = vi.fn(async ({ where }: { where: { userId: string; service: string } }) => {
	const before = instanceRows.length;
	instanceRows = instanceRows.filter(
		(r) => !(r.userId === where.userId && r.service === where.service),
	);
	return { count: before - instanceRows.length };
});

beforeEach(async () => {
	dataDir = await mkdtemp(path.join(tmpdir(), "tautulli-migration-route-"));
	instanceRows = [];
	findMany.mockClear();
	deleteMany.mockClear();

	app = Fastify();
	app.decorate("prisma", {
		systemSettings: { findUnique: vi.fn(), create: vi.fn(), upsert: vi.fn() },
		serviceInstance: { findMany, deleteMany },
	} as never);
	// DATABASE_URL inside dataDir so dirname(resolveSecretsPath(...)) === dataDir
	app.decorate("config", {
		TRUST_PROXY: false,
		COOKIE_SECURE: false,
		DATABASE_URL: `file:${path.join(dataDir, "prod.db")}`,
	} as never);
	app.decorate("dbProvider", "sqlite" as never);
	app.decorate("lifecycle", { getRestartMessage: () => "ok", restart: vi.fn() } as never);

	setupAuthInjection(app);
	await app.register(schedulerRegistryPlugin);
	await app.register(registerSystemRoutes, { prefix: "/system" });
	await app.ready();

	injectAuthenticated = createInjectAuthenticated(app);
});

afterEach(async () => {
	await app?.close();
	await rm(dataDir, { recursive: true, force: true });
});

async function seedReport() {
	const backupDir = path.join(dataDir, "rules-pre-3.0");
	await mkdir(backupDir, { recursive: true });
	await writeFile(
		path.join(backupDir, TAUTULLI_PASS_REPORT_FILE),
		JSON.stringify({
			ranAt: "2026-06-10T00:00:00.000Z",
			surfaces: {
				"library-cleanup": {
					rulesScanned: 3,
					rulesDisabled: [{ id: "c1", name: "Old watch rule", reason: "tautulli-orphaned" }],
					rulesModified: [],
					rulesUnparseable: [],
				},
				"auto-tag": {
					rulesScanned: 1,
					rulesDisabled: [],
					rulesModified: [],
					rulesUnparseable: [],
				},
			},
			totalAffectedRules: 1,
		}),
		"utf-8",
	);
}

describe("GET /system/migrations/tautulli", () => {
	it("reports needed=true with instance labels and the rules-pass report", async () => {
		instanceRows = [{ id: "ta-1", label: "My Tautulli", userId: "user-1", service: "TAUTULLI" }];
		await seedReport();

		const res = await injectAuthenticated("GET", "/system/migrations/tautulli");

		expect(res.statusCode).toBe(200);
		const body = JSON.parse(res.payload);
		expect(body.needed).toBe(true);
		expect(body.instances).toEqual([{ id: "ta-1", label: "My Tautulli" }]);
		expect(body.rulesReport.totalAffectedRules).toBe(1);
		expect(body.rulesReport.surfaces["library-cleanup"].rulesDisabled[0].name).toBe(
			"Old watch rule",
		);
	});

	it("degrades to rulesReport=null when no report file exists", async () => {
		instanceRows = [{ id: "ta-1", label: "My Tautulli", userId: "user-1", service: "TAUTULLI" }];

		const res = await injectAuthenticated("GET", "/system/migrations/tautulli");

		const body = JSON.parse(res.payload);
		expect(body.needed).toBe(true);
		expect(body.rulesReport).toBeNull();
	});

	it("reports needed=false with no lingering instances", async () => {
		const res = await injectAuthenticated("GET", "/system/migrations/tautulli");

		const body = JSON.parse(res.payload);
		expect(body).toEqual({ needed: false, instances: [], rulesReport: null });
	});

	it("scopes the lookup to the current user and TAUTULLI service", async () => {
		await injectAuthenticated("GET", "/system/migrations/tautulli");

		expect(findMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: { userId: "user-1", service: "TAUTULLI" },
			}),
		);
	});
});

describe("POST /system/migrations/tautulli", () => {
	it("deletes the current user's TAUTULLI rows and reports the count", async () => {
		instanceRows = [
			{ id: "ta-1", label: "My Tautulli", userId: "user-1", service: "TAUTULLI" },
			{ id: "plex-1", label: "My Plex", userId: "user-1", service: "PLEX" },
			{ id: "ta-2", label: "Other user's", userId: "user-2", service: "TAUTULLI" },
		];

		const res = await injectAuthenticated("POST", "/system/migrations/tautulli");

		expect(res.statusCode).toBe(200);
		expect(JSON.parse(res.payload)).toEqual({ success: true, removedInstances: 1 });
		// Plex row and the other user's row survive
		expect(instanceRows.map((r) => r.id).sort()).toEqual(["plex-1", "ta-2"]);
	});

	it("is idempotent — a second call removes nothing and still succeeds", async () => {
		instanceRows = [{ id: "ta-1", label: "My Tautulli", userId: "user-1", service: "TAUTULLI" }];

		await injectAuthenticated("POST", "/system/migrations/tautulli");
		const res = await injectAuthenticated("POST", "/system/migrations/tautulli");

		expect(res.statusCode).toBe(200);
		expect(JSON.parse(res.payload)).toEqual({ success: true, removedInstances: 0 });
	});

	it("resolves the migration: GET reports needed=false after POST", async () => {
		instanceRows = [{ id: "ta-1", label: "My Tautulli", userId: "user-1", service: "TAUTULLI" }];
		await seedReport();

		await injectAuthenticated("POST", "/system/migrations/tautulli");
		const res = await injectAuthenticated("GET", "/system/migrations/tautulli");

		const body = JSON.parse(res.payload);
		expect(body.needed).toBe(false);
		expect(body.rulesReport).toBeNull(); // report read skipped once resolved
	});
});
