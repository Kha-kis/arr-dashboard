/**
 * Quality Profile Cloner Service
 *
 * Fetches complete quality profile data from *arr instances
 * and creates templates with full profile settings
 */

import type { PrismaClient } from "@prisma/client";
import type { Encryptor } from "../auth/encryption.js";
import type { CompleteQualityProfile } from "@arr/shared";

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
	 * Fetch complete quality profile data from *arr instance
	 */
	async importQualityProfile(
		options: QualityProfileImportOptions,
	): Promise<QualityProfileImportResult> {
		try {
			const { instanceId, profileId, userId } = options;

			// Get instance configuration
			const instance = await this.prisma.serviceInstance.findFirst({
				where: {
					id: instanceId,
				},
			});

			if (!instance) {
				return {
					success: false,
					error: "Instance not found or access denied",
				};
			}

			// Decrypt API key
			const apiKey = this.encryptor.decrypt({
				value: instance.encryptedApiKey,
				iv: instance.encryptionIv,
			});
			const baseUrl = instance.baseUrl?.replace(/\/$/, "") || "";

			if (!baseUrl || !apiKey) {
				return {
					success: false,
					error: "Instance credentials incomplete",
				};
			}

			// Fetch quality profile from *arr API
			const profileUrl = `${baseUrl}/api/v3/qualityprofile/${profileId}`;
			const response = await fetch(profileUrl, {
				headers: {
					"X-Api-Key": apiKey,
					Accept: "application/json",
				},
			});

			if (!response.ok) {
				return {
					success: false,
					error: `Failed to fetch profile: ${response.statusText}`,
				};
			}

			const profileData = await response.json();

			// Transform to CompleteQualityProfile format
			const completeProfile: CompleteQualityProfile = {
				sourceInstanceId: instanceId,
				sourceProfileId: profileData.id,
				sourceProfileName: profileData.name,
				importedAt: new Date().toISOString(),

				upgradeAllowed: profileData.upgradeAllowed ?? true,
				cutoff: profileData.cutoff,
				cutoffQuality: profileData.cutoffQuality,

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
			// Get instance configuration
			const instance = await this.prisma.serviceInstance.findFirst({
				where: {
					id: instanceId,
				},
			});

			if (!instance) {
				return {
					success: false,
					error: "Instance not found or access denied",
				};
			}

			// Decrypt API key
			const apiKey = this.encryptor.decrypt({
				value: instance.encryptedApiKey,
				iv: instance.encryptionIv,
			});
			const baseUrl = instance.baseUrl?.replace(/\/$/, "") || "";

			if (!baseUrl || !apiKey) {
				return {
					success: false,
					error: "Instance credentials incomplete",
				};
			}

			// Fetch custom formats from instance to map trash_ids to instance IDs
			const cfsUrl = `${baseUrl}/api/v3/customformat`;
			const cfsResponse = await fetch(cfsUrl, {
				headers: {
					"X-Api-Key": apiKey,
					Accept: "application/json",
				},
			});

			if (!cfsResponse.ok) {
				return {
					success: false,
					error: "Failed to fetch custom formats from instance",
				};
			}

			const instanceCFs = await cfsResponse.json();

			// Map trash_ids to instance custom format IDs
			const formatItems = customFormats
				.map((cf) => {
					const instanceCF = instanceCFs.find(
						(icf: any) =>
							icf.name === cf.trash_id || icf.name.includes(cf.trash_id),
					);
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
			const method = options.existingProfileId ? "PUT" : "POST";
			const url = options.existingProfileId
				? `${baseUrl}/api/v3/qualityprofile/${options.existingProfileId}`
				: `${baseUrl}/api/v3/qualityprofile`;

			const deployResponse = await fetch(url, {
				method,
				headers: {
					"X-Api-Key": apiKey,
					"Content-Type": "application/json",
					Accept: "application/json",
				},
				body: JSON.stringify(profilePayload),
			});

			if (!deployResponse.ok) {
				const errorText = await deployResponse.text();
				return {
					success: false,
					error: `Failed to deploy profile: ${deployResponse.statusText} - ${errorText}`,
				};
			}

			const deployedProfile = await deployResponse.json();

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
			// Get instance to fetch custom formats
			const instance = await this.prisma.serviceInstance.findFirst({
				where: {
					id: instanceId,
				},
			});

			if (!instance) {
				return {
					success: false,
					error: "Instance not found",
				};
			}

			const apiKey = this.encryptor.decrypt({
				value: instance.encryptedApiKey,
				iv: instance.encryptionIv,
			});
			const baseUrl = instance.baseUrl?.replace(/\/$/, "") || "";

			// Fetch custom formats
			const cfsUrl = `${baseUrl}/api/v3/customformat`;
			const cfsResponse = await fetch(cfsUrl, {
				headers: {
					"X-Api-Key": apiKey,
					Accept: "application/json",
				},
			});

			if (!cfsResponse.ok) {
				return {
					success: false,
					error: "Failed to fetch custom formats",
				};
			}

			const instanceCFs = await cfsResponse.json();

			// Match custom formats
			const matched = customFormats.filter((cf) =>
				instanceCFs.some(
					(icf: any) =>
						icf.name === cf.trash_id || icf.name.includes(cf.trash_id),
				),
			);

			const unmatched = customFormats
				.filter(
					(cf) =>
						!instanceCFs.some(
							(icf: any) =>
								icf.name === cf.trash_id || icf.name.includes(cf.trash_id),
						),
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
	encryptor: Encryptor,
): ProfileCloner {
	return new ProfileCloner(prisma, encryptor);
}
