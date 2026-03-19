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
		const text = await response.text().catch(() => "(body unreadable)");
		throw new Error(`${method} ${url} → ${response.status}: ${text}`);
	}

	const text = await response.text();
	try {
		return JSON.parse(text) as T;
	} catch {
		throw new Error(
			`${method} ${url} returned non-JSON (${response.headers.get("content-type")}): ${text.slice(0, 200)}`,
		);
	}
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

// ── Lidarr v1 API ─────────────────────────────────────────────────────

interface LidarrRootFolder {
	id: number;
	path: string;
	accessible: boolean;
	freeSpace: number;
}

interface LidarrArtist {
	id: number;
	artistName: string;
	foreignArtistId: string;
	monitored: boolean;
}

interface LidarrQualityProfile {
	id: number;
	name: string;
}

interface LidarrMetadataProfile {
	id: number;
	name: string;
}

export async function lidarrGetStatus(baseUrl: string, apiKey: string) {
	return arrFetch(baseUrl, apiKey, "/api/v1/system/status");
}

export async function lidarrGetRootFolders(baseUrl: string, apiKey: string) {
	return arrFetch<LidarrRootFolder[]>(baseUrl, apiKey, "/api/v1/rootfolder");
}

export async function lidarrAddRootFolder(
	baseUrl: string,
	apiKey: string,
	path: string,
	defaultQualityProfileId: number,
	defaultMetadataProfileId: number,
) {
	return arrFetch<LidarrRootFolder>(baseUrl, apiKey, "/api/v1/rootfolder", {
		method: "POST",
		body: { path, name: path, defaultQualityProfileId, defaultMetadataProfileId },
	});
}

export async function lidarrGetQualityProfiles(baseUrl: string, apiKey: string) {
	return arrFetch<LidarrQualityProfile[]>(baseUrl, apiKey, "/api/v1/qualityprofile");
}

export async function lidarrGetMetadataProfiles(baseUrl: string, apiKey: string) {
	return arrFetch<LidarrMetadataProfile[]>(baseUrl, apiKey, "/api/v1/metadataprofile");
}

export async function lidarrGetArtists(baseUrl: string, apiKey: string) {
	return arrFetch<LidarrArtist[]>(baseUrl, apiKey, "/api/v1/artist");
}

export async function lidarrAddArtist(
	baseUrl: string,
	apiKey: string,
	options: {
		artistName: string;
		foreignArtistId: string;
		qualityProfileId: number;
		metadataProfileId: number;
		rootFolderPath: string;
		monitored?: boolean;
		searchForMissingAlbums?: boolean;
	},
) {
	return arrFetch<LidarrArtist>(baseUrl, apiKey, "/api/v1/artist", {
		method: "POST",
		body: {
			artistName: options.artistName,
			foreignArtistId: options.foreignArtistId,
			qualityProfileId: options.qualityProfileId,
			metadataProfileId: options.metadataProfileId,
			rootFolderPath: options.rootFolderPath,
			monitored: options.monitored ?? true,
			addOptions: {
				searchForMissingAlbums: options.searchForMissingAlbums ?? false,
			},
		},
	});
}

// ── Readarr v1 API ────────────────────────────────────────────────────

interface ReadarrRootFolder {
	id: number;
	path: string;
	accessible: boolean;
	freeSpace: number;
}

interface ReadarrAuthor {
	id: number;
	authorName: string;
	foreignAuthorId: string;
	monitored: boolean;
}

interface ReadarrQualityProfile {
	id: number;
	name: string;
}

interface ReadarrMetadataProfile {
	id: number;
	name: string;
}

export async function readarrGetStatus(baseUrl: string, apiKey: string) {
	return arrFetch(baseUrl, apiKey, "/api/v1/system/status");
}

export async function readarrGetRootFolders(baseUrl: string, apiKey: string) {
	return arrFetch<ReadarrRootFolder[]>(baseUrl, apiKey, "/api/v1/rootfolder");
}

export async function readarrAddRootFolder(
	baseUrl: string,
	apiKey: string,
	path: string,
	defaultQualityProfileId: number,
	defaultMetadataProfileId: number,
) {
	return arrFetch<ReadarrRootFolder>(baseUrl, apiKey, "/api/v1/rootfolder", {
		method: "POST",
		body: { path, name: path, defaultQualityProfileId, defaultMetadataProfileId },
	});
}

export async function readarrGetQualityProfiles(baseUrl: string, apiKey: string) {
	return arrFetch<ReadarrQualityProfile[]>(baseUrl, apiKey, "/api/v1/qualityprofile");
}

export async function readarrGetMetadataProfiles(baseUrl: string, apiKey: string) {
	return arrFetch<ReadarrMetadataProfile[]>(baseUrl, apiKey, "/api/v1/metadataprofile");
}

export async function readarrGetAuthors(baseUrl: string, apiKey: string) {
	return arrFetch<ReadarrAuthor[]>(baseUrl, apiKey, "/api/v1/author");
}

export async function readarrAddAuthor(
	baseUrl: string,
	apiKey: string,
	options: {
		authorName: string;
		foreignAuthorId: string;
		qualityProfileId: number;
		metadataProfileId: number;
		rootFolderPath: string;
		monitored?: boolean;
		searchForMissingBooks?: boolean;
	},
) {
	return arrFetch<ReadarrAuthor>(baseUrl, apiKey, "/api/v1/author", {
		method: "POST",
		body: {
			authorName: options.authorName,
			foreignAuthorId: options.foreignAuthorId,
			qualityProfileId: options.qualityProfileId,
			metadataProfileId: options.metadataProfileId,
			rootFolderPath: options.rootFolderPath,
			monitored: options.monitored ?? true,
			addOptions: {
				searchForMissingBooks: options.searchForMissingBooks ?? false,
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
