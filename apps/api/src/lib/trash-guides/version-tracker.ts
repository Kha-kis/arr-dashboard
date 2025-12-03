/**
 * TRaSH Guides Version Tracker
 *
 * Tracks TRaSH Guides repository versions via GitHub API.
 * Fetches latest commit hashes to detect when new updates are available.
 */

// ============================================================================
// Constants
// ============================================================================

const GITHUB_API_BASE = "https://api.github.com";
const TRASH_REPO = "TRaSH-Guides/Guides";
const TRASH_BRANCH = "master";

const FETCH_TIMEOUT_MS = 10000; // 10 seconds
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 1000;

// ============================================================================
// Types
// ============================================================================

export interface GitHubCommit {
	sha: string;
	commit: {
		author: {
			name: string;
			email: string;
			date: string;
		};
		message: string;
	};
	html_url: string;
}

export interface VersionInfo {
	commitHash: string;
	commitDate: string;
	commitMessage: string;
	commitUrl: string;
}

interface FetchOptions {
	timeout?: number;
	retries?: number;
	retryDelay?: number;
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
async function fetchWithTimeout(url: string, timeout: number, headers?: Record<string, string>): Promise<Response> {
	const controller = new AbortController();
	const timeoutId = setTimeout(() => controller.abort(), timeout);

	try {
		const response = await fetch(url, {
			signal: controller.signal,
			headers: {
				"User-Agent": "arr-dashboard/2.3.0",
				Accept: "application/vnd.github.v3+json",
				...headers,
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
async function fetchWithRetry(url: string, options: FetchOptions = {}, headers?: Record<string, string>): Promise<Response> {
	const {
		timeout = FETCH_TIMEOUT_MS,
		retries = MAX_RETRIES,
		retryDelay = RETRY_DELAY_MS,
	} = options;

	let lastError: Error | undefined;

	for (let attempt = 1; attempt <= retries; attempt++) {
		try {
			const response = await fetchWithTimeout(url, timeout, headers);

			// Check for rate limiting
			if (response.status === 403) {
				const rateLimitRemaining = response.headers.get("X-RateLimit-Remaining");
				if (rateLimitRemaining === "0") {
					const resetTime = response.headers.get("X-RateLimit-Reset");
					throw new Error(
						`GitHub API rate limit exceeded. Resets at ${resetTime ? new Date(Number.parseInt(resetTime) * 1000).toISOString() : "unknown"}`,
					);
				}
			}

			if (!response.ok) {
				throw new Error(`GitHub API returned ${response.status}: ${response.statusText}`);
			}

			return response;
		} catch (error) {
			lastError = error instanceof Error ? error : new Error(String(error));

			// Don't retry rate limit errors
			if (lastError.message.includes("rate limit")) {
				throw lastError;
			}

			if (attempt < retries) {
				await delay(retryDelay * 2 ** (attempt - 1)); // Exponential backoff (1x, 2x, 4x...)
			}
		}
	}

	throw lastError || new Error("Failed to fetch after retries");
}

// ============================================================================
// Version Tracker Service
// ============================================================================

export interface VersionTracker {
	getLatestCommit(): Promise<VersionInfo>;
	getCommitInfo(commitHash: string): Promise<VersionInfo>;
	compareCommits(oldHash: string, newHash: string): Promise<{
		isDifferent: boolean;
		oldCommit: VersionInfo;
		newCommit: VersionInfo;
	}>;
}

export function createVersionTracker(): VersionTracker {
	// Optional GitHub token for higher rate limits (5000/hour vs 60/hour)
	const githubToken = process.env.GITHUB_TOKEN;

	const headers = githubToken
		? { Authorization: `Bearer ${githubToken}` }
		: undefined;

	/**
	 * Get the latest commit on the master branch
	 */
	async function getLatestCommit(): Promise<VersionInfo> {
		const url = `${GITHUB_API_BASE}/repos/${TRASH_REPO}/commits/${TRASH_BRANCH}`;

		const response = await fetchWithRetry(url, {}, headers);
		const commit: GitHubCommit = await response.json();

		return {
			commitHash: commit.sha,
			commitDate: commit.commit.author.date,
			commitMessage: commit.commit.message,
			commitUrl: commit.html_url,
		};
	}

	/**
	 * Get information about a specific commit
	 */
	async function getCommitInfo(commitHash: string): Promise<VersionInfo> {
		const url = `${GITHUB_API_BASE}/repos/${TRASH_REPO}/commits/${commitHash}`;

		const response = await fetchWithRetry(url, {}, headers);
		const commit: GitHubCommit = await response.json();

		return {
			commitHash: commit.sha,
			commitDate: commit.commit.author.date,
			commitMessage: commit.commit.message,
			commitUrl: commit.html_url,
		};
	}

	/**
	 * Compare two commits to check if they're different
	 */
	async function compareCommits(
		oldHash: string,
		newHash: string,
	): Promise<{
		isDifferent: boolean;
		oldCommit: VersionInfo;
		newCommit: VersionInfo;
	}> {
		// Optimization: if hashes match, no need to fetch
		if (oldHash === newHash) {
			const commit = await getCommitInfo(oldHash);
			return {
				isDifferent: false,
				oldCommit: commit,
				newCommit: commit,
			};
		}

		// Fetch both commits in parallel
		const [oldCommit, newCommit] = await Promise.all([
			getCommitInfo(oldHash),
			getCommitInfo(newHash),
		]);

		return {
			isDifferent: oldCommit.commitHash !== newCommit.commitHash,
			oldCommit,
			newCommit,
		};
	}

	return {
		getLatestCommit,
		getCommitInfo,
		compareCommits,
	};
}
