/**
 * Quality Profile Cloner Service
 *
 * Fetches complete quality profile data from *arr instances
 * and creates templates with full profile settings
 */

import type { PrismaClient } from "@prisma/client";
import type { CompleteQualityProfile } from "@arr/shared";
import type { SonarrClient, RadarrClient } from "arr-sdk";
import type { ArrClientFactory } from "../arr/client-factory.js";

// SDK type aliases
type SdkQualityProfile = Awaited<ReturnType<SonarrClient["qualityProfile"]["getById"]>>;
type SdkQualityProfileItem = NonNullable<SdkQualityProfile["items"]>[number];
type SdkCustomFormat = Awaited<ReturnType<SonarrClient["customFormat"]["getAll"]>>[number];

/**
 * Recursively find quality by ID in quality profile items
 * Quality profiles have nested structure where groups contain items
 */
function findQualityById(items: SdkQualityProfileItem[], targetId: number): { id: number; name: string } | undefined {
	for (const item of items) {
		// Check if this item's quality matches
		if (item.quality?.id === targetId && item.quality.name) {
			return { id: item.quality.id, name: item.quality.name };
		}
		// Check if this item has an id that matches (for groups)
		if (item.id === targetId && item.name) {
			return { id: item.id, name: item.name };
		}
		// Recursively check nested items (quality groups)
		if (item.items && Array.isArray(item.items)) {
			const found = findQualityById(item.items as SdkQualityProfileItem[], targetId);
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
		private clientFactory: ArrClientFactory,
	) {}

	/**
	 * Helper to get an SDK client for an instance
	 * Validates that the instance belongs to the specified user
	 */
	private async getClientForInstance(
		instanceId: string,
		userId: string,
	): Promise<{ client: SonarrClient | RadarrClient; instanceLabel: string } | { error: string }> {
		if (!userId) {
			return { error: "User ID is required" };
		}

		const instance = await this.prisma.serviceInstance.findFirst({
			where: { id: instanceId, userId },
		});

		if (!instance) {
			return { error: "Instance not found" };
		}

		if (!instance.baseUrl || !instance.encryptedApiKey) {
			return { error: "Instance credentials incomplete" };
		}

		const client = this.clientFactory.create(instance) as SonarrClient | RadarrClient;

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

			// Get SDK client for instance (validates user ownership)
			const clientResult = await this.getClientForInstance(instanceId, userId);
			if ("error" in clientResult) {
				return { success: false, error: clientResult.error };
			}

			// Fetch quality profile using SDK
			const profileData = await clientResult.client.qualityProfile.getById(profileId);

			// Resolve cutoff quality name from items if not directly available
			let cutoffQuality: { id: number; name: string } | undefined;
			if (profileData.cutoff && profileData.items) {
				cutoffQuality = findQualityById(profileData.items as SdkQualityProfileItem[], profileData.cutoff);
			}

			// Transform to CompleteQualityProfile format
			// Cast to any for property access since Sonarr/Radarr have slightly different schemas
			const profileDataAny = profileData as any;
			const completeProfile: CompleteQualityProfile = {
				sourceInstanceId: instanceId,
				sourceInstanceLabel: clientResult.instanceLabel,
				sourceProfileId: profileData.id ?? 0,
				sourceProfileName: profileData.name || "Unknown",
				importedAt: new Date().toISOString(),

				upgradeAllowed: profileData.upgradeAllowed ?? true,
				cutoff: profileData.cutoff ?? 0,
				cutoffQuality,

				items: (profileData.items || []) as any[],

				minFormatScore: profileData.minFormatScore ?? 0,
				cutoffFormatScore: profileData.cutoffFormatScore ?? 0,
				minUpgradeFormatScore: profileData.minUpgradeFormatScore,

				// Sonarr has language/languages, Radarr doesn't - access via any
				language: profileDataAny.language,
				languages: profileDataAny.languages,
			};

			return {
				success: true,
				profile: completeProfile,
			};
		} catch (error) {
			console.error("Failed to import quality profile:", error);
			return {
				success: false,
				error: error instanceof Error ? error.message : "Unknown error",
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
			// Get SDK client for instance (validates user ownership)
			const clientResult = await this.getClientForInstance(instanceId, userId);
			if ("error" in clientResult) {
				return { success: false, error: clientResult.error };
			}
			const client = clientResult.client;

			// Fetch custom formats from instance to map trash_ids to instance IDs
			const instanceCFs = await client.customFormat.getAll();

			// Map trash_ids to instance custom format IDs
			// Match by trash_id only (cf only contains trash_id and score)
			// Note: SDK CFs don't have trash_id property, check specifications
			const formatItems = customFormats
				.map((cf) => {
					const instanceCF = instanceCFs.find((icf) => this.extractTrashId(icf) === cf.trash_id);
					if (!instanceCF || instanceCF.id === undefined) return null;

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
			// Use any for return type since Sonarr/Radarr have different quality profile schemas
			let deployedProfile: { id?: number };
			if (options.existingProfileId) {
				deployedProfile = await client.qualityProfile.update(
					options.existingProfileId,
					{ id: options.existingProfileId, ...profilePayload } as any,
				) as any;
			} else {
				deployedProfile = await client.qualityProfile.create(profilePayload as any) as any;
			}

			return {
				success: true,
				profileId: deployedProfile.id,
			};
		} catch (error) {
			console.error("Failed to deploy complete profile:", error);
			return {
				success: false,
				error: error instanceof Error ? error.message : "Unknown error",
			};
		}
	}

	/**
	 * Extract trash_id from a custom format's specifications
	 */
	private extractTrashId(cf: SdkCustomFormat): string | null {
		for (const spec of cf.specifications || []) {
			if (spec.fields && Array.isArray(spec.fields)) {
				const trashIdField = spec.fields.find((f) => f.name === 'trash_id');
				if (trashIdField) {
					return String(trashIdField.value);
				}
			}
		}
		return null;
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
			// Get SDK client for instance (validates user ownership)
			const clientResult = await this.getClientForInstance(instanceId, userId);
			if ("error" in clientResult) {
				return { success: false, error: clientResult.error };
			}

			// Fetch custom formats using SDK
			const instanceCFs = await clientResult.client.customFormat.getAll();

			// Match custom formats - prefer trash_id match (from specs), fall back to name match
			const matchesCF = (icf: SdkCustomFormat, trashId: string) => {
				const icfTrashId = this.extractTrashId(icf);
				if (icfTrashId) {
					return icfTrashId === trashId;
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
			return {
				success: false,
				error: error instanceof Error ? error.message : "Unknown error",
			};
		}
	}
}

export function createProfileCloner(
	prisma: PrismaClient,
	clientFactory: ArrClientFactory,
): ProfileCloner {
	return new ProfileCloner(prisma, clientFactory);
}
