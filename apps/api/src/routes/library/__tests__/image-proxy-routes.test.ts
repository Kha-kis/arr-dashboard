import { createServer } from "node:http";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	createInjectAuthenticated,
	registerTestErrorHandler,
	setupAuthInjection,
} from "../../__tests__/test-helpers.js";
import { registerLibraryRoutes } from "../../library.js";
import { ArrClientFactory } from "../../../lib/arr/client-factory.js";
import { Encryptor } from "../../../lib/auth/encryption.js";

const fixture = vi.hoisted(() => ({ readActive: false }));
vi.mock("../../../lib/backup/restore-runtime-client.js", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("../../../lib/backup/restore-runtime-client.js")>();
	return {
		...actual,
		withIsolatedRuntimePrismaReadClient: async (
			prisma: unknown,
			operation: (client: unknown) => Promise<unknown>,
		) => {
			fixture.readActive = true;
			try {
				return await operation(prisma);
			} finally {
				fixture.readActive = false;
			}
		},
	};
});

describe("authenticated cached Library poster delivery", () => {
	let app: FastifyInstance;
	const findFirst = vi.fn();
	const rawRequest = vi.fn();
	const instance = {
		id: "instance-1",
		userId: "user-1",
		service: "RADARR",
		enabled: true,
		baseUrl: "http://arr.example.test/subpath",
		encryptedApiKey: "synthetic-encrypted",
		encryptionIv: "synthetic-iv",
	};

	beforeEach(async () => {
		vi.clearAllMocks();
		fixture.readActive = false;
		const row = {
			instanceId: instance.id,
			arrItemId: 42,
			itemType: "movie",
			cutoffUnmet: false,
			torrentSyncedAt: null,
			torrentState: null,
			torrentRatio: null,
			data: JSON.stringify({
				id: 999,
				instanceId: "inconsistent-json-instance",
				instanceName: "Synthetic",
				service: "radarr",
				type: "movie",
				title: "Synthetic",
				monitored: true,
				poster: "https://unreachable.example.test/poster.jpg",
			}),
			instance,
		};
		findFirst.mockResolvedValue(row);
		rawRequest.mockImplementation(async () => {
			expect(fixture.readActive).toBe(false);
			return new Response("synthetic-image", { headers: { "content-type": "image/jpeg" } });
		});
		app = Fastify({ logger: false });
		setupAuthInjection(app);
		app.addHook("preHandler", async (request, reply) => {
			if (!request.currentUser?.id) return reply.code(401).send({ error: "Unauthorized" });
		});
		const prisma = {
			libraryCache: {
				findFirst,
				findMany: vi.fn().mockResolvedValue([row]),
				count: vi.fn().mockResolvedValue(1),
			},
			serviceInstance: {
				findMany: vi.fn(async (query: { where: { service?: unknown } }) =>
					query.where.service === "QUI" ? [] : [{ id: instance.id }],
				),
			},
			librarySyncStatus: { findMany: vi.fn().mockResolvedValue([]) },
			$queryRaw: vi.fn().mockResolvedValue([row]),
		};
		Object.assign(prisma, {
			$transaction: async (operation: (client: unknown) => Promise<unknown>) => operation(prisma),
		});
		app.decorate("prisma", prisma as never);
		app.decorate("arrClientFactory", { rawRequest } as never);
		registerTestErrorHandler(app);
		await app.register(registerLibraryRoutes, { prefix: "/api" });
		await app.ready();
	});

	afterEach(async () => {
		await app.close();
	});

	const url = "/api/library/poster/instance-1/movie/42";
	const inject = () => createInjectAuthenticated(app)("GET", url);

	it.each([
		["artist", "LIDARR"],
		["author", "READARR"],
	] as const)(
		"preserves case for %s posters through actual credentialed HTTP",
		async (itemType, service) => {
			const requests: Array<{
				path: string | undefined;
				authenticated: boolean;
				readActive: boolean;
			}> = [];
			const bytes = Buffer.from(
				"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jrX8AAAAASUVORK5CYII=",
				"base64",
			);
			const server = createServer((request, response) => {
				const authenticated = request.headers["x-api-key"] === "synthetic-token";
				requests.push({ path: request.url, authenticated, readActive: fixture.readActive });
				if (!authenticated) return void response.writeHead(403).end();
				if (request.url !== "/arr/MediaCover/42/poster.PNG")
					return void response.writeHead(404).end();
				response.writeHead(200, { "content-type": "image/png", connection: "close" }).end(bytes);
			});
			try {
				await new Promise<void>((resolve, reject) => {
					server.once("error", reject);
					server.listen(0, "127.0.0.1", resolve);
				});
				const address = server.address();
				if (!address || typeof address === "string")
					throw new Error("Synthetic listener unavailable");
				const encryptor = new Encryptor("42".repeat(32));
				const key = encryptor.encrypt("synthetic-token");
				app.arrClientFactory = new ArrClientFactory(encryptor);
				findFirst.mockResolvedValueOnce({
					instanceId: instance.id,
					arrItemId: 42,
					itemType,
					data: JSON.stringify({ poster: "https://synthetic.test/cover.PNG" }),
					instance: {
						...instance,
						service,
						baseUrl: `http://127.0.0.1:${address.port}/arr`,
						encryptedApiKey: key.value,
						encryptionIv: key.iv,
					},
				});
				const response = await createInjectAuthenticated(app)(
					"GET",
					`/api/library/poster/instance-1/${itemType}/42`,
				);
				expect(response.statusCode).toBe(200);
				expect(response.rawPayload).toEqual(bytes);
				expect(requests).toEqual([
					{ path: "/arr/MediaCover/42/poster.PNG", authenticated: true, readActive: false },
				]);
				expect(rawRequest).not.toHaveBeenCalled();
			} finally {
				server.closeAllConnections();
				if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
			}
		},
	);

	it.each(["/api/library", "/api/library/by-tmdb/999"])(
		"projects existing cached artwork through %s using row keys, not JSON identity",
		async (path) => {
			const response = await createInjectAuthenticated(app)("GET", path);
			expect(response.statusCode).toBe(200);
			const result = response.json();
			const item = result.item ?? result.items[0];
			expect(item.poster).toMatch(
				/^\/api\/library\/poster\/instance-1\/movie\/42\?v=[a-f0-9]{16}$/,
			);
			expect(item.poster).not.toContain("unreachable");
			expect(rawRequest).not.toHaveBeenCalled();
		},
	);

	it("delivers the owned cache row's fixed media-cover target after releasing the DB lane", async () => {
		const response = await inject();
		expect(response.statusCode).toBe(200);
		expect(response.body).toBe("synthetic-image");
		expect(response.headers["content-type"]).toBe("image/jpeg");
		expect(response.headers["cache-control"]).toBe("private, max-age=300");
		expect(response.headers["x-content-type-options"]).toBe("nosniff");
		expect(response.headers.vary).toBe("Cookie");
		expect(rawRequest).toHaveBeenCalledExactlyOnceWith(instance, "/MediaCover/42/poster.jpg", {
			method: "GET",
			timeout: 5000,
			redirect: "error",
		});
		expect(findFirst).toHaveBeenCalledExactlyOnceWith({
			where: {
				instanceId: "instance-1",
				arrItemId: 42,
				itemType: "movie",
				instance: { userId: "user-1", enabled: true, service: "RADARR" },
			},
			select: { instanceId: true, arrItemId: true, itemType: true, data: true, instance: true },
		});
	});

	it.each([
		["series", "SONARR"],
		["artist", "LIDARR"],
		["author", "READARR"],
	] as const)(
		"resolves %s only against its matching owned %s instance",
		async (itemType, service) => {
			const otherInstance = { ...instance, id: "instance-2", service };
			findFirst.mockResolvedValueOnce({
				instanceId: otherInstance.id,
				arrItemId: 42,
				itemType,
				data: JSON.stringify({ id: 999, poster: "https://synthetic.test/poster.jpg" }),
				instance: otherInstance,
			});
			const response = await createInjectAuthenticated(app)(
				"GET",
				`/api/library/poster/instance-2/${itemType}/42`,
			);
			expect(response.statusCode).toBe(200);
			expect(findFirst).toHaveBeenCalledWith(
				expect.objectContaining({
					where: {
						instanceId: "instance-2",
						arrItemId: 42,
						itemType,
						instance: { userId: "user-1", enabled: true, service },
					},
				}),
			);
			expect(rawRequest).toHaveBeenCalledWith(
				otherInstance,
				"/MediaCover/42/poster.jpg",
				expect.anything(),
			);
		},
	);

	it("refuses signed-out requests before cache or provider reads", async () => {
		expect((await app.inject({ method: "GET", url })).statusCode).toBe(401);
		expect(findFirst).not.toHaveBeenCalled();
		expect(rawRequest).not.toHaveBeenCalled();
	});

	it("refuses a missing, foreign-owned, disabled, or wrong-service cache match", async () => {
		findFirst.mockResolvedValueOnce(null);
		const response = await inject();
		expect(response.statusCode).toBe(404);
		expect(response.headers["cache-control"]).toBe("no-store");
		expect(rawRequest).not.toHaveBeenCalled();
	});

	it.each(["0", "-1", "1.5", "1e2", "9007199254740992", "42%2Fother"])(
		"rejects malformed item ID %s before target resolution",
		async (id) => {
			const response = await createInjectAuthenticated(app)(
				"GET",
				`/api/library/poster/instance-1/movie/${id}`,
			);
			expect(response.statusCode).toBe(400);
			expect(findFirst).not.toHaveBeenCalled();
			expect(rawRequest).not.toHaveBeenCalled();
		},
	);

	it("rejects unsupported root types instead of interpreting them as paths", async () => {
		const response = await createInjectAuthenticated(app)(
			"GET",
			"/api/library/poster/instance-1/album/42",
		);
		expect(response.statusCode).toBe(400);
		expect(findFirst).not.toHaveBeenCalled();
		expect(rawRequest).not.toHaveBeenCalled();
	});

	it.each([404, 401, 403, 302, 500])(
		"sanitizes provider HTTP %s without forwarding its body",
		async (status) => {
			rawRequest.mockResolvedValueOnce(new Response("private upstream detail", { status }));
			const response = await inject();
			expect(response.statusCode).toBe(status === 404 ? 404 : 502);
			expect(response.headers["cache-control"]).toBe("no-store");
			expect(response.body).not.toContain("private upstream detail");
		},
	);

	it.each(["text/html", "image/svg+xml", "application/octet-stream", ""])(
		"refuses non-raster content type %s",
		async (contentType) => {
			rawRequest.mockResolvedValueOnce(
				new Response("private invalid image", { headers: { "content-type": contentType } }),
			);
			const response = await inject();
			expect(response.statusCode).toBe(502);
			expect(response.headers["cache-control"]).toBe("no-store");
			expect(response.body).not.toContain("private invalid image");
		},
	);

	it("bounds streamed bytes without trusting Content-Length and cancels overflow", async () => {
		const cancel = vi.fn();
		let chunks = 0;
		const stream = new ReadableStream<Uint8Array>({
			pull(controller) {
				chunks++;
				controller.enqueue(new Uint8Array(1024 * 1024));
			},
			cancel,
		});
		rawRequest.mockResolvedValueOnce(
			new Response(stream, { headers: { "content-type": "image/png", "content-length": "1" } }),
		);
		const response = await inject();
		expect(response.statusCode).toBe(502);
		expect(cancel).toHaveBeenCalledOnce();
		expect(chunks).toBeLessThanOrEqual(6);
	});

	it("sanitizes transport and redirect failures as unavailable", async () => {
		rawRequest.mockRejectedValueOnce(new Error("private URL, token and redirect detail"));
		const response = await inject();
		expect(response.statusCode).toBe(503);
		expect(response.headers["cache-control"]).toBe("no-store");
		expect(response.body).not.toContain("private URL");
	});

	it("sanitizes a body-read failure as unavailable", async () => {
		rawRequest.mockResolvedValueOnce(
			new Response(
				new ReadableStream({
					start(controller) {
						controller.error(new Error("private body failure"));
					},
				}),
				{ headers: { "content-type": "image/jpeg" } },
			),
		);
		const response = await inject();
		expect(response.statusCode).toBe(503);
		expect(response.body).not.toContain("private body failure");
	});
});
