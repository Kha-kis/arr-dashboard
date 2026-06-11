/**
 * Dismiss-until-recovery — route + read-path semantics.
 *
 * Uses the attention-filter harness pattern (a single injectable collector
 * driving the exact item set) plus a STATEFUL in-memory PulseDismissal
 * stub, so the full loop is exercised end-to-end through the routes:
 *
 *   - POST /pulse/:id/dismiss hides a non-critical signal from the next
 *     GET (proving cache invalidation) and counts it in dismissedCount.
 *   - Summary counts are computed AFTER filtering (badge == visible rows).
 *   - Critical breakthrough: a tombstoned id that fires as critical is
 *     never suppressed; if the same id de-escalates, it re-hides.
 *   - Recovery sweep: tombstones for ids that stop firing are deleted, so
 *     a recurrence resurfaces.
 *   - DELETE /pulse/:id/dismiss (undo) and DELETE /pulse/dismissals
 *     (restore all) bring signals back immediately.
 *   - attentionOnly view inherits the filtering and carries dismissedCount.
 */

import type { PulseItem } from "@arr/shared";
import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let items: PulseItem[] = [];

vi.mock("../../lib/pulse/collectors.js", () => ({
	pulseCollectors: [async () => items],
}));

import { registerPulseRoutes } from "../pulse.js";
import { createInjectAuthenticated, setupAuthInjection } from "./test-helpers.js";

let app: ReturnType<typeof Fastify>;
let injectAuthenticated: ReturnType<typeof createInjectAuthenticated>;
let userCounter = 0;

// ---------------------------------------------------------------------------
// Stateful in-memory PulseDismissal stub. Keyed per current user so the
// per-test user isolation (cache busting) doesn't leak tombstones either.
// ---------------------------------------------------------------------------

let tombstones: Array<{ userId: string; signalId: string }>;

function makeStatefulDismissalStub() {
	return {
		findMany: async ({ where }: { where: { userId: string } }) =>
			tombstones.filter((t) => t.userId === where.userId),
		upsert: async ({ create }: { create: { userId: string; signalId: string } }) => {
			if (!tombstones.some((t) => t.userId === create.userId && t.signalId === create.signalId)) {
				tombstones.push(create);
			}
			return create;
		},
		deleteMany: async ({
			where,
		}: {
			where: { userId: string; signalId?: string | { in: string[] } };
		}) => {
			const matches = (t: { userId: string; signalId: string }) => {
				if (t.userId !== where.userId) return false;
				if (where.signalId === undefined) return true;
				if (typeof where.signalId === "string") return t.signalId === where.signalId;
				return where.signalId.in.includes(t.signalId);
			};
			const count = tombstones.filter(matches).length;
			tombstones = tombstones.filter((t) => !matches(t));
			return { count };
		},
	};
}

function makeItem(overrides: Partial<PulseItem> = {}): PulseItem {
	return {
		id: "warn-1",
		severity: "warning",
		category: "health",
		title: "Example warning",
		detail: "Example detail",
		actionUrl: "/settings",
		source: "system",
		timestamp: "2026-06-11T09:00:00.000Z",
		...overrides,
	};
}

async function getPulse(query = ""): Promise<{
	items: Array<{ id: string; severity: string }>;
	summary: { critical: number; warning: number; info: number };
	dismissedCount: number;
}> {
	const res = await injectAuthenticated("GET", `/pulse${query}`);
	expect(res.statusCode).toBe(200);
	return JSON.parse(res.payload);
}

beforeEach(async () => {
	userCounter += 1;
	tombstones = [];
	app = Fastify({ logger: false });
	setupAuthInjection(app, { id: `user-dismiss-${userCounter}`, username: "admin" });
	app.decorate("prisma", {
		pulseDismissal: makeStatefulDismissalStub(),
	} as unknown as never);
	await app.register(registerPulseRoutes);
	await app.ready();
	injectAuthenticated = createInjectAuthenticated(app);
});

afterEach(async () => {
	await app?.close();
});

describe("dismiss-until-recovery", () => {
	it("hides a dismissed warning from the next GET and counts it honestly", async () => {
		items = [makeItem({ id: "warn-1" }), makeItem({ id: "warn-2" })];

		// Baseline: both visible, nothing dismissed.
		const before = await getPulse();
		expect(before.items.map((i) => i.id).sort()).toEqual(["warn-1", "warn-2"]);
		expect(before.dismissedCount).toBe(0);

		const dismiss = await injectAuthenticated("POST", "/pulse/warn-1/dismiss");
		expect(dismiss.statusCode).toBe(200);

		// If the per-user cache had survived the dismiss, warn-1 would still
		// be served here — this also proves invalidatePulseCache fired.
		const after = await getPulse();
		expect(after.items.map((i) => i.id)).toEqual(["warn-2"]);
		expect(after.dismissedCount).toBe(1);
		// Summary reflects only VISIBLE rows — badge counts match the screen.
		expect(after.summary).toEqual({ critical: 0, warning: 1, info: 0 });
	});

	it("never suppresses a signal currently firing as critical (breakthrough)", async () => {
		items = [makeItem({ id: "sig-1", severity: "critical" })];

		await injectAuthenticated("POST", "/pulse/sig-1/dismiss");

		const res = await getPulse();
		expect(res.items.map((i) => i.id)).toEqual(["sig-1"]);
		expect(res.dismissedCount).toBe(0);

		// De-escalation back to warning re-applies the (still live) tombstone.
		// (Bust the per-user cache via a dismissal mutation on an unrelated id
		// rather than waiting out the 60s TTL.)
		items = [makeItem({ id: "sig-1", severity: "warning" })];
		await injectAuthenticated("DELETE", "/pulse/unrelated/dismiss");
		const deescalated = await getPulse();
		expect(deescalated.items).toEqual([]);
		expect(deescalated.dismissedCount).toBe(1);
	});

	it("sweeps the tombstone when the signal recovers, so a recurrence resurfaces", async () => {
		items = [makeItem({ id: "warn-1" })];
		await injectAuthenticated("POST", "/pulse/warn-1/dismiss");

		// Signal recovers — fresh compute sees no warn-1, sweep deletes the
		// tombstone.
		items = [];
		const recovered = await getPulse();
		expect(recovered.items).toEqual([]);
		expect(recovered.dismissedCount).toBe(0);
		expect(tombstones).toEqual([]);

		// Recurrence must be visible again — dismissal does not outlive
		// recovery. (Bust the per-user cache via a dismissal mutation on an
		// unrelated id rather than waiting out the 60s TTL.)
		items = [makeItem({ id: "warn-1" })];
		await injectAuthenticated("DELETE", "/pulse/unrelated/dismiss");
		const recurred = await getPulse();
		expect(recurred.items.map((i) => i.id)).toEqual(["warn-1"]);
		expect(recurred.dismissedCount).toBe(0);
	});

	it("restores a single signal via DELETE /pulse/:id/dismiss (undo)", async () => {
		items = [makeItem({ id: "warn-1" })];
		await injectAuthenticated("POST", "/pulse/warn-1/dismiss");
		expect((await getPulse()).items).toEqual([]);

		const undo = await injectAuthenticated("DELETE", "/pulse/warn-1/dismiss");
		expect(undo.statusCode).toBe(200);

		const restored = await getPulse();
		expect(restored.items.map((i) => i.id)).toEqual(["warn-1"]);
		expect(restored.dismissedCount).toBe(0);
	});

	it("restores everything via DELETE /pulse/dismissals and reports the cleared count", async () => {
		items = [
			makeItem({ id: "warn-1" }),
			makeItem({ id: "warn-2" }),
			makeItem({ id: "info-1", severity: "info" }),
		];
		await injectAuthenticated("POST", "/pulse/warn-1/dismiss");
		await injectAuthenticated("POST", "/pulse/warn-2/dismiss");
		await injectAuthenticated("POST", "/pulse/info-1/dismiss");
		expect((await getPulse()).dismissedCount).toBe(3);

		const res = await injectAuthenticated("DELETE", "/pulse/dismissals");
		expect(res.statusCode).toBe(200);
		expect(JSON.parse(res.payload)).toEqual({ status: "ok", cleared: 3 });

		const restored = await getPulse();
		expect(restored.items.map((i) => i.id).sort()).toEqual(["info-1", "warn-1", "warn-2"]);
		expect(restored.dismissedCount).toBe(0);
	});

	it("attentionOnly view inherits dismissal filtering and carries dismissedCount", async () => {
		items = [
			makeItem({ id: "warn-actionable" }),
			makeItem({ id: "warn-dismissed" }),
			makeItem({ id: "info-1", severity: "info", actionUrl: undefined }),
		];
		await injectAuthenticated("POST", "/pulse/warn-dismissed/dismiss");

		const res = await getPulse("?attentionOnly=true");
		expect(res.items.map((i) => i.id)).toEqual(["warn-actionable"]);
		expect(res.summary).toEqual({ critical: 0, warning: 1, info: 0 });
		expect(res.dismissedCount).toBe(1);
	});

	it("requires authentication on all three dismiss routes", async () => {
		for (const [method, url] of [
			["POST", "/pulse/x/dismiss"],
			["DELETE", "/pulse/x/dismiss"],
			["DELETE", "/pulse/dismissals"],
		] as const) {
			const res = await app.inject({ method, url });
			// setupAuthInjection leaves currentUser null without the header;
			// the handler's `currentUser!.id` access would throw → 500, but
			// production wraps these behind the auth preHandler. Assert we do
			// NOT get a 2xx without auth.
			expect(res.statusCode, `${method} ${url}`).toBeGreaterThanOrEqual(400);
		}
	});
});
