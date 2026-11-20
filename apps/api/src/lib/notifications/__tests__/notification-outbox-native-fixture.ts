import { randomUUID } from "node:crypto";
import { chmod, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { Encryptor } from "../../auth/encryption.js";
import { openRestoreRuntime } from "../../backup/restore-runtime-admission.js";
import { createRuntimePrismaClient } from "../../backup/restore-runtime-client.js";
import { synchronizeRuntimeSchema } from "../../backup/runtime-schema-startup.js";
import { createNotificationOutboxRepository } from "../outbox-repository.js";
import type { NotificationPayload } from "../types.js";

/** Only newly-owned synthetic databases; no app configuration or provider connection. */
export async function createNotificationOutboxNativeFixture() {
	const engine = process.env.NOTIFICATION_OUTBOX_TEST_ENGINE ?? "sqlite";
	let url: string;
	if (engine === "postgresql") {
		const supplied = process.env.RESTORE_RUNTIME_TEST_PG_URL;
		if (!supplied) throw new Error("Owned notification PostgreSQL fixture required.");
		const parsed = new URL(supplied);
		if (
			parsed.protocol !== "postgresql:" ||
			parsed.hostname !== "127.0.0.1" ||
			!parsed.port ||
			!/^arr_native_[a-f0-9]{32}_test$/.test(parsed.username) ||
			parsed.pathname !== `/${parsed.username}` ||
			!parsed.password ||
			parsed.search ||
			parsed.hash
		)
			throw new Error("Owned notification PostgreSQL fixture required.");
		url = supplied;
	} else if (engine === "sqlite") {
		const directory = await mkdtemp(join(tmpdir(), "arr-outbox-worker-"));
		await chmod(directory, 0o700);
		const file = join(directory, "owned.db");
		new Database(file).close();
		await chmod(file, 0o600);
		url = `file:${file}`;
	} else throw new Error("Owned notification database required.");
	await synchronizeRuntimeSchema(url);
	let runtime = await openRestoreRuntime({ databaseUrl: url });
	await runtime.bindDestination("synthetic-notification-outbox-destination");
	await runtime.activate();
	let native = createRuntimePrismaClient(runtime);
	const encryptor = new Encryptor("9".repeat(64));
	let now = new Date("2026-10-10T12:00:00.000Z");
	const ownedUsers: string[] = [];
	async function createOwner() {
		const userId = randomUUID();
		const config = encryptor.encrypt(
			JSON.stringify({ webhookUrl: "https://example.invalid/synthetic-worker" }),
		);
		await native.prisma.user.create({ data: { id: userId, username: `synthetic-${userId}` } });
		ownedUsers.push(userId);
		const channel = await native.prisma.notificationChannel.create({
			data: {
				userId,
				name: "Synthetic worker channel",
				type: "DISCORD",
				encryptedConfig: config.value,
				configIv: config.iv,
				subscriptions: { create: { eventType: "HUNT_COMPLETED" } },
			},
		});
		return { userId, channelId: channel.id };
	}
	const { userId, channelId } = await runtime.runOperation(createOwner);
	const payload: NotificationPayload = {
		eventType: "HUNT_COMPLETED",
		title: "Synthetic worker event",
		body: "Synthetic worker body",
		metadata: { exact: [1, true] },
	};
	return {
		engine,
		userId,
		channelId,
		encryptor,
		payload,
		get runtime() {
			return runtime;
		},
		get prisma() {
			return native.prisma;
		},
		get now() {
			return new Date(now);
		},
		set now(value: Date) {
			now = new Date(value);
		},
		clock: () => new Date(now),
		repository: () =>
			createNotificationOutboxRepository(native.prisma, runtime, encryptor, userId, {
				clock: () => new Date(now),
			}),
		input: () => ({
			payload,
			recipients: [
				{
					channelId,
					channelType: "DISCORD" as const,
					subscriptionEventType: "HUNT_COMPLETED" as const,
				},
			],
			policy: { stage: "ready" as const },
		}),
		run: <T>(operation: () => Promise<T>) => runtime.runOperation(operation),
		async restart(activate = true) {
			await native.close();
			await runtime.close();
			runtime = await openRestoreRuntime({ databaseUrl: url });
			await runtime.bindDestination("synthetic-notification-outbox-destination");
			if (activate) await runtime.activate();
			native = createRuntimePrismaClient(runtime);
		},
		createOwner: () => runtime.runOperation(createOwner),
		async close() {
			// After callers join their service/worker, remove only users created here.
			// The PostgreSQL server is owned but shared between cases in one suite.
			// Same-database restart tests occur before this teardown, never after it.
			if (engine === "postgresql")
				await runtime.runOperation(() =>
					native.prisma.user.deleteMany({ where: { id: { in: ownedUsers } } }),
				);
			await native.close();
			await runtime.close();
		},
	};
}
