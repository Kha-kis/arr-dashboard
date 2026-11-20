import { createHash } from "node:crypto";
import { manualImportServiceSchema, manualImportSubmissionFileSchema } from "@arr/shared";
import { z } from "zod";
import type { Encryptor } from "../../auth/encryption.js";
import { withIndependentCleanupOperationGuard } from "../../library-cleanup/cleanup-maintenance-gate.js";
import type { PrismaClient, ServiceInstance } from "../../prisma.js";
import {
	importConnectionFingerprint,
	queueDownloadKey,
} from "../../queue-cleaner/import-receipt.js";
import type { QueueCapableClient } from "../client-factory.js";
import { classifyImportCommand, importCommandFingerprint } from "../manual-import-command.js";
import { ImportSourceConflictError, withImportActionGuards } from "./action-guards.js";
import {
	ImportConnectionConflictError,
	withImportConnectionReadGuard,
} from "./connection-guards.js";
import {
	accumulatePositiveImportWitnesses,
	mergeCoveredImportWitnesses,
	verifiedImportWitnessFiles,
} from "./file-evidence.js";
import {
	acquireImportReconcileLease,
	type FinishImportReconcileLeaseInput,
	finishImportReconcileLease,
	type ImportReconcileCursor,
	parseImportReconcileCursor,
} from "./reconciliation-lease.js";
import {
	type OwnedImportAttempt,
	readOwnedImportAttempt,
	recordImportCommandObservation,
	recordVerifiedImportFiles,
	releaseTerminalImportSources,
} from "./repository.js";

export interface ImportReconciliationContext {
	prisma: PrismaClient;
	encryptor: Pick<Encryptor, "decrypt">;
	createClient: (instance: ServiceInstance, options: { timeout: number }) => QueueCapableClient;
	now?: () => Date;
}
export type ImportReconciliationResult =
	| "not-due"
	| "observed"
	| "yielded"
	| "unavailable"
	| "superseded";

const lookupSchema = z
	.object({
		version: z.literal(1),
		service: manualImportServiceSchema,
		files: z.array(manualImportSubmissionFileSchema.strict()).min(1).max(1000),
	})
	.strict();
const SLICE_MS = 15_000;
const MAX_REQUESTS = 4;
const PAGE_SIZE = 100;
class SliceBudgetError extends Error {}
class SupersededEvidenceError extends Error {}
class UnavailableEvidenceError extends Error {}
class IncompleteHistoryError extends Error {}

function object(value: unknown): Record<string, unknown> | null {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

function boundFiles(context: ImportReconciliationContext, operation: OwnedImportAttempt) {
	const cleartext = context.encryptor.decrypt({
		value: operation.encryptedSources,
		iv: operation.sourcesEncryptionIv,
	});
	if (cleartext.length > 4 * 1024 * 1024) throw new UnavailableEvidenceError();
	const parsed = lookupSchema.safeParse(JSON.parse(cleartext));
	if (
		!parsed.success ||
		parsed.data.service !== operation.service.toLowerCase() ||
		parsed.data.files.length !== operation.selectedFileCount ||
		operation.files.length !== operation.selectedFileCount ||
		importCommandFingerprint(parsed.data.files) !== operation.commandFingerprint
	)
		throw new UnavailableEvidenceError();
	const proofs = new Map(operation.files.map((file) => [file.fileFingerprint, file]));
	const seen = new Set<string>();
	for (const file of parsed.data.files) {
		const fingerprint = importCommandFingerprint([file]);
		const proof = fingerprint ? proofs.get(fingerprint) : null;
		const identity = object(proof?.identityJson);
		if (
			!fingerprint ||
			seen.has(fingerprint) ||
			!proof ||
			!identity ||
			queueDownloadKey(file) !== proof.downloadKey ||
			identity.pathHash !== createHash("sha256").update(file.path).digest("hex")
		)
			throw new UnavailableEvidenceError();
		const coordinates = file as Record<string, unknown>;
		for (const [key, value] of Object.entries(identity)) {
			if (key === "pathHash") continue;
			const actual = coordinates[key];
			if (Array.isArray(value) && Array.isArray(actual)) {
				if (JSON.stringify([...value].sort()) !== JSON.stringify([...actual].sort()))
					throw new UnavailableEvidenceError();
			} else if (value !== actual) throw new UnavailableEvidenceError();
		}
		seen.add(fingerprint);
	}
	return parsed.data;
}

function exactCommand(
	raw: unknown,
	operation: OwnedImportAttempt,
	now: Date,
	expectedId?: number,
): Record<string, unknown> | null {
	const command = object(raw);
	const body = object(command?.body);
	if (
		!command ||
		!body ||
		!Number.isSafeInteger(command.id) ||
		Number(command.id) <= 0 ||
		(expectedId !== undefined && command.id !== expectedId) ||
		(command.name ?? command.commandName ?? body.name) !== "ManualImport" ||
		body.importMode !== operation.mode ||
		importCommandFingerprint(body.files) !== operation.commandFingerprint
	)
		return null;
	if (
		expectedId === undefined &&
		(typeof command.queued !== "string" ||
			!Number.isFinite(Date.parse(command.queued)) ||
			Date.parse(command.queued) < operation.submissionStartedAt!.getTime() ||
			Date.parse(command.queued) > now.getTime())
	)
		return null;
	return command;
}

function emptyCursor(
	operation: OwnedImportAttempt,
	commandId: number,
	endedAt: string,
	sourceIndex = 0,
	previous?: ImportReconcileCursor,
): Extract<ImportReconcileCursor, { version: 2 }> {
	return {
		version: 2,
		commandFingerprint: operation.commandFingerprint,
		commandId,
		commandEndedAt: endedAt,
		sourceIndex,
		page: 1,
		pageSize: null,
		totalRecords: null,
		seenRecords: 0,
		witnesses: [],
		ambiguousFiles: [],
		retainedWitnesses: previous?.version === 2 ? previous.retainedWitnesses : [],
		retainedAmbiguousFiles: previous?.version === 2 ? previous.retainedAmbiguousFiles : [],
	};
}

function historyPage(raw: unknown, cursor: ImportReconcileCursor, requestedSize: number) {
	const page = object(raw);
	if (
		!page ||
		!Array.isArray(page.records) ||
		page.page !== cursor.page ||
		!Number.isSafeInteger(page.pageSize) ||
		Number(page.pageSize) < 1 ||
		Number(page.pageSize) > requestedSize ||
		!Number.isSafeInteger(page.totalRecords) ||
		Number(page.totalRecords) < 0
	)
		throw new IncompleteHistoryError();
	const pageSize = Number(page.pageSize);
	const total = Number(page.totalRecords);
	const offset = (cursor.page - 1) * pageSize;
	if (
		!Number.isSafeInteger(offset) ||
		offset !== cursor.seenRecords ||
		(cursor.pageSize !== null && pageSize !== cursor.pageSize) ||
		(cursor.totalRecords !== null && total !== cursor.totalRecords) ||
		page.records.length !== Math.min(pageSize, Math.max(0, total - offset)) ||
		(page.records.length === 0 && total > offset)
	)
		throw new IncompleteHistoryError();
	return { records: page.records as unknown[], pageSize, total };
}

/** Read-only, bounded observation. This function never submits/replays an import command. */
export async function reconcileTrackedImport(
	context: ImportReconciliationContext,
	userId: string,
	operationId: string,
): Promise<ImportReconciliationResult> {
	const cached = await readOwnedImportAttempt(context.prisma, userId, operationId);
	if (!cached) return "not-due";
	if (cached.state === "completed" || cached.state === "not-submitted") return "observed";
	const now = context.now ?? (() => new Date());
	try {
		return await withImportConnectionReadGuard(userId, cached.originalInstanceId, () =>
			withIndependentCleanupOperationGuard(async () => {
				const lease = await acquireImportReconcileLease(context.prisma, userId, operationId, now());
				if (!lease) return "not-due";
				let operation = lease.operation;
				let cursor = parseImportReconcileCursor(operation, operation.reconcileCursor, now());
				const deadline = Date.now() + SLICE_MS;
				let requestCount = 0;
				const refresh = async () => {
					const fresh = await readOwnedImportAttempt(context.prisma, userId, operationId);
					if (
						!fresh ||
						fresh.reconcileToken !== lease.token ||
						fresh.reconcileExpiresAt === null ||
						fresh.reconcileExpiresAt.getTime() <= Math.max(Date.now(), now().getTime())
					)
						throw new SupersededEvidenceError();
					operation = fresh;
				};
				const finish = async (
					result: ImportReconciliationResult,
					reason: FinishImportReconcileLeaseInput["reason"],
				) => {
					await refresh();
					const checkedAt = now();
					const finished = await finishImportReconcileLease(
						context.prisma,
						userId,
						operationId,
						lease.token,
						operation.revision,
						checkedAt,
						{
							cursor,
							reason,
							nextCheckAt: new Date(checkedAt.getTime() + (result === "yielded" ? 1000 : 30_000)),
						},
					);
					return finished ? result : ("superseded" as const);
				};
				const read = async (
					client: QueueCapableClient,
					path: string,
					options?: Record<string, unknown>,
				): Promise<unknown> => {
					const remaining = deadline - Date.now();
					if (requestCount >= MAX_REQUESTS || remaining <= 0) throw new SliceBudgetError();
					requestCount += 1;
					let timer: ReturnType<typeof setTimeout> | undefined;
					try {
						// Only a provider GET may detach; late results cannot resume this pass.
						return await Promise.race([
							client.get<unknown>(path, options),
							new Promise<never>((_, reject) => {
								timer = setTimeout(() => reject(new SliceBudgetError()), remaining);
							}),
						]);
					} finally {
						if (timer !== undefined) clearTimeout(timer);
					}
				};
				try {
					if (operation.reconcileCursor !== null && cursor === null)
						throw new UnavailableEvidenceError();
					if (cursor?.version === 1)
						cursor = {
							...cursor,
							version: 2,
							retainedWitnesses: [],
							retainedAmbiguousFiles: [],
						};
					const instance = await context.prisma.serviceInstance.findFirst({
						where: {
							id: operation.originalInstanceId,
							userId,
							service: operation.service,
							enabled: true,
						},
					});
					if (
						!instance ||
						instance.id !== operation.instanceId ||
						importConnectionFingerprint(instance) !== operation.connectionFingerprint
					) {
						return await finish("unavailable", "connection-changed");
					}
					const lookup = boundFiles(context, operation);
					const downloads = new Map<string, string>();
					for (const file of lookup.files) downloads.set(queueDownloadKey(file)!, file.downloadId);
					const sources = [...downloads].sort(([a], [b]) => a.localeCompare(b));
					if (sources.length > 32) throw new UnavailableEvidenceError();
					return await withImportActionGuards(userId, [...downloads.values()], async () => {
						const client = context.createClient(instance, { timeout: SLICE_MS });
						const version =
							lookup.service === "lidarr" || lookup.service === "readarr" ? "v1" : "v3";
						const terminal =
							operation.commandTerminal &&
							(operation.commandState === "completed" || operation.commandState === "failed");
						if (!terminal || cursor === null) {
							let commandId = operation.commandId;
							if (commandId === null) {
								const commands = await read(client, `/api/${version}/command`);
								if (!Array.isArray(commands) || commands.length > 1000)
									throw new UnavailableEvidenceError();
								const matches = commands.filter(
									(command) => exactCommand(command, operation, now()) !== null,
								);
								if (matches.length !== 1) throw new UnavailableEvidenceError();
								commandId = Number(object(matches[0])!.id);
							}
							const rawCommand = await read(client, `/api/${version}/command/${commandId}`);
							const command = exactCommand(rawCommand, operation, now(), commandId);
							if (!command) throw new UnavailableEvidenceError();
							const outcome = classifyImportCommand(
								command,
								operation.commandFingerprint,
								commandId,
							);
							if (outcome.state === "unknown") throw new UnavailableEvidenceError();
							const recorded = await recordImportCommandObservation(
								context.prisma,
								userId,
								operationId,
								{
									reconcileToken: lease.token,
									expectedRevision: operation.revision,
									connectionFingerprint: operation.connectionFingerprint,
									commandFingerprint: operation.commandFingerprint,
									commandId,
									state: outcome.state,
									terminal: outcome.state === "completed" || outcome.state === "failed",
									checkedAt: now(),
								},
							);
							if (!recorded) throw new SupersededEvidenceError();
							await refresh();
							if (outcome.state === "pending") {
								cursor = null;
								return await finish("observed", null);
							}
							// Terminal command identity is durable; release is NOT cleanup permission.
							await releaseTerminalImportSources(context.prisma, userId, operationId);
							const ended = typeof command.ended === "string" ? new Date(command.ended) : null;
							if (
								!ended ||
								!Number.isFinite(ended.getTime()) ||
								ended < operation.submissionStartedAt! ||
								ended > now()
							)
								throw new UnavailableEvidenceError();
							cursor = emptyCursor(
								operation,
								commandId,
								ended.toISOString(),
								0,
								cursor ?? undefined,
							);
						}
						if (!cursor || !operation.commandId) throw new UnavailableEvidenceError();
						if (cursor.sourceIndex === sources.length)
							cursor = emptyCursor(
								operation,
								operation.commandId,
								cursor.commandEndedAt,
								0,
								cursor,
							);
						while (cursor.sourceIndex < sources.length) {
							const source = sources[cursor.sourceIndex]!;
							const files = lookup.files.filter((file) => queueDownloadKey(file) === source[0]);
							const proved = new Set(
								operation.files
									.filter((file) => file.verifiedAt !== null)
									.map((file) => file.fileFingerprint),
							);
							if (files.every((file) => proved.has(importCommandFingerprint([file])!))) {
								cursor = emptyCursor(
									operation,
									operation.commandId,
									cursor.commandEndedAt,
									cursor.sourceIndex + 1,
									cursor,
								);
								continue;
							}
							const requestedSize = cursor.pageSize ?? PAGE_SIZE;
							const rawPage = await read(client, `/api/${version}/history`, {
								downloadId: source[1],
								page: cursor.page,
								pageSize: requestedSize,
								sortKey: "date",
								sortDirection: "ascending",
							});
							const page = historyPage(rawPage, cursor, requestedSize);
							const progress = accumulatePositiveImportWitnesses(
								lookup.service,
								files as Array<Record<string, unknown>>,
								page.records,
								operation.submissionStartedAt!,
								new Date(cursor.commandEndedAt),
								cursor,
							);
							cursor = {
								...cursor,
								...progress,
								pageSize: page.pageSize,
								totalRecords: page.total,
								seenRecords: cursor.seenRecords + page.records.length,
							};
							if (cursor.seenRecords === page.total) {
								if (cursor.version !== 2) throw new UnavailableEvidenceError();
								const retained = mergeCoveredImportWitnesses(
									lookup.service,
									lookup.files as Array<Record<string, unknown>>,
									operation.submissionStartedAt!,
									new Date(cursor.commandEndedAt),
									{
										witnesses: cursor.retainedWitnesses,
										ambiguousFiles: cursor.retainedAmbiguousFiles,
									},
									progress,
								);
								cursor = {
									...cursor,
									retainedWitnesses: retained.witnesses,
									retainedAmbiguousFiles: retained.ambiguousFiles,
								};
								const verified = verifiedImportWitnessFiles(
									lookup.service,
									files as Array<Record<string, unknown>>,
									retained,
								).filter((fp) => !proved.has(fp));
								if (verified.length > 0) {
									const recorded = await recordVerifiedImportFiles(
										context.prisma,
										userId,
										operationId,
										{
											reconcileToken: lease.token,
											expectedRevision: operation.revision,
											connectionFingerprint: operation.connectionFingerprint,
											commandFingerprint: operation.commandFingerprint,
											commandId: operation.commandId,
											fileFingerprints: verified,
											verifiedAt: now(),
										},
									);
									if (!recorded) throw new SupersededEvidenceError();
									await refresh();
								}
								cursor = emptyCursor(
									operation,
									operation.commandId!,
									cursor.commandEndedAt,
									cursor.sourceIndex + 1,
									cursor,
								);
							} else {
								if (cursor.page >= 1_000_000) throw new IncompleteHistoryError();
								cursor = { ...cursor, page: cursor.page + 1 };
							}
						}
						return await finish(
							"observed",
							operation.verifiedFileCount === operation.selectedFileCount
								? null
								: "evidence-unavailable",
						);
					});
				} catch (error) {
					if (error instanceof SupersededEvidenceError) return "superseded";
					if (error instanceof SliceBudgetError) return await finish("yielded", "budget-yield");
					if (error instanceof IncompleteHistoryError && cursor) {
						cursor = emptyCursor(
							operation,
							cursor.commandId,
							cursor.commandEndedAt,
							cursor.sourceIndex,
							cursor,
						);
						return await finish("unavailable", "coverage-incomplete");
					}
					if (error instanceof ImportSourceConflictError) return await finish("not-due", null);
					return await finish("unavailable", "evidence-unavailable");
				}
			}),
		);
	} catch (error) {
		if (error instanceof ImportConnectionConflictError) return "not-due";
		if (error instanceof SupersededEvidenceError) return "superseded";
		throw error;
	}
}
