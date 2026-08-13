import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerInfrastructure } from "../../bootstrap/infrastructure.js";
import type { PrismaClient } from "../../lib/prisma.js";

// The production registration path is under test. These plugins do not affect
// Tautulli state, so keep them inert while retaining the real migration plugin
// if it is registered by infrastructure.
vi.mock("../arr-client.js", () => ({ arrClientPlugin: async () => {} }));
vi.mock("../deployment-executor.js", () => ({ default: async () => {} }));
vi.mock("../heap-monitor.js", () => ({ default: async () => {} }));
vi.mock("../http-auth-migration.js", () => ({ default: async () => {} }));
vi.mock("../lifecycle.js", () => ({ default: async () => {} }));
vi.mock("../notification-service.js", () => ({ default: async () => {} }));
vi.mock("../prisma.js", () => ({ prismaPlugin: async () => {} }));
vi.mock("../runtime-lease.js", () => ({ default: async () => {} }));
vi.mock("../scheduler-registry.js", () => ({ default: async () => {} }));
vi.mock("../security.js", () => ({ securityPlugin: async () => {} }));
vi.mock("../seerr-cache.js", () => ({ default: async () => {} }));
vi.mock("../seerr-circuit-breaker.js", () => ({ default: async () => {} }));

const historicalReport = {
	ranAt: "2026-08-01T12:00:00.000Z",
	surfaces: {
		"library-cleanup": {
			rulesScanned: 1,
			rulesDisabled: [
				{ id: "cleanup-tautulli-rule", name: "Tautulli retention", reason: "tautulli-orphaned" },
			],
			rulesModified: [],
			rulesUnparseable: [],
		},
		"auto-tag": {
			rulesScanned: 0,
			rulesDisabled: [],
			rulesModified: [],
			rulesUnparseable: [],
		},
	},
	totalAffectedRules: 1,
};

describe("registerInfrastructure", () => {
	let dataDir: string;

	afterEach(async () => {
		if (dataDir) await rm(dataDir, { recursive: true, force: true });
	});

	it("preserves Tautulli services, rules, and historical report content during startup", async () => {
		dataDir = await mkdtemp(path.join(tmpdir(), "tautulli-startup-"));
		const reportPath = path.join(dataDir, "rules-pre-3.0", "tautulli-pass-report.json");
		await mkdir(path.dirname(reportPath), { recursive: true });
		await writeFile(reportPath, JSON.stringify(historicalReport, null, 2), "utf-8");
		const reportBeforeStartup = await readFile(reportPath, "utf-8");

		const services = [
			{ id: "tautulli-service", type: "tautulli", name: "Home Tautulli", enabled: true },
		];
		const cleanupRules = [
			{
				id: "cleanup-tautulli-rule",
				name: "Tautulli retention",
				enabled: true,
				ruleType: "tautulli_last_watched",
				parameters: "{}",
				operator: null,
				conditions: null,
			},
		];
		const prisma = {
			serviceInstance: { findMany: async () => services },
			libraryCleanupRule: {
				findMany: async () => cleanupRules,
				update: async ({
					where,
					data,
				}: {
					where: { id: string };
					data: Partial<(typeof cleanupRules)[number]>;
				}) => {
					const target = cleanupRules.find((candidate) => candidate.id === where.id);
					if (target) Object.assign(target, data);
					return target;
				},
			},
			autoTagRule: { findMany: async () => [], update: async () => undefined },
			$transaction: async (operations: Promise<unknown>[]) => Promise.all(operations),
		} as unknown as PrismaClient;
		const app = Fastify({ logger: false });
		app.decorate("config", { DATABASE_URL: `file:${path.join(dataDir, "prod.db")}` } as never);
		app.decorate("prisma", prisma);
		registerInfrastructure(app);

		await app.ready();

		expect(services).toEqual([
			{ id: "tautulli-service", type: "tautulli", name: "Home Tautulli", enabled: true },
		]);
		expect(cleanupRules).toEqual([
			{
				id: "cleanup-tautulli-rule",
				name: "Tautulli retention",
				enabled: true,
				ruleType: "tautulli_last_watched",
				parameters: "{}",
				operator: null,
				conditions: null,
			},
		]);
		const reportAfterStartup = await readFile(reportPath, "utf-8");
		expect(reportAfterStartup).toBe(reportBeforeStartup);
		expect(JSON.parse(reportAfterStartup)).not.toHaveProperty("acknowledgedAt");

		await app.close();
	});
});
