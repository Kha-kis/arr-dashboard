import type { HuntConfig, HuntExclusion, ServiceInstance } from "@prisma/client";
import type { FastifyInstance } from "fastify";
import { createInstanceFetcher, type InstanceFetcher } from "../arr/arr-fetcher.js";

/**
 * Hunt Executor
 *
 * Executes hunts against Sonarr/Radarr instances to find missing content
 * and trigger quality upgrade searches.
 */

export interface HuntResult {
	itemsSearched: number;
	itemsFound: number;
	foundItems: string[];
	message: string;
	status: "completed" | "partial" | "skipped" | "error";
}

interface WantedEpisode {
	id: number;
	seriesId: number;
	episodeNumber: number;
	seasonNumber: number;
	title: string;
	series?: {
		title: string;
	};
}

interface WantedMovie {
	id: number;
	title: string;
	year?: number;
}

interface WantedResponse<T> {
	page: number;
	pageSize: number;
	totalRecords: number;
	records: T[];
}

interface QueueItem {
	id: number;
}

interface QueueResponse {
	totalRecords: number;
	records: QueueItem[];
}

/**
 * Execute a hunt for missing content or quality upgrades
 */
export async function executeHunt(
	app: FastifyInstance,
	instance: ServiceInstance,
	config: HuntConfig,
	type: "missing" | "upgrade",
	exclusions: HuntExclusion[],
): Promise<HuntResult> {
	const fetcher = createInstanceFetcher(app, instance);
	const service = instance.service.toLowerCase();

	// Check queue threshold first
	const queueCheck = await checkQueueThreshold(fetcher, config.queueThreshold);
	if (!queueCheck.ok) {
		return {
			itemsSearched: 0,
			itemsFound: 0,
			foundItems: [],
			message: queueCheck.message,
			status: "skipped",
		};
	}

	const batchSize = type === "missing" ? config.missingBatchSize : config.upgradeBatchSize;

	if (service === "sonarr") {
		return executeSonarrHunt(fetcher, type, batchSize, exclusions);
	} else if (service === "radarr") {
		return executeRadarrHunt(fetcher, type, batchSize, exclusions);
	}

	return {
		itemsSearched: 0,
		itemsFound: 0,
		foundItems: [],
		message: `Unsupported service type: ${service}`,
		status: "error",
	};
}

/**
 * Check if the instance queue is below the threshold
 */
async function checkQueueThreshold(
	fetcher: InstanceFetcher,
	threshold: number,
): Promise<{ ok: boolean; message: string }> {
	if (threshold <= 0) {
		return { ok: true, message: "Queue threshold check disabled" };
	}

	try {
		const response = await fetcher("/api/v3/queue?pageSize=1");
		const data = (await response.json()) as QueueResponse;
		const queueCount = data.totalRecords ?? 0;

		if (queueCount >= threshold) {
			return {
				ok: false,
				message: `Queue (${queueCount}) exceeds threshold (${threshold})`,
			};
		}

		return { ok: true, message: `Queue (${queueCount}) below threshold (${threshold})` };
	} catch (error) {
		// If we can't check the queue, proceed anyway
		console.warn("[HuntExecutor] Failed to check queue:", error);
		return { ok: true, message: "Queue check failed, proceeding anyway" };
	}
}

/**
 * Execute hunt for Sonarr instance
 */
async function executeSonarrHunt(
	fetcher: InstanceFetcher,
	type: "missing" | "upgrade",
	batchSize: number,
	exclusions: HuntExclusion[],
): Promise<HuntResult> {
	try {
		// Get wanted episodes
		const endpoint = type === "missing" ? "/api/v3/wanted/missing" : "/api/v3/wanted/cutoff";
		const response = await fetcher(`${endpoint}?pageSize=${batchSize}&sortKey=airDateUtc&sortDirection=descending`);
		const data = (await response.json()) as WantedResponse<WantedEpisode>;

		if (!data.records || data.records.length === 0) {
			return {
				itemsSearched: 0,
				itemsFound: 0,
				foundItems: [],
				message: `No ${type === "missing" ? "missing" : "upgradeable"} episodes found`,
				status: "completed",
			};
		}

		// Filter out excluded series
		const excludedSeriesIds = new Set(
			exclusions.filter((e) => e.mediaType === "series").map((e) => e.mediaId.toString()),
		);

		const eligibleEpisodes = data.records.filter((ep) => !excludedSeriesIds.has(ep.seriesId.toString()));

		if (eligibleEpisodes.length === 0) {
			return {
				itemsSearched: 0,
				itemsFound: 0,
				foundItems: [],
				message: "All candidates are excluded",
				status: "completed",
			};
		}

		// Trigger search for eligible episodes
		const episodeIds = eligibleEpisodes.slice(0, batchSize).map((ep) => ep.id);
		const foundItems = eligibleEpisodes.slice(0, batchSize).map(
			(ep) => `${ep.series?.title ?? "Unknown"} S${String(ep.seasonNumber).padStart(2, "0")}E${String(ep.episodeNumber).padStart(2, "0")}`,
		);

		await fetcher("/api/v3/command", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				name: "EpisodeSearch",
				episodeIds,
			}),
		});

		return {
			itemsSearched: episodeIds.length,
			itemsFound: episodeIds.length,
			foundItems,
			message: `Triggered search for ${episodeIds.length} episodes`,
			status: "completed",
		};
	} catch (error) {
		const message = error instanceof Error ? error.message : "Unknown error";
		return {
			itemsSearched: 0,
			itemsFound: 0,
			foundItems: [],
			message: `Sonarr hunt failed: ${message}`,
			status: "error",
		};
	}
}

/**
 * Execute hunt for Radarr instance
 */
async function executeRadarrHunt(
	fetcher: InstanceFetcher,
	type: "missing" | "upgrade",
	batchSize: number,
	exclusions: HuntExclusion[],
): Promise<HuntResult> {
	try {
		let movies: WantedMovie[] = [];

		if (type === "missing") {
			// For missing, get all movies and filter to those without files
			const response = await fetcher("/api/v3/movie");
			const allMovies = (await response.json()) as Array<WantedMovie & { hasFile: boolean; monitored: boolean }>;
			movies = allMovies
				.filter((m) => m.monitored && !m.hasFile)
				.slice(0, batchSize);
		} else {
			// For upgrades, use wanted/cutoff endpoint
			const response = await fetcher(`/api/v3/wanted/cutoff?pageSize=${batchSize}&sortKey=digitalRelease&sortDirection=descending`);
			const data = (await response.json()) as WantedResponse<WantedMovie>;
			movies = data.records ?? [];
		}

		if (movies.length === 0) {
			return {
				itemsSearched: 0,
				itemsFound: 0,
				foundItems: [],
				message: `No ${type === "missing" ? "missing" : "upgradeable"} movies found`,
				status: "completed",
			};
		}

		// Filter out excluded movies
		const excludedMovieIds = new Set(
			exclusions.filter((e) => e.mediaType === "movie").map((e) => e.mediaId.toString()),
		);

		const eligibleMovies = movies.filter((m) => !excludedMovieIds.has(m.id.toString()));

		if (eligibleMovies.length === 0) {
			return {
				itemsSearched: 0,
				itemsFound: 0,
				foundItems: [],
				message: "All candidates are excluded",
				status: "completed",
			};
		}

		// Trigger search for eligible movies
		const movieIds = eligibleMovies.slice(0, batchSize).map((m) => m.id);
		const foundItems = eligibleMovies.slice(0, batchSize).map((m) => `${m.title} (${m.year ?? "?"})`);

		await fetcher("/api/v3/command", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				name: "MoviesSearch",
				movieIds,
			}),
		});

		return {
			itemsSearched: movieIds.length,
			itemsFound: movieIds.length,
			foundItems,
			message: `Triggered search for ${movieIds.length} movies`,
			status: "completed",
		};
	} catch (error) {
		const message = error instanceof Error ? error.message : "Unknown error";
		return {
			itemsSearched: 0,
			itemsFound: 0,
			foundItems: [],
			message: `Radarr hunt failed: ${message}`,
			status: "error",
		};
	}
}
