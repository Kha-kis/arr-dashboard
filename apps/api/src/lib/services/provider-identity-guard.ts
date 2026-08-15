import type { FastifyBaseLogger } from "fastify";
import type { Prisma, PrismaClient } from "../prisma.js";
import {
	readProviderIdentity,
	type DecryptedOwnedServiceSnapshot,
	type ProviderIdentityObservation,
	type ProviderIdentityService,
} from "./service-identity.js";

type GuardPrisma = Pick<PrismaClient, "$transaction">;

/** A provider connection already scoped to the current authenticated owner. */
export type OwnedProviderPublicationSnapshot = DecryptedOwnedServiceSnapshot & {
	id: string;
	userId: string;
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

	const postgresql = isPostgresqlDatabase();
	return await prisma.$transaction(
		async (tx) => {
			if (postgresql) {
				await tx.$queryRawUnsafe(
					'SELECT "id" FROM "ServiceInstance" WHERE "id" = $1 FOR UPDATE',
					instance.id,
				);
			}
			const current = await tx.serviceInstance.findFirst({
				where: providerPublicationPredicate(instance),
			});
			if (!current) {
				throw new ProviderIdentityGuardError(
					"PUBLICATION_SUPERSEDED",
					"Provider cache publication was superseded by a service change.",
				);
			}
			return await publish(tx, snapshot);
		},
		postgresql
			? transactionOptions(options)
			: { isolationLevel: "Serializable", ...transactionOptions(options) },
	);
}

/** Legacy null provenance remains displayable but cannot authorize cleanup. */
export function hasAuthoritativeProviderCacheGeneration(
	row: { connectionGeneration: number | null; identityGeneration: number | null } | null,
	authority: Pick<OwnedProviderPublicationSnapshot, "connectionGeneration" | "identityGeneration">,
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

function assertVerified(instance: OwnedProviderPublicationSnapshot): void {
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
	await prisma.$transaction(async (tx) => {
		await tx.serviceInstance.updateMany({
			where: providerPublicationPredicate(instance),
			data: { identityStatus: "MISMATCH", identityLastCheckedAt: (now ?? (() => new Date()))() },
		});
	});
	throw new ProviderIdentityGuardError(
		"IDENTITY_MISMATCH",
		"Provider identity changed; cache publication was not attempted.",
	);
}

function providerPublicationPredicate(instance: OwnedProviderPublicationSnapshot) {
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
