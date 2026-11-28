import {
	type BrowserPushConfig,
	type BrowserPushDisableRequest,
	type BrowserPushEnableRequest,
	type BrowserPushReconnectRequest,
	type BrowserPushState,
	type BrowserPushStateRequest,
	browserPushConfigSchema,
	browserPushStateSchema,
	notificationEventTypeSchema,
} from "@arr/shared";
import { dequal } from "dequal";
import type { Encryptor } from "../auth/encryption.js";
import type { NotificationChannel, Prisma, PrismaClient } from "../prisma.js";
import { channelConfigRevision } from "./channel-config-revision.js";

export class BrowserPushLifecycleError extends Error {
	constructor(readonly statusCode: 400 | 404 | 409) {
		super("Browser push device state could not be verified.");
	}
}
const unavailable = () => new BrowserPushLifecycleError(409);
type Device = { row: NotificationChannel; config: BrowserPushConfig };
const unregistered: BrowserPushState = {
	channelId: null,
	configRevision: null,
	state: "unregistered",
	subscribedEventCount: 0,
};

function decode(row: NotificationChannel, encryptor: Encryptor): BrowserPushConfig {
	try {
		return browserPushConfigSchema.parse(
			JSON.parse(encryptor.decrypt({ value: row.encryptedConfig, iv: row.configIv })),
		);
	} catch {
		throw unavailable();
	}
}

/** Decode only owned rows; endpoint lookup must rule out every possible duplicate. */
async function selectDevice(
	tx: Prisma.TransactionClient,
	encryptor: Encryptor,
	userId: string,
	selector: BrowserPushStateRequest,
	rebind = false,
): Promise<Device | null> {
	const rows = await tx.notificationChannel.findMany({ where: { userId, type: "BROWSER_PUSH" } });
	const retained = selector.channelId
		? rows.find((row) => row.id === selector.channelId)
		: undefined;
	if (selector.channelId && !retained) throw new BrowserPushLifecycleError(404);
	if (!selector.endpoint)
		return retained ? { row: retained, config: decode(retained, encryptor) } : null;
	const devices = rows.map((row) => ({ row, config: decode(row, encryptor) }));
	const matches = devices.filter((device) => device.config.endpoint === selector.endpoint);
	if (matches.length > 1) throw unavailable();
	if (retained) {
		const selected = devices.find((device) => device.row.id === retained.id)!;
		if (rebind) {
			if (matches.length && matches[0]!.row.id !== retained.id) throw unavailable();
		} else if (selected.config.endpoint !== selector.endpoint) throw unavailable();
		return selected;
	}
	return matches[0] ?? null;
}

async function stateOf(
	tx: Prisma.TransactionClient,
	userId: string,
	row: NotificationChannel,
): Promise<BrowserPushState> {
	const subscriptions = await tx.notificationSubscription.findMany({
		where: { channelId: row.id, channel: { userId, type: "BROWSER_PUSH" } },
		select: { eventType: true },
	});
	return browserPushStateSchema.parse({
		channelId: row.id,
		configRevision: channelConfigRevision(row),
		state: row.enabled ? "enabled" : "disabled",
		subscribedEventCount: subscriptions.filter(
			(subscription) => notificationEventTypeSchema.safeParse(subscription.eventType).success,
		).length,
	});
}

function assertRevision(device: Device, expectedRevision?: string) {
	if (expectedRevision !== undefined && channelConfigRevision(device.row) !== expectedRevision)
		throw unavailable();
}
function fence(row: NotificationChannel, userId: string): Prisma.NotificationChannelWhereInput {
	return {
		id: row.id,
		userId,
		type: "BROWSER_PUSH",
		name: row.name,
		enabled: row.enabled,
		encryptedConfig: row.encryptedConfig,
		configIv: row.configIv,
	};
}
async function lockOwner(tx: Prisma.TransactionClient, userId: string) {
	const count = await tx.$executeRaw`UPDATE "User" SET "id" = "id" WHERE "id" = ${userId}`;
	if (count !== 1) throw unavailable();
}
async function confirm(
	tx: Prisma.TransactionClient,
	encryptor: Encryptor,
	userId: string,
	id: string,
) {
	const row = await tx.notificationChannel.findFirst({
		where: { id, userId, type: "BROWSER_PUSH" },
	});
	if (!row) throw unavailable();
	decode(row, encryptor);
	return stateOf(tx, userId, row);
}

/** Read-only transaction snapshot: deliberately never takes the enrollment write lock. */
export function readBrowserPushState(
	prisma: PrismaClient,
	encryptor: Encryptor,
	userId: string,
	selector: BrowserPushStateRequest,
) {
	return prisma.$transaction(async (tx) => {
		const device = await selectDevice(tx, encryptor, userId, selector);
		return device ? stateOf(tx, userId, device.row) : unregistered;
	});
}

export function disableBrowserPush(
	prisma: PrismaClient,
	encryptor: Encryptor,
	userId: string,
	selector: BrowserPushDisableRequest,
) {
	return prisma.$transaction(async (tx) => {
		await lockOwner(tx, userId);
		const device = await selectDevice(tx, encryptor, userId, selector);
		if (!device) throw new BrowserPushLifecycleError(404);
		assertRevision(device, selector.expectedRevision);
		const result = await tx.notificationChannel.updateMany({
			where: fence(device.row, userId),
			data: { enabled: false },
		});
		if (result.count !== 1) throw unavailable();
		return confirm(tx, encryptor, userId, device.row.id);
	});
}

/** Selected explicit replacement never relies on decoding the selected old secrets. */
export function reconnectBrowserPush(
	prisma: PrismaClient,
	encryptor: Encryptor,
	userId: string,
	input: BrowserPushReconnectRequest,
) {
	return prisma.$transaction(async (tx) => {
		await lockOwner(tx, userId);
		const rows = await tx.notificationChannel.findMany({ where: { userId, type: "BROWSER_PUSH" } });
		const row = rows.find((candidate) => candidate.id === input.channelId);
		if (!row) throw new BrowserPushLifecycleError(404);
		if (channelConfigRevision(row) !== input.expectedRevision) throw unavailable();
		const endpoints = new Set<string>();
		for (const sibling of rows) {
			if (sibling.id === row.id) continue;
			const config = decode(sibling, encryptor);
			if (config.endpoint === input.endpoint || endpoints.has(config.endpoint)) throw unavailable();
			endpoints.add(config.endpoint);
		}
		const config = browserPushConfigSchema.parse({ endpoint: input.endpoint, ...input.keys });
		const encrypted = encryptor.encrypt(JSON.stringify(config));
		const result = await tx.notificationChannel.updateMany({
			where: fence(row, userId),
			data: {
				encryptedConfig: encrypted.value,
				configIv: encrypted.iv,
				lastTestedAt: null,
				lastTestResult: null,
			},
		});
		if (result.count !== 1) throw unavailable();
		const persisted = await tx.notificationChannel.findFirst({
			where: { id: row.id, userId, type: "BROWSER_PUSH" },
		});
		if (
			!persisted ||
			persisted.enabled !== row.enabled ||
			!dequal(decode(persisted, encryptor), config)
		)
			throw unavailable();
		return stateOf(tx, userId, persisted);
	});
}

/** Explicit operator intent; legacy registration keeps its original disabled-row policy. */
export function enableBrowserPush(
	prisma: PrismaClient,
	encryptor: Encryptor,
	userId: string,
	input: BrowserPushEnableRequest,
) {
	return prisma.$transaction(async (tx) => {
		await lockOwner(tx, userId);
		const device = await selectDevice(tx, encryptor, userId, input, true);
		const config = { endpoint: input.endpoint, p256dh: input.keys.p256dh, auth: input.keys.auth };
		if (device) {
			assertRevision(device, input.expectedRevision);
			const data: Prisma.NotificationChannelUpdateManyMutationInput = { enabled: true };
			if (!dequal(device.config, config)) {
				const encrypted = encryptor.encrypt(JSON.stringify(config));
				Object.assign(data, {
					encryptedConfig: encrypted.value,
					configIv: encrypted.iv,
					lastTestedAt: null,
					lastTestResult: null,
				});
			}
			const result = await tx.notificationChannel.updateMany({
				where: fence(device.row, userId),
				data,
			});
			if (result.count !== 1) throw unavailable();
			return confirm(tx, encryptor, userId, device.row.id);
		}
		const count = await tx.notificationChannel.count({ where: { userId, type: "BROWSER_PUSH" } });
		if (count >= 10) throw new BrowserPushLifecycleError(400);
		const encrypted = encryptor.encrypt(JSON.stringify(config));
		const row = await tx.notificationChannel.create({
			data: {
				userId,
				name: `Browser Push (${new Date().toLocaleDateString()})`,
				type: "BROWSER_PUSH",
				enabled: true,
				encryptedConfig: encrypted.value,
				configIv: encrypted.iv,
			},
		});
		return confirm(tx, encryptor, userId, row.id);
	});
}
