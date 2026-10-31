import {
	type NotificationChannelEditState,
	notificationChannelEditStateSchema,
	notificationChannelTypeSchema,
} from "@arr/shared";
import type { Encryptor } from "../auth/encryption.js";
import type { PrismaClient } from "../prisma.js";
import { channelConfigRevision } from "./channel-config-revision.js";
import { validateStoredNotificationConfig } from "./config-privacy.js";

/** A captured owned row certifies only whether its stored configuration can be read. */
export async function readChannelEditState(
	prisma: Pick<PrismaClient, "notificationChannel">,
	encryptor: Encryptor,
	id: string,
	userId: string,
): Promise<NotificationChannelEditState | null> {
	// Lookup and unsupported-type failures must never become permission to repair.
	const channel = await prisma.notificationChannel.findFirst({ where: { id, userId } });
	if (!channel) return null;
	const type = notificationChannelTypeSchema.parse(channel.type);
	let state: NotificationChannelEditState["state"] = "readable";
	try {
		validateStoredNotificationConfig(
			type,
			JSON.parse(encryptor.decrypt({ value: channel.encryptedConfig, iv: channel.configIv })),
		);
	} catch {
		state = "repair-required";
	}
	return notificationChannelEditStateSchema.parse({
		id: channel.id,
		name: channel.name,
		type,
		enabled: channel.enabled,
		configRevision: channelConfigRevision(channel),
		state,
	});
}
