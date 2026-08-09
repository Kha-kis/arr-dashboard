import type { RadarrClient, SonarrClient } from "arr-sdk";
import { createUpstreamResourceStateToken } from "./deployment-target.js";

type ArrClient = SonarrClient | RadarrClient;

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
		if (state.action === "created" && state.status === "pending") {
			const listed = await client.customFormat.getAll();
			if (!listed.some((format) => format.name === state.name)) return "noop";
		}
		throw new Error(`Custom Format "${state.name}" may have been created, but its ID is unknown.`);
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
			state.beforeFormat &&
			currentToken === createUpstreamResourceStateToken(state.beforeFormat)
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
		const referencingProfiles = profiles.filter((profile) =>
			profile.formatItems?.some((item) => item.format === state.resourceId),
		);
		if (referencingProfiles.length > 0) {
			throw new Error(
				`Custom Format "${state.name}" is referenced by quality profile(s) ${referencingProfiles
					.map((profile) => `"${profile.name ?? profile.id ?? "Unknown"}"`)
					.join(", ")} and was not deleted.`,
			);
		}
		await client.customFormat.delete(state.resourceId);
		return "deleted";
	}

	if (!state.beforeFormat) {
		throw new Error(`Custom Format "${state.name}" is missing its pre-deployment state.`);
	}
	if (currentToken === createUpstreamResourceStateToken(state.beforeFormat)) return "noop";
	if (currentToken !== verifiedPostStateToken) {
		throw new Error(
			`Custom Format "${state.name}" changed after deployment and was not overwritten.`,
		);
	}
	await client.customFormat.update(
		state.resourceId,
		// biome-ignore lint/suspicious/noExplicitAny: Sonarr/Radarr Custom Format types are runtime-compatible
		state.beforeFormat as any,
	);
	return "restored";
}
