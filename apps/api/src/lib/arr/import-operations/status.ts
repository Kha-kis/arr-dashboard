import type {
	ManualImportLegacyQuery,
	ManualImportLegacyStatus,
	ManualImportOperationStatus,
	ManualImportSourceQuery,
	ManualImportSourceStatus,
} from "@arr/shared";
import {
	manualImportOperationReasonSchema,
	manualImportOperationStateSchema,
	manualImportOperationStatusSchema,
} from "@arr/shared";
import type { PrismaClient } from "../../prisma.js";
import { queueDownloadKey } from "../../queue-cleaner/import-receipt.js";
import type { ImportService } from "./repository.js";

export interface ImportStatusSource {
	id: string;
	state: string;
	reason: string | null;
	selectedFileCount: number;
	verifiedFileCount: number;
	commandId: number | null;
	commandState: string | null;
	commandTerminal: boolean;
	submissionStartedAt: Date | null;
	files: Array<{ fileFingerprint: string; verifiedAt: Date | null }>;
}

export class ImportStatusUnavailableError extends Error {
	readonly statusCode = 503;
	constructor() {
		super("Cached import progress is unavailable. No import was replayed.");
		this.name = "ImportStatusUnavailableError";
	}
}

export function serializeImportStatus(operation: ImportStatusSource): ManualImportOperationStatus {
	const files = operation.files;
	if (
		!Number.isSafeInteger(operation.selectedFileCount) ||
		operation.selectedFileCount < 1 ||
		operation.selectedFileCount > 1000 ||
		files.length !== operation.selectedFileCount ||
		new Set(files.map((file) => file.fileFingerprint)).size !== files.length ||
		files.some(
			(file) =>
				!/^v1:[a-f0-9]{64}$/.test(file.fileFingerprint) ||
				(file.verifiedAt !== null && !Number.isFinite(file.verifiedAt.getTime())),
		)
	)
		throw new ImportStatusUnavailableError();
	const verifiedFileCount = files.filter((file) => file.verifiedAt !== null).length;
	if (verifiedFileCount !== operation.verifiedFileCount) throw new ImportStatusUnavailableError();
	const parsedState = manualImportOperationStateSchema.safeParse(operation.state);
	const parsedReason = manualImportOperationReasonSchema.safeParse(operation.reason);
	let state: ManualImportOperationStatus["state"] = parsedState.success
		? parsedState.data
		: "unknown";
	let reason =
		operation.reason === null
			? null
			: parsedReason.success
				? parsedReason.data
				: ("evidence-unavailable" as const);
	const submitted =
		operation.submissionStartedAt !== null &&
		Number.isFinite(operation.submissionStartedAt.getTime());
	const positiveCommand =
		Number.isSafeInteger(operation.commandId) && Number(operation.commandId) > 0;
	const terminal =
		submitted &&
		positiveCommand &&
		operation.commandTerminal &&
		(operation.commandState === "completed" || operation.commandState === "failed");
	const notSubmitted =
		state === "not-submitted" &&
		operation.submissionStartedAt === null &&
		operation.commandId === null &&
		operation.commandState === null &&
		!operation.commandTerminal &&
		verifiedFileCount === 0;
	const inconsistent =
		!parsedState.success ||
		(operation.commandTerminal && !terminal) ||
		(state === "completed" && (!terminal || verifiedFileCount !== operation.selectedFileCount)) ||
		(state === "partial" &&
			(!terminal ||
				verifiedFileCount === 0 ||
				verifiedFileCount === operation.selectedFileCount)) ||
		(state === "failed" &&
			(!terminal || operation.commandState !== "failed" || verifiedFileCount !== 0)) ||
		(state === "not-submitted" && !notSubmitted) ||
		(state === "preparing" &&
			(operation.submissionStartedAt !== null ||
				verifiedFileCount !== 0 ||
				operation.commandId !== null)) ||
		(state === "submitting" && (!submitted || terminal)) ||
		(state === "pending" &&
			(!submitted ||
				!positiveCommand ||
				operation.commandState !== "pending" ||
				operation.commandTerminal));
	if (inconsistent) {
		state = "unknown";
		reason = "evidence-unavailable";
	}
	const result = manualImportOperationStatusSchema.safeParse({
		operationId: operation.id,
		state,
		reason,
		selectedFileCount: operation.selectedFileCount,
		verifiedFileCount,
		canConsiderNewAttempt:
			!inconsistent &&
			verifiedFileCount < operation.selectedFileCount &&
			(notSubmitted || (terminal && ["unknown", "partial", "failed"].includes(state))),
	});
	if (!result.success) throw new ImportStatusUnavailableError();
	return result.data;
}

export async function readCachedImportStatus(
	prisma: Pick<PrismaClient, "arrImportOperation">,
	userId: string,
	operationId: string,
): Promise<ManualImportOperationStatus | null> {
	if (!userId || !operationId) return null;
	const operation = await prisma.arrImportOperation.findFirst({
		where: { id: operationId, userId },
		select: {
			id: true,
			state: true,
			reason: true,
			selectedFileCount: true,
			verifiedFileCount: true,
			commandId: true,
			commandState: true,
			commandTerminal: true,
			submissionStartedAt: true,
			files: { take: 1001, select: { fileFingerprint: true, verifiedAt: true } },
		},
	});
	return operation ? serializeImportStatus(operation) : null;
}

/** Recover an acknowledgement without resubmitting or reading provider/source material. */
export async function readCachedImportStatusByAttemptKey(
	prisma: Pick<PrismaClient, "arrImportOperation">,
	userId: string,
	idempotencyKey: string,
): Promise<ManualImportOperationStatus | null> {
	if (!userId || !idempotencyKey) return null;
	const operation = await prisma.arrImportOperation.findFirst({
		where: { userId, idempotencyKey },
		select: { id: true },
	});
	return operation ? readCachedImportStatus(prisma, userId, operation.id) : null;
}

/** Cached legacy discovery is not adoption, source availability or mutation permission. */
export async function readCachedLegacyImportStatus(
	prisma: Pick<
		PrismaClient,
		"arrImportOperation" | "queueCleanerImportReceipt" | "serviceInstance"
	>,
	userId: string,
	query: ManualImportLegacyQuery,
): Promise<ManualImportLegacyStatus | null> {
	if (!userId) return null;
	const downloadKey = queueDownloadKey({ downloadId: query.downloadId });
	if (!downloadKey) return null;
	const service = query.service.toUpperCase() as ImportService;
	const receipt = await prisma.queueCleanerImportReceipt.findFirst({
		where: { instanceId: query.instanceId, downloadKey, instance: { userId } },
		select: { id: true },
	});
	const operations = await prisma.arrImportOperation.findMany({
		where: {
			userId,
			originalInstanceId: query.instanceId,
			service,
			legacyReceiptId: receipt ? receipt.id : { not: null },
			files: { some: { downloadKey } },
		},
		select: { id: true },
		take: 2,
	});
	if (operations.length > 1) return { kind: "unavailable", reason: "evidence-unavailable" };
	if (operations[0]) {
		const operation = await readCachedImportStatus(prisma, userId, operations[0].id);
		if (!operation) throw new ImportStatusUnavailableError();
		return { kind: "observed", operation };
	}
	const instance = await prisma.serviceInstance.findFirst({
		where: { id: query.instanceId, userId, service },
		select: { id: true },
	});
	if (!instance) return null;
	return receipt ? { kind: "unavailable", reason: "evidence-unavailable" } : { kind: "none" };
}

/** Observe current source work without a browser key; never infer mutation permission. */
export async function readCachedSourceImportStatus(
	prisma: Pick<
		PrismaClient,
		"arrImportOperation" | "arrImportSourceClaim" | "queueCleanerImportReceipt" | "serviceInstance"
	>,
	userId: string,
	query: ManualImportSourceQuery,
): Promise<ManualImportSourceStatus | null> {
	if (!userId) return null;
	const downloadKey = queueDownloadKey({ downloadId: query.downloadId });
	if (!downloadKey) return null;
	const scope = {
		userId,
		originalInstanceId: query.instanceId,
		service: query.service.toUpperCase() as ImportService,
		files: { some: { downloadKey } },
	};
	const instance = await prisma.serviceInstance.findFirst({
		where: { id: query.instanceId, userId, service: scope.service },
		select: { id: true },
	});
	// An owned claim does not authorize a requested foreign/absent connection.
	// Immutable owned history remains readable after permitted connection removal.
	if (!instance) {
		const historical = await prisma.arrImportOperation.findFirst({
			where: scope,
			select: { id: true },
		});
		if (!historical) return null;
	}
	const claim = await prisma.arrImportSourceClaim.findFirst({
		where: { userId, downloadKey, activeOperationId: { not: null } },
		select: { activeOperationId: true },
	});
	if (claim) {
		const operation = await prisma.arrImportOperation.findFirst({
			where: { ...scope, id: claim.activeOperationId! },
			select: { id: true },
		});
		if (!operation) return { kind: "unavailable", reason: "evidence-unavailable" };
		const status = await readCachedImportStatus(prisma, userId, operation.id);
		if (!status) throw new ImportStatusUnavailableError();
		return { kind: "observed", operation: status };
	}
	// A continuation cursor must belong to this exact immutable owned source scope.
	if (query.cursor) {
		const cursor = await prisma.arrImportOperation.findFirst({
			where: { ...scope, id: query.cursor },
			select: { id: true },
		});
		if (!cursor) return { kind: "unavailable", reason: "evidence-unavailable" };
	}
	// Stable opaque-ID keyset paging is navigation, not chronology or current authority.
	const operations = await prisma.arrImportOperation.findMany({
		where: { ...scope, ...(query.cursor ? { id: { gt: query.cursor } } : {}) },
		select: { id: true },
		orderBy: { id: "asc" },
		take: 21,
	});
	if (query.cursor || operations.length > 1) {
		const page = operations.slice(0, 20);
		const statuses: ManualImportOperationStatus[] = [];
		for (const operation of page) {
			const status = await readCachedImportStatus(prisma, userId, operation.id);
			if (!status) throw new ImportStatusUnavailableError();
			statuses.push(status);
		}
		return {
			kind: "history",
			operations: statuses,
			nextCursor: operations.length > 20 ? page.at(-1)!.id : null,
		};
	}
	if (operations[0]) {
		const status = await readCachedImportStatus(prisma, userId, operations[0].id);
		if (!status) throw new ImportStatusUnavailableError();
		return { kind: "observed", operation: status };
	}
	return readCachedLegacyImportStatus(prisma, userId, query);
}
