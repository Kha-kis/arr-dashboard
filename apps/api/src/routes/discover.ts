import {
	type DiscoverAddRequest,
	type DiscoverResultInstanceState,
	type DiscoverSearchResult,
	type DiscoverSearchType,
	discoverAddRequestSchema,
	discoverAddResponseSchema,
	discoverInstanceOptionsRequestSchema,
	discoverInstanceOptionsResponseSchema,
	discoverSearchRequestSchema,
	discoverSearchResponseSchema,
	discoverSearchTypeSchema,
} from "@arr/shared";
import type { ServiceInstance } from "@prisma/client";
import type { FastifyPluginCallback } from "fastify";
import { z } from "zod";
import { createInstanceFetcher } from "../lib/arr/arr-fetcher.js";

interface RemoteImages {
	coverType?: string;
	url?: string;
	remoteUrl?: string;
}

const toNumber = (value: unknown): number | undefined => {
	if (typeof value === "number" && Number.isFinite(value)) {
		return value;
	}
	if (typeof value === "string") {
		const parsed = Number(value);
		return Number.isFinite(parsed) ? parsed : undefined;
	}
	return undefined;
};

const toBoolean = (value: unknown): boolean | undefined => {
	if (typeof value === "boolean") {
		return value;
	}
	if (typeof value === "number") {
		if (value === 0) {
			return false;
		}
		if (value === 1) {
			return true;
		}
	}
	if (typeof value === "string") {
		const normalized = value.trim().toLowerCase();
		if (["true", "1", "yes"].includes(normalized)) {
			return true;
		}
		if (["false", "0", "no"].includes(normalized)) {
			return false;
		}
	}
	return undefined;
};

const toStringValue = (value: unknown): string | undefined => {
	if (typeof value === "string") {
		const trimmed = value.trim();
		return trimmed.length > 0 ? trimmed : undefined;
	}
	if (typeof value === "number" && Number.isFinite(value)) {
		return value.toString();
	}
	return undefined;
};

const normalizeGenres = (value: unknown): string[] | undefined => {
	if (!Array.isArray(value)) {
		return undefined;
	}
	const genres = value
		.map((entry) => toStringValue(entry))
		.filter((entry): entry is string => Boolean(entry));
	return genres.length > 0 ? genres : undefined;
};

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

const slugify = (value: string): string =>
	value
		.toLowerCase()
		.trim()
		.replace(/[^a-z0-9\s-]/g, "")
		.replace(/\s+/g, "-")
		.replace(/-+/g, "-");

const createResultId = (
	type: DiscoverSearchType,
	remoteIds: { tmdbId?: number; imdbId?: string; tvdbId?: number } = {},
	title?: string,
	year?: number,
): string => {
	if (type === "movie") {
		if (remoteIds.tmdbId) {
			return `movie-tmdb-${remoteIds.tmdbId}`;
		}
		if (remoteIds.imdbId) {
			return `movie-imdb-${remoteIds.imdbId}`;
		}
	} else {
		if (remoteIds.tvdbId) {
			return `series-tvdb-${remoteIds.tvdbId}`;
		}
		if (remoteIds.tmdbId) {
			return `series-tmdb-${remoteIds.tmdbId}`;
		}
	}
	const base = title ? slugify(title) : "unknown";
	return `${type}-${base}-${year ?? ""}`;
};

const mergeInstanceState = (
	states: DiscoverResultInstanceState[],
	state: DiscoverResultInstanceState,
): DiscoverResultInstanceState[] => {
	const existingIndex = states.findIndex((entry) => entry.instanceId === state.instanceId);
	if (existingIndex >= 0) {
		states[existingIndex] = {
			...states[existingIndex],
			...state,
		};
		return states;
	}
	return [...states, state];
};

const ensureResult = (
	map: Map<string, DiscoverSearchResult>,
	result: DiscoverSearchResult,
): void => {
	const existing = map.get(result.id);
	if (!existing) {
		map.set(result.id, result);
		return;
	}

	const images = existing.images ?? {};
	const nextImages = result.images ?? {};

	map.set(result.id, {
		...existing,
		title: existing.title ?? result.title,
		sortTitle: existing.sortTitle ?? result.sortTitle,
		year: existing.year ?? result.year,
		overview: existing.overview ?? result.overview,
		remoteIds: existing.remoteIds ?? result.remoteIds,
		images: {
			poster: images.poster ?? nextImages.poster,
			fanart: images.fanart ?? nextImages.fanart,
			banner: images.banner ?? nextImages.banner,
		},
		genres: existing.genres ?? result.genres,
		status: existing.status ?? result.status,
		network: existing.network ?? result.network,
		studio: existing.studio ?? result.studio,
		runtime: existing.runtime ?? result.runtime,
		ratings: existing.ratings ?? result.ratings,
		instanceStates:
			result.instanceStates[0] !== undefined
				? mergeInstanceState(existing.instanceStates, result.instanceStates[0])
				: existing.instanceStates,
	});
};

const fetchLookupResults = async (
	fetcher: (path: string, init?: RequestInit) => Promise<Response>,
	service: "sonarr" | "radarr",
	query: string,
): Promise<unknown[]> => {
	const encoded = encodeURIComponent(query);
	const path =
		service === "radarr"
			? `/api/v3/movie/lookup?term=${encoded}`
			: `/api/v3/series/lookup?term=${encoded}`;
	const response = await fetcher(path);
	const data = await response.json();
	return Array.isArray(data) ? data : [];
};

const createInstanceState = (
	instance: ServiceInstance,
	service: "sonarr" | "radarr",
	payload: unknown,
): DiscoverResultInstanceState => ({
	instanceId: instance.id,
	instanceName: instance.label,
	service,
	exists: Boolean(toNumber(payload?.id)),
	monitored: toBoolean(payload?.monitored),
	hasFile: toBoolean(payload?.hasFile ?? payload?.hasMovieFile ?? payload?.hasEpisodeFile),
	qualityProfileId: toNumber(payload?.qualityProfileId),
	rootFolderPath: toStringValue(payload?.path ?? payload?.rootFolderPath),
});

const normalizeLookupResult = (
	raw: unknown,
	instance: ServiceInstance,
	service: "sonarr" | "radarr",
): DiscoverSearchResult => {
	const type: DiscoverSearchType = service === "radarr" ? "movie" : "series";
	const title = toStringValue(raw?.title) ?? "Untitled";
	const sortTitle = toStringValue(raw?.sortTitle);
	const year = toNumber(raw?.year ?? raw?.releaseYear);
	const overview = toStringValue(raw?.overview ?? raw?.plot);
	const runtime = toNumber(raw?.runtime ?? raw?.runtimeMinutes ?? raw?.runtimeHours);
	const status = toStringValue(raw?.status);
	const network = toStringValue(raw?.network);
	const studio = toStringValue(raw?.studio);
	const ratingsValue = toNumber(raw?.ratings?.value ?? raw?.rating);
	const ratingsVotes = toNumber(raw?.ratings?.votes);
	const images = normalizeImages(raw?.images, instance.baseUrl);

	const remoteIds = {
		tmdbId: toNumber(raw?.tmdbId),
		imdbId: toStringValue(raw?.imdbId),
		tvdbId: toNumber(raw?.tvdbId),
	};

	const id = createResultId(type, remoteIds, title, year);

	return {
		id,
		title,
		sortTitle,
		type,
		year,
		overview,
		remoteIds,
		images,
		genres: normalizeGenres(raw?.genres),
		status,
		network,
		studio,
		runtime,
		ratings:
			ratingsValue !== undefined || ratingsVotes !== undefined
				? { value: ratingsValue, votes: ratingsVotes }
				: undefined,
		instanceStates: [createInstanceState(instance, service, raw)],
	};
};

const loadRadarrRemote = async (
	fetcher: (path: string, init?: RequestInit) => Promise<Response>,
	payload: { tmdbId?: number; imdbId?: string; queryFallback: string },
): Promise<unknown | null> => {
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

const loadSonarrRemote = async (
	fetcher: (path: string, init?: RequestInit) => Promise<Response>,
	payload: { tvdbId?: number; tmdbId?: number; queryFallback: string },
): Promise<unknown | null> => {
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

const discoverRoute: FastifyPluginCallback = (app, _opts, done) => {
	app.get("/discover/search", async (request, reply) => {
		if (!request.currentUser) {
			reply.status(401);
			return discoverSearchResponseSchema.parse({ results: [], totalCount: 0 });
		}

		const parsed = discoverSearchRequestSchema.parse(request.query ?? {});
		const type = parsed.type;
		const prismaService = type === "movie" ? "RADARR" : "SONARR";

		const instances = await app.prisma.serviceInstance.findMany({
			where: {
				userId: request.currentUser.id,
				enabled: true,
				service: prismaService,
			},
		});

		if (instances.length === 0) {
			return discoverSearchResponseSchema.parse({ results: [], totalCount: 0 });
		}

		const resultMap = new Map<string, DiscoverSearchResult>();

		for (const instance of instances) {
			const service = instance.service.toLowerCase() as "sonarr" | "radarr";
			try {
				const fetcher = createInstanceFetcher(app, instance as ServiceInstance);
				const lookupResults = await fetchLookupResults(fetcher, service, parsed.query);
				for (const raw of lookupResults) {
					const normalized = normalizeLookupResult(raw, instance as ServiceInstance, service);
					ensureResult(resultMap, normalized);
				}
			} catch (error) {
				request.log.error({ err: error, instance: instance.id }, "discover search failed");
			}
		}

		const query = parsed.query.toLowerCase();

		const results = Array.from(resultMap.values()).sort((a, b) => {
			const aTitle = a.title.toLowerCase();
			const bTitle = b.title.toLowerCase();

			// Exact match comes first
			const aExact = aTitle === query ? 1 : 0;
			const bExact = bTitle === query ? 1 : 0;
			if (aExact !== bExact) return bExact - aExact;

			// Starts with query comes second
			const aStarts = aTitle.startsWith(query) ? 1 : 0;
			const bStarts = bTitle.startsWith(query) ? 1 : 0;
			if (aStarts !== bStarts) return bStarts - aStarts;

			// Contains query comes third
			const aContains = aTitle.includes(query) ? 1 : 0;
			const bContains = bTitle.includes(query) ? 1 : 0;
			if (aContains !== bContains) return bContains - aContains;

			// Then by year (newer first)
			if (a.year && b.year && a.year !== b.year) {
				return b.year - a.year;
			}

			// Finally alphabetically
			return a.title.localeCompare(b.title);
		});

		return discoverSearchResponseSchema.parse({
			results,
			totalCount: results.length,
		});
	});

	app.get("/discover/options", async (request, reply) => {
		if (!request.currentUser) {
			reply.status(401);
			return reply.send();
		}

		const parsed = discoverInstanceOptionsRequestSchema.parse(request.query ?? {});
		const instance = await app.prisma.serviceInstance.findFirst({
			where: {
				id: parsed.instanceId,
				userId: request.currentUser.id,
				enabled: true,
			},
		});

		if (!instance) {
			reply.status(404);
			return reply.send({ message: "Instance not found" });
		}

		const service = instance.service.toLowerCase() as "sonarr" | "radarr";
		const expected = parsed.type === "movie" ? "radarr" : "sonarr";
		if (service !== expected) {
			reply.status(400);
			return reply.send({
				message: `Instance does not support ${parsed.type}`,
			});
		}

		try {
			const fetcher = createInstanceFetcher(app, instance as ServiceInstance);
			const qualityProfilesResponse = await fetcher("/api/v3/qualityprofile");
			const rootFolderResponse = await fetcher("/api/v3/rootfolder");

			const qualityProfilesRaw = await qualityProfilesResponse.json();
			const rootFoldersRaw = await rootFolderResponse.json();

			const qualityProfiles = Array.isArray(qualityProfilesRaw)
				? qualityProfilesRaw
						.map((profile: unknown) => ({
							id: toNumber(profile?.id),
							name: toStringValue(profile?.name),
						}))
						.filter(
							(profile): profile is { id: number; name: string } =>
								typeof profile.id === "number" && typeof profile.name === "string",
						)
				: [];

			const rootFolders = Array.isArray(rootFoldersRaw)
				? rootFoldersRaw.reduce<
						Array<{
							id?: number | string;
							path: string;
							accessible?: boolean;
							freeSpace?: number;
						}>
					>((acc, folder: unknown) => {
						const path = toStringValue(folder?.path);
						if (!path) {
							return acc;
						}
						acc.push({
							id: toNumber(folder?.id) ?? toStringValue(folder?.id) ?? undefined,
							path,
							accessible: toBoolean(folder?.accessible),
							freeSpace: toNumber(folder?.freeSpace),
						});
						return acc;
					}, [])
				: [];

			let languageProfiles: Array<{ id: number; name: string }> | undefined;
			if (service === "sonarr") {
				try {
					const languageResponse = await fetcher("/api/v3/languageprofile");
					const languageRaw = await languageResponse.json();
					languageProfiles = Array.isArray(languageRaw)
						? languageRaw
								.map((profile: unknown) => ({
									id: toNumber(profile?.id),
									name: toStringValue(profile?.name),
								}))
								.filter(
									(profile): profile is { id: number; name: string } =>
										typeof profile.id === "number" && typeof profile.name === "string",
								)
						: [];
				} catch (error) {
					request.log.warn(
						{ err: error, instance: instance.id },
						"failed to load language profiles",
					);
				}
			}

			return discoverInstanceOptionsResponseSchema.parse({
				instanceId: instance.id,
				service,
				qualityProfiles,
				rootFolders,
				languageProfiles,
			});
		} catch (error) {
			request.log.error({ err: error, instance: instance.id }, "failed to load discover options");
			reply.status(502);
			return reply.send({ message: "Failed to load instance options" });
		}
	});

	app.post("/discover/add", async (request, reply) => {
		if (!request.currentUser) {
			reply.status(401);
			return reply.send({ message: "Unauthorized" });
		}

		const payload = discoverAddRequestSchema.parse(request.body ?? {});
		const instance = await app.prisma.serviceInstance.findFirst({
			where: {
				id: payload.instanceId,
				userId: request.currentUser.id,
				enabled: true,
			},
		});

		if (!instance) {
			reply.status(404);
			return reply.send({ message: "Instance not found" });
		}

		const service = instance.service.toLowerCase() as "sonarr" | "radarr";
		const expected = payload.payload.type === "movie" ? "radarr" : "sonarr";
		if (service !== expected) {
			reply.status(400);
			return reply.send({ message: "Instance service does not match payload" });
		}

		const fetcher = createInstanceFetcher(app, instance as ServiceInstance);

		try {
			if (service === "radarr") {
				if (payload.payload.type !== "movie") {
					reply.status(400);
					return reply.send({
						message: "Instance service does not match payload",
					});
				}

				const moviePayload = payload.payload;
				const remote = await loadRadarrRemote(fetcher, {
					tmdbId: moviePayload.tmdbId,
					imdbId: moviePayload.imdbId,
					queryFallback: moviePayload.title,
				});

				if (!remote) {
					reply.status(404);
					return reply.send({ message: "Unable to locate movie details" });
				}

				const body = {
					...remote,
					id: 0,
					tmdbId: moviePayload.tmdbId ?? remote.tmdbId,
					imdbId: moviePayload.imdbId ?? remote.imdbId,
					title: moviePayload.title ?? remote.title,
					year: moviePayload.year ?? remote.year,
					qualityProfileId: moviePayload.qualityProfileId,
					rootFolderPath: moviePayload.rootFolderPath,
					monitored: moviePayload.monitored ?? true,
					minimumAvailability:
						moviePayload.minimumAvailability ??
						toStringValue(remote?.minimumAvailability) ??
						"announced",
					addOptions: {
						searchForMovie: moviePayload.searchOnAdd ?? true,
					},
					tags: moviePayload.tags ?? [],
				};

				const response = await fetcher("/api/v3/movie", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify(body),
				});
				const created = await response.json();
				return discoverAddResponseSchema.parse({
					success: true,
					instanceId: instance.id,
					itemId: created?.id ?? created?.movieId,
				});
			}

			if (payload.payload.type !== "series") {
				reply.status(400);
				return reply.send({
					message: "Instance service does not match payload",
				});
			}

			const seriesPayload = payload.payload;
			const remote = await loadSonarrRemote(fetcher, {
				tvdbId: seriesPayload.tvdbId,
				tmdbId: seriesPayload.tmdbId,
				queryFallback: seriesPayload.title,
			});

			if (!remote) {
				reply.status(404);
				return reply.send({ message: "Unable to locate series details" });
			}

			const seasons = Array.isArray(remote?.seasons)
				? remote.seasons.map((season: unknown) => ({
						seasonNumber: toNumber(season?.seasonNumber) ?? 0,
						monitored:
							seriesPayload.seasonFolder === false ? false : (seriesPayload.monitored ?? true),
					}))
				: [];

			const languageProfileId =
				seriesPayload.languageProfileId ?? toNumber(remote?.languageProfileId);
			if (languageProfileId === undefined) {
				reply.status(400);
				return reply.send({ message: "languageProfileId is required" });
			}

			const body = {
				...remote,
				title: seriesPayload.title ?? remote.title,
				titleSlug:
					toStringValue(remote?.titleSlug) ??
					slugify(seriesPayload.title ?? remote.title ?? "series"),
				qualityProfileId: seriesPayload.qualityProfileId,
				languageProfileId,
				rootFolderPath: seriesPayload.rootFolderPath,
				seasonFolder: seriesPayload.seasonFolder ?? true,
				monitored: seriesPayload.monitored ?? true,
				seasons,
				addOptions: {
					searchForMissingEpisodes: seriesPayload.searchOnAdd ?? true,
					searchForCutoffUnmetEpisodes: seriesPayload.searchOnAdd ?? true,
				},
				tags: seriesPayload.tags ?? [],
			};

			const response = await fetcher("/api/v3/series", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(body),
			});
			const created = await response.json();
			return discoverAddResponseSchema.parse({
				success: true,
				instanceId: instance.id,
				itemId: created?.id,
			});
		} catch (error) {
			request.log.error({ err: error, instance: instance.id }, "discover add failed");
			reply.status(502);
			return reply.send({ message: "Failed to add title" });
		}
	});

	done();
};

export const registerDiscoverRoutes = discoverRoute;
