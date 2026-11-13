import { createHash } from "node:crypto";
import { manualImportForeignEditionIdSchema } from "@arr/shared";
import type { Prisma, PrismaClient, QueueCleanerImportReceipt } from "../../prisma.js";
import { importConnectionFingerprint } from "../../queue-cleaner/import-receipt.js";
import {
	type AutomaticAttemptTracking,
	assertPreparedAutomaticTracking,
	recordAutomaticPreparation,
} from "./automatic-admission.js";
import { parseImportReconcileCursor } from "./reconciliation-lease.js";

export type ImportService = "SONARR" | "RADARR" | "LIDARR" | "READARR";

export type ImportFileIdentity = { pathHash: string } & (
	| { seriesId: number; episodeIds: number[]; episodeFileId?: number }
	| { movieId: number; movieFileId?: number }
	| {
			artistId: number;
			albumId: number;
			trackIds?: number[];
			trackFileId?: number;
			albumReleaseId?: number;
	  }
	| { authorId: number; bookId: number; bookFileId?: number; foreignEditionId?: string }
);

export interface ImportAttemptFile {
	fileFingerprint: string;
	downloadKey: string;
	identity: ImportFileIdentity;
}

export interface BeginImportAttemptInput {
	userId: string;
	instanceId: string;
	connectionFingerprint: string;
	service: ImportService;
	origin: "manual" | "queue-cleaner";
	mode: "Move" | "Copy";
	idempotencyKey: string;
	requestFingerprint: string;
	commandFingerprint: string;
	encryptedSources: string;
	sourcesEncryptionIv: string;
	files: ImportAttemptFile[];
	now: Date;
	preparationExpiresAt: Date;
	automaticTracking?: AutomaticAttemptTracking;
	/** Explicit new manual intention; never an automatic retry or cleanup permit. */
	remainderOf?: string;
}

export type OwnedImportAttempt = Prisma.ArrImportOperationGetPayload<{
	include: { files: true };
}>;

export type BeginImportAttemptResult =
	| { kind: "created" | "existing"; operation: OwnedImportAttempt }
	| { kind: "protected"; downloadKeys: string[] };

export interface ImportCommandObservation {
	reconcileToken?: string;
	expectedRevision: number;
	connectionFingerprint: string;
	commandFingerprint: string;
	commandId?: number;
	state: "pending" | "completed" | "failed" | "unknown";
	terminal: boolean;
	checkedAt: Date;
}

export interface VerifiedImportFilesInput {
	reconcileToken?: string;
	expectedRevision: number;
	connectionFingerprint: string;
	commandFingerprint: string;
	commandId: number;
	fileFingerprints: string[];
	verifiedAt: Date;
}

export interface ImportSourceProtection {
	downloadKey: string;
	kind: "legacy" | "operation" | "claim";
	operationId?: string;
	state: string;
	commandTerminal: boolean;
	/** Preparation hint only: never cleanup permission or a submission bypass. */
	automaticRetryInstanceId?: string;
}

export class ImportAttemptConflictError extends Error {
	readonly reason: "invalid-attempt" | "connection-changed" | "idempotency-conflict";

	constructor(reason: ImportAttemptConflictError["reason"]) {
		super(`Import attempt conflict (${reason}).`);
		this.name = "ImportAttemptConflictError";
		this.reason = reason;
	}
}

const FILE_FINGERPRINT_PATTERN = /^v1:[a-f0-9]{64}$/;
const HASH_PATTERN = /^[a-f0-9]{64}$/;
const IMPORT_SERVICES = new Set<ImportService>(["SONARR", "RADARR", "LIDARR", "READARR"]);
const KNOWN_OPERATION_STATES = new Set([
	"preparing",
	"submitting",
	"pending",
	"unknown",
	"partial",
	"completed",
	"failed",
	"not-submitted",
]);
const RETRYABLE_DATABASE_CODES = new Set([
	"P1008",
	"P2002",
	"P2028",
	"P2034",
	"SQLITE_BUSY",
	"SQLITE_LOCKED",
]);
const MAX_BEGIN_ATTEMPTS = 3;

type TransactionClient = Prisma.TransactionClient;
type NormalizedFile = {
	fileFingerprint: string;
	downloadKey: string;
	identity: ImportFileIdentity;
	identityJson: Prisma.InputJsonObject;
};
type ValidatedAttempt = Omit<BeginImportAttemptInput, "files"> & { files: NormalizedFile[] };

class ImportSourceClaimRaceError extends Error {
	constructor() {
		super("Import source claim changed during acquisition.");
		this.name = "ImportSourceClaimRaceError";
	}
}

class StaleImportEvidenceRaceError extends Error {
	constructor() {
		super("Import evidence revision changed during persistence.");
		this.name = "StaleImportEvidenceRaceError";
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

function isFiniteDate(value: unknown): value is Date {
	return value instanceof Date && Number.isFinite(value.getTime());
}

function isPositiveInteger(value: unknown): value is number {
	return Number.isSafeInteger(value) && (value as number) > 0;
}

function isOptionalIdentifier(value: unknown): value is number {
	return Number.isSafeInteger(value) && (value as number) >= 0;
}

function validText(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0;
}

function normalizeIdList(value: unknown, required: boolean): number[] | null {
	if (!Array.isArray(value) || (required && value.length === 0)) return null;
	if (value.some((entry) => !isPositiveInteger(entry)) || new Set(value).size !== value.length)
		return null;
	return [...value].sort((left, right) => left - right);
}

export function normalizeIdentity(
	service: ImportService,
	identity: unknown,
): ImportFileIdentity | null {
	if (
		!isRecord(identity) ||
		typeof identity.pathHash !== "string" ||
		!HASH_PATTERN.test(identity.pathHash)
	) {
		return null;
	}
	const keys = Object.keys(identity).sort();
	const exactKeys = (allowed: string[]) =>
		keys.every((key) => allowed.includes(key)) &&
		allowed
			.filter(
				(key) =>
					key !== "episodeFileId" &&
					key !== "movieFileId" &&
					key !== "trackIds" &&
					key !== "trackFileId" &&
					key !== "albumReleaseId" &&
					key !== "bookFileId" &&
					key !== "foreignEditionId",
			)
			.every((key) => keys.includes(key));

	switch (service) {
		case "SONARR": {
			if (!exactKeys(["pathHash", "seriesId", "episodeIds", "episodeFileId"])) return null;
			const episodeIds = normalizeIdList(identity.episodeIds, true);
			const episodeFileId = identity.episodeFileId;
			if (!isPositiveInteger(identity.seriesId) || !episodeIds) return null;
			if (episodeFileId !== undefined && !isOptionalIdentifier(episodeFileId)) return null;
			return {
				pathHash: identity.pathHash,
				seriesId: identity.seriesId,
				episodeIds,
				...(episodeFileId === undefined ? {} : { episodeFileId }),
			};
		}
		case "RADARR": {
			if (
				!exactKeys(["pathHash", "movieId", "movieFileId"]) ||
				!isPositiveInteger(identity.movieId)
			)
				return null;
			const movieFileId = identity.movieFileId;
			if (movieFileId !== undefined && !isOptionalIdentifier(movieFileId)) return null;
			return {
				pathHash: identity.pathHash,
				movieId: identity.movieId,
				...(movieFileId === undefined ? {} : { movieFileId }),
			};
		}
		case "LIDARR": {
			if (
				!exactKeys(["pathHash", "artistId", "albumId", "trackIds", "trackFileId", "albumReleaseId"])
			)
				return null;
			if (!isPositiveInteger(identity.artistId) || !isPositiveInteger(identity.albumId))
				return null;
			const normalizedTrackIds =
				identity.trackIds === undefined ? undefined : normalizeIdList(identity.trackIds, true);
			if (identity.trackIds !== undefined && !normalizedTrackIds) return null;
			const trackIds = normalizedTrackIds ?? undefined;
			const trackFileId = identity.trackFileId;
			if (trackFileId !== undefined && !isOptionalIdentifier(trackFileId)) return null;
			const albumReleaseId = identity.albumReleaseId;
			if (albumReleaseId !== undefined && !isOptionalIdentifier(albumReleaseId)) return null;
			return {
				pathHash: identity.pathHash,
				artistId: identity.artistId,
				albumId: identity.albumId,
				...(trackIds === undefined ? {} : { trackIds }),
				...(trackFileId === undefined ? {} : { trackFileId }),
				...(albumReleaseId === undefined ? {} : { albumReleaseId }),
			};
		}
		case "READARR": {
			if (!exactKeys(["pathHash", "authorId", "bookId", "bookFileId", "foreignEditionId"]))
				return null;
			if (!isPositiveInteger(identity.authorId) || !isPositiveInteger(identity.bookId)) return null;
			const bookFileId = identity.bookFileId;
			if (bookFileId !== undefined && !isOptionalIdentifier(bookFileId)) return null;
			const foreignEditionId = identity.foreignEditionId;
			if (
				foreignEditionId !== undefined &&
				!manualImportForeignEditionIdSchema.safeParse(foreignEditionId).success
			)
				return null;
			return {
				pathHash: identity.pathHash,
				authorId: identity.authorId,
				bookId: identity.bookId,
				...(bookFileId === undefined ? {} : { bookFileId }),
				...(foreignEditionId === undefined ? {} : { foreignEditionId: foreignEditionId as string }),
			};
		}
	}
}

function validateAttempt(input: BeginImportAttemptInput): ValidatedAttempt {
	if (!isRecord(input)) throw new ImportAttemptConflictError("invalid-attempt");
	const allowedInputKeys = [
		"userId",
		"instanceId",
		"connectionFingerprint",
		"service",
		"origin",
		"mode",
		"idempotencyKey",
		"requestFingerprint",
		"commandFingerprint",
		"encryptedSources",
		"sourcesEncryptionIv",
		"files",
		"now",
		"preparationExpiresAt",
		"automaticTracking",
		"remainderOf",
	];
	if (Object.keys(input).some((key) => !allowedInputKeys.includes(key))) {
		throw new ImportAttemptConflictError("invalid-attempt");
	}
	if (
		!validText(input.userId) ||
		!validText(input.instanceId) ||
		!HASH_PATTERN.test(input.connectionFingerprint) ||
		!IMPORT_SERVICES.has(input.service) ||
		!(input.origin === "manual" || input.origin === "queue-cleaner") ||
		(input.automaticTracking !== undefined && input.origin !== "queue-cleaner") ||
		(input.remainderOf !== undefined &&
			(input.origin !== "manual" || !validRemainderReference(input.remainderOf))) ||
		!(input.mode === "Move" || input.mode === "Copy") ||
		!validText(input.idempotencyKey) ||
		!FILE_FINGERPRINT_PATTERN.test(input.requestFingerprint) ||
		!FILE_FINGERPRINT_PATTERN.test(input.commandFingerprint) ||
		!validText(input.encryptedSources) ||
		!validText(input.sourcesEncryptionIv) ||
		!Array.isArray(input.files) ||
		input.files.length < 1 ||
		input.files.length > 1000 ||
		!isFiniteDate(input.now) ||
		!isFiniteDate(input.preparationExpiresAt) ||
		input.preparationExpiresAt.getTime() <= input.now.getTime()
	) {
		throw new ImportAttemptConflictError("invalid-attempt");
	}
	const files: NormalizedFile[] = [];
	const seenFingerprints = new Set<string>();
	for (const rawFile of input.files) {
		if (
			!isRecord(rawFile) ||
			Object.keys(rawFile).some(
				(key) => !["fileFingerprint", "downloadKey", "identity"].includes(key),
			) ||
			!FILE_FINGERPRINT_PATTERN.test(rawFile.fileFingerprint) ||
			seenFingerprints.has(rawFile.fileFingerprint) ||
			typeof rawFile.downloadKey !== "string" ||
			!HASH_PATTERN.test(rawFile.downloadKey)
		) {
			throw new ImportAttemptConflictError("invalid-attempt");
		}
		const identity = normalizeIdentity(input.service, rawFile.identity);
		if (!identity) throw new ImportAttemptConflictError("invalid-attempt");
		seenFingerprints.add(rawFile.fileFingerprint);
		files.push({
			fileFingerprint: rawFile.fileFingerprint,
			downloadKey: rawFile.downloadKey,
			identity,
			identityJson: identity as unknown as Prisma.InputJsonObject,
		});
	}
	files.sort((left, right) => left.fileFingerprint.localeCompare(right.fileFingerprint));
	return {
		...input,
		requestFingerprint: importIntentionFingerprint(input.requestFingerprint, input.remainderOf),
		files,
	};
}

function validRemainderReference(value: unknown): value is string {
	return (
		typeof value === "string" && value.length > 0 && value.length <= 128 && value === value.trim()
	);
}

/** Bind the deliberate predecessor without changing existing first-attempt keys. */
export function importIntentionFingerprint(
	selectionFingerprint: string,
	remainderOf?: string,
): string {
	if (
		!FILE_FINGERPRINT_PATTERN.test(selectionFingerprint) ||
		(remainderOf !== undefined && !validRemainderReference(remainderOf))
	)
		throw new ImportAttemptConflictError("invalid-attempt");
	return remainderOf === undefined
		? selectionFingerprint
		: `v1:${createHash("sha256")
				.update(JSON.stringify(["manual-remainder-v1", remainderOf, selectionFingerprint]))
				.digest("hex")}`;
}

function descriptorForInput(file: NormalizedFile): string {
	return JSON.stringify([file.fileFingerprint, file.downloadKey, file.identity]);
}

function descriptorsMatch(operation: OwnedImportAttempt, input: ValidatedAttempt): boolean {
	const actual = operation.files
		.map((file) => JSON.stringify([file.fileFingerprint, file.downloadKey, file.identityJson]))
		.sort();
	const expected = input.files.map(descriptorForInput).sort();
	return (
		actual.length === expected.length && actual.every((value, index) => value === expected[index])
	);
}

function immutableAttemptMatches(operation: OwnedImportAttempt, input: ValidatedAttempt): boolean {
	return (
		operation.originalInstanceId === input.instanceId &&
		operation.connectionFingerprint === input.connectionFingerprint &&
		operation.service === input.service &&
		operation.origin === input.origin &&
		operation.mode === input.mode &&
		operation.requestFingerprint === input.requestFingerprint &&
		operation.commandFingerprint === input.commandFingerprint &&
		operation.selectedFileCount === input.files.length &&
		descriptorsMatch(operation, input)
	);
}

function retryableDatabaseError(error: unknown): boolean {
	const seen = new Set<object>();
	let current: unknown = error;
	while (current && typeof current === "object" && !seen.has(current)) {
		seen.add(current);
		const record = current as { code?: unknown; cause?: unknown; originalCode?: unknown };
		if (typeof record.code === "string" && RETRYABLE_DATABASE_CODES.has(record.code)) {
			return true;
		}
		if (
			typeof record.originalCode === "string" &&
			RETRYABLE_DATABASE_CODES.has(record.originalCode)
		) {
			return true;
		}
		current = record.cause;
	}
	return error instanceof ImportSourceClaimRaceError;
}

function sourceKeys(
	files: readonly NormalizedFile[] | readonly { downloadKey: string }[],
): string[] {
	return [...new Set(files.map((file) => file.downloadKey))].sort();
}

function safeOperationProtectionState(operation: {
	state: string;
	submissionStartedAt: Date | null;
	commandTerminal: boolean;
}): { state: string; commandTerminal: boolean } {
	if (
		!KNOWN_OPERATION_STATES.has(operation.state) ||
		(operation.state === "not-submitted" && operation.submissionStartedAt !== null)
	) {
		return { state: "unknown", commandTerminal: false };
	}
	return { state: operation.state, commandTerminal: operation.commandTerminal };
}

async function currentImportConnection(
	transaction: TransactionClient,
	userId: string,
	instanceId: string,
	service: ImportService,
	connectionFingerprint: string,
) {
	const instance = await transaction.serviceInstance.findFirst({
		where: { id: instanceId, userId, service, enabled: true },
	});
	return instance && importConnectionFingerprint(instance) === connectionFingerprint
		? instance
		: null;
}

async function ownedOperation(
	transaction: TransactionClient,
	userId: string,
	operationId: string,
): Promise<OwnedImportAttempt | null> {
	return transaction.arrImportOperation.findFirst({
		where: { id: operationId, userId },
		include: { files: { orderBy: { fileFingerprint: "asc" } } },
	});
}

async function protectedDownloadKeys(
	transaction: TransactionClient,
	userId: string,
	keys: string[],
): Promise<string[]> {
	if (keys.length === 0) return [];
	const [legacy, activeClaims] = await Promise.all([
		transaction.queueCleanerImportReceipt.findMany({
			where: { downloadKey: { in: keys }, instance: { userId } },
			select: { downloadKey: true },
		}),
		transaction.arrImportSourceClaim.findMany({
			where: { userId, downloadKey: { in: keys }, activeOperationId: { not: null } },
			select: { downloadKey: true },
		}),
	]);
	return [...new Set([...legacy, ...activeClaims].map((record) => record.downloadKey))].sort();
}

type AdmissionBinding = Pick<
	ValidatedAttempt,
	| "userId"
	| "instanceId"
	| "connectionFingerprint"
	| "service"
	| "origin"
	| "mode"
	| "files"
	| "now"
	| "preparationExpiresAt"
	| "remainderOf"
>;

export function terminalHistory(operation: OwnedImportAttempt, now: Date): boolean {
	return (
		["unknown", "partial", "failed", "completed"].includes(operation.state) &&
		operation.commandTerminal &&
		isPositiveInteger(operation.commandId) &&
		(operation.commandState === "completed" || operation.commandState === "failed") &&
		operation.state ===
			aggregateOperationState(
				operation.commandState,
				true,
				operation.verifiedFileCount,
				operation.selectedFileCount,
			) &&
		isFiniteDate(operation.submissionStartedAt) &&
		operation.submissionStartedAt <= now &&
		isFiniteDate(operation.lastCheckedAt) &&
		operation.lastCheckedAt >= operation.submissionStartedAt &&
		operation.lastCheckedAt <= now &&
		operation.reconcileToken === null &&
		operation.reconcileExpiresAt === null
	);
}

export function historyFilesValid(operation: OwnedImportAttempt): boolean {
	return (
		IMPORT_SERVICES.has(operation.service as ImportService) &&
		(operation.origin === "manual" || operation.origin === "queue-cleaner") &&
		(operation.mode === "Move" || operation.mode === "Copy") &&
		HASH_PATTERN.test(operation.connectionFingerprint) &&
		FILE_FINGERPRINT_PATTERN.test(operation.requestFingerprint) &&
		FILE_FINGERPRINT_PATTERN.test(operation.commandFingerprint) &&
		operation.files.length > 0 &&
		operation.files.length <= 1000 &&
		operation.selectedFileCount === operation.files.length &&
		operation.verifiedFileCount ===
			operation.files.filter((file) => file.verifiedAt !== null).length &&
		new Set(operation.files.map((file) => file.fileFingerprint)).size === operation.files.length &&
		operation.files.every(
			(file) =>
				FILE_FINGERPRINT_PATTERN.test(file.fileFingerprint) &&
				HASH_PATTERN.test(file.downloadKey) &&
				normalizeIdentity(operation.service as ImportService, file.identityJson) !== null &&
				(file.verifiedAt === null || isFiniteDate(file.verifiedAt)),
		)
	);
}

export function sameRemainingTarget(
	service: ImportService,
	original: ImportFileIdentity,
	selected: ImportFileIdentity,
): boolean {
	if (original.pathHash !== selected.pathHash) return false;
	if (service === "SONARR" && "seriesId" in original && "seriesId" in selected) {
		return (
			original.seriesId === selected.seriesId &&
			original.episodeFileId === selected.episodeFileId &&
			selected.episodeIds.every((id) => original.episodeIds.includes(id))
		);
	}
	return JSON.stringify(original) === JSON.stringify(selected);
}

function overlapsPositiveCoordinates(
	service: ImportService,
	original: ImportFileIdentity,
	selected: ImportFileIdentity,
	provenEpisodeIds: number[],
): boolean {
	if (service !== "SONARR" || !("seriesId" in original) || !("seriesId" in selected)) return true;
	// A disjoint episode subset is meaningful only for the same exact mapping.
	if (original.seriesId !== selected.seriesId || original.episodeFileId !== selected.episodeFileId)
		return true;
	return selected.episodeIds.some((id) => provenEpisodeIds.includes(id));
}

/**
 * Claim release is not new-action authority. Inspect all owned source history,
 * in bounded pages, inside both preparation and the final submission transaction.
 */
async function historyAllowsAdmission(
	transaction: TransactionClient,
	input: AdmissionBinding,
	excludeOperationId?: string,
): Promise<boolean> {
	const keys = sourceKeys(input.files);
	const deadline =
		Date.now() +
		Math.min(15_000, Math.max(0, input.preparationExpiresAt.getTime() - input.now.getTime()));
	const predecessor = input.remainderOf
		? await ownedOperation(transaction, input.userId, input.remainderOf)
		: null;
	if (
		input.remainderOf &&
		(!predecessor ||
			input.origin !== "manual" ||
			predecessor.originalInstanceId !== input.instanceId ||
			predecessor.connectionFingerprint !== input.connectionFingerprint ||
			predecessor.service !== input.service ||
			predecessor.mode !== input.mode ||
			!terminalHistory(predecessor, input.now) ||
			!historyFilesValid(predecessor))
	)
		return false;
	if (
		predecessor &&
		input.files.some((selected) => {
			const matches = predecessor.files.filter(
				(file) =>
					file.downloadKey === selected.downloadKey &&
					sameRemainingTarget(
						input.service,
						normalizeIdentity(input.service, file.identityJson)!,
						selected.identity,
					),
			);
			return matches.length !== 1 || matches[0]!.verifiedAt !== null;
		})
	)
		return false;
	let after: string | undefined;
	while (true) {
		if (Date.now() >= deadline) return false;
		const page = await transaction.arrImportOperation.findMany({
			where: {
				userId: input.userId,
				files: { some: { downloadKey: { in: keys } } },
				...(excludeOperationId
					? { id: { not: excludeOperationId, ...(after ? { gt: after } : {}) } }
					: after
						? { id: { gt: after } }
						: {}),
			},
			orderBy: { id: "asc" },
			take: 20,
			include: { files: true },
		});
		for (const operation of page) {
			if (!historyFilesValid(operation)) return false;
			const provedUnsubmitted =
				operation.state === "not-submitted" &&
				operation.submissionStartedAt === null &&
				operation.commandId === null &&
				operation.commandState === null &&
				!operation.commandTerminal &&
				operation.verifiedFileCount === 0;
			if (provedUnsubmitted) continue;
			if (
				!predecessor ||
				!terminalHistory(operation, input.now) ||
				operation.originalInstanceId !== input.instanceId ||
				operation.connectionFingerprint !== input.connectionFingerprint ||
				operation.service !== input.service
			)
				return false;
			const cursor =
				operation.reconcileCursor === null
					? null
					: parseImportReconcileCursor(operation, operation.reconcileCursor, input.now);
			if (operation.reconcileCursor !== null && cursor === null) return false;
			for (const historical of operation.files) {
				const identity = normalizeIdentity(input.service, historical.identityJson)!;
				const overlapping = input.files.filter(
					(file) =>
						file.downloadKey === historical.downloadKey &&
						file.identity.pathHash === identity.pathHash,
				);
				if (overlapping.length === 0) continue;
				if (
					cursor?.witnesses.some(
						(witness) => witness.fileFingerprint === historical.fileFingerprint,
					) ||
					cursor?.ambiguousFiles.includes(historical.fileFingerprint) ||
					(cursor?.version === 2 &&
						cursor.retainedAmbiguousFiles.includes(historical.fileFingerprint))
				)
					return false;
				const retained =
					cursor?.version === 2
						? cursor.retainedWitnesses.find(
								(witness) => witness.fileFingerprint === historical.fileFingerprint,
							)
						: undefined;
				if (historical.verifiedAt !== null || retained) {
					const episodes =
						historical.verifiedAt !== null && "episodeIds" in identity
							? identity.episodeIds
							: (retained?.episodeIds ?? []);
					if (
						overlapping.some((file) =>
							overlapsPositiveCoordinates(input.service, identity, file.identity, episodes),
						)
					)
						return false;
				}
			}
		}
		if (page.length < 20) break;
		after = page[page.length - 1]!.id;
	}
	// A legacy row remains protection unless this exact unchanged receipt has a
	// current-connection, command-bound terminal adoption. Never delete or rewrite it.
	let legacyAfter: string | undefined;
	while (true) {
		if (Date.now() >= deadline) return false;
		const receipts = await transaction.queueCleanerImportReceipt.findMany({
			where: {
				downloadKey: { in: keys },
				instance: { userId: input.userId },
				...(legacyAfter ? { id: { gt: legacyAfter } } : {}),
			},
			orderBy: { id: "asc" },
			take: 20,
		});
		for (const receipt of receipts) {
			if (
				!predecessor ||
				!["submitting", "pending", "unknown", "failed", "completed"].includes(receipt.state)
			)
				return false;
			const linked = await transaction.arrImportOperation.findMany({
				where: { userId: input.userId, legacyReceiptId: receipt.id },
				take: 2,
				include: { files: true },
			});
			const observed = linked[0];
			if (
				linked.length !== 1 ||
				!observed ||
				!terminalHistory(observed, input.now) ||
				!historyFilesValid(observed) ||
				observed.originalInstanceId !== input.instanceId ||
				receipt.instanceId !== input.instanceId ||
				observed.service !== input.service ||
				observed.connectionFingerprint !== input.connectionFingerprint ||
				receipt.connectionFingerprint !== input.connectionFingerprint ||
				observed.commandFingerprint !== receipt.commandFingerprint ||
				(receipt.commandId !== null && receipt.commandId !== observed.commandId) ||
				((receipt.state === "failed" || receipt.state === "completed") &&
					receipt.state !== observed.commandState) ||
				observed.submissionStartedAt?.getTime() !== receipt.lastAttemptAt.getTime() ||
				observed.files.some((file) => file.downloadKey !== receipt.downloadKey)
			)
				return false;
		}
		if (receipts.length < 20) break;
		legacyAfter = receipts[receipts.length - 1]!.id;
	}
	return true;
}

async function beginAttemptTransaction(
	prisma: PrismaClient,
	input: ValidatedAttempt,
): Promise<BeginImportAttemptResult> {
	return prisma.$transaction(async (transaction) => {
		const instance = await currentImportConnection(
			transaction,
			input.userId,
			input.instanceId,
			input.service,
			input.connectionFingerprint,
		);
		if (!instance) throw new ImportAttemptConflictError("connection-changed");

		const existing = await transaction.arrImportOperation.findFirst({
			where: { userId: input.userId, idempotencyKey: input.idempotencyKey },
			include: { files: { orderBy: { fileFingerprint: "asc" } } },
		});
		if (existing) {
			if (!immutableAttemptMatches(existing, input)) {
				throw new ImportAttemptConflictError("idempotency-conflict");
			}
			return { kind: "existing", operation: existing };
		}

		const keys = sourceKeys(input.files);
		const protectedKeys = input.remainderOf
			? (
					await transaction.arrImportSourceClaim.findMany({
						where: {
							userId: input.userId,
							downloadKey: { in: keys },
							activeOperationId: { not: null },
						},
						select: { downloadKey: true },
					})
				).map((claim) => claim.downloadKey)
			: await protectedDownloadKeys(transaction, input.userId, keys);
		if (protectedKeys.length > 0) return { kind: "protected", downloadKeys: protectedKeys };
		if (!(await historyAllowsAdmission(transaction, input)))
			return { kind: "protected", downloadKeys: keys };

		const operation = await transaction.arrImportOperation.create({
			data: {
				userId: input.userId,
				instanceId: instance.id,
				originalInstanceId: instance.id,
				connectionFingerprint: input.connectionFingerprint,
				service: input.service,
				origin: input.origin,
				mode: input.mode,
				idempotencyKey: input.idempotencyKey,
				requestFingerprint: input.requestFingerprint,
				commandFingerprint: input.commandFingerprint,
				encryptedSources: input.encryptedSources,
				sourcesEncryptionIv: input.sourcesEncryptionIv,
				state: "preparing",
				selectedFileCount: input.files.length,
				preparationExpiresAt: input.preparationExpiresAt,
				createdAt: input.now,
			},
		});
		for (const file of input.files) {
			await transaction.arrImportFileProof.create({
				data: {
					operationId: operation.id,
					fileFingerprint: file.fileFingerprint,
					downloadKey: file.downloadKey,
					identityJson: file.identityJson,
				},
			});
		}
		for (const downloadKey of keys) {
			const claim = await transaction.arrImportSourceClaim.findUnique({
				where: { userId_downloadKey: { userId: input.userId, downloadKey } },
				select: { activeOperationId: true },
			});
			if (!claim) {
				await transaction.arrImportSourceClaim.create({
					data: { userId: input.userId, downloadKey, activeOperationId: operation.id },
				});
			} else if (claim.activeOperationId === null) {
				const changed = await transaction.arrImportSourceClaim.updateMany({
					where: { userId: input.userId, downloadKey, activeOperationId: null },
					data: { activeOperationId: operation.id },
				});
				if (changed.count !== 1) throw new ImportSourceClaimRaceError();
			} else {
				throw new ImportSourceClaimRaceError();
			}
		}
		const owned = await transaction.arrImportOperation.findFirstOrThrow({
			where: { id: operation.id, userId: input.userId },
			include: { files: { orderBy: { fileFingerprint: "asc" } } },
		});
		if (input.automaticTracking) {
			await recordAutomaticPreparation(transaction, owned, input.automaticTracking);
		}
		return { kind: "created", operation: owned };
	});
}

async function resolveBeginRace(
	prisma: PrismaClient,
	input: ValidatedAttempt,
): Promise<BeginImportAttemptResult | null> {
	const existing = await prisma.arrImportOperation.findFirst({
		where: { userId: input.userId, idempotencyKey: input.idempotencyKey },
		include: { files: { orderBy: { fileFingerprint: "asc" } } },
	});
	if (existing) {
		if (!immutableAttemptMatches(existing, input)) {
			throw new ImportAttemptConflictError("idempotency-conflict");
		}
		return { kind: "existing", operation: existing };
	}
	const keys = sourceKeys(input.files);
	const [legacy, activeClaims] = await Promise.all([
		prisma.queueCleanerImportReceipt.findMany({
			where: { downloadKey: { in: keys }, instance: { userId: input.userId } },
			select: { downloadKey: true },
		}),
		prisma.arrImportSourceClaim.findMany({
			where: { userId: input.userId, downloadKey: { in: keys }, activeOperationId: { not: null } },
			select: { downloadKey: true },
		}),
	]);
	const protectedKeys = [
		...new Set([...legacy, ...activeClaims].map((record) => record.downloadKey)),
	].sort();
	return protectedKeys.length > 0 ? { kind: "protected", downloadKeys: protectedKeys } : null;
}

/** Atomically creates an immutable attempt and reserves every selected source. */
export async function beginImportAttempt(
	prisma: PrismaClient,
	input: BeginImportAttemptInput,
): Promise<BeginImportAttemptResult> {
	const validated = validateAttempt(input);
	let lastRetryableError: unknown;
	for (let attemptNumber = 0; attemptNumber < MAX_BEGIN_ATTEMPTS; attemptNumber += 1) {
		try {
			return await beginAttemptTransaction(prisma, validated);
		} catch (error) {
			if (error instanceof ImportAttemptConflictError) throw error;
			if (!retryableDatabaseError(error)) throw error;
			lastRetryableError = error;
			if (attemptNumber + 1 < MAX_BEGIN_ATTEMPTS) {
				await new Promise((resolve) => setTimeout(resolve, 5 * (attemptNumber + 1)));
			}
		}
	}
	const observed = await resolveBeginRace(prisma, validated);
	if (observed) return observed;
	throw lastRetryableError;
}

/** Reads an operation only when its owner matches; the payload is internal-only. */
export async function readOwnedImportAttempt(
	prisma: PrismaClient,
	userId: string,
	operationId: string,
): Promise<OwnedImportAttempt | null> {
	if (!validText(userId) || !validText(operationId)) return null;
	return prisma.arrImportOperation.findFirst({
		where: { id: operationId, userId },
		include: { files: { orderBy: { fileFingerprint: "asc" } } },
	});
}

export type LegacyImportReceiptSnapshot = Pick<
	QueueCleanerImportReceipt,
	| "id"
	| "instanceId"
	| "downloadKey"
	| "connectionFingerprint"
	| "commandFingerprint"
	| "commandId"
	| "state"
	| "lastAttemptAt"
	| "updatedAt"
>;

/** Internal evidence input, never an HTTP body or permission to submit/delete. */
export interface LegacyImportObservationInput {
	attempt: BeginImportAttemptInput;
	receipt: LegacyImportReceiptSnapshot;
	commandId: number;
	commandState: "pending" | "unknown" | "completed" | "failed";
}

/**
 * Link exact provider-derived file bindings to the unchanged legacy receipt.
 * Any command contributes zero positive file proofs; reconciliation must
 * establish those separately. This creates no submission claim or replay path.
 */
export async function persistLegacyImportObservation(
	prisma: PrismaClient,
	input: LegacyImportObservationInput,
): Promise<OwnedImportAttempt | null> {
	const attempt = validateAttempt(input.attempt);
	const receipt = input.receipt;
	if (
		attempt.origin !== "queue-cleaner" ||
		attempt.mode !== "Move" ||
		!validText(receipt.id) ||
		receipt.instanceId !== attempt.instanceId ||
		receipt.connectionFingerprint !== attempt.connectionFingerprint ||
		receipt.commandFingerprint !== attempt.commandFingerprint ||
		!HASH_PATTERN.test(receipt.downloadKey) ||
		!isFiniteDate(receipt.lastAttemptAt) ||
		!isFiniteDate(receipt.updatedAt) ||
		receipt.lastAttemptAt > attempt.now ||
		!isPositiveInteger(input.commandId) ||
		(receipt.commandId !== null && receipt.commandId !== input.commandId) ||
		!["pending", "unknown", "completed", "failed"].includes(input.commandState) ||
		!["submitting", "pending", "unknown", "completed", "failed"].includes(receipt.state) ||
		(receipt.state === "completed" && input.commandState !== "completed") ||
		(receipt.state === "failed" && input.commandState !== "failed") ||
		attempt.files.some((file) => file.downloadKey !== receipt.downloadKey)
	)
		return null;
	return prisma.$transaction(async (transaction) => {
		const existing = await transaction.arrImportOperation.findFirst({
			where: { userId: attempt.userId, legacyReceiptId: receipt.id },
			include: { files: { orderBy: { fileFingerprint: "asc" } } },
		});
		if (existing) return immutableAttemptMatches(existing, attempt) ? existing : null;
		const currentReceipt = await transaction.queueCleanerImportReceipt.findFirst({
			where: {
				...receipt,
				instance: { userId: attempt.userId },
			},
			select: { id: true },
		});
		const instance = await currentImportConnection(
			transaction,
			attempt.userId,
			attempt.instanceId,
			attempt.service,
			attempt.connectionFingerprint,
		);
		if (!currentReceipt || !instance) return null;
		const claim = await transaction.arrImportSourceClaim.findFirst({
			where: {
				userId: attempt.userId,
				downloadKey: receipt.downloadKey,
				activeOperationId: { not: null },
			},
			select: { id: true },
		});
		if (claim) return null;
		return transaction.arrImportOperation.create({
			data: {
				userId: attempt.userId,
				instanceId: instance.id,
				originalInstanceId: instance.id,
				connectionFingerprint: attempt.connectionFingerprint,
				service: attempt.service,
				origin: attempt.origin,
				mode: attempt.mode,
				idempotencyKey: attempt.idempotencyKey,
				requestFingerprint: attempt.requestFingerprint,
				commandFingerprint: attempt.commandFingerprint,
				encryptedSources: attempt.encryptedSources,
				sourcesEncryptionIv: attempt.sourcesEncryptionIv,
				legacyReceiptId: receipt.id,
				commandId: input.commandId,
				commandState: input.commandState,
				commandTerminal: input.commandState === "completed" || input.commandState === "failed",
				state: input.commandState === "completed" ? "unknown" : input.commandState,
				reason: input.commandState === "unknown" ? "evidence-unavailable" : null,
				selectedFileCount: attempt.files.length,
				verifiedFileCount: 0,
				submissionStartedAt: receipt.lastAttemptAt,
				preparationExpiresAt: attempt.now,
				createdAt: receipt.lastAttemptAt,
				files: {
					create: attempt.files.map((file) => ({
						fileFingerprint: file.fileFingerprint,
						downloadKey: file.downloadKey,
						identityJson: file.identityJson,
					})),
				},
			},
			include: { files: { orderBy: { fileFingerprint: "asc" } } },
		});
	});
}

async function operationWithCurrentConnection(
	transaction: TransactionClient,
	userId: string,
	operationId: string,
): Promise<{ operation: OwnedImportAttempt; current: boolean } | null> {
	const operation = await ownedOperation(transaction, userId, operationId);
	if (!operation) return null;
	if (!operation.instanceId || !KNOWN_OPERATION_STATES.has(operation.state)) {
		return { operation, current: false };
	}
	const instance = await currentImportConnection(
		transaction,
		operation.userId,
		operation.instanceId,
		operation.service as ImportService,
		operation.connectionFingerprint,
	);
	return { operation, current: instance !== null };
}

/** Fences the one allowed transition from preparation to a provider submission. */
export async function markImportSubmissionStarted(
	prisma: PrismaClient,
	userId: string,
	operationId: string,
	expectedConnectionFingerprint: string,
	startedAt: Date,
	automaticTracking?: AutomaticAttemptTracking,
	remainder?: { operationId: string; selectionFingerprint: string },
): Promise<boolean> {
	if (
		!validText(userId) ||
		!validText(operationId) ||
		!HASH_PATTERN.test(expectedConnectionFingerprint) ||
		!isFiniteDate(startedAt)
	) {
		return false;
	}
	return prisma.$transaction(async (transaction) => {
		const owned = await operationWithCurrentConnection(transaction, userId, operationId);
		if (!owned?.current) return false;
		const { operation } = owned;
		if (
			operation.state !== "preparing" ||
			operation.submissionStartedAt !== null ||
			operation.connectionFingerprint !== expectedConnectionFingerprint ||
			operation.preparationExpiresAt.getTime() <= startedAt.getTime() ||
			!historyFilesValid(operation) ||
			operation.verifiedFileCount !== 0 ||
			(operation.origin !== "manual" && operation.origin !== "queue-cleaner") ||
			(operation.mode !== "Move" && operation.mode !== "Copy")
		) {
			return false;
		}
		const keys = sourceKeys(operation.files);
		const claims = await transaction.arrImportSourceClaim.findMany({
			where: { userId, downloadKey: { in: keys } },
			select: { downloadKey: true, activeOperationId: true },
		});
		if (
			claims.length !== keys.length ||
			claims.some((claim) => claim.activeOperationId !== operation.id)
		) {
			return false;
		}
		if (
			remainder &&
			(operation.origin !== "manual" ||
				!validRemainderReference(remainder.operationId) ||
				!FILE_FINGERPRINT_PATTERN.test(remainder.selectionFingerprint) ||
				operation.requestFingerprint !==
					importIntentionFingerprint(remainder.selectionFingerprint, remainder.operationId))
		)
			return false;
		const files: NormalizedFile[] = [];
		for (const file of operation.files) {
			const identity = normalizeIdentity(operation.service as ImportService, file.identityJson);
			if (!identity) return false;
			files.push({
				fileFingerprint: file.fileFingerprint,
				downloadKey: file.downloadKey,
				identity,
				identityJson: file.identityJson as Prisma.InputJsonObject,
			});
		}
		if (
			!(await historyAllowsAdmission(
				transaction,
				{
					userId,
					instanceId: operation.originalInstanceId,
					connectionFingerprint: expectedConnectionFingerprint,
					service: operation.service as ImportService,
					origin: operation.origin as "manual" | "queue-cleaner",
					mode: operation.mode as "Move" | "Copy",
					files,
					now: startedAt,
					preparationExpiresAt: operation.preparationExpiresAt,
					remainderOf: remainder?.operationId,
				},
				operation.id,
			))
		)
			return false;
		if (automaticTracking) {
			await assertPreparedAutomaticTracking(transaction, operation, automaticTracking);
		}
		const changed = await transaction.arrImportOperation.updateMany({
			where: {
				id: operationId,
				userId,
				revision: operation.revision,
				state: "preparing",
				submissionStartedAt: null,
				connectionFingerprint: expectedConnectionFingerprint,
			},
			data: { state: "submitting", submissionStartedAt: startedAt, revision: { increment: 1 } },
		});
		return changed.count === 1;
	});
}

function validObservation(observation: ImportCommandObservation): boolean {
	if (!isRecord(observation)) return false;
	if (
		!Number.isSafeInteger(observation.expectedRevision) ||
		observation.expectedRevision < 0 ||
		!HASH_PATTERN.test(observation.connectionFingerprint) ||
		!FILE_FINGERPRINT_PATTERN.test(observation.commandFingerprint) ||
		!isFiniteDate(observation.checkedAt) ||
		!(
			observation.state === "pending" ||
			observation.state === "completed" ||
			observation.state === "failed" ||
			observation.state === "unknown"
		) ||
		typeof observation.terminal !== "boolean" ||
		(observation.reconcileToken !== undefined && !validText(observation.reconcileToken))
	) {
		return false;
	}
	if (observation.commandId !== undefined && !isPositiveInteger(observation.commandId))
		return false;
	if (observation.state === "completed" || observation.state === "failed") {
		return observation.terminal && observation.commandId !== undefined;
	}
	if (observation.state === "pending") {
		return !observation.terminal && observation.commandId !== undefined;
	}
	return !observation.terminal;
}

function evidenceLeaseFence(
	token: string | undefined,
	observedAt: Date,
): Prisma.ArrImportOperationWhereInput {
	return token === undefined
		? { reconcileToken: null, reconcileExpiresAt: null }
		: {
				reconcileToken: token,
				reconcileExpiresAt: { gt: new Date(Math.max(Date.now(), observedAt.getTime())) },
			};
}

function ownsEvidenceLease(
	operation: OwnedImportAttempt,
	token: string | undefined,
	observedAt: Date,
): boolean {
	return token === undefined
		? operation.reconcileToken === null && operation.reconcileExpiresAt === null
		: operation.reconcileToken === token &&
				operation.reconcileExpiresAt !== null &&
				operation.reconcileExpiresAt.getTime() > Math.max(Date.now(), observedAt.getTime());
}

function aggregateOperationState(
	commandState: ImportCommandObservation["state"],
	commandTerminal: boolean,
	verifiedFileCount: number,
	selectedFileCount: number,
): string {
	if (commandTerminal && verifiedFileCount === selectedFileCount) return "completed";
	if (!commandTerminal) return commandState;
	if (commandState === "failed") return verifiedFileCount > 0 ? "partial" : "failed";
	if (commandState === "completed") return verifiedFileCount > 0 ? "partial" : "unknown";
	return "unknown";
}

/** Persists exact command observations without treating aggregate success as file proof. */
export async function recordImportCommandObservation(
	prisma: PrismaClient,
	userId: string,
	operationId: string,
	observation: ImportCommandObservation,
): Promise<boolean> {
	if (!validText(userId) || !validText(operationId) || !validObservation(observation)) return false;
	return prisma.$transaction(async (transaction) => {
		const owned = await operationWithCurrentConnection(transaction, userId, operationId);
		if (!owned?.current) return false;
		const { operation } = owned;
		if (
			operation.submissionStartedAt === null ||
			operation.state === "preparing" ||
			operation.state === "not-submitted" ||
			operation.revision !== observation.expectedRevision ||
			operation.connectionFingerprint !== observation.connectionFingerprint ||
			operation.commandFingerprint !== observation.commandFingerprint ||
			!ownsEvidenceLease(operation, observation.reconcileToken, observation.checkedAt) ||
			(observation.commandId !== undefined &&
				operation.commandId !== null &&
				operation.commandId !== observation.commandId) ||
			!KNOWN_OPERATION_STATES.has(operation.state)
		) {
			return false;
		}
		if (operation.state === "completed") return false;
		if (
			operation.commandTerminal &&
			(!observation.terminal || observation.state !== operation.commandState)
		) {
			return false;
		}
		const verifiedFileCount = operation.files.filter((file) => file.verifiedAt !== null).length;
		const state = aggregateOperationState(
			operation.commandTerminal
				? (operation.commandState as ImportCommandObservation["state"])
				: observation.state,
			operation.commandTerminal || observation.terminal,
			verifiedFileCount,
			operation.selectedFileCount,
		);
		const changed = await transaction.arrImportOperation.updateMany({
			where: {
				...evidenceLeaseFence(observation.reconcileToken, observation.checkedAt),
				id: operationId,
				userId,
				revision: observation.expectedRevision,
				connectionFingerprint: observation.connectionFingerprint,
				commandFingerprint: observation.commandFingerprint,
			},
			data: {
				commandId: operation.commandId ?? observation.commandId ?? null,
				commandState: operation.commandTerminal ? operation.commandState : observation.state,
				commandTerminal: operation.commandTerminal || observation.terminal,
				state,
				lastCheckedAt: observation.checkedAt,
				revision: { increment: 1 },
			},
		});
		return changed.count === 1;
	});
}

function validProof(proof: VerifiedImportFilesInput): boolean {
	return (
		isRecord(proof) &&
		(proof.reconcileToken === undefined || validText(proof.reconcileToken)) &&
		Number.isSafeInteger(proof.expectedRevision) &&
		proof.expectedRevision >= 0 &&
		HASH_PATTERN.test(proof.connectionFingerprint) &&
		FILE_FINGERPRINT_PATTERN.test(proof.commandFingerprint) &&
		isPositiveInteger(proof.commandId) &&
		Array.isArray(proof.fileFingerprints) &&
		proof.fileFingerprints.length > 0 &&
		proof.fileFingerprints.length <= 1000 &&
		proof.fileFingerprints.every((fingerprint) => FILE_FINGERPRINT_PATTERN.test(fingerprint)) &&
		new Set(proof.fileFingerprints).size === proof.fileFingerprints.length &&
		isFiniteDate(proof.verifiedAt)
	);
}

/** Records positive per-file evidence only for existing, command-bound file rows. */
export async function recordVerifiedImportFiles(
	prisma: PrismaClient,
	userId: string,
	operationId: string,
	proof: VerifiedImportFilesInput,
): Promise<boolean> {
	if (!validText(userId) || !validText(operationId) || !validProof(proof)) return false;
	try {
		return await prisma.$transaction(async (transaction) => {
			const owned = await operationWithCurrentConnection(transaction, userId, operationId);
			if (!owned?.current) return false;
			const { operation } = owned;
			if (
				operation.submissionStartedAt === null ||
				operation.state === "preparing" ||
				operation.state === "not-submitted" ||
				operation.state === "completed" ||
				!KNOWN_OPERATION_STATES.has(operation.state) ||
				operation.revision !== proof.expectedRevision ||
				operation.connectionFingerprint !== proof.connectionFingerprint ||
				operation.commandFingerprint !== proof.commandFingerprint ||
				!ownsEvidenceLease(operation, proof.reconcileToken, proof.verifiedAt) ||
				operation.commandId !== proof.commandId
			) {
				return false;
			}
			const existing = await transaction.arrImportFileProof.findMany({
				where: {
					operationId,
					operation: { is: { userId } },
					fileFingerprint: { in: proof.fileFingerprints },
				},
				select: { fileFingerprint: true, verifiedAt: true },
			});
			if (existing.length !== proof.fileFingerprints.length) return false;
			await transaction.arrImportFileProof.updateMany({
				where: {
					operationId,
					operation: { is: { userId } },
					fileFingerprint: { in: proof.fileFingerprints },
					verifiedAt: null,
				},
				data: { verifiedAt: proof.verifiedAt },
			});
			const verifiedFileCount = await transaction.arrImportFileProof.count({
				where: { operationId, operation: { is: { userId } }, verifiedAt: { not: null } },
			});
			const commandState = operation.commandState;
			const nextState = operation.commandTerminal
				? aggregateOperationState(
						commandState === "completed" || commandState === "failed" ? commandState : "unknown",
						true,
						verifiedFileCount,
						operation.selectedFileCount,
					)
				: commandState === "pending" || commandState === "unknown"
					? commandState
					: operation.state;
			const changed = await transaction.arrImportOperation.updateMany({
				where: {
					...evidenceLeaseFence(proof.reconcileToken, proof.verifiedAt),
					id: operationId,
					userId,
					revision: proof.expectedRevision,
					connectionFingerprint: proof.connectionFingerprint,
					commandFingerprint: proof.commandFingerprint,
					commandId: proof.commandId,
				},
				data: { verifiedFileCount, state: nextState, revision: { increment: 1 } },
			});
			if (changed.count !== 1) throw new StaleImportEvidenceRaceError();
			return true;
		});
	} catch (error) {
		if (error instanceof StaleImportEvidenceRaceError) return false;
		throw error;
	}
}

/** Cancels only a preparing attempt whose provider submission has not begun. */
export async function cancelUnsubmittedImportAttempt(
	prisma: PrismaClient,
	userId: string,
	operationId: string,
): Promise<boolean> {
	if (!validText(userId) || !validText(operationId)) return false;
	return prisma.$transaction(async (transaction) => {
		const operation = await ownedOperation(transaction, userId, operationId);
		if (operation?.state !== "preparing" || operation.submissionStartedAt !== null) return false;
		const changed = await transaction.arrImportOperation.updateMany({
			where: {
				id: operationId,
				userId,
				revision: operation.revision,
				state: "preparing",
				submissionStartedAt: null,
			},
			data: { state: "not-submitted", reason: "not-submitted", revision: { increment: 1 } },
		});
		if (changed.count !== 1) return false;
		await transaction.arrImportSourceClaim.updateMany({
			where: { userId, activeOperationId: operationId },
			data: { activeOperationId: null },
		});
		return true;
	});
}

/** Clears an operation's active source fence without deleting its history or proofs. */
export async function releaseTerminalImportSources(
	prisma: PrismaClient,
	userId: string,
	operationId: string,
): Promise<boolean> {
	if (!validText(userId) || !validText(operationId)) return false;
	return prisma.$transaction(async (transaction) => {
		const operation = await ownedOperation(transaction, userId, operationId);
		if (!operation || !KNOWN_OPERATION_STATES.has(operation.state)) return false;
		const terminal =
			operation.submissionStartedAt !== null &&
			operation.commandId !== null &&
			operation.commandTerminal &&
			(operation.commandState === "completed" || operation.commandState === "failed") &&
			(operation.state === "unknown" ||
				operation.state === "partial" ||
				operation.state === "failed" ||
				operation.state === "completed");
		const notSubmitted =
			operation.state === "not-submitted" && operation.submissionStartedAt === null;
		if (!terminal && !notSubmitted) return false;
		const released = await transaction.arrImportSourceClaim.updateMany({
			where: { userId, activeOperationId: operationId },
			data: { activeOperationId: null },
		});
		return released.count > 0;
	});
}

/** Returns every owned receipt/proof/claim relevant to the requested source keys. */
export async function findImportSourceProtection(
	prisma: PrismaClient,
	userId: string,
	downloadKeys: string[],
): Promise<ImportSourceProtection[]> {
	if (!validText(userId) || !Array.isArray(downloadKeys) || downloadKeys.length === 0) return [];
	const keys = [
		...new Set(downloadKeys.filter((key) => typeof key === "string" && HASH_PATTERN.test(key))),
	].sort();
	if (keys.length === 0) return [];
	const [legacy, operations, claims] = await Promise.all([
		prisma.queueCleanerImportReceipt.findMany({
			where: { downloadKey: { in: keys }, instance: { userId } },
			select: { downloadKey: true, state: true },
		}),
		prisma.arrImportOperation.findMany({
			where: { userId, files: { some: { downloadKey: { in: keys } } } },
			select: {
				id: true,
				origin: true,
				originalInstanceId: true,
				state: true,
				commandId: true,
				commandState: true,
				commandTerminal: true,
				submissionStartedAt: true,
				verifiedFileCount: true,
				files: { where: { downloadKey: { in: keys } }, select: { downloadKey: true } },
			},
		}),
		prisma.arrImportSourceClaim.findMany({
			where: { userId, downloadKey: { in: keys }, activeOperationId: { not: null } },
			select: { downloadKey: true, activeOperationId: true },
		}),
	]);
	const result: ImportSourceProtection[] = [];
	for (const receipt of legacy) {
		result.push({
			downloadKey: receipt.downloadKey,
			kind: "legacy",
			state: receipt.state,
			commandTerminal: receipt.state === "completed",
		});
	}
	for (const operation of operations) {
		// Automatic preparation consumes a durable policy ordinal before POST.
		// Its cancellation is not cleanup authority, even after claims release or
		// restart. Keep removal protection independent of fresh policy admission.
		// Manual cancellations never consumed that automatic policy allowance.
		const provedUnsubmitted =
			operation.state === "not-submitted" &&
			operation.submissionStartedAt === null &&
			operation.commandId === null &&
			operation.commandState === null &&
			!operation.commandTerminal &&
			operation.verifiedFileCount === 0;
		if (provedUnsubmitted && operation.origin === "manual") continue;
		const protectionState =
			operation.state === "not-submitted" && !provedUnsubmitted
				? { state: "unknown", commandTerminal: false }
				: safeOperationProtectionState(operation);
		for (const file of operation.files) {
			result.push({
				downloadKey: file.downloadKey,
				kind: "operation",
				operationId: operation.id,
				state: protectionState.state,
				commandTerminal: protectionState.commandTerminal,
				...(provedUnsubmitted && operation.origin === "queue-cleaner"
					? { automaticRetryInstanceId: operation.originalInstanceId }
					: {}),
			});
		}
	}
	const activeOperationIds = [...new Set(claims.flatMap((claim) => claim.activeOperationId ?? []))];
	const activeOperations = activeOperationIds.length
		? await prisma.arrImportOperation.findMany({
				where: { userId, id: { in: activeOperationIds } },
				select: { id: true, state: true, commandTerminal: true, submissionStartedAt: true },
			})
		: [];
	const activeById = new Map(activeOperations.map((operation) => [operation.id, operation]));
	for (const claim of claims) {
		const operation = claim.activeOperationId ? activeById.get(claim.activeOperationId) : undefined;
		const protectionState = operation ? safeOperationProtectionState(operation) : null;
		const claimState =
			protectionState?.state === "not-submitted"
				? { state: "unknown", commandTerminal: false }
				: protectionState;
		result.push({
			downloadKey: claim.downloadKey,
			kind: "claim",
			...(operation && claimState?.state !== "unknown" ? { operationId: operation.id } : {}),
			state: claimState?.state ?? "unknown",
			commandTerminal: claimState?.commandTerminal ?? false,
		});
	}
	return result.sort(
		(left, right) =>
			left.downloadKey.localeCompare(right.downloadKey) ||
			left.kind.localeCompare(right.kind) ||
			(left.operationId ?? "").localeCompare(right.operationId ?? ""),
	);
}
