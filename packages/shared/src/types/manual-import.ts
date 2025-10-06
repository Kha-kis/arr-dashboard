import { z } from "zod";

export const manualImportRejectionSchema = z.object({
  reason: z.string().optional(),
  type: z.string().optional(),
});

export const manualImportEpisodeSchema = z.object({
  id: z.number(),
  title: z.string().optional(),
  seasonNumber: z.number().optional(),
  episodeNumber: z.number().optional(),
});

export const manualImportSeriesSchema = z.object({
  id: z.number(),
  title: z.string().optional(),
  titleSlug: z.string().optional(),
});

export const manualImportMovieSchema = z.object({
  id: z.number(),
  title: z.string().optional(),
  tmdbId: z.number().optional(),
  imdbId: z.string().optional(),
});

const manualImportBaseCandidateSchema = z.object({
  id: z.union([z.string(), z.number()]),
  path: z.string(),
  relativePath: z.string().optional(),
  folderName: z.string().optional(),
  name: z.string().optional(),
  size: z.number().optional(),
  downloadId: z.string().optional(),
  releaseGroup: z.string().optional(),
  quality: z.unknown().optional(),
  languages: z.array(z.unknown()).optional(),
  customFormats: z.array(z.unknown()).optional(),
  customFormatScore: z.number().optional(),
  indexerFlags: z.number().optional(),
  releaseType: z.string().optional(),
  rejections: z.array(manualImportRejectionSchema).optional(),
  episodeFileId: z.number().optional(),
  movieFileId: z.number().optional(),
});

export const manualImportSonarrCandidateSchema =
  manualImportBaseCandidateSchema.extend({
    service: z.literal("sonarr"),
    series: manualImportSeriesSchema.optional(),
    seasonNumber: z.number().optional(),
    episodes: z.array(manualImportEpisodeSchema).optional(),
  });

export const manualImportRadarrCandidateSchema =
  manualImportBaseCandidateSchema.extend({
    service: z.literal("radarr"),
    movie: manualImportMovieSchema.optional(),
  });

export const manualImportCandidateSchema = z.union([
  manualImportSonarrCandidateSchema,
  manualImportRadarrCandidateSchema,
]);

export const manualImportCandidateListSchema = z.array(
  manualImportCandidateSchema,
);

export type ManualImportRejection = z.infer<typeof manualImportRejectionSchema>;
export type ManualImportEpisode = z.infer<typeof manualImportEpisodeSchema>;
export type ManualImportSeries = z.infer<typeof manualImportSeriesSchema>;
export type ManualImportMovie = z.infer<typeof manualImportMovieSchema>;
export type ManualImportCandidate = z.infer<typeof manualImportCandidateSchema>;
export type ManualImportCandidateSonarr = z.infer<
  typeof manualImportSonarrCandidateSchema
>;
export type ManualImportCandidateRadarr = z.infer<
  typeof manualImportRadarrCandidateSchema
>;

export const manualImportSubmissionFileSchema = z.object({
  path: z.string(),
  folderName: z.string().optional(),
  downloadId: z.string(),
  seriesId: z.number().optional(),
  episodeIds: z.array(z.number()).optional(),
  episodeFileId: z.number().optional(),
  movieId: z.number().optional(),
  movieFileId: z.number().optional(),
  quality: z.unknown().optional(),
  languages: z.array(z.unknown()).optional(),
  releaseGroup: z.string().optional(),
  indexerFlags: z.number().optional(),
  releaseType: z.string().optional(),
});

export const manualImportSubmissionSchema = z.object({
  instanceId: z.string(),
  service: z.enum(["sonarr", "radarr"]),
  importMode: z.enum(["auto", "move", "copy"]).default("auto"),
  files: z.array(manualImportSubmissionFileSchema).min(1),
});

export type ManualImportSubmissionFile = z.infer<
  typeof manualImportSubmissionFileSchema
>;
export type ManualImportSubmission = z.infer<
  typeof manualImportSubmissionSchema
>;

export const manualImportFetchQuerySchema = z.object({
  downloadId: z.string().optional(),
  folder: z.string().optional(),
  seriesId: z.coerce.number().optional(),
  seasonNumber: z.coerce.number().optional(),
  filterExistingFiles: z.coerce.boolean().optional(),
});

export type ManualImportFetchQuery = z.infer<
  typeof manualImportFetchQuerySchema
>;
