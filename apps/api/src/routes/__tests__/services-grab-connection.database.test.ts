import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createSearchGrabRepository } from "../../lib/search/grab-repository.js";
import { createNativeGrabFixture } from "../search/__tests__/grab-native.fixture.js";

describe("registered connection mutation versus native durable Grab", () => {
	let fixture: Awaited<ReturnType<typeof createNativeGrabFixture>>;
	beforeAll(async () => {
		fixture = await createNativeGrabFixture({ services: true });
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
	const connection = () =>
		fixture.run(() =>
			fixture.native.prisma.serviceInstance.findFirst({
				where: { id: fixture.instance.id, userId: fixture.user.id },
			}),
		);
	const edit = (payload: object) =>
		fixture.app.inject({ method: "PUT", url: `/api/services/${fixture.instance.id}`, payload });
	const remove = () =>
		fixture.app.inject({ method: "DELETE", url: `/api/services/${fixture.instance.id}` });
	const submit = (payload = fixture.request()) =>
		fixture.app.inject({ method: "POST", url: "/api/search/grab", payload });
	async function record(state: "prepared" | "submitting" | "uncertain") {
		const repository = createSearchGrabRepository(
			fixture.native.prisma,
			fixture.runtime,
			fixture.encryptor,
			fixture.user.id,
		);
		return fixture.run(async () => {
			const admission = await repository.admit({
				intentId: randomUUID(),
				target: fixture.target(),
			});
			if (state !== "prepared") await repository.claimDispatch(admission.attempt.id);
			if (state === "uncertain")
				await repository.settle(admission.attempt.id, "uncertain", "transport-unconfirmed");
			return admission.attempt.id;
		});
	}
	it.each([
		["URL", { baseUrl: "http://127.0.0.1:1" }],
		["replacement key", { apiKey: "synthetic-replacement-key" }],
		["proxy credentials", { httpAuth: { username: "synthetic", password: "synthetic" } }],
		["service family", { service: "qui" }],
	])("refuses held %s identity edits without modifying safety state", async (_kind, payload) => {
		await record("uncertain");
		const before = await connection(),
			attempts = await fixture.attempts();
		const response = await edit(payload);
		expect(response.statusCode).toBe(409);
		expect(await connection()).toEqual(before);
		expect(await fixture.attempts()).toEqual(attempts);
		expect(await fixture.holds()).toBe(1);
		expect(fixture.posts).toEqual([]);
		expect(response.body).not.toContain(fixture.guid);
	});
	it.each(["prepared", "submitting", "uncertain"] as const)(
		"%s claim blocks deletion with an actionable conflict, not a cascading loss",
		async (state) => {
			await record(state);
			const before = await connection(),
				attempts = await fixture.attempts();
			expect((await remove()).statusCode).toBe(409);
			expect(await connection()).toEqual(before);
			expect(await fixture.attempts()).toEqual(attempts);
			expect(await fixture.holds()).toBe(1);
			expect(fixture.posts).toEqual([]);
		},
	);
	it.each(["prepared", "submitting"] as const)(
		"%s claim also blocks identity edits before uncertainty settlement",
		async (state) => {
			await record(state);
			const before = await connection();
			expect((await edit({ baseUrl: "http://127.0.0.1:1" })).statusCode).toBe(409);
			expect(await connection()).toEqual(before);
			expect(await fixture.holds()).toBe(1);
			expect(fixture.posts).toEqual([]);
		},
	);
	it("allows presentation/default/tag edits while retaining the exact unresolved attempt", async () => {
		await record("uncertain");
		const attempts = await fixture.attempts();
		const response = await edit({
			label: "Updated synthetic",
			isDefault: true,
			tags: ["synthetic"],
			externalUrl: "https://example.invalid",
		});
		expect(response.statusCode).toBe(200);
		expect(await connection()).toMatchObject({
			label: "Updated synthetic",
			isDefault: true,
			externalUrl: "https://example.invalid",
		});
		expect(await fixture.attempts()).toEqual(attempts);
		expect(await fixture.holds()).toBe(1);
		expect(fixture.posts).toEqual([]);
	});
	it("identical credential re-entry preserves the original encrypted binding and held evidence", async () => {
		await record("uncertain");
		const before = await connection(),
			attempts = await fixture.attempts();
		expect((await edit({ apiKey: "synthetic-provider-key" })).statusCode).toBe(200);
		const after = await connection();
		expect(after?.encryptedApiKey).toBe(before?.encryptedApiKey);
		expect(after?.encryptionIv).toBe(before?.encryptionIv);
		expect(after?.encryptedHttpAuthCredentials).toBe(before?.encryptedHttpAuthCredentials);
		expect(after?.httpAuthEncryptionIv).toBe(before?.httpAuthEncryptionIv);
		expect(await fixture.attempts()).toEqual(attempts);
		expect(await fixture.holds()).toBe(1);
		expect(fixture.posts).toEqual([]);
	});
	it("allows disable/re-enable without cancellation, claim release or a new send", async () => {
		const id = await record("uncertain"),
			attempts = await fixture.attempts();
		expect((await edit({ enabled: false })).statusCode).toBe(200);
		expect(await connection()).toMatchObject({ enabled: false });
		const status = await fixture.app.inject({
			method: "GET",
			url: `/api/search/grab/intents/${attempts[0]?.intentId}`,
		});
		expect(status.statusCode).toBe(200);
		expect(status.json()).toMatchObject({
			attemptId: id,
			state: "uncertain",
			nextAction: "inspect-before-confirmed-retry",
		});
		expect((await submit()).statusCode).toBe(409);
		expect((await edit({ enabled: true })).statusCode).toBe(200);
		expect((await submit()).statusCode).toBe(409);
		expect(await fixture.attempts()).toEqual(attempts);
		expect(await fixture.holds()).toBe(1);
		expect(fixture.posts).toEqual([]);
	});
	it("an equivalent canonical URL spelling preserves the held binding", async () => {
		await record("uncertain");
		const attempts = await fixture.attempts();
		expect((await edit({ baseUrl: fixture.instance.baseUrl + "/" })).statusCode).toBe(200);
		expect(await fixture.attempts()).toEqual(attempts);
		expect(await fixture.holds()).toBe(1);
		expect(fixture.posts).toEqual([]);
	});
	it("refuses an edit while the actual SDK POST is still settling", async () => {
		const held = fixture.holdNextReply(),
			pending = Promise.resolve(submit());
		try {
			await held.arrived;
			const before = await connection();
			expect((await edit({ apiKey: "synthetic-replacement-key" })).statusCode).toBe(409);
			expect(await connection()).toEqual(before);
			expect(await fixture.holds()).toBe(1);
			expect(fixture.posts).toHaveLength(1);
		} finally {
			held.release();
		}
		expect((await pending).statusCode).toBe(204);
		expect(await fixture.holds()).toBe(0);
		expect(fixture.posts).toHaveLength(1);
	});
	it.each(["acknowledged", "rejected"] as const)(
		"permits settled %s connection deletion without deleting outcome history",
		async (state) => {
			if (state === "rejected")
				fixture.reply = { status: 409, body: {}, contentType: "application/json", lost: false };
			const payload = fixture.request();
			expect((await submit(payload)).statusCode).toBe(state === "acknowledged" ? 204 : 422);
			const attempts = await fixture.attempts();
			expect((await remove()).statusCode).toBe(204);
			expect(await connection()).toBeNull();
			expect(await fixture.attempts()).toEqual(attempts);
			const status = await fixture.app.inject({
				method: "GET",
				url: `/api/search/grab/intents/${payload.intentId}`,
			});
			expect(status.statusCode).toBe(200);
			expect(status.json().state).toBe(state);
			expect(fixture.posts).toHaveLength(1);
		},
	);
	it("allows a legitimate identity replacement with no hold and refuses the old selector", async () => {
		const old = fixture.request();
		expect((await edit({ apiKey: "synthetic-replacement-key" })).statusCode).toBe(200);
		expect((await submit(old)).statusCode).toBe(409);
		expect(await fixture.attempts()).toEqual([]);
		expect(fixture.posts).toEqual([]);
	});
	it("does not borrow another owner's connection or held state", async () => {
		await record("uncertain");
		const other = await fixture.run(() =>
			fixture.native.prisma.user.create({ data: { username: `synthetic-${randomUUID()}` } }),
		);
		const key = fixture.encryptor.encrypt("synthetic-provider-key");
		const otherConnection = await fixture.run(() =>
			fixture.native.prisma.serviceInstance.create({
				data: {
					userId: other.id,
					service: "PROWLARR",
					label: "Synthetic",
					baseUrl: fixture.instance.baseUrl,
					encryptedApiKey: key.value,
					encryptionIv: key.iv,
				},
			}),
		);
		expect(
			(
				await fixture.app.inject({
					method: "PUT",
					url: `/api/services/${otherConnection.id}`,
					payload: { apiKey: "synthetic-replacement-key" },
				})
			).statusCode,
		).toBe(404);
		expect(
			(await fixture.app.inject({ method: "DELETE", url: `/api/services/${otherConnection.id}` }))
				.statusCode,
		).toBe(404);
		expect(await fixture.holds()).toBe(1);
		expect(fixture.posts).toEqual([]);
	});
	it("rechecks a new native claim admitted after route preflight but before its write transaction", async () => {
		const original = fixture.native.prisma,
			transact = original.$transaction.bind(original);
		let injected = false;
		fixture.app.prisma = new Proxy(original, {
			get(target, property, receiver) {
				if (property !== "$transaction") return Reflect.get(target, property, receiver);
				return async (...args: Parameters<typeof transact>) => {
					if (!injected) {
						injected = true;
						await record("prepared");
					}
					return transact(...args);
				};
			},
		});
		const before = await connection();
		expect((await edit({ apiKey: "synthetic-replacement-key" })).statusCode).toBe(409);
		expect(injected).toBe(true);
		expect(await connection()).toEqual(before);
		expect(await fixture.holds()).toBe(1);
		expect((await fixture.attempts())[0]?.state).toBe("prepared");
		expect(fixture.posts).toEqual([]);
	});
});
