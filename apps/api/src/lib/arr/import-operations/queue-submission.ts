import { createHash } from "node:crypto";
import type { ManualImportServiceType } from "@arr/shared";
import { LidarrClient, RadarrClient, ReadarrClient, SonarrClient } from "arr-sdk";
import {
	collectAutoManualImportFiles,
	fetchManualImportCandidatesWithSdk,
} from "../../../routes/manual-import-utils.js";
import { withIndependentCleanupOperationGuard } from "../../library-cleanup/cleanup-maintenance-gate.js";
import { acquireQueueSourceAction, queueDownloadKey } from "../../queue-cleaner/import-receipt.js";
import {
	queueItemFingerprint,
	readCurrentQueueItem,
} from "../../queue-cleaner/queue-observation.js";
import { ImportSourceConflictError } from "./action-guards.js";
import { withImportConnectionReadGuard } from "./connection-guards.js";
import { findImportSourceProtection, type OwnedImportAttempt } from "./repository.js";
import {
	ImportPreparationLimitError,
	type ImportSubmissionContext,
	submitTrackedImport,
	TrackedImportConflictError,
} from "./submission.js";

interface QueueManualImportInput {
	userId: string;
	instanceId: string;
	service: ManualImportServiceType;
	queueId: number;
	downloadId: string;
}

async function readBeforeDeadline<T>(read: () => Promise<T>, deadline: number): Promise<T> {
	const remaining = deadline - Date.now();
	if (remaining <= 0) throw new TrackedImportConflictError();
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			read(),
			new Promise<never>((_, reject) => {
				timer = setTimeout(() => reject(new TrackedImportConflictError()), remaining);
			}),
		]);
	} catch {
		// Never expose upstream response text or turn unavailable evidence into a target.
		throw new TrackedImportConflictError();
	} finally {
		if (timer !== undefined) clearTimeout(timer);
	}
}

/**
 * Compatibility producer for callers that supply a queue source, not a selected
 * file list. One owned connection/source always recovers the same attempt.
 * Intentional new selections/remainders use the keyed Manual Import workflow.
 */
export async function submitTrackedQueueManualImport(
	context: ImportSubmissionContext,
	input: QueueManualImportInput,
): Promise<OwnedImportAttempt> {
	const downloadKey = queueDownloadKey({ downloadId: input.downloadId });
	if (
		!input.userId ||
		!input.instanceId ||
		!downloadKey ||
		input.downloadId !== input.downloadId.trim() ||
		!Number.isSafeInteger(input.queueId) ||
		input.queueId <= 0
	)
		throw new TrackedImportConflictError();
	// Queue IDs may be reused/replaced. They are execution-time target evidence,
	// never a way to mint another attempt for an already submitted source.
	const idempotencyKey = `queue-compat-v1:${createHash("sha256")
		.update(JSON.stringify([input.userId, input.instanceId, input.service, downloadKey]))
		.digest("hex")}`;
	const existing = await context.prisma.arrImportOperation.findFirst({
		where: { userId: input.userId, idempotencyKey },
		include: { files: true },
	});
	if (existing) {
		if (
			existing.origin !== "manual" ||
			existing.mode !== "Move" ||
			existing.originalInstanceId !== input.instanceId ||
			existing.service.toLowerCase() !== input.service ||
			!existing.files.length ||
			existing.files.some((file) => file.downloadKey !== downloadKey)
		)
			throw new TrackedImportConflictError();
		return existing;
	}
	return withImportConnectionReadGuard(input.userId, input.instanceId, async () => {
		const instance = await context.prisma.serviceInstance.findFirst({
			where: { id: input.instanceId, userId: input.userId, enabled: true },
		});
		if (!instance || instance.service.toLowerCase() !== input.service)
			throw new TrackedImportConflictError();
		return withIndependentCleanupOperationGuard(async () => {
			const permit = acquireQueueSourceAction(input.userId, { downloadId: input.downloadId });
			if (!permit) throw new ImportSourceConflictError();
			try {
				if ((await findImportSourceProtection(context.prisma, input.userId, [downloadKey])).length)
					throw new TrackedImportConflictError();
				const deadline = Date.now() + 15_000;
				const client = context.createClient(instance, { timeout: 15_000 });
				const matchesClient =
					input.service === "sonarr"
						? client instanceof SonarrClient
						: input.service === "radarr"
							? client instanceof RadarrClient
							: input.service === "lidarr"
								? client instanceof LidarrClient
								: client instanceof ReadarrClient;
				if (!matchesClient) throw new TrackedImportConflictError();
				const item = await readBeforeDeadline(
					() => readCurrentQueueItem(client, instance.service, input.queueId),
					deadline,
				);
				const fingerprint = item && queueItemFingerprint(item);
				if (!item || !fingerprint || queueDownloadKey(item) !== downloadKey)
					throw new TrackedImportConflictError();
				const candidates = await readBeforeDeadline(
					() =>
						fetchManualImportCandidatesWithSdk(client, input.service, {
							downloadId: input.downloadId,
							filterExistingFiles: true,
						}),
					deadline,
				);
				if (candidates.length > 1000) throw new ImportPreparationLimitError();
				const selection = collectAutoManualImportFiles(
					input.service,
					candidates,
					input.downloadId,
					item,
				);
				// This route has no explicit subset/override UI. Do not silently import
				// only the convenient portion of a rejected or mismapped source.
				if (
					!selection.files.length ||
					selection.skipped.length ||
					candidates.some((candidate) => candidate.rejections?.length)
				)
					throw new TrackedImportConflictError();
				return await submitTrackedImport(
					context,
					{
						userId: input.userId,
						instanceId: input.instanceId,
						service: input.service,
						origin: "manual",
						importMode: "auto",
						idempotencyKey,
						files: selection.files,
					},
					{
						sourcePermit: permit,
						preparationDeadline: deadline,
						requireEligibleCandidates: true,
						verifyCurrentTarget: async () => {
							const current = await readBeforeDeadline(
								() => readCurrentQueueItem(client, instance.service, input.queueId),
								deadline,
							);
							return Boolean(
								current &&
									queueItemFingerprint(current) === fingerprint &&
									queueDownloadKey(current) === downloadKey,
							);
						},
					},
				);
			} finally {
				// Actual provider settlement, not an HTTP timeout, releases ownership.
				permit();
			}
		});
	});
}
