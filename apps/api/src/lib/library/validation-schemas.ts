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
	// Note: limit must be >= 1. Earlier revisions allowed `limit=0` as a
	// "fetch all" affordance for an internal discover-filtering hook
	// (`useLibraryForFiltering`). That hook is no longer used and the
	// fetch-all path mass-loads every LibraryCache row's data JSON blob —
	// trivially OOMs the 768 MB container heap on a 50k+ item library
	// (issue #427 follow-up). Reject the request instead.
	page: z.coerce.number().int().min(1).default(1),
	limit: z.coerce.number().int().min(1).max(10000).default(50),

	// Search
	search: z.string().optional(),

	// Filters
	monitored: z.enum(["true", "false", "all"]).default("all"),
	hasFile: z.enum(["true", "false", "all"]).default("all"),
	cutoffUnmet: z.enum(["true", "false", "all"]).default("all"),
	// qui torrent-state filter — `all` skips the filter entirely, `none`
	// matches LibraryCache rows where `torrentState` is NULL (no qui data
	// yet), other values match the normalized vocab exactly.
	torrentState: z
		.enum([
			"all",
			"none",
			"seeding",
			"downloading",
			"stalled_dl",
			"paused",
			"queued",
			"checking",
			"moving",
			"error",
			"unknown",
		])
		.default("all"),
	status: z.string().optional(),
	qualityProfileId: z.coerce.number().int().optional(),
	yearMin: z.coerce.number().int().optional(),
	yearMax: z.coerce.number().int().optional(),

	// Sorting
	sortBy: z
		.enum(["title", "sortTitle", "year", "sizeOnDisk", "added", "torrentRatio"])
		.default("sortTitle"),
	sortOrder: z.enum(["asc", "desc"]).default("asc"),
});
