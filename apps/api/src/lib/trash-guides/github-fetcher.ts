/**
 * TRaSH Guides GitHub Fetcher
 *
 * Fetches configuration JSON files from the TRaSH Guides GitHub repository.
 * Handles rate limiting, error recovery, and data validation.
 */

import type {
	TrashConfigType,
	TrashCustomFormat,
	TrashCustomFormatGroup,
	TrashQualitySize,
	TrashNamingScheme,
	TrashQualityProfile,
	TrashCFDescription,
} from "@arr/shared";
import { marked } from "marked";

// ============================================================================
// Constants
// ============================================================================

const TRASH_GITHUB_BASE_URL = "https://raw.githubusercontent.com/TRaSH-Guides/Guides/master/docs/json";
const TRASH_METADATA_URL =
	"https://raw.githubusercontent.com/TRaSH-Guides/Guides/master/metadata.json";
const TRASH_CF_DESCRIPTIONS_BASE_URL =
	"https://raw.githubusercontent.com/TRaSH-Guides/Guides/master/includes/cf-descriptions";

const FETCH_TIMEOUT_MS = 15000; // 15 seconds
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 1000; // 1 second

// ============================================================================
// Types
// ============================================================================

interface FetchOptions {
	timeout?: number;
	retries?: number;
	retryDelay?: number;
}

interface TrashMetadata {
	version?: string;
	lastUpdated?: string;
	[key: string]: unknown;
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Delay execution for specified milliseconds
 */
function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Fetch with timeout support
 */
async function fetchWithTimeout(url: string, timeout: number): Promise<Response> {
	const controller = new AbortController();
	const timeoutId = setTimeout(() => controller.abort(), timeout);

	try {
		const response = await fetch(url, {
			signal: controller.signal,
			headers: {
				"User-Agent": "arr-dashboard/2.3.0", // Identify ourselves
			},
		});

		clearTimeout(timeoutId);
		return response;
	} catch (error) {
		clearTimeout(timeoutId);
		if (error instanceof Error && error.name === "AbortError") {
			throw new Error(`Request timeout after ${timeout}ms`);
		}
		throw error;
	}
}

/**
 * Fetch with retry logic
 */
async function fetchWithRetry(url: string, options: FetchOptions = {}): Promise<Response> {
	const {
		timeout = FETCH_TIMEOUT_MS,
		retries = MAX_RETRIES,
		retryDelay = RETRY_DELAY_MS,
	} = options;

	let lastError: Error | undefined;

	for (let attempt = 1; attempt <= retries; attempt++) {
		try {
			const response = await fetchWithTimeout(url, timeout);

			// Check for GitHub rate limiting
			if (response.status === 429) {
				const retryAfter = response.headers.get("Retry-After");
				const waitTime = retryAfter ? Number.parseInt(retryAfter, 10) * 1000 : retryDelay * attempt;

				console.warn(`GitHub rate limit hit, retrying after ${waitTime}ms`);
				await delay(waitTime);
				continue;
			}

			// Success or non-retryable error
			if (response.ok || response.status === 404) {
				return response;
			}

			// Server errors are retryable
			if (response.status >= 500) {
				console.warn(`GitHub server error (${response.status}), attempt ${attempt}/${retries}`);
				if (attempt < retries) {
					await delay(retryDelay * attempt); // Exponential backoff
					continue;
				}
			}

			// Other errors
			throw new Error(`HTTP ${response.status}: ${response.statusText}`);
		} catch (error) {
			lastError = error instanceof Error ? error : new Error(String(error));
			console.error(`Fetch attempt ${attempt}/${retries} failed:`, lastError.message);

			if (attempt < retries) {
				await delay(retryDelay * attempt); // Exponential backoff
			}
		}
	}

	throw lastError || new Error("Fetch failed after all retries");
}

/**
 * Build GitHub URL for specific config type and service
 */
function buildGitHubUrl(serviceType: "RADARR" | "SONARR", configType: TrashConfigType): string {
	const service = serviceType.toLowerCase();

	switch (configType) {
		case "CUSTOM_FORMATS":
			return `${TRASH_GITHUB_BASE_URL}/${service}/cf`;
		case "CF_GROUPS":
			return `${TRASH_GITHUB_BASE_URL}/${service}/cf-groups`;
		case "QUALITY_SIZE":
			return `${TRASH_GITHUB_BASE_URL}/${service}/quality-size`;
		case "NAMING":
			return `${TRASH_GITHUB_BASE_URL}/${service}/naming`;
		case "QUALITY_PROFILES":
			return `${TRASH_GITHUB_BASE_URL}/${service}/quality-profiles`;
		default:
			throw new Error(`Unknown config type: ${configType}`);
	}
}

// ============================================================================
// Main Fetcher Class
// ============================================================================

export class TrashGitHubFetcher {
	private fetchOptions: FetchOptions;

	constructor(options: FetchOptions = {}) {
		this.fetchOptions = options;
	}

	/**
	 * Fetch TRaSH Guides metadata
	 */
	async fetchMetadata(): Promise<TrashMetadata> {
		const response = await fetchWithRetry(TRASH_METADATA_URL, this.fetchOptions);

		if (!response.ok) {
			throw new Error(`Failed to fetch metadata: ${response.statusText}`);
		}

		return (await response.json()) as TrashMetadata;
	}

	/**
	 * Fetch Custom Formats for a service
	 */
	async fetchCustomFormats(serviceType: "RADARR" | "SONARR"): Promise<TrashCustomFormat[]> {
		const baseUrl = buildGitHubUrl(serviceType, "CUSTOM_FORMATS");

		// First, try to fetch the directory listing (GitHub API)
		// For simplicity in Sprint 1, we'll use a known list approach
		// In production, you might want to use GitHub API to list files

		const formats: TrashCustomFormat[] = [];

		// Known Custom Format files (this would ideally come from metadata or GitHub API)
		// For Sprint 1, we'll implement a simple approach and expand later
		const knownFiles = await this.discoverConfigFiles(baseUrl);

		for (const file of knownFiles) {
			try {
				const url = `${baseUrl}/${file}`;
				const response = await fetchWithRetry(url, this.fetchOptions);

				if (response.ok) {
					const data = (await response.json()) as TrashCustomFormat | TrashCustomFormat[];
					// Handle both single format and array of formats
					if (Array.isArray(data)) {
						formats.push(...data);
					} else {
						formats.push(data);
					}
				}
			} catch (error) {
				console.warn(`Failed to fetch ${file}:`, error);
				// Continue with other files
			}
		}

		return formats;
	}

	/**
	 * Fetch Custom Format Groups for a service
	 */
	async fetchCustomFormatGroups(serviceType: "RADARR" | "SONARR"): Promise<TrashCustomFormatGroup[]> {
		const baseUrl = buildGitHubUrl(serviceType, "CF_GROUPS");

		const groups: TrashCustomFormatGroup[] = [];
		const knownFiles = await this.discoverConfigFiles(baseUrl);

		for (const file of knownFiles) {
			try {
				const url = `${baseUrl}/${file}`;
				const response = await fetchWithRetry(url, this.fetchOptions);

				if (response.ok) {
					const data = (await response.json()) as TrashCustomFormatGroup | TrashCustomFormatGroup[];
					if (Array.isArray(data)) {
						groups.push(...data);
					} else {
						groups.push(data);
					}
				}
			} catch (error) {
				console.warn(`Failed to fetch ${file}:`, error);
			}
		}

		return groups;
	}

	/**
	 * Fetch Quality Size settings for a service
	 */
	async fetchQualitySize(serviceType: "RADARR" | "SONARR"): Promise<TrashQualitySize[]> {
		const baseUrl = buildGitHubUrl(serviceType, "QUALITY_SIZE");

		const settings: TrashQualitySize[] = [];
		const knownFiles = await this.discoverConfigFiles(baseUrl);

		for (const file of knownFiles) {
			try {
				const url = `${baseUrl}/${file}`;
				const response = await fetchWithRetry(url, this.fetchOptions);

				if (response.ok) {
					const data = (await response.json()) as TrashQualitySize | TrashQualitySize[];
					if (Array.isArray(data)) {
						settings.push(...data);
					} else {
						settings.push(data);
					}
				}
			} catch (error) {
				console.warn(`Failed to fetch ${file}:`, error);
			}
		}

		return settings;
	}

	/**
	 * Fetch Naming schemes for a service
	 */
	async fetchNaming(serviceType: "RADARR" | "SONARR"): Promise<TrashNamingScheme[]> {
		const baseUrl = buildGitHubUrl(serviceType, "NAMING");

		const schemes: TrashNamingScheme[] = [];
		const knownFiles = await this.discoverConfigFiles(baseUrl);

		for (const file of knownFiles) {
			try {
				const url = `${baseUrl}/${file}`;
				const response = await fetchWithRetry(url, this.fetchOptions);

				if (response.ok) {
					const data = (await response.json()) as TrashNamingScheme | TrashNamingScheme[];
					if (Array.isArray(data)) {
						schemes.push(...data);
					} else {
						schemes.push(data);
					}
				}
			} catch (error) {
				console.warn(`Failed to fetch ${file}:`, error);
			}
		}

		return schemes;
	}

	/**
	 * Fetch Quality Profiles for a service
	 */
	async fetchQualityProfiles(serviceType: "RADARR" | "SONARR"): Promise<TrashQualityProfile[]> {
		const baseUrl = buildGitHubUrl(serviceType, "QUALITY_PROFILES");

		const profiles: TrashQualityProfile[] = [];
		const knownFiles = await this.discoverConfigFiles(baseUrl);

		for (const file of knownFiles) {
			try {
				const url = `${baseUrl}/${file}`;
				const response = await fetchWithRetry(url, this.fetchOptions);

				if (response.ok) {
					const data = (await response.json()) as TrashQualityProfile;
					profiles.push(data);
				}
			} catch (error) {
				console.warn(`Failed to fetch ${file}:`, error);
			}
		}

		return profiles;
	}

	/**
	 * Fetch a single CF description by file name
	 */
	async fetchCFDescription(cfName: string): Promise<TrashCFDescription | null> {
		try {
			const url = `${TRASH_CF_DESCRIPTIONS_BASE_URL}/${cfName}.md`;
			const response = await fetchWithRetry(url, this.fetchOptions);

			if (!response.ok) {
				console.warn(`CF description not found: ${cfName}`);
				return null;
			}

			const rawMarkdown = await response.text();

			// Extract display name from markdown (first # heading)
			const titleMatch = rawMarkdown.match(/^#\s+(.+)$/m);
			const displayName = titleMatch?.[1] || cfName;

			// Clean markdown: remove includes and title
			const cleanedMarkdown = rawMarkdown
				.replace(/--8<--.*?--8<--/gs, "") // Remove includes
				.replace(/^#\s+.+$/m, "") // Remove title
				.trim();

			// Convert markdown to HTML using marked
			const description = await marked.parse(cleanedMarkdown, {
				async: true,
				breaks: true, // Convert line breaks to <br>
				gfm: true, // Enable GitHub Flavored Markdown
			});

			return {
				cfName,
				displayName,
				description,
				rawMarkdown,
				fetchedAt: new Date().toISOString(),
			};
		} catch (error) {
			console.error(`Failed to fetch CF description for ${cfName}:`, error);
			return null;
		}
	}

	/**
	 * Fetch all CF descriptions
	 */
	async fetchAllCFDescriptions(): Promise<TrashCFDescription[]> {
		// First, discover all markdown files in cf-descriptions directory
		const apiUrl = "https://api.github.com/repos/TRaSH-Guides/Guides/contents/includes/cf-descriptions";

		try {
			const response = await fetchWithRetry(apiUrl, {
				...this.fetchOptions,
				retries: 2,
			});

			if (!response.ok) {
				console.warn(`GitHub API returned ${response.status} for CF descriptions`);
				return [];
			}

			const files = (await response.json()) as Array<{
				name: string;
				type: string;
			}>;

			// Filter for .md files only
			const mdFiles = files
				.filter((file) => file.type === "file" && file.name.endsWith(".md"))
				.map((file) => file.name.replace(/\.md$/, ""));

			console.log(`Discovered ${mdFiles.length} CF description files`);

			// Fetch all descriptions in parallel (with concurrency limit)
			const BATCH_SIZE = 10; // Process 10 at a time
			const descriptions: TrashCFDescription[] = [];

			for (let i = 0; i < mdFiles.length; i += BATCH_SIZE) {
				const batch = mdFiles.slice(i, i + BATCH_SIZE);
				const results = await Promise.all(
					batch.map((cfName) => this.fetchCFDescription(cfName))
				);

				// Filter out nulls and add to descriptions
				descriptions.push(...results.filter((desc): desc is TrashCFDescription => desc !== null));

				// Small delay between batches to avoid rate limiting
				if (i + BATCH_SIZE < mdFiles.length) {
					await delay(500);
				}
			}

			console.log(`Successfully fetched ${descriptions.length}/${mdFiles.length} CF descriptions`);
			return descriptions;
		} catch (error) {
			console.error("Failed to fetch CF descriptions:", error);
			return [];
		}
	}

	/**
	 * Generic fetch for any config type
	 */
	async fetchConfigs(
		serviceType: "RADARR" | "SONARR",
		configType: TrashConfigType,
	): Promise<unknown[]> {
		switch (configType) {
			case "CUSTOM_FORMATS":
				return this.fetchCustomFormats(serviceType);
			case "CF_GROUPS":
				return this.fetchCustomFormatGroups(serviceType);
			case "QUALITY_SIZE":
				return this.fetchQualitySize(serviceType);
			case "NAMING":
				return this.fetchNaming(serviceType);
			case "QUALITY_PROFILES":
				return this.fetchQualityProfiles(serviceType);
			case "CF_DESCRIPTIONS":
				return this.fetchAllCFDescriptions();
			default:
				throw new Error(`Unsupported config type: ${configType}`);
		}
	}

	/**
	 * Discover available config files in a directory using GitHub API
	 */
	private async discoverConfigFiles(baseUrl: string): Promise<string[]> {
		// Extract the path from the base URL
		// baseUrl format: https://raw.githubusercontent.com/TRaSH-Guides/Guides/master/docs/json/{service}/{type}
		const pathMatch = baseUrl.match(/\/master\/(.+)$/);
		if (!pathMatch) {
			console.warn(`Could not extract path from URL: ${baseUrl}`);
			return [];
		}

		const repoPath = pathMatch[1];
		const apiUrl = `https://api.github.com/repos/TRaSH-Guides/Guides/contents/${repoPath}`;

		try {
			const response = await fetchWithRetry(apiUrl, {
				...this.fetchOptions,
				retries: 2,
			});

			if (!response.ok) {
				console.warn(`GitHub API returned ${response.status} for ${apiUrl}`);
				return [];
			}

			const files = (await response.json()) as Array<{
				name: string;
				type: string;
				download_url: string | null;
			}>;

			// Filter for .json files only
			const jsonFiles = files
				.filter((file) => file.type === "file" && file.name.endsWith(".json"))
				.map((file) => file.name);

			if (jsonFiles.length === 0) {
				console.warn(`No JSON files discovered at ${baseUrl}`);
			}

			return jsonFiles;
		} catch (error) {
			console.error(`Failed to discover config files at ${baseUrl}:`, error);
			return [];
		}
	}
}

// ============================================================================
// Exports
// ============================================================================

/**
 * Create a default fetcher instance
 */
export function createTrashFetcher(options: FetchOptions = {}): TrashGitHubFetcher {
	return new TrashGitHubFetcher(options);
}

/**
 * Singleton instance for convenience
 */
export const defaultFetcher = createTrashFetcher();
