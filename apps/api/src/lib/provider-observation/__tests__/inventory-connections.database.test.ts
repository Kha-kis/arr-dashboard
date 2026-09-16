import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import pino from "pino";
import Fastify from "fastify";
import { registerAutoTagRoutes } from "../../../routes/auto-tag.js";
import {
	createInjectAuthenticated,
	setupAuthInjection,
	registerTestErrorHandler,
} from "../../../routes/__tests__/test-helpers.js";
import { processWebhook } from "../../auto-tag/webhook-handler.js";
import { executeAutoTagRule, type AutoTagRuleInput } from "../../auto-tag/execute-rule.js";
import { AutoTagScheduler } from "../../auto-tag/auto-tag-scheduler.js";
import { runRuleWithLock } from "../../auto-tag/run-with-lock.js";
import { createTestPrismaClient } from "../../__tests__/test-prisma.js";
import type { PrismaClient } from "../../prisma.js";
import { readProviderInventoryConnections } from "../inventory-connection-repository.js";
import { loadNativePresenceContext, resolveNativePresence } from "../native-presence-evidence.js";
import {
	beginNativeInventoryAttempt,
	publishNativeInventoriesInTransaction,
} from "../native-inventory.js";

let prisma: PrismaClient;
let directory: string;
const now = new Date();

beforeAll(async () => {
	directory = mkdtempSync(join(tmpdir(), "inventory-connections-"));
	const path = join(directory, "fixture.db");
	execFileSync("pnpm", ["exec", "prisma", "db", "push", "--schema", "prisma/schema.prisma"], {
		env: { ...process.env, DATABASE_URL: `file:${path}` },
		stdio: "ignore",
	});
	prisma = createTestPrismaClient(path);
	await prisma.user.createMany({
		data: [
			{ id: "owner", username: "owner" },
			{ id: "other", username: "other" },
		],
	});
	const common = {
		baseUrl: "http://fixture.invalid",
		encryptedApiKey: "cipher",
		encryptionIv: "iv",
		label: "Fixture",
	};
	const provider = await prisma.serviceInstance.create({
		data: {
			...common,
			id: "plex",
			service: "PLEX",
			userId: "owner",
			identityStatus: "VERIFIED",
			expectedIdentity: "fixture",
			identityKind: "PLEX_MACHINE_IDENTIFIER",
			identityVerifiedAt: now,
		},
	});
	await prisma.serviceInstance.createMany({
		data: [
			{ ...common, id: "radarr", service: "RADARR", userId: "owner" },
			{ ...common, id: "foreign", service: "RADARR", userId: "other" },
			{ ...common, id: "disabled", service: "RADARR", userId: "owner", enabled: false },
		],
	});
	await prisma.libraryCache.createMany({
		data: ["radarr", "foreign", "disabled"].map((instanceId) => ({
			instanceId,
			arrItemId: 10,
			itemType: "movie",
			title: "Fixture movie",
			data: JSON.stringify({ remoteIds: { tmdbId: 42 } }),
		})),
	});
	const jellyfin = await prisma.serviceInstance.create({
		data: {
			...common,
			id: "jellyfin",
			service: "JELLYFIN",
			userId: "owner",
			identityStatus: "VERIFIED",
			expectedIdentity: "jellyfin-fixture",
			identityKind: "JELLYFIN_SERVER_ID",
			identityVerifiedAt: now,
		},
	});
	for (const source of [provider, jellyfin]) {
		const attempt = await beginNativeInventoryAttempt(prisma, {
			userId: "owner",
			instance: source,
			domains: ["library"],
			now,
		});
		if (attempt.status !== "acquired") throw new Error("fixture claim unavailable");
		await prisma.$transaction((tx) =>
			publishNativeInventoriesInTransaction(tx, {
				userId: "owner",
				authority: attempt.authority,
				attempt: attempt.attempt,
				now,
				snapshots: [
					{
						domain: "library",
						scopeKeys: ["movies"],
						rows: [
							{
								nativeId: "mapped",
								mediaType: "movie",
								libraryIds: ["movies"],
								parentNativeId: null,
								seasonNumber: null,
								episodeNumber: null,
								title: "Fixture movie",
								externalIds: { tmdb: [42] },
							},
							{
								nativeId: "unmapped",
								mediaType: "movie",
								libraryIds: ["movies"],
								parentNativeId: null,
								seasonNumber: null,
								episodeNumber: null,
								title: "Fixture movie",
							},
						],
					},
				],
			}),
		);
	}
}, 30_000);

afterAll(async () => {
	await prisma?.$disconnect();
	if (directory) rmSync(directory, { recursive: true, force: true });
});

describe("owned inventory connections on populated SQLite", () => {
	it("joins only the owner's enabled ARR instance and retains unmapped media", async () => {
		const page = await readProviderInventoryConnections(prisma, {
			userId: "owner",
			instanceId: "plex",
			domain: "library",
			now,
		});
		expect(page).toMatchObject({
			status: "available",
			itemCount: 2,
			rows: [
				{
					nativeId: "mapped",
					connection: { status: "matched", arrItems: [{ instanceId: "radarr", arrItemId: 10 }] },
				},
				{ nativeId: "unmapped", connection: { status: "unknown", arrItems: [] } },
			],
		});
		if (page.status === "available") expect(page.rows[0]?.connection.arrItems).toHaveLength(1);
	});
	it("rejects another owner without exposing either inventory", async () => {
		expect(
			await readProviderInventoryConnections(prisma, {
				userId: "other",
				instanceId: "plex",
				domain: "library",
				now,
			}),
		).toEqual({ status: "unavailable", reason: "not-owned" });
	});
	it("retains last-known connections while a refresh is in progress", async () => {
		const provider = await prisma.serviceInstance.findUniqueOrThrow({ where: { id: "plex" } });
		await beginNativeInventoryAttempt(prisma, {
			userId: "owner",
			instance: provider,
			domains: ["library"],
			now,
		});
		expect(
			await readProviderInventoryConnections(prisma, {
				userId: "owner",
				instanceId: "plex",
				domain: "library",
				now,
			}),
		).toMatchObject({
			status: "available",
			freshness: "last-known",
			itemCount: 2,
			rows: [{ connection: { status: "matched" } }, { connection: { status: "unknown" } }],
		});
	});
});

describe("native inventory to ARR tagging through the real evaluator and database", () => {
	beforeEach(async () => {
		await prisma.autoTagRule.deleteMany({ where: { userId: "owner" } });
		await prisma.serviceInstance.update({
			where: { id: "plex" },
			data: { enabled: true, userId: "owner", connectionGeneration: 0, identityGeneration: 0 },
		});
		await prisma.serviceInstance.update({
			where: { id: "radarr" },
			data: { enabled: true, connectionGeneration: 0 },
		});
		await prisma.providerNativeInventorySnapshot.updateMany({
			where: { instanceId: "plex" },
			data: { lastAttemptResult: "success", lastAttemptToken: null, lastAttemptReason: null },
		});
	});
	const rule: AutoTagRuleInput = {
		id: "presence-rule",
		userId: "owner",
		name: "On server",
		ruleType: "media_server_presence",
		parameters: { instanceId: "plex" },
		operator: null,
		conditions: null,
		serviceFilter: ["radarr"],
		instanceFilter: ["radarr"],
		excludeTags: null,
		excludeTitles: null,
		plexLibraryFilter: null,
		tagName: "on-server",
	};
	function fixture(
		options: {
			providerId?: string;
			beforeTagList?: () => Promise<void>;
			beforeRead?: (readNumber: number) => Promise<void>;
			differentIdentity?: boolean;
			loseAcknowledgement?: boolean;
			missingTag?: boolean;
			alreadyTagged?: boolean;
			tagCatalog?: Array<{ id: number; label: string }>;
		} = {},
	) {
		let remote = {
			id: 10,
			title: "Fixture movie",
			tmdbId: options.differentIdentity ? 99 : 42,
			qualityProfileId: 9,
			tags: options.alreadyTagged ? [3, 7] : [3],
			monitored: true,
			hasFile: true,
		};
		let writes = 0;
		let tagCreates = 0;
		let readNumber = 0;
		const factory = {
			create: () => ({
				tag: {
					getAll: async () => {
						await options.beforeTagList?.();
						return options.missingTag
							? []
							: (options.tagCatalog ?? [{ id: 7, label: "on-server" }]);
					},
					create: async () => {
						tagCreates++;
						return { id: 7, label: "on-server" };
					},
				},
				movie: {
					getById: async () => {
						const current = { ...remote, tags: [...remote.tags] };
						await options.beforeRead?.(++readNumber);
						return current;
					},
					update: async (id: number, body: typeof remote) => {
						expect(id).toBe(10);
						remote = body;
						writes++;
						if (options.loseAcknowledgement && writes === 1)
							throw new Error("Fixture timeout after accepted PUT");
					},
				},
			}),
		};
		return {
			factory,
			run: (dryRun = false, overrides: Partial<AutoTagRuleInput> = {}) =>
				executeAutoTagRule({
					rule: { ...rule, ...overrides, parameters: { instanceId: options.providerId ?? "plex" } },
					dryRun,
					prisma,
					arrClientFactory: factory as never,
					encryptor: {} as never,
					log: pino({ level: "silent" }),
				}),
			state: () => ({ remote, writes, tagCreates }),
		};
	}
	it.each(["plex", "jellyfin"])(
		"applies a tag from %s native presence, preserves current ARR fields and converges on retry",
		async (providerId) => {
			const evidence = await loadNativePresenceContext(prisma, "owner", [providerId]);
			expect(evidence.size).toBe(1);
			expect(
				resolveNativePresence(
					{
						instanceId: "radarr",
						arrItemId: 10,
						itemType: "movie",
						title: "Fixture",
						data: JSON.stringify({ tmdbId: 42 }),
					},
					evidence.get(providerId),
				),
			).toBe("present");
			const remote = fixture({ providerId });
			expect(await remote.run()).toMatchObject({ status: "success", totals: { tagsApplied: 1 } });
			expect(remote.state()).toMatchObject({
				writes: 1,
				remote: { tags: [3, 7], qualityProfileId: 9 },
			});
			expect(await remote.run()).toMatchObject({ status: "success", totals: { tagsApplied: 1 } });
			expect(remote.state().writes).toBe(1);
		},
	);
	it("does not tag a live ARR record whose identity changed since the catalog scan", async () => {
		const remote = fixture({ differentIdentity: true });
		expect(await remote.run()).toMatchObject({
			status: "failed",
			totals: { tagsApplied: 0, itemsSkipped: 1 },
		});
		expect(remote.state().writes).toBe(0);
	});
	it("reauthorizes the provider after initial matching and before the ARR tag write", async () => {
		const remote = fixture({
			beforeRead: async () => {
				await prisma.serviceInstance.update({ where: { id: "plex" }, data: { enabled: false } });
			},
		});
		expect(await remote.run()).toMatchObject({
			status: "failed",
			totals: { tagsApplied: 0, itemsSkipped: 1 },
		});
		expect(remote.state().writes).toBe(0);
	});

	it.each([
		["provider reassigned", "plex", { userId: "other" }],
		["provider reconfigured", "plex", { connectionGeneration: 1 }],
		["provider identity changed", "plex", { identityGeneration: 1 }],
		["ARR disabled", "radarr", { enabled: false }],
		["ARR reconfigured", "radarr", { connectionGeneration: 1 }],
	] as const)(
		"does not create a tag or update an item when %s before execution",
		async (_label, id, data) => {
			const remote = fixture({
				missingTag: true,
				beforeRead: async () => {
					await prisma.serviceInstance.update({ where: { id }, data });
				},
			});
			expect(await remote.run()).toMatchObject({
				status: "failed",
				totals: { tagsApplied: 0, itemsSkipped: 1 },
			});
			expect(remote.state()).toMatchObject({ writes: 0, tagCreates: 0 });
		},
	);
	it("does not count an existing tag as success after ARR authorization changes", async () => {
		const remote = fixture({
			alreadyTagged: true,
			beforeRead: async () => {
				await prisma.serviceInstance.update({ where: { id: "radarr" }, data: { enabled: false } });
			},
		});
		expect(await remote.run()).toMatchObject({
			status: "failed",
			totals: { tagsApplied: 0, itemsSkipped: 1 },
		});
	});
	it("previews matches and unknown items without changing any database row or remote resource", async () => {
		async function rows() {
			const tables = await prisma.$queryRawUnsafe<Array<{ name: string }>>(
				"SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
			);
			return JSON.stringify(
				await Promise.all(
					tables.map(async ({ name }) => [
						name,
						await prisma.$queryRawUnsafe(
							`SELECT * FROM "${name.replaceAll('"', '""')}" ORDER BY rowid`,
						),
					]),
				),
				(_key, value) => (typeof value === "bigint" ? value.toString() : value),
			);
		}
		await saveRule();
		const before = await rows();
		const remote = fixture({ missingTag: true });
		expect(await remote.run(true)).toMatchObject({
			preview: {
				itemsScanned: 1,
				itemsMatched: 1,
				itemsUnknown: 0,
				items: [{ arrItemId: 10, state: "true" }],
			},
		});
		expect(remote.state()).toMatchObject({ writes: 0, tagCreates: 0 });
		expect(await rows()).toBe(before);
	});
	it("keeps stale inventory readable but reports presence rules unknown without writes", async () => {
		await prisma.providerNativeInventorySnapshot.updateMany({
			where: { instanceId: "plex" },
			data: { observedAt: new Date(now.getTime() - 25 * 60 * 60 * 1000) },
		});
		try {
			expect(
				await readProviderInventoryConnections(prisma, {
					userId: "owner",
					instanceId: "plex",
					domain: "library",
				}),
			).toMatchObject({
				status: "available",
				freshness: "last-known",
				rows: [{ connection: { status: "matched" } }, { connection: { status: "unknown" } }],
			});
			const remote = fixture({ missingTag: true });
			expect(await remote.run(true)).toMatchObject({
				preview: { itemsMatched: 0, itemsUnknown: 1 },
			});
			expect(await remote.run()).toMatchObject({
				status: "failed",
				totals: { itemsSkipped: 1, tagsApplied: 0 },
			});
			expect(remote.state()).toMatchObject({ writes: 0, tagCreates: 0 });
		} finally {
			await prisma.providerNativeInventorySnapshot.updateMany({
				where: { instanceId: "plex" },
				data: { observedAt: now },
			});
		}
	});
	it("reports lost acknowledgement as failure, then verifies the existing remote tag on retry", async () => {
		const remote = fixture({ loseAcknowledgement: true });
		expect(await remote.run()).toMatchObject({
			status: "failed",
			totals: { tagsApplied: 0, failures: 1 },
		});
		expect(remote.state().remote.tags).toEqual([3, 7]);
		expect(await remote.run()).toMatchObject({ status: "success", totals: { tagsApplied: 1 } });
		expect(remote.state().writes).toBe(1);
	});

	async function saveRule() {
		return prisma.autoTagRule.create({
			data: {
				id: rule.id,
				userId: rule.userId,
				name: rule.name,
				ruleType: rule.ruleType,
				parameters: JSON.stringify(rule.parameters),
				tagName: rule.tagName,
				serviceFilter: JSON.stringify(rule.serviceFilter),
				instanceFilter: JSON.stringify(rule.instanceFilter),
				lastRunAt: new Date("2026-01-01"),
				lastRunStatus: "partial",
				lastRunMessage: "Prior recorded run",
			},
		});
	}
	async function webhook(remote: ReturnType<typeof fixture>) {
		return processWebhook({
			deps: {
				prisma,
				arrClientFactory: remote.factory as never,
				encryptor: {} as never,
				log: pino({ level: "silent" }),
			},
			user: await prisma.user.findUniqueOrThrow({ where: { id: "owner" } }),
			instance: await prisma.serviceInstance.findUniqueOrThrow({ where: { id: "radarr" } }),
			payload: { eventType: "Download", movie: { id: 10 } },
		});
	}
	it("applies native presence through the real webhook evaluator", async () => {
		await saveRule();
		const remote = fixture();
		expect(await webhook(remote)).toMatchObject({ status: "ok", tagsApplied: 1 });
		expect(remote.state()).toMatchObject({ writes: 1, remote: { tags: [3, 7] } });
	});
	it.each(["plex", "radarr"])(
		"webhook creates no tag and reports unresolved evidence when %s changes before its write",
		async (id) => {
			await saveRule();
			const remote = fixture({
				missingTag: true,
				beforeRead: async (number) => {
					if (number === 2)
						await prisma.serviceInstance.update({ where: { id }, data: { enabled: false } });
				},
			});
			const result = await webhook(remote);
			expect(result).toMatchObject({ tagsApplied: 0 });
			expect(result.message).toMatch(/unknown|unresolved|changed|unavailable/i);
			expect(remote.state()).toMatchObject({ writes: 0, tagCreates: 0 });
		},
	);
	it("keeps prior run evidence on persistence failure and converges after restarting the route and database client", async () => {
		const saved = await saveRule();
		const remote = fixture();
		async function routeApp(database: PrismaClient) {
			const app = Fastify();
			app.decorate("prisma", database);
			app.decorate("arrClientFactory", remote.factory as never);
			app.decorate("encryptor", {} as never);
			setupAuthInjection(app, { id: "owner", username: "owner" });
			registerTestErrorHandler(app);
			await app.register(registerAutoTagRoutes);
			await app.ready();
			return app;
		}
		const failing = prisma.$extends({
			query: {
				autoTagRule: {
					update: async () => {
						throw new Error("Fixture local persistence unavailable");
					},
				},
			},
		}) as unknown as PrismaClient;
		const firstApp = await routeApp(failing);
		try {
			expect(
				(await createInjectAuthenticated(firstApp)("POST", `/rules/${rule.id}/run`)).statusCode,
			).toBe(500);
			expect(remote.state().writes).toBe(1);
			expect(await prisma.autoTagRule.findUnique({ where: { id: rule.id } })).toMatchObject({
				lastRunAt: saved.lastRunAt,
				lastRunStatus: "partial",
				lastRunMessage: "Prior recorded run",
			});
		} finally {
			await firstApp.close();
		}
		await prisma.$disconnect();
		prisma = createTestPrismaClient(join(directory, "fixture.db"));
		const restarted = await routeApp(prisma);
		try {
			const response = await createInjectAuthenticated(restarted)("POST", `/rules/${rule.id}/run`);
			expect(response.statusCode).toBe(200);
			expect(response.json()).toMatchObject({ rule: { lastRunStatus: "success" } });
			expect(remote.state().writes).toBe(1);
		} finally {
			await restarted.close();
		}
	});
	it("preserves both tags when different rules concurrently target the same live ARR record", async () => {
		const remote = fixture({
			tagCatalog: [
				{ id: 7, label: "on-server" },
				{ id: 8, label: "also-present" },
			],
			beforeRead: () => new Promise((resolve) => setTimeout(resolve, 20)),
		});
		const results = await Promise.all([
			remote.run(),
			remote.run(false, { id: "second-rule", tagName: "also-present" }),
		]);
		expect(results.map((result) => result.status)).toEqual(["success", "success"]);
		expect(remote.state().remote.tags.sort()).toEqual([3, 7, 8]);
	});
	it("serializes webhook and scheduled rule writes to preserve both resulting tags", async () => {
		await saveRule();
		const remote = fixture({
			tagCatalog: [
				{ id: 7, label: "on-server" },
				{ id: 8, label: "also-present" },
			],
			beforeRead: () => new Promise((resolve) => setTimeout(resolve, 20)),
		});
		const [webhookResult, scheduled] = await Promise.all([
			webhook(remote),
			remote.run(false, { id: "second-rule", tagName: "also-present" }),
		]);
		expect(webhookResult.status).toBe("ok");
		expect(scheduled.status).toBe("success");
		expect(remote.state().remote.tags.sort()).toEqual([3, 7, 8]);
	});
	it.each(["manual", "webhook"])(
		"%s reauthorizes after the tag listing before creating a missing tag",
		async (mode) => {
			await saveRule();
			const remote = fixture({
				missingTag: true,
				beforeTagList: async () => {
					await prisma.serviceInstance.update({ where: { id: "plex" }, data: { enabled: false } });
				},
			});
			if (mode === "manual") await remote.run();
			else await webhook(remote);
			expect(remote.state()).toMatchObject({ writes: 0, tagCreates: 0 });
		},
	);
	it("records scheduler result-save failure as retryable and verifies upstream state on the next tick", async () => {
		await saveRule();
		const remote = fixture();
		let attempts = 0;
		const failingOnce = prisma.$extends({
			query: {
				autoTagRule: {
					update: async ({ args, query }) => {
						if (++attempts === 1) throw new Error("Fixture telemetry save unavailable");
						return query(args);
					},
				},
			},
		}) as unknown as PrismaClient;
		async function tick(database: PrismaClient) {
			const scheduler = new AutoTagScheduler(
				database,
				remote.factory as never,
				{} as never,
				pino({ level: "silent" }),
			);
			await (scheduler as unknown as { tick: () => Promise<void> }).tick();
		}
		await tick(failingOnce);
		expect(remote.state().writes).toBe(1);
		expect(await prisma.autoTagRule.findUnique({ where: { id: rule.id } })).toMatchObject({
			lastRunStatus: "partial",
			lastRunAt: null,
		});
		await tick(prisma);
		expect(await prisma.autoTagRule.findUnique({ where: { id: rule.id } })).toMatchObject({
			lastRunStatus: "success",
		});
		expect(remote.state().writes).toBe(1);
	});
	it("uses the existing per-rule guard for overlapping runs", async () => {
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const remote = fixture({ beforeRead: () => gate });
		const first = runRuleWithLock(rule.id, () => remote.run());
		expect(await runRuleWithLock(rule.id, () => remote.run())).toEqual({
			status: "skipped",
			reason: "already-running",
		});
		release();
		expect(await first).toMatchObject({ status: "ran", result: { status: "success" } });
		expect(remote.state().writes).toBe(1);
	});
});

describe("episode connections across pagination", () => {
	it("keeps the library generation separate from the episode page cursor", async () => {
		await prisma.serviceInstance.create({
			data: {
				id: "sonarr",
				userId: "owner",
				service: "SONARR",
				label: "Series fixture",
				baseUrl: "http://fixture.invalid",
				encryptedApiKey: "synthetic",
				encryptionIv: "synthetic",
			},
		});
		await prisma.libraryCache.create({
			data: {
				instanceId: "sonarr",
				arrItemId: 22,
				itemType: "series",
				title: "Parent series",
				data: JSON.stringify({ remoteIds: { tvdbId: 84 } }),
			},
		});
		const instance = await prisma.serviceInstance.findUniqueOrThrow({ where: { id: "plex" } });
		for (const domain of ["library", "episode"] as const) {
			const attempt = await beginNativeInventoryAttempt(prisma, {
				userId: "owner",
				instance,
				domains: [domain],
				now,
			});
			if (attempt.status !== "acquired") throw new Error("Fixture claim unavailable");
			const rows =
				domain === "library"
					? [
							{
								nativeId: "parent",
								mediaType: "series" as const,
								libraryIds: ["shows"],
								parentNativeId: null,
								seasonNumber: null,
								episodeNumber: null,
								title: "Parent series",
								externalIds: { tvdb: [84] },
							},
						]
					: [1, 2].map((n) => ({
							nativeId: `episode-${n}`,
							mediaType: "episode" as const,
							libraryIds: ["shows"],
							parentNativeId: "parent",
							seasonNumber: 1,
							episodeNumber: n,
							title: `Episode ${n}`,
						}));
			await prisma.$transaction((tx) =>
				publishNativeInventoriesInTransaction(tx, {
					userId: "owner",
					authority: attempt.authority,
					attempt: attempt.attempt,
					now,
					snapshots: [{ domain, scopeKeys: ["shows"], rows }],
				}),
			);
		}
		const first = await readProviderInventoryConnections(prisma, {
			userId: "owner",
			instanceId: "plex",
			domain: "episode",
			limit: 1,
			now,
		});
		if (first.status !== "available" || !first.nextNativeId)
			throw new Error("Fixture first page unavailable");
		const second = await readProviderInventoryConnections(prisma, {
			userId: "owner",
			instanceId: "plex",
			domain: "episode",
			limit: 1,
			now,
			afterNativeId: first.nextNativeId,
			expectedGenerationId: first.generationId,
		});
		expect(second).toMatchObject({
			status: "available",
			rows: [
				{
					nativeId: "episode-2",
					connection: {
						status: "matched",
						arrItems: [{ instanceId: "sonarr", arrItemId: 22, itemType: "series" }],
					},
				},
			],
		});
	});
});
