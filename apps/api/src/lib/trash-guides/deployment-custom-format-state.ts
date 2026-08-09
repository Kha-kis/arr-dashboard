import type { RadarrClient, SonarrClient } from "arr-sdk";
import { z } from "zod";
import { createUpstreamResourceStateToken } from "./deployment-target.js";

type ArrClient = SonarrClient | RadarrClient;
const restorableCustomFormatSchema = z.looseObject({
	id: z.number().int().positive().safe(),
	name: z.string().min(1),
	specifications: z.array(z.unknown()),
	includeCustomFormatWhenRenaming: z.boolean().nullable(),
});

export interface CustomFormatRollbackState {
	beforeFormat: Record<string, unknown> | null;
	action: "created" | "updated";
	resourceId: number | null;
	name: string;
	status: "pending" | "applied";
	postStateToken: string | null;
	intendedPostStateToken?: string | null;
}

/**
 * Roll back only an exact Custom Format mutation made by this deployment.
 * Unknown writes fail closed; an already-restored state is an idempotent success.
 */
export async function rollbackCustomFormatDeployment(
	client: ArrClient,
	state: CustomFormatRollbackState,
): Promise<"noop" | "restored" | "deleted"> {
	if (state.resourceId === null) {
		throw new Error(`Custom Format "${state.name}" may have been created, but its ID is unknown.`);
	}
	let beforeFormat: Record<string, unknown> | null = null;
	if (state.action === "updated") {
		const parsed = restorableCustomFormatSchema.safeParse(state.beforeFormat);
		if (!parsed.success || parsed.data.id !== state.resourceId) {
			throw new Error(
				`Custom Format "${state.name}" has an incomplete or mismatched pre-deployment state and was not restored.`,
			);
		}
		beforeFormat = parsed.data;
	}

	const listed = await client.customFormat.getAll();
	const listedCurrent = listed.find((format) => format.id === state.resourceId);
	if (!listedCurrent) {
		if (state.action === "created") return "noop";
		throw new Error(`Custom Format "${state.name}" no longer exists.`);
	}
	const current = await client.customFormat.getById(state.resourceId);
	const currentToken = createUpstreamResourceStateToken(current);

	let verifiedPostStateToken = state.postStateToken;
	if (state.status === "pending") {
		if (
			state.action === "updated" &&
			beforeFormat &&
			currentToken === createUpstreamResourceStateToken(beforeFormat)
		) {
			return "noop";
		}
		if (state.postStateToken && currentToken === state.postStateToken) {
			verifiedPostStateToken = state.postStateToken;
		} else if (state.intendedPostStateToken && currentToken === state.intendedPostStateToken) {
			verifiedPostStateToken = state.intendedPostStateToken;
		} else {
			throw new Error(
				`Custom Format "${state.name}" has an unverified deployment state and was not changed.`,
			);
		}
	}

	if (!verifiedPostStateToken) {
		throw new Error(`Custom Format "${state.name}" is missing its verified post-write state.`);
	}
	if (state.action === "created") {
		if (currentToken !== verifiedPostStateToken) {
			throw new Error(
				`Custom Format "${state.name}" changed after deployment and was not deleted.`,
			);
		}
		const profiles = await client.qualityProfile.getAll();
		const referencingProfiles: Array<{ id?: number; name?: string | null }> = [];
		for (const profile of profiles) {
			let formatItems = profile.formatItems;
			if (!Array.isArray(formatItems)) {
				if (!Number.isSafeInteger(profile.id) || (profile.id ?? 0) <= 0) {
					throw new Error(
						`Custom Format "${state.name}" profile references could not be established because a quality profile has no valid ID.`,
					);
				}
				const fullProfile = await client.qualityProfile.getById(profile.id!);
				formatItems = fullProfile.formatItems;
				if (!Array.isArray(formatItems)) {
					throw new Error(
						`Custom Format "${state.name}" profile reference list could not be established for "${profile.name ?? profile.id}".`,
					);
				}
			}
			if (formatItems.some((item) => item.format === state.resourceId)) {
				referencingProfiles.push(profile);
			}
		}
		if (referencingProfiles.length > 0) {
			throw new Error(
				`Custom Format "${state.name}" is referenced by quality profile(s) ${referencingProfiles
					.map((profile) => `"${profile.name ?? profile.id ?? "Unknown"}"`)
					.join(", ")} and was not deleted.`,
			);
		}
		const rechecked = await client.customFormat.getById(state.resourceId);
		if (createUpstreamResourceStateToken(rechecked) !== verifiedPostStateToken) {
			throw new Error(
				`Custom Format "${state.name}" changed after deployment and was not deleted.`,
			);
		}
		throw new Error(
			`Custom Format "${state.name}" cannot be deleted safely because the upstream API has no conditional delete. Verify that it is unused, then remove it manually.`,
		);
	}

	if (!beforeFormat) {
		throw new Error(`Custom Format "${state.name}" is missing its pre-deployment state.`);
	}
	if (currentToken === createUpstreamResourceStateToken(beforeFormat)) return "noop";
	if (currentToken !== verifiedPostStateToken) {
		throw new Error(
			`Custom Format "${state.name}" changed after deployment and was not overwritten.`,
		);
	}
	await client.customFormat.update(
		state.resourceId,
		// biome-ignore lint/suspicious/noExplicitAny: Sonarr/Radarr Custom Format types are runtime-compatible
		beforeFormat as any,
	);
	return "restored";
}
