import type { FastifyBaseLogger } from "fastify";
import type { Prisma, PrismaClient, ServiceInstance } from "../prisma.js";
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

export type ProviderIdentityGuardCode =
	| "IDENTITY_UNVERIFIED"
	| "IDENTITY_UNAVAILABLE"
	| "IDENTITY_MISMATCH"
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

export type ProviderIdentityGuardOptions = {
	now?: () => Date;
	maxWait?: number;
	timeout?: number;
};

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
	const before = await observeIdentity(instance, log);
	await ensureExpectedIdentity(prisma, instance, before, options.now);

	const snapshot = await collect();
	const after = await observeIdentity(instance, log);
	await ensureExpectedIdentity(prisma, instance, after, options.now);

	const publication = await withCurrentProviderPublicationAuthority(
		prisma,
		instance,
		async (tx) => await publish(tx, snapshot),
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
	return await prisma.$transaction(
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
			if (!cleanupAuthority || cleanupAuthority.runClaimToken !== null) {
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
): Promise<ProviderIdentityObservation> {
	try {
		return await readProviderIdentity(instance, log);
	} catch {
		throw new ProviderIdentityGuardError(
			"IDENTITY_UNAVAILABLE",
			"Provider identity could not be read; cache publication was not attempted.",
		);
	}
}

async function ensureExpectedIdentity(
	prisma: GuardPrisma,
	instance: OwnedProviderPublicationSnapshot,
	observation: ProviderIdentityObservation,
	now: (() => Date) | undefined,
): Promise<void> {
	if (
		observation.service === instance.service &&
		observation.rawIdentity === instance.expectedIdentity
	) {
		return;
	}
	const mismatch = await withCurrentProviderPublicationAuthority(prisma, instance, async (tx) =>
		tx.serviceInstance.updateMany({
			where: providerPublicationPredicate(instance),
			data: { identityStatus: "MISMATCH", identityLastCheckedAt: (now ?? (() => new Date()))() },
		}),
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
