import { z } from "zod";

export const searchTypeSchema = z.enum(["all", "movie", "tv", "music", "book"]);

export const searchProtocolSchema = z.enum(["torrent", "usenet", "unknown"]);

export const prowlarrIndexerSchema = z.object({
  id: z.number().int().nonnegative(),
  name: z.string(),
  enable: z.boolean(),
  protocol: searchProtocolSchema,
  supportsRss: z.boolean().optional(),
  supportsSearch: z.boolean().optional(),
  supportsRedirect: z.boolean().optional(),
  appProfileId: z.number().int().nonnegative().optional(),
  priority: z.number().int().optional(),
  tags: z.array(z.number().int()).optional(),
  capabilities: z.array(z.string()).optional(),
  instanceId: z.string(),
  instanceName: z.string(),
  instanceUrl: z.string().optional(),
});

export type ProwlarrIndexer = z.infer<typeof prowlarrIndexerSchema>;

export const prowlarrIndexerFieldSchema = z.object({
  name: z.string(),
  label: z.string().optional(),
  helpText: z.string().optional(),
  value: z.union([z.string(), z.number(), z.boolean()]).nullable().optional(),
  type: z.string().optional(),
});

export type ProwlarrIndexerField = z.infer<typeof prowlarrIndexerFieldSchema>;

export const prowlarrIndexerStatsSchema = z.object({
  status: z.string().optional(),
  message: z.string().optional(),
  successRate: z.number().optional(),
  averageResponseTime: z.number().optional(),
  responseTime: z.number().optional(),
  grabs: z.number().optional(),
  fails: z.number().optional(),
  lastCheck: z.string().optional(),
  lastFailure: z.string().optional(),
});

export type ProwlarrIndexerStats = z.infer<typeof prowlarrIndexerStatsSchema>;

export const prowlarrIndexerDetailsSchema = z.object({
  id: z.number().int().nonnegative(),
  name: z.string(),
  enable: z.boolean().optional(),
  protocol: searchProtocolSchema.optional(),
  priority: z.number().int().optional(),
  appProfileId: z.number().int().optional(),
  instanceId: z.string(),
  instanceName: z.string(),
  instanceUrl: z.string().optional(),
  implementationName: z.string().optional(),
  definitionName: z.string().optional(),
  description: z.string().optional(),
  language: z.string().optional(),
  privacy: z.string().optional(),
  isPrivate: z.boolean().optional(),
  capabilities: z.array(z.string()).optional(),
  tags: z.array(z.number().int()).optional(),
  categories: z.array(z.number().int()).optional(),
  fields: z.array(prowlarrIndexerFieldSchema).optional(),
  stats: prowlarrIndexerStatsSchema.optional(),
});

export type ProwlarrIndexerDetails = z.infer<typeof prowlarrIndexerDetailsSchema>;

export const searchIndexerDetailsResponseSchema = z.object({
  indexer: prowlarrIndexerDetailsSchema,
});

export type SearchIndexerDetailsResponse = z.infer<typeof searchIndexerDetailsResponseSchema>;

export const searchIndexersResponseSchema = z.object({
  instances: z.array(
    z.object({
      instanceId: z.string(),
      instanceName: z.string(),
      data: z.array(prowlarrIndexerSchema),
    }),
  ),
  aggregated: z.array(prowlarrIndexerSchema),
  totalCount: z.number().int().nonnegative(),
});

export type SearchIndexersResponse = z.infer<typeof searchIndexersResponseSchema>;

const searchLanguageSchema = z.object({
  id: z.number().int(),
  name: z.string(),
});

export const searchResultSchema = z.object({
  id: z.string(),
  guid: z.string().optional(),
  title: z.string(),
  size: z.number().nonnegative().optional(),
  link: z.string().optional(),
  magnetUrl: z.string().optional(),
  infoUrl: z.string().optional(),
  downloadUrl: z.string().optional(),
  indexer: z.string(),
  indexerId: z.number().int().nonnegative(),
  categories: z.array(z.number().int()).optional(),
  seeders: z.number().nonnegative().optional(),
  leechers: z.number().nonnegative().optional(),
  peers: z.number().nonnegative().optional(),
  grabs: z.number().nonnegative().optional(),
  protocol: searchProtocolSchema,
  publishDate: z.string().optional(),
  age: z.number().nonnegative().optional(),
  ageHours: z.number().nonnegative().optional(),
  ageDays: z.number().nonnegative().optional(),
  downloadClient: z.string().optional(),
  downloadVolumeFactor: z.number().nonnegative().optional(),
  uploadVolumeFactor: z.number().nonnegative().optional(),
  minimumRatio: z.number().nonnegative().optional(),
  minimumSeedTime: z.number().nonnegative().optional(),
  rejectionReasons: z.array(z.string()).optional(),
  rejected: z.boolean().optional(),
  languages: z.array(searchLanguageSchema).optional(),
  quality: z.unknown().optional(),
  instanceId: z.string(),
  instanceName: z.string(),
  instanceUrl: z.string().optional(),
});

export type SearchResult = z.infer<typeof searchResultSchema>;

export const multiInstanceSearchResponseSchema = z.object({
  instances: z.array(
    z.object({
      instanceId: z.string(),
      instanceName: z.string(),
      data: z.array(searchResultSchema),
    }),
  ),
  aggregated: z.array(searchResultSchema),
  totalCount: z.number().int().nonnegative(),
});

export type MultiInstanceSearchResponse = z.infer<typeof multiInstanceSearchResponseSchema>;

const searchFilterSchema = z.object({
  instanceId: z.string(),
  indexerIds: z.array(z.number().int().positive()).optional(),
  categories: z.array(z.number().int().positive()).optional(),
});

export const searchRequestSchema = z.object({
  query: z.string().min(1).max(200),
  type: searchTypeSchema.default("all"),
  limit: z.number().int().min(1).max(200).optional(),
  filters: z.array(searchFilterSchema).optional(),
});

export type SearchRequest = z.infer<typeof searchRequestSchema>;

const grabResultSchema = searchResultSchema.omit({ instanceId: true, instanceName: true });

export const searchGrabRequestSchema = z.object({
  instanceId: z.string(),
  result: grabResultSchema,
});

export type SearchGrabRequest = z.infer<typeof searchGrabRequestSchema>;
export const searchIndexerTestRequestSchema = z.object({
  instanceId: z.string(),
  indexerId: z.number().int().positive(),
});

export type SearchIndexerTestRequest = z.infer<typeof searchIndexerTestRequestSchema>;

export const searchIndexerTestResponseSchema = z.object({
  success: z.boolean(),
  message: z.string().optional(),
});

export type SearchIndexerTestResponse = z.infer<typeof searchIndexerTestResponseSchema>;

export const searchIndexerUpdateRequestSchema = z.object({
  instanceId: z.string(),
  indexer: prowlarrIndexerDetailsSchema,
});

export type SearchIndexerUpdateRequest = z.infer<typeof searchIndexerUpdateRequestSchema>;


