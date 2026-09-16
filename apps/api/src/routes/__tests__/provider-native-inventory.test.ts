import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	createInjectAuthenticated,
	registerTestErrorHandler,
	setupAuthInjection,
} from "./test-helpers.js";

const mocks = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock("../../lib/provider-observation/inventory-connection-repository.js", () => ({
	readProviderInventoryConnections: mocks.read,
}));

import { registerProviderInventoryRoutes } from "../library/provider-inventory-routes.js";

let app: FastifyInstance;
beforeEach(async () => {
	vi.clearAllMocks();
	app = Fastify();
	app.decorate("prisma", {} as never);
	setupAuthInjection(app);
	registerTestErrorHandler(app);
	await app.register(registerProviderInventoryRoutes);
	await app.ready();
});
afterEach(async () => {
	await app.close();
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
				},
			],
			nextNativeId: "native-1",
		});
		const res = await createInjectAuthenticated(app)("GET", `${path}&userId=foreign-user`);
		expect(res.statusCode).toBe(200);
		expect(mocks.read).toHaveBeenCalledWith(app.prisma, {
			userId: "user-1",
			instanceId: "plex-1",
			domain: "episode",
			limit: 100,
		});
		expect(res.json()).toMatchObject({
			itemCount: 24343,
			observedAt: "2026-09-14T12:00:00.000Z",
			rows: [{ title: "Unmatched episode" }],
		});
	});
	it("hides unowned instances without publishing an empty catalog", async () => {
		mocks.read.mockResolvedValue({ status: "unavailable", reason: "not-owned" });
		const res = await createInjectAuthenticated(app)("GET", path);
		expect(res.statusCode).toBe(404);
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
		},
	);
	it("pins subsequent pages to the supplied generation", async () => {
		mocks.read.mockResolvedValue({ status: "unavailable", reason: "snapshot-changed" });
		await createInjectAuthenticated(app)(
			"GET",
			`${path}&afterNativeId=cursor&expectedGenerationId=generation&limit=50`,
		);
		expect(mocks.read).toHaveBeenCalledWith(app.prisma, {
			userId: "user-1",
			instanceId: "plex-1",
			domain: "episode",
			afterNativeId: "cursor",
			expectedGenerationId: "generation",
			limit: 50,
		});
	});
});
