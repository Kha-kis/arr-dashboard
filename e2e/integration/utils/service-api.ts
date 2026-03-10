/**
 * Direct *arr API helpers for integration tests.
 *
 * These functions call the *arr services directly (via external/host URLs)
 * to seed test data and verify state. They bypass arr-dashboard entirely —
 * the dashboard later aggregates this data through its own API layer.
 */

interface ArrRequestOptions {
	method?: string;
	body?: unknown;
}

/** Make an authenticated request to an *arr service API. */
async function arrFetch<T = unknown>(
	baseUrl: string,
	apiKey: string,
	path: string,
	options: ArrRequestOptions = {},
): Promise<T> {
	const { method = "GET", body } = options;
	const url = `${baseUrl}${path}`;

	const response = await fetch(url, {
		method,
		headers: {
			"X-Api-Key": apiKey,
			"Content-Type": "application/json",
		},
		body: body ? JSON.stringify(body) : undefined,
	});

	if (!response.ok) {
		const text = await response.text().catch(() => "");
		throw new Error(`${method} ${url} → ${response.status}: ${text}`);
	}

	return response.json() as Promise<T>;
}

// ── Sonarr v3 API ─────────────────────────────────────────────────────

interface SonarrRootFolder {
	id: number;
	path: string;
	accessible: boolean;
	freeSpace: number;
}

interface SonarrSeries {
	id: number;
	title: string;
	tvdbId: number;
	monitored: boolean;
}

interface SonarrQualityProfile {
	id: number;
	name: string;
}

export async function sonarrGetStatus(baseUrl: string, apiKey: string) {
	return arrFetch(baseUrl, apiKey, "/api/v3/system/status");
}

export async function sonarrGetRootFolders(baseUrl: string, apiKey: string) {
	return arrFetch<SonarrRootFolder[]>(baseUrl, apiKey, "/api/v3/rootfolder");
}

export async function sonarrAddRootFolder(baseUrl: string, apiKey: string, path: string) {
	return arrFetch<SonarrRootFolder>(baseUrl, apiKey, "/api/v3/rootfolder", {
		method: "POST",
		body: { path },
	});
}

export async function sonarrGetQualityProfiles(baseUrl: string, apiKey: string) {
	return arrFetch<SonarrQualityProfile[]>(baseUrl, apiKey, "/api/v3/qualityprofile");
}

export async function sonarrGetSeries(baseUrl: string, apiKey: string) {
	return arrFetch<SonarrSeries[]>(baseUrl, apiKey, "/api/v3/series");
}

export async function sonarrAddSeries(
	baseUrl: string,
	apiKey: string,
	options: {
		title: string;
		tvdbId: number;
		qualityProfileId: number;
		rootFolderPath: string;
		monitored?: boolean;
		searchForMissingEpisodes?: boolean;
	},
) {
	return arrFetch<SonarrSeries>(baseUrl, apiKey, "/api/v3/series", {
		method: "POST",
		body: {
			title: options.title,
			tvdbId: options.tvdbId,
			qualityProfileId: options.qualityProfileId,
			rootFolderPath: options.rootFolderPath,
			monitored: options.monitored ?? true,
			seasonFolder: true,
			addOptions: {
				searchForMissingEpisodes: options.searchForMissingEpisodes ?? false,
			},
		},
	});
}

// ── Radarr v3 API ─────────────────────────────────────────────────────

interface RadarrRootFolder {
	id: number;
	path: string;
	accessible: boolean;
	freeSpace: number;
}

interface RadarrMovie {
	id: number;
	title: string;
	tmdbId: number;
	monitored: boolean;
}

interface RadarrQualityProfile {
	id: number;
	name: string;
}

export async function radarrGetStatus(baseUrl: string, apiKey: string) {
	return arrFetch(baseUrl, apiKey, "/api/v3/system/status");
}

export async function radarrGetRootFolders(baseUrl: string, apiKey: string) {
	return arrFetch<RadarrRootFolder[]>(baseUrl, apiKey, "/api/v3/rootfolder");
}

export async function radarrAddRootFolder(baseUrl: string, apiKey: string, path: string) {
	return arrFetch<RadarrRootFolder>(baseUrl, apiKey, "/api/v3/rootfolder", {
		method: "POST",
		body: { path },
	});
}

export async function radarrGetQualityProfiles(baseUrl: string, apiKey: string) {
	return arrFetch<RadarrQualityProfile[]>(baseUrl, apiKey, "/api/v3/qualityprofile");
}

export async function radarrGetMovies(baseUrl: string, apiKey: string) {
	return arrFetch<RadarrMovie[]>(baseUrl, apiKey, "/api/v3/movie");
}

export async function radarrAddMovie(
	baseUrl: string,
	apiKey: string,
	options: {
		title: string;
		tmdbId: number;
		qualityProfileId: number;
		rootFolderPath: string;
		monitored?: boolean;
		searchForMovie?: boolean;
	},
) {
	return arrFetch<RadarrMovie>(baseUrl, apiKey, "/api/v3/movie", {
		method: "POST",
		body: {
			title: options.title,
			tmdbId: options.tmdbId,
			qualityProfileId: options.qualityProfileId,
			rootFolderPath: options.rootFolderPath,
			monitored: options.monitored ?? true,
			addOptions: {
				searchForMovie: options.searchForMovie ?? false,
			},
		},
	});
}

// ── Prowlarr v1 API ───────────────────────────────────────────────────

export async function prowlarrGetStatus(baseUrl: string, apiKey: string) {
	return arrFetch(baseUrl, apiKey, "/api/v1/system/status");
}

export async function prowlarrGetIndexers(baseUrl: string, apiKey: string) {
	return arrFetch<unknown[]>(baseUrl, apiKey, "/api/v1/indexer");
}
