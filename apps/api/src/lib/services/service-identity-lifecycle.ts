import {
	confirmProviderIdentity,
	type ProviderIdentityObservation,
	type ProviderIdentityService,
} from "./service-identity.js";
import type { PrismaClientInstance } from "../prisma.js";

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
		expectedIdentity: string | null;
		identityStatus: string;
		identityGeneration: number;
	},
	observation: ProviderIdentityObservation,
	now: Date = new Date(),
) {
	const alreadyVerified =
		current.identityStatus === "VERIFIED" && current.expectedIdentity === observation.rawIdentity;
	return {
		expectedIdentity: observation.rawIdentity,
		identityKind: toPersistedIdentityKind(observation.identityKind),
		identityStatus: "VERIFIED" as const,
		identityGeneration: alreadyVerified
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
	await prisma.plexCache.deleteMany({ where: { instanceId } });
	await prisma.plexEpisodeCache.deleteMany({ where: { instanceId } });
	await prisma.tautulliCache.deleteMany({ where: { instanceId } });
	await prisma.jellyfinCache.deleteMany({ where: { instanceId } });
	await prisma.jellyfinEpisodeCache.deleteMany({ where: { instanceId } });
	await prisma.cacheRefreshStatus.deleteMany({ where: { instanceId } });
}

const NONTERMINAL_APPROVAL_STATUSES: string[] = [
	"pending",
	"approved",
	"retry_pending",
	"executing",
	"retry_executing",
] as const;

type ApprovalReplacementPrisma = Pick<PrismaClientInstance, "libraryCleanupApproval">;

/**
 * Pre-provenance approvals cannot establish that they are unrelated, so a
 * replacement expires them conservatively. Future provider-evidence snapshots
 * are narrowed to the exact replaced instance and identity generation.
 */
export async function expireApprovalsForProviderReplacement(
	prisma: ApprovalReplacementPrisma,
	userId: string,
	instanceId: string,
	connectionGeneration: number,
	identityGeneration: number,
): Promise<void> {
	const approvals = await prisma.libraryCleanupApproval.findMany({
		where: { config: { userId }, status: { in: NONTERMINAL_APPROVAL_STATUSES } },
		select: { id: true, status: true, safetySnapshot: true },
	});
	for (const approval of approvals) {
		if (
			!approvalReferencesReplacedProvider(
				approval.safetySnapshot,
				instanceId,
				connectionGeneration,
				identityGeneration,
			)
		) {
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

function approvalReferencesReplacedProvider(
	safetySnapshot: string | null,
	instanceId: string,
	connectionGeneration: number,
	identityGeneration: number,
): boolean {
	if (!safetySnapshot) return true;
	try {
		const parsed: unknown = JSON.parse(safetySnapshot);
		if (typeof parsed !== "object" || parsed === null) return true;
		const providerEvidence = (parsed as { providerEvidence?: unknown }).providerEvidence;
		if (!Array.isArray(providerEvidence)) return true;
		return providerEvidence.some(
			(evidence) =>
				typeof evidence === "object" &&
				evidence !== null &&
				(evidence as { instanceId?: unknown }).instanceId === instanceId &&
				(evidence as { connectionGeneration?: unknown }).connectionGeneration ===
					connectionGeneration &&
				(evidence as { identityGeneration?: unknown }).identityGeneration === identityGeneration,
		);
	} catch {
		return true;
	}
}
