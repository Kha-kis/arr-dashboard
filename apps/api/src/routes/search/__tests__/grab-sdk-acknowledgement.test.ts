import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createNativeGrabFixture } from "./grab-native.fixture.js";

describe("registered durable Grab exact SDK acknowledgement and recovery", () => {
	let fixture: Awaited<ReturnType<typeof createNativeGrabFixture>>;
	beforeAll(async () => {
		fixture = await createNativeGrabFixture();
	}, 30000);
	beforeEach(async () => {
		await fixture.reset();
	});
	afterEach(async () => {
		await fixture.closeCase();
	});
	afterAll(async () => {
		await fixture?.close();
	});
	const send = (payload = fixture.request()) =>
		fixture.app.inject({ method: "POST", url: "/api/search/grab", payload });
	it.each([
		["different GUID", { guid: "synthetic:other", indexerId: 7 }],
		["different indexer", { guid: "synthetic:opaque/東京?exact=1", indexerId: 8 }],
		["missing identity", {}],
		["null", null],
		["array", []],
		["string indexer", { guid: "synthetic:opaque/東京?exact=1", indexerId: "7" }],
		["numeric GUID", { guid: 7, indexerId: 7 }],
	])("keeps %s unknown, held and unreplayed", async (_label, body) => {
		fixture.reply = { status: 200, body, contentType: "application/json", lost: false };
		const payload = fixture.request(),
			response = await send(payload);
		expect(response.statusCode).toBe(502);
		expect(response.json().status.state).toBe("uncertain");
		expect(await fixture.holds()).toBe(1);
		expect((await send(payload)).statusCode).toBe(502);
		expect(fixture.posts).toEqual([{ guid: fixture.guid, indexerId: 7 }]);
		expect(fixture.markers).toEqual([true]);
	});
	it.each(["HTML", "empty"])("refuses %s as acknowledgement", async (kind) => {
		fixture.reply = {
			status: kind === "HTML" ? 200 : 204,
			body: "Synthetic private diagnostic",
			contentType: "text/html",
			lost: false,
		};
		const response = await send();
		expect(response.statusCode).toBe(502);
		expect(response.body).not.toContain("Synthetic private diagnostic");
		expect(await fixture.holds()).toBe(1);
		expect(fixture.posts).toHaveLength(1);
	});
	it.each([400, 404, 409, 408, 429, 500, 503])(
		"distinguishes HTTP %i without diagnostic leaks or replay",
		async (status) => {
			fixture.reply = {
				status,
				body: { message: "SYNTHETIC_PRIVATE_PROVIDER_DIAGNOSTIC" },
				contentType: "application/json",
				lost: false,
			};
			const response = await send(),
				rejected = [400, 404, 409].includes(status);
			expect(response.statusCode).toBe(rejected ? 422 : 502);
			expect(response.json().status.state).toBe(rejected ? "rejected" : "uncertain");
			expect(response.body).not.toContain("SYNTHETIC_PRIVATE_PROVIDER_DIAGNOSTIC");
			expect(await fixture.holds()).toBe(rejected ? 0 : 1);
			expect(fixture.posts).toHaveLength(1);
		},
	);
	it("holds a lost reply and replay only observes", async () => {
		fixture.reply = { status: 200, body: null, contentType: "application/json", lost: true };
		const payload = fixture.request();
		expect((await send(payload)).statusCode).toBe(502);
		expect((await send(payload)).statusCode).toBe(502);
		expect(fixture.posts).toHaveLength(1);
		expect(await fixture.holds()).toBe(1);
	});
	it("in-flight replay and GET observe submitting without an additional POST", async () => {
		const payload = fixture.request(),
			held = fixture.holdNextReply();
		const pending = Promise.resolve(send(payload));
		try {
			await held.arrived;
			const response = await send(payload);
			expect(response.statusCode).toBe(202);
			expect(response.json().status).toMatchObject({
				state: "submitting",
				nextAction: "observe-status",
				completedAt: null,
			});
			const observed = await fixture.app.inject({
				method: "GET",
				url: `/api/search/grab/intents/${payload.intentId}`,
			});
			expect(observed.statusCode).toBe(200);
			expect(observed.json().state).toBe("submitting");
			expect(await fixture.holds()).toBe(1);
			expect(fixture.posts).toHaveLength(1);
		} finally {
			held.release();
		}
		expect((await pending).statusCode).toBe(204);
		expect(await fixture.holds()).toBe(0);
	});
	it("requires explicit confirmed successor and replay preserves the original uncertainty", async () => {
		fixture.reply = { status: 200, body: null, contentType: "application/json", lost: true };
		const original = fixture.request();
		const uncertain = await send(original);
		expect(uncertain.statusCode).toBe(502);
		const predecessorId = uncertain.json().status.attemptId;
		const successor = fixture.request(randomUUID());
		expect((await send(successor)).statusCode).toBe(409);
		expect(
			(
				await fixture.app.inject({
					method: "POST",
					url: "/api/search/grab",
					payload: {
						...successor,
						retry: { predecessorId, duplicateRiskConfirmed: false },
					},
				})
			).statusCode,
		).toBe(400);
		expect(fixture.posts).toHaveLength(1);
		fixture.reply = {
			status: 200,
			body: { guid: fixture.guid, indexerId: 7 },
			contentType: "application/json",
			lost: false,
		};
		const confirmed = {
			...successor,
			retry: { predecessorId, duplicateRiskConfirmed: true as const },
		};
		expect((await send(confirmed)).statusCode).toBe(204);
		expect((await send(confirmed)).statusCode).toBe(204);
		const rows = await fixture.attempts();
		expect(rows).toHaveLength(2);
		expect(rows.find((row) => row.intentId === original.intentId)?.state).toBe("uncertain");
		expect(rows.find((row) => row.intentId === successor.intentId)?.state).toBe("acknowledged");
		expect(await fixture.holds()).toBe(0);
		expect(fixture.posts).toHaveLength(2);
		expect(fixture.markers).toEqual([true, true]);
	});
	it("never returns204 or releases the hold when ACK persistence fails", async () => {
		const postgres = fixture.engine === "postgresql";
		if (postgres)
			await fixture.run(() =>
				fixture.native.prisma.$executeRawUnsafe(
					`CREATE OR REPLACE FUNCTION synthetic_route_ack_fault_fn() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW."state" = 'acknowledged' THEN RAISE EXCEPTION 'synthetic fault'; END IF; RETURN NEW; END $$`,
				),
			);
		await fixture.run(() =>
			fixture.native.prisma.$executeRawUnsafe(
				postgres
					? `CREATE TRIGGER synthetic_route_ack_fault BEFORE UPDATE ON "SearchGrabAttempt" FOR EACH ROW EXECUTE FUNCTION synthetic_route_ack_fault_fn()`
					: `CREATE TRIGGER synthetic_route_ack_fault BEFORE UPDATE ON "SearchGrabAttempt" WHEN NEW."state" = 'acknowledged' BEGIN SELECT RAISE(ABORT, 'synthetic fault'); END`,
			),
		);
		try {
			const payload = fixture.request();
			expect((await send(payload)).statusCode).toBe(502);
			expect(fixture.posts).toHaveLength(1);
			expect(await fixture.holds()).toBe(1);
			expect((await fixture.attempts())[0]?.state).toBe("submitting");
			const observed = await fixture.app.inject({
				method: "GET",
				url: `/api/search/grab/intents/${payload.intentId}`,
			});
			expect(observed.statusCode).toBe(200);
			expect(observed.json().state).toBe("submitting");
			expect(fixture.posts).toHaveLength(1);
		} finally {
			await fixture.run(() =>
				fixture.native.prisma.$executeRawUnsafe(
					postgres
						? 'DROP TRIGGER "synthetic_route_ack_fault" ON "SearchGrabAttempt"'
						: 'DROP TRIGGER "synthetic_route_ack_fault"',
				),
			);
			if (postgres)
				await fixture.run(() =>
					fixture.native.prisma.$executeRawUnsafe("DROP FUNCTION synthetic_route_ack_fault_fn()"),
				);
		}
	});
});
