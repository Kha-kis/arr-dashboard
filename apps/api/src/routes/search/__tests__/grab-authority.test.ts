import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Encryptor } from "../../../lib/auth/encryption.js";
import { createSearchGrabRepository } from "../../../lib/search/grab-repository.js";
import { issueSearchGrabSelector } from "../../../lib/search/grab-selector.js";
import { createNativeGrabFixture } from "./grab-native.fixture.js";

describe("registered durable Grab authority on actual native storage and SDK", () => {
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
	const send = (payload: object = fixture.request()) =>
		fixture.app.inject({ method: "POST", url: "/api/search/grab", payload });
	it("admits provenance from the actual query and commits before one POST/204", async () => {
		const query = await fixture.app.inject({
			method: "POST",
			url: "/api/search/query",
			payload: { query: "synthetic" },
		});
		expect(query.statusCode).toBe(200);
		const row = query.json().aggregated[0];
		const response = await send({
			instanceId: row.instanceId,
			selector: row.grabSelector,
			intentId: randomUUID(),
		});
		expect(response.statusCode).toBe(204);
		expect(response.body).toBe("");
		expect(fixture.posts).toEqual([{ guid: fixture.guid, indexerId: 7 }]);
		expect(fixture.markers).toEqual([true]);
		expect((await fixture.attempts())[0]?.state).toBe("acknowledged");
		expect(await fixture.holds()).toBe(0);
	});
	it("refuses the legacy raw result even for an owned enabled connection", async () => {
		expect(
			(await send({ instanceId: fixture.instance.id, result: fixture.release })).statusCode,
		).toBe(400);
		expect(fixture.posts).toEqual([]);
		expect(await fixture.attempts()).toEqual([]);
	});
	it.each(["forged", "expired", "disabled", "foreign", "replaced", "wrong-service"])(
		"refuses %s authority with zero dispatch",
		async (kind) => {
			const payload = fixture.request();
			if (kind === "forged") payload.selector = "sg1.invalid.forged";
			if (kind === "expired")
				payload.selector = fixture.request(payload.intentId, Date.now() - 1_800_001).selector;
			if (kind === "foreign")
				payload.selector = issueSearchGrabSelector(fixture.encryptor, {
					...fixture.target(),
					userId: randomUUID(),
				});
			if (["disabled", "replaced", "wrong-service"].includes(kind))
				await fixture.run(() =>
					fixture.native.prisma.serviceInstance.updateMany({
						where: { userId: fixture.user.id, id: fixture.instance.id },
						data:
							kind === "disabled"
								? { enabled: false }
								: kind === "replaced"
									? { baseUrl: "http://127.0.0.1:1" }
									: { service: "RADARR" },
					}),
				);
			expect((await send(payload)).statusCode).toBeGreaterThanOrEqual(400);
			expect(fixture.posts).toEqual([]);
			expect(await fixture.attempts()).toEqual([]);
		},
	);
	it("denies unauthenticated submission and status before dispatch", async () => {
		const payload = fixture.request();
		fixture.authenticated = false;
		expect((await send(payload)).statusCode).toBe(401);
		expect(
			(
				await fixture.app.inject({
					method: "GET",
					url: `/api/search/grab/intents/${payload.intentId}`,
				})
			).statusCode,
		).toBe(401);
		expect(fixture.posts).toEqual([]);
		expect(await fixture.attempts()).toEqual([]);
	});
	it("observes ACK by same-intent replay and selector-free read without another POST", async () => {
		const payload = fixture.request();
		expect((await send(payload)).statusCode).toBe(204);
		expect((await send(payload)).statusCode).toBe(204);
		const before = await fixture.attempts(),
			response = await fixture.app.inject({
				method: "GET",
				url: `/api/search/grab/intents/${payload.intentId}`,
			});
		expect(response.statusCode).toBe(200);
		expect(response.json()).toMatchObject({
			intentId: payload.intentId,
			state: "acknowledged",
			nextAction: "none",
		});
		for (const value of [payload.selector, fixture.guid, fixture.user.id, fixture.instance.id])
			expect(response.body).not.toContain(value);
		expect(await fixture.attempts()).toEqual(before);
		expect(fixture.posts).toHaveLength(1);
	});
	it("refuses a changed target on replay without an extra POST", async () => {
		const payload = fixture.request();
		expect((await send(payload)).statusCode).toBe(204);
		const selector = issueSearchGrabSelector(fixture.encryptor, {
			...fixture.target(),
			guid: "synthetic:other",
		});
		expect((await send({ ...payload, selector })).statusCode).toBe(409);
		expect(fixture.posts).toHaveLength(1);
	});
	it("missing status is unavailable, never success", async () => {
		const response = await fixture.app.inject({
			method: "GET",
			url: `/api/search/grab/intents/${randomUUID()}`,
		});
		expect(response.statusCode).toBe(404);
		expect(fixture.posts).toEqual([]);
		expect(await fixture.attempts()).toEqual([]);
	});
	it("another owner's intent is not readable", async () => {
		const payload = fixture.request();
		expect((await send(payload)).statusCode).toBe(204);
		await fixture.closeCase();
		await fixture.reset();
		expect(
			(
				await fixture.app.inject({
					method: "GET",
					url: `/api/search/grab/intents/${payload.intentId}`,
				})
			).statusCode,
		).toBe(404);
		expect(fixture.posts).toEqual([]);
	});
	it("malformed status identity refuses without a write or send", async () => {
		const response = await fixture.app.inject({
			method: "GET",
			url: "/api/search/grab/intents/not-an-intent",
		});
		expect(response.statusCode).toBe(400);
		expect(await fixture.attempts()).toEqual([]);
		expect(fixture.posts).toEqual([]);
	});
	it("reports a durably prepared intent as202 without dispatching it", async () => {
		const payload = fixture.request();
		const repository = createSearchGrabRepository(
			fixture.native.prisma,
			fixture.runtime,
			fixture.encryptor,
			fixture.user.id,
		);
		await fixture.run(() =>
			repository.admit({ intentId: payload.intentId, target: fixture.target() }),
		);
		const before = await fixture.attempts();
		const response = await send(payload);
		expect(response.statusCode).toBe(202);
		expect(response.json().status).toMatchObject({
			state: "prepared",
			dispatchedAt: null,
			completedAt: null,
			nextAction: "observe-status",
		});
		const observed = await fixture.app.inject({
			method: "GET",
			url: `/api/search/grab/intents/${payload.intentId}`,
		});
		expect(observed.statusCode).toBe(200);
		expect(observed.json()).toMatchObject({ state: "prepared", nextAction: "observe-status" });
		expect(await fixture.attempts()).toEqual(before);
		expect(await fixture.holds()).toBe(1);
		expect(fixture.posts).toEqual([]);
	});
	it("an expired selector observes its recorded intent but cannot admit a new send", async () => {
		const payload = fixture.request();
		expect((await send(payload)).statusCode).toBe(204);
		const expired = fixture.request(payload.intentId, Date.now() - 1_800_001);
		expect((await send(expired)).statusCode).toBe(204);
		expect((await send({ ...expired, intentId: randomUUID() })).statusCode).toBe(409);
		expect(await fixture.attempts()).toHaveLength(1);
		expect(fixture.posts).toHaveLength(1);
	});
	it("selector-free status survives an encryption-key change while replay refuses", async () => {
		const payload = fixture.request();
		expect((await send(payload)).statusCode).toBe(204);
		fixture.app.encryptor = new Encryptor("88".repeat(32));
		expect((await send(payload)).statusCode).toBe(409);
		const response = await fixture.app.inject({
			method: "GET",
			url: `/api/search/grab/intents/${payload.intentId}`,
		});
		expect(response.statusCode).toBe(200);
		expect(response.json()).toMatchObject({ state: "acknowledged", nextAction: "none" });
		expect(fixture.posts).toHaveLength(1);
	});
	it("an invalid stored outcome category makes status unavailable without private diagnostics", async () => {
		const payload = fixture.request();
		expect((await send(payload)).statusCode).toBe(204);
		await fixture.run(() =>
			fixture.native.prisma.searchGrabAttempt.updateMany({
				where: { userId: fixture.user.id, intentId: payload.intentId },
				data: { outcomeCategory: "SYNTHETIC_PRIVATE_STATUS_DIAGNOSTIC" },
			}),
		);
		const before = await fixture.attempts();
		const response = await fixture.app.inject({
			method: "GET",
			url: `/api/search/grab/intents/${payload.intentId}`,
		});
		expect(response.statusCode).toBe(502);
		expect(response.json().category).toBe("status-unavailable");
		expect(response.body).not.toContain("SYNTHETIC_PRIVATE_STATUS_DIAGNOSTIC");
		expect(await fixture.attempts()).toEqual(before);
		expect(fixture.posts).toHaveLength(1);
	});
});
