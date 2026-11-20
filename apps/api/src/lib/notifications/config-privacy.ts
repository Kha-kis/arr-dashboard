import {
	channelConfigSchemaMap,
	NOTIFICATION_CONFIG_PRIVATE_FIELDS,
	type NotificationChannelType,
	REDACTED_NOTIFICATION_CONFIG_VALUE,
} from "@arr/shared";
import { NotificationFailureError } from "./failure-diagnostics.js";

// URLs can carry credentials in userinfo, path or query. Arbitrarily named
// headers can also be secrets, so their entire container remains server-side.
const PRIVATE_FIELDS: Record<NotificationChannelType, ReadonlySet<string>> = {
	DISCORD: new Set(NOTIFICATION_CONFIG_PRIVATE_FIELDS.DISCORD),
	SLACK: new Set(NOTIFICATION_CONFIG_PRIVATE_FIELDS.SLACK),
	TELEGRAM: new Set(NOTIFICATION_CONFIG_PRIVATE_FIELDS.TELEGRAM),
	EMAIL: new Set(NOTIFICATION_CONFIG_PRIVATE_FIELDS.EMAIL),
	BROWSER_PUSH: new Set(NOTIFICATION_CONFIG_PRIVATE_FIELDS.BROWSER_PUSH),
	PUSHBULLET: new Set(NOTIFICATION_CONFIG_PRIVATE_FIELDS.PUSHBULLET),
	PUSHOVER: new Set(NOTIFICATION_CONFIG_PRIVATE_FIELDS.PUSHOVER),
	GOTIFY: new Set(NOTIFICATION_CONFIG_PRIVATE_FIELDS.GOTIFY),
	NTFY: new Set(NOTIFICATION_CONFIG_PRIVATE_FIELDS.NTFY),
	WEBHOOK: new Set(NOTIFICATION_CONFIG_PRIVATE_FIELDS.WEBHOOK),
};

class RetainedConfigValueError extends Error {
	readonly statusCode = 400;
	constructor() {
		super(
			"Stored values can only retain an existing secret field. Reopen channel settings or enter a replacement.",
		);
		this.name = "Invalid retained configuration";
	}
}

export function hasRetainedNotificationConfig(config: Record<string, unknown>): boolean {
	return Object.values(config).some((value) => value === REDACTED_NOTIFICATION_CONFIG_VALUE);
}

export function rejectNewNotificationConfigMarkers(config: Record<string, unknown>): void {
	if (hasRetainedNotificationConfig(config)) throw new RetainedConfigValueError();
}

export function validateStoredNotificationConfig(
	type: NotificationChannelType,
	config: unknown,
): Record<string, unknown> {
	const schema = channelConfigSchemaMap[type];
	const parsed = schema?.safeParse(config);
	if (!parsed?.success) throw new NotificationFailureError("configuration");
	return parsed.data as Record<string, unknown>;
}

export function redactNotificationConfig(
	type: NotificationChannelType,
	config: unknown,
): Record<string, unknown> {
	const validated = validateStoredNotificationConfig(type, config);
	return Object.fromEntries(
		Object.entries(validated).map(([key, value]) => {
			const populated =
				typeof value === "string"
					? value.length > 0
					: typeof value === "object" && value !== null && Object.keys(value).length > 0;
			return [
				key,
				PRIVATE_FIELDS[type].has(key) && populated ? REDACTED_NOTIFICATION_CONFIG_VALUE : value,
			];
		}),
	);
}

export function resolveRetainedNotificationConfig(
	type: NotificationChannelType,
	incoming: Record<string, unknown>,
	existing: Record<string, unknown>,
): Record<string, unknown> {
	return Object.fromEntries(
		Object.entries(incoming).map(([key, value]) => {
			if (value !== REDACTED_NOTIFICATION_CONFIG_VALUE) return [key, value];
			if (
				!PRIVATE_FIELDS[type]?.has(key) ||
				!Object.hasOwn(existing, key) ||
				existing[key] === undefined
			)
				throw new RetainedConfigValueError();
			return [key, existing[key]];
		}),
	);
}
