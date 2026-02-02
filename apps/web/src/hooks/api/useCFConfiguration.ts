import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "../../lib/api-client/base";
import type { QualityProfileSummary } from "../../lib/api-client/trash-guides";

/**
 * Wizard-specific profile type that allows undefined trashId for edit mode.
 * In edit mode, templates don't persist the original TRaSH profile ID.
 */
type WizardSelectedProfile = Omit<QualityProfileSummary, 'trashId'> & {
	trashId?: string;
};

interface UseCFConfigurationOptions {
	serviceType: "RADARR" | "SONARR";
	qualityProfile: WizardSelectedProfile;
	isEditMode?: boolean;
	editingTemplate?: any;
}

/**
 * Check if a trashId indicates a cloned profile from an instance
 * Cloned profile trashIds have format: cloned-{instanceId}-{profileId}-{uuid}
 */
function isClonedProfile(trashId: string | undefined): boolean {
	return !!trashId && trashId.startsWith("cloned-");
}

/**
 * Parse cloned profile trashId to extract instanceId and profileId
 * Format: cloned-{instanceId}-{profileId}-{uuid}
 * Where instanceId can contain dashes, profileId is a number, and uuid can be:
 * - Standard UUID: 5 parts (xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx)
 * - Fallback: 2 parts (timestamp-random alphanumeric)
 */
function parseClonedProfileId(trashId: string): { instanceId: string; profileId: number } | null {
	if (!isClonedProfile(trashId)) return null;

	// Remove "cloned-" prefix
	const withoutPrefix = trashId.slice(7); // "cloned-".length = 7
	if (!withoutPrefix) return null;

	// Split by "-"
	const parts = withoutPrefix.split("-");

	// Need at least: instanceId (1+ parts) + profileId (1 part) + uuid (2 or 5 parts) = 4 or 7 parts minimum
	if (parts.length < 4) return null;

	// Try to detect UUID format by testing the last segments
	// First, try standard 5-part UUID format
	const uuidParts5 = parts.slice(-5);
	const uuidCandidate5 = uuidParts5.join("-");
	// UUID regex: 8-4-4-4-12 hex digits
	const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

	let profileIdIndex: number;

	if (uuidRegex.test(uuidCandidate5) && parts.length >= 7) {
		// Standard 5-part UUID format detected
		profileIdIndex = parts.length - 6; // profileId is second-to-last before UUID
	} else {
		// Try fallback 2-part format (timestamp-random)
		const uuidParts2 = parts.slice(-2);
		if (parts.length < 4) return null; // Need at least instanceId + profileId + 2-part ID

		// Check if first part is numeric (timestamp) and second is alphanumeric
		const timestampPart = uuidParts2[0];
		const randomPart = uuidParts2[1];

		if (timestampPart && randomPart && /^\d+$/.test(timestampPart) && /^[a-z0-9]+$/i.test(randomPart)) {
			// Fallback 2-part format detected
			profileIdIndex = parts.length - 3; // profileId is third-to-last before 2-part ID
		} else {
			// Neither format matches
			return null;
		}
	}

	// Extract profileId and instanceId based on detected format
	const profileIdStr = parts[profileIdIndex];
	const instanceIdParts = parts.slice(0, profileIdIndex);
	const instanceId = instanceIdParts.join("-");

	// Validate that profileId and instanceId are non-empty
	if (!instanceId || !profileIdStr) return null;

	// Parse profileId as number
	const profileId = parseInt(profileIdStr, 10);
	if (isNaN(profileId) || profileId < 0) return null;

	return { instanceId, profileId };
}

export function useCFConfiguration({
	serviceType,
	qualityProfile,
	isEditMode = false,
	editingTemplate,
}: UseCFConfigurationOptions) {
	// In normal mode, we need a valid trashId to fetch profile data
	const hasValidTrashId = !!qualityProfile.trashId;
	const isCloned = isClonedProfile(qualityProfile.trashId);

	return useQuery({
		queryKey: isEditMode
			? ["template-edit-data", editingTemplate?.id]
			: isCloned
				? ["cloned-profile-details", qualityProfile.trashId]
				: ["quality-profile-details", serviceType, qualityProfile.trashId],
		queryFn: async () => {
			if (isEditMode && editingTemplate) {
				return await fetchEditModeData(serviceType, editingTemplate);
			}
			if (isCloned && qualityProfile.trashId) {
				return await fetchClonedProfileData(qualityProfile.trashId);
			}
			if (!qualityProfile.trashId) {
				throw new Error("Missing trashId for quality profile fetch");
			}
			return await fetchNormalModeData(serviceType, qualityProfile.trashId);
		},
		// Only enable in edit mode (with template) or normal mode (with valid trashId)
		enabled: isEditMode ? !!editingTemplate : hasValidTrashId,
	});
}

/**
 * Default quality definitions for Radarr
 * Ordered from highest priority (bottom) to lowest priority (top)
 * Higher quality items should be at the END of the array
 */
const RADARR_DEFAULT_QUALITIES = [
	{ name: "Unknown", allowed: false, source: "unknown", resolution: 0 },
	{ name: "SDTV", allowed: false, source: "tv", resolution: 480 },
	{ name: "DVD", allowed: false, source: "dvd", resolution: 480 },
	{ name: "WEBDL-480p", allowed: false, source: "webdl", resolution: 480 },
	{ name: "WEBRip-480p", allowed: false, source: "webrip", resolution: 480 },
	{ name: "Bluray-480p", allowed: false, source: "bluray", resolution: 480 },
	{ name: "HDTV-720p", allowed: false, source: "tv", resolution: 720 },
	{ name: "WEBDL-720p", allowed: true, source: "webdl", resolution: 720 },
	{ name: "WEBRip-720p", allowed: true, source: "webrip", resolution: 720 },
	{ name: "Bluray-720p", allowed: true, source: "bluray", resolution: 720 },
	{ name: "HDTV-1080p", allowed: false, source: "tv", resolution: 1080 },
	{ name: "WEBDL-1080p", allowed: true, source: "webdl", resolution: 1080 },
	{ name: "WEBRip-1080p", allowed: true, source: "webrip", resolution: 1080 },
	{ name: "Bluray-1080p", allowed: true, source: "bluray", resolution: 1080 },
	{ name: "Remux-1080p", allowed: true, source: "bluray", resolution: 1080 },
	{ name: "HDTV-2160p", allowed: false, source: "tv", resolution: 2160 },
	{ name: "WEBDL-2160p", allowed: true, source: "webdl", resolution: 2160 },
	{ name: "WEBRip-2160p", allowed: true, source: "webrip", resolution: 2160 },
	{ name: "Bluray-2160p", allowed: true, source: "bluray", resolution: 2160 },
	{ name: "Remux-2160p", allowed: true, source: "bluray", resolution: 2160 },
];

/**
 * Default quality definitions for Sonarr
 * Ordered from highest priority (bottom) to lowest priority (top)
 * Higher quality items should be at the END of the array
 */
const SONARR_DEFAULT_QUALITIES = [
	{ name: "Unknown", allowed: false, source: "unknown", resolution: 0 },
	{ name: "SDTV", allowed: false, source: "tv", resolution: 480 },
	{ name: "DVD", allowed: false, source: "dvd", resolution: 480 },
	{ name: "WEBDL-480p", allowed: false, source: "webdl", resolution: 480 },
	{ name: "WEBRip-480p", allowed: false, source: "webrip", resolution: 480 },
	{ name: "Bluray-480p", allowed: false, source: "bluray", resolution: 480 },
	{ name: "HDTV-720p", allowed: false, source: "tv", resolution: 720 },
	{ name: "WEBDL-720p", allowed: true, source: "webdl", resolution: 720 },
	{ name: "WEBRip-720p", allowed: true, source: "webrip", resolution: 720 },
	{ name: "Bluray-720p", allowed: true, source: "bluray", resolution: 720 },
	{ name: "HDTV-1080p", allowed: false, source: "tv", resolution: 1080 },
	{ name: "WEBDL-1080p", allowed: true, source: "webdl", resolution: 1080 },
	{ name: "WEBRip-1080p", allowed: true, source: "webrip", resolution: 1080 },
	{ name: "Bluray-1080p", allowed: true, source: "bluray", resolution: 1080 },
	{ name: "Remux-1080p", allowed: true, source: "bluray", resolution: 1080 },
	{ name: "HDTV-2160p", allowed: false, source: "tv", resolution: 2160 },
	{ name: "WEBDL-2160p", allowed: true, source: "webdl", resolution: 2160 },
	{ name: "WEBRip-2160p", allowed: true, source: "webrip", resolution: 2160 },
	{ name: "Bluray-2160p", allowed: true, source: "bluray", resolution: 2160 },
	{ name: "Remux-2160p", allowed: true, source: "bluray", resolution: 2160 },
];

/**
 * Get default quality definitions for a service type
 */
function getDefaultQualitiesForService(serviceType: string): Array<{
	name: string;
	allowed: boolean;
	source?: string;
	resolution?: number;
}> {
	return serviceType === "RADARR" ? RADARR_DEFAULT_QUALITIES : SONARR_DEFAULT_QUALITIES;
}

/**
 * Fetch CF descriptions and build lookup Maps for enrichment.
 *
 * Uses the dedicated cf-descriptions/list endpoint which lazy-loads
 * descriptions from GitHub on demand (the generic /cache/entries endpoint
 * does NOT populate CF_DESCRIPTIONS during full cache refresh).
 *
 * Returns two maps for multi-strategy matching:
 * - bySlug: cfName slug → description (primary, e.g. "br-disk")
 * - byDisplayName: lowercased displayName → description (fallback, e.g. "br-disk")
 */
type DescEntry = { description: string; displayName: string };

async function fetchCFDescriptionMap(serviceType: string): Promise<{
	bySlug: Map<string, DescEntry>;
	byDisplayName: Map<string, DescEntry>;
}> {
	const bySlug = new Map<string, DescEntry>();
	const byDisplayName = new Map<string, DescEntry>();
	try {
		const res = await apiRequest<any>(
			`/api/trash-guides/cache/cf-descriptions/list?serviceType=${serviceType}`
		);
		const serviceKey = serviceType.toLowerCase();
		const descriptions: any[] = res?.[serviceKey] || [];
		for (const desc of descriptions) {
			if (desc.cfName && desc.description) {
				const entry: DescEntry = {
					description: desc.description,
					displayName: desc.displayName || "",
				};
				bySlug.set(desc.cfName, entry);
				if (desc.displayName) {
					byDisplayName.set(desc.displayName.toLowerCase(), entry);
				}
			}
		}
	} catch (error) {
		// Descriptions are optional enrichment; don't fail the whole flow
		console.warn("[useCFConfiguration] Failed to fetch CF descriptions:", error);
	}
	return { bySlug, byDisplayName };
}

/**
 * Convert a CF name to the slug format used for description lookup.
 * Matches the server-side logic: lowercase → spaces to hyphens → strip non-alphanumeric.
 */
function cfNameToSlug(name: string): string {
	return name.toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "");
}

/**
 * Enrich a CF object with description using multiple matching strategies.
 * Mirrors the 4-strategy approach from custom-formats-browser.tsx.
 */
function enrichWithDescription(
	cf: any,
	descMaps: { bySlug: Map<string, DescEntry>; byDisplayName: Map<string, DescEntry> },
): { description: string; displayName: string } {
	const name = cf.name || cf.originalConfig?.name || "";
	const slug = cfNameToSlug(name);
	const nameLower = name.toLowerCase();

	// Strategy 1: Exact slug match (e.g. "BR-DISK" → "br-disk")
	let match = descMaps.bySlug.get(slug);

	// Strategy 2: Display name match (case-insensitive)
	if (!match) {
		match = descMaps.byDisplayName.get(nameLower);
	}

	// Strategies 3 & 4: Strip parenthetical suffix (e.g. "ATMOS (undefined)" → "atmos")
	if (!match) {
		const baseName = nameLower.replace(/\s*\([^)]*\)\s*$/, "").trim();
		const baseSlug = cfNameToSlug(baseName);

		if (baseSlug !== slug) {
			// Strategy 3: Base slug match
			match = descMaps.bySlug.get(baseSlug);

			// Strategy 4: Base display name match
			if (!match) {
				match = descMaps.byDisplayName.get(baseName);
			}
		}
	}

	return {
		description: match?.description || cf.trash_description || cf.description || "",
		displayName: match?.displayName || cf.displayName || cf.name || "",
	};
}

async function fetchEditModeData(serviceType: string, editingTemplate: any) {
	const templateCFs = editingTemplate.config.customFormats || [];
	const templateCFGroups = editingTemplate.config.customFormatGroups || [];

	// Fetch description map for enrichment
	const descMap = await fetchCFDescriptionMap(serviceType);

	// Extract custom formats from template's originalConfig
	const mandatoryCFs = templateCFs.map((cf: any) => {
		const trashScores = cf.originalConfig?.trash_scores || {};
		const defaultScore = trashScores.default || 0;
		const cfName = cf.originalConfig?.name || cf.name;
		const enriched = enrichWithDescription({ name: cfName, ...cf }, descMap);

		return {
			trash_id: cf.trashId,
			name: cfName,
			displayName: enriched.displayName,
			description: enriched.description,
			defaultScore,
			scoreOverride: cf.scoreOverride,
			source: "template" as const,
			locked: false,
			originalConfig: cf.originalConfig,
		};
	});

	// Fetch all available custom formats from cache (pass descMap for enrichment)
	const availableFormats = await fetchAvailableFormats(serviceType, descMap);

	// Map CF Groups
	const cfGroups = templateCFGroups.map((cfGroup: any) => ({
		trash_id: cfGroup.trashId,
		name: cfGroup.originalConfig?.name || cfGroup.name,
		trash_description: cfGroup.originalConfig?.trash_description || "",
		custom_formats: cfGroup.originalConfig?.custom_formats || [],
		default: cfGroup.originalConfig?.default,
		quality_profiles: cfGroup.originalConfig?.quality_profiles,
	}));

	// In edit mode, provide default quality items from service type
	// This allows users to configure qualities even if the template was created
	// before the quality configuration feature was added
	const qualityItems = getDefaultQualitiesForService(serviceType);

	return {
		cfGroups,
		mandatoryCFs,
		availableFormats,
		stats: {
			mandatoryCount: templateCFs.length,
			optionalGroupCount: templateCFGroups.length,
			totalOptionalCFs: availableFormats.length,
		},
		qualityItems,
	};
}

/**
 * Fetch data for a cloned profile from the source instance
 */
async function fetchClonedProfileData(trashId: string) {
	const parsedId = parseClonedProfileId(trashId);

	if (!parsedId) {
		throw new Error("Invalid cloned profile ID format");
	}

	const { instanceId, profileId } = parsedId;

	// Fetch profile details from the source instance
	const response = await apiRequest<any>(
		`/api/trash-guides/profile-clone/profile-details/${instanceId}/${profileId}`
	);

	if (!response.success || !response.data) {
		throw new Error(response.error || "Failed to fetch profile details from instance");
	}

	const { profile, customFormats, allCustomFormats } = response.data;

	// Detect service type from instance for description enrichment
	// Instance response may include serviceType; fall back to inferring from trashId
	const instanceServiceType = response.data.serviceType || "RADARR";
	const descMap = await fetchCFDescriptionMap(instanceServiceType);

	// Convert instance CFs to the format expected by the wizard
	const mandatoryCFs = customFormats.map((cf: any) => {
		const enriched = enrichWithDescription(cf, descMap);
		return {
			trash_id: cf.trash_id,
			name: cf.name,
			displayName: enriched.displayName,
			description: enriched.description,
			score: cf.score,
			defaultScore: cf.score,
			source: "instance" as const,
			locked: false,
			specifications: cf.specifications,
			originalConfig: {
				name: cf.name,
				specifications: cf.specifications,
				includeCustomFormatWhenRenaming: cf.includeCustomFormatWhenRenaming,
			},
		};
	});

	// All instance CFs as available formats
	const availableFormats = allCustomFormats.map((cf: any) => {
		const enriched = enrichWithDescription(cf, descMap);
		return {
			trash_id: cf.trash_id,
			name: cf.name,
			displayName: enriched.displayName,
			description: enriched.description,
			score: 0, // Instance CFs don't have TRaSH scores by default
			originalConfig: {
				name: cf.name,
				specifications: cf.specifications,
				includeCustomFormatWhenRenaming: cf.includeCustomFormatWhenRenaming,
			},
		};
	});

	// Extract quality items from cloned profile
	const qualityItems = profile.items?.map((item: any) => ({
		name: item.name || item.quality?.name,
		allowed: item.allowed ?? true,
		source: item.quality?.source,
		resolution: item.quality?.resolution,
		// Group items contain nested quality names
		items: item.items?.map((q: any) => typeof q === 'string' ? q : q.name || q.quality?.name),
	})) || [];

	return {
		cfGroups: [], // Cloned profiles don't have CF groups
		mandatoryCFs,
		availableFormats,
		profile: {
			name: profile.name,
			upgradeAllowed: profile.upgradeAllowed,
			cutoff: profile.cutoff,
			minFormatScore: profile.minFormatScore,
		},
		stats: {
			mandatoryCount: customFormats.length,
			optionalGroupCount: 0,
			totalOptionalCFs: allCustomFormats.length,
		},
		isClonedProfile: true,
		qualityItems,
	};
}

async function fetchNormalModeData(
	serviceType: string,
	trashId: string
) {
	const profileData = await apiRequest<any>(
		`/api/trash-guides/quality-profiles/${serviceType}/${trashId}`
	);

	// Check for error response (quality profile route returns { statusCode, error, message } on error)
	if (profileData.statusCode || profileData.error) {
		throw new Error(profileData.message || profileData.error || "Failed to fetch quality profile details");
	}

	const availableFormats = await fetchAvailableFormats(serviceType);

	// Extract quality items from profile for QualityGroupEditor
	const qualityItems = extractQualityItems(profileData.profile);

	return {
		...profileData,
		availableFormats,
		qualityItems,
	};
}

/**
 * Extract quality items from TRaSH profile for QualityGroupEditor
 * TRaSH profiles have items array with quality definitions
 */
function extractQualityItems(profile: any): Array<{
	name: string;
	allowed: boolean;
	source?: string;
	resolution?: number;
	items?: string[];
}> {
	if (!profile?.items || !Array.isArray(profile.items)) {
		return [];
	}

	return profile.items.map((item: any) => ({
		name: item.name,
		allowed: item.allowed ?? true,
		source: item.quality?.source,
		resolution: item.quality?.resolution,
		// If this is a group, it has nested items
		items: item.items,
	}));
}

async function fetchAvailableFormats(
	serviceType: string,
	existingDescMap?: { bySlug: Map<string, DescEntry>; byDisplayName: Map<string, DescEntry> },
) {
	const customFormatsRes = await apiRequest<any>(
		`/api/trash-guides/cache/entries?serviceType=${serviceType}&configType=CUSTOM_FORMATS`
	);

	const customFormatsCacheEntry = Array.isArray(customFormatsRes)
		? customFormatsRes[0]
		: customFormatsRes;

	const allCustomFormats = customFormatsCacheEntry?.data || [];

	// Fetch descriptions if not already provided by caller
	const descMap = existingDescMap ?? await fetchCFDescriptionMap(serviceType);

	// Note: We include originalConfig which contains trash_scores.
	// The component resolves the actual score using the profile's scoreSet.
	// No need to pre-compute 'score' here since it would only use default.
	const trashFormats = allCustomFormats.map((cf: any) => {
		const enriched = enrichWithDescription(cf, descMap);
		return {
			trash_id: cf.trash_id,
			name: cf.name,
			displayName: enriched.displayName,
			description: enriched.description,
			originalConfig: cf,
		};
	});

	// Also fetch user custom formats and merge them in
	try {
		const userCFsRes = await apiRequest<any>(
			`/api/trash-guides/user-custom-formats?serviceType=${serviceType}`
		);
		const userCFs = userCFsRes?.customFormats || [];

		const userFormats = userCFs.map((cf: any) => ({
			trash_id: `user-${cf.id}`,
			name: cf.name,
			displayName: cf.name,
			description: cf.description || "",
			_source: "user_created" as const,
			originalConfig: {
				name: cf.name,
				specifications: cf.specifications,
				includeCustomFormatWhenRenaming: cf.includeCustomFormatWhenRenaming,
				trash_scores: { default: cf.defaultScore },
			},
		}));

		return [...trashFormats, ...userFormats];
	} catch (error) {
		// User CFs are optional enrichment; don't fail the whole flow
		console.warn("[useCFConfiguration] Failed to fetch user custom formats:", error);
		return trashFormats;
	}
}
