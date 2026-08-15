import type { RadarrClient, SonarrClient } from "arr-sdk";
import { z } from "zod";
import { matchesIntendedWritableState } from "./deployment-custom-format-state.js";
import { createQualityProfileStateToken } from "./deployment-target.js";

type ArrProfileClient = SonarrClient | RadarrClient;
const restorableQualitySchema = z.looseObject({
	id: z.number().int().nonnegative().safe(),
	name: z.string().min(1),
});
const restorableQualityProfileItemSchema: z.ZodType = z.lazy(() =>
	z
		.looseObject({
			id: z.number().int().nonnegative().safe().optional(),
			name: z.string().min(1).optional(),
			allowed: z.boolean(),
			quality: restorableQualitySchema.optional(),
			items: z.array(restorableQualityProfileItemSchema),
		})
		.superRefine((item, ctx) => {
			if (!item.quality && item.items.length === 0) {
				ctx.addIssue({
					code: "custom",
					message: "Quality profile item requires a quality or non-empty nested items",
				});
			}
			if (!item.quality && (item.id === undefined || item.name === undefined)) {
				ctx.addIssue({
					code: "custom",
					message: "Quality profile group requires an ID and name",
				});
			}
		}),
);
export const restorableQualityProfileSchema = z.looseObject({
	id: z.number().int().positive().safe(),
	name: z.string().min(1),
	upgradeAllowed: z.boolean(),
	cutoff: z.number().int().nonnegative().safe(),
	items: z.array(restorableQualityProfileItemSchema),
	minFormatScore: z.number().int().safe(),
	cutoffFormatScore: z.number().int().safe(),
	minUpgradeFormatScore: z.number().int().safe(),
	formatItems: z.array(
		z.looseObject({
			format: z.number().int().positive().safe(),
			score: z.number().int().safe(),
		}),
	),
});

export interface QualityProfileRollbackState {
	beforeProfile: Record<string, unknown> | null;
	action: "created" | "updated";
	profileId: number | null;
	profileName?: string | null;
	status: "pending" | "applied";
	postStateToken: string | null;
	intendedPostStateToken?: string | null;
	intendedPostState?: Record<string, unknown> | null;
}

export interface RecoveredQualityProfileIdentity {
	profileId: number;
	postStateToken: string;
}

/**
 * Roll back only the exact quality-profile state written by a deployment.
 * A matching pre-deployment state is treated as an idempotent retry.
 */
export async function rollbackQualityProfileDeployment(
	client: ArrProfileClient,
	state: QualityProfileRollbackState,
	onRecoveredIdentity?: (identity: RecoveredQualityProfileIdentity) => void | Promise<void>,
): Promise<void> {
	let profileId = state.profileId;
	let recoveredPostStateToken: string | null = null;
	const currentProfiles = await client.qualityProfile.getAll();
	if (profileId === null) {
		if (state.action !== "created" || !state.profileName || !state.intendedPostState) {
			throw new Error("A quality profile may have been created, but its ID is unknown.");
		}
		const namedCandidates = currentProfiles.filter(
			(profile) =>
				Number.isSafeInteger(profile.id) &&
				(profile.id ?? 0) > 0 &&
				profile.name === state.profileName,
		);
		const exactCandidates: Array<{ id: number; profile: Record<string, unknown> }> = [];
		for (const candidate of namedCandidates) {
			const fullProfile = await client.qualityProfile.getById(candidate.id!);
			if (matchesIntendedWritableState(fullProfile, state.intendedPostState)) {
				exactCandidates.push({
					id: candidate.id!,
					profile: fullProfile as Record<string, unknown>,
				});
			}
		}
		if (exactCandidates.length !== 1) {
			throw new Error(
				`Quality profile "${state.profileName}" may have been created, but its ID could not be recovered exactly.`,
			);
		}
		profileId = exactCandidates[0]!.id;
		recoveredPostStateToken = createQualityProfileStateToken(exactCandidates[0]!.profile);
		await onRecoveredIdentity?.({ profileId, postStateToken: recoveredPostStateToken });
	}
	let beforeProfile: Record<string, unknown> | null = null;
	if (state.action === "updated") {
		const parsed = restorableQualityProfileSchema.safeParse(state.beforeProfile);
		if (!parsed.success || parsed.data.id !== profileId) {
			throw new Error(
				"The quality profile has an incomplete or mismatched pre-deployment state and was not restored.",
			);
		}
		beforeProfile = parsed.data;
	}
	const currentProfile = currentProfiles.find((profile) => profile.id === profileId);
	let verifiedPostStateToken = state.postStateToken ?? recoveredPostStateToken;
	if (state.status === "pending") {
		if (!currentProfile) {
			if (state.action === "created") return;
			throw new Error("The quality profile to restore no longer exists.");
		}
		const fullCurrent = await client.qualityProfile.getById(profileId);
		const currentStateToken = createQualityProfileStateToken(fullCurrent);
		if (
			state.action === "updated" &&
			beforeProfile &&
			currentStateToken === createQualityProfileStateToken(beforeProfile)
		) {
			return;
		}
		if (state.postStateToken && currentStateToken === state.postStateToken) {
			verifiedPostStateToken = state.postStateToken;
		} else if (state.intendedPostStateToken && currentStateToken === state.intendedPostStateToken) {
			verifiedPostStateToken = state.intendedPostStateToken;
		} else if (
			state.action === "created" &&
			recoveredPostStateToken &&
			currentStateToken === recoveredPostStateToken &&
			state.intendedPostState &&
			matchesIntendedWritableState(fullCurrent, state.intendedPostState)
		) {
			verifiedPostStateToken = recoveredPostStateToken;
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
		const fullCurrent = await client.qualityProfile.getById(profileId);
		if (createQualityProfileStateToken(fullCurrent) !== verifiedPostStateToken) {
			throw new Error("The created quality profile changed after deployment and was not deleted.");
		}
		throw new Error(
			`The created quality profile "${state.profileName ?? profileId}" (ARR ID: ${profileId}) cannot be deleted safely because the upstream API has no conditional delete. Verify that exact ID is unused, then remove it manually.`,
		);
	}

	if (!currentProfile || !beforeProfile) {
		throw new Error("The quality profile to restore no longer exists.");
	}
	const fullCurrent = await client.qualityProfile.getById(profileId);
	const currentStateToken = createQualityProfileStateToken(fullCurrent);
	if (currentStateToken === createQualityProfileStateToken(beforeProfile)) {
		return;
	}
	if (currentStateToken !== verifiedPostStateToken) {
		throw new Error("The quality profile changed after deployment and was not overwritten.");
	}
	throw new Error(
		`The quality profile "${state.profileName ?? profileId}" (ARR ID: ${profileId}) cannot be restored safely because the upstream API has no conditional update. Its current state still matches this deployment; restore the recorded pre-deployment configuration for that exact ID manually.`,
	);
}
