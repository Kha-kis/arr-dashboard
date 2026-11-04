import Fastify, { type FastifyBaseLogger, type FastifyInstance } from "fastify";
import pino from "pino";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	createInjectAuthenticated,
	registerTestErrorHandler,
	setupAuthInjection,
} from "./test-helpers.js";

const mocks = vi.hoisted(() => ({ read: vi.fn(), withRead: vi.fn() }));
vi.mock("../../lib/provider-observation/inventory-connection-repository.js", () => ({
	readProviderInventoryConnections: mocks.read,
}));
vi.mock("../../lib/backup/restore-runtime-client.js", () => ({
	withIsolatedRuntimePrismaReadClient: mocks.withRead,
}));

import { registerProviderInventoryRoutes } from "../library/provider-inventory-routes.js";

let app: FastifyInstance;
const events: Array<Record<string, unknown>> = [];
let rejectTimingLog = false;
const timingEvent = () =>
	events.find((event) => event.category === "provider-inventory-read-timing");
beforeEach(async () => {
	vi.clearAllMocks();
	events.length = 0;
	rejectTimingLog = false;
	mocks.withRead.mockImplementation(async (prisma, read) => await read(prisma));
	const log: FastifyBaseLogger = pino(
		{ base: null, timestamp: false },
		{
			write(line) {
				const event = JSON.parse(line) as Record<string, unknown>;
				events.push(event);
				if (rejectTimingLog && event.category === "provider-inventory-read-timing")
					throw new Error("Synthetic timing logger failure");
			},
		},
	);
	app = Fastify({ loggerInstance: log });
	app.decorate("prisma", {} as never);
	setupAuthInjection(app);
	app.addHook("preHandler", async (request) => {
		if (request.currentUser) request.log = request.log.child({ userId: request.currentUser.id });
	});
	registerTestErrorHandler(app);
	await app.register(registerProviderInventoryRoutes);
	await app.ready();
});
afterEach(async () => {
	await app.close();
	vi.restoreAllMocks();
});

const path = "/library/provider-inventory?instanceId=plex-1&domain=episode";

describe("owned native inventory route", () => {
	it("reads a bounded published page using the authenticated owner", async () => {
		mocks.read.mockResolvedValue({
			status: "available",
			generationId: "generation",
			observedAt: new Date("2026-09-14T12:00:00Z"),
			itemCount: 24343,
			scopeCount: 2,
			lastAttemptAt: null,
			lastAttemptResult: "success",
			lastAttemptReason: null,
			freshness: "current",
			complete: true,
			rows: [
				{
					nativeId: "native-1",
					mediaType: "episode",
					libraryIds: ["library"],
					parentNativeId: null,
					seasonNumber: null,
					episodeNumber: null,
					title: "Unmatched episode",
					watch: {
						state: "watched",
						freshness: "current",
						valueSemantics: "exact",
						observedAt: "2026-09-14T12:00:00.000Z",
					},
				},
			],
			nextNativeId: "native-1",
		});
		const res = await createInjectAuthenticated(app)("GET", `${path}&userId=foreign-user`);
		expect(res.statusCode).toBe(200);
		expect(mocks.read).toHaveBeenCalledWith(
			app.prisma,
			{
				userId: "user-1",
				instanceId: "plex-1",
				domain: "episode",
				limit: 100,
				includeAttempt: true,
			},
			expect.objectContaining({ child: expect.any(Function) }),
		);
		expect(res.json()).toMatchObject({
			itemCount: 24343,
			observedAt: "2026-09-14T12:00:00.000Z",
			rows: [{ title: "Unmatched episode", watch: { state: "watched" } }],
		});
		expect(timingEvent()).toMatchObject({ outcome: "available", domain: "episode" });
	});
	it("passes the bounded missing-TMDb filter through the owned library route", async () => {
		mocks.read.mockResolvedValue({
			status: "available",
			generationId: "generation",
			observedAt: new Date("2026-09-14T12:00:00Z"),
			itemCount: 2,
			filteredItemCount: 1,
			scopeCount: 1,
			lastAttemptAt: null,
			lastAttemptResult: "success",
			lastAttemptReason: null,
			freshness: "current",
			complete: true,
			rows: [
				{
					nativeId: "unmapped",
					mediaType: "movie",
					libraryIds: ["library"],
					parentNativeId: null,
					seasonNumber: null,
					episodeNumber: null,
					title: "Synthetic unmapped item",
				},
			],
			nextNativeId: null,
		});
		const res = await createInjectAuthenticated(app)(
			"GET",
			"/library/provider-inventory?instanceId=plex-1&domain=library&metadataFilter=missing-tmdb",
		);
		expect(res.statusCode).toBe(200);
		expect(mocks.read).toHaveBeenCalledWith(
			app.prisma,
			expect.objectContaining({
				userId: "user-1",
				instanceId: "plex-1",
				domain: "library",
				metadataFilter: "missing-tmdb",
			}),
			expect.objectContaining({ child: expect.any(Function) }),
		);
		expect(res.json()).toMatchObject({ itemCount: 2, filteredItemCount: 1 });
	});
	it("rejects an invalid watch category rather than silently normalizing it", async () => {
		mocks.read.mockResolvedValue({
			status: "available",
			generationId: "generation",
			observedAt: new Date("2026-09-14T12:00:00Z"),
			itemCount: 1,
			scopeCount: 1,
			lastAttemptAt: null,
			lastAttemptResult: "success",
			lastAttemptReason: null,
			freshness: "current",
			complete: true,
			rows: [
				{
					nativeId: "native-1",
					mediaType: "episode",
					libraryIds: ["library"],
					parentNativeId: "series-1",
					seasonNumber: 1,
					episodeNumber: 1,
					title: "Synthetic episode",
					watch: {
						state: "not-really",
						freshness: "current",
						valueSemantics: "exact",
						observedAt: null,
					},
				},
			],
			nextNativeId: null,
		});
		const res = await createInjectAuthenticated(app)("GET", path);
		expect(res.statusCode).toBe(500);
		expect(res.json()).not.toHaveProperty("rows");
		expect(timingEvent()).toMatchObject({ outcome: "error" });
	});
	it("hides unowned instances without publishing an empty catalog", async () => {
		mocks.read.mockResolvedValue({ status: "unavailable", reason: "not-owned" });
		const res = await createInjectAuthenticated(app)("GET", path);
		expect(res.statusCode).toBe(404);
		expect(res.json()).not.toHaveProperty("itemCount");
		expect(timingEvent()).toMatchObject({ outcome: "unavailable" });
	});
	it("returns generic scan progress without treating staged rows as published zero", async () => {
		mocks.read.mockResolvedValue({
			status: "unavailable",
			reason: "no-publication",
			attempt: {
				state: "running",
				passOrdinal: 2,
				pagesCompleted: 3,
				itemsStaged: 300,
				failureCount: 0,
				reasonCode: null,
			},
		});
		const res = await createInjectAuthenticated(app)("GET", path);
		expect(res.statusCode).toBe(200);
		expect(res.json()).toEqual({
			status: "unavailable",
			reason: "no-publication",
			attempt: {
				state: "running",
				passOrdinal: 2,
				pagesCompleted: 3,
				itemsStaged: 300,
				failureCount: 0,
				reasonCode: null,
			},
		});
		expect(res.json()).not.toHaveProperty("itemCount");
	});
	it.each(["no-publication", "snapshot-changed", "identity-changed"])(
		"preserves %s without a zero total",
		async (reason) => {
			mocks.read.mockResolvedValue({ status: "unavailable", reason });
			const res = await createInjectAuthenticated(app)("GET", path);
			expect(res.statusCode).toBe(200);
			expect(res.json()).toEqual({ status: "unavailable", reason });
		},
	);
	it.each(["&limit=201", "&limit=0", "&afterNativeId=cursor", "&domain=unknown"])(
		"rejects invalid pagination %s before reading",
		async (query) => {
			const res = await createInjectAuthenticated(app)("GET", path + query);
			expect(res.statusCode).toBe(400);
			expect(mocks.read).not.toHaveBeenCalled();
			expect(timingEvent()).toBeUndefined();
		},
	);
	it("pins subsequent pages to the supplied generation", async () => {
		mocks.read.mockResolvedValue({ status: "unavailable", reason: "snapshot-changed" });
		await createInjectAuthenticated(app)(
			"GET",
			`${path}&afterNativeId=cursor&expectedGenerationId=generation&limit=50`,
		);
		expect(mocks.read).toHaveBeenCalledWith(
			app.prisma,
			{
				userId: "user-1",
				instanceId: "plex-1",
				domain: "episode",
				afterNativeId: "cursor",
				expectedGenerationId: "generation",
				limit: 50,
				includeAttempt: true,
			},
			expect.objectContaining({ child: expect.any(Function) }),
		);
	});
});

describe("inventory read timing", () => {
	it("separates admission, guarded repository and release without changing the response", async () => {
		let clock = 0;
		vi.spyOn(performance, "now").mockImplementation(() => clock);
		mocks.withRead.mockImplementation(async (prisma, read) => {
			clock = 20;
			const result = await read(prisma);
			clock = 75;
			return result;
		});
		mocks.read.mockImplementation(async () => {
			clock = 70;
			return { status: "unavailable", reason: "no-publication" };
		});
		const res = await createInjectAuthenticated(app)("GET", path);
		expect(res.statusCode).toBe(200);
		expect(res.json()).toEqual({ status: "unavailable", reason: "no-publication" });
		expect(timingEvent()).toMatchObject({
			category: "provider-inventory-read-timing",
			domain: "episode",
			outcome: "unavailable",
			readAdmissionMs: 20,
			repositoryMs: 50,
			releaseMs: 5,
			postReadMs: 0,
			totalMs: 75,
		});
		expect(Object.keys(timingEvent()!).sort()).toEqual(
			[
				"category",
				"domain",
				"level",
				"msg",
				"outcome",
				"postReadMs",
				"readAdmissionMs",
				"releaseMs",
				"repositoryMs",
				"totalMs",
			].sort(),
		);
	});

	it.each([
		{ phase: "admission", readAdmissionMs: 40, repositoryMs: 0, releaseMs: 0 },
		{ phase: "repository", readAdmissionMs: 0, repositoryMs: 40, releaseMs: 0 },
		{ phase: "release", readAdmissionMs: 0, repositoryMs: 0, releaseMs: 40 },
	])("preserves a $phase failure without logging private details", async (expected) => {
		let clock = 0;
		vi.spyOn(performance, "now").mockImplementation(() => clock);
		const failure = new Error("synthetic-private-payload-and-credential");
		mocks.read.mockImplementation(async () => {
			if (expected.phase === "repository") {
				clock = 40;
				throw failure;
			}
			return { status: "unavailable", reason: "no-publication" };
		});
		mocks.withRead.mockImplementation(async (prisma, read) => {
			if (expected.phase === "admission") {
				clock = 40;
				throw failure;
			}
			const result = await read(prisma);
			if (expected.phase === "release") {
				clock = 40;
				throw failure;
			}
			return result;
		});
		const res = await createInjectAuthenticated(app)("GET", path);
		expect(res.statusCode).toBe(500);
		expect(timingEvent()).toMatchObject({
			outcome: "error",
			totalMs: 40,
			postReadMs: 0,
			readAdmissionMs: expected.readAdmissionMs,
			repositoryMs: expected.repositoryMs,
			releaseMs: expected.releaseMs,
		});
		expect(JSON.stringify(timingEvent())).not.toContain(failure.message);
		expect(JSON.stringify(timingEvent())).not.toContain("plex-1");
		expect(JSON.stringify(timingEvent())).not.toContain("user-1");
	});

	it("keeps a valid response when the diagnostic logger throws", async () => {
		rejectTimingLog = true;
		mocks.read.mockResolvedValue({ status: "unavailable", reason: "no-publication" });
		const res = await createInjectAuthenticated(app)("GET", path);
		expect(res.statusCode).toBe(200);
		expect(res.json()).toEqual({ status: "unavailable", reason: "no-publication" });
		expect(timingEvent()).toMatchObject({ outcome: "unavailable" });
	});
});
