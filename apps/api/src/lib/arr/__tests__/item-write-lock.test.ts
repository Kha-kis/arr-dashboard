import { setImmediate } from "node:timers/promises";
import { RadarrClient } from "arr-sdk";
import Fastify, { type FastifyBaseLogger } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerMonitorRoutes } from "../../../routes/library/monitor-routes.js";
import { type AutoTagRuleInput, executeAutoTagRule } from "../../auto-tag/execute-rule.js";
import { acquireAutoTagTargetLock } from "../../auto-tag/target-lock.js";
import { radarrDestWriter } from "../../label-sync/dest-writers/arr-writer.js";
import type { DestWriterOpts } from "../../label-sync/strategy-types.js";
import type { PrismaClient, ServiceInstance } from "../../prisma.js";
import { acquireArrItemWriteLock } from "../item-write-lock.js";

const chain = vi.hoisted(() => ({
	run: undefined as undefined | ((args: { arrItemId: number }) => Promise<unknown>),
}));
vi.mock("../../label-sync/trigger-for-item.js", () => ({
	triggerLabelSyncForItem: (args: { arrItemId: number }) => chain.run?.(args),
}));
vi.mock("../../library-cleanup/rule-evaluators.js", () => ({
	evaluateSingleConditionState: () => ({ state: "true", reason: "synthetic match" }),
}));
vi.mock("../../library-cleanup/cleanup-executor.js", () => ({
	buildEvalContextWithHealth: async () => ({ ctx: { now: new Date() }, failedSources: new Set() }),
}));
afterEach(() => {
	chain.run = undefined;
});
const deferred = () => {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
};
const instance = (baseUrl: string, id = "selected"): ServiceInstance =>
	({
		id,
		userId: "owner",
		service: "RADARR",
		enabled: true,
		baseUrl,
		encryptedApiKey: "synthetic",
		encryptionIv: "synthetic",
		label: "Synthetic",
		connectionGeneration: 1,
		identityGeneration: 1,
	}) as ServiceInstance;
const log = {
	info() {},
	warn() {},
	error() {},
	debug() {},
	trace() {},
	fatal() {},
	child() {
		return this;
	},
} as unknown as FastifyBaseLogger;
const movie = (id: number) => ({
	id,
	tmdbId: id + 1000,
	title: "Same synthetic title",
	tags: [1],
	monitored: true,
	year: 2020,
	qualityProfileId: 7,
	path: `/synthetic/${id}`,
	custom: { keep: true },
});
function fixture(baseUrl: string) {
	const selected = instance(baseUrl);
	const rows = new Map([1, 2, 99].map((id) => [id, movie(id)]));
	const client = Object.assign(Object.create(RadarrClient.prototype), {
		tag: {
			getAll: async () => [
				{ id: 2, label: "auto" },
				{ id: 3, label: "chain" },
			],
		},
		movie: {
			getAll: async () => [...rows.values()].map((row) => structuredClone(row)),
			getById: vi.fn(async (id: number) => structuredClone(rows.get(id)!)),
			update: vi.fn(async (id: number, value: ReturnType<typeof movie>) => {
				rows.set(id, structuredClone(value));
				return structuredClone(value);
			}),
		},
	});
	const factory = { create: () => client } as unknown as DestWriterOpts["arrClientFactory"];
	const label = (id: number) =>
		radarrDestWriter.applyLabels({
			rule: {
				id: "label",
				userId: "owner",
				sourceService: "radarr",
				sourceInstanceId: selected.id,
				sourceTagName: "auto",
				destService: "radarr",
				destInstanceId: selected.id,
				destTagName: "chain",
			},
			prisma: {} as PrismaClient,
			encryptor: {} as DestWriterOpts["encryptor"],
			destInstance: selected,
			candidates: [{ tmdbId: id + 1000, mediaType: "movie", title: "Same synthetic title" }],
			arrClientFactory: factory,
			log,
		} as DestWriterOpts);
	const auto = (id: number) =>
		executeAutoTagRule({
			rule: {
				id: `auto-${id}`,
				userId: "owner",
				name: "Synthetic",
				ruleType: "year_range",
				parameters: {},
				operator: null,
				conditions: null,
				serviceFilter: null,
				instanceFilter: null,
				excludeTags: null,
				excludeTitles: null,
				plexLibraryFilter: null,
				tagName: "auto",
			} as AutoTagRuleInput,
			prisma: {
				serviceInstance: { findMany: async () => [selected], findFirst: async () => selected },
				libraryCache: {
					findMany: async () => [
						{
							id: `cache-${id}`,
							instanceId: selected.id,
							arrItemId: id,
							itemType: "movie",
							title: "Same synthetic title",
							data: JSON.stringify(rows.get(id)),
							year: 2020,
							sizeOnDisk: 1n,
							monitored: true,
						},
					],
				},
			} as never,
			arrClientFactory: factory,
			encryptor: {} as never,
			log,
		});
	return { selected, rows, client, factory, label, auto };
}

describe("shared ARR item write lock", () => {
	it("shares the compatibility alias, normalizes URL aliases and queues releases idempotently", async () => {
		expect(acquireAutoTagTargetLock).toBe(acquireArrItemWriteLock);
		const first = await acquireArrItemWriteLock(instance("HTTP://lock-alias.invalid:80/base/"), 1);
		let granted = false;
		const queued = acquireAutoTagTargetLock(
			instance("http://lock-alias.invalid/base", "other-config"),
			1,
		).then((release) => {
			granted = true;
			return release;
		});
		await setImmediate();
		expect(granted).toBe(false);
		first();
		const second = await queued;
		first();
		let thirdGranted = false;
		const third = acquireArrItemWriteLock(instance("http://lock-alias.invalid/base"), 1).then(
			(release) => {
				thirdGranted = true;
				return release;
			},
		);
		await setImmediate();
		expect(thirdGranted).toBe(false);
		second();
		(await third)();
	});
	it("keeps numeric items, services, endpoint paths and different endpoints independent", async () => {
		const held = await acquireArrItemWriteLock(instance("http://lock-identities.invalid/base"), 1);
		try {
			const releases = await Promise.all([
				acquireArrItemWriteLock(instance("http://lock-identities.invalid/base"), 2),
				acquireArrItemWriteLock(
					{ ...instance("http://lock-identities.invalid/base"), service: "SONARR" },
					1,
				),
				acquireArrItemWriteLock(instance("http://lock-identities.invalid/other"), 1),
				acquireArrItemWriteLock(instance("http://other-lock.invalid/base"), 1),
			]);
			for (const release of releases) release();
		} finally {
			held();
		}
	});
	it("releases a failed Label Sync write so a later real writer can progress", async () => {
		const f = fixture("http://lock-failure.invalid");
		f.client.movie.update.mockRejectedValueOnce(new Error("Synthetic upstream failure"));
		expect(await f.label(1)).toMatchObject({ failures: 1, labelsApplied: 0 });
		expect(await f.label(1)).toMatchObject({ failures: 0, labelsApplied: 1 });
		expect(f.rows.get(1)?.tags).toEqual([1, 3]);
	});
	it("releases Auto-Tagger before chaining into the same real Label Sync target", async () => {
		const f = fixture("http://same-target-chain.invalid");
		chain.run = ({ arrItemId }) => f.label(arrItemId);
		expect(await f.auto(1)).toMatchObject({
			status: "success",
			totals: { tagsApplied: 1, failures: 0 },
		});
		expect(f.rows.get(1)).toEqual({ ...movie(1), tags: [1, 2, 3] });
		expect(f.rows.get(99)).toEqual(movie(99));
	});
	it("releases source locks before opposing cross-target chains acquire their destinations", async () => {
		const f = fixture("http://opposing-chains.invalid"),
			both = deferred();
		let entered = 0;
		chain.run = async ({ arrItemId }) => {
			if (++entered === 2) both.resolve();
			await both.promise;
			return f.label(arrItemId === 1 ? 2 : 1);
		};
		const results = await Promise.all([f.auto(1), f.auto(2)]);
		expect(results.every((result) => result.status === "success")).toBe(true);
		for (const id of [1, 2]) expect(f.rows.get(id)).toEqual({ ...movie(id), tags: [1, 2, 3] });
		expect(f.rows.get(99)).toEqual(movie(99));
	});
	it("serializes actual Library monitor and Label Sync GET/merge/PUT so monitoring and tags survive", async () => {
		const f = fixture("http://monitor-label-chain.invalid"),
			entered = deferred(),
			resume = deferred();
		const app = Fastify({ logger: false });
		let first = true;
		f.client.movie.getById.mockImplementation(async (id: number) => {
			const snapshot = structuredClone(f.rows.get(id)!);
			if (first) {
				first = false;
				entered.resolve();
				await resume.promise;
			}
			return snapshot;
		});
		app.decorate("prisma", {
			serviceInstance: { findFirst: async () => f.selected },
			libraryCache: {
				findFirst: async () => ({ id: "cache", monitored: true, data: JSON.stringify(movie(1)) }),
				update: async () => ({}),
			},
		} as unknown as PrismaClient);
		app.decorate("arrClientFactory", f.factory);
		app.addHook("preHandler", async (request) => {
			request.currentUser = { id: "owner" } as never;
		});
		await app.register(registerMonitorRoutes);
		await app.ready();
		const monitoring = app.inject({
			method: "POST",
			url: "/library/monitor",
			payload: { instanceId: f.selected.id, service: "radarr", itemId: 1, monitored: false },
		});
		let labeling: ReturnType<typeof f.label> | undefined;
		try {
			await entered.promise;
			labeling = f.label(1);
			await setImmediate();
			expect(f.client.movie.getById).toHaveBeenCalledTimes(1);
			resume.resolve();
			const [response, labels] = await Promise.all([monitoring, labeling]);
			expect(response.statusCode).toBe(204);
			expect(labels).toMatchObject({ failures: 0, labelsApplied: 1 });
			expect(f.rows.get(1)).toEqual({ ...movie(1), monitored: false, tags: [1, 3] });
			expect(f.rows.get(99)).toEqual(movie(99));
		} finally {
			resume.resolve();
			await Promise.allSettled([monitoring, labeling]);
			await app.close();
		}
	});
});
