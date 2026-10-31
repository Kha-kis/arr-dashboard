import { createHash } from "node:crypto";
import {
	type ManualImportCandidate,
	type ManualImportLegacyQuery,
	type ManualImportRemainderReview,
	type ManualImportSubmissionFile,
	manualImportRemainderReviewSchema,
} from "@arr/shared";
import { LidarrClient, RadarrClient, ReadarrClient, SonarrClient } from "arr-sdk";
import { fetchManualImportCandidatesWithSdk } from "../../../routes/manual-import-utils.js";
import {
	importConnectionFingerprint,
	queueDownloadKey,
} from "../../queue-cleaner/import-receipt.js";
import { withImportActionGuards } from "./action-guards.js";
import { withImportConnectionReadGuard } from "./connection-guards.js";
import { parseImportReconcileCursor } from "./reconciliation-lease.js";
import {
	historyFilesValid,
	type ImportService,
	normalizeIdentity,
	readOwnedImportAttempt,
	sameRemainingTarget,
	terminalHistory,
} from "./repository.js";
import { buildVerifiedImportSelection } from "./selection.js";
import { serializeImportStatus } from "./status.js";
import type { ImportSubmissionContext } from "./submission.js";

export class ImportRemainderReviewUnavailableError extends Error {
	readonly statusCode = 503;
	constructor() {
		super(
			"Remaining-file review is unavailable or changed. Observe the original attempt and retry review. No import was submitted.",
		);
		this.name = "ImportRemainderReviewUnavailableError";
	}
}
class ImportRemainderNotFoundError extends Error {
	readonly statusCode = 404;
	constructor() {
		super("Import operation not found");
		this.name = "ImportRemainderNotFoundError";
	}
}

/** Explicit provider GET review, never a cached-status GET or a submission. */
export async function readImportRemainderReview(
	context: ImportSubmissionContext,
	userId: string,
	operationId: string,
	query: ManualImportLegacyQuery,
): Promise<ManualImportRemainderReview> {
	return withImportConnectionReadGuard(userId, query.instanceId, () =>
		withImportActionGuards(userId, [query.downloadId], async () => {
			const operation = await readOwnedImportAttempt(context.prisma, userId, operationId);
			const downloadKey = queueDownloadKey({ downloadId: query.downloadId });
			if (
				!operation ||
				operation.originalInstanceId !== query.instanceId ||
				operation.service.toLowerCase() !== query.service ||
				!downloadKey ||
				!operation.files.some((file) => file.downloadKey === downloadKey)
			)
				throw new ImportRemainderNotFoundError();
			try {
				const now = new Date();
				const deadline = Date.now() + 15000;
				const status = serializeImportStatus(operation);
				if (
					!status.canConsiderNewAttempt ||
					!terminalHistory(operation, now) ||
					!historyFilesValid(operation)
				)
					throw new ImportRemainderReviewUnavailableError();
				const service = operation.service as ImportService;
				const cursor =
					operation.reconcileCursor === null
						? null
						: parseImportReconcileCursor(operation, operation.reconcileCursor, now);
				if (operation.reconcileCursor !== null && cursor === null)
					throw new ImportRemainderReviewUnavailableError();
				const currentConnection = () =>
					context.prisma.serviceInstance.findFirst({
						where: { id: query.instanceId, userId, service, enabled: true },
					});
				const activeClaim = () =>
					context.prisma.arrImportSourceClaim.findFirst({
						where: { userId, downloadKey, activeOperationId: { not: null } },
						select: { id: true },
					});
				const instance = await currentConnection();
				if (
					!instance ||
					instance.id !== operation.instanceId ||
					importConnectionFingerprint(instance) !== operation.connectionFingerprint ||
					(await activeClaim())
				)
					throw new ImportRemainderReviewUnavailableError();
				const client = context.createClient(instance, { timeout: 15000 });
				if (
					!(query.service === "sonarr" && client instanceof SonarrClient) &&
					!(query.service === "radarr" && client instanceof RadarrClient) &&
					!(query.service === "lidarr" && client instanceof LidarrClient) &&
					!(query.service === "readarr" && client instanceof ReadarrClient)
				)
					throw new ImportRemainderReviewUnavailableError();
				let timer: ReturnType<typeof setTimeout> | undefined;
				const remaining = deadline - Date.now();
				if (remaining <= 0) throw new ImportRemainderReviewUnavailableError();
				const candidates = await Promise.race([
					fetchManualImportCandidatesWithSdk(client, query.service, {
						downloadId: query.downloadId,
					}),
					new Promise<never>((_, reject) => {
						timer = setTimeout(
							() => reject(new ImportRemainderReviewUnavailableError()),
							remaining,
						);
					}),
				]).finally(() => {
					if (timer !== undefined) clearTimeout(timer);
				});
				if (candidates.length > 10000) throw new ImportRemainderReviewUnavailableError();
				const sourceFiles = operation.files.filter((file) => file.downloadKey === downloadKey);
				const paths = new Map<string, ManualImportCandidate[]>();
				for (const candidate of candidates) {
					if (Date.now() >= deadline) throw new ImportRemainderReviewUnavailableError();
					const pathHash = createHash("sha256").update(candidate.path).digest("hex");
					const matching = paths.get(pathHash) ?? [];
					matching.push(candidate);
					paths.set(pathHash, matching);
				}
				const sourcePathCounts = new Map<string, number>();
				for (const file of sourceFiles) {
					const pathHash = normalizeIdentity(service, file.identityJson)!.pathHash;
					sourcePathCounts.set(pathHash, (sourcePathCounts.get(pathHash) ?? 0) + 1);
				}
				const fresh: ManualImportCandidate[] = [];
				let unavailableFileCount = 0;
				let verifiedEpisodeCount = 0;
				for (const file of sourceFiles) {
					if (Date.now() >= deadline) throw new ImportRemainderReviewUnavailableError();
					const identity = normalizeIdentity(service, file.identityJson)!;
					const retained =
						cursor?.version === 2
							? cursor.retainedWitnesses.find(
									(witness) => witness.fileFingerprint === file.fileFingerprint,
								)
							: undefined;
					const verifiedEpisodes =
						service === "SONARR" && "episodeIds" in identity
							? file.verifiedAt !== null
								? identity.episodeIds
								: (retained?.episodeIds ?? [])
							: [];
					verifiedEpisodeCount += verifiedEpisodes.length;
					if (file.verifiedAt !== null) continue;
					if (service !== "SONARR" && retained) {
						// Positive evidence excludes replay even if its full-file marker is missing.
						unavailableFileCount += 1;
						continue;
					}
					const ambiguous =
						cursor?.ambiguousFiles.includes(file.fileFingerprint) ||
						cursor?.witnesses.some((witness) => witness.fileFingerprint === file.fileFingerprint) ||
						(cursor?.version === 2 && cursor.retainedAmbiguousFiles.includes(file.fileFingerprint));
					const matches = paths.get(identity.pathHash) ?? [];
					if (ambiguous || matches.length !== 1 || sourcePathCounts.get(identity.pathHash) !== 1) {
						unavailableFileCount += 1;
						continue;
					}
					const candidate = matches[0]!;
					const { pathHash: _pathHash, ...coordinates } = identity;
					const requested: ManualImportSubmissionFile = {
						...coordinates,
						path: candidate.path,
						downloadId: query.downloadId,
					};
					if (service === "SONARR" && "episodeIds" in identity) {
						requested.episodeIds = identity.episodeIds.filter(
							(id) => !verifiedEpisodes.includes(id),
						);
						if (requested.episodeIds.length === 0) {
							unavailableFileCount += 1;
							continue;
						}
					}
					try {
						const selection = buildVerifiedImportSelection(query.service, [requested], matches);
						if (!sameRemainingTarget(service, identity, selection.identities[0]!.identity))
							throw new ImportRemainderReviewUnavailableError();
						fresh.push(
							candidate.service === "sonarr"
								? {
										...candidate,
										episodes: candidate.episodes?.filter((episode) =>
											requested.episodeIds!.includes(episode.id),
										),
									}
								: candidate,
						);
					} catch {
						unavailableFileCount += 1;
					}
				}
				const [after, connection, claim] = await Promise.all([
					readOwnedImportAttempt(context.prisma, userId, operationId),
					currentConnection(),
					activeClaim(),
				]);
				if (
					Date.now() >= deadline ||
					!after ||
					after.revision !== operation.revision ||
					!terminalHistory(after, new Date()) ||
					!historyFilesValid(after) ||
					!connection ||
					importConnectionFingerprint(connection) !== operation.connectionFingerprint ||
					claim
				)
					throw new ImportRemainderReviewUnavailableError();
				return manualImportRemainderReviewSchema.parse({
					operation: status,
					importMode: operation.mode === "Copy" ? "copy" : "move",
					sourceFileCount: sourceFiles.length,
					sourceVerifiedFileCount: sourceFiles.filter((file) => file.verifiedAt !== null).length,
					verifiedEpisodeCount,
					unavailableFileCount,
					candidates: fresh,
				});
			} catch {
				throw new ImportRemainderReviewUnavailableError();
			}
		}),
	);
}
