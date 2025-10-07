import type {
	DiscoverResultInstanceState,
	DiscoverSearchResult,
	DiscoverSearchType,
} from "@arr/shared";
import type { ServiceInstance } from "@prisma/client";
import { toBoolean, toNumber, toStringArray, toStringValue } from "../data/values.js";

interface RemoteImages {
	coverType?: string;
	url?: string;
	remoteUrl?: string;
}

/**
 * Resolves an image URL, handling both absolute URLs and relative paths
 */
const resolveImageUrl = (value: unknown, baseUrl?: string): string | undefined => {
	const raw = toStringValue(value);
	if (!raw) {
		return undefined;
	}
	if (/^https?:\/\//i.test(raw)) {
		return raw;
	}
	if (!baseUrl) {
		return raw;
	}
	const normalizedBase = baseUrl.replace(/\/$/, "");
	const trimmedPath = raw.replace(/^\/+/, "");
	return `${normalizedBase}/${trimmedPath}`;
};

/**
 * Normalizes image arrays from Sonarr/Radarr
 */
const normalizeImages = (
	images: unknown,
	baseUrl?: string,
): { poster?: string; fanart?: string; banner?: string } => {
	if (!Array.isArray(images)) {
		return {};
	}
	const result: { poster?: string; fanart?: string; banner?: string } = {};
	for (const raw of images as RemoteImages[]) {
		const coverType = toStringValue(raw?.coverType)?.toLowerCase();
		if (!coverType) {
			continue;
		}
		if (coverType === "poster" && !result.poster) {
			result.poster = resolveImageUrl(raw?.remoteUrl ?? raw?.url, baseUrl);
		}
		if ((coverType === "fanart" || coverType === "background") && !result.fanart) {
			result.fanart = resolveImageUrl(raw?.remoteUrl ?? raw?.url, baseUrl);
		}
		if (coverType === "banner" && !result.banner) {
			result.banner = resolveImageUrl(raw?.remoteUrl ?? raw?.url, baseUrl);
		}
	}
	return result;
};

/**
 * Normalizes a lookup result from Sonarr or Radarr API
 * @param raw - Raw API response (any type allows flexible property access, safety enforced via helper functions)
 */
export const normalizeLookupResult = (
	raw: any,
	instance: ServiceInstance,
	service: "sonarr" | "radarr",
): DiscoverSearchResult => {
	const images = normalizeImages(raw?.images, instance.baseUrl);

	const tmdbId = toNumber(raw?.tmdbId);
	const imdbId = toStringValue(raw?.imdbId);
	const tvdbId = toNumber(raw?.tvdbId);

	const year = toNumber(raw?.year);
	const title = toStringValue(raw?.title) ?? "Untitled";
	const sortTitle = toStringValue(raw?.sortTitle);
	const overview = toStringValue(raw?.overview);
	const status = toStringValue(raw?.status);
	const genres = toStringArray(raw?.genres);
	const network = toStringValue(raw?.network);
	const studio = toStringValue(raw?.studio);
	const runtime = toNumber(raw?.runtime);

	const monitored = toBoolean(raw?.monitored);
	const hasFile = toBoolean(raw?.hasFile);
	const qualityProfileId = toNumber(raw?.qualityProfileId);
	const rootFolderPath = toStringValue(raw?.rootFolderPath);

	const type: DiscoverSearchType = service === "radarr" ? "movie" : "series";
	const existingId = toNumber(raw?.id);

	const remoteIds = {
		tmdbId,
		imdbId,
		tvdbId,
	};

	const key = `${type}:${tmdbId ?? imdbId ?? tvdbId ?? title}`;

	const instanceState: DiscoverResultInstanceState = {
		instanceId: instance.id,
		instanceName: instance.label,
		service,
		exists: existingId !== undefined,
		monitored,
		hasFile,
		qualityProfileId,
		rootFolderPath,
	};

	const result: DiscoverSearchResult = {
		id: key,
		type,
		title,
		sortTitle,
		year,
		overview,
		status,
		genres,
		network,
		studio,
		runtime,
		remoteIds,
		images: {
			poster: images.poster,
			fanart: images.fanart,
			banner: images.banner,
		},
		instanceStates: [instanceState],
	};

	return result;
};

/**
 * Merges a new result into the result map, combining instance data if the same item exists
 */
export const ensureResult = (
	resultMap: Map<string, DiscoverSearchResult>,
	normalized: DiscoverSearchResult,
): void => {
	const existing = resultMap.get(normalized.id);

	if (!existing) {
		resultMap.set(normalized.id, normalized);
		return;
	}

	// Merge instance states
	const mergedInstanceStates = [...existing.instanceStates];
	for (const newState of normalized.instanceStates) {
		const existingIndex = mergedInstanceStates.findIndex(
			(s) => s.instanceId === newState.instanceId,
		);
		if (existingIndex === -1) {
			mergedInstanceStates.push(newState);
		}
	}

	// Prefer newer data for images if missing
	const existingImages = existing.images ?? {};
	const newImages = normalized.images ?? {};
	const mergedImages = {
		poster: existingImages.poster ?? newImages.poster,
		fanart: existingImages.fanart ?? newImages.fanart,
		banner: existingImages.banner ?? newImages.banner,
	};

	resultMap.set(normalized.id, {
		...existing,
		images: mergedImages,
		instanceStates: mergedInstanceStates,
	});
};

/**
 * Fetches lookup results from Sonarr or Radarr
 */
export const fetchLookupResults = async (
	fetcher: (path: string, init?: RequestInit) => Promise<Response>,
	service: "sonarr" | "radarr",
	query: string,
): Promise<any[]> => {
	const encodedQuery = encodeURIComponent(query);
	const endpoint =
		service === "radarr"
			? `/api/v3/movie/lookup?term=${encodedQuery}`
			: `/api/v3/series/lookup?term=${encodedQuery}`;

	const response = await fetcher(endpoint);
	const payload = await response.json();
	return Array.isArray(payload) ? payload : [];
};

/**
 * Sorts discover search results by relevance to query
 */
export const sortSearchResults = (
	results: DiscoverSearchResult[],
	query: string,
): DiscoverSearchResult[] => {
	const lowerQuery = query.toLowerCase();

	return results.sort((a, b) => {
		const aTitle = a.title.toLowerCase();
		const bTitle = b.title.toLowerCase();

		// Exact match comes first
		const aExact = aTitle === lowerQuery ? 1 : 0;
		const bExact = bTitle === lowerQuery ? 1 : 0;
		if (aExact !== bExact) return bExact - aExact;

		// Starts with query comes second
		const aStarts = aTitle.startsWith(lowerQuery) ? 1 : 0;
		const bStarts = bTitle.startsWith(lowerQuery) ? 1 : 0;
		if (aStarts !== bStarts) return bStarts - aStarts;

		// Contains query comes third
		const aContains = aTitle.includes(lowerQuery) ? 1 : 0;
		const bContains = bTitle.includes(lowerQuery) ? 1 : 0;
		if (aContains !== bContains) return bContains - aContains;

		// Then by year (newer first)
		if (a.year && b.year && a.year !== b.year) {
			return b.year - a.year;
		}

		// Finally alphabetically
		return a.title.localeCompare(b.title);
	});
};

/**
 * Converts a string to a URL-safe slug
 */
export const slugify = (value: string): string =>
	value
		.toLowerCase()
		.trim()
		.replace(/[^a-z0-9\s-]/g, "")
		.replace(/\s+/g, "-")
		.replace(/-+/g, "-");

/**
 * Loads movie details from Radarr by trying multiple lookup terms
 */
export const loadRadarrRemote = async (
	fetcher: (path: string, init?: RequestInit) => Promise<Response>,
	payload: { tmdbId?: number; imdbId?: string; queryFallback: string },
): Promise<any | null> => {
	const terms: string[] = [];
	if (payload.tmdbId) {
		terms.push(`tmdb:${payload.tmdbId}`);
	}
	if (payload.imdbId) {
		terms.push(`imdb:${payload.imdbId}`);
	}
	terms.push(payload.queryFallback);

	for (const term of terms) {
		try {
			const results = await fetchLookupResults(fetcher, "radarr", term);
			if (results.length > 0) {
				return results[0];
			}
		} catch (error) {
			// try next term
		}
	}
	return null;
};

/**
 * Loads series details from Sonarr by trying multiple lookup terms
 */
export const loadSonarrRemote = async (
	fetcher: (path: string, init?: RequestInit) => Promise<Response>,
	payload: { tvdbId?: number; tmdbId?: number; queryFallback: string },
): Promise<any | null> => {
	const terms: string[] = [];
	if (payload.tvdbId) {
		terms.push(`tvdb:${payload.tvdbId}`);
	}
	if (payload.tmdbId) {
		terms.push(`tmdb:${payload.tmdbId}`);
	}
	terms.push(payload.queryFallback);

	for (const term of terms) {
		try {
			const results = await fetchLookupResults(fetcher, "sonarr", term);
			if (results.length > 0) {
				return results[0];
			}
		} catch (error) {
			// try next
		}
	}
	return null;
};
