import { createHash } from "node:crypto";
import type { NotificationChannel } from "../prisma.js";

/** Settings only: delivery diagnostics, timestamps, and subscriptions do not invalidate an edit. */
export function channelConfigRevision(
	channel: Pick<
		NotificationChannel,
		"id" | "userId" | "type" | "name" | "enabled" | "encryptedConfig" | "configIv"
	>,
): string {
	return createHash("sha256")
		.update(
			JSON.stringify([
				channel.id,
				channel.userId,
				channel.type,
				channel.name,
				channel.enabled,
				channel.encryptedConfig,
				channel.configIv,
			]),
		)
		.digest("hex");
}
