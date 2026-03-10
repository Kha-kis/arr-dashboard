/**
 * Seed *arr instances with test data.
 *
 * Called from test specs (or as a standalone setup) to populate Sonarr/Radarr
 * with root folders and content so the dashboard has real data to display.
 *
 * Uses the external (host) URLs since this runs from the Playwright host,
 * not inside the Docker network.
 */

import {
	sonarrGetRootFolders,
	sonarrAddRootFolder,
	sonarrGetQualityProfiles,
	sonarrGetSeries,
	sonarrAddSeries,
	radarrGetRootFolders,
	radarrAddRootFolder,
	radarrGetQualityProfiles,
	radarrGetMovies,
	radarrAddMovie,
	prowlarrGetStatus,
} from "../utils/service-api";

// External (host-accessible) URLs from .env.services
const SONARR_URL = process.env.SONARR_EXTERNAL_URL || "http://localhost:8989";
const SONARR_KEY = process.env.SONARR_API_KEY || "";
const RADARR_URL = process.env.RADARR_EXTERNAL_URL || "http://localhost:7878";
const RADARR_KEY = process.env.RADARR_API_KEY || "";
const PROWLARR_URL = process.env.PROWLARR_EXTERNAL_URL || "http://localhost:9696";
const PROWLARR_KEY = process.env.PROWLARR_API_KEY || "";

const SONARR_ROOT = "/config/media/tv";
const RADARR_ROOT = "/config/media/movies";

// Well-known content for seeding (searchForMissing disabled to avoid download attempts)
const SEED_SERIES = {
	title: "Breaking Bad",
	tvdbId: 81189,
};

const SEED_MOVIE = {
	title: "The Matrix",
	tmdbId: 603,
};

/**
 * Seed Sonarr with a root folder and a test series.
 * Idempotent — skips if content already exists.
 */
export async function seedSonarr(): Promise<void> {
	if (!SONARR_KEY) {
		console.log("[seed] No Sonarr API key, skipping");
		return;
	}

	console.log("[seed] Seeding Sonarr...");

	// Ensure root folder exists
	const rootFolders = await sonarrGetRootFolders(SONARR_URL, SONARR_KEY);
	if (!rootFolders.some((f) => f.path === SONARR_ROOT)) {
		try {
			await sonarrAddRootFolder(SONARR_URL, SONARR_KEY, SONARR_ROOT);
			console.log(`[seed]   Added root folder: ${SONARR_ROOT}`);
		} catch (error) {
			console.log(
				`[seed]   Could not add root folder (may need chown in container): ${error instanceof Error ? error.message : error}`,
			);
		}
	}

	// Get first quality profile (LinuxServer images ship with defaults)
	const profiles = await sonarrGetQualityProfiles(SONARR_URL, SONARR_KEY);
	if (profiles.length === 0) {
		console.log("[seed]   No quality profiles available, skipping series");
		return;
	}

	// Add series if not already present
	const existingSeries = await sonarrGetSeries(SONARR_URL, SONARR_KEY);
	if (existingSeries.some((s) => s.tvdbId === SEED_SERIES.tvdbId)) {
		console.log(`[seed]   ${SEED_SERIES.title} already exists`);
		return;
	}

	try {
		await sonarrAddSeries(SONARR_URL, SONARR_KEY, {
			title: SEED_SERIES.title,
			tvdbId: SEED_SERIES.tvdbId,
			qualityProfileId: profiles[0].id,
			rootFolderPath: SONARR_ROOT,
			monitored: true,
			searchForMissingEpisodes: false,
		});
		console.log(`[seed]   Added series: ${SEED_SERIES.title}`);
	} catch (error) {
		// May fail if tvdbId lookup requires network — non-fatal
		console.log(`[seed]   Could not add series: ${error instanceof Error ? error.message : error}`);
	}
}

/**
 * Seed Radarr with a root folder and a test movie.
 * Idempotent — skips if content already exists.
 */
export async function seedRadarr(): Promise<void> {
	if (!RADARR_KEY) {
		console.log("[seed] No Radarr API key, skipping");
		return;
	}

	console.log("[seed] Seeding Radarr...");

	// Ensure root folder exists
	const rootFolders = await radarrGetRootFolders(RADARR_URL, RADARR_KEY);
	if (!rootFolders.some((f) => f.path === RADARR_ROOT)) {
		try {
			await radarrAddRootFolder(RADARR_URL, RADARR_KEY, RADARR_ROOT);
			console.log(`[seed]   Added root folder: ${RADARR_ROOT}`);
		} catch (error) {
			console.log(
				`[seed]   Could not add root folder (may need chown in container): ${error instanceof Error ? error.message : error}`,
			);
		}
	}

	// Get first quality profile
	const profiles = await radarrGetQualityProfiles(RADARR_URL, RADARR_KEY);
	if (profiles.length === 0) {
		console.log("[seed]   No quality profiles available, skipping movie");
		return;
	}

	// Add movie if not already present
	const existingMovies = await radarrGetMovies(RADARR_URL, RADARR_KEY);
	if (existingMovies.some((m) => m.tmdbId === SEED_MOVIE.tmdbId)) {
		console.log(`[seed]   ${SEED_MOVIE.title} already exists`);
		return;
	}

	try {
		await radarrAddMovie(RADARR_URL, RADARR_KEY, {
			title: SEED_MOVIE.title,
			tmdbId: SEED_MOVIE.tmdbId,
			qualityProfileId: profiles[0].id,
			rootFolderPath: RADARR_ROOT,
			monitored: true,
			searchForMovie: false,
		});
		console.log(`[seed]   Added movie: ${SEED_MOVIE.title}`);
	} catch (error) {
		// May fail if tmdbId lookup requires network — non-fatal
		console.log(`[seed]   Could not add movie: ${error instanceof Error ? error.message : error}`);
	}
}

/**
 * Verify Prowlarr is accessible. No data seeding needed —
 * indexers require manual config, but the connection itself is testable.
 */
export async function verifyProwlarr(): Promise<void> {
	if (!PROWLARR_KEY) {
		console.log("[seed] No Prowlarr API key, skipping");
		return;
	}

	console.log("[seed] Verifying Prowlarr...");
	await prowlarrGetStatus(PROWLARR_URL, PROWLARR_KEY);
	console.log("[seed]   Prowlarr is accessible");
}

/**
 * Seed all services. Call once before running integration specs.
 */
export async function seedAll(): Promise<void> {
	await seedSonarr();
	await seedRadarr();
	await verifyProwlarr();
	console.log("[seed] All services seeded");
}
