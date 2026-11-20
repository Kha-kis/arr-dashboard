import { randomUUID } from "node:crypto";
import type { SearchGrabRequest } from "@arr/shared";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
	createSearchGrabRepository,
	SearchGrabRepositoryError,
} from "../../../lib/search/grab-repository.js";
import { createNativeGrabFixture } from "./grab-native.fixture.js";

describe("native same-worker unsent Grab recovery", () => {
	let fixture: Awaited<ReturnType<typeof createNativeGrabFixture>>;
	beforeAll(async () => {
		fixture = await createNativeGrabFixture({ services: true });
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
	const repository = (userId = fixture.user.id) =>
		createSearchGrabRepository(fixture.native.prisma, fixture.runtime, fixture.encryptor, userId);
	const submit = (payload: SearchGrabRequest = fixture.request()) =>
		fixture.app.inject({
			method: "POST",
			url: "/api/search/grab",
			payload,
		});
	const enabled = (value: boolean) =>
		fixture.app.inject({
			method: "PUT",
			url: `/api/services/${fixture.instance.id}`,
			payload: { enabled: value },
		});
	async function record(
		state: "prepared" | "submitting" | "uncertain" | "acknowledged" = "prepared",
	) {
		return fixture.run(async () => {
			const repo = repository();
			const admission = await repo.admit({ intentId: randomUUID(), target: fixture.target() });
			if (state !== "prepared") await repo.claimDispatch(admission.attempt.id);
			if (state === "uncertain" || state === "acknowledged")
				await repo.settle(admission.attempt.id, state);
			return admission.attempt.id;
		});
	}
	function interceptTransaction(operation: (transact: () => Promise<unknown>) => Promise<unknown>) {
		const original = fixture.native.prisma,
			transact = original.$transaction.bind(original);
		fixture.app.prisma = new Proxy(original, {
			get(target, property, receiver) {
				if (property !== "$transaction") return Reflect.get(target, property, receiver);
				return (...args: Parameters<typeof transact>) => operation(() => transact(...args));
			},
		});
	}
	function disableBeforeMarker() {
		let injected = false;
		interceptTransaction(async (transact) => {
			if (!injected && (await fixture.attempts()).some((row) => row.state === "prepared")) {
				injected = true;
				expect((await enabled(false)).statusCode).toBe(200);
			}
			return transact();
		});
		return () => injected;
	}
	it("settles only its exact unmarked attempt, releases its own hold and is idempotent", async () => {
		const id = await record();
		const outcome = await fixture.run(() => repository().rejectUnsent(id));
		expect(outcome).toMatchObject({
			state: "rejected",
			dispatchedAt: null,
			outcomeCategory: "interrupted-before-dispatch",
		});
		expect(outcome.completedAt).toBeInstanceOf(Date);
		expect(await fixture.holds()).toBe(0);
		expect(await fixture.run(() => repository().rejectUnsent(id))).toEqual(outcome);
		expect(fixture.posts).toEqual([]);
	});
	it.each(["submitting", "uncertain", "acknowledged"] as const)(
		"does not relabel %s marked work as unsent",
		async (state) => {
			const id = await record(state),
				before = await fixture.attempts(),
				holds = await fixture.holds();
			await expect(fixture.run(() => repository().rejectUnsent(id))).rejects.toBeInstanceOf(
				SearchGrabRepositoryError,
			);
			expect(await fixture.attempts()).toEqual(before);
			expect(await fixture.holds()).toBe(holds);
			expect(fixture.posts).toEqual([]);
		},
	);
	it("cannot settle another owner's prepared attempt", async () => {
		const id = await record(),
			before = await fixture.attempts();
		await expect(
			fixture.run(() => repository("different-synthetic-owner").rejectUnsent(id)),
		).rejects.toBeInstanceOf(SearchGrabRepositoryError);
		expect(await fixture.attempts()).toEqual(before);
		expect(await fixture.holds()).toBe(1);
	});
	it("does not settle prepared work belonging to another epoch", async () => {
		const id = await record();
		await fixture.run(() =>
			fixture.native.prisma.searchGrabAttempt.update({
				where: { id },
				data: { workerEpoch: randomUUID() },
			}),
		);
		const before = await fixture.attempts();
		await expect(fixture.run(() => repository().rejectUnsent(id))).rejects.toBeInstanceOf(
			SearchGrabRepositoryError,
		);
		expect(await fixture.attempts()).toEqual(before);
		expect(await fixture.holds()).toBe(1);
	});
	it("cannot release a claim that now points to a different attempt", async () => {
		const id = await record(),
			original = (await fixture.attempts())[0]!;
		const replacementId = randomUUID();
		await fixture.run(async () => {
			await fixture.native.prisma.searchGrabAttempt.create({
				data: { ...original, id: replacementId, intentId: randomUUID() },
			});
			await fixture.native.prisma.searchGrabClaim.updateMany({
				where: { userId: fixture.user.id, attemptId: id },
				data: { attemptId: replacementId },
			});
		});
		const before = await fixture.attempts();
		await expect(fixture.run(() => repository().rejectUnsent(id))).rejects.toBeInstanceOf(
			SearchGrabRepositoryError,
		);
		expect(await fixture.attempts()).toEqual(before);
		const claim = await fixture.run(() =>
			fixture.native.prisma.searchGrabClaim.findFirst({ where: { userId: fixture.user.id } }),
		);
		expect(claim?.attemptId).toBe(replacementId);
		expect(await fixture.holds()).toBe(1);
		expect(fixture.posts).toEqual([]);
	});
	it("a permitted disable after admission does not strand a never-sent primary intent", async () => {
		const injected = disableBeforeMarker(),
			payload = fixture.request();
		const response = await submit(payload);
		expect(injected()).toBe(true);
		expect(response.statusCode).toBe(422);
		expect(response.json().status).toMatchObject({
			state: "rejected",
			dispatchedAt: null,
			outcomeCategory: "interrupted-before-dispatch",
			nextAction: "new-search",
		});
		expect(await fixture.holds()).toBe(0);
		expect(fixture.posts).toEqual([]);
		expect((await submit(payload)).statusCode).toBe(422);
		expect((await enabled(true)).statusCode).toBe(200);
		expect((await submit()).statusCode).toBe(204);
		expect(fixture.posts).toHaveLength(1);
	});
	it("an unsent explicit successor returns the hold to its unresolved predecessor", async () => {
		const predecessorId = await record("uncertain"),
			predecessor = (await fixture.attempts())[0];
		const injected = disableBeforeMarker();
		const response = await submit({
			...fixture.request(),
			retry: { predecessorId, duplicateRiskConfirmed: true as const },
		});
		expect(injected()).toBe(true);
		expect(response.statusCode).toBe(422);
		expect((await fixture.attempts()).find((row) => row.id === predecessorId)).toEqual(predecessor);
		const claim = await fixture.run(() =>
			fixture.native.prisma.searchGrabClaim.findFirst({ where: { userId: fixture.user.id } }),
		);
		expect(claim?.attemptId).toBe(predecessorId);
		expect(await fixture.holds()).toBe(1);
		expect(fixture.posts).toEqual([]);
		expect((await enabled(true)).statusCode).toBe(200);
		expect((await submit()).statusCode).toBe(409);
		expect(
			(
				await submit({
					...fixture.request(),
					retry: { predecessorId, duplicateRiskConfirmed: true as const },
				})
			).statusCode,
		).toBe(204);
		expect(fixture.posts).toHaveLength(1);
	});
	it("a transaction failure before marker can settle only after native evidence proves it unmarked", async () => {
		let injected = false;
		interceptTransaction(async (transact) => {
			if (!injected && (await fixture.attempts()).some((row) => row.state === "prepared")) {
				injected = true;
				throw new Error("synthetic transaction interruption");
			}
			return transact();
		});
		expect((await submit()).statusCode).toBe(422);
		expect(injected).toBe(true);
		expect((await fixture.attempts())[0]).toMatchObject({ state: "rejected", dispatchedAt: null });
		expect(await fixture.holds()).toBe(0);
		expect(fixture.posts).toEqual([]);
	});
	it("loss of a marker transaction reply never downgrades a committed marker to unsent", async () => {
		let injected = false;
		interceptTransaction(async (transact) => {
			const result = await transact();
			if (!injected && (await fixture.attempts()).some((row) => row.state === "submitting")) {
				injected = true;
				throw new Error("synthetic reply loss after commit");
			}
			return result;
		});
		expect((await submit()).statusCode).toBe(502);
		expect(injected).toBe(true);
		expect((await fixture.attempts())[0]).toMatchObject({ state: "submitting" });
		expect((await fixture.attempts())[0]?.dispatchedAt).toBeInstanceOf(Date);
		expect(await fixture.holds()).toBe(1);
		expect(fixture.posts).toEqual([]);
	});
	it("unavailable unsent settlement retains the hold and reports unavailable rather than rejection", async () => {
		let failures = 0;
		interceptTransaction(async (transact) => {
			if ((await fixture.attempts()).some((row) => row.state === "prepared")) {
				failures++;
				throw new Error("synthetic database unavailable");
			}
			return transact();
		});
		expect((await submit()).statusCode).toBe(502);
		expect(failures).toBeGreaterThanOrEqual(1);
		expect((await fixture.attempts())[0]).toMatchObject({ state: "prepared", dispatchedAt: null });
		expect(await fixture.holds()).toBe(1);
		expect(fixture.posts).toEqual([]);
	});
});
