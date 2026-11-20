import { createHash } from "node:crypto";
import type { ManualImportCandidate, ManualImportSubmission } from "@arr/shared";
import { LidarrClient, RadarrClient, ReadarrClient, SonarrClient } from "arr-sdk";
import {
	collectAutoManualImportFiles,
	fetchManualImportCandidatesWithSdk,
	ManualImportSubmissionUnknownError,
	submitManualImportCommandWithSdk,
} from "../../../routes/manual-import-utils.js";
import type { Encryptor } from "../../auth/encryption.js";
import type { PrismaClient, ServiceInstance } from "../../prisma.js";
import {
	importConnectionFingerprint,
	type QueueSourceActionPermit,
	queueDownloadKey,
} from "../../queue-cleaner/import-receipt.js";
import { collectStatusTexts, type RawQueueItem } from "../../queue-cleaner/queue-item-utils.js";
import {
	queueItemFingerprint,
	readCurrentQueueItem,
} from "../../queue-cleaner/queue-observation.js";
import { normalizeDownloadId } from "../../queue-cleaner/qui-gate.js";
import {
	importCommandFingerprint,
	type ManualImportCommandOutcome,
} from "../manual-import-command.js";
import { withImportActionGuards } from "./action-guards.js";
import {
	type AutomaticAttemptTracking,
	automaticImportPolicyFingerprint,
} from "./automatic-admission.js";
import { withImportConnectionReadGuard } from "./connection-guards.js";
import {
	type BeginImportAttemptResult,
	beginImportAttempt,
	cancelUnsubmittedImportAttempt,
	findImportSourceProtection,
	ImportAttemptConflictError,
	type ImportService,
	importIntentionFingerprint,
	markImportSubmissionStarted,
	type OwnedImportAttempt,
	readOwnedImportAttempt,
	recordImportCommandObservation,
	releaseTerminalImportSources,
} from "./repository.js";
import { buildVerifiedImportSelection, importRequestFingerprint } from "./selection.js";

export type TrackedImportInput = ManualImportSubmission & {
	userId: string;
	idempotencyKey: string;
	origin: "manual" | "queue-cleaner";
	/** Internal until the deliberate review route/UI is assembled. */
	remainderOf?: string;
};

export interface ImportSubmissionContext {
	prisma: PrismaClient;
	encryptor: Pick<Encryptor, "encrypt">;
	createClient: (
		instance: ServiceInstance,
		options: { timeout: number },
	) => SonarrClient | RadarrClient | LidarrClient | ReadarrClient;
}

/** Internal composition options; never parsed from an HTTP request. */
export interface ImportSubmissionOptions {
	sourcePermit?: QueueSourceActionPermit;
	preparationDeadline?: number;
	verifyCurrentTarget?: (operationId: string) => Promise<boolean>;
	automaticTracking?: AutomaticAttemptTracking;
	/** Source-only producers cannot express intentional rejected-file overrides. */
	requireEligibleCandidates?: boolean;
}

export class TrackedImportConflictError extends Error {
	readonly statusCode = 409;
	constructor() {
		super(
			"Import targets, connection, or attempt identity are unavailable or changed. Observe any existing attempt before starting new work.",
		);
		this.name = "TrackedImportConflictError";
	}
}

const PREPARATION_BUDGET_MS = 15_000;
const MAX_DOWNLOADS_PER_ATTEMPT = 32;

export class ImportPreparationLimitError extends Error {
	readonly statusCode = 413;
	constructor() {
		super(
			"Split the selection into smaller import batches of at most 1000 files from 32 download sources. No import was submitted.",
		);
		this.name = "ImportPreparationLimitError";
	}
}

async function beforeDeadline<T>(read: () => Promise<T>, deadline: number): Promise<T> {
	const remaining = deadline - Date.now();
	if (remaining <= 0) throw new TrackedImportConflictError();
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		// Only a read may detach. A late candidate result cannot resume submission.
		return await Promise.race([
			read(),
			new Promise<never>((_, reject) => {
				timer = setTimeout(() => reject(new TrackedImportConflictError()), remaining);
			}),
		]);
	} finally {
		if (timer !== undefined) clearTimeout(timer);
	}
}

function assertRequestBinding(
	operation: OwnedImportAttempt,
	input: TrackedImportInput,
	requestFingerprint: string,
	mode: string,
) {
	if (
		operation.originalInstanceId !== input.instanceId ||
		operation.service.toLowerCase() !== input.service ||
		operation.origin !== input.origin ||
		operation.mode !== mode ||
		operation.requestFingerprint !== requestFingerprint
	)
		throw new TrackedImportConflictError();
}

function correctClient(
	client: ReturnType<ImportSubmissionContext["createClient"]>,
	service: TrackedImportInput["service"],
): boolean {
	switch (service) {
		case "sonarr":
			return client instanceof SonarrClient;
		case "radarr":
			return client instanceof RadarrClient;
		case "lidarr":
			return client instanceof LidarrClient;
		case "readarr":
			return client instanceof ReadarrClient;
	}
}

/**
 * Prepare an exact current selection, persist the submission fence, and issue
 * one provider POST. Retry requests only observe the immutable owned attempt.
 * No command acknowledgement can establish positive per-file completion.
 */
export async function submitTrackedImport(
	context: ImportSubmissionContext,
	input: TrackedImportInput,
	options: ImportSubmissionOptions = {},
): Promise<OwnedImportAttempt> {
	if (
		!input.userId ||
		!input.idempotencyKey?.trim() ||
		input.idempotencyKey.length > 128 ||
		(input.origin !== "manual" && input.origin !== "queue-cleaner") ||
		(input.remainderOf !== undefined && input.origin !== "manual")
	)
		throw new TrackedImportConflictError();
	let requestFingerprint: string;
	try {
		requestFingerprint = importIntentionFingerprint(
			importRequestFingerprint(input.files),
			input.remainderOf,
		);
	} catch {
		throw new TrackedImportConflictError();
	}
	const mode = input.importMode === "copy" ? "Copy" : "Move";
	const existing = await context.prisma.arrImportOperation.findFirst({
		where: { userId: input.userId, idempotencyKey: input.idempotencyKey },
		include: { files: true },
	});
	if (existing) {
		assertRequestBinding(existing, input, requestFingerprint, mode);
		return existing;
	}
	return withImportConnectionReadGuard(input.userId, input.instanceId, async () => {
		const instance = await context.prisma.serviceInstance.findFirst({
			where: { id: input.instanceId, userId: input.userId, enabled: true },
		});
		if (!instance || instance.service.toLowerCase() !== input.service)
			throw new TrackedImportConflictError();
		const fingerprint = importConnectionFingerprint(instance);
		const downloadIds = [
			...new Set(
				input.files.map((file) => normalizeDownloadId(file.downloadId) ?? file.downloadId),
			),
		];
		if (downloadIds.length > MAX_DOWNLOADS_PER_ATTEMPT) {
			throw new ImportPreparationLimitError();
		}
		return withImportActionGuards(
			input.userId,
			downloadIds,
			async () => {
				const deadline = Math.min(
					Date.now() + PREPARATION_BUDGET_MS,
					options.preparationDeadline ?? Infinity,
				);
				if (!Number.isFinite(deadline) || deadline <= Date.now())
					throw new TrackedImportConflictError();
				const client = context.createClient(instance, { timeout: PREPARATION_BUDGET_MS });
				if (!correctClient(client, input.service)) throw new TrackedImportConflictError();
				const candidates: ManualImportCandidate[] = [];
				for (const downloadId of downloadIds) {
					const current = await beforeDeadline(
						() =>
							fetchManualImportCandidatesWithSdk(client, input.service, {
								downloadId,
								filterExistingFiles: false,
							}),
						deadline,
					);
					if (candidates.length + current.length > 10_000) throw new TrackedImportConflictError();
					candidates.push(...current);
				}
				const selection = buildVerifiedImportSelection(input.service, input.files, candidates);
				if (
					(input.origin === "queue-cleaner" || options.requireEligibleCandidates) &&
					candidates.some(
						(candidate) =>
							selection.files.some((file) => file.path === candidate.path) &&
							candidate.rejections?.length,
					)
				)
					throw new TrackedImportConflictError();
				const encrypted = context.encryptor.encrypt(
					JSON.stringify({ version: 1, service: input.service, files: selection.files }),
				);
				let prepared: BeginImportAttemptResult;
				try {
					const now = new Date();
					prepared = await beginImportAttempt(context.prisma, {
						userId: input.userId,
						instanceId: instance.id,
						connectionFingerprint: fingerprint,
						service: instance.service as ImportService,
						origin: input.origin,
						mode,
						idempotencyKey: input.idempotencyKey,
						requestFingerprint: selection.requestFingerprint,
						commandFingerprint: selection.commandFingerprint,
						encryptedSources: encrypted.value,
						sourcesEncryptionIv: encrypted.iv,
						files: selection.identities,
						now,
						preparationExpiresAt: new Date(deadline),
						automaticTracking: options.automaticTracking,
						remainderOf: input.remainderOf,
					});
				} catch (error) {
					if (error instanceof ImportAttemptConflictError) throw new TrackedImportConflictError();
					throw error;
				}
				if (prepared.kind === "protected") throw new TrackedImportConflictError();
				if (prepared.kind === "existing") return prepared.operation;
				const operationId = prepared.operation.id;
				let outcome: ManualImportCommandOutcome;
				try {
					outcome = await submitManualImportCommandWithSdk(
						client,
						input.service,
						selection.files,
						input.importMode,
						async (commandFiles) => {
							const verifyCurrentTarget = options.verifyCurrentTarget;
							if (
								verifyCurrentTarget &&
								!(await beforeDeadline(() => verifyCurrentTarget(operationId), deadline))
							)
								throw new TrackedImportConflictError();
							if (
								importCommandFingerprint(commandFiles) !== selection.commandFingerprint ||
								!(await markImportSubmissionStarted(
									context.prisma,
									input.userId,
									operationId,
									fingerprint,
									new Date(),
									options.automaticTracking,
									input.remainderOf
										? {
												operationId: input.remainderOf,
												selectionFingerprint: selection.requestFingerprint,
											}
										: undefined,
								))
							) {
								throw new TrackedImportConflictError();
							}
						},
					);
				} catch (error) {
					if (!(error instanceof ManualImportSubmissionUnknownError)) {
						if (await cancelUnsubmittedImportAttempt(context.prisma, input.userId, operationId)) {
							await releaseTerminalImportSources(context.prisma, input.userId, operationId);
						}
						throw error;
					}
					outcome = { state: "unknown" as const };
				}
				const submitted = await readOwnedImportAttempt(context.prisma, input.userId, operationId);
				if (!submitted) throw new TrackedImportConflictError();
				await recordImportCommandObservation(context.prisma, input.userId, operationId, {
					expectedRevision: submitted.revision,
					connectionFingerprint: fingerprint,
					commandFingerprint: selection.commandFingerprint,
					...("commandId" in outcome ? { commandId: outcome.commandId } : {}),
					state: outcome.state,
					terminal: outcome.state === "completed" || outcome.state === "failed",
					checkedAt: new Date(),
				});
				const observed = await readOwnedImportAttempt(context.prisma, input.userId, operationId);
				if (!observed) throw new TrackedImportConflictError();
				return observed;
			},
			options.sourcePermit,
		);
	});
}

export interface TrackedAutomaticImportInput {
	userId: string;
	instanceId: string;
	service: TrackedImportInput["service"];
	downloadId: string;
	queueId: number;
	queueFingerprint: string;
	connectionFingerprint: string;
	/** Current server-side cleaner attempt counter; a retry retains its ordinal. */
	attemptOrdinal: number;
}

/**
 * Internal cleaner adapter. Selection and queue authority are provider-derived;
 * the permit/gate are server capabilities, never browser-supplied input. Callers
 * must retain the same ordinal for observation and admit a new ordinal only
 * under the cleaner's current eligibility/cooldown policy.
 */
export async function submitTrackedAutomaticImport(
	context: ImportSubmissionContext,
	input: TrackedAutomaticImportInput,
	options: {
		sourcePermit: QueueSourceActionPermit;
		currentQueueGate: (item: RawQueueItem, preparedOperationId?: string) => Promise<boolean>;
	},
): Promise<OwnedImportAttempt> {
	const downloadKey = queueDownloadKey({ downloadId: input.downloadId });
	if (
		!input.userId ||
		!input.instanceId ||
		!downloadKey ||
		input.downloadId !== input.downloadId.trim() ||
		!Number.isSafeInteger(input.queueId) ||
		input.queueId <= 0 ||
		!Number.isSafeInteger(input.attemptOrdinal) ||
		input.attemptOrdinal <= 0 ||
		!/^v1:[a-f0-9]{64}$/.test(input.queueFingerprint) ||
		!/^[a-f0-9]{64}$/.test(input.connectionFingerprint)
	)
		throw new TrackedImportConflictError();
	const idempotencyKey = `auto-v1:${createHash("sha256")
		.update(
			JSON.stringify([
				input.userId,
				input.instanceId,
				input.service,
				input.connectionFingerprint,
				input.queueFingerprint,
				downloadKey,
				input.attemptOrdinal,
			]),
		)
		.digest("hex")}`;
	const existing = await context.prisma.arrImportOperation.findFirst({
		where: { userId: input.userId, idempotencyKey },
		include: { files: true },
	});
	if (existing) {
		if (
			existing.origin !== "queue-cleaner" ||
			existing.originalInstanceId !== input.instanceId ||
			existing.connectionFingerprint !== input.connectionFingerprint ||
			existing.service.toLowerCase() !== input.service ||
			existing.mode !== "Move"
		)
			throw new TrackedImportConflictError();
		return existing;
	}
	return withImportConnectionReadGuard(input.userId, input.instanceId, async () => {
		const instance = await context.prisma.serviceInstance.findFirst({
			where: { id: input.instanceId, userId: input.userId, enabled: true },
		});
		if (
			!instance ||
			instance.service.toLowerCase() !== input.service ||
			importConnectionFingerprint(instance) !== input.connectionFingerprint
		)
			throw new TrackedImportConflictError();
		const config = await context.prisma.queueCleanerConfig.findFirst({
			where: { instanceId: instance.id, instance: { userId: input.userId } },
		});
		if (!config?.enabled || config.dryRunMode || !config.autoImportEnabled)
			throw new TrackedImportConflictError();
		const deadline = Date.now() + PREPARATION_BUDGET_MS;
		const client = context.createClient(instance, { timeout: PREPARATION_BUDGET_MS });
		if (!correctClient(client, input.service)) throw new TrackedImportConflictError();
		const currentQueue = async (preparedOperationId?: string) => {
			try {
				const item = await beforeDeadline(
					() => readCurrentQueueItem(client, instance.service, input.queueId),
					deadline,
				);
				if (
					!item ||
					queueItemFingerprint(item) !== input.queueFingerprint ||
					queueDownloadKey(item) !== downloadKey ||
					!(await beforeDeadline(
						() => options.currentQueueGate(item, preparedOperationId),
						deadline,
					))
				)
					throw new TrackedImportConflictError();
				return item;
			} catch {
				throw new TrackedImportConflictError();
			}
		};
		const item = await currentQueue();
		const state =
			typeof item.trackedDownloadState === "string" ? item.trackedDownloadState.toLowerCase() : "";
		if (state !== "importpending" && state !== "importblocked")
			throw new TrackedImportConflictError();
		const automaticTracking: AutomaticAttemptTracking = {
			queueId: input.queueId,
			queueFingerprint: input.queueFingerprint,
			attemptOrdinal: input.attemptOrdinal,
			downloadId: input.downloadId,
			downloadTitle:
				typeof item.title === "string" && item.title.trim() ? item.title : "Queue item",
			rule: state === "importblocked" ? "import_blocked" : "import_pending",
			reason: "Eligible for auto-import",
			statusTexts: collectStatusTexts(item),
			configFingerprint: automaticImportPolicyFingerprint(config),
		};
		if (
			(await findImportSourceProtection(context.prisma, input.userId, [downloadKey])).some(
				(entry) => entry.automaticRetryInstanceId !== instance.id,
			)
		)
			throw new TrackedImportConflictError();
		const candidates = await beforeDeadline(
			() =>
				fetchManualImportCandidatesWithSdk(client, input.service, {
					downloadId: input.downloadId,
					filterExistingFiles: true,
				}),
			deadline,
		);
		if (!candidates.length || candidates.length > 10_000) throw new TrackedImportConflictError();
		const selection = collectAutoManualImportFiles(
			input.service,
			candidates,
			input.downloadId,
			item,
		);
		// Automatic policy cannot turn a partially rejected/mismapped selection
		// into an intentional manual subset. Retain the source for explicit review.
		if (!selection.files.length || selection.skipped.length) throw new TrackedImportConflictError();
		return submitTrackedImport(
			context,
			{
				userId: input.userId,
				instanceId: instance.id,
				service: input.service,
				origin: "queue-cleaner",
				importMode: "auto",
				idempotencyKey,
				files: selection.files,
			},
			{
				sourcePermit: options.sourcePermit,
				preparationDeadline: deadline,
				automaticTracking,
				verifyCurrentTarget: async (operationId) => {
					const current = await currentQueue(operationId);
					const currentState =
						typeof current.trackedDownloadState === "string"
							? current.trackedDownloadState.toLowerCase()
							: "";
					// The queue fingerprint establishes source/media identity, not
					// continued policy eligibility. Do not reuse older status evidence.
					if (
						currentState !== state ||
						JSON.stringify(collectStatusTexts(current).sort()) !==
							JSON.stringify([...automaticTracking.statusTexts].sort())
					)
						return false;
					const protection = await findImportSourceProtection(context.prisma, input.userId, [
						downloadKey,
					]);
					return protection.every(
						(entry) =>
							entry.automaticRetryInstanceId === instance.id ||
							(entry.kind !== "legacy" && entry.operationId === operationId),
					);
				},
			},
		);
	});
}
