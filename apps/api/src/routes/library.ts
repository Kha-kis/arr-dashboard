import type { FastifyPluginCallback } from "fastify";
import { z } from "zod";
import {
  libraryServiceSchema,
  libraryToggleMonitorRequestSchema,
  librarySeasonSearchRequestSchema,
  libraryMovieSearchRequestSchema,
  librarySeriesSearchRequestSchema,
  multiInstanceLibraryResponseSchema,
  type LibraryService,
  type LibraryItem,
} from "@arr/shared";
import type { ServiceInstance, ServiceType } from "@prisma/client";
import { createInstanceFetcher } from "../utils/arr-fetcher.js";

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

const normalizeTags = (value: unknown): string[] | undefined => {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const tags = value
    .map((entry) => toStringValue(entry))
    .filter((entry): entry is string => Boolean(entry));
  return tags.length > 0 ? tags : undefined;
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
  const trimmed = raw.replace(/^\/+/, "");
  return `${normalizedBase}/${trimmed}`;
};

const normalizeImages = (images: unknown, baseUrl?: string): { poster?: string; fanart?: string } => {
  if (!Array.isArray(images)) {
    return {};
  }
  const result: { poster?: string; fanart?: string } = {};
  for (const raw of images as Array<{ coverType?: string; url?: string; remoteUrl?: string }>) {
    const type = toStringValue(raw?.coverType)?.toLowerCase();
    if (!type) {
      continue;
    }
    if (type === "poster" && !result.poster) {
      result.poster = resolveImageUrl(raw?.remoteUrl ?? raw?.url, baseUrl);
    }
    if ((type === "fanart" || type === "background") && !result.fanart) {
      result.fanart = resolveImageUrl(raw?.remoteUrl ?? raw?.url, baseUrl);
    }
  }
  return result;
};


const buildMovieFile = (raw: any) => {
  if (!raw || typeof raw !== "object") {
    return undefined;
  }
  const id = toNumber(raw?.id);
  const relativePath =
    toStringValue(raw?.relativePath) ??
    toStringValue(raw?.path) ??
    toStringValue(raw?.originalFilePath);
  const quality =
    toStringValue(raw?.quality?.quality?.name) ??
    toStringValue(raw?.quality?.name);
  const size = toNumber(raw?.size) ?? toNumber(raw?.sizeOnDisk);
  let resolution =
    toStringValue(raw?.mediaInfo?.resolution) ??
    toStringValue(raw?.mediaInfo?.screenSize);
  const width = toNumber(raw?.mediaInfo?.width);
  const height = toNumber(raw?.mediaInfo?.height);
  if (!resolution && width !== undefined && height !== undefined) {
    resolution = `${width}x${height}`;
  }
  if (!relativePath && !quality && !size && !resolution && id === undefined) {
    return undefined;
  }
  return {
    id,
    relativePath,
    quality,
    size,
    resolution,
  };
};

const normalizeSeasons = (value: unknown) => {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const seasons = value
    .map((entry: any) => {
      const seasonNumber = toNumber(entry?.seasonNumber);
      if (seasonNumber === undefined) {
        return null;
      }
      const title = toStringValue(entry?.title);
      const monitored = toBoolean(entry?.monitored);
      const stats = entry?.statistics ?? {};
      const episodeCount =
        toNumber(stats?.totalEpisodeCount) ??
        toNumber(stats?.episodeCount) ??
        toNumber(entry?.episodeCount);
      const episodeFileCount =
        toNumber(stats?.episodeFileCount) ??
        toNumber(entry?.episodeFileCount);
      const missingEpisodeCountRaw =
        episodeCount !== undefined && episodeFileCount !== undefined
          ? Math.max(episodeCount - episodeFileCount, 0)
          : undefined;
      const missingEpisodeCount = monitored === false ? 0 : missingEpisodeCountRaw;

      return {
        seasonNumber,
        title,
        monitored,
        episodeCount,
        episodeFileCount,
        missingEpisodeCount,
      };
    })
    .filter((entry): entry is NonNullable<typeof entry> => entry !== null);

  return seasons.length > 0 ? seasons : undefined;
};

const extractYear = (raw: any): number | undefined => {
  const year = toNumber(raw?.year ?? raw?.releaseYear);
  if (typeof year === "number") {
    return year;
  }
  const firstAired = toStringValue(raw?.firstAired);
  if (firstAired) {
    const match = firstAired.match(/^(\d{4})/);
    if (match) {
      const parsed = Number(match[1]);
      if (Number.isFinite(parsed)) {
        return parsed;
      }
    }
  }
  return undefined;
};
const buildLibraryItem = (
  instance: ServiceInstance,
  service: LibraryService,
  raw: any,
): LibraryItem => {
    const images = normalizeImages(raw?.images, instance.baseUrl);

  const base: Partial<LibraryItem> = {
    id: toNumber(raw?.id) ?? toStringValue(raw?.id) ?? Math.random().toString(36),
    instanceId: instance.id,
    instanceName: instance.label,
    service,
    title: toStringValue(raw?.title) ?? "Untitled",
    titleSlug: toStringValue(raw?.titleSlug),
    sortTitle: toStringValue(raw?.sortTitle),
    year: extractYear(raw),
    overview: toStringValue(raw?.overview),
    runtime: toNumber(raw?.runtime ?? raw?.runtimeMinutes),
    added: toStringValue(raw?.added),
    updated: toStringValue(raw?.lastInfoSync ?? raw?.lastModified),
    genres: normalizeGenres(raw?.genres),
    tags: normalizeTags(raw?.tags),
    poster: images.poster,
    fanart: images.fanart,
  };

  if (service === "radarr") {
    return {
      ...base,
      type: "movie",
      monitored: toBoolean(raw?.monitored),
      hasFile: Boolean(raw?.hasFile || raw?.movieFileId),
      qualityProfileId: toNumber(raw?.qualityProfileId),
      qualityProfileName: toStringValue(raw?.qualityProfile?.name),
      rootFolderPath: toStringValue(raw?.path ?? raw?.rootFolderPath),
      sizeOnDisk: toNumber(raw?.sizeOnDisk),
      path: toStringValue(raw?.path),
      status: toStringValue(raw?.status),
      remoteIds: {
        tmdbId: toNumber(raw?.tmdbId),
        imdbId: toStringValue(raw?.imdbId),
      },
      movieFile: buildMovieFile(raw?.movieFile),
      statistics: {
        movieFileQuality: toStringValue(raw?.movieFile?.quality?.quality?.name),
        runtime: toNumber(raw?.runtime ?? raw?.movieFile?.mediaInfo?.runTime),
      },
    } as LibraryItem;
  }

  const stats = raw?.statistics ?? {};
  const episodeFileCount = toNumber(stats?.episodeFileCount ?? raw?.episodeFileCount) ?? 0;

  return {
    ...base,
    type: "series",
    monitored: toBoolean(raw?.monitored),
    hasFile: episodeFileCount > 0,
    qualityProfileId: toNumber(raw?.qualityProfileId),
    qualityProfileName: toStringValue(raw?.qualityProfile?.name),
    languageProfileId: toNumber(raw?.languageProfileId),
    languageProfileName: toStringValue(raw?.languageProfile?.name),
    rootFolderPath: toStringValue(raw?.path ?? raw?.rootFolderPath),
    sizeOnDisk: toNumber(stats?.sizeOnDisk),
    path: toStringValue(raw?.path),
    status: toStringValue(raw?.status),
    remoteIds: {
      tmdbId: toNumber(raw?.tmdbId),
      imdbId: toStringValue(raw?.imdbId),
      tvdbId: toNumber(raw?.tvdbId),
    },
    seasons: normalizeSeasons(raw?.seasons),
    statistics: {
      seasonCount: toNumber(stats?.seasonCount),
      episodeCount: toNumber(stats?.episodeCount),
      episodeFileCount,
      totalEpisodeCount: toNumber(stats?.totalEpisodeCount),
      monitoredSeasons: Array.isArray(raw?.seasons)
        ? raw.seasons.filter((season: any) => toBoolean(season?.monitored)).length
        : undefined,
      runtime: toNumber(raw?.runtime),
    },
  } as LibraryItem;
};

const libraryQuerySchema = z.object({
  service: libraryServiceSchema.optional(),
  instanceId: z.string().optional(),
});

const libraryRoute: FastifyPluginCallback = (app, _opts, done) => {
  app.get("/library", async (request, reply) => {
    if (!request.currentUser) {
      reply.status(401);
      return multiInstanceLibraryResponseSchema.parse({
        instances: [],
        aggregated: [],
        totalCount: 0,
      });
    }

    const parsed = libraryQuerySchema.parse(request.query ?? {});

    const where: {
      userId: string;
      enabled: boolean;
      service?: ServiceType | { in: ServiceType[] };
      id?: string;
    } = {
      userId: request.currentUser.id,
      enabled: true,
    };

    if (parsed.instanceId) {
      where.id = parsed.instanceId;
    }

    if (parsed.service) {
      where.service = parsed.service.toUpperCase() as ServiceType;
    } else {
      where.service = { in: ["SONARR", "RADARR"] } as { in: ServiceType[] };
    }

    const instances = await app.prisma.serviceInstance.findMany({ where, orderBy: { label: "asc" } });

    const instanceResults: Array<{
      instanceId: string;
      instanceName: string;
      service: LibraryService;
      data: LibraryItem[];
    }> = [];
    const aggregated: LibraryItem[] = [];

    for (const instance of instances) {
      const service = instance.service.toLowerCase() as LibraryService;
      try {
        const fetcher = createInstanceFetcher(app, instance as ServiceInstance);
        const path = service === "radarr" ? "/api/v3/movie" : "/api/v3/series";
        const response = await fetcher(path);
        const payload = await response.json();
        const items = Array.isArray(payload)
          ? payload.map((raw: any) => buildLibraryItem(instance as ServiceInstance, service, raw))
          : [];
        instanceResults.push({
          instanceId: instance.id,
          instanceName: instance.label,
          service,
          data: items,
        });
        aggregated.push(...items);
      } catch (error) {
        request.log.error({ err: error, instance: instance.id }, "library fetch failed");
        instanceResults.push({
          instanceId: instance.id,
          instanceName: instance.label,
          service,
          data: [],
        });
      }
    }

    return multiInstanceLibraryResponseSchema.parse({
      instances: instanceResults,
      aggregated,
      totalCount: aggregated.length,
    });
  });

  app.post("/library/monitor", async (request, reply) => {
    if (!request.currentUser) {
      reply.status(401);
      return reply.send({ message: "Unauthorized" });
    }

    const payload = libraryToggleMonitorRequestSchema.parse(request.body ?? {});

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

    const service = instance.service.toLowerCase() as LibraryService;
    if (service !== payload.service) {
      reply.status(400);
      return reply.send({ message: "Instance service mismatch" });
    }

    const fetcher = createInstanceFetcher(app, instance as ServiceInstance);
    const itemId = encodeURIComponent(String(payload.itemId));

    try {
      if (service === "radarr") {
        const response = await fetcher(`/api/v3/movie/${itemId}`);
        const movie = await response.json();
        movie.monitored = payload.monitored;
        await fetcher(`/api/v3/movie/${itemId}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(movie),
        });
        reply.status(204);
        return reply.send();
      }

      const response = await fetcher(`/api/v3/series/${itemId}`);
      const series = await response.json();
      series.monitored = payload.monitored;
      if (Array.isArray(series.seasons)) {
        const seasonNumbers = payload.seasonNumbers
          ?.map((number) => Number(number))
          .filter((value) => Number.isFinite(value));
        series.seasons = series.seasons.map((season: any) => {
          const seasonNumber = toNumber(season?.seasonNumber) ?? 0;
          const hasSelections = Array.isArray(seasonNumbers) && seasonNumbers.length > 0;

          let nextMonitored = !!season?.monitored;

          if (hasSelections) {
            if (seasonNumbers!.includes(seasonNumber)) {
              nextMonitored = payload.monitored;
            }
          } else {
            nextMonitored = seasonNumber === 0 ? false : payload.monitored;
          }

          return {
            ...season,
            monitored: nextMonitored,
          };
        });
      }
      await fetcher(`/api/v3/series/${itemId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(series),
      });
      reply.status(204);
      return reply.send();
    } catch (error) {
      request.log.error({ err: error, instance: instance.id, itemId: payload.itemId }, "failed to update monitoring");
      reply.status(502);
      return reply.send({ message: "Failed to update monitoring" });
    }
  });


app.post("/library/season/search", async (request, reply) => {
  if (!request.currentUser) {
    reply.status(401);
    return reply.send({ message: "Unauthorized" });
  }

  const payload = librarySeasonSearchRequestSchema.parse(request.body ?? {});

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

  const service = instance.service.toLowerCase() as LibraryService;
  if (service !== "sonarr") {
    reply.status(400);
    return reply.send({ message: "Season search is only supported for Sonarr instances" });
  }

  const seriesId = Number(payload.seriesId);
  if (!Number.isFinite(seriesId)) {
    reply.status(400);
    return reply.send({ message: "Invalid series identifier" });
  }

  const seasonNumber = Number(payload.seasonNumber);
  if (!Number.isFinite(seasonNumber)) {
    reply.status(400);
    return reply.send({ message: "Invalid season number" });
  }

  const fetcher = createInstanceFetcher(app, instance as ServiceInstance);

  try {
    await fetcher("/api/v3/command", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "SeasonSearch",
        seriesId,
        seasonNumber,
      }),
    });

    reply.status(202);
    return reply.send({ message: "Season search queued" });
  } catch (error) {
    request.log.error(
      { err: error, instance: instance.id, seriesId, seasonNumber },
      "failed to queue season search",
    );
    reply.status(502);
    return reply.send({ message: "Failed to queue season search" });
  }
});app.post("/library/series/search", async (request, reply) => {
  if (!request.currentUser) {
    reply.status(401);
    return reply.send({ message: "Unauthorized" });
  }

  const payload = librarySeriesSearchRequestSchema.parse(request.body ?? {});

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

  const service = instance.service.toLowerCase() as LibraryService;
  if (service !== "sonarr") {
    reply.status(400);
    return reply.send({ message: "Series search is only supported for Sonarr instances" });
  }

  const seriesId = Number(payload.seriesId);
  if (!Number.isFinite(seriesId)) {
    reply.status(400);
    return reply.send({ message: "Invalid series identifier" });
  }

  const fetcher = createInstanceFetcher(app, instance as ServiceInstance);

  try {
    await fetcher("/api/v3/command", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "SeriesSearch",
        seriesId,
      }),
    });

    reply.status(202);
    return reply.send({ message: "Series search queued" });
  } catch (error) {
    request.log.error({ err: error, instance: instance.id, seriesId }, "failed to queue series search");
    reply.status(502);
    return reply.send({ message: "Failed to queue series search" });
  }
});
app.post("/library/movie/search", async (request, reply) => {
  if (!request.currentUser) {
    reply.status(401);
    return reply.send({ message: "Unauthorized" });
  }

  const payload = libraryMovieSearchRequestSchema.parse(request.body ?? {});

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

  const service = instance.service.toLowerCase() as LibraryService;
  if (service !== "radarr") {
    reply.status(400);
    return reply.send({ message: "Movie search is only supported for Radarr instances" });
  }

  const movieId = Number(payload.movieId);
  if (!Number.isFinite(movieId)) {
    reply.status(400);
    return reply.send({ message: "Invalid movie identifier" });
  }

  const fetcher = createInstanceFetcher(app, instance as ServiceInstance);

  try {
    await fetcher("/api/v3/command", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "MoviesSearch",
        movieIds: [movieId],
      }),
    });

    reply.status(202);
    return reply.send({ message: "Movie search queued" });
  } catch (error) {
    request.log.error({ err: error, instance: instance.id, movieId }, "failed to queue movie search");
    reply.status(502);
    return reply.send({ message: "Failed to queue movie search" });
  }
});


  done();
};

export const registerLibraryRoutes = libraryRoute;


















