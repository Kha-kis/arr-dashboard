import type { FastifyBaseLogger, FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QuiApiError, QuiInstanceUnreachableError } from "../../errors.js";
import type { ServiceInstance } from "../../prisma.js";
import { createQuiClient } from "../client-factory.js";

const fakeLog: FastifyBaseLogger = {
	info: vi.fn(),
	warn: vi.fn(),
	error: vi.fn(),
	debug: vi.fn(),
	trace: vi.fn(),
	fatal: vi.fn(),
	silent: vi.fn(),
	child: vi.fn(() => fakeLog),
	level: "info",
} as unknown as FastifyBaseLogger;

const buildApp = (): FastifyInstance =>
	({
		log: fakeLog,
		encryptor: { decrypt: () => "test-api-key" },
	}) as unknown as FastifyInstance;

const buildInstance = (over: Partial<ServiceInstance> = {}): ServiceInstance =>
	({
		id: "qui-1",
		userId: "u1",
		service: "QUI",
		label: "qui main",
		baseUrl: "http://qui.test",
		externalUrl: null,
		encryptedApiKey: "enc",
		encryptionIv: "iv",
		isDefault: false,
		enabled: true,
		storageGroupId: null,
		createdAt: new Date(),
		updatedAt: new Date(),
		...over,
	}) as ServiceInstance;

// qui's wire format is full snake_case using qBit's native field names.
const wireTorrent = (over: Record<string, unknown> = {}) => ({
	hash: "abc123",
	name: "T",
	state: "uploading",
	ratio: 1.42,
	progress: 1,
	num_seeds: 1,
	num_leechs: 0,
	tags: "",
	category: "",
	save_path: "/x",
	added_on: 0,
	completion_on: 100,
	seeding_time: 200,
	eta: 0,
	dlspeed: 0,
	upspeed: 1024,
	priority: 0,
	size: 100,
	instance_id: 1,
	instance_name: "qb",
	...over,
});

describe("createQuiClient", () => {
	const fetchSpy = vi.spyOn(globalThis, "fetch");

	beforeEach(() => {
		fetchSpy.mockReset();
	});

	afterEach(() => {
		vi.clearAllMocks();
	});

	it("sends X-API-Key header with the decrypted key on every call", async () => {
		fetchSpy.mockResolvedValueOnce(
			new Response(JSON.stringify({ cross_instance_torrents: [wireTorrent()] }), {
				status: 200,
				headers: { "content-type": "application/json" },
			}),
		);

		const client = createQuiClient(buildApp(), buildInstance());
		await client.getTorrentByHash("abc123");

		expect(fetchSpy).toHaveBeenCalledOnce();
		const headers = fetchSpy.mock.calls[0]?.[1]?.headers as Record<string, string>;
		expect(headers["X-API-Key"]).toBe("test-api-key");
	});

	it("transforms snake_case wire format into canonical camelCase", async () => {
		fetchSpy.mockResolvedValueOnce(
			new Response(
				JSON.stringify({
					cross_instance_torrents: [
						wireTorrent({
							hash: "abc123",
							num_seeds: 5,
							num_leechs: 2,
							save_path: "/data/tv",
							added_on: 1700000000,
							completion_on: 1700001000,
							seeding_time: 86400,
							dlspeed: 0,
							upspeed: 2048,
							tags: "linux,iso,private",
						}),
					],
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			),
		);

		const client = createQuiClient(buildApp(), buildInstance());
		const result = await client.getTorrentByHash("abc123");

		expect(result).not.toBeNull();
		expect(result?.numSeeds).toBe(5);
		expect(result?.numLeechs).toBe(2);
		expect(result?.savePath).toBe("/data/tv");
		expect(result?.addedOn).toBe(1700000000);
		expect(result?.completedOn).toBe(1700001000);
		expect(result?.seedingTime).toBe(86400);
		expect(result?.upSpeed).toBe(2048);
		expect(result?.tags).toEqual(["linux", "iso", "private"]);
	});

	it("normalizes completion_on=0 to completedOn=null (incomplete torrents)", async () => {
		fetchSpy.mockResolvedValueOnce(
			new Response(
				JSON.stringify({
					cross_instance_torrents: [wireTorrent({ completion_on: 0, progress: 0.5 })],
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			),
		);

		const client = createQuiClient(buildApp(), buildInstance());
		const result = await client.getTorrentByHash("abc123");
		expect(result?.completedOn).toBeNull();
	});

	it("returns null when cross-instance search has no exact hash match", async () => {
		fetchSpy.mockResolvedValueOnce(
			new Response(JSON.stringify({ cross_instance_torrents: [] }), {
				status: 200,
				headers: { "content-type": "application/json" },
			}),
		);

		const client = createQuiClient(buildApp(), buildInstance());
		const result = await client.getTorrentByHash("notfound");
		expect(result).toBeNull();
	});

	it("filters fuzzy matches to the exact lowercased hash", async () => {
		fetchSpy.mockResolvedValueOnce(
			new Response(
				JSON.stringify({
					cross_instance_torrents: [
						wireTorrent({ hash: "ABC123", instance_id: 1 }),
						wireTorrent({ hash: "differenthash", instance_id: 2 }),
					],
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			),
		);

		const client = createQuiClient(buildApp(), buildInstance());
		const result = await client.getTorrentByHash("abc123");
		expect(result?.hash).toBe("ABC123");
		expect(result?.instanceId).toBe(1);
	});

	it("handles cross_instance_torrents:null gracefully", async () => {
		fetchSpy.mockResolvedValueOnce(
			new Response(JSON.stringify({ cross_instance_torrents: null }), {
				status: 200,
				headers: { "content-type": "application/json" },
			}),
		);

		const client = createQuiClient(buildApp(), buildInstance());
		const result = await client.getTorrentByHash("abc123");
		expect(result).toBeNull();
	});

	it("derives tracker health from the raw qBit status int", async () => {
		fetchSpy.mockResolvedValueOnce(
			new Response(
				JSON.stringify([
					{
						url: "https://tracker.example/announce",
						status: 4,
						msg: "tracker not working",
						num_seeds: 0,
						num_leeches: 0,
						num_peers: 0,
					},
				]),
				{ status: 200, headers: { "content-type": "application/json" } },
			),
		);

		const client = createQuiClient(buildApp(), buildInstance());
		const trackers = await client.getTrackers(1, "abc123");
		expect(trackers[0]?.health).toBe("not_working");
		expect(trackers[0]?.status).toBe(4);
		expect(trackers[0]?.numLeeches).toBe(0);
	});

	it("getCrossSeedMatches normalizes matches:null to []", async () => {
		fetchSpy.mockResolvedValueOnce(
			new Response(JSON.stringify({ matches: null }), {
				status: 200,
				headers: { "content-type": "application/json" },
			}),
		);

		const client = createQuiClient(buildApp(), buildInstance());
		const matches = await client.getCrossSeedMatches(1, "abc123");
		expect(matches).toEqual([]);
	});

	it("throws QuiApiError with mapped status on 4xx", async () => {
		fetchSpy.mockResolvedValue(
			new Response(JSON.stringify({ error: "invalid api key" }), {
				status: 401,
				headers: { "content-type": "application/json" },
			}),
		);

		const client = createQuiClient(buildApp(), buildInstance());
		await expect(client.getTorrentByHash("abc")).rejects.toBeInstanceOf(QuiApiError);
		try {
			await client.getTorrentByHash("abc");
		} catch (error) {
			expect((error as QuiApiError).statusCode).toBe(401);
			expect((error as QuiApiError).upstreamStatus).toBe(401);
		}
	});

	it("collapses 5xx upstream to 502 client-facing", async () => {
		fetchSpy.mockResolvedValueOnce(new Response("Internal Server Error", { status: 500 }));

		const client = createQuiClient(buildApp(), buildInstance());
		try {
			await client.getTorrentByHash("abc");
			expect.fail("should have thrown");
		} catch (error) {
			expect(error).toBeInstanceOf(QuiApiError);
			expect((error as QuiApiError).statusCode).toBe(502);
			expect((error as QuiApiError).upstreamStatus).toBe(500);
		}
	});

	it("throws QuiInstanceUnreachableError on network failure", async () => {
		fetchSpy.mockRejectedValueOnce(
			Object.assign(new Error("fetch failed"), {
				cause: { code: "ECONNREFUSED" },
			}),
		);

		const client = createQuiClient(buildApp(), buildInstance());
		await expect(client.getTorrentByHash("abc")).rejects.toBeInstanceOf(
			QuiInstanceUnreachableError,
		);
	});

	it("throws QuiApiError(502) on shape drift", async () => {
		fetchSpy.mockResolvedValueOnce(
			new Response(JSON.stringify({ totally_unexpected: true }), {
				status: 200,
				headers: { "content-type": "application/json" },
			}),
		);

		const client = createQuiClient(buildApp(), buildInstance());
		try {
			await client.getTorrentByHash("abc");
			expect.fail("should have thrown");
		} catch (error) {
			expect(error).toBeInstanceOf(QuiApiError);
			expect((error as QuiApiError).statusCode).toBe(502);
		}
	});

	it("testConnection returns ok:true when health probe + auth check both pass", async () => {
		fetchSpy
			.mockResolvedValueOnce(
				new Response("{}", {
					status: 200,
					headers: { "content-type": "application/json" },
				}),
			)
			.mockResolvedValueOnce(
				new Response(JSON.stringify([]), {
					status: 200,
					headers: { "content-type": "application/json" },
				}),
			);

		const client = createQuiClient(buildApp(), buildInstance());
		const result = await client.testConnection();
		expect(result).toEqual({ ok: true });
	});

	it("testConnection returns ok:false with a reason on auth failure", async () => {
		fetchSpy
			.mockResolvedValueOnce(
				new Response("{}", {
					status: 200,
					headers: { "content-type": "application/json" },
				}),
			)
			.mockResolvedValueOnce(
				new Response(JSON.stringify({ error: "invalid api key" }), {
					status: 401,
					headers: { "content-type": "application/json" },
				}),
			);

		const client = createQuiClient(buildApp(), buildInstance());
		const result = await client.testConnection();
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.reason).toMatch(/qui request to/i);
		}
	});
});
