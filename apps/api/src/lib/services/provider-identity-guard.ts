import type { FastifyBaseLogger } from "fastify";
import {
	withIsolatedRuntimePrismaReadTransaction,
	withIsolatedRuntimePrismaTransaction,
} from "../backup/restore-runtime-client.js";
import type { Prisma, PrismaClient, ServiceInstance } from "../prisma.js";
import { invalidateObservationRunsInTransaction } from "../provider-observation/observation-run-repository.js";
import { withSqliteTransactionWriteIntent } from "../sqlite-transaction-intent.js";
import {
	type DecryptedOwnedServiceSnapshot,
	type ProviderIdentityObservation,
	type ProviderIdentityService,
	readProviderIdentity,
} from "./service-identity.js";

type GuardPrisma = Pick<PrismaClient, "$transaction">;
type PublicationAuthorityResult<T> = { matched: true; value: T } | { matched: false };

/** Exact stored authority from an ownership-scoped service row; contains no plaintext credentials. */
export type ProviderPublicationAuthority = {
	id: string;
	userId: string;
	service: ProviderIdentityService;
	baseUrl: string;
	enabled: boolean;
	encryptedApiKey: string;
	encryptionIv: string;
	encryptedHttpAuthCredentials: string | null;
	httpAuthEncryptionIv: string | null;
	expectedIdentity: string | null;
	identityStatus: "UNVERIFIED" | "VERIFIED" | "MISMATCH";
	connectionGeneration: number;
	identityGeneration: number;
};

/** Stored publication authority plus the plaintext connection needed for live reads. */
export type OwnedProviderPublicationSnapshot = ProviderPublicationAuthority &
	DecryptedOwnedServiceSnapshot;

export function createProviderPublicationAuthority(
	instance: ServiceInstance,
): ProviderPublicationAuthority {
	if (!isProviderIdentityService(instance.service)) {
		throw new Error("Publication authority requires an identity-enforced provider instance");
	}
	return {
		id: instance.id,
		userId: instance.userId,
		service: instance.service,
		baseUrl: instance.baseUrl,
		enabled: instance.enabled,
		encryptedApiKey: instance.encryptedApiKey,
		encryptionIv: instance.encryptionIv,
		encryptedHttpAuthCredentials: instance.encryptedHttpAuthCredentials,
		httpAuthEncryptionIv: instance.httpAuthEncryptionIv,
		expectedIdentity: instance.expectedIdentity,
		identityStatus: instance.identityStatus,
		connectionGeneration: instance.connectionGeneration,
		identityGeneration: instance.identityGeneration,
	};
}

/** Compare every stored field that can grant provider publication authority. */
export function sameProviderPublicationAuthority(
	left: ProviderPublicationAuthority,
	right: ProviderPublicationAuthority,
): boolean {
	return (
		left.id === right.id &&
		left.userId === right.userId &&
		left.service === right.service &&
		left.baseUrl === right.baseUrl &&
		left.enabled === right.enabled &&
		left.encryptedApiKey === right.encryptedApiKey &&
		left.encryptionIv === right.encryptionIv &&
		left.encryptedHttpAuthCredentials === right.encryptedHttpAuthCredentials &&
		left.httpAuthEncryptionIv === right.httpAuthEncryptionIv &&
		left.expectedIdentity === right.expectedIdentity &&
		left.identityStatus === right.identityStatus &&
		left.connectionGeneration === right.connectionGeneration &&
		left.identityGeneration === right.identityGeneration
	);
}

export type ProviderIdentityGuardCode =
	| "IDENTITY_UNVERIFIED"
	| "IDENTITY_UNAVAILABLE"
	| "IDENTITY_MISMATCH"
	| "PUBLICATION_CANCELLED"
	| "PUBLICATION_SUPERSEDED";

/** A safe boundary error: it intentionally contains no endpoint, credential, or raw identity. */
export class ProviderIdentityGuardError extends Error {
	constructor(
		public readonly code: ProviderIdentityGuardCode,
		message: string,
	) {
		super(message);
		this.name = "ProviderIdentityGuardError";
	}
}

export type ProviderPublicationStage =
	| "before-identity-read"
	| "collection"
	| "after-identity-read"
	| "collection-read-admission"
	| "publication-admission"
	| "transaction-publisher-entered"
	| "failure-recording";

export type ProviderIdentityGuardOptions = {
	/** Optional diagnostics only; observer failures cannot affect publication. */
	onStage?: (stage: ProviderPublicationStage) => void;
	/** Cancels read/prepublication admission, never an executing publisher. */
	signal?: AbortSignal;
	/** Internal cleanup lease owner; omitted publications require no active cleanup run. */
	cleanupRunClaimToken?: string;
	now?: () => Date;
	maxWait?: number;
	timeout?: number;
};

/**
 * Validate collected input without reserving the database writer for a no-op
 * publication. This returns no publication authority: the caller must still
 * stage/publish under its own current-generation and claim fences. The normal
 * refresh-attempt admission must already have created its cleanup config.
 */
export async function withGuardedProviderCollection<TSnapshot>(
	prisma: GuardPrisma,
	instance: OwnedProviderPublicationSnapshot,
	log: FastifyBaseLogger,
	collect: () => Promise<TSnapshot>,
	options: ProviderIdentityGuardOptions = {},
): Promise<TSnapshot> {
	assertVerified(instance);
	assertPublicationNotCancelled(options.signal);
	observePublicationStage(options, "before-identity-read");
	const before = await observeIdentity(instance, log, options.signal);
	assertPublicationNotCancelled(options.signal);
	await ensureExpectedIdentity(prisma, instance, before, options);
	assertPublicationNotCancelled(options.signal);
	observePublicationStage(options, "collection");
	const snapshot = await collect().catch((error: unknown) => {
		assertPublicationNotCancelled(options.signal);
		throw error;
	});
	assertPublicationNotCancelled(options.signal);
	observePublicationStage(options, "after-identity-read");
	const after = await observeIdentity(instance, log, options.signal);
	assertPublicationNotCancelled(options.signal);
	await ensureExpectedIdentity(prisma, instance, after, options);
	assertPublicationNotCancelled(options.signal);
	observePublicationStage(options, "collection-read-admission");
	const matched = await withIsolatedRuntimePrismaReadTransaction(
		prisma,
		async (tx) => {
			assertPublicationNotCancelled(options.signal);
			const cleanup = await tx.libraryCleanupConfig.findUnique({
				where: { userId: instance.userId },
				select: { runClaimToken: true },
			});
			if (!cleanup || cleanup.runClaimToken !== (options.cleanupRunClaimToken ?? null))
				return false;
			const current = await tx.serviceInstance.findFirst({
				where: providerPublicationPredicate(instance),
				select: { id: true },
			});
			assertPublicationNotCancelled(options.signal);
			return current !== null;
		},
		{ isolationLevel: "Serializable", ...transactionOptions(options) },
	);
	if (!matched)
		throw new ProviderIdentityGuardError(
			"PUBLICATION_SUPERSEDED",
			"Provider collection was superseded by a service or cleanup change.",
		);
	return snapshot;
}

/**
 * Collect upstream data and publish it only while the exact owned, verified
 * service snapshot that produced it remains current. Callers provide no
 * authority token: this primitive owns both identity observations and the
 * final transaction predicate.
 */
export async function withGuardedProviderPublication<TSnapshot, TResult>(
	prisma: GuardPrisma,
	instance: OwnedProviderPublicationSnapshot,
	log: FastifyBaseLogger,
	collect: () => Promise<TSnapshot>,
	publish: (tx: Prisma.TransactionClient, snapshot: TSnapshot) => Promise<TResult>,
	options: ProviderIdentityGuardOptions = {},
): Promise<TResult> {
	assertVerified(instance);
	assertPublicationNotCancelled(options.signal);
	observePublicationStage(options, "before-identity-read");
	const before = await observeIdentity(instance, log, options.signal);
	assertPublicationNotCancelled(options.signal);
	await ensureExpectedIdentity(prisma, instance, before, options);

	assertPublicationNotCancelled(options.signal);
	observePublicationStage(options, "collection");
	const snapshot = await collect().catch((error: unknown) => {
		assertPublicationNotCancelled(options.signal);
		throw error;
	});
	assertPublicationNotCancelled(options.signal);
	observePublicationStage(options, "after-identity-read");
	const after = await observeIdentity(instance, log, options.signal);
	assertPublicationNotCancelled(options.signal);
	await ensureExpectedIdentity(prisma, instance, after, options);

	assertPublicationNotCancelled(options.signal);
	observePublicationStage(options, "publication-admission");
	const publication = await withCurrentProviderPublicationAuthority(
		prisma,
		instance,
		async (tx) => {
			// Admission and authority reads may have waited. Once entered, the
			// publisher/transaction must be joined and retain its actual result.
			assertPublicationNotCancelled(options.signal);
			observePublicationStage(options, "transaction-publisher-entered");
			return await publish(tx, snapshot);
		},
		options,
	);
	if (!publication.matched) {
		throw new ProviderIdentityGuardError(
			"PUBLICATION_SUPERSEDED",
			"Provider cache publication was superseded by a service change.",
		);
	}
	return publication.value;
}

function observePublicationStage(
	options: ProviderIdentityGuardOptions,
	stage: ProviderPublicationStage,
): void {
	try {
		options.onStage?.(stage);
	} catch {
		// Diagnostics cannot change identity checks, transaction joining, or results.
	}
}

/** Fence a bounded background slice against a live provider replacement. */
export async function verifyLiveProviderIdentity(
	prisma: GuardPrisma,
	instance: ProviderPublicationAuthority,
	readRawIdentity: () => Promise<string>,
	options: ProviderIdentityGuardOptions = {},
): Promise<void> {
	assertVerified(instance);
	let rawIdentity: string;
	try {
		const observed = await readRawIdentity();
		if (typeof observed !== "string" || !observed.trim()) throw new Error("identity unavailable");
		rawIdentity = observed.trim();
	} catch {
		throw new ProviderIdentityGuardError(
			"IDENTITY_UNAVAILABLE",
			"Provider identity could not be read; cache publication was not attempted.",
		);
	}
	await ensureExpectedIdentity(
		prisma,
		instance,
		{ service: instance.service, rawIdentity },
		options,
	);
}

/**
 * Run a status/cache write only while the complete stored publication snapshot
 * remains current. This performs no upstream read, so dependency failures can
 * be recorded without weakening the database authority fence.
 */
export async function withCurrentProviderPublicationAuthority<T>(
	prisma: GuardPrisma,
	instance: ProviderPublicationAuthority,
	action: (tx: Prisma.TransactionClient) => Promise<T>,
	options: ProviderIdentityGuardOptions = {},
): Promise<PublicationAuthorityResult<T>> {
	assertVerified(instance);
	const postgresql = isPostgresqlDatabase();
	return await withSqliteTransactionWriteIntent(() =>
		withIsolatedRuntimePrismaTransaction(
			prisma,
			async (tx) => {
				const cleanupConfig = await tx.libraryCleanupConfig.upsert({
					where: { userId: instance.userId },
					update: {},
					create: { userId: instance.userId },
					select: { id: true },
				});
				if (postgresql) {
					await tx.$queryRawUnsafe(
						'SELECT "id" FROM "library_cleanup_configs" WHERE "id" = $1 FOR UPDATE',
						cleanupConfig.id,
					);
				}
				const cleanupAuthority = await tx.libraryCleanupConfig.findUnique({
					where: { id: cleanupConfig.id },
					select: { runClaimToken: true },
				});
				const expectedRunClaimToken = options.cleanupRunClaimToken ?? null;
				if (!cleanupAuthority || cleanupAuthority.runClaimToken !== expectedRunClaimToken) {
					return { matched: false };
				}
				if (postgresql) {
					await tx.$queryRawUnsafe(
						'SELECT "id" FROM "ServiceInstance" WHERE "id" = $1 FOR UPDATE',
						instance.id,
					);
				}
				const current = await tx.serviceInstance.findFirst({
					where: providerPublicationPredicate(instance),
				});
				if (!current) return { matched: false };
				return { matched: true, value: await action(tx) };
			},
			postgresql
				? transactionOptions(options)
				: { isolationLevel: "Serializable", ...transactionOptions(options) },
		),
	);
}

/** Legacy null provenance remains displayable but cannot authorize cleanup. */
export function hasAuthoritativeProviderCacheGeneration(
	row: { connectionGeneration: number | null; identityGeneration: number | null } | null,
	authority: Pick<ProviderPublicationAuthority, "connectionGeneration" | "identityGeneration">,
): boolean {
	return (
		row?.connectionGeneration !== null &&
		row?.connectionGeneration !== undefined &&
		row.identityGeneration !== null &&
		row.identityGeneration !== undefined &&
		row.connectionGeneration === authority.connectionGeneration &&
		row.identityGeneration === authority.identityGeneration
	);
}

/** Select rows made obsolete by a monotonic cache-affecting connection update. */
export function olderProviderCacheGenerationWhere(
	instanceId: string,
	connectionGeneration: number,
) {
	return { instanceId, connectionGeneration: { lt: connectionGeneration } };
}

function assertVerified(instance: ProviderPublicationAuthority): void {
	if (
		!instance.enabled ||
		instance.identityStatus !== "VERIFIED" ||
		!instance.expectedIdentity ||
		!isProviderIdentityService(instance.service)
	) {
		throw new ProviderIdentityGuardError(
			"IDENTITY_UNVERIFIED",
			"Provider cache publication requires a verified provider identity.",
		);
	}
}

async function observeIdentity(
	instance: OwnedProviderPublicationSnapshot,
	log: FastifyBaseLogger,
	signal?: AbortSignal,
): Promise<ProviderIdentityObservation> {
	try {
		return await readProviderIdentity(instance, log, signal);
	} catch {
		assertPublicationNotCancelled(signal);
		throw new ProviderIdentityGuardError(
			"IDENTITY_UNAVAILABLE",
			"Provider identity could not be read; cache publication was not attempted.",
		);
	}
}

function assertPublicationNotCancelled(signal?: AbortSignal): void {
	if (signal?.aborted)
		throw new ProviderIdentityGuardError(
			"PUBLICATION_CANCELLED",
			"Provider cache publication cancelled.",
		);
}

async function ensureExpectedIdentity(
	prisma: GuardPrisma,
	instance: ProviderPublicationAuthority,
	observation: Pick<ProviderIdentityObservation, "service" | "rawIdentity">,
	options: ProviderIdentityGuardOptions,
): Promise<void> {
	if (
		observation.service === instance.service &&
		observation.rawIdentity === instance.expectedIdentity
	) {
		return;
	}
	const mismatch = await withCurrentProviderPublicationAuthority(
		prisma,
		instance,
		async (tx) => {
			await invalidateObservationRunsInTransaction(tx, { instanceId: instance.id });
			await tx.providerNativeInventoryRun.updateMany({
				where: {
					instanceId: instance.id,
					connectionGeneration: instance.connectionGeneration,
					identityGeneration: instance.identityGeneration,
					activeSlotKey: { not: null },
				},
				data: {
					state: "superseded",
					activeSlotKey: null,
					claimToken: null,
					leaseUntil: null,
					nextAttemptAt: null,
				},
			});
			await tx.cacheRefreshStatus.updateMany({
				where: {
					instanceId: instance.id,
					connectionGeneration: instance.connectionGeneration,
					identityGeneration: instance.identityGeneration,
					lastAttemptResult: { startsWith: "in_progress:" },
				},
				data: {
					lastAttemptResult: "error",
					lastAttemptErrorMessage:
						instance.service === "TAUTULLI" ? "provider_identity_changed" : "identity-changed",
				},
			});
			return await tx.serviceInstance.updateMany({
				where: providerPublicationPredicate(instance),
				data: {
					identityStatus: "MISMATCH",
					identityLastCheckedAt: (options.now ?? (() => new Date()))(),
				},
			});
		},
		options,
	);
	if (!mismatch.matched) {
		throw new ProviderIdentityGuardError(
			"PUBLICATION_SUPERSEDED",
			"Provider cache publication was superseded by a service change.",
		);
	}
	throw new ProviderIdentityGuardError(
		"IDENTITY_MISMATCH",
		"Provider identity changed; cache publication was not attempted.",
	);
}

function providerPublicationPredicate(instance: ProviderPublicationAuthority) {
	return {
		id: instance.id,
		userId: instance.userId,
		service: instance.service,
		enabled: true,
		expectedIdentity: instance.expectedIdentity,
		identityStatus: "VERIFIED" as const,
		connectionGeneration: instance.connectionGeneration,
		identityGeneration: instance.identityGeneration,
		baseUrl: instance.baseUrl,
		encryptedApiKey: instance.encryptedApiKey,
		encryptionIv: instance.encryptionIv,
		encryptedHttpAuthCredentials: instance.encryptedHttpAuthCredentials,
		httpAuthEncryptionIv: instance.httpAuthEncryptionIv,
	};
}

function transactionOptions(options: ProviderIdentityGuardOptions) {
	return {
		...(options.maxWait === undefined ? {} : { maxWait: options.maxWait }),
		...(options.timeout === undefined ? {} : { timeout: options.timeout }),
	};
}

function isProviderIdentityService(service: string): service is ProviderIdentityService {
	return (
		service === "PLEX" || service === "JELLYFIN" || service === "EMBY" || service === "TAUTULLI"
	);
}

function isPostgresqlDatabase(): boolean {
	return /^postgres(ql)?:\/\//i.test(process.env.DATABASE_URL ?? "");
}
