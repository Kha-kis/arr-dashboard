import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	createInjectAuthenticated,
	registerTestErrorHandler,
	setupAuthInjection,
} from "../../__tests__/test-helpers.js";
import { InstanceNotFoundError } from "../../../lib/errors.js";
import { JellyfinClient } from "../../../lib/jellyfin/jellyfin-client.js";

const routeMocks = vi.hoisted(() => ({
	requireClient: vi.fn(),
}));

vi.mock("../../../lib/jellyfin/jellyfin-helpers.js", () => ({
	requireJellyfinClient: routeMocks.requireClient,
}));

import { registerImageProxyRoutes } from "../image-proxy-routes.js";

describe("GET /api/jellyfin/thumb/:instanceId", () => {
	let app: FastifyInstance;
	const fetchImage = vi.fn();
	const log = { warn: vi.fn() };

	beforeEach(async () => {
		vi.clearAllMocks();
		fetchImage.mockResolvedValue(
			new Response("image-bytes", {
				status: 200,
				headers: { "Content-Type": "image/jpeg" },
			}),
		);
		routeMocks.requireClient.mockResolvedValue({ client: { fetchImage } });

		app = Fastify({ logger: false });
		setupAuthInjection(app);
		app.decorate("prisma", {} as never);
		app.decorate("encryptor", {} as never);
		registerTestErrorHandler(app);
		await app.register(registerImageProxyRoutes, { prefix: "/api/jellyfin/thumb" });
		await app.ready();
	});

	afterEach(async () => {
		vi.unstubAllGlobals();
		await app.close();
	});

	it("sanitizes a typed missing-image response to 404", async () => {
		vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 404 })));
		routeMocks.requireClient.mockResolvedValueOnce({
			client: new JellyfinClient("https://jellyfin.example.test", "private-token", log as never),
		});

		const response = await createInjectAuthenticated(app)(
			"GET",
			"/api/jellyfin/thumb/instance-1?itemId=item-1",
		);

		expect(response.statusCode).toBe(404);
		expect(response.json()).toEqual({ error: "Image not found" });
		expect(response.headers["cache-control"]).toBe("no-store");
		expect(response.body).not.toContain("private-token");
	});

	it("keeps unexpected image failures as errors", async () => {
		fetchImage.mockRejectedValueOnce(new Error("private upstream URL and token"));

		const response = await createInjectAuthenticated(app)(
			"GET",
			"/api/jellyfin/thumb/instance-1?itemId=item-1",
		);

		expect(response.statusCode).toBe(500);
		expect(response.body).not.toContain("private upstream URL and token");
	});

	it.each([401, 403, 500])("does not map upstream HTTP %s to missing image", async (status) => {
		vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status })));
		routeMocks.requireClient.mockResolvedValueOnce({
			client: new JellyfinClient("https://jellyfin.example.test", "private-token", log as never),
		});

		const response = await createInjectAuthenticated(app)(
			"GET",
			"/api/jellyfin/thumb/instance-1?itemId=item-1",
		);

		expect(response.statusCode).toBe(500);
		expect(response.body).not.toContain("private-token");
	});

	it.each([
		new TypeError("fetch failed"),
		new DOMException("The operation was aborted", "AbortError"),
		new DOMException("The operation timed out", "TimeoutError"),
	])("keeps transport and timeout failures as errors", async (failure) => {
		vi.stubGlobal("fetch", vi.fn().mockRejectedValue(failure));
		routeMocks.requireClient.mockResolvedValueOnce({
			client: new JellyfinClient("https://jellyfin.example.test", "private-token", log as never),
		});

		const response = await createInjectAuthenticated(app)(
			"GET",
			"/api/jellyfin/thumb/instance-1?itemId=item-1",
		);

		expect(response.statusCode).toBe(500);
		expect(response.body).not.toContain("private-token");
	});

	it("rejects invalid item IDs before resolving a Jellyfin client", async () => {
		const response = await createInjectAuthenticated(app)(
			"GET",
			"/api/jellyfin/thumb/instance-1?itemId=../private",
		);

		expect(response.statusCode).toBe(400);
		expect(routeMocks.requireClient).not.toHaveBeenCalled();
		expect(fetchImage).not.toHaveBeenCalled();
	});

	it("does not fetch an image when ownership resolution rejects the instance", async () => {
		routeMocks.requireClient.mockRejectedValueOnce(new InstanceNotFoundError("instance-1"));

		const response = await createInjectAuthenticated(app)(
			"GET",
			"/api/jellyfin/thumb/instance-1?itemId=item-1",
		);

		expect(response.statusCode).toBe(404);
		expect(fetchImage).not.toHaveBeenCalled();
	});

	it("preserves successful image proxying", async () => {
		const response = await createInjectAuthenticated(app)(
			"GET",
			"/api/jellyfin/thumb/instance-1?itemId=item-1",
		);

		expect(response.statusCode).toBe(200);
		expect(response.headers["content-type"]).toContain("image/jpeg");
		expect(response.body).toBe("image-bytes");
		expect(fetchImage).toHaveBeenCalledWith("item-1", "Primary", 300);
		expect(routeMocks.requireClient).toHaveBeenCalledWith(
			expect.anything(),
			"user-1",
			"instance-1",
		);
	});
});
