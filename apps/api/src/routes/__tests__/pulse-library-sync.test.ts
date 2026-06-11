/**
 * Integration tests for library-sync signal emission on GET /pulse.
 *
 * Mirrors pulse-cache-staleness.test.ts: run the real
 * `collectLibrarySyncHealth` against a stubbed Prisma surface and assert
 * the emission gates.
 *
 * Emission rules under test:
 *   error row:  lastError != null → warning WITH library.sync action
 *               (and NO additional stale row for the same instance)
 *   stale row:  pollingEnabled AND !syncInProgress AND
 *               now - (lastFullSync ?? createdAt) >= max(3 × interval, 1h)
 *               → warning WITH library.sync action
 *   gated out:  polling disabled, sync in progress, fresh rows,
 *               never-synced rows younger than the threshold
 */

import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../lib/pulse/collectors.js", async () => {
	const actual = await vi.importActual<typeof import("../../lib/pulse/collectors.js")>(
		"../../lib/pulse/collectors.js",
	);
	return { pulseCollectors: [actual.collectLibrarySyncHealth] };
});

import { registerPulseRoutes } from "../pulse.js";
import {
	createInjectAuthenticated,
	makePulseDismissalStub,
	setupAuthInjection,
} from "./test-helpers.js";

let app: ReturnType<typeof Fastify>;
let injectAuthenticated: ReturnType<typeof createInjectAuthenticated>;
let syncStatuses: SyncStatusRow[];
let userCounter = 0;

type SyncStatusRow = {
	id: string;
	instanceId: string;
	lastFullSync: Date | null;
	syncInProgress: boolean;
	lastError: string | null;
	pollingEnabled: boolean;
	pollingIntervalMins: number;
	createdAt: Date;
	updatedAt: Date;
	instance: { label: string; service: string };
};

const HOURS = 60 * 60 * 1000;

function makeRow(overrides: Partial<SyncStatusRow> = {}): SyncStatusRow {
	return {
		id: "row-1",
		instanceId: "inst-1",
		lastFullSync: new Date(Date.now() - 24 * HOURS), // stale vs 15min interval
		syncInProgress: false,
		lastError: null,
		pollingEnabled: true,
		pollingIntervalMins: 15,
		createdAt: new Date(Date.now() - 30 * 24 * HOURS),
		updatedAt: new Date(Date.now() - 24 * HOURS),
		instance: { label: "Sonarr Main", service: "SONARR" },
		...overrides,
	};
}

beforeEach(async () => {
	userCounter += 1;
	app = Fastify({ logger: false });
	setupAuthInjection(app, { id: `user-libsync-${userCounter}`, username: "admin" });
	app.decorate("prisma", {
		librarySyncStatus: {
			findMany: async () => syncStatuses,
		},
		pulseDismissal: makePulseDismissalStub(),
	} as unknown as never);
	await app.register(registerPulseRoutes);
	await app.ready();
	injectAuthenticated = createInjectAuthenticated(app);
});

afterEach(async () => {
	await app?.close();
});

async function getItems(): Promise<Array<Record<string, unknown>>> {
	const res = await injectAuthenticated("GET", "/pulse");
	expect(res.statusCode).toBe(200);
	return JSON.parse(res.payload).items;
}

describe("GET /pulse — library sync signal emission", () => {
	it("emits a warning with a library.sync action when lastError is set", async () => {
		syncStatuses = [makeRow({ lastError: "fetch failed: ECONNREFUSED" })];

		const items = await getItems();
		const item = items.find((i) => i.id === "library-sync-error-inst-1");

		expect(item).toBeDefined();
		expect(item).toMatchObject({
			severity: "warning",
			title: "Sonarr Main: library sync failing",
			detail: "fetch failed: ECONNREFUSED",
			actionUrl: "/library",
			source: "sonarr",
			action: {
				kind: "library.sync",
				target: { instanceId: "inst-1" },
				label: "Sync now",
				destructive: false,
			},
		});
	});

	it("does NOT double-emit a stale row for an instance that already has an error row", async () => {
		// Stale AND erroring — one row ("failing") is the honest summary; a
		// second "stale" row would double-count the same broken sync.
		syncStatuses = [
			makeRow({ lastError: "boom", lastFullSync: new Date(Date.now() - 48 * HOURS) }),
		];

		const items = await getItems();

		expect(items.map((i) => i.id)).toEqual(["library-sync-error-inst-1"]);
	});

	it("emits a stale warning with action when lastFullSync exceeds 3× the polling interval", async () => {
		syncStatuses = [makeRow({ lastFullSync: new Date(Date.now() - 24 * HOURS) })];

		const items = await getItems();
		const item = items.find((i) => i.id === "library-sync-stale-inst-1");

		expect(item).toBeDefined();
		expect(item).toMatchObject({
			severity: "warning",
			title: "Sonarr Main: library sync is stale",
			action: { kind: "library.sync", target: { instanceId: "inst-1" } },
		});
	});

	it("stays quiet for a fresh row", async () => {
		syncStatuses = [makeRow({ lastFullSync: new Date(Date.now() - 10 * 60 * 1000) })];

		expect(await getItems()).toEqual([]);
	});

	it("respects the 1-hour floor for short polling intervals", async () => {
		// 5-min interval → 3× = 15min, but the floor is 1h. A 30-min-old sync
		// must NOT flag even though it exceeds 3× the interval.
		syncStatuses = [
			makeRow({ pollingIntervalMins: 5, lastFullSync: new Date(Date.now() - 30 * 60 * 1000) }),
		];

		expect(await getItems()).toEqual([]);
	});

	it("scales the threshold for long polling intervals (24h interval, 48h-old sync is fine)", async () => {
		// 1440-min interval → threshold 72h. 48h-old sync is within budget.
		syncStatuses = [
			makeRow({ pollingIntervalMins: 1440, lastFullSync: new Date(Date.now() - 48 * HOURS) }),
		];

		expect(await getItems()).toEqual([]);
	});

	it("gates by omission when polling is disabled (operator opted out)", async () => {
		syncStatuses = [
			makeRow({ pollingEnabled: false, lastFullSync: new Date(Date.now() - 100 * HOURS) }),
		];

		expect(await getItems()).toEqual([]);
	});

	it("stays quiet while a sync is in progress", async () => {
		syncStatuses = [
			makeRow({ syncInProgress: true, lastFullSync: new Date(Date.now() - 24 * HOURS) }),
		];

		expect(await getItems()).toEqual([]);
	});

	it("uses createdAt as the staleness reference for never-synced instances", async () => {
		// Old row, never synced, not in progress → honest "never completed" row.
		syncStatuses = [makeRow({ lastFullSync: null })];

		const items = await getItems();
		const item = items.find((i) => i.id === "library-sync-stale-inst-1");

		expect(item).toBeDefined();
		expect(item).toMatchObject({
			detail: "This instance has never completed a library sync.",
		});
	});

	it("stays quiet for a brand-new never-synced instance (createdAt within threshold)", async () => {
		syncStatuses = [
			makeRow({ lastFullSync: null, createdAt: new Date(Date.now() - 10 * 60 * 1000) }),
		];

		expect(await getItems()).toEqual([]);
	});
});
