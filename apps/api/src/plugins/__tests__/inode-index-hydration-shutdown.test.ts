import Fastify, { type FastifyInstance } from "fastify";
import fp from "fastify-plugin";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerInfrastructure } from "../../bootstrap/infrastructure.js";
import { installNonDatabaseRuntimeFixture } from "../../lib/__tests__/runtime-admission-fixture.js";
import {
	withCleanupMaintenanceGuard,
	withCleanupOperationGuard,
	withExclusiveCleanupOperationGuard,
} from "../../lib/library-cleanup/cleanup-maintenance-gate.js";
import {
	__testOnly,
	clearFileIdIndexCache,
	type FileIdIndex,
	serializeFileIdIndex,
} from "../../lib/library-sync/infohash-backfill-by-inode.js";

// Exercise real bootstrap wiring, hydration/deserialization, cache publication,
// Fastify lifecycle and maintenance gates. Only unrelated infrastructure and
// the persisted snapshot read are synthetic; no provider, file or QA DB access.
const boundary = vi.hoisted(() => ({
	prisma: {} as object,
	upgradeComplete: false,
	upgradeFails: false,
	teardown: false,
	pendingAtTeardown: -1,
	pending: 0,
}));
vi.mock("../prisma.js", async () => ({
	prismaPlugin: (await import("fastify-plugin")).default(
		async (app: FastifyInstance) => {
			app.decorate("prisma", boundary.prisma as FastifyInstance["prisma"]);
			app.addHook("onClose", async () => {
				boundary.pendingAtTeardown = boundary.pending;
				boundary.teardown = true;
			});
		},
		{ name: "prisma" },
	),
}));
vi.mock("../inode-correlation-upgrade.js", async () => ({
	default: (await import("fastify-plugin")).default(
		async (app: FastifyInstance) => {
			app.addHook("onReady", async () => {
				if (boundary.upgradeFails) throw new Error("Synthetic inode upgrade unavailable");
				boundary.upgradeComplete = true;
			});
		},
		{ name: "inode-correlation-upgrade" },
	),
}));
vi.mock("../arr-client.js", () => ({ arrClientPlugin: async () => {} }));
vi.mock("../security.js", () => ({ securityPlugin: async () => {} }));
vi.mock("../label-sync-mutation-recovery.js", () => ({ default: async () => {} }));
vi.mock("../provider-cache-attempt-recovery.js", () => ({ default: async () => {} }));
vi.mock("../provider-observation-run-recovery.js", () => ({ default: async () => {} }));
vi.mock("../search-grab-recovery.js", () => ({ default: async () => {} }));
vi.mock("../http-auth-migration.js", () => ({ default: async () => {} }));
vi.mock("../seerr-circuit-breaker.js", () => ({ default: async () => {} }));
vi.mock("../seerr-cache.js", () => ({ default: async () => {} }));
vi.mock("../deployment-executor.js", () => ({ default: async () => {} }));
vi.mock("../notification-service.js", () => ({ default: async () => {} }));
vi.mock("../heap-monitor.js", () => ({ default: async () => {} }));

const apps: FastifyInstance[] = [];
const releases: Array<() => void> = [];
const readyPromises: Array<Promise<unknown>> = [];
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
function snapshot(overrides: Partial<FileIdIndex> = {}): FileIdIndex {
	return {
		byFileId: new Map([["1:2", new Set(["synthetic-hash"])]]),
		statted: 1,
		skippedNoLinks: 0,
		skippedUnstatable: 0,
		sourceConnectionGeneration: 3,
		fallbackOwnershipVersion: 4,
		inventoryComplete: true,
		incompleteDirectoryWalks: 0,
		issues: [],
		torrentInventoryFingerprint: "a".repeat(64),
		...overrides,
	};
}
function row(id = "synthetic-instance", index = snapshot(), builtAt = new Date()) {
	return {
		instanceId: id,
		builtAt,
		serializedData: serializeFileIdIndex(index),
		filesIndexed: 1,
		instance: { connectionGeneration: 3 },
	};
}
async function boot(
	options: {
		gate?: Promise<void>;
		reject?: boolean;
		synchronousFailure?: boolean;
		upgradeFailure?: boolean;
		rows?: ReturnType<typeof row>[];
		holdBeforeHydration?: Promise<void>;
	} = {},
) {
	const app = Fastify({ logger: false });
	installNonDatabaseRuntimeFixture(app);
	apps.push(app);
	const state = { reads: 0, afterTeardown: 0, ready: false };
	boundary.upgradeFails = options.upgradeFailure === true;
	boundary.prisma = {
		inodeIndexCache: {
			findMany: async (args: unknown) => {
				expect(boundary.upgradeComplete).toBe(true);
				expect(args).toEqual({
					select: {
						instanceId: true,
						builtAt: true,
						serializedData: true,
						filesIndexed: true,
						instance: { select: { connectionGeneration: true } },
					},
				});
				state.reads++;
				boundary.pending++;
				if (boundary.teardown) state.afterTeardown++;
				try {
					if (options.synchronousFailure) throw new Error("Synthetic synchronous read failure");
					await options.gate;
					if (options.reject) throw new Error("Synthetic snapshot read unavailable");
					return options.rows ?? [row()];
				} finally {
					boundary.pending--;
					if (boundary.teardown) state.afterTeardown++;
				}
			},
		},
	};
	if (options.holdBeforeHydration) {
		app.register(
			fp(async (instance) => {
				instance.addHook("onReady", async () => {
					await options.holdBeforeHydration;
				});
			}),
		);
	}
	const hooks = vi.spyOn(app, "addHook");
	registerInfrastructure(app);
	const ready = Promise.resolve(app.ready()).then(() => {
		state.ready = true;
	});
	readyPromises.push(ready.catch(() => {}));
	await settle();
	const replayHook = async (name: "onReady" | "preClose") => {
		const callback = hooks.mock.calls.filter(([hook]) => hook === name).at(-1)?.[1];
		expect(callback).toBeTypeOf("function");
		await (callback as () => Promise<void>)();
	};
	return {
		app,
		state,
		ready,
		replayReady: () => replayHook("onReady"),
		closeAdmission: () => replayHook("preClose"),
	};
}

beforeEach(() => {
	boundary.upgradeComplete = false;
	boundary.upgradeFails = false;
	boundary.teardown = false;
	boundary.pendingAtTeardown = -1;
	boundary.pending = 0;
	__testOnly.clearCache();
});
afterEach(async () => {
	for (const release of releases.splice(0)) release();
	await Promise.all(readyPromises.splice(0));
	await Promise.all(apps.splice(0).map((app) => app.close()));
	__testOnly.clearCache();
	vi.restoreAllMocks();
	// No failed test may leak an operation lease into another test.
	await expect(withCleanupMaintenanceGuard(async () => true)).resolves.toBe(true);
});

describe("startup inode snapshot hydration ownership", () => {
	it("does not read persisted snapshots when the prior inode upgrade fails", async () => {
		const { state, ready } = await boot({ upgradeFailure: true });
		await expect(ready).rejects.toThrow("Synthetic inode upgrade unavailable");
		expect(state.reads).toBe(0);
		expect(boundary.pending).toBe(0);
		expect(__testOnly.peekCache("synthetic-instance")).toBeUndefined();
	});

	it.each(["empty", "synchronous-failure"] as const)(
		"settles a %s read without retrying or leaking its lease",
		async (kind) => {
			const { app, state, replayReady } = await boot({
				rows: [],
				synchronousFailure: kind === "synchronous-failure",
			});
			expect(state.ready).toBe(true);
			expect(state.reads).toBe(1);
			expect(boundary.pending).toBe(0);
			await replayReady();
			expect(state.reads).toBe(1);
			expect(__testOnly.peekCache("synthetic-instance")).toBeUndefined();
			await expect(withCleanupMaintenanceGuard(async () => true)).resolves.toBe(true);
			await app.close();
			expect(boundary.pendingAtTeardown).toBe(0);
		},
	);

	it("retains its maintenance lease while deserializing and publishing persisted evidence", async () => {
		const persisted = row(),
			payload = persisted.serializedData;
		const attempts: Array<Promise<boolean>> = [];
		Object.defineProperty(persisted, "serializedData", {
			get: () => {
				attempts.push(
					withCleanupMaintenanceGuard(async () => true).then(
						() => true,
						() => false,
					),
				);
				return payload;
			},
		});
		const { state } = await boot({ rows: [persisted] });
		expect(state.reads).toBe(1);
		expect(attempts.length).toBeGreaterThan(0);
		expect(await Promise.all(attempts)).not.toContain(true);
		expect(__testOnly.peekCache(persisted.instanceId)).toBeDefined();
		await expect(withCleanupMaintenanceGuard(async () => true)).resolves.toBe(true);
	});

	it("starts exactly once through infrastructure after upgrade without blocking readiness", async () => {
		const gate = deferred();
		const { state, replayReady } = await boot({ gate: gate.promise });
		expect(state.ready).toBe(true);
		expect(state.reads).toBe(1);
		expect(boundary.pending).toBe(1);
		expect(__testOnly.peekCache("synthetic-instance")).toBeUndefined();
		await replayReady();
		expect(state.reads).toBe(1);
		gate.resolve();
		await settle();
		expect(__testOnly.peekCache("synthetic-instance")?.index.byFileId.get("1:2")).toEqual(
			new Set(["synthetic-hash"]),
		);
	});

	it.each([false, true])(
		"drains accepted hydration before database teardown (read rejects: %s)",
		async (reject) => {
			const gate = deferred();
			const { app, state, replayReady } = await boot({ gate: gate.promise, reject });
			expect(state.reads).toBe(1);
			let closed = false;
			const closing = app.close().then(() => {
				closed = true;
			});
			await settle();
			expect(closed).toBe(false);
			expect(boundary.teardown).toBe(false);
			expect(boundary.pending).toBe(1);
			gate.resolve();
			await closing;
			expect(boundary.pendingAtTeardown).toBe(0);
			expect(state.afterTeardown).toBe(0);
			expect(__testOnly.peekCache("synthetic-instance") !== undefined).toBe(!reject);
			await replayReady();
			expect(state.reads).toBe(1);
			await expect(withCleanupMaintenanceGuard(async () => true)).resolves.toBe(true);
		},
	);

	it("keeps maintenance and service deletion excluded until hydration actually settles", async () => {
		const gate = deferred();
		const { state } = await boot({ gate: gate.promise });
		expect(state.reads).toBe(1);
		const maintenance = vi.fn(async () => true);
		const deletion = vi.fn(async () => true);
		await expect(withCleanupMaintenanceGuard(maintenance)).rejects.toMatchObject({
			statusCode: 409,
		});
		await expect(withExclusiveCleanupOperationGuard(deletion)).rejects.toMatchObject({
			statusCode: 409,
		});
		expect(maintenance).not.toHaveBeenCalled();
		expect(deletion).not.toHaveBeenCalled();
		gate.resolve();
		await settle();
		await expect(withCleanupMaintenanceGuard(maintenance)).resolves.toBe(true);
		await expect(withExclusiveCleanupOperationGuard(deletion)).resolves.toBe(true);
	});

	it.each(["maintenance", "deletion"] as const)(
		"skips boot hydration when %s already owns the gate",
		async (kind) => {
			const guard =
				kind === "maintenance" ? withCleanupMaintenanceGuard : withExclusiveCleanupOperationGuard;
			await guard(async () => {
				const { state, ready, replayReady } = await boot();
				await ready;
				expect(state.reads).toBe(0);
				expect(__testOnly.peekCache("synthetic-instance")).toBeUndefined();
				await replayReady();
				expect(state.reads).toBe(0);
			});
		},
	);

	it("does not admit hydration after preClose while an earlier ready hook is pending", async () => {
		const gate = deferred();
		const { app, state, closeAdmission } = await boot({ holdBeforeHydration: gate.promise });
		expect(state.ready).toBe(false);
		await closeAdmission();
		const closing = app.close();
		await settle();
		gate.resolve();
		await closing;
		expect(state.reads).toBe(0);
		expect(boundary.pendingAtTeardown).toBe(0);
	});

	it("drains work admitted when close waits for an earlier readiness hook", async () => {
		const readyGate = deferred(),
			readGate = deferred();
		const { app, state } = await boot({
			holdBeforeHydration: readyGate.promise,
			gate: readGate.promise,
		});
		let closed = false;
		const closing = app.close().then(() => {
			closed = true;
		});
		await settle();
		expect(state.reads).toBe(0);
		readyGate.resolve();
		await settle();
		expect(state.reads).toBe(1);
		expect(closed).toBe(false);
		expect(boundary.teardown).toBe(false);
		readGate.resolve();
		await closing;
		expect(boundary.pendingAtTeardown).toBe(0);
		expect(state.afterTeardown).toBe(0);
	});

	it("keeps an independent lease after the startup caller releases its shared lease", async () => {
		const gate = deferred();
		const { state } = await withCleanupOperationGuard(() => boot({ gate: gate.promise }));
		expect(state.ready).toBe(true);
		expect(state.reads).toBe(1);
		await expect(withCleanupMaintenanceGuard(async () => true)).rejects.toMatchObject({
			statusCode: 409,
		});
		gate.resolve();
		await settle();
		await expect(withCleanupMaintenanceGuard(async () => true)).resolves.toBe(true);
	});

	it("preserves persisted age and keeps independent current-generation entries", async () => {
		const old = new Date(Date.now() - 60 * 60_000);
		const { state } = await boot({
			rows: [row("synthetic-a", snapshot(), old), row("synthetic-b")],
		});
		expect(state.reads).toBe(1);
		expect(__testOnly.peekCache("synthetic-a")?.builtAt).toBe(old.getTime());
		expect(__testOnly.peekCache("synthetic-b")?.index.sourceConnectionGeneration).toBe(3);
	});

	it.each(["corrupt", "legacy", "generation", "ownership"] as const)(
		"does not publish a %s snapshot",
		async (kind) => {
			const invalid = row(
				"invalid",
				snapshot({
					...(kind === "legacy"
						? { sourceConnectionGeneration: undefined, fallbackOwnershipVersion: undefined }
						: {}),
					...(kind === "generation" ? { sourceConnectionGeneration: 2 } : {}),
					...(kind === "ownership" ? { fallbackOwnershipVersion: 3 } : {}),
				}),
			);
			if (kind === "corrupt") invalid.serializedData = Buffer.from("not gzip");
			const { state } = await boot({ rows: [invalid, row("valid")] });
			expect(state.reads).toBe(1);
			expect(__testOnly.peekCache("invalid")).toBeUndefined();
			expect(__testOnly.peekCache("valid")).toBeDefined();
		},
	);

	it("does not overwrite a newer in-memory index", async () => {
		const gate = deferred(),
			persisted = row();
		const { state } = await boot({ gate: gate.promise, rows: [persisted] });
		expect(state.reads).toBe(1);
		const newer = {
			index: snapshot({ byFileId: new Map([["3:4", new Set(["new-hash"])]]) }),
			builtAt: persisted.builtAt.getTime() + 1,
		};
		__testOnly.primeCache(persisted.instanceId, newer);
		gate.resolve();
		await settle();
		expect(__testOnly.peekCache(persisted.instanceId)).toBe(newer);
	});

	it("does not republish a snapshot invalidated while its read was pending", async () => {
		const gate = deferred();
		const { state } = await boot({ gate: gate.promise });
		expect(state.reads).toBe(1);
		clearFileIdIndexCache("synthetic-instance");
		gate.resolve();
		await settle();
		expect(__testOnly.peekCache("synthetic-instance")).toBeUndefined();
	});
});
