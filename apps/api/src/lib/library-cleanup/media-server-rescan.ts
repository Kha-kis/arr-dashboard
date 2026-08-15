import { randomUUID } from "node:crypto";
import { createJellyfinClient } from "../jellyfin/jellyfin-client.js";
import { createPlexClient } from "../plex/plex-client.js";
import type { LibraryCleanupApproval, ServiceInstance } from "../prisma.js";
import {
	approvalRecordToAuditSnapshot,
	cleanupAuditEnabled,
	recordApprovalExecutionOutcome,
	recordApprovalMediaRescanEvent,
	runCleanupAuditBestEffort,
} from "./cleanup-audit.js";
import {
	assertCurrentProviderScanAuthority,
	createCurrentProviderScanAuthority,
	ProviderExecutionAuthorityChangedError,
	parseExecutableSafetyEnvelope,
	parseProviderScanAuthority,
} from "./shared-plex-safety.js";
import type { CleanupExecutorDeps } from "./types.js";

const RESCAN_RETRY_BASE_MS = 60 * 1000;
const RESCAN_RETRY_MAX_MS = 6 * 60 * 60 * 1000;

type RescanMediaType = "movie" | "show";
type RescanService = "PLEX" | "JELLYFIN" | "EMBY";

export interface MediaServerRescanResult {
	targets: number;
	triggered: number;
	skipped?: number;
	failed: number;
	warnings: string[];
	/** Exact upstream operations successfully triggered by this invocation. */
	triggeredOperationKeys?: string[];
	/** Terminal outcome for each physical operation completed by this invocation. */
	terminalOperationOutcomes?: Array<{
		operationKey: string;
		outcome: "triggered" | "skipped";
	}>;
	providerAuthorityFailed?: boolean;
}

function auditTrigger(
	deps: CleanupExecutorDeps,
): "approval" | "retry" | "recovery" | "manual" | "scheduled" {
	return deps.auditTrigger ?? "scheduled";
}

async function ensureTerminalAuditRecorded(
	deps: CleanupExecutorDeps,
	userId: string,
	approval: LibraryCleanupApproval,
): Promise<boolean> {
	if (!cleanupAuditEnabled(deps.prisma) || approval.terminalAuditRecordedAt) return true;
	const correlationId = approval.executionAuditCorrelationId ?? `recovery:${approval.id}`;
	let terminalEventType: string | null = null;
	const auditPersisted = await runCleanupAuditBestEffort(
		() =>
			recordApprovalExecutionOutcome(
				deps.prisma,
				{
					approval: approvalRecordToAuditSnapshot(approval),
					correlationId,
					trigger: "recovery",
					actorId: deps.auditActorId,
					auditPrepared: false,
					mutationAttempted: !approval.reconciledWithoutMutation,
					durableStateRecordingFailed: false,
					eventKeySuffix: "terminal_audit_recovery",
				},
				deps.log,
			).then((eventType) => {
				terminalEventType = eventType;
			}),
		deps.log,
		"media-server scan terminal-audit recovery",
	);
	if (
		!auditPersisted ||
		(terminalEventType !== "terminal_succeeded" &&
			terminalEventType !== "reconciled_without_mutation")
	) {
		return false;
	}
	const marked = await deps.prisma.libraryCleanupApproval.updateMany({
		where: {
			id: approval.id,
			config: { userId },
			status: "executed",
			terminalAuditRecordedAt: null,
		},
		data: { terminalAuditRecordedAt: new Date() },
	});
	if (marked.count === 1) return true;
	const current = await deps.prisma.libraryCleanupApproval.findFirst({
		where: { id: approval.id, config: { userId }, status: "executed" },
		select: { terminalAuditRecordedAt: true },
	});
	return current?.terminalAuditRecordedAt != null;
}

function isRescanService(service: ServiceInstance["service"]): service is RescanService {
	return service === "PLEX" || service === "JELLYFIN" || service === "EMBY";
}

function genericScanError(service: RescanService): string {
	return `${service === "PLEX" ? "Plex" : service === "JELLYFIN" ? "Jellyfin" : "Emby"} library scan request failed; arr-dashboard will retry it without repeating the cleanup deletion.`;
}

function rescanOperationKey(scan: {
	id: string;
	instanceId: string;
	service: string;
	serverIdentity: string | null;
	mediaType: string;
	plannedSectionIds: string | null;
}): string {
	if (!isRescanService(scan.service as ServiceInstance["service"])) return `unverified:${scan.id}`;
	if (scan.mediaType !== "movie" && scan.mediaType !== "show") return `unverified:${scan.id}`;
	const evidence = parseProviderScanAuthority(scan.serverIdentity, {
		instanceId: scan.instanceId,
		service: scan.service as RescanService,
		mediaType: scan.mediaType,
	});
	const identities = new Set(evidence?.sources.map((source) => source.identityFingerprint) ?? []);
	if (identities.size !== 1) return `unverified:${scan.id}`;
	const identityFingerprint = [...identities][0]!;
	return scan.service === "PLEX" && scan.plannedSectionIds !== null
		? `${scan.service}:${identityFingerprint}:${scan.mediaType}:${scan.plannedSectionIds}`
		: scan.service === "PLEX"
			? `unverified:${scan.id}`
			: `${scan.service}:${identityFingerprint}:global-library-refresh`;
}

function nextRescanDelayMs(attempt: number): number {
	const exponent = Math.max(0, Math.min(20, attempt - 1));
	return Math.min(RESCAN_RETRY_MAX_MS, RESCAN_RETRY_BASE_MS * 2 ** exponent);
}

function nextRescanAttemptAt(attempt: number, now = Date.now()): Date {
	return new Date(now + nextRescanDelayMs(attempt));
}

function candidateScanWhere() {
	return { status: { in: ["pending", "failed", "triggering"] } };
}

async function recordFinalRescanState(
	deps: CleanupExecutorDeps,
	approval: LibraryCleanupApproval,
	targets: Array<{ status: string; attemptCount: number }>,
	context: string,
): Promise<void> {
	if (targets.length === 0) return;
	if (targets.some((target) => target.status === "pending" || target.status === "triggering")) {
		return;
	}
	const failedCount = targets.filter((target) => target.status === "failed").length;
	const skippedCount = targets.filter((target) => target.status === "skipped").length;
	const triggeredCount = targets.filter((target) => target.status === "triggered").length;
	const auditEnabled = cleanupAuditEnabled(deps.prisma);
	const auditPersisted = await runCleanupAuditBestEffort(
		() =>
			recordApprovalMediaRescanEvent(
				deps.prisma,
				{
					approval: approvalRecordToAuditSnapshot(approval),
					correlationId: `media-rescan:${approval.id}`,
					trigger: auditTrigger(deps),
					actorId: deps.auditActorId,
					eventType:
						failedCount > 0
							? "media_rescan_failed"
							: skippedCount === targets.length
								? "media_rescan_skipped"
								: skippedCount > 0
									? "media_rescan_completed"
									: "media_rescan_triggered",
					attempt: Math.max(1, ...targets.map((target) => target.attemptCount)),
					targetCount: targets.length,
					failedCount,
					triggeredCount,
					skippedCount,
				},
				deps.log,
			),
		deps.log,
		context,
	);
	if (!auditEnabled || !auditPersisted || failedCount > 0) return;
	await deps.prisma.libraryCleanupMediaServerScan
		.deleteMany({
			where: { approvalId: approval.id, status: { in: ["triggered", "skipped"] } },
		})
		.catch((error) => {
			deps.log.warn(
				{ err: error, approvalId: approval.id },
				"Completed media-server scan jobs could not be pruned",
			);
		});
}

function equivalentOperationWhere(scan: {
	id: string;
	instanceId: string;
	service: string;
	serverIdentity: string | null;
	mediaType: string;
	plannedSectionIds: string | null;
}) {
	return scan.service === "PLEX"
		? {
				service: scan.service,
				mediaType: scan.mediaType,
				plannedSectionIds: scan.plannedSectionIds,
			}
		: { service: scan.service };
}

function rescanLeaseDelegate(deps: CleanupExecutorDeps) {
	return (
		deps.prisma as unknown as {
			libraryCleanupMediaServerScanLease?: {
				create(args: { data: Record<string, unknown> }): Promise<unknown>;
				updateMany(args: {
					where: Record<string, unknown>;
					data: Record<string, unknown>;
				}): Promise<{ count: number }>;
				deleteMany(args: { where: Record<string, unknown> }): Promise<{ count: number }>;
			};
		}
	).libraryCleanupMediaServerScanLease;
}

function rescanLeaseSqlExecutor(deps: CleanupExecutorDeps) {
	return (
		deps.prisma as unknown as {
			$executeRawUnsafe?: (query: string, ...values: unknown[]) => Promise<number>;
		}
	).$executeRawUnsafe;
}

function rescanLeaseSqlReader(deps: CleanupExecutorDeps) {
	return (
		deps.prisma as unknown as {
			$queryRawUnsafe?: (query: string, ...values: unknown[]) => Promise<Array<{ id: string }>>;
		}
	).$queryRawUnsafe;
}

function usesPostgres(): boolean {
	return /^postgres(ql)?:\/\//i.test(process.env.DATABASE_URL ?? "");
}

async function filterDatabaseEligibleScans<
	T extends { id: string; status: string; nextAttemptAt: Date | null },
>(deps: CleanupExecutorDeps, rows: T[]): Promise<T[]> {
	if (rows.length === 0) return [];
	const queryRaw = rescanLeaseSqlReader(deps);
	if (!queryRaw) {
		const now = new Date();
		return rows.filter(
			(row) =>
				row.status === "pending" ||
				row.status === "triggering" ||
				(row.status === "failed" && (row.nextAttemptAt === null || row.nextAttemptAt <= now)),
		);
	}
	const placeholders = rows.map((_, index) => (usesPostgres() ? `$${index + 1}` : "?")).join(", ");
	const query = usesPostgres()
		? `SELECT "id" FROM "library_cleanup_media_server_scans" WHERE "id" IN (${placeholders}) AND ("status" IN ('pending', 'triggering') OR ("status" = 'failed' AND ("nextAttemptAt" IS NULL OR "nextAttemptAt" <= CURRENT_TIMESTAMP)))`
		: `SELECT "id" FROM "library_cleanup_media_server_scans" WHERE "id" IN (${placeholders}) AND ("status" IN ('pending', 'triggering') OR ("status" = 'failed' AND ("nextAttemptAt" IS NULL OR julianday("nextAttemptAt") <= julianday('now'))))`;
	const eligible = await queryRaw.call(deps.prisma, query, ...rows.map((row) => row.id));
	const eligibleIds = new Set(eligible.map((row) => row.id));
	return rows.filter((row) => eligibleIds.has(row.id));
}

async function recordDatabaseRequestStart(
	deps: CleanupExecutorDeps,
	targetIds: string[],
	executionToken: string,
): Promise<number> {
	const executeRaw = rescanLeaseSqlExecutor(deps);
	if (!executeRaw) {
		return (
			await deps.prisma.libraryCleanupMediaServerScan.updateMany({
				where: { id: { in: targetIds }, status: "triggering", executionToken },
				data: { requestStartedAt: new Date() },
			})
		).count;
	}
	const idPlaceholders = targetIds
		.map((_, index) => (usesPostgres() ? `$${index + 1}` : "?"))
		.join(", ");
	const tokenPlaceholder = usesPostgres() ? `$${targetIds.length + 1}` : "?";
	return await executeRaw.call(
		deps.prisma,
		`UPDATE "library_cleanup_media_server_scans" SET "requestStartedAt" = CURRENT_TIMESTAMP, "updatedAt" = CURRENT_TIMESTAMP WHERE "id" IN (${idPlaceholders}) AND "status" = 'triggering' AND "executionToken" = ${tokenPlaceholder}`,
		...targetIds,
		executionToken,
	);
}

async function recordDatabaseScanFailure(
	deps: CleanupExecutorDeps,
	targetIds: string[],
	executionToken: string,
	message: string,
	attempt: number,
): Promise<number> {
	const executeRaw = rescanLeaseSqlExecutor(deps);
	if (!executeRaw) {
		return (
			await deps.prisma.libraryCleanupMediaServerScan.updateMany({
				where: { id: { in: targetIds }, status: "triggering", executionToken },
				data: {
					status: "failed",
					executionToken: null,
					lastError: message,
					nextAttemptAt: nextRescanAttemptAt(attempt),
				},
			})
		).count;
	}
	const delayMs = nextRescanDelayMs(attempt);
	if (usesPostgres()) {
		const idPlaceholders = targetIds.map((_, index) => `$${index + 3}`).join(", ");
		const tokenPlaceholder = `$${targetIds.length + 3}`;
		return await executeRaw.call(
			deps.prisma,
			`UPDATE "library_cleanup_media_server_scans" SET "status" = 'failed', "executionToken" = NULL, "lastError" = $1, "nextAttemptAt" = CURRENT_TIMESTAMP + ($2 * INTERVAL '1 millisecond'), "updatedAt" = CURRENT_TIMESTAMP WHERE "id" IN (${idPlaceholders}) AND "status" = 'triggering' AND "executionToken" = ${tokenPlaceholder}`,
			message,
			delayMs,
			...targetIds,
			executionToken,
		);
	}
	const idPlaceholders = targetIds.map(() => "?").join(", ");
	return await executeRaw.call(
		deps.prisma,
		`UPDATE "library_cleanup_media_server_scans" SET "status" = 'failed', "executionToken" = NULL, "lastError" = ?, "nextAttemptAt" = datetime('now', '+' || (? / 1000.0) || ' seconds'), "updatedAt" = CURRENT_TIMESTAMP WHERE "id" IN (${idPlaceholders}) AND "status" = 'triggering' AND "executionToken" = ?`,
		message,
		delayMs,
		...targetIds,
		executionToken,
	);
}

async function acquireRescanOperationLease(
	deps: CleanupExecutorDeps,
	userId: string,
	operationKey: string,
	executionToken: string,
): Promise<boolean> {
	const lease = rescanLeaseDelegate(deps);
	if (!lease) return true;
	const executeRaw = rescanLeaseSqlExecutor(deps);
	if (executeRaw) {
		const inserted = usesPostgres()
			? await executeRaw.call(
					deps.prisma,
					'INSERT INTO "library_cleanup_media_server_scan_leases" ("operationKey", "userId", "executionToken", "createdAt", "updatedAt") VALUES ($1, $2, $3, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP) ON CONFLICT ("operationKey") DO NOTHING',
					operationKey,
					userId,
					executionToken,
				)
			: await executeRaw.call(
					deps.prisma,
					'INSERT OR IGNORE INTO "library_cleanup_media_server_scan_leases" ("operationKey", "userId", "executionToken", "createdAt", "updatedAt") VALUES (?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)',
					operationKey,
					userId,
					executionToken,
				);
		if (inserted === 1) return true;
		const reclaimed = usesPostgres()
			? await executeRaw.call(
					deps.prisma,
					'UPDATE "library_cleanup_media_server_scan_leases" SET "userId" = $1, "executionToken" = $2, "updatedAt" = CURRENT_TIMESTAMP WHERE "operationKey" = $3 AND "updatedAt" < CURRENT_TIMESTAMP - INTERVAL \'10 minutes\'',
					userId,
					executionToken,
					operationKey,
				)
			: await executeRaw.call(
					deps.prisma,
					'UPDATE "library_cleanup_media_server_scan_leases" SET "userId" = ?, "executionToken" = ?, "updatedAt" = CURRENT_TIMESTAMP WHERE "operationKey" = ? AND julianday("updatedAt") < julianday(\'now\', \'-10 minutes\')',
					userId,
					executionToken,
					operationKey,
				);
		return reclaimed === 1;
	}
	try {
		await lease.create({ data: { operationKey, userId, executionToken } });
		return true;
	} catch (error) {
		if ((error as { code?: string }).code !== "P2002") throw error;
		// Test doubles do not expose raw SQL. Production lease expiry is always
		// decided by the database clock above, never a worker-local timestamp.
		return false;
	}
}

async function assertRescanOperationLease(
	deps: CleanupExecutorDeps,
	userId: string,
	operationKey: string,
	executionToken: string,
): Promise<void> {
	const lease = rescanLeaseDelegate(deps);
	if (!lease) return;
	const executeRaw = rescanLeaseSqlExecutor(deps);
	if (executeRaw) {
		const renewed = usesPostgres()
			? await executeRaw.call(
					deps.prisma,
					'UPDATE "library_cleanup_media_server_scan_leases" SET "updatedAt" = CURRENT_TIMESTAMP WHERE "operationKey" = $1 AND "userId" = $2 AND "executionToken" = $3',
					operationKey,
					userId,
					executionToken,
				)
			: await executeRaw.call(
					deps.prisma,
					'UPDATE "library_cleanup_media_server_scan_leases" SET "updatedAt" = CURRENT_TIMESTAMP WHERE "operationKey" = ? AND "userId" = ? AND "executionToken" = ?',
					operationKey,
					userId,
					executionToken,
				);
		if (renewed !== 1) throw new Error("Media-server scan operation lease was lost");
		return;
	}
	const renewed = await lease.updateMany({
		where: { operationKey, userId, executionToken },
		data: {},
	});
	if (renewed.count !== 1) throw new Error("Media-server scan operation lease was lost");
}

async function releaseRescanOperationLease(
	deps: CleanupExecutorDeps,
	userId: string,
	operationKey: string,
	executionToken: string,
): Promise<void> {
	const lease = rescanLeaseDelegate(deps);
	if (!lease) return;
	await lease.deleteMany({ where: { operationKey, userId, executionToken } });
}

async function readMediaServerTarget(
	deps: CleanupExecutorDeps,
	instance: ServiceInstance,
	mediaType: RescanMediaType,
): Promise<{ plannedSectionIds: string | null }> {
	if (
		instance.identityStatus !== "VERIFIED" ||
		!instance.expectedIdentity ||
		!instance.identityKind ||
		!instance.identityVerifiedAt ||
		instance.identityGeneration <= 0
	) {
		throw new ProviderExecutionAuthorityChangedError();
	}
	if (instance.service === "PLEX") {
		const client =
			deps.plexCacheClientFactory?.(instance) ??
			(deps.encryptor ? createPlexClient(deps.encryptor, instance, deps.log) : null);
		if (!client) throw new Error("Plex scan client is unavailable");
		const identity = await client.getIdentity();
		if (identity.machineIdentifier !== instance.expectedIdentity) {
			throw new ProviderExecutionAuthorityChangedError();
		}
		const sections = await client.getLibrarySections();
		if (sections.length === 0) {
			throw new Error("Plex returned no library-section inventory");
		}
		const plannedSectionIds = sections
			.filter((section) => section.type === mediaType)
			.map((section) => section.key)
			.sort();
		return { plannedSectionIds: JSON.stringify(plannedSectionIds) };
	}
	if (instance.service === "JELLYFIN" || instance.service === "EMBY") {
		const client =
			deps.jellyfinCacheClientFactory?.(instance) ??
			(deps.encryptor ? createJellyfinClient(deps.encryptor, instance, deps.log) : null);
		if (!client) throw new Error("Jellyfin-compatible scan client is unavailable");
		const identity = await client.getPublicInfo();
		if (identity.id !== instance.expectedIdentity) {
			throw new ProviderExecutionAuthorityChangedError();
		}
		return { plannedSectionIds: null };
	}
	throw new Error("Media-server scan service is unsupported");
}

function completedPlexSections(value: string): Set<string> {
	try {
		const parsed = JSON.parse(value);
		return new Set(
			Array.isArray(parsed)
				? parsed.filter((entry): entry is string => typeof entry === "string" && entry.length > 0)
				: [],
		);
	} catch {
		return new Set();
	}
}

/**
 * Persist post-deletion scan intent before the first irreversible ARR write.
 * Failure to persist this intent blocks the deletion instead of silently
 * dropping an explicitly requested follow-up action.
 */
export async function prepareMediaServerRescans(
	deps: CleanupExecutorDeps,
	userId: string,
	approval: LibraryCleanupApproval,
	mediaType: RescanMediaType,
): Promise<number> {
	if (!approval.scanMediaServerAfterDelete) return 0;
	const approvalEnvelope = parseExecutableSafetyEnvelope(approval.safetySnapshot);
	if (!approvalEnvelope || approvalEnvelope.providerEvidence.sources.length === 0) {
		throw new Error("Requested media-server scan provider authority is unavailable");
	}
	const instances = await deps.prisma.serviceInstance.findMany({
		where: {
			userId,
			enabled: true,
			service: { in: ["PLEX", "JELLYFIN", "EMBY"] },
		},
		orderBy: { id: "asc" },
	});
	const rescanInstances = instances.filter((instance) => isRescanService(instance.service));
	if (rescanInstances.length === 0) {
		throw new Error(
			"Media-server scanning is enabled for this rule, but no enabled Plex, Jellyfin, or Emby service is configured.",
		);
	}
	const expectedTargets = new Map<
		string,
		{ serverIdentity: string; plannedSectionIds: string | null }
	>();

	for (const instance of rescanInstances) {
		const targetKey = `${instance.service}:${instance.id}:${mediaType}`;
		let serverIdentity: string;
		let plannedSectionIds: string | null;
		try {
			({ plannedSectionIds } = await readMediaServerTarget(deps, instance, mediaType));
			serverIdentity = await createCurrentProviderScanAuthority(
				deps,
				userId,
				{ instanceId: instance.id, service: instance.service as RescanService, mediaType },
				approvalEnvelope.providerEvidence,
			);
			expectedTargets.set(targetKey, { serverIdentity, plannedSectionIds });
		} catch (error) {
			deps.log.warn(
				{ err: error, instanceId: instance.id, service: instance.service },
				"Cleanup could not verify a requested media-server scan target before deletion",
			);
			if (error instanceof ProviderExecutionAuthorityChangedError) {
				throw new Error(
					"A requested media-server scan target lacks current provider authority, so cleanup was not started.",
				);
			}
			throw new Error(
				"A requested media-server scan target could not be verified, so cleanup was not started.",
			);
		}
		try {
			await deps.prisma.libraryCleanupMediaServerScan.create({
				data: {
					approvalId: approval.id,
					instanceId: instance.id,
					service: instance.service,
					serverIdentity,
					mediaType,
					plannedSectionIds,
					targetKey,
				},
			});
		} catch (error) {
			if ((error as { code?: string }).code !== "P2002") throw error;
			const existing = await deps.prisma.libraryCleanupMediaServerScan.findUnique({
				where: { approvalId_targetKey: { approvalId: approval.id, targetKey } },
				select: { serverIdentity: true, plannedSectionIds: true },
			});
			if (
				!existing ||
				existing.serverIdentity !== serverIdentity ||
				existing.plannedSectionIds !== plannedSectionIds
			) {
				throw new Error(
					"A requested media-server scan target or section plan changed before cleanup could be retried.",
				);
			}
		}
	}

	const durableTargets = await deps.prisma.libraryCleanupMediaServerScan.findMany({
		where: { approvalId: approval.id },
		select: { targetKey: true, serverIdentity: true, plannedSectionIds: true },
	});
	const targetCount = durableTargets.length;
	const targetPlanMatches =
		targetCount === expectedTargets.size &&
		durableTargets.every((target) => {
			const expected = expectedTargets.get(target.targetKey);
			return (
				expected?.serverIdentity === target.serverIdentity &&
				expected.plannedSectionIds === target.plannedSectionIds
			);
		});
	if (!targetPlanMatches) {
		throw new Error(
			"The durable media-server scan target set changed before cleanup could be retried.",
		);
	}
	if (targetCount === 0) {
		throw new Error(
			"Media-server scanning is enabled for this rule, but no durable scan target could be recorded.",
		);
	}
	if (targetCount > 0) {
		await runCleanupAuditBestEffort(
			() =>
				recordApprovalMediaRescanEvent(
					deps.prisma,
					{
						approval: approvalRecordToAuditSnapshot(approval),
						correlationId: approval.executionToken ?? `media-rescan:${approval.id}`,
						trigger: auditTrigger(deps),
						actorId: deps.auditActorId,
						eventType: "media_rescan_pending",
						attempt: 0,
						targetCount,
					},
					deps.log,
				),
			deps.log,
			"media-server rescan preparation",
		);
	}
	return targetCount;
}

async function triggerClaimedRescan(
	deps: CleanupExecutorDeps,
	userId: string,
	scan: {
		id: string;
		instanceId: string;
		service: string;
		serverIdentity: string | null;
		mediaType: string;
		plannedSectionIds: string | null;
		completedSectionIds: string;
	},
	executionToken: string,
	operationKey: string,
	onUpstreamDispatch: () => void,
): Promise<"triggered" | "skipped"> {
	const service = scan.service as RescanService;
	if (!isRescanService(service as ServiceInstance["service"])) {
		throw new Error("Stored media-server scan service is invalid");
	}
	const instance = await deps.prisma.serviceInstance.findFirst({
		where: { id: scan.instanceId, userId, enabled: true, service },
	});
	if (!instance)
		throw new Error("Media-server scan target is no longer enabled or owned by this user");
	if (scan.mediaType !== "movie" && scan.mediaType !== "show") {
		throw new Error("Stored media-server scan type is invalid");
	}
	const authorityTarget = {
		instanceId: scan.instanceId,
		service,
		mediaType: scan.mediaType as RescanMediaType,
	};
	await assertCurrentProviderScanAuthority(
		deps,
		userId,
		scan.serverIdentity,
		authorityTarget,
		async () => await assertRescanOperationLease(deps, userId, operationKey, executionToken),
	);

	if (service === "PLEX") {
		const client =
			deps.plexCacheClientFactory?.(instance) ??
			(deps.encryptor ? createPlexClient(deps.encryptor, instance, deps.log) : null);
		if (!client) throw new Error("Plex scan client is unavailable");
		if (scan.plannedSectionIds === null) {
			throw new Error("Stored Plex scan target lacks pre-deletion section evidence");
		}
		const planned = completedPlexSections(scan.plannedSectionIds);
		if (planned.size === 0) return "skipped";
		const currentSections = new Map(
			(await client.getLibrarySections())
				.filter((section) => section.type === scan.mediaType)
				.map((section) => [section.key, section]),
		);
		const sections = [...planned]
			.map((sectionId) => currentSections.get(sectionId))
			.filter((section): section is NonNullable<typeof section> => section !== undefined)
			.sort((left, right) => left.key.localeCompare(right.key));
		if (sections.length !== planned.size) {
			throw new Error("A planned Plex library section is unavailable");
		}
		// Retry the complete pre-deletion plan. A section refreshed during an
		// earlier partial attempt cannot cover a deletion that joined this
		// physical operation later.
		const completed = new Set<string>();
		for (const section of sections) {
			await assertCurrentProviderScanAuthority(
				deps,
				userId,
				scan.serverIdentity,
				authorityTarget,
				async () => await assertRescanOperationLease(deps, userId, operationKey, executionToken),
			);
			await client.refreshSection(section.key);
			onUpstreamDispatch();
			completed.add(section.key);
			const progress = await deps.prisma.libraryCleanupMediaServerScan.updateMany({
				where: { id: scan.id, status: "triggering", executionToken },
				data: { completedSectionIds: JSON.stringify([...completed].sort()) },
			});
			if (progress.count !== 1) throw new Error("Media-server scan ownership changed");
		}
		return "triggered";
	}

	const client =
		deps.jellyfinCacheClientFactory?.(instance) ??
		(deps.encryptor ? createJellyfinClient(deps.encryptor, instance, deps.log) : null);
	if (!client) throw new Error("Jellyfin-compatible scan client is unavailable");
	await client.refreshLibrary();
	onUpstreamDispatch();
	return "triggered";
}

/** Trigger only durable scan work for one already-executed cleanup action. */
export async function triggerMediaServerRescansForApproval(
	deps: CleanupExecutorDeps,
	userId: string,
	approvalId: string,
): Promise<MediaServerRescanResult> {
	const approval = await deps.prisma.libraryCleanupApproval.findFirst({
		where: { id: approvalId, config: { userId }, status: "executed" },
	});
	if (!approval) return { targets: 0, triggered: 0, failed: 0, warnings: [] };
	if (!(await ensureTerminalAuditRecorded(deps, userId, approval))) {
		return {
			targets: 0,
			triggered: 0,
			failed: 0,
			warnings: [
				"The media-server scan remains pending until the terminal cleanup audit can be recorded.",
			],
		};
	}

	const scanCandidates = await deps.prisma.libraryCleanupMediaServerScan.findMany({
		where: {
			approvalId,
			...candidateScanWhere(),
		},
		orderBy: { targetKey: "asc" },
	});
	const scans = await filterDatabaseEligibleScans(deps, scanCandidates);
	let triggered = 0;
	let skipped = 0;
	let failed = 0;
	let claimed = 0;
	const warnings: string[] = [];
	const triggeredOperationKeys = new Set<string>();
	const terminalOperationOutcomes = new Map<string, "triggered" | "skipped">();
	const affectedApprovalIds = new Set<string>();
	let providerAuthorityFailed = false;
	const representativeScans = new Map<string, (typeof scans)[number]>();
	for (const scan of scans) {
		const operationKey = rescanOperationKey(scan);
		if (!representativeScans.has(operationKey)) representativeScans.set(operationKey, scan);
	}

	for (const [operationKey, scan] of representativeScans) {
		const executionToken = randomUUID();
		if (!(await acquireRescanOperationLease(deps, userId, operationKey, executionToken))) {
			continue;
		}
		let preserveLeaseForAmbiguousDispatch = false;
		let upstreamDispatchStarted = false;
		let physicalOutcome: "triggered" | "skipped" | null = null;
		try {
			const equivalentCandidates = await deps.prisma.libraryCleanupMediaServerScan.findMany({
				where: {
					...equivalentOperationWhere(scan),
					...candidateScanWhere(),
					approval: {
						config: { userId },
						status: "executed",
						...(cleanupAuditEnabled(deps.prisma) ? { terminalAuditRecordedAt: { not: null } } : {}),
					},
				},
				orderBy: [{ approvalId: "asc" }, { targetKey: "asc" }],
			});
			const equivalentTargets = await filterDatabaseEligibleScans(
				deps,
				equivalentCandidates.filter((candidate) => rescanOperationKey(candidate) === operationKey),
			);
			if (equivalentTargets.length === 0) continue;
			const targetIds = equivalentTargets.map((target) => target.id);
			const claim = await deps.prisma.libraryCleanupMediaServerScan.updateMany({
				where: { id: { in: targetIds }, ...candidateScanWhere() },
				data: {
					status: "triggering",
					executionToken,
					attemptCount: { increment: 1 },
					completedSectionIds: "[]",
					lastError: null,
					nextAttemptAt: null,
					requestStartedAt: null,
				},
			});
			if (claim.count === 0) continue;
			const claimedTargets = await deps.prisma.libraryCleanupMediaServerScan.findMany({
				where: { id: { in: targetIds }, status: "triggering", executionToken },
				orderBy: [{ approvalId: "asc" }, { targetKey: "asc" }],
			});
			if (claimedTargets.length !== claim.count || claimedTargets.length === 0) {
				throw new Error("Media-server scan claim could not be verified");
			}
			claimed += claimedTargets.length;
			for (const target of claimedTargets) affectedApprovalIds.add(target.approvalId);
			const requestProofCount = await recordDatabaseRequestStart(deps, targetIds, executionToken);
			if (requestProofCount !== claimedTargets.length) {
				throw new Error("Media-server scan request-start proof could not be recorded");
			}
			let lastCandidateError: unknown = new Error(
				"No equivalent media-server instance could execute the scan",
			);
			for (const candidate of claimedTargets) {
				try {
					physicalOutcome = await triggerClaimedRescan(
						deps,
						userId,
						candidate,
						executionToken,
						operationKey,
						() => {
							upstreamDispatchStarted = true;
						},
					);
					break;
				} catch (error) {
					if (error instanceof ProviderExecutionAuthorityChangedError) throw error;
					lastCandidateError = error;
					if (upstreamDispatchStarted) throw error;
					deps.log.warn(
						{ err: error, scanId: candidate.id, instanceId: candidate.instanceId },
						"Equivalent media-server scan instance could not execute the physical operation",
					);
				}
			}
			if (!physicalOutcome) throw lastCandidateError;
			await assertRescanOperationLease(deps, userId, operationKey, executionToken);
			const completedAt = new Date();
			const completed = await deps.prisma.libraryCleanupMediaServerScan.updateMany({
				where: { id: { in: targetIds }, status: "triggering", executionToken },
				data: {
					status: physicalOutcome,
					executionToken: null,
					triggeredAt: completedAt,
					lastError: null,
					nextAttemptAt: null,
				},
			});
			if (completed.count !== claimedTargets.length) {
				throw new Error("Media-server scan ownership changed before terminal recording");
			}
			if (physicalOutcome === "triggered") {
				triggered += completed.count;
				triggeredOperationKeys.add(operationKey);
			} else skipped += completed.count;
			terminalOperationOutcomes.set(operationKey, physicalOutcome);
		} catch (error) {
			if (error instanceof ProviderExecutionAuthorityChangedError) {
				providerAuthorityFailed = true;
			}
			if (upstreamDispatchStarted || physicalOutcome !== null) {
				preserveLeaseForAmbiguousDispatch = true;
				const message =
					physicalOutcome === "skipped"
						? "The media-server scan was verified as unnecessary, but that result could not be recorded. arr-dashboard will re-verify it after the database lease expires without repeating the cleanup deletion."
						: "The media-server scan may have completed, but its result could not be recorded. arr-dashboard will safely reissue the idempotent scan after the database lease expires without repeating the cleanup deletion.";
				warnings.push(message);
				deps.log.warn(
					{ err: error, scanId: scan.id, service: scan.service },
					"Cleanup media-server scan dispatch has an ambiguous durable outcome",
				);
				continue;
			}
			const ownedTargets = await deps.prisma.libraryCleanupMediaServerScan.findMany({
				where: { status: "triggering", executionToken },
				select: { id: true, approvalId: true, attemptCount: true },
			});
			for (const target of ownedTargets) affectedApprovalIds.add(target.approvalId);
			failed += ownedTargets.length;
			const message = isRescanService(scan.service as ServiceInstance["service"])
				? genericScanError(scan.service as RescanService)
				: "Media-server library scan request failed; arr-dashboard will retry it without repeating the cleanup deletion.";
			warnings.push(message);
			await recordDatabaseScanFailure(
				deps,
				ownedTargets.map((target) => target.id),
				executionToken,
				message,
				Math.max(1, ...ownedTargets.map((target) => target.attemptCount)),
			).catch((persistError) => {
				deps.log.error(
					{ err: persistError, scanId: scan.id },
					"Media-server scan failure state could not be recorded",
				);
			});
			deps.log.warn(
				{ err: error, scanId: scan.id, service: scan.service },
				"Cleanup deletion completed but its media-server scan request failed",
			);
		} finally {
			if (!preserveLeaseForAmbiguousDispatch) {
				await releaseRescanOperationLease(deps, userId, operationKey, executionToken).catch(
					(error) => {
						deps.log.warn(
							{ err: error, operationKey },
							"Media-server scan operation lease will be reclaimed after its stale timeout",
						);
					},
				);
			}
		}
		if (providerAuthorityFailed) break;
	}

	if (scans.length === 0) affectedApprovalIds.add(approvalId);
	if (claimed > 0 || affectedApprovalIds.size > 0) {
		const approvalDelegate = (
			deps.prisma as unknown as {
				libraryCleanupApproval: {
					findMany?: CleanupExecutorDeps["prisma"]["libraryCleanupApproval"]["findMany"];
				};
			}
		).libraryCleanupApproval;
		const affectedApprovals = approvalDelegate.findMany
			? await approvalDelegate.findMany({
					where: { id: { in: [...affectedApprovalIds] }, config: { userId }, status: "executed" },
				})
			: affectedApprovalIds.has(approval.id)
				? [approval]
				: [];
		for (const affectedApproval of affectedApprovals) {
			const finalTargets = await deps.prisma.libraryCleanupMediaServerScan.findMany({
				where: { approvalId: affectedApproval.id },
				select: { status: true, attemptCount: true },
			});
			await recordFinalRescanState(
				deps,
				affectedApproval,
				finalTargets,
				"media-server rescan outcome",
			);
		}
	}

	return {
		targets: scans.length,
		triggered,
		skipped,
		failed,
		warnings: [...new Set(warnings)],
		triggeredOperationKeys: [...triggeredOperationKeys],
		terminalOperationOutcomes: [...terminalOperationOutcomes].map(([operationKey, outcome]) => ({
			operationKey,
			outcome,
		})),
		providerAuthorityFailed,
	};
}

/**
 * Claim every currently eligible job for each physical server/media operation.
 * The database lease prevents concurrent workers from issuing the same refresh.
 */
export async function triggerCoalescedMediaServerRescans(
	deps: CleanupExecutorDeps,
	userId: string,
	approvalIds: string[],
): Promise<MediaServerRescanResult> {
	const uniqueApprovalIds = [...new Set(approvalIds)].sort();
	if (uniqueApprovalIds.length === 0) {
		return { targets: 0, triggered: 0, failed: 0, warnings: [] };
	}
	const terminalRows = await deps.prisma.libraryCleanupMediaServerScan.findMany({
		where: {
			approvalId: { in: uniqueApprovalIds },
			status: { in: ["triggered", "skipped"] },
			approval: { config: { userId }, status: "executed" },
		},
		select: { approvalId: true, status: true },
	});
	for (const approvalId of new Set(
		terminalRows
			.filter((row) => row.status === "triggered" || row.status === "skipped")
			.map((row) => row.approvalId),
	)) {
		const approvalTargets = await deps.prisma.libraryCleanupMediaServerScan.findMany({
			where: { approvalId },
			select: { status: true },
		});
		if (
			approvalTargets.length > 0 &&
			approvalTargets.every(
				(target) => target.status === "triggered" || target.status === "skipped",
			)
		) {
			await triggerMediaServerRescansForApproval(deps, userId, approvalId);
		}
	}
	const pendingCandidates = await deps.prisma.libraryCleanupMediaServerScan.findMany({
		where: {
			approvalId: { in: uniqueApprovalIds },
			...candidateScanWhere(),
			approval: { config: { userId }, status: "executed" },
		},
		orderBy: [{ mediaType: "asc" }, { approvalId: "asc" }, { targetKey: "asc" }],
	});
	const pending = await filterDatabaseEligibleScans(deps, pendingCandidates);
	const representativeByOperation = new Map<string, string>();
	for (const scan of pending) {
		const operationKey = rescanOperationKey(scan);
		if (!representativeByOperation.has(operationKey)) {
			representativeByOperation.set(operationKey, scan.approvalId);
		}
	}
	const combined: MediaServerRescanResult = {
		targets: pending.length,
		triggered: 0,
		skipped: 0,
		failed: 0,
		warnings: [],
		triggeredOperationKeys: [],
	};
	const triggeredOperationKeys = new Set<string>();
	for (const representativeApprovalId of new Set(representativeByOperation.values())) {
		const result = await triggerMediaServerRescansForApproval(
			deps,
			userId,
			representativeApprovalId,
		);
		combined.triggered += result.triggered;
		combined.skipped = (combined.skipped ?? 0) + (result.skipped ?? 0);
		combined.failed += result.failed;
		if (result.providerAuthorityFailed) combined.providerAuthorityFailed = true;
		combined.warnings.push(...result.warnings);
		for (const { operationKey, outcome } of result.terminalOperationOutcomes ?? []) {
			if (outcome === "triggered") triggeredOperationKeys.add(operationKey);
		}
		if (result.providerAuthorityFailed) break;
	}
	combined.warnings = [...new Set(combined.warnings)];
	combined.triggeredOperationKeys = [...triggeredOperationKeys];
	return combined;
}

/** Retry pending ancillary scan work without touching ARR deletion state. */
export async function retryPendingMediaServerRescans(
	deps: CleanupExecutorDeps,
	userId: string,
): Promise<MediaServerRescanResult> {
	const scanDelegate = (
		deps.prisma as unknown as {
			libraryCleanupMediaServerScan?: {
				findMany?: CleanupExecutorDeps["prisma"]["libraryCleanupMediaServerScan"]["findMany"];
			};
		}
	).libraryCleanupMediaServerScan;
	if (typeof scanDelegate?.findMany !== "function") {
		return { targets: 0, triggered: 0, failed: 0, warnings: [] };
	}
	const candidates = await scanDelegate.findMany({
		where: {
			approval: { config: { userId }, status: "executed" },
			status: { in: ["pending", "failed", "triggering", "triggered", "skipped"] },
		},
		select: { id: true, approvalId: true, status: true, nextAttemptAt: true },
		orderBy: { approvalId: "asc" },
	});
	const eligibleWork = await filterDatabaseEligibleScans(
		deps,
		candidates.filter((row) => row.status !== "triggered" && row.status !== "skipped"),
	);
	const pending = [
		...candidates.filter((row) => row.status === "triggered" || row.status === "skipped"),
		...eligibleWork,
	];
	return await triggerCoalescedMediaServerRescans(deps, userId, [
		...new Set(pending.map(({ approvalId }) => approvalId)),
	]);
}

/** Retry ancillary scan work for every owner, independent of cleanup enablement or due time. */
export async function retryAllPendingMediaServerRescans(
	deps: CleanupExecutorDeps,
): Promise<MediaServerRescanResult> {
	const scanDelegate = (
		deps.prisma as unknown as {
			libraryCleanupMediaServerScan?: {
				findMany?: CleanupExecutorDeps["prisma"]["libraryCleanupMediaServerScan"]["findMany"];
			};
		}
	).libraryCleanupMediaServerScan;
	if (typeof scanDelegate?.findMany !== "function") {
		return { targets: 0, triggered: 0, failed: 0, warnings: [] };
	}
	const candidates = await scanDelegate.findMany({
		where: {
			approval: { status: "executed" },
			status: { in: ["pending", "failed", "triggering", "triggered", "skipped"] },
		},
		select: {
			id: true,
			status: true,
			nextAttemptAt: true,
			approval: { select: { config: { select: { userId: true } } } },
		},
	});
	const eligibleWork = await filterDatabaseEligibleScans(
		deps,
		candidates.filter((row) => row.status !== "triggered" && row.status !== "skipped"),
	);
	const pending = [
		...candidates.filter((row) => row.status === "triggered" || row.status === "skipped"),
		...eligibleWork,
	];
	const userIds = [
		...new Set(pending.map((row) => row.approval.config.userId).filter(Boolean)),
	].sort();
	const combined: MediaServerRescanResult = {
		targets: 0,
		triggered: 0,
		skipped: 0,
		failed: 0,
		warnings: [],
	};
	for (const userId of userIds) {
		const result = await retryPendingMediaServerRescans(deps, userId);
		combined.targets += result.targets;
		combined.triggered += result.triggered;
		combined.skipped = (combined.skipped ?? 0) + (result.skipped ?? 0);
		combined.failed += result.failed;
		combined.warnings.push(...result.warnings);
	}
	combined.warnings = [...new Set(combined.warnings)];
	return combined;
}

export function rescanMediaType(itemType: string): RescanMediaType {
	return itemType === "movie" ? "movie" : "show";
}
