/**
 * TRaSH Guide Fetcher
 * Fetches and parses Custom Format definitions from TRaSH guides repository
 */

import type { ServiceType } from "@prisma/client";
import type { TrashGuideData, TrashCustomFormat } from "../types.js";

const TRASH_GUIDES_BASE_URL =
	"https://raw.githubusercontent.com/TRaSH-Guides/Guides";

interface TrashGuideConfig {
	ref: string; // branch, tag, or commit
	service: ServiceType;
}

/**
 * Fetch TRaSH guides data for a specific service and ref
 */
export async function fetchTrashGuides(
	config: TrashGuideConfig,
): Promise<TrashGuideData> {
	const { ref, service } = config;

	// Map service type to TRaSH guides path
	const servicePath = service === "SONARR" ? "sonarr" : "radarr";

	// For now, we'll fetch the CF JSON directly
	// The actual structure may vary; adjust based on TRaSH guides repo structure
	const customFormatsUrl = `${TRASH_GUIDES_BASE_URL}/${ref}/docs/json/${servicePath}/cf/all.json`;

	try {
		const response = await fetch(customFormatsUrl, {
			headers: {
				Accept: "application/json",
			},
		});

		if (!response.ok) {
			throw new Error(
				`Failed to fetch TRaSH guides from ${customFormatsUrl}: ${response.statusText}`,
			);
		}

		const data = await response.json();

		// Parse and normalize the data
		return {
			customFormats: normalizeCustomFormats(data),
			version: ref,
			lastUpdated: new Date().toISOString(),
		};
	} catch (error) {
		throw new Error(
			`Failed to fetch TRaSH guides: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

/**
 * Normalize TRaSH custom formats to our internal format
 */
function normalizeCustomFormats(data: any): TrashCustomFormat[] {
	// Handle different possible data structures
	const formats = Array.isArray(data) ? data : data.custom_formats || [];

	return formats.map((cf: any) => ({
		trash_id: cf.trash_id || cf.id || "",
		trash_scores: cf.trash_scores || {},
		name: cf.name || "Unknown",
		includeCustomFormatWhenRenaming:
			cf.includeCustomFormatWhenRenaming ?? false,
		specifications: normalizeSpecifications(cf.specifications || []),
	}));
}

/**
 * Normalize specifications to match Sonarr/Radarr API format
 */
function normalizeSpecifications(specs: any[]): any[] {
	return specs.map((spec) => ({
		implementation: spec.implementation || "",
		name: spec.name || "",
		negate: spec.negate ?? false,
		required: spec.required ?? false,
		fields: spec.fields || {},
	}));
}

/**
 * Fetch available presets for a service
 */
export async function fetchAvailablePresets(
	service: ServiceType,
	ref = "master",
): Promise<string[]> {
	// This would fetch the list of available presets
	// For now, return a hardcoded list of common presets
	const commonPresets = [
		"anime",
		"x265",
		"hdr",
		"hdr10plus",
		"dolby-vision",
		"web-dl",
		"remux",
	];

	if (service === "SONARR") {
		return [
			...commonPresets,
			"scene",
			"p2p",
			"repack-proper",
			"streaming-services",
		];
	}

	// RADARR
	return [...commonPresets, "uhd-bluray-web", "imax", "imax-enhanced"];
}

/**
 * Filter custom formats by preset names
 */
export function filterByPresets(
	customFormats: TrashCustomFormat[],
	presets: string[],
): TrashCustomFormat[] {
	if (presets.length === 0) {
		return customFormats;
	}

	// Simple name-based matching for now
	// In a real implementation, you'd have a proper mapping
	const presetNames = new Set(presets.map((p) => p.toLowerCase()));

	return customFormats.filter((cf) => {
		const cfName = cf.name.toLowerCase();
		return presets.some((preset) => cfName.includes(preset.toLowerCase()));
	});
}
