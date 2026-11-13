import assert from "node:assert/strict";
import { lstatSync, realpathSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import { syncBuiltinESMExports } from "node:module";
import net from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname } from "node:path";
import tls from "node:tls";
import { Encryptor } from "../../../lib/auth/encryption.js";
import { openRestoreRuntime } from "../../../lib/backup/restore-runtime-admission.js";
import { createRuntimePrismaClient } from "../../../lib/backup/restore-runtime-client.js";
import { NotificationDispatcher } from "../../../lib/notifications/notification-dispatcher.js";
import { NotificationService } from "../../../lib/notifications/notification-service.js";
import { RuleEngine } from "../../../lib/notifications/rule-engine.js";
import type { NotificationPayload } from "../../../lib/notifications/types.js";

// Owned synthetic SQLite actor. No configured transport or network request is allowed.
process.umask(0o077);
let blockedNetworkCalls = 0;
const refuse = () => {
	blockedNetworkCalls++;
	throw new Error("Synthetic notification actor refuses network.");
};
globalThis.fetch = async () => refuse();
Object.assign(http, { request: refuse, get: refuse });
Object.assign(https, { request: refuse, get: refuse });
Object.assign(net, { connect: refuse, createConnection: refuse });
Object.assign(net.Socket.prototype, { connect: refuse });
Object.assign(tls, { connect: refuse });
syncBuiltinESMExports();

const owner = "synthetic-process-owner";
const channelId = "synthetic-process-channel";
const payload: NotificationPayload = {
	eventType: "HUNT_COMPLETED",
	title: "Synthetic accepted event",
	body: "Synthetic accepted body",
};
const logger = { info() {}, warn() {}, error() {}, debug() {} };
async function message(value: object): Promise<void> {
	assert.ok(process.send);
	await new Promise<void>((resolve, reject) => {
		process.send!(value, (error) => (error ? reject(error) : resolve()));
	});
}
async function main() {
	const [phase, mode, database, initialClock] = process.argv.slice(2);
	assert.ok(phase === "admit" || phase === "restart");
	assert.ok(
		mode &&
			[
				"immediate",
				"aggregation",
				"retry",
				"quiet-hours",
				"before-marker",
				"in-flight",
				"ack-write-fault",
			].includes(mode),
	);
	assert.ok(database && initialClock);
	assert.equal(dirname(dirname(database)), realpathSync(tmpdir()));
	assert.match(basename(dirname(database)), /^arr-outbox-process-[A-Za-z0-9]+$/);
	assert.equal(basename(database), "owned.db");
	assert.equal(realpathSync(database), database);
	assert.equal(lstatSync(database).isFile(), true);
	assert.equal(lstatSync(database).mode & 0o777, 0o600);
	let now = new Date(initialClock);
	assert.ok(Number.isFinite(now.getTime()));
	const runtime = await openRestoreRuntime({ databaseUrl: `file:${database}` });
	await runtime.bindDestination("synthetic-notification-process-destination");
	await runtime.activate();
	const native = createRuntimePrismaClient(runtime);
	const prisma = native.prisma;
	const encryptor = new Encryptor("9".repeat(64));
	const config = { webhookUrl: "https://example.invalid/synthetic-process" };
	const sent: NotificationPayload[] = [];
	const dispatcher = new NotificationDispatcher();
	let service: NotificationService;
	const run = <T>(operation: () => Promise<T>) => runtime.runOperation(operation);
	async function snapshot() {
		return run(async () => {
			const [deliveries, events, logs, channel, subscriptions] = await Promise.all([
				prisma.notificationOutboxDelivery.findMany({
					where: { userId: owner },
					orderBy: { id: "asc" },
					select: { state: true, attemptOrdinal: true, nextAttemptAt: true, attemptToken: true },
				}),
				prisma.notificationOutboxEvent.findMany({
					where: { userId: owner },
					select: { stage: true, dueAt: true },
				}),
				prisma.notificationLog.findMany({ where: { channelId }, select: { status: true } }),
				prisma.notificationChannel.findFirstOrThrow({ where: { id: channelId, userId: owner } }),
				prisma.notificationSubscription.count({ where: { channelId } }),
			]);
			assert.deepEqual(
				JSON.parse(encryptor.decrypt({ value: channel.encryptedConfig, iv: channel.configIv })),
				config,
			);
			return {
				sends: sent.length,
				titles: sent.map((item) => item.title),
				digestCounts: sent.map((item) => item.metadata?.count ?? null),
				deliveries: deliveries.map((item) => ({
					state: item.state,
					ordinal: item.attemptOrdinal,
					dueAt: item.nextAttemptAt.toISOString(),
					hasToken: item.attemptToken !== null,
				})),
				events: events.map((item) => ({ stage: item.stage, dueAt: item.dueAt.toISOString() })),
				logs: logs.map((item) => item.status),
				channels: 1,
				subscriptions,
				encryptedConfigRoundTrip: true,
				blockedNetworkCalls,
			};
		});
	}
	dispatcher.registerSender("DISCORD", {
		async send(currentConfig, item) {
			assert.deepEqual(currentConfig, config);
			const markers = await prisma.notificationOutboxDelivery.count({
				where: { userId: owner, state: "submitting", attemptToken: { not: null } },
			});
			assert.equal(markers, 1, "Physical transport requires a committed marker.");
			sent.push(item);
			if (phase === "admit" && mode === "in-flight") {
				await message({ state: "ACCEPTED", snapshot: await snapshot() });
				return new Promise<never>(() => {});
			}
			return phase === "admit" && mode === "retry"
				? { success: false, retryable: true, failureCategory: "transport", retryAfterMs: 300_000 }
				: { success: true, retryable: false };
		},
		async test() {
			throw new Error("This actor never tests a channel.");
		},
	});
	const createService = () =>
		new NotificationService(
			prisma,
			encryptor,
			dispatcher,
			logger,
			undefined,
			undefined,
			"https://example.invalid",
			new RuleEngine(),
			undefined,
			{ runtime, clock: () => new Date(now) },
		);
	service = createService();
	if (phase === "admit") {
		await run(async () => {
			await prisma.user.create({ data: { id: owner, username: "synthetic-process-only" } });
			const encrypted = encryptor.encrypt(JSON.stringify(config));
			await prisma.notificationChannel.create({
				data: {
					id: channelId,
					userId: owner,
					name: "Synthetic process only",
					type: "DISCORD",
					encryptedConfig: encrypted.value,
					configIv: encrypted.iv,
					subscriptions: { create: { eventType: "HUNT_COMPLETED" } },
				},
			});
			if (mode === "aggregation")
				await prisma.notificationAggregationConfig.create({
					data: {
						userId: owner,
						eventType: "HUNT_COMPLETED",
						enabled: true,
						windowSeconds: 300,
						maxBatchSize: 10,
					},
				});
			if (mode === "quiet-hours") {
				const minute = now.getUTCHours() * 60 + now.getUTCMinutes();
				const hhmm = (value: number) =>
					`${String(Math.floor(value / 60)).padStart(2, "0")}:${String(value % 60).padStart(2, "0")}`;
				await prisma.notificationRule.create({
					data: {
						userId: owner,
						name: "Synthetic process quiet hours",
						action: "quiet_hours",
						conditions: "[]",
						quietHoursStart: hhmm((minute + 1430) % 1440),
						quietHoursEnd: hhmm((minute + 60) % 1440),
						quietHoursTimezone: "UTC",
					},
				});
			}
			if (mode === "ack-write-fault")
				await prisma.$executeRawUnsafe(
					'CREATE TRIGGER "synthetic_process_log_refusal" BEFORE INSERT ON "notification_logs" BEGIN SELECT RAISE(ABORT, \'synthetic bookkeeping rejection\'); END',
				);
		});
		await run(async () => {
			if (mode === "before-marker")
				await service.runProducer(async () => {
					service.closeAdmission();
					await service.notify(payload, { userId: owner });
				});
			else {
				await service.notify(payload, { userId: owner });
				if (mode === "aggregation")
					await service.notify({ ...payload, title: "Synthetic second member" }, { userId: owner });
			}
		});
		const commanded = new Promise<unknown>((resolve) => process.once("message", resolve));
		await message({ state: "ACCEPTED", snapshot: await snapshot() });
		const command = await commanded;
		assert.deepEqual(command, { action: "graceful" });
		await service.shutdown();
		await message({ state: "DRAINED", snapshot: await snapshot() });
	} else {
		if (mode === "ack-write-fault")
			await run(() => prisma.$executeRawUnsafe('DROP TRIGGER "synthetic_process_log_refusal"'));
		await service.start();
		await service.drain();
		await service.start(); // Same startup must not admit a duplicate worker/send.
		await service.drain();
		const commanded = new Promise<unknown>((resolve) => process.once("message", resolve));
		await message({ state: "RESTARTED", snapshot: await snapshot() });
		const command = await commanded;
		assert.ok(
			command &&
				typeof command === "object" &&
				"action" in command &&
				command.action === "advance" &&
				"now" in command &&
				typeof command.now === "string",
		);
		const next = new Date(command.now);
		assert.ok(Number.isFinite(next.getTime()) && next >= now);
		await service.shutdown();
		now = next;
		service = createService();
		await service.start();
		await service.drain();
		await message({ state: "RECOVERED", snapshot: await snapshot() });
		await run(() =>
			service.notify(
				{ ...payload, title: "Synthetic independent control", metadata: { aggregated: true } },
				{ userId: owner, skipRules: true },
			),
		);
		await service.shutdown();
		await message({ state: "CONTROL", snapshot: await snapshot() });
	}
	assert.equal(blockedNetworkCalls, 0);
	await service.shutdown();
	await native.close();
	await runtime.close();
	process.disconnect?.();
	process.exit(0); // Only after real service/native lifetimes are joined; logging worker is idle.
}
void main().catch(async (error: unknown) => {
	process.stderr.write(error instanceof Error ? `${error.stack}\n` : "Synthetic actor failure.\n");
	await message({
		state: "ACTOR_ERROR",
		category: error instanceof assert.AssertionError ? "assertion" : "setup-or-runtime",
	}).catch(() => {});
	process.disconnect?.();
	process.exit(2);
});
