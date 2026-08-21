import {
	confirmProviderIdentity,
	providerIdentityAuthorityFingerprint,
	providerInstanceAuthorityFingerprint,
	type ProviderIdentityObservation,
	type ProviderIdentityService,
} from "./service-identity.js";
import type { PrismaClientInstance } from "../prisma.js";
import { deletePlexCacheRows, deleteProviderCacheStatuses } from "../plex/plex-cache-storage.js";

const PROVIDER_IDENTITY_SERVICES = new Set<ProviderIdentityService>([
	"PLEX",
	"JELLYFIN",
	"EMBY",
	"TAUTULLI",
]);

export function isProviderIdentityService(service: string): service is ProviderIdentityService {
	return PROVIDER_IDENTITY_SERVICES.has(service as ProviderIdentityService);
}

export function initialVerifiedIdentityData(
	observation: ProviderIdentityObservation,
	now: Date = new Date(),
) {
	return {
		expectedIdentity: observation.rawIdentity,
		identityKind: toPersistedIdentityKind(observation.identityKind),
		identityStatus: "VERIFIED" as const,
		identityGeneration: 1,
		identityVerifiedAt: now,
		identityLastCheckedAt: now,
	};
}

export function toSafeIdentityCandidate(observation: ProviderIdentityObservation) {
	return {
		service: observation.service,
		identityKind: observation.identityKind,
		fingerprint: observation.fingerprint,
		...(observation.displayName ? { displayName: observation.displayName } : {}),
		confirmationDigest: observation.confirmationDigest,
	};
}

export function confirmsIdentityCandidate(
	observation: ProviderIdentityObservation,
	confirmationDigest: string,
): boolean {
	return confirmProviderIdentity(confirmationDigest, observation.confirmationDigest);
}

export function verifiedIdentityData(
	current: {
		service: string;
		expectedIdentity: string | null;
		identityStatus: string;
		identityGeneration: number;
	},
	observation: ProviderIdentityObservation,
	now: Date = new Date(),
) {
	const sameEnrolledIdentity = current.expectedIdentity === observation.rawIdentity;
	const preservesIdentityGeneration =
		sameEnrolledIdentity &&
		(current.identityStatus === "VERIFIED" ||
			(current.service === "PLEX" && observation.service === "PLEX"));
	return {
		expectedIdentity: observation.rawIdentity,
		identityKind: toPersistedIdentityKind(observation.identityKind),
		identityStatus: "VERIFIED" as const,
		identityGeneration: preservesIdentityGeneration
			? current.identityGeneration
			: current.identityGeneration + 1,
		identityVerifiedAt: now,
		identityLastCheckedAt: now,
	};
}

export function replacementIdentityData(
	current: { identityGeneration: number },
	observation: ProviderIdentityObservation,
	now: Date = new Date(),
) {
	return {
		expectedIdentity: observation.rawIdentity,
		identityKind: toPersistedIdentityKind(observation.identityKind),
		identityStatus: "VERIFIED" as const,
		identityGeneration: current.identityGeneration + 1,
		identityVerifiedAt: now,
		identityLastCheckedAt: now,
	};
}

type ProviderCacheStatePrisma = {
	plexCache: { deleteMany(args: { where: { instanceId: string } }): Promise<unknown> };
	plexEpisodeCache: { deleteMany(args: { where: { instanceId: string } }): Promise<unknown> };
	tautulliCache: { deleteMany(args: { where: { instanceId: string } }): Promise<unknown> };
	jellyfinCache: { deleteMany(args: { where: { instanceId: string } }): Promise<unknown> };
	jellyfinEpisodeCache: { deleteMany(args: { where: { instanceId: string } }): Promise<unknown> };
	cacheRefreshStatus: { deleteMany(args: { where: { instanceId: string } }): Promise<unknown> };
};

export async function clearDurableProviderCacheState(
	prisma: ProviderCacheStatePrisma,
	instanceId: string,
): Promise<void> {
	await deletePlexCacheRows(prisma as never, instanceId);
	await prisma.tautulliCache.deleteMany({ where: { instanceId } });
	await prisma.jellyfinCache.deleteMany({ where: { instanceId } });
	await prisma.jellyfinEpisodeCache.deleteMany({ where: { instanceId } });
	await deleteProviderCacheStatuses(prisma as never, instanceId);
}

const NONTERMINAL_APPROVAL_STATUSES: string[] = [
	"pending",
	"approved",
	"retry_pending",
	"executing",
	"retry_executing",
] as const;

type ApprovalReplacementPrisma = Pick<PrismaClientInstance, "libraryCleanupApproval">;

export type ProviderReplacementAuthority = {
	service: ProviderIdentityService;
	identityKind: NonNullable<ReturnType<typeof toPersistedIdentityKind> | undefined>;
	identityFingerprint: string;
	instanceFingerprint: string;
	connectionGeneration: number;
	identityGeneration: number;
};

export function createProviderReplacementAuthority(instance: {
	id: string;
	service: string;
	identityKind: string | null;
	expectedIdentity: string | null;
	connectionGeneration: number;
	identityGeneration: number;
}): ProviderReplacementAuthority | null {
	if (
		!isProviderIdentityService(instance.service) ||
		instance.identityKind === null ||
		instance.expectedIdentity === null
	) {
		return null;
	}
	return {
		service: instance.service,
		identityKind: instance.identityKind as ProviderReplacementAuthority["identityKind"],
		identityFingerprint: providerIdentityAuthorityFingerprint(instance),
		instanceFingerprint: providerInstanceAuthorityFingerprint(instance.id),
		connectionGeneration: instance.connectionGeneration,
		identityGeneration: instance.identityGeneration,
	};
}

/**
 * Pre-provenance approvals cannot establish that they are unrelated, so a
 * replacement expires them conservatively. Future provider-evidence snapshots
 * are narrowed to the exact replaced instance and identity generation.
 */
export async function expireApprovalsForProviderReplacement(
	prisma: ApprovalReplacementPrisma,
	userId: string,
	authority: ProviderReplacementAuthority,
): Promise<void> {
	const approvals = await prisma.libraryCleanupApproval.findMany({
		where: { config: { userId }, status: { in: NONTERMINAL_APPROVAL_STATUSES } },
		select: { id: true, status: true, safetySnapshot: true },
	});
	for (const approval of approvals) {
		if (!(await approvalReferencesReplacedProvider(approval.safetySnapshot, authority))) {
			continue;
		}
		await prisma.libraryCleanupApproval.updateMany({
			where: { id: approval.id, config: { userId }, status: approval.status },
			data: {
				status: "expired",
				lastExecutionError: "Provider identity was replaced; a new cleanup approval is required.",
			},
		});
	}
}

export function toPersistedIdentityKind(
	identityKind: ProviderIdentityObservation["identityKind"],
): "PLEX_MACHINE_IDENTIFIER" | "JELLYFIN_SERVER_ID" | "EMBY_SERVER_ID" | "TAUTULLI_PMS_IDENTIFIER" {
	switch (identityKind) {
		case "plex-machine-identifier":
			return "PLEX_MACHINE_IDENTIFIER";
		case "jellyfin-server-id":
			return "JELLYFIN_SERVER_ID";
		case "emby-server-id":
			return "EMBY_SERVER_ID";
		case "tautulli-pms-identifier":
			return "TAUTULLI_PMS_IDENTIFIER";
	}
}

async function approvalReferencesReplacedProvider(
	safetySnapshot: string | null,
	authority: ProviderReplacementAuthority,
): Promise<boolean> {
	if (!safetySnapshot) return true;
	const { parseExecutableSafetyEnvelope } = await import(
		"../library-cleanup/shared-plex-safety.js"
	);
	const envelope = parseExecutableSafetyEnvelope(safetySnapshot);
	if (!envelope) return true;
	return envelope.providerEvidence.sources.some((source) => {
		const exactInstance =
			source.instanceFingerprint === undefined ||
			source.instanceFingerprint === authority.instanceFingerprint;
		return (
			exactInstance &&
			source.service === authority.service &&
			source.identityKind === authority.identityKind &&
			source.identityFingerprint === authority.identityFingerprint &&
			source.connectionGeneration === authority.connectionGeneration &&
			source.identityGeneration === authority.identityGeneration
		);
	});
}
