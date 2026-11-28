/**
 * Auto-import handler for queue cleaner.
 *
 * Evaluates eligibility and attempts auto-import for stuck
 * import_pending/import_blocked queue items before removal.
 */

import type { AutoImportResult } from "@arr/shared";
import type { FastifyInstance } from "fastify";
import { submitTrackedAutomaticImport } from "../arr/import-operations/submission.js";
import type { ManualImportCommandOutcome } from "../arr/manual-import-command.js";
import { loggers } from "../logger.js";
import type { ServiceInstance } from "../prisma.js";
import { importConnectionFingerprint, type QueueSourceActionPermit } from "./import-receipt.js";
import type { RawQueueItem } from "./queue-item-utils.js";

export { evaluateAutoImportEligibility } from "./auto-import-policy.js";

const log = loggers.queueCleaner;

export interface TrackedAutoImportOptions {
	queueId: number;
	queueFingerprint: string;
	attemptOrdinal: number;
	sourcePermit: QueueSourceActionPermit;
	currentQueueGate: (item: RawQueueItem, preparedOperationId?: string) => Promise<boolean>;
}

/**
 * Attempt to auto-import a queue item.
 *
 * @param app - Fastify instance with ARR client factory
 * @param instance - Service instance to import on
 * @param downloadId - Download ID of the item to import
 * @param _itemTitle - Compatibility display value; never logged
 * @returns Import result with success/failure status
 */
export async function attemptAutoImport(
	app: FastifyInstance,
	instance: ServiceInstance,
	downloadId: string,
	_itemTitle: string,
	options: TrackedAutoImportOptions,
): Promise<
	AutoImportResult & {
		safetyBlocked?: boolean;
		commandId?: number;
		commandState?: ManualImportCommandOutcome["state"];
	}
> {
	const service = instance.service.toLowerCase();
	if (
		service !== "sonarr" &&
		service !== "radarr" &&
		service !== "lidarr" &&
		service !== "readarr"
	) {
		return {
			attempted: false,
			success: false,
			safetyBlocked: true,
			skippedReason: "Automatic import is unavailable for this service.",
		};
	}

	try {
		const operation = await submitTrackedAutomaticImport(
			{
				prisma: app.prisma,
				encryptor: app.encryptor,
				createClient: (connection, clientOptions) => {
					if (
						connection.service !== "SONARR" &&
						connection.service !== "RADARR" &&
						connection.service !== "LIDARR" &&
						connection.service !== "READARR"
					) {
						throw new Error("Automatic import connection is unavailable.");
					}
					return app.arrClientFactory.create(
						{ ...connection, service: connection.service },
						clientOptions,
					);
				},
			},
			{
				userId: instance.userId,
				instanceId: instance.id,
				service,
				downloadId,
				queueId: options.queueId,
				queueFingerprint: options.queueFingerprint,
				attemptOrdinal: options.attemptOrdinal,
				connectionFingerprint: importConnectionFingerprint(instance),
			},
			{ sourcePermit: options.sourcePermit, currentQueueGate: options.currentQueueGate },
		);
		const commandState =
			operation.commandState === "failed"
				? "failed"
				: operation.commandState === "pending"
					? "pending"
					: "unknown";
		log.info({ category: commandState }, "Automatic import attempt recorded; source retained");
		// A POST receipt cannot verify per-file import results. Reconcile completed
		// commands with positive provider history on the next invocation.
		return {
			attempted: operation.submissionStartedAt !== null,
			success: false,
			commandId: operation.commandId ?? undefined,
			commandState,
		};
	} catch {
		// Neither failed preparation nor an unobserved write grants cleanup authority.
		log.warn(
			{ category: "automatic-import-unavailable" },
			"Automatic import unavailable; source retained",
		);
		return {
			attempted: false,
			success: false,
			safetyBlocked: true,
			error:
				"Automatic import evidence or preparation is unavailable; source retained. Observe import progress before retrying.",
		};
	}
}
