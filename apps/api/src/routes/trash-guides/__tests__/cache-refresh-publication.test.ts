import { gzipSync } from "node:zlib";
import Fastify, { type FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestPrismaClient } from "../../../lib/__tests__/test-prisma.js";
import { registerTrashCacheRoutes } from "../cache-routes.js";

// Real cache persistence; only the external GitHub transport is synthetic.
const prisma = createTestPrismaClient(":memory:");
const quality = {
	trash_id: "synthetic-quality-size",
	type: "movie",
	qualities: [{ quality: "Synthetic Quality", min: 1, preferred: 2, max: 3 }],
};
const headers = { "x-fixture-auth": "1" };
let app: FastifyInstance;
let listingStatus = 200;
let malformedListing = false;
let contentStatus = 200;
let emptyContent = false;
let upstreamRequests = 0;

beforeAll(async () => {
	// These are the only two models accessed by this route, not a mock Prisma.
	await prisma.$executeRawUnsafe(`CREATE TABLE trash_settings (
		id TEXT PRIMARY KEY, userId TEXT NOT NULL UNIQUE, customRepoOwner TEXT, customRepoName TEXT,
		customRepoBranch TEXT, customRepoMode TEXT NOT NULL DEFAULT 'fork')`);
	await prisma.$executeRawUnsafe(`CREATE TABLE trash_cache (
		id TEXT PRIMARY KEY, serviceType TEXT NOT NULL, configType TEXT NOT NULL,
		data TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1, commitHash TEXT,
		fetchedAt DATETIME NOT NULL, lastCheckedAt DATETIME NOT NULL,
		updatedAt DATETIME NOT NULL, UNIQUE(serviceType, configType))`);
	app = Fastify({ logger: false });
	app.decorate("prisma", prisma);
	app.decorateRequest("currentUser", null);
	app.addHook("preHandler", async (request, reply) => {
		if (request.headers["x-fixture-auth"] !== "1") {
			return reply.code(401).send({ error: "Authentication required" });
		}
		request.currentUser = { id: "synthetic-owner", username: "synthetic-owner" } as never;
	});
	await app.register(registerTrashCacheRoutes, { prefix: "/cache" });
	await app.ready();
});

beforeEach(async () => {
	await prisma.trashCache.deleteMany();
	listingStatus = 200;
	contentStatus = 200;
	malformedListing = false;
	emptyContent = false;
	upstreamRequests = 0;
	vi.stubGlobal("fetch", async (input: string) => {
		const url = new URL(input);
		upstreamRequests++;
		if (url.hostname === "api.github.com") {
			return Response.json(malformedListing ? {} : [{ name: "fixture.json", type: "file" }], {
				status: listingStatus,
			});
		}
		expect(url.hostname).toBe("raw.githubusercontent.com");
		return Response.json(emptyContent ? [] : quality, { status: contentStatus });
	});
});

afterEach(() => vi.unstubAllGlobals());
afterAll(async () => {
	await app?.close();
	await prisma.$disconnect();
});

function refresh(
	serviceType: "RADARR" | "SONARR",
	force = true,
	configType: "QUALITY_SIZE" | "NAMING_PRESETS" | "QUALITY_PROFILE_GROUPS" = "QUALITY_SIZE",
) {
	return app.inject({
		method: "POST",
		url: "/cache/refresh",
		headers,
		payload: { serviceType, configType, force },
	});
}

it("keeps healthy service results when the other catalogue is unreadable", async () => {
	const now = new Date();
	await prisma.trashCache.createMany({
		data: [
			{
				serviceType: "RADARR",
				configType: "CUSTOM_FORMATS",
				data: "invalid gzip",
				fetchedAt: now,
				lastCheckedAt: now,
			},
			{
				serviceType: "SONARR",
				configType: "CUSTOM_FORMATS",
				data: gzipSync("[]").toString("base64"),
				fetchedAt: now,
				lastCheckedAt: now,
			},
		],
	});
	const before = await prisma.trashCache.findMany();
	const mixed = await app.inject({ url: "/cache/custom-formats/list", headers });
	expect(mixed.statusCode).toBe(200);
	expect(mixed.json()).toEqual({ sonarr: [], unavailableServices: ["RADARR"] });
	const unavailable = await app.inject({
		url: "/cache/custom-formats/list?serviceType=RADARR",
		headers,
	});
	expect(unavailable.statusCode).toBe(503);
	expect(upstreamRequests).toBe(0);
	await expect(prisma.trashCache.findMany()).resolves.toEqual(before);
});

for (const serviceType of ["RADARR", "SONARR"] as const) {
	for (const configType of ["NAMING_PRESETS", "QUALITY_PROFILE_GROUPS"] as const) {
		describe(`${serviceType} ${configType} complete publication`, () => {
			let mode: "good" | "unavailable" | "malformed" | "invalid" | "mixed" | "empty";
			const naming =
				serviceType === "RADARR"
					? { folder: { Default: "Synthetic folder" }, file: { Default: "Synthetic file" } }
					: {
							season: { Default: "Synthetic season" },
							series: { Default: "Synthetic series" },
							episodes: { standard: { Default: "Synthetic episode" }, daily: {}, anime: {} },
						};
			const valid =
				configType === "NAMING_PRESETS"
					? naming
					: { name: "Synthetic group", profiles: { "Synthetic profile": "synthetic-id" } };
			beforeEach(() => {
				mode = "good";
				vi.stubGlobal("fetch", async (input: string) => {
					const url = new URL(input);
					if (url.hostname === "api.github.com")
						return Response.json([
							{ name: "first.json", type: "file" },
							{ name: "later.json", type: "file" },
						]);
					expect(url.hostname).toBe("raw.githubusercontent.com");
					// A later naming file fails only after an earlier one was collected.
					if (configType === "NAMING_PRESETS" && url.pathname.endsWith("first.json")) {
						return Response.json(mode === "empty" ? [] : valid);
					}
					if (mode === "unavailable") return Response.json({}, { status: 404 });
					if (mode === "malformed") return new Response("not-json");
					return Response.json(
						mode === "invalid"
							? {}
							: mode === "mixed"
								? [valid, {}]
								: mode === "empty"
									? []
									: valid,
					);
				});
			});

			it.each(["unavailable", "malformed", "invalid", "mixed"] as const)(
				"keeps the prior publication after %s content and permits retry",
				async (failure) => {
					expect((await refresh(serviceType, true, configType)).statusCode).toBe(200);
					const where = { serviceType_configType: { serviceType, configType } };
					const before = await prisma.trashCache.findUniqueOrThrow({ where });
					mode = failure;
					expect((await refresh(serviceType, true, configType)).statusCode).toBeGreaterThanOrEqual(
						400,
					);
					const after = await prisma.trashCache.findUniqueOrThrow({ where });
					expect(after.data).toBe(before.data);
					expect(after.version).toBe(before.version);
					expect(after.fetchedAt).toEqual(before.fetchedAt);
					mode = "good";
					expect((await refresh(serviceType, true, configType)).statusCode).toBe(200);
					expect((await prisma.trashCache.findUniqueOrThrow({ where })).version).toBe(
						before.version + 1,
					);
				},
			);

			it("accepts a genuinely fetched empty array", async () => {
				mode = "empty";
				const response = await refresh(serviceType, true, configType);
				expect(response.statusCode).toBe(200);
				expect(response.json().results[configType]).toMatchObject({ success: true, itemCount: 0 });
			});
		});
	}
}

for (const serviceType of ["RADARR", "SONARR"] as const) {
	describe(`${serviceType} cache publication`, () => {
		it("publishes verified content, reads it back, and avoids an unneeded fresh refresh", async () => {
			const created = await refresh(serviceType);
			expect(created.statusCode).toBe(200);
			expect(created.json().results.QUALITY_SIZE).toMatchObject({ success: true, itemCount: 1 });
			const readback = await app.inject({ url: `/cache/${serviceType}/QUALITY_SIZE`, headers });
			expect(readback.statusCode).toBe(200);
			expect(readback.json()).toMatchObject({ cached: true, data: [quality] });
			const before = upstreamRequests;
			const fresh = await refresh(serviceType, false);
			expect(fresh.json().refreshed).toBe(false);
			expect(upstreamRequests).toBe(before);
		});

		it.each(["listing unavailable", "malformed listing", "content unavailable"])(
			"preserves the good publication when %s, then permits an explicit retry",
			async (failure) => {
				expect((await refresh(serviceType)).statusCode).toBe(200);
				const where = { serviceType_configType: { serviceType, configType: "QUALITY_SIZE" } };
				const before = await prisma.trashCache.findUniqueOrThrow({ where });
				listingStatus = failure === "listing unavailable" ? 404 : 200;
				malformedListing = failure === "malformed listing";
				contentStatus = failure === "content unavailable" ? 404 : 200;
				const failed = await refresh(serviceType);
				expect(failed.statusCode).toBeGreaterThanOrEqual(400);
				const after = await prisma.trashCache.findUniqueOrThrow({ where });
				expect(after.data).toBe(before.data);
				expect(after.version).toBe(before.version);
				expect(after.fetchedAt).toEqual(before.fetchedAt);
				listingStatus = 200;
				malformedListing = false;
				contentStatus = 200;
				expect((await refresh(serviceType)).statusCode).toBe(200);
				expect((await prisma.trashCache.findUniqueOrThrow({ where })).version).toBe(
					before.version + 1,
				);
			},
		);

		it("reports unreadable data and repairs it on a non-forced refresh", async () => {
			expect((await refresh(serviceType)).statusCode).toBe(200);
			const where = { serviceType_configType: { serviceType, configType: "QUALITY_SIZE" } };
			const corrupt = await prisma.trashCache.update({
				where,
				data: {
					data: gzipSync(JSON.stringify([{ invalid: true }])).toString("base64"),
					commitHash: "verified:v1:synthetic%2Frepo:0123456789abcdef0123456789abcdef01234567",
				},
			});
			const readsBefore = upstreamRequests;
			const status = await app.inject({ url: `/cache/status?serviceType=${serviceType}`, headers });
			expect(status.statusCode).toBe(200);
			expect(status.json().statuses).toMatchObject([
				{ configType: "QUALITY_SIZE", unavailable: true, itemCount: null },
			]);
			expect(upstreamRequests).toBe(readsBefore);
			await expect(prisma.trashCache.findUnique({ where })).resolves.toEqual(corrupt);
			const recovered = await refresh(serviceType, false);
			expect(recovered.statusCode).toBe(200);
			expect(recovered.json()).toMatchObject({
				refreshed: true,
				status: { itemCount: 1, version: corrupt.version + 1 },
			});
			expect(recovered.json().status.unavailable).toBeUndefined();
			expect((await prisma.trashCache.findUniqueOrThrow({ where })).commitHash).toBeNull();
		});

		it("allows a genuinely fetched and validated empty content array", async () => {
			emptyContent = true;
			const response = await refresh(serviceType);
			expect(response.statusCode).toBe(200);
			expect(response.json().results.QUALITY_SIZE).toMatchObject({ success: true, itemCount: 0 });
			const readback = await app.inject({ url: `/cache/${serviceType}/QUALITY_SIZE`, headers });
			expect(readback.json()).toMatchObject({ cached: true, data: [] });
		});

		it("preserves stale cached data when its automatic read refresh cannot list the source", async () => {
			expect((await refresh(serviceType)).statusCode).toBe(200);
			const where = { serviceType_configType: { serviceType, configType: "QUALITY_SIZE" } };
			await prisma.trashCache.update({ where, data: { lastCheckedAt: new Date(0) } });
			const before = await prisma.trashCache.findUniqueOrThrow({ where });
			listingStatus = 404;
			const failed = await app.inject({ url: `/cache/${serviceType}/QUALITY_SIZE`, headers });
			expect(failed.statusCode).toBeGreaterThanOrEqual(400);
			const after = await prisma.trashCache.findUniqueOrThrow({ where });
			expect(after.data).toBe(before.data);
			expect(after.version).toBe(before.version);
			expect(after.fetchedAt).toEqual(before.fetchedAt);
		});
	});
}
