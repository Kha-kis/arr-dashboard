import type { RadarrClient, SonarrClient } from "arr-sdk";
import { createUpstreamResourceStateToken } from "./deployment-target.js";
import type { TemplateCF } from "./quality-profile-helpers.js";

type ArrClient = SonarrClient | RadarrClient;
type ManagedProfile = {
	id?: number;
	formatItems?: Array<{ format?: number; score?: number }> | null;
};

export interface ManagedCustomFormatIdentity {
	trashId: string;
	name: string;
	resourceId: number;
	stateToken: string;
	profileId: number;
	appliedScore: number;
}

export interface OrphanedManagedCustomFormat {
	trashId: string;
	name: string;
	resourceId: number;
}

export async function captureManagedCustomFormatIdentities(
	client: ArrClient,
	templateCFs: Array<Pick<TemplateCF, "trashId" | "name">>,
	profile: ManagedProfile,
): Promise<ManagedCustomFormatIdentity[]> {
	if (profile.id === undefined) {
		throw new Error("The managed quality profile ID is unavailable");
	}
	const appliedScores = new Map<number, number>();
	for (const item of profile.formatItems ?? []) {
		if (item.format !== undefined && item.score !== undefined) {
			appliedScores.set(item.format, item.score);
		}
	}
	const listed = await client.customFormat.getAll();
	const byName = new Map(
		listed.filter((format) => format.name).map((format) => [format.name!, format]),
	);
	const identities: ManagedCustomFormatIdentity[] = [];
	for (const templateCF of templateCFs) {
		const match = byName.get(templateCF.name);
		if (match?.id === undefined) {
			throw new Error(
				`The deployed Custom Format identity for "${templateCF.name}" could not be captured.`,
			);
		}
		const full = await client.customFormat.getById(match.id);
		identities.push({
			trashId: templateCF.trashId,
			name: templateCF.name,
			resourceId: match.id,
			stateToken: createUpstreamResourceStateToken(full),
			profileId: profile.id,
			appliedScore: appliedScores.get(match.id) ?? 0,
		});
	}
	return identities;
}

export function parseManagedCustomFormatIdentities(
	backupData: string | null | undefined,
): ManagedCustomFormatIdentity[] {
	if (!backupData) return [];
	const parsed = JSON.parse(backupData) as unknown;
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return [];
	const value = (parsed as { managedCustomFormats?: unknown }).managedCustomFormats;
	if (value === undefined) return [];
	return parseManagedCustomFormatIdentityArray(value);
}

function parseManagedCustomFormatIdentityArray(value: unknown): ManagedCustomFormatIdentity[] {
	if (!Array.isArray(value)) throw new Error("Managed Custom Format metadata is invalid");
	return value.map((entry) => {
		if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
			throw new Error("Managed Custom Format identity is invalid");
		}
		const candidate = entry as Partial<ManagedCustomFormatIdentity>;
		if (
			typeof candidate.trashId !== "string" ||
			candidate.trashId.length === 0 ||
			typeof candidate.name !== "string" ||
			candidate.name.length === 0 ||
			typeof candidate.resourceId !== "number" ||
			!Number.isInteger(candidate.resourceId) ||
			candidate.resourceId <= 0 ||
			typeof candidate.stateToken !== "string" ||
			candidate.stateToken.length === 0 ||
			typeof candidate.profileId !== "number" ||
			!Number.isInteger(candidate.profileId) ||
			candidate.profileId <= 0 ||
			typeof candidate.appliedScore !== "number" ||
			!Number.isSafeInteger(candidate.appliedScore)
		) {
			throw new Error("Managed Custom Format identity is incomplete");
		}
		return candidate as ManagedCustomFormatIdentity;
	});
}

export function readPersistedManagedCustomFormatIdentities(
	mapping?: {
		managedCustomFormatsCaptured: boolean;
		managedCustomFormats: string | null;
	} | null,
): ManagedCustomFormatIdentity[] {
	if (!mapping) return [];
	if (!mapping.managedCustomFormatsCaptured || !mapping.managedCustomFormats) {
		throw new Error(
			"The managed Custom Format identity snapshot is unavailable. Unlink and review a fresh deployment before continuing.",
		);
	}
	return parseManagedCustomFormatIdentityArray(JSON.parse(mapping.managedCustomFormats));
}

/** Resolve only removed template formats whose exact upstream identity is unchanged. */
export async function resolveOrphanedManagedCustomFormats(
	client: ArrClient,
	currentTemplateCFs: Array<Pick<TemplateCF, "trashId" | "name">>,
	previousManagedFormats: ManagedCustomFormatIdentity[],
	currentProfile: ManagedProfile | undefined,
): Promise<{ formats: OrphanedManagedCustomFormat[]; warnings: string[] }> {
	const currentTrashIds = new Set(currentTemplateCFs.map((format) => format.trashId));
	const listed = await client.customFormat.getAll();
	const listedIds = new Set(
		listed.flatMap((format) => (format.id === undefined ? [] : [format.id])),
	);
	const formats: OrphanedManagedCustomFormat[] = [];
	const warnings: string[] = [];

	for (const previous of previousManagedFormats) {
		if (currentTrashIds.has(previous.trashId) || !listedIds.has(previous.resourceId)) continue;
		if (currentProfile?.id !== previous.profileId) {
			warnings.push(
				`The previously managed Custom Format "${previous.name}" is associated with a different quality profile, so its score will not be reset automatically.`,
			);
			continue;
		}
		const currentScore =
			currentProfile.formatItems?.find((item) => item.format === previous.resourceId)?.score ?? 0;
		if (currentScore !== previous.appliedScore) {
			warnings.push(
				`The score for previously managed Custom Format "${previous.name}" changed after deployment, so the current score was preserved.`,
			);
			continue;
		}
		const current = await client.customFormat.getById(previous.resourceId);
		if (createUpstreamResourceStateToken(current) !== previous.stateToken) {
			warnings.push(
				`The previously managed Custom Format "${previous.name}" changed identity, so its profile score will not be reset automatically.`,
			);
			continue;
		}
		formats.push({
			trashId: previous.trashId,
			name: previous.name,
			resourceId: previous.resourceId,
		});
	}

	return { formats, warnings };
}
