import type { Encryptor } from "../auth/encryption.js";
import { createJellyfinClient, type JellyfinClient } from "../jellyfin/jellyfin-client.js";
import { createPlexClient, type PlexClient } from "../plex/plex-client.js";
import type { LibraryCleanupApproval, PrismaClient, ServiceInstance } from "../prisma.js";
import { getErrorMessage } from "../utils/error-message.js";

export type RescanMediaType = "movie" | "show";
export type RescanService = "PLEX" | "JELLYFIN" | "EMBY";

type PlexRescanClient = Pick<PlexClient, "getIdentity" | "getLibrarySections" | "refreshSection">;
type JellyfinRescanClient = Pick<
	JellyfinClient,
	"getPublicInfo" | "getServerInfo" | "refreshLibrary"
>;

export interface MediaServerRescanDeps {
	prisma: PrismaClient;
	encryptor?: Encryptor;
	log: {
		warn: (bindings: object, message?: string) => void;
		error: (bindings: object, message?: string) => void;
	};
	/** Narrow test seam; production uses the current encrypted client factory. */
	plexRescanClientFactory?: (instance: ServiceInstance) => PlexRescanClient;
	/** Shared Jellyfin/Emby test seam; production uses the current encrypted client factory. */
	jellyfinRescanClientFactory?: (instance: ServiceInstance) => JellyfinRescanClient;
	/** Narrow timing seam for lease-heartbeat concurrency tests. */
	mediaServerRescanLeaseHeartbeatMs?: number;
}

type PreparedTarget = { serverIdentity: string; plannedSectionIds: string | null };

function expectedIdentityKind(service: RescanService): ServiceInstance["identityKind"] {
	switch (service) {
		case "PLEX":
			return "PLEX_MACHINE_IDENTIFIER";
		case "JELLYFIN":
			return "JELLYFIN_SERVER_ID";
		case "EMBY":
			return "EMBY_SERVER_ID";
	}
}

function assertEnrolledIdentity(instance: ServiceInstance): string {
	if (
		!isRescanService(instance.service) ||
		instance.identityStatus !== "VERIFIED" ||
		!instance.expectedIdentity ||
		instance.identityKind !== expectedIdentityKind(instance.service)
	) {
		throw new Error("Media-server identity enrollment is unavailable.");
	}
	return instance.expectedIdentity;
}

function isRescanService(service: ServiceInstance["service"]): service is RescanService {
	return service === "PLEX" || service === "JELLYFIN" || service === "EMBY";
}

function parseSelectedInstanceIds(value: string | null): string[] {
	if (!value) throw new Error("Requested selected media-server targets are invalid.");
	let parsed: unknown;
	try {
		parsed = JSON.parse(value);
	} catch {
		throw new Error("Requested selected media-server targets are invalid.");
	}
	if (
		!Array.isArray(parsed) ||
		parsed.length === 0 ||
		parsed.some((entry) => typeof entry !== "string" || entry.length === 0)
	) {
		throw new Error("Requested selected media-server targets are invalid.");
	}
	const ids = parsed as string[];
	const canonical = [...new Set(ids)].sort();
	if (canonical.length !== ids.length || canonical.some((id, index) => id !== ids[index])) {
		throw new Error("Requested selected media-server targets are invalid.");
	}
	return canonical;
}

function createPlexRescanClient(
	deps: MediaServerRescanDeps,
	instance: ServiceInstance,
): PlexRescanClient {
	const client =
		deps.plexRescanClientFactory?.(instance) ??
		(deps.encryptor ? createPlexClient(deps.encryptor, instance, deps.log as never) : null);
	if (!client) throw new Error("Plex scan client is unavailable.");
	return client;
}

function createJellyfinRescanClient(
	deps: MediaServerRescanDeps,
	instance: ServiceInstance,
): JellyfinRescanClient {
	const client =
		deps.jellyfinRescanClientFactory?.(instance) ??
		(deps.encryptor ? createJellyfinClient(deps.encryptor, instance, deps.log as never) : null);
	if (!client) throw new Error("Jellyfin-compatible scan client is unavailable.");
	return client;
}

async function readPreparedTarget(
	deps: MediaServerRescanDeps,
	instance: ServiceInstance,
	mediaType: RescanMediaType,
): Promise<PreparedTarget> {
	const enrolledIdentity = assertEnrolledIdentity(instance);
	if (instance.service === "PLEX") {
		const client = createPlexRescanClient(deps, instance);
		const identity = await client.getIdentity();
		if (!identity.machineIdentifier || identity.machineIdentifier !== enrolledIdentity) {
			throw new Error("Plex server identity does not match its enrollment.");
		}
		const sectionIds = [
			...new Set(
				(await client.getLibrarySections())
					.filter((section) => section.type === mediaType && Boolean(section.key))
					.map((section) => section.key),
			),
		].sort();
		if (sectionIds.length === 0) {
			throw new Error("Plex section selection is unavailable for this media type.");
		}
		return {
			serverIdentity: `PLEX:${identity.machineIdentifier}`,
			plannedSectionIds: JSON.stringify(sectionIds),
		};
	}
	if (instance.service === "JELLYFIN" || instance.service === "EMBY") {
		const identity = await createJellyfinRescanClient(deps, instance).getPublicInfo();
		if (!identity.id || identity.id !== enrolledIdentity) {
			throw new Error("Media-server identity does not match its enrollment.");
		}
		return { serverIdentity: `${instance.service}:${identity.id}`, plannedSectionIds: null };
	}
	throw new Error("Media-server scan service is unsupported.");
}

/**
 * Persist post-delete scan intent before the first irreversible ARR mutation.
 * No upstream refresh is issued here.
 */
export async function prepareMediaServerRescans(
	deps: MediaServerRescanDeps,
	userId: string,
	approval: LibraryCleanupApproval,
	mediaType: RescanMediaType,
): Promise<number> {
	if (!approval.scanMediaServerAfterDelete) return 0;
	const selectedIds = parseSelectedInstanceIds(approval.scanMediaServerInstanceIds);
	const previouslyPrepared = await deps.prisma.libraryCleanupMediaServerScan.findMany({
		where: { approvalId: approval.id, approval: { config: { userId } } },
		select: {
			instanceId: true,
			service: true,
			serverIdentity: true,
			mediaType: true,
			plannedSectionIds: true,
			targetKey: true,
		},
	});
	const instances = await deps.prisma.serviceInstance.findMany({
		where: {
			id: { in: selectedIds },
			userId,
			enabled: true,
			service: { in: ["PLEX", "JELLYFIN", "EMBY"] },
		},
		orderBy: { id: "asc" },
	});
	if (
		instances.length !== selectedIds.length ||
		instances.some((instance) => !isRescanService(instance.service)) ||
		instances.some((instance) => !selectedIds.includes(instance.id))
	) {
		throw new Error("Requested selected media-server targets could not be verified.");
	}

	const expected = new Map<string, PreparedTarget>();
	for (const instance of instances) {
		const targetKey = `${instance.service}:${instance.id}:${mediaType}`;
		try {
			expected.set(targetKey, await readPreparedTarget(deps, instance, mediaType));
		} catch {
			throw new Error("A requested media-server target could not be verified before cleanup.");
		}
	}

	if (previouslyPrepared.length > 0) {
		const preparedIds = new Set(previouslyPrepared.map((target) => target.instanceId));
		const exactDurableSelection =
			previouslyPrepared.length === selectedIds.length &&
			preparedIds.size === selectedIds.length &&
			selectedIds.every((instanceId) => preparedIds.has(instanceId)) &&
			previouslyPrepared.every((target) => {
				const service = target.service as ServiceInstance["service"];
				if (!isRescanService(service)) return false;
				if (target.mediaType !== mediaType) return false;
				if (target.targetKey !== `${service}:${target.instanceId}:${mediaType}`) return false;
				const liveTarget = expected.get(target.targetKey);
				if (
					!liveTarget ||
					liveTarget.serverIdentity !== target.serverIdentity ||
					liveTarget.plannedSectionIds !== target.plannedSectionIds
				) {
					return false;
				}
				const identityPrefix = `${service}:`;
				if (
					!target.serverIdentity?.startsWith(identityPrefix) ||
					target.serverIdentity.length <= identityPrefix.length
				) {
					return false;
				}
				if (service !== "PLEX") return target.plannedSectionIds === null;
				try {
					parsePlannedSections(target.plannedSectionIds);
					return true;
				} catch {
					return false;
				}
			});
		if (!exactDurableSelection) {
			throw new Error(
				"The durable selected media-server target set changed before cleanup could be retried.",
			);
		}
		return previouslyPrepared.length;
	}

	return await deps.prisma.$transaction(async (tx) => {
		for (const instance of instances) {
			const targetKey = `${instance.service}:${instance.id}:${mediaType}`;
			const target = expected.get(targetKey);
			if (!target) {
				throw new Error("Requested selected media-server targets could not be verified.");
			}
			try {
				await tx.libraryCleanupMediaServerScan.create({
					data: {
						approvalId: approval.id,
						instanceId: instance.id,
						service: instance.service,
						serverIdentity: target.serverIdentity,
						mediaType,
						plannedSectionIds: target.plannedSectionIds,
						targetKey,
					},
				});
			} catch (error) {
				if ((error as { code?: string }).code !== "P2002") throw error;
				const existing = await tx.libraryCleanupMediaServerScan.findUnique({
					where: { approvalId_targetKey: { approvalId: approval.id, targetKey } },
					select: { serverIdentity: true, plannedSectionIds: true },
				});
				if (
					!existing ||
					existing.serverIdentity !== target.serverIdentity ||
					existing.plannedSectionIds !== target.plannedSectionIds
				) {
					throw new Error(
						"A requested media-server target changed before cleanup could be retried.",
					);
				}
			}
		}

		const durable = await tx.libraryCleanupMediaServerScan.findMany({
			where: { approvalId: approval.id },
			select: { targetKey: true, serverIdentity: true, plannedSectionIds: true },
		});
		if (
			durable.length !== expected.size ||
			durable.some((target) => {
				const planned = expected.get(target.targetKey);
				return (
					!planned ||
					planned.serverIdentity !== target.serverIdentity ||
					planned.plannedSectionIds !== target.plannedSectionIds
				);
			})
		) {
			throw new Error(
				"The durable selected media-server target set changed before cleanup could be retried.",
			);
		}
		return durable.length;
	});
}

export function rescanMediaType(itemType: string): RescanMediaType {
	return itemType === "movie" ? "movie" : "show";
}

const RETRY_BASE_MS = 60_000;
const RETRY_MAX_MS = 6 * 60 * 60_000;
const LEASE_STALE_MS = 10 * 60_000;
const LEASE_HEARTBEAT_MS = Math.floor(LEASE_STALE_MS / 3);

export interface MediaServerRescanResult {
	targets: number;
	triggered: number;
	failed: number;
	warnings: string[];
}

type ScanRow = {
	id: string;
	approvalId: string;
	instanceId: string;
	service: string;
	serverIdentity: string | null;
	mediaType: string;
	plannedSectionIds: string | null;
	status: string;
	executionToken: string | null;
	attemptCount: number;
	completedSectionIds: string;
	nextAttemptAt: Date | null;
	requestStartedAt: Date | null;
	updatedAt: Date;
};

function retryAt(attempt: number): Date {
	const exponent = Math.max(0, Math.min(20, attempt - 1));
	return new Date(Date.now() + Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** exponent));
}

function operationKey(scan: ScanRow): string {
	if (!scan.serverIdentity) return `unverified:${scan.id}`;
	if (scan.service === "PLEX") {
		return scan.plannedSectionIds
			? `${scan.serverIdentity}:${scan.mediaType}:${scan.plannedSectionIds}`
			: `unverified:${scan.id}`;
	}
	return `${scan.serverIdentity}:global-library-refresh`;
}

function equivalentOperationWhere(scan: ScanRow) {
	if (!scan.serverIdentity) return { id: scan.id };
	return scan.service === "PLEX"
		? {
				service: scan.service,
				serverIdentity: scan.serverIdentity,
				mediaType: scan.mediaType,
				plannedSectionIds: scan.plannedSectionIds,
			}
		: { service: scan.service, serverIdentity: scan.serverIdentity };
}

function eligibleForAttempt(
	scan: Pick<ScanRow, "status" | "nextAttemptAt" | "updatedAt">,
): boolean {
	if (scan.status === "pending") return true;
	if (scan.status === "failed") return !scan.nextAttemptAt || scan.nextAttemptAt <= new Date();
	if (scan.status === "triggering" || scan.status === "ambiguous") {
		return (
			(!scan.nextAttemptAt || scan.nextAttemptAt <= new Date()) &&
			scan.updatedAt.getTime() <= Date.now() - LEASE_STALE_MS
		);
	}
	return false;
}

function parseCompletedSectionIds(value: string): Set<string> {
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

function parsePlannedSections(value: string | null): string[] {
	if (!value) throw new Error("Plex scan section selection is unavailable.");
	const sectionIds = parseCompletedSectionIds(value);
	const sorted = [...sectionIds].sort();
	if (sorted.length === 0 || JSON.stringify(sorted) !== value) {
		throw new Error("Plex scan section selection is unavailable.");
	}
	return sorted;
}

function leaseStore(deps: MediaServerRescanDeps) {
	return deps.prisma.libraryCleanupMediaServerScanLease;
}

function usesPostgres(): boolean {
	return /^postgres(ql)?:\/\//i.test(process.env.DATABASE_URL ?? "");
}

function rawExecutor(deps: MediaServerRescanDeps) {
	return (
		deps.prisma as unknown as {
			$executeRawUnsafe?: (query: string, ...values: unknown[]) => Promise<number>;
		}
	).$executeRawUnsafe;
}

async function acquireLease(
	deps: MediaServerRescanDeps,
	userId: string,
	key: string,
	token: string,
): Promise<boolean> {
	const executeRaw = rawExecutor(deps);
	if (executeRaw) {
		const inserted = usesPostgres()
			? await executeRaw.call(
					deps.prisma,
					'INSERT INTO "library_cleanup_media_server_scan_leases" ("operationKey", "userId", "executionToken", "createdAt", "updatedAt") VALUES ($1, $2, $3, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP) ON CONFLICT ("operationKey") DO NOTHING',
					key,
					userId,
					token,
				)
			: await executeRaw.call(
					deps.prisma,
					'INSERT OR IGNORE INTO "library_cleanup_media_server_scan_leases" ("operationKey", "userId", "executionToken", "createdAt", "updatedAt") VALUES (?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)',
					key,
					userId,
					token,
				);
		if (inserted === 1) return true;
		return (
			(usesPostgres()
				? await executeRaw.call(
						deps.prisma,
						'UPDATE "library_cleanup_media_server_scan_leases" SET "userId" = $1, "executionToken" = $2, "updatedAt" = CURRENT_TIMESTAMP WHERE "operationKey" = $3 AND "updatedAt" < CURRENT_TIMESTAMP - INTERVAL \'10 minutes\'',
						userId,
						token,
						key,
					)
				: await executeRaw.call(
						deps.prisma,
						'UPDATE "library_cleanup_media_server_scan_leases" SET "userId" = ?, "executionToken" = ?, "updatedAt" = CURRENT_TIMESTAMP WHERE "operationKey" = ? AND julianday("updatedAt") < julianday(\'now\', \'-10 minutes\')',
						userId,
						token,
						key,
					)) === 1
		);
	}
	try {
		await leaseStore(deps).create({ data: { operationKey: key, userId, executionToken: token } });
		return true;
	} catch (error) {
		if ((error as { code?: string }).code !== "P2002") throw error;
		// Test doubles do not expose database SQL. Production lease expiry above is
		// decided by the database clock, not a worker-local timestamp.
		const reclaimed = await leaseStore(deps).updateMany({
			where: { operationKey: key, updatedAt: { lt: new Date(Date.now() - LEASE_STALE_MS) } },
			data: { userId, executionToken: token },
		});
		return reclaimed.count === 1;
	}
}

async function releaseLease(
	deps: MediaServerRescanDeps,
	userId: string,
	key: string,
	token: string,
): Promise<void> {
	await leaseStore(deps).deleteMany({
		where: { operationKey: key, userId, executionToken: token },
	});
}

function startLeaseHeartbeat(
	deps: MediaServerRescanDeps,
	userId: string,
	key: string,
	token: string,
): () => Promise<void> {
	const intervalMs = deps.mediaServerRescanLeaseHeartbeatMs ?? LEASE_HEARTBEAT_MS;
	let stopped = false;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let currentTick: Promise<void> | undefined;

	const schedule = () => {
		if (stopped) return;
		timer = setTimeout(
			() => {
				currentTick = (async () => {
					try {
						const renewed = await leaseStore(deps).updateMany({
							where: { operationKey: key, userId, executionToken: token },
							data: { updatedAt: new Date() },
						});
						if (renewed.count !== 1) {
							deps.log.warn(
								{ operationKey: key },
								"Media-server scan operation lease could not be renewed",
							);
						}
					} catch (error) {
						deps.log.warn(
							{ err: error, operationKey: key },
							"Media-server scan operation lease renewal failed",
						);
					} finally {
						currentTick = undefined;
						schedule();
					}
				})();
			},
			Math.max(1, intervalMs),
		);
	};
	schedule();

	return async () => {
		stopped = true;
		if (timer) clearTimeout(timer);
		await currentTick;
	};
}

async function resolveOwnedInstance(
	deps: MediaServerRescanDeps,
	userId: string,
	scan: ScanRow,
): Promise<ServiceInstance> {
	if (!isRescanService(scan.service as ServiceInstance["service"])) {
		throw new Error("Media-server scan service is unsupported.");
	}
	const instance = await deps.prisma.serviceInstance.findFirst({
		where: {
			id: scan.instanceId,
			userId,
			enabled: true,
			service: scan.service as RescanService,
		},
	});
	if (!instance || !isRescanService(instance.service)) {
		throw new Error("Media-server scan target is no longer owned and enabled.");
	}
	return instance;
}

async function dispatchScan(
	deps: MediaServerRescanDeps,
	userId: string,
	scans: ScanRow[],
	token: string,
	onUpstreamStart: () => void,
): Promise<void> {
	const scan = scans[0];
	if (!scan) throw new Error("Prepared media-server scan is unavailable.");
	const instance = await resolveOwnedInstance(deps, userId, scan);
	if (!scan.serverIdentity) throw new Error("Prepared media-server identity is unavailable.");
	if (instance.service === "PLEX") {
		const client = createPlexRescanClient(deps, instance);
		const planned = parsePlannedSections(scan.plannedSectionIds);
		const inventory = await client.getLibrarySections();
		const inventoryIds = new Set(
			inventory.filter((section) => section.type === scan.mediaType).map((section) => section.key),
		);
		if (planned.some((sectionId) => !inventoryIds.has(sectionId))) {
			throw new Error("Prepared Plex section selection is no longer available.");
		}
		const completedByScan = new Map(
			scans.map((coalescedScan) => [
				coalescedScan.id,
				parseCompletedSectionIds(coalescedScan.completedSectionIds),
			]),
		);
		const completedByEveryScan = new Set(completedByScan.get(scan.id) ?? []);
		for (const coalescedScan of scans.slice(1)) {
			const completed = completedByScan.get(coalescedScan.id) ?? new Set<string>();
			for (const sectionId of completedByEveryScan) {
				if (!completed.has(sectionId)) completedByEveryScan.delete(sectionId);
			}
		}
		for (const sectionId of planned) {
			if (completedByEveryScan.has(sectionId)) continue;
			const identity = await client.getIdentity();
			if (`PLEX:${identity.machineIdentifier}` !== scan.serverIdentity) {
				throw new Error("Live Plex server identity does not match the prepared target.");
			}
			onUpstreamStart();
			await client.refreshSection(sectionId);
			completedByEveryScan.add(sectionId);
			for (const coalescedScan of scans) {
				const completed = completedByScan.get(coalescedScan.id) ?? new Set<string>();
				completed.add(sectionId);
				completedByScan.set(coalescedScan.id, completed);
				const persisted = await deps.prisma.libraryCleanupMediaServerScan.updateMany({
					where: {
						id: { in: [coalescedScan.id] },
						status: "triggering",
						executionToken: token,
					},
					data: { completedSectionIds: JSON.stringify([...completed].sort()) },
				});
				if (persisted.count !== 1) {
					throw new Error("Durable Plex section progress was not recorded for every scan target.");
				}
			}
		}
		return;
	}
	const client = createJellyfinRescanClient(deps, instance);
	const identity = await client.getServerInfo();
	if (`${instance.service}:${identity.id}` !== scan.serverIdentity) {
		throw new Error("Live media-server identity does not match the prepared target.");
	}
	onUpstreamStart();
	await client.refreshLibrary();
}

async function terminalAuditAllowsScan(
	deps: MediaServerRescanDeps,
	userId: string,
	approvalId: string,
): Promise<boolean> {
	const approval = await deps.prisma.libraryCleanupApproval.findFirst({
		where: {
			id: approvalId,
			status: "executed",
			terminalAuditRecordedAt: { not: null },
			config: { userId },
		},
		select: { id: true },
	});
	return approval !== null;
}

async function persistFailure(
	deps: MediaServerRescanDeps,
	rows: ScanRow[],
	token: string,
	status: "failed" | "ambiguous",
	lastError: string,
): Promise<void> {
	const attempt = Math.max(1, ...rows.map((row) => row.attemptCount + 1));
	await deps.prisma.libraryCleanupMediaServerScan.updateMany({
		where: { id: { in: rows.map((row) => row.id) }, status: "triggering", executionToken: token },
		data: {
			status,
			executionToken: null,
			lastError,
			nextAttemptAt: retryAt(attempt),
		},
	});
}

function safeScanFailureMessage(error: unknown, started: boolean): string {
	const message = getErrorMessage(error, "");
	if (message.includes("identity does not match")) {
		return "Media-server identity changed after cleanup was prepared.";
	}
	if (message.includes("no longer owned and enabled")) {
		return "Selected media-server instance is no longer available.";
	}
	if (message.includes("section selection is no longer available")) {
		return "A prepared Plex library section is no longer available.";
	}
	if (message.includes("scan client is unavailable")) {
		return "Media-server scan client is unavailable. Check the selected instance connection.";
	}
	return started
		? "Media-server scan response was not confirmed. Retry is scheduled."
		: "Media-server scan could not start. Check the selected instance connection.";
}

/** Run durable, terminal-audit-gated scan jobs and coalesce equivalent physical operations. */
export async function triggerCoalescedMediaServerRescans(
	deps: MediaServerRescanDeps,
	userId: string,
	approvalIds: string[],
): Promise<MediaServerRescanResult> {
	const wanted = [...new Set(approvalIds)].sort();
	if (wanted.length === 0) return { targets: 0, triggered: 0, failed: 0, warnings: [] };
	const allowed = new Set<string>();
	for (const approvalId of wanted) {
		if (await terminalAuditAllowsScan(deps, userId, approvalId)) allowed.add(approvalId);
	}
	const rows = (await deps.prisma.libraryCleanupMediaServerScan.findMany({
		where: { approvalId: { in: wanted } },
		orderBy: [{ approvalId: "asc" }, { targetKey: "asc" }],
	})) as ScanRow[];
	const eligible = rows.filter((row) => allowed.has(row.approvalId) && eligibleForAttempt(row));
	const groups = new Map<string, ScanRow[]>();
	for (const row of eligible) {
		const key = operationKey(row);
		groups.set(key, [...(groups.get(key) ?? []), row]);
	}
	const result: MediaServerRescanResult = {
		targets: eligible.length,
		triggered: 0,
		failed: 0,
		warnings:
			allowed.size === wanted.length
				? []
				: ["Media-server scan is waiting for the durable cleanup terminal audit."],
	};
	for (const [key, group] of groups) {
		const token = crypto.randomUUID();
		if (!(await acquireLease(deps, userId, key, token))) continue;
		const stopLeaseHeartbeat = startLeaseHeartbeat(deps, userId, key, token);
		let started = false;
		let preserveLease = false;
		let operationRows = group;
		try {
			const coalesced = (await deps.prisma.libraryCleanupMediaServerScan.findMany({
				where: {
					...equivalentOperationWhere(group[0]!),
					status: { in: ["pending", "failed", "triggering", "ambiguous"] },
					approval: {
						status: "executed",
						terminalAuditRecordedAt: { not: null },
						config: { userId },
					},
				},
				orderBy: [{ approvalId: "asc" }, { targetKey: "asc" }],
			})) as ScanRow[];
			operationRows = coalesced.filter(eligibleForAttempt);
			if (operationRows.length === 0) continue;
			const claimed = await deps.prisma.libraryCleanupMediaServerScan.updateMany({
				where: {
					id: { in: operationRows.map((row) => row.id) },
					status: { in: ["pending", "failed", "triggering", "ambiguous"] },
				},
				data: {
					status: "triggering",
					executionToken: token,
					attemptCount: { increment: 1 },
					requestStartedAt: new Date(),
					nextAttemptAt: null,
				},
			});
			if (claimed.count !== operationRows.length) continue;
			await dispatchScan(deps, userId, operationRows, token, () => {
				started = true;
			});
			const completed = await deps.prisma.libraryCleanupMediaServerScan.updateMany({
				where: {
					id: { in: operationRows.map((row) => row.id) },
					status: "triggering",
					executionToken: token,
				},
				data: {
					status: "triggered",
					executionToken: null,
					triggeredAt: new Date(),
					lastError: null,
					nextAttemptAt: null,
				},
			});
			if (completed.count !== operationRows.length) {
				throw new Error("Durable media-server scan completion was not recorded.");
			}
			result.triggered += completed.count;
		} catch (error) {
			const status = started ? "ambiguous" : "failed";
			const lastError = safeScanFailureMessage(error, started);
			deps.log.warn(
				{
					errorType: error instanceof Error ? error.name : "UnknownError",
					failure: lastError,
					scanIds: operationRows.map((row) => row.id),
					service: operationRows[0]?.service,
					status,
				},
				"Media-server scan dispatch failed",
			);
			await persistFailure(deps, operationRows, token, status, lastError);
			result.failed += operationRows.length;
			result.warnings.push(
				started
					? "Media-server scan dispatch is ambiguous and will be retried without repeating cleanup deletion."
					: "Media-server scan failed before dispatch and will be retried without repeating cleanup deletion.",
			);
			preserveLease = started;
		} finally {
			await stopLeaseHeartbeat();
			if (!preserveLease) await releaseLease(deps, userId, key, token);
		}
	}
	return { ...result, warnings: [...new Set(result.warnings)] };
}

/** Retry durable ancillary work only; this function never depends on an ARR client. */
export async function retryPendingMediaServerRescans(
	deps: MediaServerRescanDeps,
	userId: string,
): Promise<MediaServerRescanResult> {
	const rows = (await deps.prisma.libraryCleanupMediaServerScan.findMany({
		where: {
			status: { in: ["pending", "failed", "triggering", "ambiguous"] },
			approval: { config: { userId } },
		},
		select: { approvalId: true },
	})) as Array<{ approvalId: string }>;
	return triggerCoalescedMediaServerRescans(deps, userId, [
		...new Set(rows.map((row) => row.approvalId)),
	]);
}

/**
 * Discover and retry durable ancillary scan work for every owner. This is
 * deliberately independent of cleanup configuration enablement and due time.
 */
export async function retryAllPendingMediaServerRescans(
	deps: MediaServerRescanDeps,
): Promise<MediaServerRescanResult> {
	const rows = (await deps.prisma.libraryCleanupMediaServerScan.findMany({
		where: { status: { in: ["pending", "failed", "triggering", "ambiguous"] } },
		select: {
			id: true,
			approvalId: true,
			status: true,
			nextAttemptAt: true,
			updatedAt: true,
			approval: { select: { config: { select: { userId: true } } } },
		},
	})) as Array<
		Pick<ScanRow, "approvalId" | "id" | "nextAttemptAt" | "status" | "updatedAt"> & {
			approval: { config: { userId: string } };
		}
	>;
	const userIds = [
		...new Set(
			rows
				.filter(eligibleForAttempt)
				.map((row) => row.approval.config.userId)
				.filter(Boolean),
		),
	].sort();
	const combined: MediaServerRescanResult = { targets: 0, triggered: 0, failed: 0, warnings: [] };
	for (const userId of userIds) {
		try {
			const result = await retryPendingMediaServerRescans(deps, userId);
			combined.targets += result.targets;
			combined.triggered += result.triggered;
			combined.failed += result.failed;
			combined.warnings.push(...result.warnings);
		} catch {
			combined.failed += 1;
			combined.warnings.push(
				"Media-server scan recovery could not complete for one owner and will retry without repeating cleanup deletion.",
			);
		}
	}
	return { ...combined, warnings: [...new Set(combined.warnings)] };
}
