import type { RadarrClient, SonarrClient } from "arr-sdk";
import { createQualityProfileStateToken } from "./deployment-target.js";

type ArrProfileClient = SonarrClient | RadarrClient;

export interface QualityProfileRollbackState {
	beforeProfile: Record<string, unknown> | null;
	action: "created" | "updated";
	profileId: number | null;
	profileName?: string | null;
	status: "pending" | "applied";
	postStateToken: string | null;
	intendedPostStateToken?: string | null;
}

/**
 * Roll back only the exact quality-profile state written by a deployment.
 * A matching pre-deployment state is treated as an idempotent retry.
 */
export async function rollbackQualityProfileDeployment(
	client: ArrProfileClient,
	state: QualityProfileRollbackState,
): Promise<void> {
	if (state.profileId === null) {
		if (state.action === "created" && state.status === "pending" && state.profileName) {
			const currentProfiles = await client.qualityProfile.getAll();
			if (!currentProfiles.some((profile) => profile.name === state.profileName)) return;
		}
		throw new Error("A quality profile may have been created, but its ID is unknown.");
	}
	const currentProfiles = await client.qualityProfile.getAll();
	const currentProfile = currentProfiles.find((profile) => profile.id === state.profileId);
	let verifiedPostStateToken = state.postStateToken;
	if (state.status === "pending") {
		if (!currentProfile) {
			if (state.action === "created") return;
			throw new Error("The quality profile to restore no longer exists.");
		}
		const fullCurrent = await client.qualityProfile.getById(state.profileId);
		const currentStateToken = createQualityProfileStateToken(fullCurrent);
		if (
			state.action === "updated" &&
			state.beforeProfile &&
			currentStateToken === createQualityProfileStateToken(state.beforeProfile)
		) {
			return;
		}
		if (state.postStateToken && currentStateToken === state.postStateToken) {
			verifiedPostStateToken = state.postStateToken;
		} else if (state.intendedPostStateToken && currentStateToken === state.intendedPostStateToken) {
			verifiedPostStateToken = state.intendedPostStateToken;
		} else {
			throw new Error(
				"The quality profile has an unverified deployment state and was not changed.",
			);
		}
	}
	if (!verifiedPostStateToken) {
		throw new Error("The quality profile is missing its verified post-write state.");
	}

	if (state.action === "created") {
		if (!currentProfile) {
			return;
		}
		const fullCurrent = await client.qualityProfile.getById(state.profileId);
		if (createQualityProfileStateToken(fullCurrent) !== verifiedPostStateToken) {
			throw new Error("The created quality profile changed after deployment and was not deleted.");
		}
		await client.qualityProfile.delete(state.profileId);
		return;
	}

	if (!currentProfile || !state.beforeProfile) {
		throw new Error("The quality profile to restore no longer exists.");
	}
	const fullCurrent = await client.qualityProfile.getById(state.profileId);
	const currentStateToken = createQualityProfileStateToken(fullCurrent);
	if (currentStateToken === createQualityProfileStateToken(state.beforeProfile)) {
		return;
	}
	if (currentStateToken !== verifiedPostStateToken) {
		throw new Error("The quality profile changed after deployment and was not overwritten.");
	}
	await client.qualityProfile.update(
		state.profileId,
		// biome-ignore lint/suspicious/noExplicitAny: Sonarr/Radarr profile types are runtime-compatible
		state.beforeProfile as any,
	);
}
