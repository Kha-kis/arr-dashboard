/**
 * Programmatic Sonarr/Radarr Connect webhook installer (issue #422).
 *
 * Auto-discovers the user's enabled Sonarr/Radarr instances, queries each
 * for an existing arr-dashboard webhook, and either creates or updates the
 * notification with the current arr-dashboard webhook URL + Bearer secret.
 *
 * The plaintext webhook secret is NOT stored at rest. It comes from the
 * frontend (which has it in session memory after the user clicked Generate
 * or Rotate) and is passed through this module to the *arr's notification
 * API. We never log the secret and never echo it in error messages.
 */

import { ArrError } from "arr-sdk";
import type { ArrClient, ArrClientFactory } from "../arr/client-factory.js";
import type { PrismaClient, ServiceInstance } from "../prisma.js";
import { getErrorMessage } from "../utils/error-message.js";

/** Notification name used to identify arr-dashboard's webhook in *arr's UI. */
export const ARR_DASHBOARD_NOTIFICATION_NAME = "arr-dashboard auto-tagger";

export interface InstallEvents {
	onDownload: boolean; // post-import — primary event
	onUpgrade: boolean;
	onGrab: boolean;
}

export const DEFAULT_EVENTS: InstallEvents = {
	onDownload: true,
	onUpgrade: true,
	onGrab: false,
};

export interface InstallStatusEntry {
	instanceId: string;
	label: string;
	service: "SONARR" | "RADARR";
	installed: boolean;
	/** Notification id in the *arr (only present when installed). */
	notificationId: number | null;
	/** Last error encountered probing this instance (e.g. "instance unreachable"). */
	error: string | null;
}

export interface InstallResultEntry {
	instanceId: string;
	label: string;
	service: "SONARR" | "RADARR";
	status: "installed" | "updated" | "skipped" | "failed";
	notificationId: number | null;
	error: string | null;
}

interface InstallerDeps {
	prisma: PrismaClient;
	arrClientFactory: ArrClientFactory;
}

/**
 * Build the Connect webhook notification payload for a given *arr instance.
 *
 * Field-name spelling differs slightly between *arr versions, but all
 * versions accept the lowercase forms used here. Forwards-compatible by
 * checking field names case-insensitively when reading existing
 * notifications.
 */
function buildNotificationPayload(args: {
	webhookUrl: string;
	bearerSecret: string;
	events: InstallEvents;
}) {
	return {
		name: ARR_DASHBOARD_NOTIFICATION_NAME,
		implementation: "Webhook",
		implementationName: "Webhook",
		configContract: "WebhookSettings",
		// Connect's webhook fields use a name/value pair list; the *arr UI
		// renders these as the form inputs. method=1 → POST.
		fields: [
			{ name: "url", value: args.webhookUrl },
			{ name: "method", value: 1 },
			{ name: "username", value: "" },
			{ name: "password", value: "" },
			{
				name: "headers",
				value: [{ key: "Authorization", value: `Bearer ${args.bearerSecret}` }],
			},
		],
		tags: [],
		onGrab: args.events.onGrab,
		onDownload: args.events.onDownload,
		onUpgrade: args.events.onUpgrade,
		onRename: false,
		onMovieAdded: false,
		onMovieDelete: false,
		onMovieFileDelete: false,
		onMovieFileDeleteForUpgrade: false,
		onSeriesAdd: false,
		onSeriesDelete: false,
		onEpisodeFileDelete: false,
		onEpisodeFileDeleteForUpgrade: false,
		onHealthIssue: false,
		onHealthRestored: false,
		onApplicationUpdate: false,
		onManualInteractionRequired: false,
		includeHealthWarnings: false,
	};
}

/** Find an existing arr-dashboard notification on this *arr by name match. */
async function findExistingNotification(client: ArrClient): Promise<{
	id: number;
} | null> {
	// biome-ignore lint/suspicious/noExplicitAny: SDK union typing requires the cast
	const all = (await (client as any).notification.getAll()) as Array<{
		id?: number;
		name?: string | null;
	}>;
	const match = all.find((n) => n.name === ARR_DASHBOARD_NOTIFICATION_NAME);
	if (!match || typeof match.id !== "number") return null;
	return { id: match.id };
}

/** Probe one instance for current install state. Failures don't throw. */
export async function probeInstallStatus(
	deps: InstallerDeps,
	instance: ServiceInstance,
): Promise<InstallStatusEntry> {
	const base: Pick<InstallStatusEntry, "instanceId" | "label" | "service"> = {
		instanceId: instance.id,
		label: instance.label,
		service: instance.service as "SONARR" | "RADARR",
	};

	try {
		const client = deps.arrClientFactory.create({
			id: instance.id,
			baseUrl: instance.baseUrl,
			encryptedApiKey: instance.encryptedApiKey,
			encryptionIv: instance.encryptionIv,
			service: instance.service,
			label: instance.label,
		});
		const found = await findExistingNotification(client);
		return {
			...base,
			installed: found !== null,
			notificationId: found?.id ?? null,
			error: null,
		};
	} catch (err) {
		return { ...base, installed: false, notificationId: null, error: getErrorMessage(err) };
	}
}

/** Install or update arr-dashboard's webhook on a single instance. */
export async function installOnInstance(
	deps: InstallerDeps,
	instance: ServiceInstance,
	args: { webhookUrl: string; bearerSecret: string; events: InstallEvents },
): Promise<InstallResultEntry> {
	const base: Pick<InstallResultEntry, "instanceId" | "label" | "service"> = {
		instanceId: instance.id,
		label: instance.label,
		service: instance.service as "SONARR" | "RADARR",
	};

	try {
		const client = deps.arrClientFactory.create({
			id: instance.id,
			baseUrl: instance.baseUrl,
			encryptedApiKey: instance.encryptedApiKey,
			encryptionIv: instance.encryptionIv,
			service: instance.service,
			label: instance.label,
		});
		const existing = await findExistingNotification(client);
		const payload = buildNotificationPayload(args);

		if (existing) {
			// biome-ignore lint/suspicious/noExplicitAny: SDK union typing requires the cast
			const updated = (await (client as any).notification.update(existing.id, {
				...payload,
				id: existing.id,
			})) as { id?: number };
			return {
				...base,
				status: "updated",
				notificationId: updated.id ?? existing.id,
				error: null,
			};
		}

		// biome-ignore lint/suspicious/noExplicitAny: SDK union typing requires the cast
		const created = (await (client as any).notification.create(payload)) as { id?: number };
		return {
			...base,
			status: "installed",
			notificationId: created.id ?? null,
			error: null,
		};
	} catch (err) {
		// Prefix the HTTP status code only when the error is an ArrError —
		// avoids the unsafe `as ArrError` cast that hid type-narrowing.
		const message = getErrorMessage(err);
		const reason = err instanceof ArrError ? `${err.statusCode} ${message}`.trim() : message;
		return { ...base, status: "failed", notificationId: null, error: reason };
	}
}

/** List the user's enabled Sonarr/Radarr instances eligible for auto-install. */
export async function listEligibleInstances(
	prisma: PrismaClient,
	userId: string,
): Promise<ServiceInstance[]> {
	return prisma.serviceInstance.findMany({
		where: {
			userId,
			service: { in: ["SONARR", "RADARR"] },
			enabled: true,
		},
		orderBy: [{ service: "asc" }, { label: "asc" }],
	});
}
