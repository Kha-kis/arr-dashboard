/**
 * TRaSH Guides GitHub Fetcher
 *
 * Fetches configuration JSON files from the TRaSH Guides GitHub repository.
 * Handles rate limiting, error recovery, and data validation.
 */

import type {
	TrashCFDescription,
	TrashCFInclude,
	TrashConfigType,
	TrashCustomFormat,
	TrashCustomFormatGroup,
	TrashNamingScheme,
	TrashQualityProfile,
	TrashQualitySize,
	TrashRepoConfig,
} from "@arr/shared";
import { DEFAULT_TRASH_REPO } from "@arr/shared";
import type { FastifyBaseLogger } from "fastify";
import DOMPurify from "isomorphic-dompurify";
import { marked } from "marked";

// ============================================================================
// Logger Interface
// ============================================================================

/**
 * Simple logger interface that matches Fastify's logger methods.
 * Allows passing a Fastify logger or using console fallback.
 */
interface Logger {
	warn: (msg: string | object, ...args: unknown[]) => void;
	error: (msg: string | object, ...args: unknown[]) => void;
	debug?: (msg: string | object, ...args: unknown[]) => void;
}

/** No-op logger for when logging is disabled */
const noopLogger: Logger = {
	warn: () => {},
	error: () => {},
	debug: () => {},
};

// ============================================================================
// HTML Sanitization Configuration
// ============================================================================

/**
 * Sanitization config for HTML generated from TRaSH Guide markdown.
 * Uses allowlist approach to prevent XSS attacks while preserving
 * necessary formatting for guide descriptions.
 */
const DOMPURIFY_CONFIG = {
	ALLOWED_TAGS: [
		"p",
		"br",
		"b",
		"i",
		"strong",
		"em",
		"a",
		"ul",
		"ol",
		"li",
		"code",
		"pre",
		"blockquote",
		"h1",
		"h2",
		"h3",
		"h4",
		"h5",
		"h6",
		"span",
		"div",
		"table",
		"thead",
		"tbody",
		"tr",
		"th",
		"td",
	],
	ALLOWED_ATTR: ["href", "target", "rel", "class", "id", "title"],
};

/**
 * Sanitize HTML content to prevent XSS attacks.
 * Should be called immediately after marked.parse() output.
 */
function sanitizeHtml(html: string): string {
	// Add noopener noreferrer to all links with target="_blank"
	const sanitized = DOMPurify.sanitize(html, DOMPURIFY_CONFIG);
	// DOMPurify handles most security concerns; add rel attributes for external links
	return sanitized.replace(
		/<a([^>]*?)target="_blank"([^>]*?)>/gi,
		'<a$1target="_blank" rel="noopener noreferrer"$2>',
	);
}

// ============================================================================
// Constants
// ============================================================================

const FETCH_TIMEOUT_MS = 15000; // 15 seconds
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 1000; // 1 second

// Rate limit thresholds
const RATE_LIMIT_WARNING_THRESHOLD = 10; // Warn when remaining < 10
const RATE_LIMIT_BLOCK_THRESHOLD = 2; // Block new requests when remaining < 2

// ============================================================================
// Rate Limit Tracking
// ============================================================================

/**
 * Rate limit state for GitHub API.
 * GitHub returns these headers on every API response:
 * - X-RateLimit-Limit: Total requests allowed per hour
 * - X-RateLimit-Remaining: Requests remaining in current window
 * - X-RateLimit-Reset: Unix timestamp when the rate limit resets
 */
export interface GitHubRateLimitState {
	limit: number;
	remaining: number;
	resetAt: Date;
	lastUpdated: Date;
	isAuthenticated: boolean;
}

// Singleton rate limit state (shared across all fetcher instances)
let rateLimitState: GitHubRateLimitState | null = null;

/**
 * Get the current rate limit state
 */
export function getRateLimitState(): GitHubRateLimitState | null {
	return rateLimitState;
}

/**
 * Update rate limit state from response headers
 */
function updateRateLimitFromResponse(response: Response, isAuthenticated: boolean): void {
	const limit = response.headers.get("X-RateLimit-Limit");
	const remaining = response.headers.get("X-RateLimit-Remaining");
	const reset = response.headers.get("X-RateLimit-Reset");

	if (limit && remaining && reset) {
		rateLimitState = {
			limit: Number.parseInt(limit, 10),
			remaining: Number.parseInt(remaining, 10),
			resetAt: new Date(Number.parseInt(reset, 10) * 1000),
			lastUpdated: new Date(),
			isAuthenticated,
		};
	}
}

/**
 * Check if we should block due to rate limiting.
 * Returns time to wait in milliseconds, or 0 if we can proceed.
 */
function checkRateLimitBlock(): number {
	if (!rateLimitState) return 0;

	// If we're below the block threshold and reset time is in the future
	if (rateLimitState.remaining < RATE_LIMIT_BLOCK_THRESHOLD) {
		const now = Date.now();
		const resetTime = rateLimitState.resetAt.getTime();
		if (resetTime > now) {
			return resetTime - now;
		}
	}

	return 0;
}

// ============================================================================
// Types
// ============================================================================

interface FetchOptions {
	timeout?: number;
	retries?: number;
	retryDelay?: number;
	/**
	 * GitHub Personal Access Token for authenticated API requests.
	 * Unauthenticated requests are limited to 60/hour.
	 * Authenticated requests allow 5,000/hour.
	 */
	githubToken?: string;
	/**
	 * Optional logger for debug/error output.
	 * If not provided, uses no-op logger (silent).
	 */
	logger?: Logger | FastifyBaseLogger;
	/**
	 * Custom repository configuration. If not provided, uses official TRaSH-Guides/Guides.
	 * Forks must follow the same directory structure as the official repo.
	 */
	repoConfig?: TrashRepoConfig;
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
 * Build headers for fetch requests
 */
function buildHeaders(githubToken?: string, isGitHubApi = false): Record<string, string> {
	const headers: Record<string, string> = {
		"User-Agent": "arr-dashboard/2.3.0", // Identify ourselves
	};

	// Add authentication for GitHub API requests if token is provided
	if (githubToken && isGitHubApi) {
		headers.Authorization = `Bearer ${githubToken}`;
		headers["X-GitHub-Api-Version"] = "2022-11-28";
	}

	return headers;
}

/**
 * Fetch with timeout support
 */
async function fetchWithTimeout(
	url: string,
	timeout: number,
	headers?: Record<string, string>,
): Promise<Response> {
	const controller = new AbortController();
	const timeoutId = setTimeout(() => controller.abort(), timeout);

	try {
		const response = await fetch(url, {
			signal: controller.signal,
			headers: headers || {
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
 * Fetch with retry logic and proactive rate limit tracking
 */
async function fetchWithRetry(
	url: string,
	options: FetchOptions = {},
	log: Logger = noopLogger,
): Promise<Response> {
	const {
		timeout = FETCH_TIMEOUT_MS,
		retries = MAX_RETRIES,
		retryDelay = RETRY_DELAY_MS,
		githubToken,
	} = options;

	// Determine if this is a GitHub API request (vs raw.githubusercontent.com)
	const isGitHubApi = new URL(url).hostname === "api.github.com";
	const headers = buildHeaders(githubToken, isGitHubApi);

	// Proactive rate limit check (only for GitHub API requests)
	if (isGitHubApi) {
		const waitTime = checkRateLimitBlock();
		if (waitTime > 0) {
			log.warn(
				`Proactive rate limit wait: ${Math.ceil(waitTime / 1000)}s until reset. ` +
					`Current remaining: ${rateLimitState?.remaining ?? "unknown"}`,
			);
			await delay(waitTime + 1000); // Add 1s buffer
		}
	}

	let lastError: Error | undefined;

	for (let attempt = 1; attempt <= retries; attempt++) {
		try {
			const response = await fetchWithTimeout(url, timeout, headers);

			// Update rate limit state from response (GitHub API only)
			if (isGitHubApi) {
				updateRateLimitFromResponse(response, !!githubToken);

				// Log warning when getting low on requests
				if (
					rateLimitState &&
					rateLimitState.remaining < RATE_LIMIT_WARNING_THRESHOLD &&
					rateLimitState.remaining > 0
				) {
					const resetIn = Math.ceil((rateLimitState.resetAt.getTime() - Date.now()) / 1000 / 60);
					log.warn(
						`GitHub API rate limit warning: ${rateLimitState.remaining} requests remaining. ` +
							`Resets in ${resetIn} minutes. ` +
							`${rateLimitState.isAuthenticated ? "(authenticated: 5000/hr)" : "(unauthenticated: 60/hr - set GITHUB_TOKEN for higher limits)"}`,
					);
				}
			}

			// Check for GitHub rate limiting (reactive - 429 response)
			if (response.status === 429) {
				const retryAfter = response.headers.get("Retry-After");
				const waitTime = retryAfter
					? Number.parseInt(retryAfter, 10) * 1000
					: Math.min(retryDelay * Math.pow(2, attempt - 1) + Math.random() * 1000, 60000);
				const rateLimitRemaining = response.headers.get("X-RateLimit-Remaining");
				const rateLimitReset = response.headers.get("X-RateLimit-Reset");

				// Update state from 429 response
				if (isGitHubApi) {
					updateRateLimitFromResponse(response, !!githubToken);
				}

				if (!githubToken) {
					log.warn(
						`GitHub rate limit hit (unauthenticated: 60 req/hour). Consider setting GITHUB_TOKEN for 5,000 req/hour. Retrying after ${waitTime}ms`,
					);
				} else {
					log.warn(
						`GitHub rate limit hit. Remaining: ${rateLimitRemaining}, ` +
							`Reset: ${rateLimitReset ? new Date(Number.parseInt(rateLimitReset, 10) * 1000).toISOString() : "unknown"}. ` +
							`Retrying after ${waitTime}ms`,
					);
				}
				await delay(waitTime);
				continue;
			}

			// Success or non-retryable error
			if (response.ok || response.status === 404) {
				return response;
			}

			// Server errors are retryable
			if (response.status >= 500) {
				log.warn(`GitHub server error (${response.status}), attempt ${attempt}/${retries}`);
				if (attempt < retries) {
					await delay(retryDelay * attempt); // Exponential backoff
					continue;
				}
			}

			// Other errors
			throw new Error(`HTTP ${response.status}: ${response.statusText}`);
		} catch (error) {
			lastError = error instanceof Error ? error : new Error(String(error));
			log.error(`Fetch attempt ${attempt}/${retries} failed:`, lastError.message);

			if (attempt < retries) {
				await delay(retryDelay * attempt); // Exponential backoff
			}
		}
	}

	throw lastError || new Error("Fetch failed after all retries");
}

// ============================================================================
// Supplementary Merge Helpers
// ============================================================================

/**
 * Extract a dedup key from a config item.
 * Supports all TRaSH config types:
 * - TrashCustomFormat, TrashQualityProfile, TrashQualitySize, etc. → `trash_id`
 * - TrashCFDescription → `cfName`
 * - TrashCFInclude → `path`
 */
function getItemKey(item: unknown): string | undefined {
	if (!item || typeof item !== "object") return undefined;
	if ("trash_id" in item) return (item as { trash_id: string }).trash_id;
	if ("cfName" in item) return (item as { cfName: string }).cfName;
	if ("path" in item) return (item as { path: string }).path;
	return undefined;
}

/**
 * Merge official and custom config arrays using a "base + overlay" strategy.
 * Custom items override official items when they share the same key.
 * Items without a key are concatenated (no dedup possible).
 */
function mergeByTrashId<T>(official: T[], custom: T[]): T[] {
	const customKeys = new Set<string>();
	for (const item of custom) {
		const key = getItemKey(item);
		if (key) customKeys.add(key);
	}
	const base = official.filter((item) => {
		const key = getItemKey(item);
		return !key || !customKeys.has(key);
	});

	// Tag shallow copies with source repo for provenance tracking (avoids mutating inputs)
	const taggedBase = base.map((item) =>
		item && typeof item === "object"
			? ({ ...item, _repoSource: "official" as const } as T)
			: item,
	);
	const taggedCustom = custom.map((item) =>
		item && typeof item === "object"
			? ({ ...item, _repoSource: "custom" as const } as T)
			: item,
	);

	return [...taggedBase, ...taggedCustom];
}

// ============================================================================
// Main Fetcher Class
// ============================================================================

export class TrashGitHubFetcher {
	private fetchOptions: FetchOptions;
	private log: Logger;
	private repoConfig: TrashRepoConfig;

	// Instance-specific URLs built from repoConfig
	private baseUrl: string;
	private metadataUrl: string;
	private cfDescriptionsBaseUrl: string;
	private repoContentsApiUrl: string;
	private rawBaseUrl: string;

	constructor(options: FetchOptions = {}) {
		this.fetchOptions = options;
		// Use provided logger or no-op logger (silent by default)
		this.log = (options.logger as Logger) ?? noopLogger;

		// Build URLs from repo config (custom fork or official)
		this.repoConfig = options.repoConfig ?? DEFAULT_TRASH_REPO;
		const { owner, name, branch } = this.repoConfig;
		this.rawBaseUrl = `https://raw.githubusercontent.com/${owner}/${name}/${branch}`;
		this.baseUrl = `${this.rawBaseUrl}/docs/json`;
		this.metadataUrl = `${this.rawBaseUrl}/metadata.json`;
		this.cfDescriptionsBaseUrl = `${this.rawBaseUrl}/includes/cf-descriptions`;
		this.repoContentsApiUrl = `https://api.github.com/repos/${owner}/${name}/contents`;
	}

	/**
	 * Build GitHub raw URL for specific config type and service
	 */
	private buildGitHubUrl(serviceType: "RADARR" | "SONARR", configType: TrashConfigType): string {
		const service = serviceType.toLowerCase();

		switch (configType) {
			case "CUSTOM_FORMATS":
				return `${this.baseUrl}/${service}/cf`;
			case "CF_GROUPS":
				return `${this.baseUrl}/${service}/cf-groups`;
			case "QUALITY_SIZE":
				return `${this.baseUrl}/${service}/quality-size`;
			case "NAMING":
				return `${this.baseUrl}/${service}/naming`;
			case "QUALITY_PROFILES":
				return `${this.baseUrl}/${service}/quality-profiles`;
			default:
				throw new Error(`Unknown config type: ${configType}`);
		}
	}

	/**
	 * Fetch TRaSH Guides metadata
	 */
	async fetchMetadata(): Promise<TrashMetadata> {
		const response = await fetchWithRetry(this.metadataUrl, this.fetchOptions, this.log);

		if (!response.ok) {
			throw new Error(`Failed to fetch metadata: ${response.statusText}`);
		}

		return (await response.json()) as TrashMetadata;
	}

	/**
	 * Fetch Custom Formats for a service
	 */
	async fetchCustomFormats(serviceType: "RADARR" | "SONARR"): Promise<TrashCustomFormat[]> {
		const baseUrl = this.buildGitHubUrl(serviceType, "CUSTOM_FORMATS");

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
				const response = await fetchWithRetry(url, this.fetchOptions, this.log);

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
				this.log.warn(`Failed to fetch ${file}:`, error);
				// Continue with other files
			}
		}

		return formats;
	}

	/**
	 * Fetch Custom Format Groups for a service
	 */
	async fetchCustomFormatGroups(
		serviceType: "RADARR" | "SONARR",
	): Promise<TrashCustomFormatGroup[]> {
		const baseUrl = this.buildGitHubUrl(serviceType, "CF_GROUPS");

		const groups: TrashCustomFormatGroup[] = [];
		const knownFiles = await this.discoverConfigFiles(baseUrl);

		for (const file of knownFiles) {
			try {
				const url = `${baseUrl}/${file}`;
				const response = await fetchWithRetry(url, this.fetchOptions, this.log);

				if (response.ok) {
					const data = (await response.json()) as TrashCustomFormatGroup | TrashCustomFormatGroup[];
					if (Array.isArray(data)) {
						groups.push(...data);
					} else {
						groups.push(data);
					}
				}
			} catch (error) {
				this.log.warn(`Failed to fetch ${file}:`, error);
			}
		}

		return groups;
	}

	/**
	 * Fetch Quality Size settings for a service
	 */
	async fetchQualitySize(serviceType: "RADARR" | "SONARR"): Promise<TrashQualitySize[]> {
		const baseUrl = this.buildGitHubUrl(serviceType, "QUALITY_SIZE");

		const settings: TrashQualitySize[] = [];
		const knownFiles = await this.discoverConfigFiles(baseUrl);

		for (const file of knownFiles) {
			try {
				const url = `${baseUrl}/${file}`;
				const response = await fetchWithRetry(url, this.fetchOptions, this.log);

				if (response.ok) {
					const data = (await response.json()) as TrashQualitySize | TrashQualitySize[];
					if (Array.isArray(data)) {
						settings.push(...data);
					} else {
						settings.push(data);
					}
				}
			} catch (error) {
				this.log.warn(`Failed to fetch ${file}:`, error);
			}
		}

		return settings;
	}

	/**
	 * Fetch Naming schemes for a service
	 */
	async fetchNaming(serviceType: "RADARR" | "SONARR"): Promise<TrashNamingScheme[]> {
		const baseUrl = this.buildGitHubUrl(serviceType, "NAMING");

		const schemes: TrashNamingScheme[] = [];
		const knownFiles = await this.discoverConfigFiles(baseUrl);

		for (const file of knownFiles) {
			try {
				const url = `${baseUrl}/${file}`;
				const response = await fetchWithRetry(url, this.fetchOptions, this.log);

				if (response.ok) {
					const data = (await response.json()) as TrashNamingScheme | TrashNamingScheme[];
					if (Array.isArray(data)) {
						schemes.push(...data);
					} else {
						schemes.push(data);
					}
				}
			} catch (error) {
				this.log.warn(`Failed to fetch ${file}:`, error);
			}
		}

		return schemes;
	}

	/**
	 * Fetch Quality Profiles for a service
	 */
	async fetchQualityProfiles(serviceType: "RADARR" | "SONARR"): Promise<TrashQualityProfile[]> {
		const baseUrl = this.buildGitHubUrl(serviceType, "QUALITY_PROFILES");

		const profiles: TrashQualityProfile[] = [];
		const knownFiles = await this.discoverConfigFiles(baseUrl);

		for (const file of knownFiles) {
			try {
				const url = `${baseUrl}/${file}`;
				const response = await fetchWithRetry(url, this.fetchOptions, this.log);

				if (response.ok) {
					const data = (await response.json()) as TrashQualityProfile | TrashQualityProfile[];
					// Handle both single profile and array of profiles
					if (Array.isArray(data)) {
						profiles.push(...data);
					} else {
						profiles.push(data);
					}
				}
			} catch (error) {
				this.log.warn(`Failed to fetch ${file}:`, error);
			}
		}

		return profiles;
	}

	/**
	 * Fetch a single CF description by file name
	 */
	async fetchCFDescription(cfName: string): Promise<TrashCFDescription | null> {
		try {
			const url = `${this.cfDescriptionsBaseUrl}/${cfName}.md`;
			const response = await fetchWithRetry(url, this.fetchOptions, this.log);

			if (!response.ok) {
				this.log.warn(`CF description not found: ${cfName}`);
				return null;
			}

			const rawMarkdown = await response.text();

			// Extract display name from markdown (first # heading)
			const titleMatch = rawMarkdown.match(/^#\s+(.+)$/m);
			const displayName = titleMatch?.[1] || cfName;

			// NOTE: Include resolution is disabled for performance.
			// Making 100+ additional network requests during cache refresh was crashing the server.
			// The frontend cleanDescription() strips include directives for display.
			// Future: Consider on-demand resolution when viewing individual CF details.

			// Clean markdown: remove title and Kramdown-specific syntax
			const cleanedMarkdown = rawMarkdown
				.replace(/^#\s+.+$/m, "") // Remove title
				.replace(/\{:target="_blank"\s*rel="noopener noreferrer"\}/g, "") // Remove Kramdown link attributes
				.replace(/\{:.*?\}/g, "") // Remove any other Kramdown inline attributes
				.trim();

			// Convert markdown to HTML using marked, then sanitize to prevent XSS
			const rawHtml = await marked.parse(cleanedMarkdown, {
				async: true,
				breaks: true, // Convert line breaks to <br>
				gfm: true, // Enable GitHub Flavored Markdown
			});
			const description = sanitizeHtml(rawHtml);

			return {
				cfName,
				displayName,
				description,
				rawMarkdown, // Store raw markdown (includes not resolved)
				fetchedAt: new Date().toISOString(),
			};
		} catch (error) {
			this.log.error(`Failed to fetch CF description for ${cfName}:`, error);
			return null;
		}
	}

	/**
	 * Fetch all CF descriptions
	 */
	async fetchAllCFDescriptions(): Promise<TrashCFDescription[]> {
		// First, discover all markdown files in cf-descriptions directory
		const apiUrl = `${this.repoContentsApiUrl}/includes/cf-descriptions`;

		try {
			const response = await fetchWithRetry(apiUrl, { ...this.fetchOptions, retries: 2 }, this.log);

			if (!response.ok) {
				this.log.warn(`GitHub API returned ${response.status} for CF descriptions`);
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

			// Fetch all descriptions in parallel (with concurrency limit)
			const BATCH_SIZE = 10; // Process 10 at a time
			const descriptions: TrashCFDescription[] = [];

			for (let i = 0; i < mdFiles.length; i += BATCH_SIZE) {
				const batch = mdFiles.slice(i, i + BATCH_SIZE);
				const results = await Promise.all(batch.map((cfName) => this.fetchCFDescription(cfName)));

				// Filter out nulls and add to descriptions
				descriptions.push(...results.filter((desc): desc is TrashCFDescription => desc !== null));

				// Small delay between batches to avoid rate limiting
				if (i + BATCH_SIZE < mdFiles.length) {
					await delay(500);
				}
			}

			return descriptions;
		} catch (error) {
			this.log.error("Failed to fetch CF descriptions:", error);
			return [];
		}
	}

	/**
	 * Fetch MkDocs include files that are actually referenced by CF descriptions.
	 * Only fetches files that match known include patterns (not CF descriptions).
	 *
	 * Include files are short, reusable snippets like:
	 * - apply-*.md (scoring application instructions)
	 * - *-info.md (additional info sections)
	 *
	 * CF descriptions are named after specific formats (br-disk.md, dv.md, etc.)
	 */
	async fetchCFIncludes(): Promise<TrashCFInclude[]> {
		// Known include file patterns - these are reusable snippets, not CF descriptions
		// Include files typically have action-oriented or generic names
		const KNOWN_INCLUDE_PATTERNS = [
			/^apply-\d+\.md$/, // apply-10000.md, apply-5000.md, etc.
			/^.*-info\.md$/, // *-info.md pattern
			/^common-.*\.md$/, // common-*.md pattern
			/^note-.*\.md$/, // note-*.md pattern
		];

		const INCLUDES_BASE = "includes/cf-descriptions";
		const apiUrl = `${this.repoContentsApiUrl}/${INCLUDES_BASE}`;
		const GITHUB_RAW_BASE = this.rawBaseUrl;

		try {
			const response = await fetchWithRetry(apiUrl, { ...this.fetchOptions, retries: 2 }, this.log);

			if (!response.ok) {
				this.log.warn(`GitHub API returned ${response.status} for CF includes`);
				return [];
			}

			const files = (await response.json()) as Array<{
				name: string;
				type: string;
			}>;

			// Filter for .md files that match known include patterns
			const includeFiles = files
				.filter((file) => {
					if (file.type !== "file" || !file.name.endsWith(".md")) return false;
					// Check if filename matches any known include pattern
					return KNOWN_INCLUDE_PATTERNS.some((pattern) => pattern.test(file.name));
				})
				.map((file) => file.name);

			this.log.debug?.(`Found ${includeFiles.length} include files matching patterns`);

			if (includeFiles.length === 0) {
				return [];
			}

			// Fetch all include files in parallel
			const results = await Promise.all(
				includeFiles.map(async (fileName) => {
					try {
						const path = `${INCLUDES_BASE}/${fileName}`;
						const url = `${GITHUB_RAW_BASE}/${path}`;
						const fetchResponse = await fetchWithRetry(
							url,
							{ ...this.fetchOptions, retries: 1 },
							this.log,
						);

						if (fetchResponse.ok) {
							let content = await fetchResponse.text();
							// Clean the content: iteratively remove HTML comments
							const commentPattern = /<!--.*?-->/gs;
							while (commentPattern.test(content)) {
								content = content.replace(commentPattern, "");
								commentPattern.lastIndex = 0;
							}
							content = content.trim();
							return {
								path,
								content,
								fetchedAt: new Date().toISOString(),
							} as TrashCFInclude;
						}
						return null;
					} catch (_error) {
						this.log.warn(`Failed to fetch include file: ${fileName}`);
						return null;
					}
				}),
			);

			const includes = results.filter((inc): inc is TrashCFInclude => inc !== null);
			this.log.debug?.(`Fetched ${includes.length} CF include files`);
			return includes;
		} catch (error) {
			this.log.error("Failed to fetch CF includes:", error);
			return [];
		}
	}

	/**
	 * Generic fetch for any config type.
	 * When mode is "supplementary", fetches from both official and custom repos
	 * in parallel, then merges results (custom overrides official by key).
	 */
	async fetchConfigs(
		serviceType: "RADARR" | "SONARR",
		configType: TrashConfigType,
	): Promise<unknown[]> {
		if (this.repoConfig.mode === "supplementary") {
			const officialFetcher = new TrashGitHubFetcher({
				...this.fetchOptions,
				repoConfig: DEFAULT_TRASH_REPO, // mode undefined = no recursion
			});
			const [official, custom] = await Promise.all([
				officialFetcher.fetchConfigsFromRepo(serviceType, configType),
				this.fetchConfigsFromRepo(serviceType, configType),
			]);
			return mergeByTrashId(official, custom);
		}
		return this.fetchConfigsFromRepo(serviceType, configType);
	}

	/**
	 * Fetch configs from this fetcher's single repo (no merge logic).
	 */
	private async fetchConfigsFromRepo(
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
			case "CF_INCLUDES":
				return this.fetchCFIncludes();
			default:
				throw new Error(`Unsupported config type: ${configType}`);
		}
	}

	/**
	 * Discover available config files in a directory using GitHub API
	 */
	private async discoverConfigFiles(baseUrl: string): Promise<string[]> {
		// Extract the path after the branch segment in the raw URL
		// baseUrl format: https://raw.githubusercontent.com/{owner}/{name}/{branch}/docs/json/{service}/{type}
		const branchEscaped = this.repoConfig.branch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		const pathMatch = baseUrl.match(new RegExp(`/${branchEscaped}/(.+)$`));
		if (!pathMatch) {
			this.log.warn(`Could not extract path from URL: ${baseUrl}`);
			return [];
		}

		const repoPath = pathMatch[1];
		const apiUrl = `${this.repoContentsApiUrl}/${repoPath}`;

		try {
			const response = await fetchWithRetry(apiUrl, { ...this.fetchOptions, retries: 2 }, this.log);

			if (!response.ok) {
				this.log.warn(`GitHub API returned ${response.status} for ${apiUrl}`);
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
				this.log.warn(`No JSON files discovered at ${baseUrl}`);
			}

			return jsonFiles;
		} catch (error) {
			this.log.error(`Failed to discover config files at ${baseUrl}:`, error);
			return [];
		}
	}
}

// ============================================================================
// Exports
// ============================================================================

/**
 * Create a fetcher instance with optional configuration.
 * If no githubToken is provided, attempts to read from GITHUB_TOKEN environment variable.
 * If no repoConfig is provided, uses the official TRaSH-Guides/Guides repository.
 */
export function createTrashFetcher(options: FetchOptions = {}): TrashGitHubFetcher {
	// Auto-inject GitHub token from environment if not provided
	const resolvedOptions: FetchOptions = {
		...options,
		githubToken: options.githubToken ?? process.env.GITHUB_TOKEN,
	};

	return new TrashGitHubFetcher(resolvedOptions);
}
