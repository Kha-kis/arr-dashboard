/**
 * Quality Profile Cloner Service
 *
 * Fetches complete quality profile data from *arr instances
 * and creates templates with full profile settings
 */

import type { CompleteQualityProfile } from "@arr/shared";
import type { RadarrClient, SonarrClient } from "arr-sdk";
import { dequal as deepEqual } from "dequal";
import type { PrismaClient } from "../../lib/prisma.js";
import type { ArrClientFactory } from "../arr/client-factory.js";
import { loggers } from "../logger.js";
import { getErrorMessage } from "../utils/error-message.js";

const log = loggers.trashGuides;

// SDK type aliases
type SdkQualityProfile = Awaited<ReturnType<SonarrClient["qualityProfile"]["getById"]>>;
type SdkQualityProfileItem = NonNullable<SdkQualityProfile["items"]>[number];
type SdkCustomFormat = Awaited<ReturnType<SonarrClient["customFormat"]["getAll"]>>[number];

type OwnedClient = {
	client: SonarrClient | RadarrClient;
	instanceLabel: string;
	service: "SONARR" | "RADARR";
};
const reviewAdvice =
	"Refresh and review the cloned profile, or use the normal template-deployment flow.";
const isPositiveSafeId = (value: unknown): value is number =>
	typeof value === "number" && Number.isSafeInteger(value) && value > 0;

function canonical(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(canonical);
	if (value && typeof value === "object") {
		const record = value as Record<string, unknown>;
		return Object.fromEntries(
			Object.keys(record)
				.sort()
				.map((key) => [key, canonical(record[key])]),
		);
	}
	return value;
}

/** Complete content comparison, not the recommendation matcher's fuzzy score.
 * Object/field/spec order is immaterial; extra fields and nested values remain.
 */
function normalizedSpecifications(value: unknown): unknown[] | null {
	if (!Array.isArray(value)) return null;
	const normalized: unknown[] = [];
	for (const item of value) {
		if (!item || typeof item !== "object") return null;
		const spec = item as Record<string, unknown>;
		if (
			typeof spec.name !== "string" ||
			typeof spec.implementation !== "string" ||
			(spec.negate !== undefined && typeof spec.negate !== "boolean") ||
			(spec.required !== undefined && typeof spec.required !== "boolean") ||
			!Array.isArray(spec.fields)
		)
			return null;
		const names = new Set<string>();
		for (const field of spec.fields) {
			if (
				!field ||
				typeof field !== "object" ||
				typeof field.name !== "string" ||
				!Object.hasOwn(field, "value") ||
				names.has(field.name)
			)
				return null;
			names.add(field.name);
		}
		const fields = spec.fields
			.map(canonical)
			.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
		normalized.push(
			canonical({
				...spec,
				negate: spec.negate ?? false,
				required: spec.required ?? false,
				fields,
			}),
		);
	}
	return normalized.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
}

function sameDefinition(source: SdkCustomFormat, target: SdkCustomFormat): boolean {
	if (source.name !== target.name) return false;
	for (const cf of [source, target]) {
		if (
			cf.includeCustomFormatWhenRenaming != null &&
			typeof cf.includeCustomFormatWhenRenaming !== "boolean"
		)
			return false;
	}
	if (
		(source.includeCustomFormatWhenRenaming ?? false) !==
		(target.includeCustomFormatWhenRenaming ?? false)
	)
		return false;
	const sourceSpecs = normalizedSpecifications(source.specifications),
		targetSpecs = normalizedSpecifications(target.specifications);
	return sourceSpecs !== null && targetSpecs !== null && deepEqual(sourceSpecs, targetSpecs);
}

/**
 * Recursively find quality by ID in quality profile items
 * Quality profiles have nested structure where groups contain items
 */
function findQualityById(
	items: SdkQualityProfileItem[],
	targetId: number,
): { id: number; name: string } | undefined {
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
	): Promise<OwnedClient | { error: string }> {
		if (!userId) {
			return { error: "User ID is required" };
		}

		const instance = await this.prisma.serviceInstance.findFirst({
			where: { id: instanceId, userId },
		});

		if (!instance) {
			return { error: "Instance not found" };
		}
		if (!instance.enabled || (instance.service !== "SONARR" && instance.service !== "RADARR")) {
			return { error: "Clone profiles require an enabled Sonarr or Radarr instance" };
		}

		if (!instance.baseUrl || !instance.encryptedApiKey) {
			return { error: "Instance credentials incomplete" };
		}

		const client = this.clientFactory.create(instance) as SonarrClient | RadarrClient;

		return { client, instanceLabel: instance.label, service: instance.service };
	}

	/** Both preview and execution resolve again from current owned live inputs. */
	private async resolveCustomFormats(
		target: OwnedClient,
		userId: string,
		profile: CompleteQualityProfile,
		selections: Array<{ trash_id: string; score: number }>,
	): Promise<{ formatItems: Array<{ format: number; score: number }>; unmatched: string[] }> {
		if (!profile.sourceInstanceId || !isPositiveSafeId(profile.sourceProfileId))
			throw new Error(`Invalid clone source identity. ${reviewAdvice}`);
		const source = await this.getClientForInstance(profile.sourceInstanceId, userId);
		if ("error" in source) throw new Error(`Clone source: ${source.error}. ${reviewAdvice}`);
		if (source.service !== target.service)
			throw new Error(`Clone source and target service types differ. ${reviewAdvice}`);
		const [liveProfile, sourceFormats, targetFormats] = await Promise.all([
			source.client.qualityProfile.getById(profile.sourceProfileId),
			source.client.customFormat.getAll(),
			target.client.customFormat.getAll(),
		]);
		if (!isPositiveSafeId(liveProfile.id) || liveProfile.id !== profile.sourceProfileId)
			throw new Error(`Clone source profile identity changed. ${reviewAdvice}`);
		for (const formats of [sourceFormats, targetFormats]) {
			const ids = new Set<number>();
			for (const cf of formats) {
				if (!isPositiveSafeId(cf.id) || ids.has(cf.id))
					throw new Error(`Invalid or duplicate live Custom Format identity. ${reviewAdvice}`);
				ids.add(cf.id);
			}
		}
		const profileIds = new Set<number>();
		for (const item of liveProfile.formatItems ?? []) {
			if (
				!isPositiveSafeId(item.format) ||
				profileIds.has(item.format) ||
				!Number.isFinite(item.score)
			)
				throw new Error(`Invalid source profile Custom Format identity or score. ${reviewAdvice}`);
			profileIds.add(item.format);
		}
		const sourceCFs = sourceFormats.filter((cf) => profileIds.has(cf.id!));
		if (sourceCFs.length !== profileIds.size)
			throw new Error(`Source profile Custom Format definition is missing. ${reviewAdvice}`);
		const sourceMarkers = new Map(sourceCFs.map((cf) => [cf, this.extractTrashId(cf)]));
		const targetMarkers = new Map(targetFormats.map((cf) => [cf, this.extractTrashId(cf)]));
		const selectedKeys = new Set<string>(),
			targetIds = new Set<number>();
		const formatItems: Array<{ format: number; score: number }> = [],
			unmatched: string[] = [];
		for (const selection of selections) {
			if (
				typeof selection.trash_id !== "string" ||
				!selection.trash_id.trim() ||
				!Number.isFinite(selection.score) ||
				selectedKeys.has(selection.trash_id.toLowerCase())
			)
				throw new Error(`Invalid or duplicate selected Custom Format. ${reviewAdvice}`);
			selectedKeys.add(selection.trash_id.toLowerCase());
			const marker = selection.trash_id.toLowerCase();
			const sourceExact = sourceCFs.filter((cf) => sourceMarkers.get(cf) === marker);
			const candidates = sourceExact.length
				? sourceExact
				: sourceCFs.filter((cf) => cf.name === selection.trash_id);
			const sourceCF = candidates.length === 1 ? candidates[0] : undefined;
			let targetCF: SdkCustomFormat | undefined;
			if (sourceCF) {
				const exact = targetFormats.filter((cf) => targetMarkers.get(cf) === marker);
				if (exact.length === 1 && sourceExact.length === 1) targetCF = exact[0];
				else if (exact.length === 0) {
					const definitions = targetFormats.filter((cf) => sameDefinition(sourceCF, cf));
					if (definitions.length === 1) targetCF = definitions[0];
				} else if (exact.length === 1 && sameDefinition(sourceCF, exact[0]!)) targetCF = exact[0];
			}
			if (!targetCF) {
				unmatched.push(selection.trash_id);
				continue;
			}
			if (targetIds.has(targetCF.id!))
				throw new Error(
					`Conflicting selections resolve to one target Custom Format. ${reviewAdvice}`,
				);
			targetIds.add(targetCF.id!);
			formatItems.push({ format: targetCF.id!, score: selection.score });
		}
		return { formatItems, unmatched };
	}

	/**
	 * Fetch complete quality profile data from *arr instance
	 */
	async importQualityProfile(
		options: QualityProfileImportOptions,
	): Promise<QualityProfileImportResult> {
		try {
			const { instanceId, profileId, userId } = options;
			if (!isPositiveSafeId(profileId))
				return { success: false, error: "Invalid source profile identity" };

			// Get SDK client for instance (validates user ownership)
			const clientResult = await this.getClientForInstance(instanceId, userId);
			if ("error" in clientResult) {
				return { success: false, error: clientResult.error };
			}

			// Fetch quality profile using SDK
			const profileData = await clientResult.client.qualityProfile.getById(profileId);
			if (profileData.id !== profileId || !isPositiveSafeId(profileData.id))
				return { success: false, error: "Source profile identity changed" };

			// Resolve cutoff quality name from items if not directly available
			let cutoffQuality: { id: number; name: string } | undefined;
			if (profileData.cutoff && profileData.items) {
				cutoffQuality = findQualityById(
					profileData.items as SdkQualityProfileItem[],
					profileData.cutoff,
				);
			}

			// Transform to CompleteQualityProfile format
			// Sonarr-specific fields (language, languages) exist on Sonarr profiles but not Radarr
			const profileRecord = profileData as Record<string, unknown>;
			const completeProfile: CompleteQualityProfile = {
				sourceInstanceId: instanceId,
				sourceInstanceLabel: clientResult.instanceLabel,
				sourceProfileId: profileData.id ?? 0,
				sourceProfileName: profileData.name || "Unknown",
				importedAt: new Date().toISOString(),

				upgradeAllowed: profileData.upgradeAllowed ?? true,
				cutoff: profileData.cutoff ?? 0,
				cutoffQuality,

				items: (profileData.items || []) as CompleteQualityProfile["items"],

				minFormatScore: profileData.minFormatScore ?? 0,
				cutoffFormatScore: profileData.cutoffFormatScore ?? 0,
				minUpgradeFormatScore: profileData.minUpgradeFormatScore,

				// Sonarr has language/languages, Radarr doesn't — access via Record
				language: profileRecord.language as CompleteQualityProfile["language"],
				languages: profileRecord.languages as CompleteQualityProfile["languages"],
			};

			return {
				success: true,
				profile: completeProfile,
			};
		} catch (error) {
			log.error(
				{ err: error, instanceId: options.instanceId, profileId: options.profileId },
				"Failed to import quality profile",
			);
			return {
				success: false,
				error: getErrorMessage(error, "Unknown error"),
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
			if (options.existingProfileId !== undefined && !isPositiveSafeId(options.existingProfileId))
				throw new Error("Invalid existing target profile identity");
			// Get SDK client for instance (validates user ownership)
			const clientResult = await this.getClientForInstance(instanceId, userId);
			if ("error" in clientResult) {
				return { success: false, error: clientResult.error };
			}
			const client = clientResult.client;

			const { formatItems, unmatched } = await this.resolveCustomFormats(
				clientResult,
				userId,
				profile,
				customFormats,
			);
			if (unmatched.length)
				throw new Error(
					`Selected Custom Formats have no unique current source-to-target mapping (${unmatched.join(", ")}). ${reviewAdvice}`,
				);

			// Build quality profile payload
			const intended = {
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
			const profilePayload = Object.fromEntries(
				Object.entries(intended).filter(([, value]) => value !== undefined),
			);

			// Create or update profile
			// SonarrClient | RadarrClient union creates impossible intersection for QualityProfile create/update
			// biome-ignore lint/suspicious/noExplicitAny: SDK type union incompatibility at QualitySource enum level
			let deployedProfile: any;
			if (options.existingProfileId !== undefined) {
				const live = await client.qualityProfile.getById(options.existingProfileId);
				if (!isPositiveSafeId(live.id) || live.id !== options.existingProfileId)
					throw new Error(`Target profile identity changed. ${reviewAdvice}`);
				// biome-ignore lint/suspicious/noExplicitAny: SDK type union incompatibility
				const updatePayload: any = { ...live, ...profilePayload, id: options.existingProfileId };
				deployedProfile = await client.qualityProfile.update(
					options.existingProfileId,
					updatePayload,
				);
			} else {
				// biome-ignore lint/suspicious/noExplicitAny: SDK type union incompatibility
				const createPayload: any = profilePayload;
				deployedProfile = await client.qualityProfile.create(createPayload);
			}
			if (
				!isPositiveSafeId(deployedProfile?.id) ||
				(options.existingProfileId !== undefined &&
					deployedProfile.id !== options.existingProfileId)
			)
				throw new Error(
					"ARR returned an invalid deployed profile identity. The mutation outcome is uncertain; inspect ARR before retrying.",
				);

			return {
				success: true,
				profileId: deployedProfile.id,
			};
		} catch (error) {
			log.error(
				{ err: error, instanceId, profileName: options.profileName },
				"Failed to deploy complete profile",
			);
			return {
				success: false,
				error: getErrorMessage(error, "Unknown error"),
			};
		}
	}

	/**
	 * Extract trash_id from a custom format's specifications
	 */
	private extractTrashId(cf: SdkCustomFormat): string | null {
		let marker: string | null = null;
		for (const spec of cf.specifications || []) {
			if (spec.fields && Array.isArray(spec.fields)) {
				for (const field of spec.fields.filter((f) => f.name === "trash_id")) {
					if (marker !== null || typeof field.value !== "string" || !field.value.trim())
						throw new Error(`Ambiguous live Custom Format TRaSH identity. ${reviewAdvice}`);
					marker = field.value.toLowerCase();
				}
			}
		}
		return marker;
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

			const { formatItems, unmatched } = await this.resolveCustomFormats(
				clientResult,
				userId,
				profile,
				customFormats,
			);

			// Calculate quality stats
			const totalQualities = profile.items.length;
			const allowedQualities = profile.items.filter((item) => item.allowed).length;

			// Find cutoff quality name
			const cutoffQuality = profile.cutoffQuality?.name || "Unknown";

			// Calculate score stats
			const scores = customFormats.map((cf) => cf.score);
			const avgScore = scores.length > 0 ? scores.reduce((a, b) => a + b, 0) / scores.length : 0;

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
						matched: formatItems.length,
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
				error: getErrorMessage(error, "Unknown error"),
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
