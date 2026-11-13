import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createArrServiceFingerprint } from "../../../lib/arr/service-fingerprint.js";
import { createSearchGrabRepository } from "../../../lib/search/grab-repository.js";
import {
	issueSearchGrabSelector,
	type SearchGrabTarget,
} from "../../../lib/search/grab-selector.js";
import { createNativeGrabFixture } from "./grab-native.fixture.js";

describe("actual native bounded Grab result status", () => {
	let fixture: Awaited<ReturnType<typeof createNativeGrabFixture>>;
	beforeAll(async () => {
		fixture = await createNativeGrabFixture();
	}, 30000);
	beforeEach(async () => {
		await fixture.reset();
	});
	afterEach(async () => {
		fixture.app.prisma = fixture.native.prisma;
		await fixture.closeCase();
	});
	afterAll(async () => {
		await fixture?.close();
	});
	const repository = () =>
		createSearchGrabRepository(
			fixture.native.prisma,
			fixture.runtime,
			fixture.encryptor,
			fixture.user.id,
		);
	const result = (target: SearchGrabTarget = fixture.target(), issuedAt = Date.now()) => ({
		instanceId: target.serviceInstanceId,
		selector: issueSearchGrabSelector(fixture.encryptor, target, issuedAt),
	});
	const lookup = (results = [result()]) =>
		fixture.app.inject({
			method: "POST",
			url: "/api/search/grab/results/status",
			payload: { results },
		});
	async function record(
		state: "prepared" | "submitting" | "uncertain" | "acknowledged" | "rejected",
		target = fixture.target(),
		predecessorId?: string,
	) {
		return fixture.run(async () => {
			const repo = repository();
			const admitted = await repo.admit({
				intentId: randomUUID(),
				target,
				...(predecessorId ? { retry: { predecessorId, duplicateRiskConfirmed: true } } : {}),
			});
			if (state !== "prepared") await repo.claimDispatch(admitted.attempt.id);
			if (["uncertain", "acknowledged", "rejected"].includes(state))
				await repo.settle(admitted.attempt.id, state as "uncertain" | "acknowledged" | "rejected");
			return admitted.attempt.id;
		});
	}
	it("reports only absence of a matching record and does not create one", async () => {
		const response = await lookup();
		expect(response.statusCode).toBe(200);
		expect(response.json()).toEqual({
			results: [{ resultIndex: 0, availability: "not-recorded", status: null }],
		});
		expect(await fixture.attempts()).toEqual([]);
		expect(await fixture.holds()).toBe(0);
		expect(fixture.posts).toEqual([]);
		expect(fixture.reads).toBe(0);
	});
	it.each(["prepared", "submitting", "uncertain", "acknowledged", "rejected"] as const)(
		"observes %s using a newly issued selector without writes or provider reads",
		async (state) => {
			const id = await record(state),
				before = await fixture.attempts(),
				holds = await fixture.holds();
			const response = await lookup();
			expect(response.statusCode).toBe(200);
			const slot = response.json().results[0];
			expect(Object.keys(slot).sort()).toEqual(["availability", "resultIndex", "status"]);
			expect(slot).toMatchObject({
				resultIndex: 0,
				availability: "recorded",
				status: { attemptId: id, state },
			});
			expect(Object.keys(slot.status).sort()).toEqual([
				"attemptId",
				"completedAt",
				"dispatchedAt",
				"intentId",
				"nextAction",
				"outcomeCategory",
				"requestedAt",
				"state",
			]);
			expect(await fixture.attempts()).toEqual(before);
			expect(await fixture.holds()).toBe(holds);
			expect(response.body).not.toContain(fixture.guid);
			expect(response.body).not.toContain(fixture.instance.encryptedApiKey);
			expect(fixture.posts).toEqual([]);
			expect(fixture.reads).toBe(0);
		},
	);
	it("shows the held uncertain predecessor rather than its newer rejected retry", async () => {
		const parent = await record("uncertain");
		await record("rejected", fixture.target(), parent);
		const before = await fixture.attempts(),
			response = await lookup();
		expect(response.statusCode).toBe(200);
		expect(response.json().results[0]).toMatchObject({
			availability: "recorded",
			status: {
				attemptId: parent,
				state: "uncertain",
				nextAction: "inspect-before-confirmed-retry",
			},
		});
		expect(await fixture.attempts()).toEqual(before);
		expect(await fixture.holds()).toBe(1);
		expect(fixture.posts).toEqual([]);
	});
	it("keeps same release on different instances distinct and preserves positional duplicate correlation", async () => {
		const first = await record("acknowledged");
		const other = await fixture.run(() =>
			fixture.native.prisma.serviceInstance.create({
				data: {
					userId: fixture.user.id,
					service: "PROWLARR",
					label: "Synthetic second",
					baseUrl: fixture.instance.baseUrl,
					encryptedApiKey: fixture.instance.encryptedApiKey,
					encryptionIv: fixture.instance.encryptionIv,
				},
			}),
		);
		const target = {
			...fixture.target(),
			serviceInstanceId: other.id,
			connectionFingerprint: createArrServiceFingerprint(other),
		};
		const second = await record("uncertain", target);
		const response = await lookup([result(), result(target), result()]);
		expect(response.statusCode).toBe(200);
		expect(
			response
				.json()
				.results.map((slot: { resultIndex: number; status: { attemptId: string } }) => [
					slot.resultIndex,
					slot.status.attemptId,
				]),
		).toEqual([
			[0, first],
			[1, second],
			[2, first],
		]);
		expect(fixture.posts).toEqual([]);
		expect(fixture.reads).toBe(0);
	});
	it("returns the latest exact terminal record when no unresolved claim remains", async () => {
		const older = await record("rejected"),
			newer = await record("acknowledged");
		await fixture.run(() =>
			fixture.native.prisma.searchGrabAttempt.update({
				where: { id: older },
				data: { requestedAt: new Date(Date.now() - 5000) },
			}),
		);
		const before = await fixture.attempts(),
			response = await lookup();
		expect(response.statusCode).toBe(200);
		expect(response.json().results[0]).toMatchObject({
			availability: "recorded",
			status: { attemptId: newer, state: "acknowledged" },
		});
		expect(await fixture.attempts()).toEqual(before);
		expect(await fixture.holds()).toBe(0);
		expect(fixture.posts).toEqual([]);
	});
	it("keeps mixed availability distinct without discarding valid recorded evidence", async () => {
		const id = await record("uncertain");
		const response = await lookup([
			result(),
			result({ ...fixture.target(), guid: "synthetic:unrecorded" }),
			result({ ...fixture.target(), userId: "different-synthetic-owner" }),
		]);
		expect(response.statusCode).toBe(200);
		expect(response.json().results[0]).toMatchObject({
			resultIndex: 0,
			availability: "recorded",
			status: { attemptId: id, state: "uncertain" },
		});
		expect(response.json().results.slice(1)).toEqual([
			{ resultIndex: 1, availability: "not-recorded", status: null },
			{ resultIndex: 2, availability: "unavailable", status: null },
		]);
		expect(await fixture.holds()).toBe(1);
		expect(fixture.posts).toEqual([]);
		expect(fixture.reads).toBe(0);
	});
	it("does not reveal another owner's exact-looking result", async () => {
		await record("uncertain");
		const foreign = result({ ...fixture.target(), userId: "different-synthetic-owner" });
		const response = await lookup([foreign]);
		expect(response.statusCode).toBe(200);
		expect(response.json()).toEqual({
			results: [{ resultIndex: 0, availability: "unavailable", status: null }],
		});
	});
	it("can observe a disabled owned connection but does not grant dispatch authority", async () => {
		const id = await record("uncertain");
		await fixture.run(() =>
			fixture.native.prisma.serviceInstance.update({
				where: { id: fixture.instance.id },
				data: { enabled: false },
			}),
		);
		const response = await lookup();
		expect(response.statusCode).toBe(200);
		expect(response.json().results[0].status.attemptId).toBe(id);
		expect(
			(
				await fixture.app.inject({
					method: "POST",
					url: "/api/search/grab",
					payload: fixture.request(),
				})
			).statusCode,
		).toBe(409);
		expect(fixture.posts).toEqual([]);
		expect(await fixture.holds()).toBe(1);
	});
	it.each(["expired", "tampered", "wrong-instance"] as const)(
		"keeps %s provenance unavailable, not absent",
		async (kind) => {
			await record("uncertain");
			const entry = result(
				fixture.target(),
				kind === "expired" ? Date.now() - 1_800_001 : Date.now(),
			);
			if (kind === "tampered") entry.selector = `${entry.selector.slice(0, -3)}AAA`;
			if (kind === "wrong-instance") entry.instanceId = "different-synthetic-instance";
			const before = await fixture.attempts(),
				response = await lookup([entry]);
			expect(response.statusCode).toBe(200);
			expect(response.json()).toEqual({
				results: [{ resultIndex: 0, availability: "unavailable", status: null }],
			});
			expect(await fixture.attempts()).toEqual(before);
			expect(await fixture.holds()).toBe(1);
		},
	);
	it("changed connection proof remains unavailable instead of looking like empty history", async () => {
		await record("acknowledged");
		const entry = result();
		await fixture.run(() =>
			fixture.native.prisma.serviceInstance.update({
				where: { id: fixture.instance.id },
				data: { baseUrl: "http://127.0.0.1:1" },
			}),
		);
		expect((await lookup([entry])).json()).toEqual({
			results: [{ resultIndex: 0, availability: "unavailable", status: null }],
		});
		expect(fixture.posts).toEqual([]);
	});
	it("missing owned connection does not hide its historical intent or leak it through the result lookup", async () => {
		await record("acknowledged");
		const entry = result(),
			[attempt] = await fixture.attempts();
		await fixture.run(() =>
			fixture.native.prisma.serviceInstance.delete({ where: { id: fixture.instance.id } }),
		);
		expect((await lookup([entry])).json()).toEqual({
			results: [{ resultIndex: 0, availability: "unavailable", status: null }],
		});
		expect(
			(
				await fixture.app.inject({
					method: "GET",
					url: `/api/search/grab/intents/${attempt!.intentId}`,
				})
			).statusCode,
		).toBe(200);
	});
	it.each(["empty", "too-many", "raw-target", "extra-field", "bad-shape"] as const)(
		"refuses %s requests without writes or sends",
		async (kind) => {
			const valid = result();
			const payload =
				kind === "empty"
					? { results: [] }
					: kind === "too-many"
						? { results: Array.from({ length: 51 }, () => valid) }
						: kind === "raw-target"
							? { results: [{ instanceId: valid.instanceId, guid: fixture.guid, indexerId: 7 }] }
							: kind === "extra-field"
								? { results: [valid], retry: true }
								: { results: [{ ...valid, selector: "bad" }] };
			expect(
				(
					await fixture.app.inject({
						method: "POST",
						url: "/api/search/grab/results/status",
						payload,
					})
				).statusCode,
			).toBe(400);
			expect(await fixture.attempts()).toEqual([]);
			expect(await fixture.holds()).toBe(0);
			expect(fixture.posts).toEqual([]);
		},
	);
	it("accepts exactly fifty lookup slots with bounded positional output", async () => {
		const response = await lookup(Array.from({ length: 50 }, () => result()));
		expect(response.statusCode).toBe(200);
		expect(response.json().results).toEqual(
			Array.from({ length: 50 }, (_, resultIndex) => ({
				resultIndex,
				availability: "not-recorded",
				status: null,
			})),
		);
	});
	it("requires authentication before reading recorded status", async () => {
		await record("uncertain");
		fixture.authenticated = false;
		const response = await lookup();
		expect(response.statusCode).toBe(401);
		expect(response.body).not.toContain("attemptId");
		expect(fixture.posts).toEqual([]);
	});
	it("native lookup failure returns unavailable rather than a successful empty result", async () => {
		await record("uncertain");
		const original = fixture.native.prisma;
		fixture.app.prisma = new Proxy(original, {
			get(target, property, receiver) {
				if (property === "$transaction")
					return () => Promise.reject(new Error("synthetic-private-database-diagnostic"));
				return Reflect.get(target, property, receiver);
			},
		});
		const response = await lookup();
		expect(response.statusCode).toBe(502);
		expect(response.json()).toMatchObject({ category: "status-unavailable" });
		expect(response.body).not.toContain("synthetic-private-database-diagnostic");
		expect(await fixture.holds()).toBe(1);
	});
	it("inconsistent held target evidence fails closed and leaves every row unchanged", async () => {
		const held = await record("uncertain"),
			otherTarget = { ...fixture.target(), guid: "synthetic:different-target" };
		const other = await record("acknowledged", otherTarget);
		await fixture.run(() =>
			fixture.native.prisma.searchGrabClaim.updateMany({
				where: { userId: fixture.user.id, attemptId: held },
				data: { attemptId: other },
			}),
		);
		const before = await fixture.attempts(),
			response = await lookup();
		expect(response.statusCode).toBe(502);
		expect(response.json()).toMatchObject({ category: "status-unavailable" });
		expect(await fixture.attempts()).toEqual(before);
		expect(await fixture.holds()).toBe(1);
		expect(fixture.posts).toEqual([]);
	});
	it("observing prior epoch work does not invoke recovery from the read route", async () => {
		const id = await record("prepared");
		await fixture.run(() =>
			fixture.native.prisma.searchGrabAttempt.update({
				where: { id },
				data: { workerEpoch: randomUUID() },
			}),
		);
		const before = await fixture.attempts(),
			response = await lookup();
		expect(response.statusCode).toBe(200);
		expect(response.json().results[0].status.state).toBe("prepared");
		expect(await fixture.attempts()).toEqual(before);
		expect(await fixture.holds()).toBe(1);
		expect(fixture.posts).toEqual([]);
	});
});
