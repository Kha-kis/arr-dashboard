import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	closeScopedWriteFixtures,
	createScopedWriteFixture,
} from "../../__tests__/scoped-write-intent-fixture.js";
import { ArrClientFactory } from "../../arr/client-factory.js";
import { executeOnInstances } from "../../arr/client-helpers.js";
import { Encryptor } from "../../auth/encryption.js";
import { pulseCollectors } from "../../pulse/collectors.js";
import { SchedulerRegistry } from "../../scheduler-registry/scheduler-registry.js";
import { SeerrCircuitBreaker } from "../../seerr/seerr-circuit-breaker.js";
import { withIsolatedRuntimePrismaReadClient } from "../restore-runtime-client.js";

afterEach(async () => {
	vi.unstubAllGlobals();
	await closeScopedWriteFixtures();
});

describe("Dashboard metadata read acquisition", { timeout: 20_000 }, () => {
	// Break caught: selecting ARR connections must not wait on or borrow an
	// unrelated transaction, or retain a read lane while provider work waits.
	it("selects only committed owned enabled ARR connections and releases its lane before callbacks", async () => {
		const f = await createScopedWriteFixture({ writeIntent: true });
		const encryptor = new Encryptor("8".repeat(64));
		const token = encryptor.encrypt("synthetic-only-token");
		await f.plain.user.create({ data: { id: "foreign-user", username: "foreign-user" } });
		await f.plain.serviceInstance.createMany({
			data: [
				{ id: "owned-arr", userId: "synthetic-user", label: "Committed ARR", enabled: true },
				{ id: "disabled-arr", userId: "synthetic-user", label: "Disabled", enabled: false },
				{ id: "foreign-arr", userId: "foreign-user", label: "Foreign", enabled: true },
			].map((row) => ({
				...row,
				service: "RADARR" as const,
				baseUrl: "http://synthetic.invalid",
				encryptedApiKey: token.value,
				encryptionIv: token.iv,
			})),
		});
		const app = Fastify({ logger: false });
		app.decorate("prisma", f.client.prisma);
		app.decorate("arrClientFactory", new ArrClientFactory(encryptor));
		vi.stubGlobal("fetch", () => {
			throw new Error("Unexpected synthetic provider request");
		});
		let releaseTransaction = () => {};
		let releaseCallbacks = () => {};
		let publication: Promise<unknown> | undefined;
		let operations: Array<Promise<unknown>> = [];
		try {
			let entered!: () => void;
			const enteredTransaction = new Promise<void>((resolve) => {
				entered = resolve;
			});
			const heldTransaction = new Promise<void>((resolve) => {
				releaseTransaction = resolve;
			});
			const rollback = new Error("synthetic-metadata-rollback");
			publication = f.runtime
				.runOperation(() =>
					f.client.prisma.$transaction(
						async (tx) => {
							await tx.serviceInstance.update({
								where: { id: "owned-arr" },
								data: { userId: "foreign-user", enabled: false, label: "Uncommitted" },
							});
							await tx.serviceInstance.update({
								where: { id: "foreign-arr" },
								data: { userId: "synthetic-user" },
							});
							entered();
							await heldTransaction;
							throw rollback;
						},
						{ timeout: 15_000 },
					),
				)
				.then(
					() => null,
					(error: unknown) => error,
				);
			await enteredTransaction;
			let callbacksEntered!: () => void;
			const allCallbacksEntered = new Promise<void>((resolve) => {
				callbacksEntered = resolve;
			});
			const heldCallbacks = new Promise<void>((resolve) => {
				releaseCallbacks = resolve;
			});
			let callbackCount = 0;
			operations = Array.from({ length: 4 }, () =>
				f.runtime.runOperation(() =>
					executeOnInstances(
						app,
						"synthetic-user",
						{ serviceTypes: ["RADARR"] },
						async (_client, instance) => {
							if (++callbackCount === 4) callbacksEntered();
							await heldCallbacks;
							return { id: instance.id, label: instance.label };
						},
					),
				),
			);
			const completed = Promise.all(operations);
			await Promise.race([
				allCallbacksEntered,
				completed.then(() => {
					throw new Error("Provider callbacks did not remain pending");
				}),
			]);
			// Four callbacks are held. Keeping their database leases would exhaust
			// the pool and prevent this independent committed-data read.
			expect(
				await f.runtime.runOperation(() =>
					withIsolatedRuntimePrismaReadClient(f.client.prisma, (reader) =>
						reader.serviceInstance.findMany({
							where: { userId: "synthetic-user", enabled: true, service: "RADARR" },
							select: { id: true, label: true },
						}),
					),
				),
			).toEqual([{ id: "owned-arr", label: "Committed ARR" }]);
			releaseCallbacks();
			for (const response of await completed) {
				expect(response).toMatchObject({
					aggregated: [{ id: "owned-arr", label: "Committed ARR" }],
					totalCount: 1,
					errorCount: 0,
					instances: [{ instanceId: "owned-arr", instanceName: "Committed ARR", success: true }],
				});
			}
			releaseTransaction();
			expect(await publication).toBe(rollback);
			expect(f.losses).toEqual([]);
		} finally {
			releaseCallbacks();
			releaseTransaction();
			await Promise.allSettled(operations);
			await publication;
			await app.close();
		}
	});

	// Break caught: Pulse must read committed user-owned metadata and emit real
	// attention instead of timing out or returning fabricated empty success.
	it("collects owned committed Pulse attention during an unrelated ordinary transaction", async () => {
		const f = await createScopedWriteFixture({ writeIntent: true });
		await f.plain.serviceInstance.updateMany({ data: { enabled: false } });
		await f.plain.user.create({ data: { id: "foreign-user", username: "foreign-user" } });
		await f.plain.serviceInstance.createMany({
			data: [
				{ id: "owned-seerr", userId: "synthetic-user", enabled: true, label: "Committed Seerr" },
				{ id: "disabled-seerr", userId: "synthetic-user", enabled: false, label: "Disabled" },
				{ id: "foreign-seerr", userId: "foreign-user", enabled: true, label: "Foreign" },
			].map((row) => ({
				...row,
				service: "SEERR" as const,
				baseUrl: "http://synthetic.invalid",
				encryptedApiKey: "synthetic-cipher",
				encryptionIv: "synthetic-iv",
			})),
		});
		const app = Fastify({ logger: false });
		app.decorate("prisma", f.client.prisma);
		app.decorate("schedulerRegistry", new SchedulerRegistry());
		const breaker = new SeerrCircuitBreaker({ failureThreshold: 1, cooldownMs: 60_000 });
		for (const id of ["owned-seerr", "disabled-seerr", "foreign-seerr"]) breaker.reportFailure(id);
		app.decorate("seerrCircuitBreaker", breaker);
		vi.stubGlobal("fetch", () => {
			throw new Error("Unexpected synthetic provider request");
		});
		let release = () => {};
		let publication: Promise<unknown> | undefined;
		let work: Promise<unknown> | undefined;
		try {
			let entered!: () => void;
			const enteredTransaction = new Promise<void>((resolve) => {
				entered = resolve;
			});
			const held = new Promise<void>((resolve) => {
				release = resolve;
			});
			const rollback = new Error("synthetic-pulse-rollback");
			publication = f.runtime
				.runOperation(() =>
					f.client.prisma.$transaction(
						async (tx) => {
							await tx.serviceInstance.update({
								where: { id: "owned-seerr" },
								data: { enabled: false, userId: "foreign-user", label: "Uncommitted" },
							});
							await tx.serviceInstance.update({
								where: { id: "foreign-seerr" },
								data: { userId: "synthetic-user" },
							});
							entered();
							await held;
							throw rollback;
						},
						{ timeout: 15_000 },
					),
				)
				.then(
					() => null,
					(error: unknown) => error,
				);
			await enteredTransaction;
			const attempts = pulseCollectors.map((collect) =>
				f.runtime.runOperation(() => collect(app, "synthetic-user", app.log)),
			);
			const collectors = Promise.all(attempts);
			work = Promise.allSettled(attempts);
			const items = (await collectors).flat();
			expect(items).toEqual([
				expect.objectContaining({
					id: "seerr-circuit-owned-seerr",
					severity: "critical",
					title: "Committed Seerr is unreachable",
					source: "seerr",
				}),
			]);
			expect(JSON.stringify(items)).not.toMatch(/Uncommitted|Foreign|foreign-seerr|disabled-seerr/);
			release();
			expect(await publication).toBe(rollback);
			expect(f.losses).toEqual([]);
		} finally {
			release();
			await work?.catch(() => {});
			await publication;
			breaker.destroy();
			await app.close();
		}
	});
});
