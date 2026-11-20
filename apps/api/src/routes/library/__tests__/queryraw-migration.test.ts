/**
 * Cached Library lookup contracts against real databases.
 *
 * SQLite runs by default using fresh full-schema copies.
 * PostgreSQL requires INTEGRATION_TESTS=true and an explicit loopback
 * TEST_PG_URL without query parameters; it owns a newly created schema
 * and a native generated client.
 */

import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { PrismaPg } from "@prisma/adapter-pg";
import Fastify, { type FastifyInstance } from "fastify";
import { Pool } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestPrismaClient } from "../../../lib/__tests__/test-prisma.js";
import { Prisma, type PrismaClient } from "../../../lib/prisma.js";
import { registerTestErrorHandler, setupAuthInjection } from "../../__tests__/test-helpers.js";
import { registerFetchRoutes } from "../fetch-routes.js";

const execFileAsync = promisify(execFile);
const apiDir = path.resolve(import.meta.dirname, "../../../..");
const PG_URL = process.env.TEST_PG_URL;
const RUN_PG_TESTS = process.env.INTEGRATION_TESTS === "true" && Boolean(PG_URL);

function parseLoopbackFixtureUrl(value: string): URL {
	const url = new URL(value);
	if (
		!["postgres:", "postgresql:"].includes(url.protocol) ||
		!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
		url.pathname.length <= 1
	)
		throw new Error("PostgreSQL fixtures require an explicit loopback database");
	// node-postgres lets query parameters override authority fields such as host.
	// This fixture sets its schema and search path internally, never from input.
	if (url.searchParams.size > 0)
		throw new Error("PostgreSQL fixture URLs must not supply query parameters");
	return url;
}

describe("PostgreSQL fixture target authorization without network access", () => {
	it("accepts an explicit loopback database authority", () => {
		for (const host of ["127.0.0.1", "localhost", "[::1]"]) {
			const url = parseLoopbackFixtureUrl(`postgresql://${host}:5432/synthetic`);
			expect(url.hostname).toBe(host);
			expect(url.pathname).toBe("/synthetic");
		}
	});

	it("rejects non-loopback, non-PostgreSQL and missing-database targets", () => {
		for (const value of [
			"postgresql://synthetic.invalid:5432/synthetic",
			"https://127.0.0.1:5432/synthetic",
			"postgresql://127.0.0.1:5432/",
		]) {
			expect(() => parseLoopbackFixtureUrl(value)).toThrow(/explicit loopback database/);
		}
	});

	it("rejects supplied connection query parameters before a driver can override the target", () => {
		for (const query of [
			"host=synthetic.invalid",
			"port=1",
			"schema=public",
			"options=-c%20search_path=public",
			"sslmode=disable",
		]) {
			expect(() =>
				parseLoopbackFixtureUrl(`postgresql://127.0.0.1:5432/synthetic?${query}`),
			).toThrow(/query parameters/);
		}
	});
});

async function buildLookupApp(prisma: PrismaClient, provider: "sqlite" | "postgresql") {
	const app = Fastify({ logger: false });
	app.decorate("prisma", prisma);
	app.decorate("dbProvider", provider);
	setupAuthInjection(app, { id: "test-user-1", username: "testuser" });
	registerTestErrorHandler(app);
	await app.register(registerFetchRoutes);
	await app.ready();
	return app;
}

/** Shared test data setup */
async function seedTestData(prisma: PrismaClient) {
	const userId = "test-user-1";

	await prisma.user.create({
		data: { id: userId, username: "testuser" },
	});

	await prisma.serviceInstance.create({
		data: {
			id: "inst-sonarr-1",
			userId,
			service: "SONARR",
			label: "Sonarr 1",
			baseUrl: "http://localhost:8989",
			encryptedApiKey: "encrypted",
			encryptionIv: "iv",
		},
	});
	await prisma.serviceInstance.create({
		data: {
			id: "inst-radarr-1",
			userId,
			service: "RADARR",
			label: "Radarr 1",
			baseUrl: "http://localhost:7878",
			encryptedApiKey: "encrypted",
			encryptionIv: "iv",
		},
	});

	await prisma.libraryCache.create({
		data: {
			instanceId: "inst-sonarr-1",
			arrItemId: 1,
			itemType: "series",
			title: "Breaking Bad",
			data: JSON.stringify({
				title: "Breaking Bad",
				remoteIds: { tmdbId: 1396, imdbId: "tt0903747" },
			}),
		},
	});

	await prisma.libraryCache.create({
		data: {
			instanceId: "inst-radarr-1",
			arrItemId: 100,
			itemType: "movie",
			title: "Inception",
			data: JSON.stringify({
				title: "Inception",
				remoteIds: { tmdbId: 27205, imdbId: "tt1375666" },
			}),
		},
	});

	await prisma.libraryCache.create({
		data: {
			instanceId: "inst-radarr-1",
			arrItemId: 200,
			itemType: "movie",
			title: "The Matrix",
			data: JSON.stringify({
				title: "The Matrix",
				remoteIds: { tmdbId: 603, imdbId: "tt0133093" },
			}),
		},
	});
}

async function cleanupTestData(prisma: PrismaClient) {
	await prisma.libraryCache.deleteMany({});
	await prisma.serviceInstance.deleteMany({});
	await prisma.user.deleteMany({});
}

/**
 * Shared test cases — parameterized by database provider.
 * The jsonExtractBuilder produces the provider-specific SQL fragment.
 */
function defineQueryRawTests(
	getClient: () => PrismaClient,
	jsonExtractBuilder: (tmdbId: number) => ReturnType<typeof Prisma.sql>,
) {
	it("finds item by tmdbId using Prisma.sql with nested fragments and Prisma.join", async () => {
		const instanceIds = ["inst-sonarr-1", "inst-radarr-1"];
		const tmdbId = 1396;

		const jsonExtract = jsonExtractBuilder(tmdbId);
		const rows = await getClient().$queryRaw<Array<{ data: string }>>(
			Prisma.sql`SELECT data FROM library_cache WHERE "instanceId" IN (${Prisma.join(instanceIds)}) AND ${jsonExtract} LIMIT 1`,
		);

		expect(rows).toHaveLength(1);
		const item = JSON.parse(rows[0]!.data);
		expect(item.title).toBe("Breaking Bad");
		expect(item.remoteIds.tmdbId).toBe(1396);
	});

	it("finds movie by tmdbId across multiple instances", async () => {
		const instanceIds = ["inst-sonarr-1", "inst-radarr-1"];
		const tmdbId = 27205;

		const jsonExtract = jsonExtractBuilder(tmdbId);
		const rows = await getClient().$queryRaw<Array<{ data: string }>>(
			Prisma.sql`SELECT data FROM library_cache WHERE "instanceId" IN (${Prisma.join(instanceIds)}) AND ${jsonExtract} LIMIT 1`,
		);

		expect(rows).toHaveLength(1);
		const item = JSON.parse(rows[0]!.data);
		expect(item.title).toBe("Inception");
	});

	it("returns empty array when tmdbId does not exist", async () => {
		const instanceIds = ["inst-sonarr-1", "inst-radarr-1"];
		const tmdbId = 999999;

		const jsonExtract = jsonExtractBuilder(tmdbId);
		const rows = await getClient().$queryRaw<Array<{ data: string }>>(
			Prisma.sql`SELECT data FROM library_cache WHERE "instanceId" IN (${Prisma.join(instanceIds)}) AND ${jsonExtract} LIMIT 1`,
		);

		expect(rows).toHaveLength(0);
	});

	it("scopes query to specified instance IDs only", async () => {
		const instanceIds = ["inst-sonarr-1"];
		const tmdbId = 27205;

		const jsonExtract = jsonExtractBuilder(tmdbId);
		const rows = await getClient().$queryRaw<Array<{ data: string }>>(
			Prisma.sql`SELECT data FROM library_cache WHERE "instanceId" IN (${Prisma.join(instanceIds)}) AND ${jsonExtract} LIMIT 1`,
		);

		expect(rows).toHaveLength(0);
	});
}

/** Actual registered read handler, not a duplicate query implementation. */
function defineLookupRouteTests(getApp: () => FastifyInstance, getClient: () => PrismaClient) {
	const lookup = (id: number | string) =>
		getApp().inject({
			method: "GET",
			url: `/library/by-tmdb/${id}`,
			headers: { "x-test-auth": "1" },
		});

	it("returns the populated series and movie through the actual cache lookup handler", async () => {
		const series = await lookup(1396);
		const movie = await lookup(27205);
		expect(series.statusCode).toBe(200);
		expect(series.json()).toEqual({
			item: { title: "Breaking Bad", remoteIds: { tmdbId: 1396, imdbId: "tt0903747" } },
		});
		expect(movie.statusCode).toBe(200);
		expect(movie.json()).toEqual({
			item: { title: "Inception", remoteIds: { tmdbId: 27205, imdbId: "tt1375666" } },
		});
	});

	it("does not expose another owner's cache or a disabled owned instance", async () => {
		const prisma = getClient();
		await prisma.user.create({ data: { id: "other-owner", username: "synthetic-other-owner" } });
		for (const [id, userId, enabled, tmdbId] of [
			["other-instance", "other-owner", true, 811111],
			["disabled-instance", "test-user-1", false, 811112],
		] as const) {
			await prisma.serviceInstance.create({
				data: {
					id,
					userId,
					enabled,
					service: "RADARR",
					label: "Synthetic same label",
					baseUrl: "http://synthetic.invalid",
					encryptedApiKey: "synthetic",
					encryptionIv: "synthetic",
				},
			});
			await prisma.libraryCache.create({
				data: {
					instanceId: id,
					arrItemId: 1,
					itemType: "movie",
					title: "Synthetic same title",
					data: JSON.stringify({ title: "Synthetic same title", remoteIds: { tmdbId } }),
				},
			});
		}
		for (const id of [811111, 811112]) {
			const response = await lookup(id);
			expect(response.statusCode).toBe(404);
			expect(response.json()).toEqual({ error: "Item not found" });
		}
	});

	it("reports genuine absence and rejects invalid identifiers", async () => {
		const missing = await lookup(999999);
		expect(missing.statusCode).toBe(404);
		expect(missing.json()).toEqual({ error: "Item not found" });
		for (const id of ["0", "-1", "not-a-number"]) {
			expect((await lookup(id)).statusCode).toBe(400);
		}
	});

	it("does not report absence on a database read failure and recovers on explicit retry", async () => {
		const read = vi
			.spyOn(getClient(), "$queryRaw")
			.mockRejectedValueOnce(new Error("synthetic read failure"));
		try {
			const failed = await lookup(27205);
			expect(failed.statusCode).toBe(500);
			expect(failed.json()).toEqual({ error: "Internal Server Error" });
			const retried = await lookup(27205);
			expect(retried.statusCode).toBe(200);
			expect(retried.json().item.title).toBe("Inception");
		} finally {
			read.mockRestore();
		}
	});
}

describe("$queryRaw migration: SQLite (json_extract)", () => {
	let templateDir: string | undefined;
	let templatePath: string;
	let caseDir: string | undefined;
	let prisma: PrismaClient | undefined;
	let app: FastifyInstance | undefined;

	beforeAll(async () => {
		templateDir = await fs.mkdtemp(path.join(os.tmpdir(), "library-queryraw-schema-"));
		templatePath = path.join(templateDir, "template.db");
		await execFileAsync(
			"pnpm",
			[
				"exec",
				"prisma",
				"db",
				"push",
				"--schema",
				"prisma/schema.prisma",
				"--url",
				`file:${templatePath}`,
			],
			{
				cwd: apiDir,
				env: { ...process.env, DATABASE_URL: `file:${templatePath}` },
			},
		);
	}, 120_000);

	afterAll(async () => {
		if (templateDir) await fs.rm(templateDir, { recursive: true, force: true });
	});

	beforeEach(async () => {
		caseDir = await fs.mkdtemp(path.join(os.tmpdir(), "library-queryraw-case-"));
		const databasePath = path.join(caseDir, "case.db");
		await fs.copyFile(templatePath, databasePath);
		prisma = createTestPrismaClient(databasePath);
		await seedTestData(prisma);
		app = await buildLookupApp(prisma, "sqlite");
	});

	afterEach(async () => {
		try {
			await app?.close();
		} finally {
			app = undefined;
			try {
				await prisma?.$disconnect();
			} finally {
				prisma = undefined;
				if (caseDir) await fs.rm(caseDir, { recursive: true, force: true });
				caseDir = undefined;
			}
		}
	});

	defineQueryRawTests(
		() => prisma!,
		(tmdbId) => Prisma.sql`CAST(json_extract(data, '$.remoteIds.tmdbId') AS INTEGER) = ${tmdbId}`,
	);
	defineLookupRouteTests(
		() => app!,
		() => prisma!,
	);
});

(RUN_PG_TESTS ? describe : describe.skip)(
	"$queryRaw migration: PostgreSQL (JSON ->> operator)",
	() => {
		let directory: string | undefined;
		let schemaName: string | undefined;
		let schemaCreated = false;
		let admin: Pool | undefined;
		let pool: Pool | undefined;
		let prisma: PrismaClient | undefined;
		let app: FastifyInstance | undefined;

		beforeAll(async () => {
			if (!PG_URL) throw new Error("Explicit PostgreSQL fixture URL required");
			const url = parseLoopbackFixtureUrl(PG_URL);
			schemaName = `queryraw_${randomUUID().replaceAll("-", "")}`;
			admin = new Pool({ connectionString: url.toString() });
			await admin.query(`CREATE SCHEMA "${schemaName}"`);
			schemaCreated = true;
			directory = await fs.mkdtemp(path.join(os.tmpdir(), "library-queryraw-pg-"));
			const source = await fs.readFile(path.join(apiDir, "prisma/schema.prisma"), "utf8");
			const generatedSchema = source
				.replace(
					/generator client \{[\s\S]*?\}\n\n/,
					'generator client {\n  provider = "prisma-client"\n  output = "./generated"\n}\n\n',
				)
				.replace('provider = "sqlite"', 'provider = "postgresql"');
			const schemaFile = path.join(directory, "schema.prisma");
			await fs.writeFile(schemaFile, generatedSchema, { mode: 0o600 });
			url.searchParams.set("schema", schemaName);
			url.searchParams.set("options", `-c search_path=${schemaName}`);
			const databaseUrl = url.toString();
			const env = { ...process.env, DATABASE_URL: databaseUrl };
			await execFileAsync("pnpm", ["exec", "prisma", "generate", "--schema", schemaFile], {
				cwd: apiDir,
				env,
			});
			await execFileAsync(
				"pnpm",
				["exec", "prisma", "db", "push", "--schema", schemaFile, "--url", databaseUrl],
				{ cwd: apiDir, env },
			);
			const generated = await import(
				/* @vite-ignore */ pathToFileURL(path.join(directory, "generated/client.ts")).href
			);
			const { PrismaClient: NativePgClient } = (generated.default ?? generated) as {
				PrismaClient: new (options: { adapter: unknown }) => PrismaClient;
			};
			pool = new Pool({ connectionString: databaseUrl });
			prisma = new NativePgClient({ adapter: new PrismaPg(pool, { schema: schemaName }) });
		}, 120_000);

		afterAll(async () => {
			try {
				await prisma?.$disconnect();
			} finally {
				try {
					await pool?.end();
				} finally {
					try {
						if (schemaCreated && schemaName && admin) {
							await admin.query(`DROP SCHEMA "${schemaName}" CASCADE`);
						}
					} finally {
						try {
							await admin?.end();
						} finally {
							if (directory) await fs.rm(directory, { recursive: true, force: true });
						}
					}
				}
			}
		});

		beforeEach(async () => {
			if (!prisma || !schemaCreated)
				throw new Error("Disposable PostgreSQL schema was not initialized");
			await seedTestData(prisma);
			app = await buildLookupApp(prisma, "postgresql");
		});

		afterEach(async () => {
			try {
				await app?.close();
			} finally {
				app = undefined;
				if (schemaCreated && prisma) await cleanupTestData(prisma);
			}
		});

		defineQueryRawTests(
			() => prisma!,
			(tmdbId) => Prisma.sql`CAST("data"::json->'remoteIds'->>'tmdbId' AS INTEGER) = ${tmdbId}`,
		);
		defineLookupRouteTests(
			() => app!,
			() => prisma!,
		);
	},
);
