import type { RadarrClient, SonarrClient } from "arr-sdk";
import { z } from "zod";
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
		throw new Error("A quality profile may have been created, but its ID is unknown.");
	}
	let beforeProfile: Record<string, unknown> | null = null;
	if (state.action === "updated") {
		const parsed = restorableQualityProfileSchema.safeParse(state.beforeProfile);
		if (!parsed.success || parsed.data.id !== state.profileId) {
			throw new Error(
				"The quality profile has an incomplete or mismatched pre-deployment state and was not restored.",
			);
		}
		beforeProfile = parsed.data;
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
			beforeProfile &&
			currentStateToken === createQualityProfileStateToken(beforeProfile)
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
		throw new Error(
			"The created quality profile cannot be deleted safely because the upstream API has no conditional delete. Verify that it is unused, then remove it manually.",
		);
	}

	if (!currentProfile || !beforeProfile) {
		throw new Error("The quality profile to restore no longer exists.");
	}
	const fullCurrent = await client.qualityProfile.getById(state.profileId);
	const currentStateToken = createQualityProfileStateToken(fullCurrent);
	if (currentStateToken === createQualityProfileStateToken(beforeProfile)) {
		return;
	}
	if (currentStateToken !== verifiedPostStateToken) {
		throw new Error("The quality profile changed after deployment and was not overwritten.");
	}
	throw new Error(
		"The quality profile cannot be restored safely because the upstream API has no conditional update. Its current state still matches this deployment; restore the recorded pre-deployment configuration manually.",
	);
	const restoredProfile = await client.qualityProfile.getById(state.profileId);
	if (
		createQualityProfileStateToken(restoredProfile) !==
		createQualityProfileStateToken(beforeProfile)
	) {
		throw new Error("The quality profile did not match its pre-deployment state after restore.");
	}
}
