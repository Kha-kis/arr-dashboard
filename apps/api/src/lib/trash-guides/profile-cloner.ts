/**
 * Quality Profile Cloner Service
 *
 * Fetches complete quality profile data from *arr instances
 * and creates templates with full profile settings
 */

import type { PrismaClient } from "@prisma/client";
import type { Encryptor } from "../auth/encryption.js";
import type { CompleteQualityProfile } from "@arr/shared";
import { ArrApiClient, type ApiError, type QualityProfile, type QualityProfileItem } from "./arr-api-client.js";

/**
 * Recursively find quality by ID in quality profile items
 * Quality profiles have nested structure where groups contain items
 */
function findQualityById(items: QualityProfileItem[], targetId: number): { id: number; name: string } | undefined {
	for (const item of items) {
		// Check if this item's quality matches
		if (item.quality?.id === targetId) {
			return { id: item.quality.id, name: item.quality.name };
		}
		// Check if this item has an id that matches (for groups)
		if (item.id === targetId && item.name) {
			return { id: item.id, name: item.name };
		}
		// Recursively check nested items (quality groups)
		if (item.items && Array.isArray(item.items)) {
			// Cast to QualityProfileItem[] for recursive call
			const found = findQualityById(item.items as unknown as QualityProfileItem[], targetId);
			if (found) return found;
		}
	}
	return undefined;
}

interface QualityProfileImportOptions {
	instanceId: string;
	profileId: number;
	userId: string;
}

interface QualityProfileImportResult {
	success: boolean;
	profile?: CompleteQualityProfile;
	error?: string;
}

export class ProfileCloner {
	constructor(
		private prisma: PrismaClient,
		private encryptor: Encryptor,
	) {}

	/**
	 * Helper to create an ArrApiClient for an instance
	 * Validates that the instance belongs to the specified user
	 */
	private async getClientForInstance(
		instanceId: string,
		userId: string,
	): Promise<{ client: ArrApiClient; instanceLabel: string } | { error: string }> {
		if (!userId) {
			return { error: "User ID is required" };
		}

		const instance = await this.prisma.serviceInstance.findFirst({
			where: { id: instanceId, userId },
		});

		if (!instance) {
			return { error: "Instance not found" };
		}

		const apiKey = this.encryptor.decrypt({
			value: instance.encryptedApiKey,
			iv: instance.encryptionIv,
		});
		const baseUrl = instance.baseUrl?.replace(/\/$/, "") || "";

		if (!baseUrl || !apiKey) {
			return { error: "Instance credentials incomplete" };
		}

		const client = new ArrApiClient({
			id: instance.id,
			baseUrl,
			apiKey,
			service: instance.service as "RADARR" | "SONARR",
		});

		return { client, instanceLabel: instance.label };
	}

	/**
	 * Fetch complete quality profile data from *arr instance
	 */
	async importQualityProfile(
		options: QualityProfileImportOptions,
	): Promise<QualityProfileImportResult> {
		try {
			const { instanceId, profileId, userId } = options;

			// Get ArrApiClient for instance (validates user ownership)
			const clientResult = await this.getClientForInstance(instanceId, userId);
			if ("error" in clientResult) {
				return { success: false, error: clientResult.error };
			}

			// Fetch quality profile using ArrApiClient
			const profileData = await clientResult.client.getQualityProfile(profileId);

			// Resolve cutoff quality name from items if not directly available
			let cutoffQuality = profileData.cutoffQuality;
			if (!cutoffQuality && profileData.cutoff && profileData.items) {
				cutoffQuality = findQualityById(profileData.items, profileData.cutoff);
			}

			// Transform to CompleteQualityProfile format
			const completeProfile: CompleteQualityProfile = {
				sourceInstanceId: instanceId,
				sourceInstanceLabel: clientResult.instanceLabel,
				sourceProfileId: profileData.id,
				sourceProfileName: profileData.name,
				importedAt: new Date().toISOString(),

				upgradeAllowed: profileData.upgradeAllowed ?? true,
				cutoff: profileData.cutoff,
				cutoffQuality,

				items: profileData.items || [],

				minFormatScore: profileData.minFormatScore ?? 0,
				cutoffFormatScore: profileData.cutoffFormatScore ?? 0,
				minUpgradeFormatScore: profileData.minUpgradeFormatScore,

				language: profileData.language,
				languages: profileData.languages,
			};

			return {
				success: true,
				profile: completeProfile,
			};
		} catch (error) {
			console.error("Failed to import quality profile:", error);
			const apiError = error as ApiError;
			return {
				success: false,
				error: apiError.message || (error instanceof Error ? error.message : "Unknown error"),
			};
		}
	}

	/**
	 * Deploy complete quality profile to *arr instance
	 * Creates a new profile or updates existing one
	 */
	async deployCompleteProfile(
		instanceId: string,
		userId: string,
		profile: CompleteQualityProfile,
		customFormats: Array<{ trash_id: string; score: number }>,
		options: {
			profileName: string;
			existingProfileId?: number; // If provided, update instead of create
		},
	): Promise<{
		success: boolean;
		profileId?: number;
		error?: string;
	}> {
		try {
			// Get ArrApiClient for instance (validates user ownership)
			const clientResult = await this.getClientForInstance(instanceId, userId);
			if ("error" in clientResult) {
				return { success: false, error: clientResult.error };
			}
			const client = clientResult.client;

			// Fetch custom formats from instance to map trash_ids to instance IDs
			const instanceCFs = await client.getCustomFormats();

			// Map trash_ids to instance custom format IDs
			// Prefer exact trash_id match, fall back to name match if trash_id is absent
			const formatItems = customFormats
				.map((cf) => {
					const instanceCF = instanceCFs.find((icf) => {
						// First try exact trash_id match if the instance CF has one
						if (icf.trash_id) {
							return icf.trash_id === cf.trash_id;
						}
						// Fall back to name match only if trash_id is absent
						return icf.name === cf.trash_id;
					});
					if (!instanceCF) return null;

					return {
						format: instanceCF.id,
						score: cf.score,
					};
				})
				.filter(Boolean);

			// Build quality profile payload
			const profilePayload = {
				name: options.profileName,
				upgradeAllowed: profile.upgradeAllowed,
				cutoff: profile.cutoff,
				items: profile.items,
				minFormatScore: profile.minFormatScore,
				cutoffFormatScore: profile.cutoffFormatScore,
				minUpgradeFormatScore: profile.minUpgradeFormatScore,
				formatItems,
				language: profile.language,
			};

			// Create or update profile
			let deployedProfile: QualityProfile;
			if (options.existingProfileId) {
				deployedProfile = await client.updateQualityProfile(
					options.existingProfileId,
					// biome-ignore lint/suspicious/noExplicitAny: ARR API accepts partial payload with id
					{ id: options.existingProfileId, ...profilePayload } as any,
				);
			} else {
				// biome-ignore lint/suspicious/noExplicitAny: ARR API accepts partial payload for creation
				deployedProfile = await client.createQualityProfile(profilePayload as any);
			}

			return {
				success: true,
				profileId: deployedProfile.id,
			};
		} catch (error) {
			console.error("Failed to deploy complete profile:", error);
			const apiError = error as ApiError;
			return {
				success: false,
				error: apiError.message || (error instanceof Error ? error.message : "Unknown error"),
			};
		}
	}

	/**
	 * Preview what will be deployed
	 */
	async previewProfileDeployment(
		instanceId: string,
		userId: string,
		profile: CompleteQualityProfile,
		customFormats: Array<{ trash_id: string; score: number }>,
	): Promise<{
		success: boolean;
		preview?: {
			profileName: string;
			qualityDefinitions: {
				cutoff: string;
				upgradeAllowed: boolean;
				totalQualities: number;
				allowedQualities: number;
			};
			customFormats: {
				total: number;
				matched: number;
				unmatched: string[];
			};
			formatScores: {
				minScore: number;
				cutoffScore: number;
				avgScore: number;
			};
		};
		error?: string;
	}> {
		try {
			// Get ArrApiClient for instance (validates user ownership)
			const clientResult = await this.getClientForInstance(instanceId, userId);
			if ("error" in clientResult) {
				return { success: false, error: clientResult.error };
			}

			// Fetch custom formats using ArrApiClient
			const instanceCFs = await clientResult.client.getCustomFormats();

			// Match custom formats - prefer trash_id match, fall back to name match
			const matchesCF = (icf: { trash_id?: string; name: string }, trashId: string) => {
				if (icf.trash_id) {
					return icf.trash_id === trashId;
				}
				return icf.name === trashId;
			};

			const matched = customFormats.filter((cf) =>
				instanceCFs.some((icf) => matchesCF(icf, cf.trash_id)),
			);

			const unmatched = customFormats
				.filter(
					(cf) => !instanceCFs.some((icf) => matchesCF(icf, cf.trash_id)),
				)
				.map((cf) => cf.trash_id);

			// Calculate quality stats
			const totalQualities = profile.items.length;
			const allowedQualities = profile.items.filter((item) => item.allowed).length;

			// Find cutoff quality name
			const cutoffQuality = profile.cutoffQuality?.name || "Unknown";

			// Calculate score stats
			const scores = customFormats.map((cf) => cf.score);
			const avgScore =
				scores.length > 0
					? scores.reduce((a, b) => a + b, 0) / scores.length
					: 0;

			return {
				success: true,
				preview: {
					profileName: profile.sourceProfileName,
					qualityDefinitions: {
						cutoff: cutoffQuality,
						upgradeAllowed: profile.upgradeAllowed,
						totalQualities,
						allowedQualities,
					},
					customFormats: {
						total: customFormats.length,
						matched: matched.length,
						unmatched,
					},
					formatScores: {
						minScore: profile.minFormatScore,
						cutoffScore: profile.cutoffFormatScore,
						avgScore: Math.round(avgScore),
					},
				},
			};
		} catch (error) {
			const apiError = error as ApiError;
			return {
				success: false,
				error: apiError.message || (error instanceof Error ? error.message : "Unknown error"),
			};
		}
	}
}

export function createProfileCloner(
	prisma: PrismaClient,
	encryptor: Encryptor,
): ProfileCloner {
	return new ProfileCloner(prisma, encryptor);
}
