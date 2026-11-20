import Fastify, { type FastifyInstance } from "fastify";
import pino from "pino";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	createInjectAuthenticated,
	setupAuthInjection,
} from "../../../routes/__tests__/test-helpers.js";
import { registerNotificationRoutes } from "../../../routes/notifications.js";
import type { Encryptor } from "../../auth/encryption.js";
import type { PrismaClientInstance } from "../../prisma.js";
import { NotificationDispatcher } from "../notification-dispatcher.js";
import { NotificationService } from "../notification-service.js";
import type { NotificationPayload, SendResult } from "../types.js";
import { createNotificationOutboxNativeFixture } from "./notification-outbox-native-fixture.js";

let fixture: Awaited<ReturnType<typeof createNotificationOutboxNativeFixture>>;
let prisma: PrismaClientInstance;
let encryptor: Encryptor;
let owner: string;
let ownedChannel: string;
let otherOwner: string;
let otherChannel: string;
let service: NotificationService;
let logs: string[];
let sends: number;
let result: SendResult;
let app: FastifyInstance;
const privateMarker = "synthetic-private-provider-token";
const privateError = `https://synthetic.invalid/token/${privateMarker} provider response ${privateMarker}`;
const payload: NotificationPayload = {
	eventType: "HUNT_COMPLETED",
	title: "Synthetic event",
	body: "Synthetic notification",
};

beforeEach(async () => {
	fixture = await createNotificationOutboxNativeFixture();
	prisma = fixture.prisma;
	encryptor = fixture.encryptor;
	owner = fixture.userId;
	ownedChannel = fixture.channelId;
	const other = await fixture.createOwner();
	otherOwner = other.userId;
	otherChannel = other.channelId;
	await fixture.run(async () => {
		const encrypted = encryptor.encrypt(
			JSON.stringify({ webhookUrl: "https://synthetic.invalid" }),
		);
		await prisma.notificationChannel.updateMany({
			where: { id: { in: [ownedChannel, otherChannel] } },
			data: { encryptedConfig: encrypted.value, configIv: encrypted.iv },
		});
		await prisma.notificationChannel.update({
			where: { id: ownedChannel, userId: owner },
			data: { name: privateMarker },
		});
	});
	logs = [];
	sends = 0;
	const logger = pino(
		{ level: "debug", base: null, timestamp: false },
		{ write: (line: string) => logs.push(line) },
	);
	const dispatcher = new NotificationDispatcher();
	dispatcher.registerSender("DISCORD", {
		send: async () => {
			sends++;
			return result;
		},
		test: async () => {},
	});
	service = new NotificationService(
		prisma,
		encryptor,
		dispatcher,
		logger,
		undefined,
		undefined,
		"https://synthetic.invalid",
		undefined,
		undefined,
		{ runtime: fixture.runtime, clock: fixture.clock },
	);
	app = Fastify({ logger: false });
	app.decorate("prisma", prisma);
	setupAuthInjection(app, { id: owner, username: "synthetic-owner" });
	await app.register(registerNotificationRoutes);
	await app.ready();
});

afterEach(async () => {
	try {
		await app?.close();
		await service?.shutdown();
	} finally {
		await fixture?.close();
	}
});

describe("real native delivery persistence and logs preserve safe actionable outcomes", () => {
	it.each([
		["authentication", /credentials|permissions/i],
		["rate-limited", /rate|wait/i],
		["timeout", /timed out|network/i],
		["provider-unavailable", /provider|availability/i],
	] as const)(
		"retains %s evidence without raw secrets or channel names",
		async (category, action) =>
			fixture.run(async () => {
				result = {
					success: false,
					retryable: category !== "authentication",
					error: privateError,
					failureCategory: category,
				};
				await service.notify(payload, { userId: owner });
				const rows = await prisma.notificationLog.findMany({ where: { channelId: ownedChannel } });
				expect(rows).toHaveLength(1);
				expect(rows[0]).toMatchObject({ channelId: ownedChannel, status: "failed", retryCount: 0 });
				expect(rows[0]?.error).toMatch(action);
				expect(rows[0]?.error).not.toContain(privateMarker);
				expect(
					(
						await prisma.notificationChannel.findUniqueOrThrow({
							where: { id: ownedChannel, userId: owner },
						})
					).lastSendResult,
				).toBe("failed");
				expect(
					(
						await prisma.notificationChannel.findUniqueOrThrow({
							where: { id: otherChannel, userId: otherOwner },
						})
					).lastSendResult,
				).toBeNull();
				expect(logs.join("\n")).not.toContain(privateMarker);
				expect(sends).toBe(1);
				expect(
					await prisma.notificationOutboxDelivery.count({
						where: { userId: owner, state: "retry-waiting" },
					}),
				).toBe(category === "authentication" ? 0 : 1);
				expect(await prisma.notificationOutboxEvent.count({ where: { userId: otherOwner } })).toBe(
					0,
				);
				const response = await createInjectAuthenticated(app)("GET", "/logs");
				expect(await prisma.notificationLog.count({ where: { channelId: otherChannel } })).toBe(0);
				expect(response.statusCode).toBe(200);
				expect(response.json().logs[0]?.error).toBe(rows[0]?.error);
				expect(response.payload).not.toContain(privateMarker);
			}),
	);

	it("unknown legacy error input cannot enter stored diagnostics or last-send status", async () =>
		fixture.run(async () => {
			const context = await prisma.notificationChannel.findUniqueOrThrow({
				where: { id: ownedChannel, userId: owner },
			});
			await service.logDelivery(ownedChannel, "DISCORD", payload, "dead_letter", privateError, 3, {
				id: context.id,
				userId: context.userId,
				type: context.type,
				encryptedConfig: context.encryptedConfig,
				configIv: context.configIv,
			});
			const row = await prisma.notificationLog.findFirstOrThrow({
				where: { channelId: ownedChannel },
			});
			expect(row).toMatchObject({ status: "dead_letter", retryCount: 3 });
			expect(row.error).toMatch(/not confirmed|check/i);
			expect(row.error).not.toContain(privateMarker);
			expect(
				(
					await prisma.notificationChannel.findUniqueOrThrow({
						where: { id: ownedChannel, userId: owner },
					})
				).lastSendResult,
			).toBe("failed");
		}));

	it("corrupted decrypted configuration retains a private non-delivery reason without inventing a send", async () =>
		fixture.run(async () => {
			const encrypted = encryptor.encrypt(`not-json-${privateMarker}`);
			await prisma.notificationChannel.update({
				where: { id: ownedChannel, userId: owner },
				data: { encryptedConfig: encrypted.value, configIv: encrypted.iv },
			});
			await service.notify(payload, { userId: owner });
			expect(sends).toBe(0);
			expect(await prisma.notificationLog.count({ where: { channelId: ownedChannel } })).toBe(0);
			const row = await prisma.notificationOutboxDelivery.findFirstOrThrow({
				where: { userId: owner },
			});
			expect(row).toMatchObject({
				state: "canceled",
				outcomeCategory: "configuration",
				attemptOrdinal: 0,
				attemptToken: null,
				dispatchedAt: null,
			});
			expect(JSON.stringify(row)).not.toContain(privateMarker);
			expect(logs.join("\n")).not.toContain(privateMarker);
			expect(
				(
					await prisma.notificationChannel.findUniqueOrThrow({
						where: { id: ownedChannel, userId: owner },
					})
				).lastSendResult,
			).toBeNull();
			expect(
				await prisma.notificationOutboxDelivery.count({
					where: { userId: owner, state: "retry-waiting" },
				}),
			).toBe(0);
		}));

	it("confirmed delivery retains success and no failure diagnostic", async () =>
		fixture.run(async () => {
			result = { success: true, retryable: false };
			await service.notify(payload, { userId: owner });
			const row = await prisma.notificationLog.findFirstOrThrow({
				where: { channelId: ownedChannel },
			});
			expect(row).toMatchObject({ status: "sent", error: null, retryCount: 0 });
			expect(sends).toBe(1);
			expect(
				(
					await prisma.notificationChannel.findUniqueOrThrow({
						where: { id: ownedChannel, userId: owner },
					})
				).lastSendResult,
			).toBe("success");
			expect(
				await prisma.notificationOutboxDelivery.count({
					where: { userId: owner, state: "retry-waiting" },
				}),
			).toBe(0);
		}));
});
