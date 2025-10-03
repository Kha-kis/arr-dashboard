import { z } from "zod";

const discoverServiceSchema = z.enum(["sonarr", "radarr"]);

export const discoverSearchTypeSchema = z.enum(["movie", "series"]);
export type DiscoverSearchType = z.infer<typeof discoverSearchTypeSchema>;

export const discoverResultInstanceStateSchema = z.object({
  instanceId: z.string(),
  instanceName: z.string(),
  service: discoverServiceSchema,
  exists: z.boolean(),
  monitored: z.boolean().optional(),
  hasFile: z.boolean().optional(),
  qualityProfileId: z.number().optional(),
  rootFolderPath: z.string().optional(),
});

export type DiscoverResultInstanceState = z.infer<typeof discoverResultInstanceStateSchema>;

export const discoverSearchResultSchema = z.object({
  id: z.string(),
  title: z.string(),
  sortTitle: z.string().optional(),
  type: discoverSearchTypeSchema,
  year: z.number().optional(),
  overview: z.string().optional(),
  remoteIds: z
    .object({
      tmdbId: z.number().optional(),
      imdbId: z.string().optional(),
      tvdbId: z.number().optional(),
      tvrageId: z.number().optional(),
    })
    .optional(),
  images: z
    .object({
      poster: z.string().optional(),
      fanart: z.string().optional(),
      banner: z.string().optional(),
    })
    .optional(),
  genres: z.array(z.string()).optional(),
  status: z.string().optional(),
  network: z.string().optional(),
  studio: z.string().optional(),
  runtime: z.number().optional(),
  ratings: z
    .object({
      value: z.number().optional(),
      votes: z.number().optional(),
    })
    .optional(),
  instanceStates: z.array(discoverResultInstanceStateSchema),
});

export type DiscoverSearchResult = z.infer<typeof discoverSearchResultSchema>;

export const discoverSearchRequestSchema = z.object({
  query: z.string().trim().min(1).max(200),
  type: discoverSearchTypeSchema.default("movie"),
});

export type DiscoverSearchRequest = z.infer<typeof discoverSearchRequestSchema>;

export const discoverSearchResponseSchema = z.object({
  results: z.array(discoverSearchResultSchema),
  totalCount: z.number().nonnegative(),
});

export type DiscoverSearchResponse = z.infer<typeof discoverSearchResponseSchema>;

export const discoverQualityProfileSchema = z.object({
  id: z.number(),
  name: z.string(),
});

export type DiscoverQualityProfile = z.infer<typeof discoverQualityProfileSchema>;

export const discoverLanguageProfileSchema = z.object({
  id: z.number(),
  name: z.string(),
});

export type DiscoverLanguageProfile = z.infer<typeof discoverLanguageProfileSchema>;

export const discoverRootFolderSchema = z.object({
  id: z.union([z.number(), z.string()]).optional(),
  path: z.string(),
  accessible: z.boolean().optional(),
  freeSpace: z.number().optional(),
});

export type DiscoverRootFolder = z.infer<typeof discoverRootFolderSchema>;

export const discoverAddPayloadSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("movie"),
    tmdbId: z.number().optional(),
    imdbId: z.string().optional(),
    title: z.string(),
    year: z.number().optional(),
    qualityProfileId: z.number(),
    rootFolderPath: z.string(),
    monitored: z.boolean().default(true),
    searchOnAdd: z.boolean().default(true),
    minimumAvailability: z.string().optional(),
    tags: z.array(z.number()).optional(),
  }),
  z.object({
    type: z.literal("series"),
    tvdbId: z.number().optional(),
    tmdbId: z.number().optional(),
    title: z.string(),
    qualityProfileId: z.number(),
    languageProfileId: z.number().optional(),
    rootFolderPath: z.string(),
    monitored: z.boolean().default(true),
    searchOnAdd: z.boolean().default(true),
    seasonFolder: z.boolean().optional(),
    seriesType: z.string().optional(),
    tags: z.array(z.number()).optional(),
  }),
]);

export type DiscoverAddPayload = z.infer<typeof discoverAddPayloadSchema>;

export const discoverAddRequestSchema = z.object({
  instanceId: z.string(),
  payload: discoverAddPayloadSchema,
});

export type DiscoverAddRequest = z.infer<typeof discoverAddRequestSchema>;

export const discoverAddResponseSchema = z.object({
  success: z.boolean(),
  instanceId: z.string(),
  itemId: z.union([z.number(), z.string()]).optional(),
});

export type DiscoverAddResponse = z.infer<typeof discoverAddResponseSchema>;

export const discoverInstanceOptionsRequestSchema = z.object({
  instanceId: z.string(),
  type: discoverSearchTypeSchema.default("movie"),
});

export type DiscoverInstanceOptionsRequest = z.infer<typeof discoverInstanceOptionsRequestSchema>;

export const discoverInstanceOptionsResponseSchema = z.object({
  instanceId: z.string(),
  service: discoverServiceSchema,
  qualityProfiles: z.array(discoverQualityProfileSchema),
  rootFolders: z.array(discoverRootFolderSchema),
  languageProfiles: z.array(discoverLanguageProfileSchema).optional(),
});

export type DiscoverInstanceOptionsResponse = z.infer<typeof discoverInstanceOptionsResponseSchema>;
