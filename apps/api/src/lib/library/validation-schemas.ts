import { libraryServiceSchema } from "@arr/shared";
import { z } from "zod";

/**
 * Validation schema for library query parameters
 * Supports pagination, search, filtering, and sorting
 */
export const libraryQuerySchema = z.object({
	// Instance filtering
	service: libraryServiceSchema.optional(),
	instanceId: z.string().optional(),

	// Pagination
	page: z.coerce.number().int().min(1).default(1),
	limit: z.coerce.number().int().min(1).max(100).default(50),

	// Search
	search: z.string().optional(),

	// Filters
	monitored: z.enum(["true", "false", "all"]).default("all"),
	hasFile: z.enum(["true", "false", "all"]).default("all"),
	status: z.string().optional(),
	qualityProfileId: z.coerce.number().int().optional(),
	yearMin: z.coerce.number().int().optional(),
	yearMax: z.coerce.number().int().optional(),

	// Sorting
	sortBy: z.enum(["title", "sortTitle", "year", "sizeOnDisk", "added"]).default("sortTitle"),
	sortOrder: z.enum(["asc", "desc"]).default("asc"),
});

export type LibraryQuery = z.infer<typeof libraryQuerySchema>;
