import { z } from "zod";

export const recommendationTypeSchema = z.enum([
  "trending",
  "popular",
  "top_rated",
  "upcoming",
  "airing_today"
]);

export type RecommendationType = z.infer<typeof recommendationTypeSchema>;

export const recommendationItemSchema = z.object({
  id: z.number(),
  tmdbId: z.number(),
  title: z.string(),
  overview: z.string().optional(),
  posterUrl: z.string().optional(),
  backdropUrl: z.string().optional(),
  releaseDate: z.string().optional(),
  rating: z.number().optional(),
  voteCount: z.number().optional(),
  popularity: z.number().optional(),
});

export type RecommendationItem = z.infer<typeof recommendationItemSchema>;

export const recommendationsRequestSchema = z.object({
  type: recommendationTypeSchema,
  mediaType: z.enum(["movie", "series"]),
});

export type RecommendationsRequest = z.infer<typeof recommendationsRequestSchema>;

export const recommendationsResponseSchema = z.object({
  type: recommendationTypeSchema,
  mediaType: z.enum(["movie", "series"]),
  items: z.array(recommendationItemSchema),
  totalResults: z.number(),
});

export type RecommendationsResponse = z.infer<typeof recommendationsResponseSchema>;
