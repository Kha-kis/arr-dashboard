/**
 * Shared Zod schemas for route validation
 * Minimal types for ARR quality profiles and format items
 */

import { z } from "zod";

// Generic helpers
export const StringArray = z.array(z.string());
export const OptString = z.string().optional().nullable();

export const ArrQualityProfileItem = z.object({
	format: z.number(), // ARR custom format ID
	score: z.number(),
	name: z.string().optional(),
});

export const ArrQualityProfile = z.object({
	id: z.number(),
	name: z.string(),
	upgradeAllowed: z.boolean().optional(),
	cutoff: z.number().optional(),
	minFormatScore: z.number().optional(),
	cutoffFormatScore: z.number().optional(),
	formatItems: z.array(ArrQualityProfileItem).default([]),
});

export type TArrQualityProfile = z.infer<typeof ArrQualityProfile>;
export type TArrQualityProfileItem = z.infer<typeof ArrQualityProfileItem>;
