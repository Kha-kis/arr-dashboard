import Fastify, { type FastifyInstance } from "fastify";
import fp from "fastify-plugin";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installRuntimeFixture } from "./runtime-fixture.js";
import { withCleanupMaintenanceGuard } from "../../lib/library-cleanup/cleanup-maintenance-gate.js";
import { JOB_ID } from "../../lib/scheduler-registry/job-definitions.js";
import registry from "../scheduler-registry.js";
import tmdbScheduler from "../tmdb-list-cache-scheduler.js";
import traktScheduler from "../trakt-list-cache-scheduler.js";

// Keep the real refresher, registry and Fastify lifecycle. Only persistence and
// provider transports are synthetic; generation/ownership contracts have their
// own database tests. Nothing here contacts a provider or a populated QA DB.
const boundary = vi.hoisted(() => ({ tmdb: vi.fn(), trakt: vi.fn() }));
vi.mock("../../lib/tmdb/list-client.js", () => ({ createTmdbV3Client: boundary.tmdb }));
vi.mock("../../lib/trakt/list-client.js", () => ({ createTraktClient: boundary.trakt }));
type Provider = "tmdb" | "trakt";
type Origin = "startup" | "interval";
type Phase =
	| "rules"
	| "user"
	| "provider"
	| "publication-delete"
	| "publication-create"
	| "publication-status"
	| "failure-status"
	| "orphan-rows"
	| "orphan-owners"
	| "orphan-delete"
	| "orphan-status";
type Row = {
	userId: string;
	listKey: string;
	tmdbId: number;
	mediaType: string;
	generation: string;
};
type Status = Record<string, unknown> & { userId: string; provider: string; listKey: string };
type Selection = {
	userId: string;
	listId?: string | { notIn: string[] };
	listSlug?: string | { notIn: string[] };
};
type Upsert = {
	where: { userId_provider_listKey: { userId: string; provider: string; listKey: string } };
	create: Status;
	update: Record<string, unknown>;
};
const apps: FastifyInstance[] = [],
	releases: Array<() => void> = [];
function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	releases.push(resolve);
	return { promise, resolve };
}
async function settle() {
	for (let i = 0; i < 8; i++) await new Promise<void>((done) => setImmediate(done));
}
async function boot(
	provider: Provider,
	options: {
		hold?: { phase: Phase; gate: Promise<void>; call?: number; reject?: boolean };
		preClose?: Promise<void>;
		providerFailure?: boolean;
		empty?: boolean;
	} = {},
) {
	const listField = provider === "tmdb" ? "listId" : "listSlug";
	const cacheName = provider === "tmdb" ? "tmdbListCache" : "traktListCache";
	const jobId = provider === "tmdb" ? JOB_ID.tmdbListCache : JOB_ID.traktListCache;
	const counts = new Map<Phase, number>();
	const state = { pending: 0, teardown: false, afterTeardown: 0, pendingAtTeardown: -1 };
	const store = {
		rows: ["owner-a", "owner-b"].flatMap<Row>((userId) =>
			["shared", "orphan"].map((listKey) => ({
				userId,
				listKey,
				tmdbId: 50,
				mediaType: "movie",
				generation: "old-generation",
			})),
		),
		statuses: ["owner-a", "owner-b"]
			.flatMap<Status>((userId) =>
				["shared", "orphan"].map((listKey) => ({
					userId,
					provider,
					listKey,
					generationId: "old-generation",
					lastResult: "success",
				})),
			)
			.concat([
				{
					userId: "owner-a",
					provider: provider === "tmdb" ? "trakt" : "tmdb",
					listKey: "orphan",
					generationId: "other-provider",
				},
			]),
	};
	async function pause(phase: Phase) {
		const call = (counts.get(phase) ?? 0) + 1;
		counts.set(phase, call);
		state.pending++;
		if (state.teardown) state.afterTeardown++;
		try {
			if (options.hold?.phase === phase && call === (options.hold.call ?? 1)) {
				await options.hold.gate;
				if (options.hold.reject) throw new Error("Synthetic boundary unavailable");
			}
		} finally {
			state.pending--;
			if (state.teardown) state.afterTeardown++;
		}
	}
	function cacheMethods(target: typeof store) {
		return {
			findMany: async (args: unknown) => {
				expect(args).toEqual({ select: { userId: true }, distinct: ["userId"] });
				await pause("orphan-rows");
				return [...new Set(target.rows.map((row) => row.userId))].map((userId) => ({ userId }));
			},
			deleteMany: async ({ where }: { where: Selection }) => {
				expect(["owner-a", "owner-b"]).toContain(where.userId);
				const selection = where[listField];
				await pause(typeof selection === "string" ? "publication-delete" : "orphan-delete");
				const before = target.rows.length;
				target.rows = target.rows.filter(
					(row) =>
						row.userId !== where.userId ||
						(typeof selection === "string"
							? row.listKey !== selection
							: selection?.notIn.includes(row.listKey)),
				);
				return { count: before - target.rows.length };
			},
			createMany: async ({ data }: { data: Array<Record<string, unknown>> }) => {
				await pause("publication-create");
				for (const row of data) {
					expect(["owner-a", "owner-b"]).toContain(row.userId);
					expect(row[listField]).toBe("shared");
					target.rows.push({
						userId: String(row.userId),
						listKey: String(row[listField]),
						tmdbId: Number(row.tmdbId),
						mediaType: String(row.mediaType),
						generation: String(row.generation),
					});
				}
				return { count: data.length };
			},
		};
	}
	function statusMethods(target: typeof store) {
		return {
			findMany: async (args: unknown) => {
				expect(args).toEqual({
					where: { provider },
					select: { userId: true },
					distinct: ["userId"],
				});
				await pause("orphan-owners");
				return [
					...new Set(
						target.statuses.filter((row) => row.provider === provider).map((row) => row.userId),
					),
				].map((userId) => ({ userId }));
			},
			upsert: async (args: Upsert) => {
				const key = args.where.userId_provider_listKey;
				expect(key.provider).toBe(provider);
				expect(key.listKey).toBe("shared");
				expect(["owner-a", "owner-b"]).toContain(key.userId);
				await pause(
					args.update.lastAttemptResult === "error" ? "failure-status" : "publication-status",
				);
				const row = target.statuses.find(
					(row) =>
						row.userId === key.userId &&
						row.provider === key.provider &&
						row.listKey === key.listKey,
				);
				if (row) Object.assign(row, args.update);
				else target.statuses.push(args.create);
				return row;
			},
			deleteMany: async ({
				where,
			}: {
				where: { userId: string; provider: string; listKey?: { notIn: string[] } };
			}) => {
				expect(where.provider).toBe(provider);
				expect(["owner-a", "owner-b"]).toContain(where.userId);
				await pause("orphan-status");
				const before = target.statuses.length;
				target.statuses = target.statuses.filter(
					(row) =>
						row.userId !== where.userId ||
						row.provider !== where.provider ||
						where.listKey?.notIn.includes(row.listKey),
				);
				return { count: before - target.statuses.length };
			},
		};
	}
	const forbidden = vi.fn(() => {
		throw new Error("Forbidden persistence operation");
	});
	const database = new Proxy(
		{
			autoTagRule: {
				findMany: async (args: unknown) => {
					expect(args).toEqual({
						where: { enabled: true },
						select: { userId: true, ruleType: true, parameters: true, conditions: true },
					});
					await pause("rules");
					return options.empty
						? []
						: [
								{
									userId: "owner-a",
									ruleType: `${provider}_list_member`,
									parameters: JSON.stringify({ [listField]: "shared" }),
									conditions: null,
								},
								{
									userId: "owner-a",
									ruleType: `${provider}_list_member`,
									parameters: JSON.stringify({ [listField]: "shared" }),
									conditions: null,
								},
								{
									userId: "owner-b",
									ruleType: "composite",
									parameters: "{}",
									conditions: JSON.stringify([
										{ ruleType: `${provider}_list_member`, parameters: { [listField]: "shared" } },
									]),
								},
							];
				},
			},
			user: {
				findUnique: async (args: { where: { id: string }; select: unknown }) => {
					expect(["owner-a", "owner-b"]).toContain(args.where.id);
					expect(args.select).toEqual(
						provider === "tmdb"
							? { encryptedTmdbApiKey: true, tmdbEncryptionIv: true }
							: { encryptedTraktAccessToken: true, traktTokenIv: true },
					);
					await pause("user");
					return {
						encryptedTmdbApiKey: "synthetic",
						tmdbEncryptionIv: "synthetic",
						encryptedTraktAccessToken: "synthetic",
						traktTokenIv: "synthetic",
					};
				},
			},
			[cacheName]: cacheMethods(store),
			listCacheRefreshStatus: statusMethods(store),
			$transaction: async (callback: (tx: unknown) => Promise<unknown>) => {
				// Model atomic commit/rollback without pretending this is a real DB.
				const staged = {
					rows: store.rows.map((row) => ({ ...row })),
					statuses: store.statuses.map((row) => ({ ...row })),
				};
				const result = await callback({
					[cacheName]: cacheMethods(staged),
					listCacheRefreshStatus: statusMethods(staged),
				});
				Object.assign(store, staged);
				return result;
			},
		},
		{
			get(target, key) {
				return key in target
					? target[key as keyof typeof target]
					: ["then", "getter", "setter"].includes(String(key))
						? undefined
						: forbidden;
			},
		},
	);
	const client = {
		getListItems: async (key: string) => {
			expect(key).toBe("shared");
			await pause("provider");
			if (options.providerFailure && counts.get("provider") === 1)
				throw new Error("Synthetic provider unavailable");
			return [
				{ tmdbId: 10, mediaType: "movie", title: "Synthetic same title" },
				{ tmdbId: 10, mediaType: "series", title: "Synthetic same title" },
			];
		},
	};
	boundary[provider].mockImplementation(() => client);
	const app = Fastify({ logger: false });
	apps.push(app);
	await installRuntimeFixture(app);
	app.register(
		fp(
			async (scope) => {
				scope.decorate("prisma", database as unknown as FastifyInstance["prisma"]);
				scope.addHook("onClose", async () => {
					state.pendingAtTeardown = state.pending;
					state.teardown = true;
				});
			},
			{ name: "prisma" },
		),
	);
	app.register(
		fp(
			async (scope) => {
				scope.decorate("encryptor", {
					decrypt: () => "synthetic",
				} as unknown as FastifyInstance["encryptor"]);
			},
			{ name: "security" },
		),
	);
	app.register(registry);
	app.register(provider === "tmdb" ? tmdbScheduler : traktScheduler);
	const preClosed = deferred();
	// Observe and hold shutdown only after the real scheduler closes admission.
	app.register(
		fp(
			async (server) => {
				server.addHook("preClose", async () => preClosed.resolve());
				if (options.preClose) server.addHook("preClose", async () => options.preClose);
			},
			{
				name: "list-cache-shutdown-observer",
				dependencies: [
					provider === "tmdb" ? "tmdb-list-cache-scheduler" : "trakt-list-cache-scheduler",
				],
			},
		),
	);
	const timeouts = vi.spyOn(globalThis, "setTimeout"),
		intervals = vi.spyOn(globalThis, "setInterval");
	await app.ready();
	const track = vi.spyOn(app.schedulerRegistry, "track");
	function callback(origin: Origin) {
		const spy = origin === "startup" ? timeouts : intervals;
		const ms = origin === "startup" ? (provider === "tmdb" ? 60_000 : 90_000) : 4 * 60 * 60_000;
		const index = spy.mock.calls.findIndex(([, delay]) => delay === ms);
		const fn = spy.mock.calls[index]?.[0];
		if (typeof fn !== "function") throw new Error("List-cache timer missing");
		return () => {
			if (origin === "startup") clearTimeout(spy.mock.results[index]?.value);
			fn();
		};
	}
	return {
		app,
		state,
		counts,
		store,
		track,
		forbidden,
		callback,
		status: () => app.schedulerRegistry.getStatus(jobId)!,
		async closePending() {
			let settled = false;
			const promise = app.close().then(() => {
				settled = true;
			});
			await preClosed.promise;
			await settle();
			return { promise, settled: () => settled };
		},
	};
}
beforeEach(() => {
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
	vi.stubEnv("TRAKT_CLIENT_ID", "synthetic");
	vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Network forbidden"));
	boundary.tmdb.mockReset();
	boundary.trakt.mockReset();
});
afterEach(async () => {
	for (const release of releases.splice(0)) release();
	await settle();
	await Promise.all(apps.splice(0).map((app) => app.close()));
	expect(globalThis.fetch).not.toHaveBeenCalled();
	vi.restoreAllMocks();
	vi.useRealTimers();
	vi.unstubAllEnvs();
});
for (const provider of ["tmdb", "trakt"] as const)
	describe(`${provider} list-cache shutdown`, () => {
		for (const origin of ["startup", "interval"] as const)
			for (const phase of [
				"rules",
				"user",
				"provider",
				"publication-delete",
				"publication-create",
				"publication-status",
				"failure-status",
				"orphan-rows",
				"orphan-owners",
				"orphan-delete",
				"orphan-status",
			] as const)
				for (const reject of [false, true])
					it(`drains ${origin} ${phase} ${reject ? "failure" : "success"} before DB teardown`, async () => {
						const held = deferred();
						const h = await boot(provider, {
							hold: { phase, gate: held.promise, reject },
							providerFailure: phase === "failure-status",
						});
						h.callback(origin)();
						await settle();
						expect(h.state.pending).toBeGreaterThan(0);
						expect(h.status().state).toBe("running");
						await expect(withCleanupMaintenanceGuard(async () => undefined)).rejects.toMatchObject({
							statusCode: 409,
						});
						const close = await h.closePending();
						try {
							expect(close.settled()).toBe(false);
							expect(h.state.teardown).toBe(false);
						} finally {
							held.resolve();
							await close.promise;
						}
						expect(h.state.afterTeardown).toBe(0);
						expect(h.state.pendingAtTeardown).toBe(0);
						expect(h.status().state).toBe("idle");
						expect(h.status().totalRuns).toBe(1);
						if (reject && phase.startsWith("publication-")) {
							const previous = h.store.statuses.find(
								(row) =>
									row.userId === "owner-a" && row.provider === provider && row.listKey === "shared",
							)!;
							expect(previous.generationId).toBe("old-generation");
							expect(previous.lastAttemptResult).toBe("error");
							expect(h.store.rows.filter((row) => row.userId === "owner-a")).toEqual([
								{
									userId: "owner-a",
									listKey: "shared",
									tmdbId: 50,
									mediaType: "movie",
									generation: "old-generation",
								},
							]);
						}
						expect(h.forbidden).not.toHaveBeenCalled();
						await expect(withCleanupMaintenanceGuard(async () => "safe")).resolves.toBe("safe");
					});
		for (const origin of ["startup", "interval"] as const) {
			for (const synchronous of [true, false])
				it(`releases ${origin} completion after ${synchronous ? "synchronous" : "asynchronous"} registry rejection`, async () => {
					const h = await boot(provider);
					if (synchronous)
						h.track.mockImplementationOnce(() => {
							throw new Error("Synthetic registry unavailable");
						});
					else h.track.mockRejectedValueOnce(new Error("Synthetic registry unavailable"));
					h.callback(origin)();
					await settle();
					expect(h.counts.size).toBe(0);
					h.callback("interval")();
					await settle();
					expect(h.counts.get("provider")).toBe(2);
					await h.app.close();
					expect(h.state.pendingAtTeardown).toBe(0);
				});
			it(`rejects ${origin} admission during preClose and after close without touching registry metadata`, async () => {
				const held = deferred(),
					h = await boot(provider, { preClose: held.promise });
				const close = await h.closePending();
				try {
					h.callback(origin)();
					await settle();
					expect(h.track).not.toHaveBeenCalled();
					expect(h.counts.size).toBe(0);
				} finally {
					held.resolve();
					await close.promise;
				}
				h.callback(origin)();
				await settle();
				expect(h.track).not.toHaveBeenCalled();
				expect(h.counts.size).toBe(0);
			});
			it(`rejects ${origin} during maintenance and recovers on the next tick`, async () => {
				const held = deferred(),
					h = await boot(provider);
				const maintenance = withCleanupMaintenanceGuard(async () => held.promise);
				await settle();
				try {
					h.callback(origin)();
					await settle();
					expect(h.counts.size).toBe(0);
					expect(h.status().totalRuns).toBe(0);
				} finally {
					held.resolve();
					await maintenance;
				}
				h.callback("interval")();
				await settle();
				expect(h.counts.get("provider")).toBe(2);
				expect(h.status().totalRuns).toBe(1);
			});
		}
		it("retains later owners and orphan bookkeeping after a held second-owner publication", async () => {
			const held = deferred(),
				h = await boot(provider, {
					hold: { phase: "publication-status", gate: held.promise, call: 2 },
				});
			h.callback("startup")();
			await settle();
			const close = await h.closePending();
			try {
				expect(close.settled()).toBe(false);
			} finally {
				held.resolve();
				await close.promise;
			}
			expect(h.counts.get("provider")).toBe(2);
			expect(h.counts.get("orphan-delete")).toBe(2);
			expect(h.store.rows).toHaveLength(4);
			for (const owner of ["owner-a", "owner-b"]) {
				const rows = h.store.rows.filter((row) => row.userId === owner);
				const status = h.store.statuses.find(
					(row) => row.userId === owner && row.provider === provider,
				)!;
				expect(rows.map((row) => [row.listKey, row.tmdbId, row.mediaType])).toEqual([
					["shared", 10, "movie"],
					["shared", 10, "series"],
				]);
				expect(rows.every((row) => row.generation === status.generationId)).toBe(true);
				expect(status.lastResult).toBe("success");
			}
			expect(h.store.statuses).toHaveLength(3);
			expect(h.store.statuses.some((row) => row.generationId === "other-provider")).toBe(true);
			expect(h.state.afterTeardown).toBe(0);
		});
		it("preserves the prior publication after provider failure and finishes the other owner", async () => {
			const h = await boot(provider, { providerFailure: true });
			h.callback("startup")();
			await settle();
			const failed = h.store.statuses.find(
				(row) => row.userId === "owner-a" && row.provider === provider,
			)!;
			expect(failed.generationId).toBe("old-generation");
			expect(failed.lastAttemptResult).toBe("error");
			expect(h.store.rows.filter((row) => row.userId === "owner-a")).toEqual([
				{
					userId: "owner-a",
					listKey: "shared",
					tmdbId: 50,
					mediaType: "movie",
					generation: "old-generation",
				},
			]);
			expect(h.store.rows.filter((row) => row.userId === "owner-b")).toHaveLength(2);
			expect(h.counts.get("orphan-status")).toBe(2);
		});
		it("does not overlap a retained round and permits a later round after settlement", async () => {
			const held = deferred(),
				h = await boot(provider, { hold: { phase: "rules", gate: held.promise } });
			h.callback("startup")();
			h.callback("interval")();
			await settle();
			try {
				expect(h.counts.get("rules")).toBe(1);
			} finally {
				held.resolve();
				await settle();
			}
			h.callback("interval")();
			await settle();
			expect(h.counts.get("rules")).toBe(2);
			expect(h.counts.get("provider")).toBe(4);
		});
		it("still handles a round with no enabled targets using owner-scoped orphan cleanup", async () => {
			const h = await boot(provider, { empty: true });
			h.callback("startup")();
			await settle();
			expect(h.counts.get("provider")).toBeUndefined();
			expect(h.store.rows).toEqual([]);
			expect(h.store.statuses).toHaveLength(1);
			expect(h.store.statuses[0]?.generationId).toBe("other-provider");
		});
	});

it("preserves Trakt's unconfigured no-op without database or provider work", async () => {
	vi.stubEnv("TRAKT_CLIENT_ID", undefined);
	const h = await boot("trakt");
	h.callback("startup")();
	await settle();
	expect(h.counts.size).toBe(0);
	expect(boundary.trakt).not.toHaveBeenCalled();
	await h.app.close();
	expect(h.state.pendingAtTeardown).toBe(0);
});
