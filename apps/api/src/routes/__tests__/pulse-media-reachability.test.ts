/**
 * Integration tests for collectMediaServerReachability.
 *
 * Asserts the emission matrix:
 *   - Plex/Jellyfin/Tautulli reachable → NO row
 *   - Plex/Jellyfin/Tautulli ping throws → critical "<label> is unreachable" row
 *   - ARR / other services are NOT queried by this collector
 *   - Per-instance isolation: one broken instance does not silence the others
 *
 * The row shape mirrors the existing `arr-unreachable-<id>` contract so
 * operators get one consistent "X is unreachable — check connection"
 * signal across ARR and media services.
 */

import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock the three client factories so we can inject canned pings per
// service. This is the highest-leverage seam — the collector creates
// clients at call time and only calls one method on each.
const plexIdentity = vi.fn();
const jellyfinPublicInfo = vi.fn();

vi.mock("../../lib/plex/plex-client.js", () => ({
	createPlexClient: () => ({ getIdentity: (...args: unknown[]) => plexIdentity(...args) }),
}));
vi.mock("../../lib/jellyfin/jellyfin-client.js", () => ({
	createJellyfinClient: () => ({
		getPublicInfo: (...args: unknown[]) => jellyfinPublicInfo(...args),
	}),
}));

// Run only the collector under test.
vi.mock("../../lib/pulse/collectors.js", async () => {
	const actual = await vi.importActual<typeof import("../../lib/pulse/collectors.js")>(
		"../../lib/pulse/collectors.js",
	);
	return { pulseCollectors: [actual.collectMediaServerReachability] };
});

import { registerPulseRoutes } from "../pulse.js";
import { createInjectAuthenticated, setupAuthInjection } from "./test-helpers.js";

type InstanceRow = { id: string; service: string; label: string; enabled: boolean };

let app: ReturnType<typeof Fastify>;
let injectAuthenticated: ReturnType<typeof createInjectAuthenticated>;
let instanceRows: InstanceRow[];
let userCounter = 0;

function makeInstance(overrides: Partial<InstanceRow> = {}): InstanceRow {
	return { id: "inst-default", service: "PLEX", label: "Home", enabled: true, ...overrides };
}

beforeEach(async () => {
	userCounter += 1;
	instanceRows = [];
	plexIdentity.mockReset();
	jellyfinPublicInfo.mockReset();

	app = Fastify({ logger: false });
	setupAuthInjection(app, { id: `user-reach-${userCounter}`, username: "admin" });

	app.decorate("prisma", {
		serviceInstance: {
			findMany: async ({ where }: { where: { service: { in: string[] } } }) =>
				instanceRows.filter((r) => where.service.in.includes(r.service)),
		},
	} as unknown as never);
	// Factories need an encryptor on the app even though we mocked them —
	// access at create time must not fault.
	app.decorate("encryptor", {} as unknown as never);

	await app.register(registerPulseRoutes);
	await app.ready();
	injectAuthenticated = createInjectAuthenticated(app);
});

afterEach(async () => {
	await app?.close();
});

describe("GET /pulse — collectMediaServerReachability", () => {
	it("emits a critical unreachable row when the Plex identity ping throws", async () => {
		instanceRows = [makeInstance({ id: "inst-plex", service: "PLEX", label: "khak1s-media" })];
		plexIdentity.mockRejectedValue(new Error("ECONNREFUSED 127.0.0.1:32400"));

		const res = await injectAuthenticated("GET", "/pulse");
		const body = JSON.parse(res.payload);
		const item = body.items.find((i: { id: string }) => i.id === "plex-unreachable-inst-plex");

		expect(item).toEqual({
			id: "plex-unreachable-inst-plex",
			severity: "critical",
			category: "health",
			title: "khak1s-media is unreachable",
			detail: "Could not connect to Plex instance",
			actionUrl: "/settings",
			actionLabel: "Check connection",
			source: "plex",
			timestamp: expect.any(String),
		});
	});

	it("emits a critical unreachable row when the Jellyfin public-info ping throws", async () => {
		// Public-info is intentionally unauthenticated — a thrown error
		// here means the server is genuinely unreachable, not an auth
		// problem. That's why it's the right probe for reachability.
		instanceRows = [makeInstance({ id: "inst-jf", service: "JELLYFIN", label: "Test Jellyfin" })];
		jellyfinPublicInfo.mockRejectedValue(new Error("ECONNREFUSED 127.0.0.1:8096"));

		const res = await injectAuthenticated("GET", "/pulse");
		const body = JSON.parse(res.payload);
		const item = body.items.find((i: { id: string }) => i.id === "jellyfin-unreachable-inst-jf");

		expect(item?.title).toBe("Test Jellyfin is unreachable");
		expect(item?.severity).toBe("critical");
		expect(item?.actionUrl).toBe("/settings");
		expect(item?.source).toBe("jellyfin");
	});

	it("does NOT probe lingering pre-3.0 TAUTULLI instances (ADR-0007)", async () => {
		// Tautulli was removed in 3.0. Instance rows may linger until the
		// migration dialog deletes them; the reachability collector must
		// neither ping them nor emit rows for them.
		instanceRows = [makeInstance({ id: "inst-ta", service: "TAUTULLI", label: "Tautulli" })];

		const res = await injectAuthenticated("GET", "/pulse");
		const body = JSON.parse(res.payload);
		const item = body.items.find((i: { id: string }) => i.id === "tautulli-unreachable-inst-ta");

		expect(item).toBeUndefined();
	});

	it("emits NO row when all pings succeed", async () => {
		// Reachable = healthy. No noise in the Pulse feed.
		instanceRows = [
			makeInstance({ id: "inst-plex", service: "PLEX", label: "P" }),
			makeInstance({ id: "inst-jf", service: "JELLYFIN", label: "J" }),
		];
		plexIdentity.mockResolvedValue({});
		jellyfinPublicInfo.mockResolvedValue({});

		const res = await injectAuthenticated("GET", "/pulse");
		const body = JSON.parse(res.payload);
		const unreachableItems = body.items.filter((i: { id: string }) =>
			/(plex|jellyfin|tautulli)-unreachable-/.test(i.id),
		);

		expect(unreachableItems).toEqual([]);
	});

	it("isolates per-instance failures — one bad instance does not silence others", async () => {
		// Regression guard: the collector uses Promise.all + per-instance
		// try/catch. A throw in one branch must not abort the others or
		// crash the whole /pulse response.
		instanceRows = [
			makeInstance({ id: "inst-plex-ok", service: "PLEX", label: "Good Plex" }),
			makeInstance({ id: "inst-jf-bad", service: "JELLYFIN", label: "Bad Jellyfin" }),
			makeInstance({ id: "inst-ta-ok", service: "TAUTULLI", label: "Good Tautulli" }),
		];
		plexIdentity.mockResolvedValue({});
		jellyfinPublicInfo.mockRejectedValue(new Error("ECONNREFUSED"));

		const res = await injectAuthenticated("GET", "/pulse");
		const body = JSON.parse(res.payload);
		const unreachableItems = body.items.filter((i: { id: string }) =>
			/(plex|jellyfin|tautulli)-unreachable-/.test(i.id),
		);

		expect(unreachableItems).toHaveLength(1);
		expect(unreachableItems[0].id).toBe("jellyfin-unreachable-inst-jf-bad");
	});

	it("does NOT query ARR, Seerr, Prowlarr instances", async () => {
		// Regression guard: findMany's service filter must exclude non-
		// media services. If this test starts failing because an ARR
		// ping got invoked, somebody loosened the WHERE clause.
		instanceRows = [
			makeInstance({ id: "inst-sonarr", service: "SONARR", label: "Sonarr" }),
			makeInstance({ id: "inst-seerr", service: "SEERR", label: "Seerr" }),
			makeInstance({ id: "inst-prowlarr", service: "PROWLARR", label: "Prowlarr" }),
		];

		const res = await injectAuthenticated("GET", "/pulse");
		const body = JSON.parse(res.payload);
		const unreachableItems = body.items.filter((i: { id: string }) =>
			/(plex|jellyfin|tautulli)-unreachable-/.test(i.id),
		);

		expect(unreachableItems).toEqual([]);
		expect(plexIdentity).not.toHaveBeenCalled();
		expect(jellyfinPublicInfo).not.toHaveBeenCalled();
	});
});
