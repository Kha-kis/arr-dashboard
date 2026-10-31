import Fastify from "fastify";
import fp from "fastify-plugin";
import { vi } from "vitest";
import { envSchema } from "../../../config/env.js";
import {
	registerRestoreBootstrapPlugin,
	registerRestoreRuntimeActivation,
} from "../../../lib/backup/restore-runtime-bootstrap.js";
import { createRuntimePrismaClient } from "../../../lib/backup/restore-runtime-client.js";
import { createNotificationOutboxNativeFixture } from "../../../lib/notifications/__tests__/notification-outbox-native-fixture.js";
import { NotificationDispatcher } from "../../../lib/notifications/notification-dispatcher.js";
import type { NotificationPayload, SendResult } from "../../../lib/notifications/types.js";
import type { PrismaClientInstance } from "../../../lib/prisma.js";
import notificationServicePlugin from "../../notification-service.js";

type NativeFixture = Awaited<ReturnType<typeof createNotificationOutboxNativeFixture>>;

/** Real plugin/bootstrap and distinct native app/observer clients; synthetic destinations only. */
export async function bootNotificationNativeApp(
	options: {
		prepare?: (fixture: NativeFixture) => Promise<void>;
		transport?: (payload: NotificationPayload) => Promise<SendResult>;
		beforeClose?: Promise<void>;
		instrument?: (prisma: PrismaClientInstance, fixture: NativeFixture, order: string[]) => void;
		awaitStartup?: boolean;
	} = {},
) {
	const native = await createNotificationOutboxNativeFixture();
	const state = {
		pendingTransports: 0,
		pendingAtDatabaseClose: -1,
		databaseCloseCount: 0,
		physicalClientClosed: false,
		order: [] as string[],
	};
	const payloads: NotificationPayload[] = [];
	const app = Fastify({ logger: false });
	let appNative: ReturnType<typeof createRuntimePrismaClient> | undefined;
	let observedPreClose!: () => void;
	const preClosed = new Promise<void>((resolve) => {
		observedPreClose = resolve;
	});
	let transportSpy: ReturnType<typeof vi.spyOn> | undefined;
	try {
		if (options.prepare) await native.run(() => options.prepare!(native));
		await native.restart(false);
		appNative = createRuntimePrismaClient(native.runtime);
		const currentClient = appNative;
		options.instrument?.(currentClient.prisma, native, state.order);
		transportSpy = vi
			.spyOn(NotificationDispatcher.prototype, "send")
			.mockImplementation(async (type, config, payload) => {
				if (
					type !== "DISCORD" ||
					config.webhookUrl !== "https://example.invalid/synthetic-worker"
				) {
					throw new Error("Fixture refuses an unexpected notification destination");
				}
				payloads.push(payload);
				state.order.push("transport-start");
				state.pendingTransports++;
				try {
					return options.transport
						? await options.transport(payload)
						: { success: true, retryable: false };
				} finally {
					state.pendingTransports--;
					state.order.push("transport-settled");
				}
			});
		app.decorate("restoreRuntime", native.runtime);
		app.decorate("prisma", currentClient.prisma);
		app.decorate("encryptor", native.encryptor);
		app.decorate(
			"config",
			envSchema.parse({ NODE_ENV: "test", APP_URL: "https://synthetic.invalid" }),
		);
		app.register(
			fp(
				async (server) => {
					server.addHook("onClose", async () => {
						state.pendingAtDatabaseClose = state.pendingTransports;
						state.order.push("database-close-start");
						await currentClient.close();
						state.physicalClientClosed = true;
						state.databaseCloseCount++;
						state.order.push("database-close-complete");
					});
				},
				{ name: "prisma" },
			),
		);
		app.register(fp(async () => {}, { name: "security" }));
		registerRestoreBootstrapPlugin(app, notificationServicePlugin);
		// Observe after the real plugin closes admission, independent of whether
		// Fastify registers root preClose hooks immediately or defers them.
		app.register(
			fp(
				async (server) => {
					server.addHook("preClose", async () => {
						observedPreClose();
					});
					if (options.beforeClose)
						server.addHook("preClose", async () => {
							await options.beforeClose;
						});
				},
				{ name: "notification-shutdown-observer", dependencies: ["notification-service"] },
			),
		);
		registerRestoreRuntimeActivation(app);
		await app.ready();
		if (options.awaitStartup !== false) await app.notificationService.drain();
	} catch (error) {
		try {
			await app.close();
		} finally {
			transportSpy?.mockRestore();
			await appNative?.close();
			await native.close();
		}
		throw error;
	}
	return {
		app,
		native,
		state,
		payloads,
		preClosed,
		notify: (payload = native.payload, options?: { skipRules?: boolean }) =>
			app.notificationService.notify(payload, { ...options, userId: native.userId }),
		deliveries: () =>
			native.run(() =>
				native.prisma.notificationOutboxDelivery.findMany({
					where: { userId: native.userId, channelId: native.channelId },
				}),
			),
		history: () =>
			native.run(() =>
				native.prisma.notificationLog.findMany({
					where: { channelId: native.channelId },
					orderBy: { retryCount: "asc" },
				}),
			),
		async dispose() {
			try {
				await app.close();
			} finally {
				transportSpy?.mockRestore();
				await native.close();
			}
		},
	};
}
