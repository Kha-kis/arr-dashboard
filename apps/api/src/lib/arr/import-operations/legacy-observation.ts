import { createHash } from "node:crypto";
import {
	type ManualImportServiceType,
	type ManualImportSubmissionFile,
	manualImportSubmissionFileSchema,
} from "@arr/shared";
import { LidarrClient, RadarrClient, ReadarrClient, SonarrClient } from "arr-sdk";
import type { Encryptor } from "../../auth/encryption.js";
import { withIndependentCleanupOperationGuard } from "../../library-cleanup/cleanup-maintenance-gate.js";
import {
	importConnectionFingerprint,
	queueDownloadKey,
} from "../../queue-cleaner/import-receipt.js";
import { classifyImportCommand, importCommandFingerprint } from "../manual-import-command.js";
import { withImportActionGuards } from "./action-guards.js";
import { withImportConnectionReadGuard } from "./connection-guards.js";
import type { ImportReconciliationContext } from "./reconciliation.js";
import {
	type ImportAttemptFile,
	type ImportFileIdentity,
	type ImportService,
	type LegacyImportReceiptSnapshot,
	type OwnedImportAttempt,
	persistLegacyImportObservation,
} from "./repository.js";
import { importRequestFingerprint } from "./selection.js";

export type LegacyImportObservationResult =
	| { kind: "bound"; operation: OwnedImportAttempt }
	| { kind: "unavailable" };
export type LegacyImportObservationContext = Omit<ImportReconciliationContext, "encryptor"> & {
	encryptor: Pick<Encryptor, "encrypt">;
};
const BUDGET_MS = 15_000;
const MAX_PAYLOAD_BYTES = 4 * 1024 * 1024;
const mediaFields: Record<ManualImportServiceType, string[]> = {
	sonarr: ["seriesId", "episodeIds", "episodeFileId"],
	radarr: ["movieId", "movieFileId"],
	lidarr: ["artistId", "albumId", "trackIds", "trackFileId", "albumReleaseId"],
	readarr: ["authorId", "bookId", "bookFileId", "foreignEditionId"],
};
function object(value: unknown): Record<string, unknown> | null {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}
function correctClient(
	client: ReturnType<ImportReconciliationContext["createClient"]>,
	service: string,
) {
	return service === "sonarr"
		? client instanceof SonarrClient
		: service === "radarr"
			? client instanceof RadarrClient
			: service === "lidarr"
				? client instanceof LidarrClient
				: service === "readarr" && client instanceof ReadarrClient;
}
function commandIdentity(
	raw: unknown,
	receipt: LegacyImportReceiptSnapshot,
	service: ManualImportServiceType,
	now: Date,
	expectedId?: number,
) {
	const command = object(raw),
		body = object(command?.body);
	if (
		!command ||
		!body ||
		!Number.isSafeInteger(command.id) ||
		Number(command.id) <= 0 ||
		(expectedId !== undefined && command.id !== expectedId) ||
		(command.name ?? command.commandName ?? body.name) !== "ManualImport" ||
		body.importMode !== "Move" ||
		typeof command.queued !== "string" ||
		!Number.isFinite(Date.parse(command.queued)) ||
		Date.parse(command.queued) < receipt.lastAttemptAt.getTime() ||
		Date.parse(command.queued) > now.getTime() ||
		!Array.isArray(body.files) ||
		body.files.length < 1 ||
		body.files.length > 1000 ||
		Buffer.byteLength(JSON.stringify(body.files), "utf8") > MAX_PAYLOAD_BYTES ||
		importCommandFingerprint(body.files) !== receipt.commandFingerprint
	)
		return null;
	const files: ManualImportSubmissionFile[] = [];
	for (const rawFile of body.files) {
		const file = object(rawFile);
		if (!file) return null;
		const historicalFile = { ...file };
		// Older Readarr command records serialize an omitted edition as null.
		// Normalize only this historical representation, never the raw command.
		if (service === "readarr" && historicalFile.foreignEditionId === null)
			delete historicalFile.foreignEditionId;
		const parsed = manualImportSubmissionFileSchema.safeParse(historicalFile);
		if (
			!parsed.success ||
			!parsed.data.path.trim() ||
			!parsed.data.downloadId ||
			parsed.data.downloadId !== parsed.data.downloadId.trim() ||
			queueDownloadKey(parsed.data) !== receipt.downloadKey
		)
			return null;
		for (const [kind, fields] of Object.entries(mediaFields)) {
			if (
				kind !== service &&
				fields.some((field) => (parsed.data as Record<string, unknown>)[field] !== undefined)
			)
				return null;
		}
		files.push(parsed.data);
	}
	if (
		new Set(files.map((file) => file.path)).size !== files.length ||
		importCommandFingerprint(files) !== receipt.commandFingerprint
	)
		return null;
	return { files, commandId: Number(command.id) };
}
function commandBinding(
	raw: unknown,
	receipt: LegacyImportReceiptSnapshot,
	service: ManualImportServiceType,
	now: Date,
	expectedId: number,
) {
	const identity = commandIdentity(raw, receipt, service, now, expectedId);
	const command = object(raw);
	if (!identity || !command) return null;
	const outcome = classifyImportCommand(command, receipt.commandFingerprint, identity.commandId);
	// Exact files establish the selection even before a terminal outcome exists.
	// Neither pending nor unknown observations establish imported-file evidence.
	if (outcome.state === "pending" || outcome.state === "unknown")
		return { ...identity, commandState: outcome.state };
	if (
		typeof command.queued !== "string" ||
		typeof command.ended !== "string" ||
		!Number.isFinite(Date.parse(command.ended)) ||
		Date.parse(command.ended) < Date.parse(command.queued) ||
		Date.parse(command.ended) > now.getTime()
	)
		return null;
	return { ...identity, commandState: outcome.state };
}
function fileBindings(
	service: ManualImportServiceType,
	files: ManualImportSubmissionFile[],
): ImportAttemptFile[] {
	return files.map((file) => {
		const identity: Record<string, unknown> = {
			pathHash: createHash("sha256").update(file.path).digest("hex"),
		};
		for (const field of mediaFields[service]) {
			const value = (file as Record<string, unknown>)[field];
			if (value !== undefined) identity[field] = value;
		}
		// The repository validates exact service coordinates before persistence.
		return {
			fileFingerprint: importCommandFingerprint([file])!,
			downloadKey: queueDownloadKey(file)!,
			identity: identity as ImportFileIdentity,
		};
	});
}

/**
 * Read-only provider observation plus local immutable linkage. Never submits,
 * changes legacy state, supplies cleanup permission, or invents file success.
 * The regular durable reconciler/scheduler obtains positive History evidence.
 */
export async function observeLegacyImport(
	context: LegacyImportObservationContext,
	userId: string,
	receiptId: string,
): Promise<LegacyImportObservationResult> {
	if (!userId?.trim() || !receiptId?.trim()) return { kind: "unavailable" };
	const cached = async () =>
		context.prisma.arrImportOperation.findFirst({
			where: { userId, legacyReceiptId: receiptId },
			include: { files: { orderBy: { fileFingerprint: "asc" } } },
		});
	try {
		const existing = await cached();
		if (existing) return { kind: "bound", operation: existing };
		const receipt = await context.prisma.queueCleanerImportReceipt.findFirst({
			where: { id: receiptId, instance: { userId } },
			select: {
				id: true,
				instanceId: true,
				downloadKey: true,
				connectionFingerprint: true,
				commandFingerprint: true,
				commandId: true,
				state: true,
				lastAttemptAt: true,
				updatedAt: true,
			},
		});
		if (
			!receipt ||
			!["submitting", "pending", "unknown", "completed", "failed"].includes(receipt.state)
		)
			return { kind: "unavailable" };
		return await withImportConnectionReadGuard(userId, receipt.instanceId, () =>
			withIndependentCleanupOperationGuard(async () => {
				const now = context.now?.() ?? new Date();
				const instance = await context.prisma.serviceInstance.findFirst({
					where: {
						id: receipt.instanceId,
						userId,
						enabled: true,
						service: { in: ["SONARR", "RADARR", "LIDARR", "READARR"] },
					},
				});
				if (
					!instance ||
					importConnectionFingerprint(instance) !== receipt.connectionFingerprint ||
					!Number.isFinite(now.getTime()) ||
					!Number.isFinite(receipt.lastAttemptAt.getTime()) ||
					receipt.lastAttemptAt > now ||
					!/^v1:[a-f0-9]{64}$/.test(receipt.commandFingerprint) ||
					!/^[a-f0-9]{64}$/.test(receipt.downloadKey) ||
					(receipt.commandId !== null &&
						(!Number.isSafeInteger(receipt.commandId) || receipt.commandId <= 0))
				)
					return { kind: "unavailable" as const };
				const service = instance.service.toLowerCase() as ManualImportServiceType;
				const client = context.createClient(instance, { timeout: BUDGET_MS });
				if (!correctClient(client, service)) return { kind: "unavailable" as const };
				const version = service === "lidarr" || service === "readarr" ? "v1" : "v3";
				const deadline = Date.now() + BUDGET_MS;
				const read = async (path: string): Promise<unknown> => {
					const remaining = deadline - Date.now();
					if (remaining <= 0) throw new Error("Legacy observation unavailable");
					let timer: ReturnType<typeof setTimeout> | undefined;
					try {
						return await Promise.race([
							client.get<unknown>(path),
							new Promise<never>((_, reject) => {
								timer = setTimeout(
									() => reject(new Error("Legacy observation unavailable")),
									remaining,
								);
							}),
						]);
					} finally {
						if (timer !== undefined) clearTimeout(timer);
					}
				};
				let commandId = receipt.commandId;
				if (commandId === null) {
					const commands = await read(`/api/${version}/command`);
					if (
						!Array.isArray(commands) ||
						commands.length > 1000 ||
						Buffer.byteLength(JSON.stringify(commands), "utf8") > MAX_PAYLOAD_BYTES
					)
						return { kind: "unavailable" as const };
					// Uniqueness includes active and unknown matches, not only terminal ones.
					const matches = commands.flatMap((raw) => {
						const identity = commandIdentity(raw, receipt, service, now);
						return identity ? [identity] : [];
					});
					if (matches.length !== 1) return { kind: "unavailable" as const };
					commandId = matches[0]!.commandId;
				}
				const binding = commandBinding(
					await read(`/api/${version}/command/${commandId}`),
					receipt,
					service,
					now,
					commandId,
				);
				if (!binding) return { kind: "unavailable" as const };
				return withImportActionGuards(
					userId,
					[...new Set(binding.files.map((file) => file.downloadId))],
					async () => {
						const lookup = JSON.stringify({ version: 1, service, files: binding.files });
						if (Buffer.byteLength(lookup, "utf8") > MAX_PAYLOAD_BYTES)
							return { kind: "unavailable" as const };
						const encrypted = context.encryptor.encrypt(lookup);
						const operation = await persistLegacyImportObservation(context.prisma, {
							receipt,
							commandId: binding.commandId,
							commandState: binding.commandState,
							attempt: {
								userId,
								instanceId: instance.id,
								service: instance.service as ImportService,
								connectionFingerprint: receipt.connectionFingerprint,
								origin: "queue-cleaner",
								mode: "Move",
								idempotencyKey: `legacy-v1:${createHash("sha256")
									.update(JSON.stringify([userId, receiptId]))
									.digest("hex")}`,
								requestFingerprint: importRequestFingerprint(binding.files),
								commandFingerprint: receipt.commandFingerprint,
								encryptedSources: encrypted.value,
								sourcesEncryptionIv: encrypted.iv,
								files: fileBindings(service, binding.files),
								now,
								preparationExpiresAt: new Date(now.getTime() + BUDGET_MS),
							},
						});
						return operation
							? { kind: "bound" as const, operation }
							: { kind: "unavailable" as const };
					},
				);
			}),
		);
	} catch {
		// A uniqueness race may have established the same owned immutable link.
		const existing = await cached().catch(() => null);
		return existing ? { kind: "bound", operation: existing } : { kind: "unavailable" };
	}
}
