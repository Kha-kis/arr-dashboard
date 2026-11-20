import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { createNotificationOutboxNativeFixture } from "../../lib/notifications/__tests__/notification-outbox-native-fixture.js";
import { createNotificationOutboxRepository } from "../../lib/notifications/outbox-repository.js";
import { registerNotificationRoutes } from "../notifications.js";
import { registerTestErrorHandler, setupAuthInjection } from "./test-helpers.js";

type Fixture = Awaited<ReturnType<typeof createNotificationOutboxNativeFixture>>;
const actors: Array<{ fixture: Fixture; app: FastifyInstance }> = [];
afterEach(async () => {
	for (const { app, fixture } of actors.splice(0)) {
		try {
			await app.close();
		} finally {
			await fixture.close();
		}
	}
});

async function boot() {
	const fixture = await createNotificationOutboxNativeFixture();
	const app = Fastify({ logger: false });
	actors.push({ fixture, app });
	let rejectQueueRead = false;
	// Only a failing transaction entry is injected. All successful queries and
	// admission/ownership remain actual native operations; no capability is forged.
	const client = new Proxy(fixture.prisma, {
		get(target, property) {
			if (property === "$transaction" && rejectQueueRead)
				return async () => {
					throw new Error("synthetic-private-queue-storage-detail");
				};
			const value = Reflect.get(target, property, target);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
	app.decorate("prisma", client);
	setupAuthInjection(app, { id: fixture.userId, username: "synthetic-queue-reader" });
	registerTestErrorHandler(app);
	await app.register(registerNotificationRoutes);
	await app.ready();
	return {
		fixture,
		setQueueReadFailure: (value: boolean) => {
			rejectQueueRead = value;
		},
		get: () =>
			fixture.run(() =>
				app.inject({ method: "GET", url: "/statistics?days=7", headers: { "x-test-auth": "1" } }),
			),
	};
}

const zeroHistory = {
	sent: 0,
	failed: 0,
	deadLetter: 0,
	unclassified: 0,
	total: 0,
	successRate: 0,
};
const noEvents = { ready: 0, deferred: 0, aggregating: 0 };
const noDeliveries = { ready: 0, retryWaiting: 0, submitting: 0, uncertain: 0 };

describe("registered notification statistics observe actual owner-scoped queued work", () => {
	it("contains a simulated queue read failure without erasing History, then recovers", async () => {
		const { fixture, get, setQueueReadFailure } = await boot();
		await fixture.run(async () => {
			await fixture.repository().admit(fixture.input());
			await fixture.prisma.notificationLog.create({
				data: {
					channelId: fixture.channelId,
					channelType: "DISCORD",
					eventType: "HUNT_COMPLETED",
					title: "Synthetic historical notification",
					body: "Synthetic historical notification",
					status: "sent",
					sentAt: new Date(),
				},
			});
		});
		setQueueReadFailure(true);
		const unavailable = await get();
		expect(unavailable.statusCode).toBe(200);
		expect(unavailable.json().totals).toEqual({
			...zeroHistory,
			sent: 1,
			total: 1,
			successRate: 100,
		});
		expect(unavailable.json().queue).toEqual({
			state: "unavailable",
			reason: "storage-unavailable",
		});
		expect(unavailable.payload).not.toContain("synthetic-private-queue-storage-detail");
		setQueueReadFailure(false);
		const recovered = await get();
		expect(recovered.statusCode).toBe(200);
		expect(recovered.json().queue).toMatchObject({
			state: "observed",
			events: { ...noEvents, ready: 1 },
			deliveries: { ...noDeliveries, ready: 1 },
		});
	});

	it("reports unknown persisted queue state as unavailable, then observes actual recovery", async () => {
		const { fixture, get } = await boot();
		let eventId = "";
		await fixture.run(async () => {
			eventId = (await fixture.repository().admit(fixture.input())).eventId;
			await fixture.prisma.notificationOutboxEvent.updateMany({
				where: { id: eventId, userId: fixture.userId },
				data: { stage: "synthetic-invalid-state" },
			});
		});
		const unavailable = await get();
		expect(unavailable.statusCode).toBe(200);
		expect(unavailable.json().totals).toEqual(zeroHistory);
		expect(unavailable.json().queue).toEqual({ state: "unavailable", reason: "state-unavailable" });
		expect(unavailable.payload).not.toContain("synthetic-invalid-state");
		await fixture.run(() =>
			fixture.prisma.notificationOutboxEvent.updateMany({
				where: { id: eventId, userId: fixture.userId },
				data: { stage: "ready" },
			}),
		);
		const recovered = await get();
		expect(recovered.statusCode).toBe(200);
		expect(recovered.json().queue).toMatchObject({
			state: "observed",
			events: { ...noEvents, ready: 1 },
			deliveries: { ...noDeliveries, ready: 1 },
		});
	});

	it("shows queued work separately when no delivery History exists", async () => {
		const { fixture, get } = await boot();
		await fixture.run(async () => {
			const repository = fixture.repository();
			await repository.admit(fixture.input());
			await repository.admit({
				...fixture.input(),
				payload: { ...fixture.payload, title: "Synthetic deferred queue observation" },
				policy: { stage: "deferred", dueAt: new Date("2026-10-10T12:01:30.000Z") },
			});
			await repository.admit({
				...fixture.input(),
				payload: { ...fixture.payload, title: "Synthetic aggregate queue observation" },
				policy: { stage: "aggregating", windowSeconds: 60, maxBatchSize: 10 },
			});
		});
		const response = await get();
		expect(response.statusCode).toBe(200);
		const stats = response.json();
		expect(stats.totals).toEqual(zeroHistory);
		expect(stats.queue).toMatchObject({
			state: "observed",
			events: { ready: 1, deferred: 1, aggregating: 1 },
			deliveries: { ...noDeliveries, ready: 1 },
			oldestDueAt: "2026-10-10T12:00:00.000Z",
		});
		expect(stats.queue.observedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
		const queue = JSON.stringify(stats.queue);
		for (const privateValue of [fixture.userId, fixture.channelId, fixture.payload.title])
			expect(queue).not.toContain(privateValue);
	});

	it("distinguishes an actually observed empty queue from absent evidence", async () => {
		const { get } = await boot();
		const response = await get();
		expect(response.statusCode).toBe(200);
		expect(response.json().queue).toMatchObject({
			state: "observed",
			events: noEvents,
			deliveries: noDeliveries,
			oldestDueAt: null,
		});
	});

	it("never includes another owner's actual queued events or recipients", async () => {
		const { fixture, get } = await boot();
		const foreign = await fixture.createOwner();
		await fixture.run(async () => {
			await fixture.repository().admit(fixture.input());
			const repository = createNotificationOutboxRepository(
				fixture.prisma,
				fixture.runtime,
				fixture.encryptor,
				foreign.userId,
				{ clock: fixture.clock },
			);
			for (const title of ["Synthetic foreign one", "Synthetic foreign two"])
				await repository.admit({
					...fixture.input(),
					payload: { ...fixture.payload, title },
					recipients: [{ ...fixture.input().recipients[0]!, channelId: foreign.channelId }],
				});
		});
		const response = await get();
		expect(response.statusCode).toBe(200);
		expect(response.json().queue).toMatchObject({
			state: "observed",
			events: { ...noEvents, ready: 1 },
			deliveries: { ...noDeliveries, ready: 1 },
		});
		expect(response.payload).not.toContain(foreign.userId);
		expect(response.payload).not.toContain(foreign.channelId);
	});

	it("does not hide historical accepted work when its channel has been deleted", async () => {
		const { fixture, get } = await boot();
		await fixture.run(async () => {
			await fixture.repository().admit(fixture.input());
			await fixture.prisma.notificationChannel.deleteMany({
				where: { id: fixture.channelId, userId: fixture.userId },
			});
		});
		const response = await get();
		expect(response.statusCode).toBe(200);
		expect(response.json().totals).toEqual(zeroHistory);
		expect(response.json().queue).toMatchObject({
			state: "observed",
			events: { ...noEvents, ready: 1 },
			deliveries: { ...noDeliveries, ready: 1 },
		});
	});

	it("keeps retry, submitting and uncertain work separate from classified delivery outcomes", async () => {
		const { fixture, get } = await boot();
		const admittedAt = new Date();
		fixture.now = admittedAt;
		await fixture.run(async () => {
			const repository = fixture.repository();
			for (const state of ["retry", "submitting", "uncertain"] as const) {
				const admitted = await repository.admit({
					...fixture.input(),
					payload: { ...fixture.payload, title: `Synthetic observed ${state}` },
				});
				const delivery = await fixture.prisma.notificationOutboxDelivery.findFirstOrThrow({
					where: { userId: fixture.userId, eventId: admitted.eventId },
				});
				const attempt = await repository.beginAttempt(delivery.id);
				expect(attempt).not.toBeNull();
				if (!attempt) throw new Error("Synthetic attempt missing");
				if (state !== "submitting")
					expect(
						await repository.finishAttempt(
							attempt,
							state === "uncertain"
								? { outcome: "uncertain" }
								: { success: false, retryable: true, failureCategory: "provider-unavailable" },
						),
					).toBe(true);
			}
		});
		const response = await get();
		expect(response.statusCode).toBe(200);
		const stats = response.json();
		expect(admittedAt.getTime()).toBeGreaterThanOrEqual(new Date(stats.period.since).getTime());
		expect(admittedAt.getTime()).toBeLessThanOrEqual(new Date(stats.period.until).getTime());
		expect(stats.totals).toEqual({ ...zeroHistory, failed: 1, total: 1 });
		expect(stats.queue).toMatchObject({
			state: "observed",
			events: { ...noEvents, ready: 2 },
			deliveries: { ready: 0, retryWaiting: 1, submitting: 1, uncertain: 1 },
			oldestDueAt: new Date(admittedAt.getTime() + 30_000).toISOString(),
		});
	});
});
