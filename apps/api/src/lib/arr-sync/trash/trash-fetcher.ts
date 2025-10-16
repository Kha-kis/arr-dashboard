/**
 * TRaSH Guide Fetcher
 * Fetches and parses Custom Format definitions from TRaSH guides repository
 */

import type { ServiceType } from "@prisma/client";
import type { TrashGuideData, TrashCustomFormat } from "../types.js";

const TRASH_GUIDES_BASE_URL =
	"https://raw.githubusercontent.com/TRaSH-Guides/Guides";

const GITHUB_API_BASE_URL =
	"https://api.github.com/repos/TRaSH-Guides/Guides/contents";

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

	try {
		// Use GitHub API to list all files in the cf directory
		const apiUrl = `${GITHUB_API_BASE_URL}/docs/json/${servicePath}/cf?ref=${ref}`;

		const listResponse = await fetch(apiUrl, {
			headers: {
				'Accept': 'application/vnd.github.v3+json',
				'User-Agent': 'arr-dashboard'
			}
		});

		if (!listResponse.ok) {
			throw new Error(`Failed to list TRaSH custom formats: ${listResponse.statusText}`);
		}

		const fileList = await listResponse.json();

		// Filter to only .json files (excluding index or collection files if they exist)
		const jsonFiles = fileList.filter((file: any) =>
			file.type === "file" &&
			file.name.endsWith('.json') &&
			!file.name.startsWith('index') &&
			!file.name.startsWith('collection')
		);

		// Fetch individual custom format files (limit batches to avoid overwhelming)
		const customFormats: TrashCustomFormat[] = [];
		const batchSize = 10;

		for (let i = 0; i < jsonFiles.length; i += batchSize) {
			const batch = jsonFiles.slice(i, i + batchSize);

			const batchPromises = batch.map(async (file: any) => {
				try {
					// Use the download_url from GitHub API response
					const cfResponse = await fetch(file.download_url);

					if (!cfResponse.ok) {
						console.warn(`Failed to fetch custom format ${file.name}: ${cfResponse.statusText}`);
						return null;
					}

					const cfData = await cfResponse.json();

					// Extract trash_id from filename (remove .json extension)
					const trashId = file.name.replace('.json', '');

					return {
						trash_id: cfData.trash_id || trashId,
						trash_scores: cfData.trash_scores || {},
						trash_description: cfData.trash_description || undefined,
						name: cfData.name || trashId,
						includeCustomFormatWhenRenaming: cfData.includeCustomFormatWhenRenaming ?? false,
						specifications: normalizeSpecifications(cfData.specifications || []),
					};
				} catch (error) {
					console.warn(`Error fetching custom format ${file.name}:`, error);
					return null;
				}
			});

			const batchResults = await Promise.all(batchPromises);
			customFormats.push(...batchResults.filter((cf): cf is TrashCustomFormat => cf !== null));
		}

		return {
			customFormats,
			version: ref,
			lastUpdated: new Date().toISOString(),
		};
	} catch (error) {
		console.error('Error fetching TRaSH guides:', error);
		throw error;
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
	return specs.map((spec) => {
		// Convert fields object to array format expected by Arr APIs
		const fields = spec.fields || {};
		const fieldsArray = Object.entries(fields).map(([name, value]) => ({
			name,
			value,
		}));

		return {
			implementation: spec.implementation || "",
			name: spec.name || "",
			negate: spec.negate ?? false,
			required: spec.required ?? false,
			fields: fieldsArray,
		};
	});
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

/**
 * Fetch CF groups for a specific service
 */
export async function fetchCFGroups(
	config: TrashGuideConfig,
): Promise<any[]> {
	const { ref, service } = config;

	// Map service type to TRaSH guides path
	const servicePath = service === "SONARR" ? "sonarr" : "radarr";

	try {
		// Use GitHub API to list all files in the cf-groups directory
		const apiUrl = `${GITHUB_API_BASE_URL}/docs/json/${servicePath}/cf-groups?ref=${ref}`;

		const listResponse = await fetch(apiUrl, {
			headers: {
				'Accept': 'application/vnd.github.v3+json',
				'User-Agent': 'arr-dashboard'
			}
		});

		if (!listResponse.ok) {
			throw new Error(`Failed to list TRaSH CF groups: ${listResponse.statusText}`);
		}

		const fileList = await listResponse.json();

		// Filter to only .json files
		const jsonFiles = fileList.filter((file: any) =>
			file.type === "file" && file.name.endsWith('.json')
		);

		// Fetch individual CF group files
		const cfGroups: any[] = [];
		const batchSize = 10;

		for (let i = 0; i < jsonFiles.length; i += batchSize) {
			const batch = jsonFiles.slice(i, i + batchSize);

			const batchPromises = batch.map(async (file: any) => {
				try {
					const response = await fetch(file.download_url);

					if (!response.ok) {
						console.warn(`Failed to fetch CF group ${file.name}: ${response.statusText}`);
						return null;
					}

					const data = await response.json();
					return {
						...data,
						fileName: file.name,
					};
				} catch (error) {
					console.warn(`Error fetching CF group ${file.name}:`, error);
					return null;
				}
			});

			const batchResults = await Promise.all(batchPromises);
			cfGroups.push(...batchResults.filter((group): group is any => group !== null));
		}

		return cfGroups;
	} catch (error) {
		console.error('Error fetching TRaSH CF groups:', error);
		throw error;
	}
}

/**
 * Fetch quality profiles for a specific service
 */
export async function fetchQualityProfiles(
	config: TrashGuideConfig,
): Promise<any[]> {
	const { ref, service } = config;

	// Map service type to TRaSH guides path
	const servicePath = service === "SONARR" ? "sonarr" : "radarr";

	try {
		// Use GitHub API to list all files in the quality-profiles directory
		const apiUrl = `${GITHUB_API_BASE_URL}/docs/json/${servicePath}/quality-profiles?ref=${ref}`;

		const listResponse = await fetch(apiUrl, {
			headers: {
				'Accept': 'application/vnd.github.v3+json',
				'User-Agent': 'arr-dashboard'
			}
		});

		if (!listResponse.ok) {
			throw new Error(`Failed to list TRaSH quality profiles: ${listResponse.statusText}`);
		}

		const fileList = await listResponse.json();

		// Filter to only .json files
		const jsonFiles = fileList.filter((file: any) =>
			file.type === "file" && file.name.endsWith('.json')
		);

		// Fetch individual quality profile files
		const qualityProfiles: any[] = [];
		const batchSize = 10;

		for (let i = 0; i < jsonFiles.length; i += batchSize) {
			const batch = jsonFiles.slice(i, i + batchSize);

			const batchPromises = batch.map(async (file: any) => {
				try {
					const response = await fetch(file.download_url);

					if (!response.ok) {
						console.warn(`Failed to fetch quality profile ${file.name}: ${response.statusText}`);
						return null;
					}

					const data = await response.json();
					return {
						...data,
						fileName: file.name,
					};
				} catch (error) {
					console.warn(`Error fetching quality profile ${file.name}:`, error);
					return null;
				}
			});

			const batchResults = await Promise.all(batchPromises);
			qualityProfiles.push(...batchResults.filter((profile): profile is any => profile !== null));
		}

		return qualityProfiles;
	} catch (error) {
		console.error('Error fetching TRaSH quality profiles:', error);
		throw error;
	}
}
