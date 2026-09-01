import Fastify from "fastify";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Encryptor } from "../../lib/auth/encryption.js";
import { historyRoutes } from "./history-routes.js";

vi.mock("../../lib/arr/client-helpers.js", () => ({
	isSonarrClient: (client: { kind?: string }) => client.kind === "sonarr",
	isRadarrClient: (client: { kind?: string }) => client.kind === "radarr",
	isProwlarrClient: (client: { kind?: string }) => client.kind === "prowlarr",
	isLidarrClient: (client: { kind?: string }) => client.kind === "lidarr",
	isReadarrClient: (client: { kind?: string }) => client.kind === "readarr",
}));

const userId = "history-user";
const encryptionKey = "0123456789abcdef0123456789abcdef";

const instance = (id: string, service = "SONARR") => ({
	id,
	userId,
	service,
	label: id,
	baseUrl: `http://${id}.example.test`,
	encryptedApiKey: "encrypted",
	encryptionIv: "iv",
	encryptedHttpAuthCredentials: null,
	httpAuthEncryptionIv: null,
	isDefault: false,
	enabled: true,
	storageGroupId: null,
	hasLocalFilesystemAccess: false,
	pathPrefix: null,
	connectionGeneration: 0,
	expectedIdentity: null,
	identityKind: null,
	identityStatus: "UNVERIFIED",
	identityGeneration: 0,
	identityVerifiedAt: null,
	identityLastCheckedAt: null,
	createdAt: new Date("2026-08-31T00:00:00.000Z"),
	updatedAt: new Date("2026-08-31T00:00:00.000Z"),
});

const records = (prefix: string) => [
	{ id: `${prefix}-1`, date: "2026-08-31T12:00:00.000Z", eventType: "grabbed" },
	{ id: `${prefix}-2`, date: "2026-08-31T10:00:00.000Z", eventType: "imported" },
];

const createClient = (items: unknown[], kind = "sonarr") => ({
	kind,
	history: {
		get: vi.fn(async ({ page, pageSize }: { page: number; pageSize: number }) => ({
			records: items.slice((page - 1) * pageSize, page * pageSize),
			totalRecords: items.length,
		})),
	},
});

async function buildApp({
	instances,
	clients,
	currentUserId = userId,
	cursorRows = new Map(),
}: {
	instances: ReturnType<typeof instance>[];
	clients: Map<string, ReturnType<typeof createClient> | Error>;
	currentUserId?: string;
	cursorRows?: Map<
		string,
		{
			id: string;
			userId: string;
			encryptedState: string;
			encryptionIv: string;
			expiresAt: Date;
			createdAt: Date;
		}
	>;
}) {
	const app = Fastify();
	const findMany = vi.fn(async () => instances);
	const create = vi.fn((value: ReturnType<typeof instance>) => {
		const client = clients.get(value.id);
		if (client instanceof Error) throw client;
		if (!client) throw new Error("Missing test client");
		return client;
	});

	const historyCursorState = {
		findFirst: vi.fn(async ({ where }: { where: { id: string; userId: string } }) => {
			const row = cursorRows.get(where.id);
			return row?.userId === where.userId && row.expiresAt > new Date() ? row : null;
		}),
		deleteMany: vi.fn(
			async ({ where }: { where: { userId: string; expiresAt: { lte: Date } } }) => {
				let count = 0;
				for (const [id, row] of cursorRows) {
					if (row.userId === where.userId && row.expiresAt <= where.expiresAt.lte) {
						cursorRows.delete(id);
						count += 1;
					}
				}
				return { count };
			},
		),
		create: vi.fn(
			async ({ data }: { data: typeof cursorRows extends Map<string, infer T> ? T : never }) => {
				cursorRows.set(data.id, data);
				return data;
			},
		),
	};
	app.decorate("prisma", { serviceInstance: { findMany }, historyCursorState } as never);
	app.decorate("encryptor", new Encryptor(encryptionKey));
	app.decorate("arrClientFactory", { create } as never);
	app.decorateRequest("currentUser", null);
	app.decorateRequest("sessionToken", null);
	app.addHook("preHandler", async (request) => {
		request.currentUser = {
			id: currentUserId,
			username: "history",
			mustChangePassword: false,
			createdAt: new Date(),
			updatedAt: new Date(),
		};
	});
	await app.register(historyRoutes);
	await app.ready();
	return { app, findMany, create };
}

describe("History route cursor contract", () => {
	beforeEach(() => {
		vi.restoreAllMocks();
	});

	it("scopes providers to the current user and resumes without duplicate records", async () => {
		const sonarr = instance("sonarr");
		const radarr = instance("radarr", "RADARR");
		const { app, findMany } = await buildApp({
			instances: [sonarr, radarr],
			clients: new Map([
				[sonarr.id, createClient(records("s"))],
				[radarr.id, createClient(records("r"), "radarr")],
			]),
		});

		try {
			const first = await app.inject({
				method: "GET",
				url: "/dashboard/history?pageSize=2&hideProwlarrRss=true",
			});
			expect(first.statusCode).toBe(200);
			const firstBody = first.json();
			expect(firstBody).toMatchObject({
				version: 2,
				totalCount: null,
				pagination: {
					pageSize: 2,
					hasMore: true,
					incomplete: false,
					sortKey: "date",
					sortDirection: "descending",
				},
			});
			expect(firstBody.instances).toHaveLength(2);
			expect(
				firstBody.instances.every((provider: { data: unknown[] }) => provider.data.length === 0),
			).toBe(true);
			expect(firstBody.aggregated).toHaveLength(2);
			expect(firstBody.pagination.nextCursor).toEqual(expect.any(String));
			expect(findMany).toHaveBeenCalledWith(
				expect.objectContaining({
					where: expect.objectContaining({
						userId,
						enabled: true,
					}),
				}),
			);

			const second = await app.inject({
				method: "GET",
				url: `/dashboard/history?pageSize=2&hideProwlarrRss=true&cursor=${encodeURIComponent(
					firstBody.pagination.nextCursor,
				)}`,
			});
			expect(second.statusCode).toBe(200);
			const secondBody = second.json();
			const ids = [...firstBody.aggregated, ...secondBody.aggregated].map(
				(item: { id: string }) => item.id,
			);
			expect(new Set(ids).size).toBe(ids.length);
			expect(ids).toEqual(["r-1", "s-1", "r-2", "s-2"]);
			expect(secondBody.totalCount).toBe(4);
			expect(secondBody.pagination.hasMore).toBe(false);
		} finally {
			await app.close();
		}
	});

	it("returns a deliberate client error above the fixed provider concurrency limit", async () => {
		const instances = Array.from({ length: 201 }, (_, index) => instance(`sonarr-${index}`));
		const { app } = await buildApp({ instances, clients: new Map() });

		try {
			const response = await app.inject({
				method: "GET",
				url: "/dashboard/history?pageSize=25&hideProwlarrRss=true",
			});
			expect(response.statusCode).toBe(422);
			expect(response.json()).toEqual({
				error:
					"History supports at most 200 enabled providers per request. Narrow the service or instance filter.",
			});
		} finally {
			await app.close();
		}
	});

	it("keeps a failed provider visible and does not publish healthy data as complete", async () => {
		const failed = instance("failed");
		const healthy = instance("healthy");
		const clients = new Map<string, ReturnType<typeof createClient> | Error>([
			[failed.id, new Error("credential failure")],
			[healthy.id, createClient(records("healthy"))],
		]);
		const { app } = await buildApp({
			instances: [failed, healthy],
			clients,
		});

		try {
			const response = await app.inject({
				method: "GET",
				url: "/dashboard/history?pageSize=2&hideProwlarrRss=true",
			});
			expect(response.statusCode).toBe(200);
			expect(response.json()).toMatchObject({
				aggregated: [],
				totalCount: null,
				pagination: { hasMore: false, incomplete: true },
				instances: expect.arrayContaining([
					expect.objectContaining({
						instanceId: "failed",
						status: "error",
						error: "Provider unavailable",
					}),
				]),
			});
		} finally {
			await app.close();
		}
	});

	it("rejects a tampered cursor and a cursor replayed after an instance binding changes", async () => {
		const sonarr = instance("sonarr");
		const clients = new Map([[sonarr.id, createClient(records("s"))]]);
		const fixture = await buildApp({ instances: [sonarr], clients });

		try {
			const first = await fixture.app.inject({
				method: "GET",
				url: "/dashboard/history?pageSize=1&hideProwlarrRss=true",
			});
			const cursor = first.json().pagination.nextCursor as string;
			const tampered = `${cursor.slice(0, -1)}${cursor.endsWith("A") ? "B" : "A"}`;
			const tamperedResponse = await fixture.app.inject({
				method: "GET",
				url: `/dashboard/history?pageSize=1&hideProwlarrRss=true&cursor=${encodeURIComponent(tampered)}`,
			});
			expect(tamperedResponse.statusCode).toBe(409);

			sonarr.updatedAt = new Date("2026-08-31T00:01:00.000Z");
			const changedBindingResponse = await fixture.app.inject({
				method: "GET",
				url: `/dashboard/history?pageSize=1&hideProwlarrRss=true&cursor=${encodeURIComponent(cursor)}`,
			});
			expect(changedBindingResponse.statusCode).toBe(409);
		} finally {
			await fixture.app.close();
		}
	});

	it("rejects a valid cursor replayed by another authenticated user", async () => {
		const sonarr = instance("sonarr");
		const clients = new Map([[sonarr.id, createClient(records("s"))]]);
		const cursorRows = new Map();
		const owner = await buildApp({
			instances: [sonarr],
			clients,
			currentUserId: "user-a",
			cursorRows,
		});
		const otherUser = await buildApp({
			instances: [sonarr],
			clients,
			currentUserId: "user-b",
			cursorRows,
		});

		try {
			const first = await owner.app.inject({
				method: "GET",
				url: "/dashboard/history?pageSize=1&hideProwlarrRss=true",
			});
			const cursor = first.json().pagination.nextCursor as string;
			const replay = await otherUser.app.inject({
				method: "GET",
				url: `/dashboard/history?pageSize=1&hideProwlarrRss=true&cursor=${encodeURIComponent(cursor)}`,
			});

			expect(replay.statusCode).toBe(409);
			expect(replay.json()).toEqual({
				error: "History changed while paging. Refresh to restart from the newest records.",
			});
		} finally {
			await owner.app.close();
			await otherUser.app.close();
		}
	});

	it("keeps a 20-provider next request below the live Node HTTP parser limit", async () => {
		const manyInstances = Array.from({ length: 20 }, (_, index) =>
			instance(`00000000-0000-4000-8000-${String(index).padStart(12, "0")}`),
		);
		const clients = new Map(
			manyInstances.map((entry) => [entry.id, createClient(records(entry.id))]),
		);
		const { app } = await buildApp({ instances: manyInstances, clients });

		try {
			const baseUrl = await app.listen({ host: "127.0.0.1", port: 0 });
			const first = await fetch(`${baseUrl}/dashboard/history?pageSize=20&hideProwlarrRss=true`);
			expect(first.status).toBe(200);
			const cursor = ((await first.json()) as { pagination: { nextCursor: string } }).pagination
				.nextCursor;
			expect(cursor).toMatch(/^[A-Za-z0-9_-]{43}$/);
			const next = await fetch(
				`${baseUrl}/dashboard/history?pageSize=20&hideProwlarrRss=true&cursor=${encodeURIComponent(cursor)}`,
			);

			expect(next.status).toBe(200);
		} finally {
			await app.close();
		}
	});
});
