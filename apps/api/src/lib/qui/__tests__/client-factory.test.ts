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

const wireTorrentPage = (torrents: unknown[] | null, over: Record<string, unknown> = {}) => ({
	cross_instance_torrents: torrents,
	total: torrents?.length ?? 0,
	hasMore: false,
	partialResults: false,
	...over,
});

// qui's cross-seed local-matches wire shape (snake_case, qBit-native fields).
const wireCrossSeedMatch = (over: Record<string, unknown> = {}) => ({
	hash: "sibhash",
	name: "Sibling",
	instance_id: 2,
	instance_name: "qb2",
	state: "uploading",
	progress: 1,
	size: 100,
	category: "",
	save_path: "/x",
	content_path: "/x/Sibling",
	tracker: "https://tracker.example.com/announce",
	match_type: "release",
	tags: "",
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
			new Response(JSON.stringify(wireTorrentPage([wireTorrent()])), {
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

	it("sends stored reverse-proxy Basic Auth alongside the qui API key", async () => {
		fetchSpy.mockResolvedValueOnce(
			new Response(JSON.stringify(wireTorrentPage([wireTorrent()])), {
				status: 200,
				headers: { "content-type": "application/json" },
			}),
		);
		const app = {
			log: fakeLog,
			encryptor: {
				decrypt: ({ value }: { value: string }) =>
					value === "http-enc"
						? JSON.stringify({ v: 1, username: "proxy-user", password: "proxy-pass" })
						: "test-api-key",
			},
		} as unknown as FastifyInstance;

		const client = createQuiClient(
			app,
			buildInstance({
				encryptedHttpAuthCredentials: "http-enc",
				httpAuthEncryptionIv: "http-iv",
			}),
		);
		await client.getTorrentByHash("abc123");

		const headers = fetchSpy.mock.calls[0]?.[1]?.headers as Record<string, string>;
		expect(headers.Authorization).toBe("Basic cHJveHktdXNlcjpwcm94eS1wYXNz");
		expect(headers["X-API-Key"]).toBe("test-api-key");
	});

	it("transforms snake_case wire format into canonical camelCase", async () => {
		fetchSpy.mockResolvedValueOnce(
			new Response(
				JSON.stringify(
					wireTorrentPage([
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
					]),
				),
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
				JSON.stringify(wireTorrentPage([wireTorrent({ completion_on: 0, progress: 0.5 })])),
				{ status: 200, headers: { "content-type": "application/json" } },
			),
		);

		const client = createQuiClient(buildApp(), buildInstance());
		const result = await client.getTorrentByHash("abc123");
		expect(result?.completedOn).toBeNull();
	});

	it("returns null when cross-instance search has no exact hash match", async () => {
		fetchSpy.mockResolvedValueOnce(
			new Response(JSON.stringify(wireTorrentPage([])), {
				status: 200,
				headers: { "content-type": "application/json" },
			}),
		);

		const client = createQuiClient(buildApp(), buildInstance());
		const result = await client.getTorrentByHash("notfound");
		expect(result).toBeNull();
	});

	it("accepts metadata-free qUI responses for an ordinary exact-hash point lookup", async () => {
		fetchSpy.mockResolvedValueOnce(
			new Response(
				JSON.stringify({
					cross_instance_torrents: [wireTorrent({ hash: "ABC123", instance_id: 7 })],
				}),
				{
					status: 200,
					headers: { "content-type": "application/json" },
				},
			),
		);

		const client = createQuiClient(buildApp(), buildInstance());
		const result = await client.getTorrentByHash("abc123");

		expect(result).toMatchObject({ hash: "ABC123", instanceId: 7 });
	});

	it("filters fuzzy matches to the exact lowercased hash", async () => {
		fetchSpy.mockResolvedValueOnce(
			new Response(
				JSON.stringify(
					wireTorrentPage([
						wireTorrent({ hash: "ABC123", instance_id: 1 }),
						wireTorrent({ hash: "differenthash", instance_id: 2 }),
					]),
				),
				{ status: 200, headers: { "content-type": "application/json" } },
			),
		);

		const client = createQuiClient(buildApp(), buildInstance());
		const result = await client.getTorrentByHash("abc123");
		expect(result?.hash).toBe("ABC123");
		expect(result?.instanceId).toBe(1);
	});

	it("returns every exact-hash result across paginated qBit instances", async () => {
		fetchSpy
			.mockResolvedValueOnce(
				new Response(
					JSON.stringify(
						wireTorrentPage(
							[
								wireTorrent({ hash: "ABC123", instance_id: 1 }),
								wireTorrent({ hash: "abc123-near-match", instance_id: 9 }),
							],
							{ total: 3, hasMore: true },
						),
					),
					{ status: 200, headers: { "content-type": "application/json" } },
				),
			)
			.mockResolvedValueOnce(
				new Response(
					JSON.stringify(
						wireTorrentPage([wireTorrent({ hash: "abc123", instance_id: 2 })], {
							total: 3,
						}),
					),
					{ status: 200, headers: { "content-type": "application/json" } },
				),
			);

		const client = createQuiClient(buildApp(), buildInstance());
		const results = await client.getTorrentsByHash("abc123");

		expect(results.map((torrent) => torrent.instanceId)).toEqual([1, 2]);
		expect(fetchSpy).toHaveBeenCalledTimes(2);
		expect(new URL(fetchSpy.mock.calls[1]![0] as string).searchParams.get("page")).toBe("1");
	});

	it("fails closed when exact-hash pagination still has more results at the cap", async () => {
		fetchSpy.mockImplementation(async (input) => {
			const page = new URL(input as string).searchParams.get("page") ?? "0";
			return new Response(
				JSON.stringify(
					wireTorrentPage([wireTorrent({ hash: `abc123-${page}`, instance_id: 1 })], {
						total: 100_001,
						hasMore: true,
					}),
				),
				{ status: 200, headers: { "content-type": "application/json" } },
			);
		});

		const client = createQuiClient(buildApp(), buildInstance());
		await expect(client.getTorrentsByHash("abc123")).rejects.toThrow("exact-hash lookup exceeded");
		expect(fetchSpy).toHaveBeenCalledTimes(50);
	});

	it("fails closed when the full torrent inventory exceeds its pagination cap", async () => {
		fetchSpy.mockImplementation(async (input) => {
			const page = new URL(input as string).searchParams.get("page") ?? "0";
			return new Response(
				JSON.stringify(
					wireTorrentPage([wireTorrent({ hash: `abc123-${page}`, instance_id: 1 })], {
						total: 100_001,
						hasMore: true,
					}),
				),
				{ status: 200, headers: { "content-type": "application/json" } },
			);
		});

		const client = createQuiClient(buildApp(), buildInstance());
		await expect(client.listAllTorrents({ requireComplete: true })).rejects.toThrow(
			"torrent inventory exceeded",
		);
		expect(fetchSpy).toHaveBeenCalledTimes(50);
	});

	it.each([
		[
			"exact-hash lookup",
			(client: ReturnType<typeof createQuiClient>) => client.getTorrentsByHash("abc123"),
		],
		[
			"torrent inventory",
			(client: ReturnType<typeof createQuiClient>) =>
				client.listAllTorrents({ requireComplete: true }),
		],
	] as const)("fails closed when qUI marks the %s response partial", async (_label, invoke) => {
		fetchSpy.mockResolvedValueOnce(
			new Response(JSON.stringify(wireTorrentPage([], { partialResults: true })), {
				status: 200,
				headers: { "content-type": "application/json" },
			}),
		);

		await expect(invoke(createQuiClient(buildApp(), buildInstance()))).rejects.toThrow(
			"partial results",
		);
	});

	it.each([
		[
			"exact-hash lookup",
			(client: ReturnType<typeof createQuiClient>) => client.getTorrentsByHash("abc123"),
		],
		[
			"torrent inventory",
			(client: ReturnType<typeof createQuiClient>) =>
				client.listAllTorrents({ requireComplete: true }),
		],
	] as const)(
		"fails closed when the %s returns an empty page with hasMore",
		async (_label, invoke) => {
			fetchSpy.mockResolvedValueOnce(
				new Response(JSON.stringify(wireTorrentPage([], { total: 1, hasMore: true })), {
					status: 200,
					headers: { "content-type": "application/json" },
				}),
			);

			await expect(invoke(createQuiClient(buildApp(), buildInstance()))).rejects.toThrow(
				"empty page with more results",
			);
		},
	);

	it.each([
		[
			"exact-hash lookup",
			(client: ReturnType<typeof createQuiClient>) => client.getTorrentsByHash("abc123"),
		],
		[
			"torrent inventory",
			(client: ReturnType<typeof createQuiClient>) =>
				client.listAllTorrents({ requireComplete: true }),
		],
	] as const)("rejects missing completeness metadata for the %s", async (_label, invoke) => {
		fetchSpy.mockResolvedValueOnce(
			new Response(JSON.stringify({ cross_instance_torrents: [] }), {
				status: 200,
				headers: { "content-type": "application/json" },
			}),
		);

		await expect(invoke(createQuiClient(buildApp(), buildInstance()))).rejects.toThrow();
	});

	it.each([
		[
			"exact-hash lookup",
			(client: ReturnType<typeof createQuiClient>) => client.getTorrentsByHash("abc123"),
		],
		[
			"torrent inventory",
			(client: ReturnType<typeof createQuiClient>) =>
				client.listAllTorrents({ requireComplete: true }),
		],
	] as const)("rejects an early total for the %s", async (_label, invoke) => {
		fetchSpy.mockResolvedValueOnce(
			new Response(JSON.stringify(wireTorrentPage([wireTorrent()], { total: 2 })), {
				status: 200,
				headers: { "content-type": "application/json" },
			}),
		);

		await expect(invoke(createQuiClient(buildApp(), buildInstance()))).rejects.toThrow(
			"ended before its declared total",
		);
	});

	it.each([
		[
			"exact-hash lookup",
			(client: ReturnType<typeof createQuiClient>) => client.getTorrentsByHash("abc123"),
		],
		[
			"torrent inventory",
			(client: ReturnType<typeof createQuiClient>) =>
				client.listAllTorrents({ requireComplete: true }),
		],
	] as const)("rejects changing totals while paginating the %s", async (_label, invoke) => {
		fetchSpy
			.mockResolvedValueOnce(
				new Response(
					JSON.stringify(wireTorrentPage([wireTorrent()], { total: 2, hasMore: true })),
					{ status: 200, headers: { "content-type": "application/json" } },
				),
			)
			.mockResolvedValueOnce(
				new Response(JSON.stringify(wireTorrentPage([wireTorrent()], { total: 3 })), {
					status: 200,
					headers: { "content-type": "application/json" },
				}),
			);

		await expect(invoke(createQuiClient(buildApp(), buildInstance()))).rejects.toThrow(
			"total changed during pagination",
		);
	});

	it.each([
		[
			"exact-hash lookup",
			(client: ReturnType<typeof createQuiClient>) => client.getTorrentsByHash("abc123"),
		],
		[
			"torrent inventory",
			(client: ReturnType<typeof createQuiClient>) =>
				client.listAllTorrents({ requireComplete: true }),
		],
	] as const)("rejects duplicate torrents across pages for the %s", async (_label, invoke) => {
		fetchSpy
			.mockResolvedValueOnce(
				new Response(
					JSON.stringify(wireTorrentPage([wireTorrent()], { total: 2, hasMore: true })),
					{ status: 200, headers: { "content-type": "application/json" } },
				),
			)
			.mockResolvedValueOnce(
				new Response(JSON.stringify(wireTorrentPage([wireTorrent()], { total: 2 })), {
					status: 200,
					headers: { "content-type": "application/json" },
				}),
			);

		await expect(invoke(createQuiClient(buildApp(), buildInstance()))).rejects.toThrow(
			"duplicate torrent across pages",
		);
	});

	it("accepts metadata-free torrent inventories for non-destructive consumers", async () => {
		fetchSpy.mockResolvedValueOnce(
			new Response(
				JSON.stringify({
					cross_instance_torrents: [wireTorrent({ hash: "legacy", instance_id: 2 })],
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			),
		);

		const client = createQuiClient(buildApp(), buildInstance());
		const torrents = await client.listAllTorrents();

		expect(torrents).toHaveLength(1);
		expect(torrents[0]).toMatchObject({ hash: "legacy", instanceId: 2 });
		expect(fetchSpy).toHaveBeenCalledTimes(1);
	});

	it("reports whether the read-only torrent inventory proves completeness", async () => {
		fetchSpy
			.mockResolvedValueOnce(
				new Response(
					JSON.stringify({
						cross_instance_torrents: [wireTorrent({ hash: "legacy", instance_id: 2 })],
					}),
					{ status: 200, headers: { "content-type": "application/json" } },
				),
			)
			.mockResolvedValueOnce(
				new Response(
					JSON.stringify(wireTorrentPage([wireTorrent({ hash: "current", instance_id: 3 })])),
					{ status: 200, headers: { "content-type": "application/json" } },
				),
			);

		const client = createQuiClient(buildApp(), buildInstance());

		await expect(client.listTorrentInventory()).resolves.toMatchObject({
			complete: false,
			torrents: [expect.objectContaining({ hash: "legacy", instanceId: 2 })],
		});
		await expect(client.listTorrentInventory()).resolves.toMatchObject({
			complete: true,
			torrents: [expect.objectContaining({ hash: "current", instanceId: 3 })],
		});
	});

	it("handles cross_instance_torrents:null gracefully", async () => {
		fetchSpy.mockResolvedValueOnce(
			new Response(JSON.stringify(wireTorrentPage(null)), {
				status: 200,
				headers: { "content-type": "application/json" },
			}),
		);

		const client = createQuiClient(buildApp(), buildInstance());
		const result = await client.getTorrentByHash("abc123");
		expect(result).toBeNull();
	});

	// ── qUI v1.26.0 compatibility boundary (#770) ─────────────────────
	// qUI v1.26.0's TorrentResponse.CrossInstanceTorrents carries
	// `json:"cross_instance_torrents,omitempty"` (sync_manager.go:234). Go's
	// omitempty drops the field entirely when the slice is empty, so a
	// complete empty inventory is serialized WITHOUT the key — not as `[]`
	// and not as `null`. Completeness is still proven by the always-present
	// `total`/`hasMore`/`partialResults` fields (none carry omitempty).

	it("accepts a complete empty inventory where qUI v1.26.0 omits cross_instance_torrents (#770)", async () => {
		// Exact v1.26.0 wire shape for a complete zero-torrent inventory:
		// cross_instance_torrents is absent, but total/hasMore/partialResults
		// are present and prove completeness.
		fetchSpy.mockResolvedValueOnce(
			new Response(
				JSON.stringify({
					total: 0,
					hasMore: false,
					partialResults: false,
					isCrossInstance: true,
					trackerHealthSupported: false,
					useSubcategories: false,
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			),
		);

		const client = createQuiClient(buildApp(), buildInstance());
		const inventory = await client.listTorrentInventory();

		expect(inventory.complete).toBe(true);
		expect(inventory.torrents).toEqual([]);
	});

	it("accepts a complete empty inventory via requireComplete listAllTorrents (#770)", async () => {
		fetchSpy.mockResolvedValueOnce(
			new Response(
				JSON.stringify({
					total: 0,
					hasMore: false,
					partialResults: false,
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			),
		);

		const client = createQuiClient(buildApp(), buildInstance());
		const torrents = await client.listAllTorrents({ requireComplete: true });

		expect(torrents).toEqual([]);
	});

	it("accepts a complete empty inventory for exact-hash lookup (#770)", async () => {
		fetchSpy.mockResolvedValueOnce(
			new Response(
				JSON.stringify({
					total: 0,
					hasMore: false,
					partialResults: false,
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			),
		);

		const client = createQuiClient(buildApp(), buildInstance());
		const results = await client.getTorrentsByHash("abc123");

		expect(results).toEqual([]);
	});

	it("tolerates additive unknown fields alongside a known complete inventory (#770)", async () => {
		fetchSpy.mockResolvedValueOnce(
			new Response(
				JSON.stringify({
					total: 0,
					hasMore: false,
					partialResults: false,
					someFutureField: { nested: true },
					anotherFutureField: "hello",
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			),
		);

		const client = createQuiClient(buildApp(), buildInstance());
		const inventory = await client.listTorrentInventory();

		expect(inventory.complete).toBe(true);
		expect(inventory.torrents).toEqual([]);
	});

	it("rejects an unknown wrapper that lacks completeness metadata (#770)", async () => {
		// A torrent-looking payload under an unverified semantic shape must
		// not be guessed into an authoritative empty inventory.
		fetchSpy.mockResolvedValueOnce(
			new Response(JSON.stringify({ torrents: [] }), {
				status: 200,
				headers: { "content-type": "application/json" },
			}),
		);

		const client = createQuiClient(buildApp(), buildInstance());
		await expect(client.listAllTorrents({ requireComplete: true })).rejects.toThrow();
	});

	it("does not treat a missing cross_instance_torrents with partialResults as empty (#770)", async () => {
		// partialResults=true means some instances failed; absence is NOT
		// authoritative even though the collection key is missing.
		fetchSpy.mockResolvedValueOnce(
			new Response(
				JSON.stringify({
					total: 0,
					hasMore: false,
					partialResults: true,
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			),
		);

		const client = createQuiClient(buildApp(), buildInstance());
		await expect(client.listAllTorrents({ requireComplete: true })).rejects.toThrow(
			"partial results",
		);
	});

	// ── Metadata-consistency safety matrix (#770) ─────────────────────
	// The normalization rule is NOT "missing cross_instance_torrents => []".
	// It is: known qUI semantic response AND omitted collection AND metadata
	// proves zero results => []. Any contradiction fails closed.

	it("rejects a non-empty total with an omitted collection (CASE B)", async () => {
		// total=5 claims torrents exist but no collection is supplied.
		fetchSpy.mockResolvedValueOnce(
			new Response(JSON.stringify({ total: 5, hasMore: false, partialResults: false }), {
				status: 200,
				headers: { "content-type": "application/json" },
			}),
		);

		const client = createQuiClient(buildApp(), buildInstance());
		await expect(client.listAllTorrents({ requireComplete: true })).rejects.toThrow(
			"ended before its declared total",
		);
	});

	it("rejects an omitted collection while more pages supposedly exist (CASE C)", async () => {
		fetchSpy.mockResolvedValueOnce(
			new Response(JSON.stringify({ total: 5, hasMore: true, partialResults: false }), {
				status: 200,
				headers: { "content-type": "application/json" },
			}),
		);

		const client = createQuiClient(buildApp(), buildInstance());
		await expect(client.listAllTorrents({ requireComplete: true })).rejects.toThrow(
			"empty page with more results",
		);
	});

	it("fails closed for requireComplete when partialResults metadata is missing (CASE E)", async () => {
		// Missing partialResults means completeness cannot be proven; the
		// strict requireComplete schema rejects it outright.
		fetchSpy.mockResolvedValueOnce(
			new Response(JSON.stringify({ total: 0, hasMore: false }), {
				status: 200,
				headers: { "content-type": "application/json" },
			}),
		);

		const client = createQuiClient(buildApp(), buildInstance());
		await expect(client.listAllTorrents({ requireComplete: true })).rejects.toThrow();
	});

	it("reports incomplete (not authoritative) for read-only inventory missing partialResults (CASE E)", async () => {
		// The non-requireComplete path tolerates the missing metadata but
		// must NOT claim completeness, so absence is not authoritative.
		fetchSpy.mockResolvedValueOnce(
			new Response(JSON.stringify({ total: 0, hasMore: false }), {
				status: 200,
				headers: { "content-type": "application/json" },
			}),
		);

		const client = createQuiClient(buildApp(), buildInstance());
		const inventory = await client.listTorrentInventory();

		expect(inventory.complete).toBe(false);
		expect(inventory.torrents).toEqual([]);
	});

	it("rejects a returned count greater than total with an omitted collection (CASE F)", async () => {
		// total=0 but a collection is supplied — impossible, must fail closed.
		fetchSpy.mockResolvedValueOnce(
			new Response(
				JSON.stringify({
					total: 0,
					hasMore: false,
					partialResults: false,
					cross_instance_torrents: [wireTorrent({ hash: "abc123", instance_id: 1 })],
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			),
		);

		const client = createQuiClient(buildApp(), buildInstance());
		await expect(client.listAllTorrents({ requireComplete: true })).rejects.toThrow(
			"more rows than its total",
		);
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

	it("getCrossSeedMatches strips tracker passkeys down to the hostname", async () => {
		fetchSpy.mockResolvedValueOnce(
			new Response(
				JSON.stringify({
					matches: [
						// passkey in the path
						wireCrossSeedMatch({
							hash: "sib1",
							tracker: "https://tracker.beyond-hd.me:2053/announce/SECRETPASSKEY123",
						}),
						// passkey in the query string
						wireCrossSeedMatch({
							hash: "sib2",
							tracker: "https://hdbits.org/announce.php?passkey=SECRETPASSKEY456",
						}),
					],
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			),
		);

		const client = createQuiClient(buildApp(), buildInstance());
		const matches = await client.getCrossSeedMatches(1, "abc123");

		expect(matches.map((m) => m.tracker)).toEqual(["tracker.beyond-hd.me", "hdbits.org"]);
		// Defense-in-depth: the secret must not survive anywhere in the payload.
		expect(JSON.stringify(matches)).not.toContain("SECRETPASSKEY");
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

	/**
	 * URL-pin tests for triggerDirScan. The previous bug shipped to
	 * production used `/api/dirscan/webhook` (no hyphen, no trailing /scan)
	 * which qui's HTTP router rejected with a generic 404, masking the
	 * issue as "qui dir-scan not configured." The actual route on qui is
	 *   r.Route("/dir-scan/webhook", ...).Post("/scan", ...)
	 *   → /api/dir-scan/webhook/scan
	 * Easy to misremember — these tests pin BOTH the URL and the
	 * request shape so a future refactor can't reintroduce the typo.
	 */
	describe("triggerDirScan URL contract", () => {
		it("POSTs to qui's `/api/dir-scan/webhook/scan` with {path} body", async () => {
			fetchSpy.mockResolvedValueOnce(
				new Response(
					JSON.stringify({
						runId: 42,
						directoryId: 7,
						directoryPath: "/data/media/movies",
						scanRoot: "/data/media/movies/Foo",
					}),
					{ status: 202, headers: { "content-type": "application/json" } },
				),
			);

			const client = createQuiClient(buildApp(), buildInstance());
			const result = await client.triggerDirScan("/data/media/movies/Foo");

			expect(result.runId).toBe(42);
			expect(result.directoryId).toBe(7);
			expect(result.scanRoot).toBe("/data/media/movies/Foo");

			// Pin BOTH the URL and the body shape.
			const [url, init] = fetchSpy.mock.calls[0]!;
			expect(String(url)).toBe("http://qui.test/api/dir-scan/webhook/scan");
			expect(init?.method).toBe("POST");
			expect(JSON.parse(String(init?.body))).toEqual({
				path: "/data/media/movies/Foo",
			});
		});

		it("relays qui's 404 with the original message (no configured dir-scan)", async () => {
			// qui returns 404 when no configured dir-scan directory has a
			// path prefix covering the requested path. quiRequest wraps this
			// as QuiApiError with statusCode preserved. The route layer
			// keys off statusCode to decide whether to surface "configure
			// dir-scan in qui's UI" guidance to the user.
			fetchSpy.mockResolvedValueOnce(
				new Response(JSON.stringify({ error: "No matching directory found for the given path" }), {
					status: 404,
					headers: { "content-type": "application/json" },
				}),
			);

			const client = createQuiClient(buildApp(), buildInstance());
			await expect(client.triggerDirScan("/elsewhere")).rejects.toMatchObject({
				name: "QuiApiError",
				statusCode: 404,
			});
		});
	});

	describe("ensureNotificationTarget", () => {
		const target = {
			id: 42,
			name: "arr-dashboard",
			url: "generic://dashboard.example/api/webhooks/qui?template=json&secret=current",
			enabled: true,
			eventTypes: ["torrent_added"],
		};

		it("creates the target when qUI's empty list is encoded as null", async () => {
			fetchSpy
				.mockResolvedValueOnce(
					new Response("null", {
						status: 200,
						headers: { "content-type": "application/json" },
					}),
				)
				.mockResolvedValueOnce(
					new Response(JSON.stringify(target), {
						status: 201,
						headers: { "content-type": "application/json" },
					}),
				)
				.mockResolvedValueOnce(
					new Response(JSON.stringify([target]), {
						status: 200,
						headers: { "content-type": "application/json" },
					}),
				);

			const client = createQuiClient(buildApp(), buildInstance());
			await expect(
				client.ensureNotificationTarget({
					name: target.name,
					url: target.url,
					eventTypes: target.eventTypes,
				}),
			).resolves.toEqual({ id: 42 });
			expect(fetchSpy.mock.calls[1]?.[1]?.method).toBe("POST");
		});

		it("leaves targets owned by another dashboard instance untouched", async () => {
			const legacyTarget = {
				...target,
				id: 7,
				name: "arr-dashboard",
				url: "generic://other-dashboard.example/api/webhooks/qui?template=json&secret=other",
			};
			const ownedTarget = { ...target, name: "arr-dashboard-qui-1" };
			fetchSpy
				.mockResolvedValueOnce(
					new Response(JSON.stringify([legacyTarget]), {
						status: 200,
						headers: { "content-type": "application/json" },
					}),
				)
				.mockResolvedValueOnce(
					new Response(JSON.stringify(ownedTarget), {
						status: 201,
						headers: { "content-type": "application/json" },
					}),
				)
				.mockResolvedValueOnce(
					new Response(JSON.stringify([legacyTarget, ownedTarget]), {
						status: 200,
						headers: { "content-type": "application/json" },
					}),
				);

			const client = createQuiClient(buildApp(), buildInstance());
			await expect(
				client.ensureNotificationTarget({
					name: ownedTarget.name,
					url: ownedTarget.url,
					eventTypes: ownedTarget.eventTypes,
				}),
			).resolves.toEqual({ id: 42 });

			expect(fetchSpy).toHaveBeenCalledTimes(3);
			expect(fetchSpy.mock.calls[1]?.[1]?.method).toBe("POST");
			expect(JSON.parse(String(fetchSpy.mock.calls[1]?.[1]?.body))).toMatchObject({
				name: ownedTarget.name,
			});
			expect(fetchSpy.mock.calls.some(([, init]) => init?.method === "PUT")).toBe(false);
		});

		it("reports manual cleanup when an old-secret legacy target cannot prove ownership", async () => {
			const legacyTarget = {
				...target,
				url: "generic://dashboard.example/api/webhooks/qui?template=json&secret=old",
			};
			const desiredTarget = {
				...legacyTarget,
				id: 99,
				name: "arr-dashboard-installation-deployment",
				url: "generic://dashboard.example/api/webhooks/qui?template=json&secret=new&instanceId=qui-1&deploymentId=deployment-1&owner=owner-1",
			};
			fetchSpy
				.mockResolvedValueOnce(
					new Response(JSON.stringify([legacyTarget]), {
						status: 200,
						headers: { "content-type": "application/json" },
					}),
				)
				.mockResolvedValueOnce(
					new Response(JSON.stringify(desiredTarget), {
						status: 201,
						headers: { "content-type": "application/json" },
					}),
				)
				.mockResolvedValueOnce(
					new Response(JSON.stringify([legacyTarget, desiredTarget]), {
						status: 200,
						headers: { "content-type": "application/json" },
					}),
				);

			const client = createQuiClient(buildApp(), buildInstance());
			await expect(
				client.ensureNotificationTarget({
					name: desiredTarget.name,
					url: desiredTarget.url,
					ownerId: "owner-1",
					legacyTargetAdoption: "secret",
					reportLegacyCleanupRequired: true,
					eventTypes: desiredTarget.eventTypes,
				}),
			).resolves.toEqual({ id: 99, legacyCleanupRequired: true });

			expect(fetchSpy).toHaveBeenCalledTimes(3);
			expect(fetchSpy.mock.calls[1]?.[1]?.method).toBe("POST");
			expect(fetchSpy.mock.calls.some(([, init]) => init?.method === "PUT")).toBe(false);
		});

		it("upgrades an exact-secret legacy target when shared deployment adoption requires it", async () => {
			const legacyTarget = {
				...target,
				url: "generic://dashboard.example/api/webhooks/qui?template=json&secret=current",
			};
			const desiredTarget = {
				...legacyTarget,
				name: "arr-dashboard-installation-deployment",
				url: "generic://dashboard.example/api/webhooks/qui?template=json&secret=current&instanceId=qui-1&deploymentId=deployment-1&owner=owner-1",
			};
			fetchSpy
				.mockResolvedValueOnce(
					new Response(JSON.stringify([legacyTarget]), {
						status: 200,
						headers: { "content-type": "application/json" },
					}),
				)
				.mockResolvedValueOnce(
					new Response(JSON.stringify(desiredTarget), {
						status: 200,
						headers: { "content-type": "application/json" },
					}),
				);

			const client = createQuiClient(buildApp(), buildInstance());
			await expect(
				client.ensureNotificationTarget({
					name: desiredTarget.name,
					url: desiredTarget.url,
					ownerId: "owner-1",
					legacyTargetAdoption: "secret",
					eventTypes: desiredTarget.eventTypes,
				}),
			).resolves.toEqual({ id: 42 });

			expect(fetchSpy).toHaveBeenCalledTimes(2);
			expect(fetchSpy.mock.calls[1]?.[1]?.method).toBe("PUT");
		});

		it("leaves ambiguous legacy targets at a shared callback untouched", async () => {
			const otherUserLegacyTarget = {
				...target,
				id: 7,
				url: "generic://dashboard.example/api/webhooks/qui?template=json&secret=other-user",
			};
			const desiredTarget = {
				...target,
				name: "arr-dashboard-installation-deployment",
				url: "generic://dashboard.example/api/webhooks/qui?template=json&secret=current&instanceId=qui-1&deploymentId=deployment-1&owner=owner-1",
			};
			fetchSpy
				.mockResolvedValueOnce(
					new Response(JSON.stringify([otherUserLegacyTarget]), {
						status: 200,
						headers: { "content-type": "application/json" },
					}),
				)
				.mockResolvedValueOnce(
					new Response(JSON.stringify(desiredTarget), {
						status: 201,
						headers: { "content-type": "application/json" },
					}),
				)
				.mockResolvedValueOnce(
					new Response(JSON.stringify([otherUserLegacyTarget, desiredTarget]), {
						status: 200,
						headers: { "content-type": "application/json" },
					}),
				);

			const client = createQuiClient(buildApp(), buildInstance());
			await expect(
				client.ensureNotificationTarget({
					name: desiredTarget.name,
					url: desiredTarget.url,
					ownerId: "owner-1",
					legacyTargetAdoption: "secret",
					eventTypes: desiredTarget.eventTypes,
				}),
			).resolves.toEqual({ id: 42 });

			expect(fetchSpy).toHaveBeenCalledTimes(3);
			expect(fetchSpy.mock.calls[1]?.[1]?.method).toBe("POST");
			expect(fetchSpy.mock.calls.some(([, init]) => init?.method === "PUT")).toBe(false);
		});

		it("leaves same-secret legacy targets untouched when adoption is denied", async () => {
			const ambiguousLegacyTarget = {
				...target,
				id: 7,
				url: "generic://dashboard.example/api/webhooks/qui?template=json&secret=current",
			};
			const desiredTarget = {
				...target,
				name: "arr-dashboard-installation-deployment",
				url: "generic://dashboard.example/api/webhooks/qui?template=json&secret=current&instanceId=qui-2&deploymentId=deployment-1&owner=owner-2",
			};
			fetchSpy
				.mockResolvedValueOnce(
					new Response(JSON.stringify([ambiguousLegacyTarget]), {
						status: 200,
						headers: { "content-type": "application/json" },
					}),
				)
				.mockResolvedValueOnce(
					new Response(JSON.stringify(desiredTarget), {
						status: 201,
						headers: { "content-type": "application/json" },
					}),
				)
				.mockResolvedValueOnce(
					new Response(JSON.stringify([ambiguousLegacyTarget, desiredTarget]), {
						status: 200,
						headers: { "content-type": "application/json" },
					}),
				);

			const client = createQuiClient(buildApp(), buildInstance());
			await expect(
				client.ensureNotificationTarget({
					name: desiredTarget.name,
					url: desiredTarget.url,
					ownerId: "owner-2",
					legacyTargetAdoption: "never",
					eventTypes: desiredTarget.eventTypes,
				}),
			).resolves.toEqual({ id: 42 });

			expect(fetchSpy).toHaveBeenCalledTimes(3);
			expect(fetchSpy.mock.calls[1]?.[1]?.method).toBe("POST");
			expect(fetchSpy.mock.calls.some(([, init]) => init?.method === "PUT")).toBe(false);
		});

		it("updates an existing target instead of creating a duplicate", async () => {
			fetchSpy
				.mockResolvedValueOnce(
					new Response(JSON.stringify([target]), {
						status: 200,
						headers: { "content-type": "application/json" },
					}),
				)
				.mockResolvedValueOnce(
					new Response(JSON.stringify({ ...target, url: "generic://dashboard.test/hook" }), {
						status: 200,
						headers: { "content-type": "application/json" },
					}),
				);

			const client = createQuiClient(buildApp(), buildInstance());
			const result = await client.ensureNotificationTarget({
				name: "arr-dashboard",
				url: "generic://dashboard.test/hook",
				eventTypes: ["torrent_added"],
			});

			expect(result).toEqual({ id: 42 });
			expect(fetchSpy).toHaveBeenCalledTimes(2);
			expect(String(fetchSpy.mock.calls[1]?.[0])).toBe(
				"http://qui.test/api/notifications/targets/42",
			);
			expect(fetchSpy.mock.calls[1]?.[1]?.method).toBe("PUT");
		});

		it("renames an owned target after the qUI base URL changes instead of creating a duplicate", async () => {
			const previousTarget = {
				...target,
				name: "arr-dashboard-previous-deployment",
				url: `${target.url}&owner=owner-1&instanceId=qui-1`,
			};
			const desiredTarget = {
				...previousTarget,
				name: "arr-dashboard-current-deployment",
			};
			fetchSpy
				.mockResolvedValueOnce(
					new Response(JSON.stringify([previousTarget]), {
						status: 200,
						headers: { "content-type": "application/json" },
					}),
				)
				.mockResolvedValueOnce(
					new Response(JSON.stringify(desiredTarget), {
						status: 200,
						headers: { "content-type": "application/json" },
					}),
				);

			const client = createQuiClient(buildApp(), buildInstance());
			await expect(
				client.ensureNotificationTarget({
					name: desiredTarget.name,
					url: desiredTarget.url,
					ownerId: "owner-1",
					eventTypes: desiredTarget.eventTypes,
				}),
			).resolves.toEqual({ id: 42 });

			expect(fetchSpy).toHaveBeenCalledTimes(2);
			expect(String(fetchSpy.mock.calls[1]?.[0])).toBe(
				"http://qui.test/api/notifications/targets/42",
			);
			expect(fetchSpy.mock.calls[1]?.[1]?.method).toBe("PUT");
			expect(JSON.parse(String(fetchSpy.mock.calls[1]?.[1]?.body))).toMatchObject({
				name: desiredTarget.name,
			});
		});

		it("expands an empty requested event list and resets an existing subset", async () => {
			const allEventTypes = ["torrent_added", "torrent_completed"];
			fetchSpy
				.mockResolvedValueOnce(
					new Response(
						JSON.stringify(allEventTypes.map((type) => ({ type, label: type, description: type }))),
						{
							status: 200,
							headers: { "content-type": "application/json" },
						},
					),
				)
				.mockResolvedValueOnce(
					new Response(JSON.stringify([target]), {
						status: 200,
						headers: { "content-type": "application/json" },
					}),
				)
				.mockResolvedValueOnce(
					new Response(JSON.stringify({ ...target, eventTypes: allEventTypes }), {
						status: 200,
						headers: { "content-type": "application/json" },
					}),
				);

			const client = createQuiClient(buildApp(), buildInstance());
			await expect(
				client.ensureNotificationTarget({
					name: target.name,
					url: target.url,
					eventTypes: [],
				}),
			).resolves.toEqual({ id: 42 });
			expect(fetchSpy).toHaveBeenCalledTimes(3);
			expect(String(fetchSpy.mock.calls[0]?.[0])).toBe("http://qui.test/api/notifications/events");
			expect(JSON.parse(String(fetchSpy.mock.calls[2]?.[1]?.body))).toMatchObject({
				eventTypes: allEventTypes,
			});
		});

		it("accepts a committed update when qUI loses the PUT response", async () => {
			const desiredUrl = "generic://dashboard.test/hook";
			fetchSpy
				.mockResolvedValueOnce(
					new Response(JSON.stringify([target]), {
						status: 200,
						headers: { "content-type": "application/json" },
					}),
				)
				.mockResolvedValueOnce(
					new Response(JSON.stringify({ error: "upstream response lost" }), {
						status: 502,
						headers: { "content-type": "application/json" },
					}),
				)
				.mockResolvedValueOnce(
					new Response(JSON.stringify([{ ...target, url: desiredUrl }]), {
						status: 200,
						headers: { "content-type": "application/json" },
					}),
				);

			const client = createQuiClient(buildApp(), buildInstance());
			await expect(
				client.ensureNotificationTarget({
					name: target.name,
					url: desiredUrl,
					eventTypes: target.eventTypes,
				}),
			).resolves.toEqual({ id: 42 });
			expect(fetchSpy).toHaveBeenCalledTimes(3);
		});

		it("keeps one canonical target and disables enabled duplicates", async () => {
			const duplicate = { ...target, id: 99, url: "generic://dashboard.example/stale" };
			fetchSpy
				.mockResolvedValueOnce(
					new Response(JSON.stringify([target, duplicate]), {
						status: 200,
						headers: { "content-type": "application/json" },
					}),
				)
				.mockResolvedValueOnce(
					new Response(JSON.stringify({ ...duplicate, enabled: false }), {
						status: 200,
						headers: { "content-type": "application/json" },
					}),
				);

			const client = createQuiClient(buildApp(), buildInstance());
			const result = await client.ensureNotificationTarget({
				name: target.name,
				url: target.url,
				eventTypes: target.eventTypes,
			});

			expect(result).toEqual({ id: 42 });
			expect(String(fetchSpy.mock.calls[1]?.[0])).toBe(
				"http://qui.test/api/notifications/targets/99",
			);
			expect(JSON.parse(String(fetchSpy.mock.calls[1]?.[1]?.body))).toMatchObject({
				url: duplicate.url,
				enabled: false,
			});
		});

		it("prefers an already-valid newer target during an initial retry", async () => {
			const stale = { ...target, url: "generic://dashboard.example/stale" };
			const valid = { ...target, id: 99 };
			fetchSpy
				.mockResolvedValueOnce(
					new Response(JSON.stringify([stale, valid]), {
						status: 200,
						headers: { "content-type": "application/json" },
					}),
				)
				.mockResolvedValueOnce(
					new Response(JSON.stringify({ ...stale, enabled: false }), {
						status: 200,
						headers: { "content-type": "application/json" },
					}),
				);

			const client = createQuiClient(buildApp(), buildInstance());
			await expect(
				client.ensureNotificationTarget({
					name: target.name,
					url: target.url,
					eventTypes: target.eventTypes,
				}),
			).resolves.toEqual({ id: 99 });
			expect(String(fetchSpy.mock.calls[1]?.[0])).toBe(
				"http://qui.test/api/notifications/targets/42",
			);
			expect(JSON.parse(String(fetchSpy.mock.calls[1]?.[1]?.body))).toMatchObject({
				enabled: false,
			});
		});

		it("recovers a valid newer target after a lost POST response", async () => {
			const stale = { ...target, url: "generic://dashboard.example/stale" };
			const valid = { ...target, id: 99 };
			fetchSpy
				.mockResolvedValueOnce(
					new Response(JSON.stringify([]), {
						status: 200,
						headers: { "content-type": "application/json" },
					}),
				)
				.mockResolvedValueOnce(
					new Response(JSON.stringify({ error: "upstream response lost" }), {
						status: 502,
						headers: { "content-type": "application/json" },
					}),
				)
				.mockResolvedValueOnce(
					new Response(JSON.stringify([stale, valid]), {
						status: 200,
						headers: { "content-type": "application/json" },
					}),
				)
				.mockResolvedValueOnce(
					new Response(JSON.stringify({ ...stale, enabled: false }), {
						status: 200,
						headers: { "content-type": "application/json" },
					}),
				);

			const client = createQuiClient(buildApp(), buildInstance());
			await expect(
				client.ensureNotificationTarget({
					name: target.name,
					url: target.url,
					eventTypes: target.eventTypes,
				}),
			).resolves.toEqual({ id: 99 });
			expect(fetchSpy).toHaveBeenCalledTimes(4);
		});

		it("preserves a successful POST when stale-target cleanup cannot finish", async () => {
			const stale = { ...target, url: "generic://dashboard.example/stale" };
			const valid = { ...target, id: 99 };
			fetchSpy
				.mockResolvedValueOnce(
					new Response(JSON.stringify([]), {
						status: 200,
						headers: { "content-type": "application/json" },
					}),
				)
				.mockResolvedValueOnce(
					new Response(JSON.stringify(valid), {
						status: 201,
						headers: { "content-type": "application/json" },
					}),
				)
				.mockResolvedValueOnce(
					new Response(JSON.stringify([stale, valid]), {
						status: 200,
						headers: { "content-type": "application/json" },
					}),
				)
				.mockResolvedValueOnce(
					new Response(JSON.stringify({ error: "cleanup failed" }), {
						status: 500,
						headers: { "content-type": "application/json" },
					}),
				)
				.mockResolvedValueOnce(
					new Response(JSON.stringify([stale, valid]), {
						status: 200,
						headers: { "content-type": "application/json" },
					}),
				);

			const client = createQuiClient(buildApp(), buildInstance());
			await expect(
				client.ensureNotificationTarget({
					name: target.name,
					url: target.url,
					eventTypes: target.eventTypes,
				}),
			).resolves.toEqual({ id: 99, cleanupPending: true });
			expect(fetchSpy).toHaveBeenCalledTimes(5);
		});

		it("reports canonical success when duplicate cleanup remains pending", async () => {
			const duplicate = { ...target, id: 99, url: "generic://dashboard.example/stale" };
			fetchSpy
				.mockResolvedValueOnce(
					new Response(JSON.stringify([target, duplicate]), {
						status: 200,
						headers: { "content-type": "application/json" },
					}),
				)
				.mockResolvedValueOnce(
					new Response(JSON.stringify({ error: "cleanup failed" }), {
						status: 500,
						headers: { "content-type": "application/json" },
					}),
				)
				.mockResolvedValueOnce(
					new Response(JSON.stringify([target, duplicate]), {
						status: 200,
						headers: { "content-type": "application/json" },
					}),
				);

			const client = createQuiClient(buildApp(), buildInstance());
			await expect(
				client.ensureNotificationTarget({
					name: target.name,
					url: target.url,
					eventTypes: target.eventTypes,
				}),
			).resolves.toEqual({ id: 42, cleanupPending: true });
			expect(vi.mocked(fakeLog.warn)).toHaveBeenCalledWith(
				{ targetId: 99 },
				expect.stringMatching(/cleanup remains pending/i),
			);
		});

		it("recovers a target created when the POST response is lost", async () => {
			fetchSpy
				.mockResolvedValueOnce(
					new Response(JSON.stringify([]), {
						status: 200,
						headers: { "content-type": "application/json" },
					}),
				)
				.mockResolvedValueOnce(
					new Response(JSON.stringify({ error: "upstream response lost" }), {
						status: 502,
						headers: { "content-type": "application/json" },
					}),
				)
				.mockResolvedValueOnce(
					new Response(JSON.stringify([target]), {
						status: 200,
						headers: { "content-type": "application/json" },
					}),
				);

			const client = createQuiClient(buildApp(), buildInstance());
			await expect(
				client.ensureNotificationTarget({
					name: target.name,
					url: target.url,
					eventTypes: target.eventTypes,
				}),
			).resolves.toEqual({ id: 42 });
			expect(fetchSpy).toHaveBeenCalledTimes(3);
		});

		it("scrubs the callback secret before the shared request helper logs or throws", async () => {
			const secret = "plaintext-webhook-secret";
			const targetUrl = `generic://dashboard.example/api/webhooks/qui?template=json&secret=${secret}`;
			fetchSpy
				.mockResolvedValueOnce(
					new Response(JSON.stringify([]), {
						status: 200,
						headers: { "content-type": "application/json" },
					}),
				)
				.mockResolvedValueOnce(
					new Response(JSON.stringify({ error: `invalid notification url: ${targetUrl}` }), {
						status: 400,
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
			const rejection = client.ensureNotificationTarget({
				name: "arr-dashboard",
				url: targetUrl,
			});

			await expect(rejection).rejects.toThrow("secret=***");
			await expect(rejection).rejects.not.toThrow(secret);
			expect(JSON.stringify(vi.mocked(fakeLog.warn).mock.calls)).toContain("secret=***");
			expect(JSON.stringify(vi.mocked(fakeLog.warn).mock.calls)).not.toContain(secret);
		});
	});
});
