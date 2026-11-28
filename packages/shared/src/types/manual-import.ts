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

export const manualImportArtistSchema = z.object({
	id: z.number(),
	artistName: z.string().optional(),
	foreignArtistId: z.string().optional(),
});

export const manualImportAlbumSchema = z.object({
	id: z.number(),
	title: z.string().optional(),
	foreignAlbumId: z.string().optional(),
});

export const manualImportAuthorSchema = z.object({
	id: z.number(),
	authorName: z.string().optional(),
	foreignAuthorId: z.string().optional(),
});

export const manualImportBookSchema = z.object({
	id: z.number(),
	title: z.string().optional(),
	foreignBookId: z.string().optional(),
});

export const manualImportTrackIdsSchema = z
	.array(z.number().int().positive().max(Number.MAX_SAFE_INTEGER))
	.min(1)
	.max(1000)
	.refine((ids) => new Set(ids).size === ids.length);
export const manualImportForeignEditionIdSchema = z
	.string()
	.min(1)
	.max(1024)
	.refine((value) => value === value.trim());
const manualImportTracksSchema = z
	.array(z.object({ id: z.number().int().positive().max(Number.MAX_SAFE_INTEGER) }))
	.min(1)
	.max(1000)
	.refine((tracks) => new Set(tracks.map((track) => track.id)).size === tracks.length);

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

export const manualImportSonarrCandidateSchema = manualImportBaseCandidateSchema.extend({
	service: z.literal("sonarr"),
	series: manualImportSeriesSchema.optional(),
	seasonNumber: z.number().optional(),
	episodes: z.array(manualImportEpisodeSchema).optional(),
});

export const manualImportRadarrCandidateSchema = manualImportBaseCandidateSchema.extend({
	service: z.literal("radarr"),
	movie: manualImportMovieSchema.optional(),
});

export const manualImportLidarrCandidateSchema = manualImportBaseCandidateSchema.extend({
	service: z.literal("lidarr"),
	artist: manualImportArtistSchema.optional(),
	album: manualImportAlbumSchema.optional(),
	albumReleaseId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
	tracks: manualImportTracksSchema.optional(),
});

export const manualImportReadarrCandidateSchema = manualImportBaseCandidateSchema.extend({
	service: z.literal("readarr"),
	author: manualImportAuthorSchema.optional(),
	book: manualImportBookSchema.optional(),
	foreignEditionId: manualImportForeignEditionIdSchema.optional(),
});

// Using discriminatedUnion for better error messages and faster validation
export const manualImportCandidateSchema = z.discriminatedUnion("service", [
	manualImportSonarrCandidateSchema,
	manualImportRadarrCandidateSchema,
	manualImportLidarrCandidateSchema,
	manualImportReadarrCandidateSchema,
]);

export const manualImportCandidateListSchema = z.array(manualImportCandidateSchema);

export type ManualImportRejection = z.infer<typeof manualImportRejectionSchema>;
export type ManualImportEpisode = z.infer<typeof manualImportEpisodeSchema>;
export type ManualImportSeries = z.infer<typeof manualImportSeriesSchema>;
export type ManualImportMovie = z.infer<typeof manualImportMovieSchema>;
export type ManualImportArtist = z.infer<typeof manualImportArtistSchema>;
export type ManualImportAlbum = z.infer<typeof manualImportAlbumSchema>;
export type ManualImportAuthor = z.infer<typeof manualImportAuthorSchema>;
export type ManualImportBook = z.infer<typeof manualImportBookSchema>;
export type ManualImportCandidate = z.infer<typeof manualImportCandidateSchema>;
export type ManualImportCandidateSonarr = z.infer<typeof manualImportSonarrCandidateSchema>;
export type ManualImportCandidateRadarr = z.infer<typeof manualImportRadarrCandidateSchema>;
export type ManualImportCandidateLidarr = z.infer<typeof manualImportLidarrCandidateSchema>;
export type ManualImportCandidateReadarr = z.infer<typeof manualImportReadarrCandidateSchema>;

// Common fields shared by all submission file types
const manualImportSubmissionFileBaseSchema = z.object({
	path: z.string(),
	folderName: z.string().optional(),
	downloadId: z.string(),
	quality: z.unknown().optional(),
	languages: z.array(z.unknown()).optional(),
	releaseGroup: z.string().optional(),
	indexerFlags: z.number().optional(),
});

// Sonarr submission file - requires seriesId and episodeIds
export const manualImportSonarrSubmissionFileSchema = manualImportSubmissionFileBaseSchema.extend({
	seriesId: z.number(),
	episodeIds: z.array(z.number()).min(1),
	episodeFileId: z.number().optional(),
	releaseType: z.string().optional(),
});

// Radarr submission file - requires movieId
export const manualImportRadarrSubmissionFileSchema = manualImportSubmissionFileBaseSchema.extend({
	movieId: z.number(),
	movieFileId: z.number().optional(),
});

// Lidarr submission file - requires artistId and albumId
export const manualImportLidarrSubmissionFileSchema = manualImportSubmissionFileBaseSchema.extend({
	artistId: z.number(),
	albumId: z.number(),
	albumReleaseId: z.number().optional(),
	trackIds: manualImportTrackIdsSchema.optional(),
	trackFileId: z.number().optional(),
});

// Readarr submission file - requires authorId and bookId
export const manualImportReadarrSubmissionFileSchema = manualImportSubmissionFileBaseSchema.extend({
	authorId: z.number(),
	bookId: z.number(),
	bookFileId: z.number().optional(),
	foreignEditionId: manualImportForeignEditionIdSchema.optional(),
});

// Legacy schema for backward compatibility - accepts any combination
// Used by buildCommandFiles which validates fields at runtime
export const manualImportSubmissionFileSchema = z.object({
	path: z.string(),
	folderName: z.string().optional(),
	downloadId: z.string(),
	// Sonarr fields
	seriesId: z.number().optional(),
	episodeIds: z.array(z.number()).optional(),
	episodeFileId: z.number().optional(),
	// Radarr fields
	movieId: z.number().optional(),
	movieFileId: z.number().optional(),
	// Lidarr fields
	artistId: z.number().optional(),
	albumId: z.number().optional(),
	albumReleaseId: z.number().optional(),
	trackIds: z.array(z.number()).optional(),
	trackFileId: z.number().optional(),
	// Readarr fields
	authorId: z.number().optional(),
	bookId: z.number().optional(),
	bookFileId: z.number().optional(),
	foreignEditionId: manualImportForeignEditionIdSchema.optional(),
	// Common fields
	quality: z.unknown().optional(),
	languages: z.array(z.unknown()).optional(),
	releaseGroup: z.string().optional(),
	indexerFlags: z.number().optional(),
	releaseType: z.string().optional(),
});

// Service type for manual import (excludes prowlarr which doesn't support it)
export const manualImportServiceSchema = z.enum(["sonarr", "radarr", "lidarr", "readarr"]);
export type ManualImportServiceType = z.infer<typeof manualImportServiceSchema>;

export const manualImportOperationStateSchema = z.enum([
	"preparing",
	"submitting",
	"pending",
	"unknown",
	"partial",
	"completed",
	"failed",
	"not-submitted",
]);
export const manualImportOperationReasonSchema = z.enum([
	"evidence-unavailable",
	"coverage-incomplete",
	"budget-yield",
	"connection-changed",
	"not-submitted",
]);
export const manualImportOperationStatusSchema = z
	.object({
		operationId: z.string().min(1).max(128),
		state: manualImportOperationStateSchema,
		reason: manualImportOperationReasonSchema.nullable(),
		selectedFileCount: z.number().int().min(1).max(1000),
		verifiedFileCount: z.number().int().min(0).max(1000),
		// A UI hint only: a new submission still needs current target/source authorization.
		canConsiderNewAttempt: z.boolean(),
	})
	.strict()
	.refine(
		(status) =>
			status.verifiedFileCount <= status.selectedFileCount &&
			(status.state !== "completed" || status.verifiedFileCount === status.selectedFileCount) &&
			(status.state !== "partial" ||
				(status.verifiedFileCount > 0 && status.verifiedFileCount < status.selectedFileCount)) &&
			(!["failed", "not-submitted"].includes(status.state) || status.verifiedFileCount === 0) &&
			(!status.canConsiderNewAttempt ||
				(["partial", "unknown", "failed", "not-submitted"].includes(status.state) &&
					status.verifiedFileCount < status.selectedFileCount)),
		{ message: "Import progress is inconsistent." },
	);
export type ManualImportOperationStatus = z.infer<typeof manualImportOperationStatusSchema>;

export const manualImportLegacyQuerySchema = z
	.object({
		instanceId: z.string().min(1).max(128),
		service: manualImportServiceSchema,
		downloadId: z
			.string()
			.min(1)
			.max(1024)
			.refine((value) => value === value.trim()),
	})
	.strict();
export const manualImportLegacyStatusSchema = z.discriminatedUnion("kind", [
	z.object({ kind: z.literal("none") }).strict(),
	z.object({ kind: z.literal("unavailable"), reason: z.literal("evidence-unavailable") }).strict(),
	z.object({ kind: z.literal("observed"), operation: manualImportOperationStatusSchema }).strict(),
]);
export type ManualImportLegacyStatus = z.infer<typeof manualImportLegacyStatusSchema>;
export type ManualImportLegacyQuery = z.infer<typeof manualImportLegacyQuerySchema>;

export const manualImportRemainderParamsSchema = z
	.object({
		operationId: z
			.string()
			.min(1)
			.max(128)
			.refine((value) => value === value.trim()),
	})
	.strict();
/** Fresh review candidates are not submission or cleanup permission. */
export const manualImportRemainderReviewSchema = z
	.object({
		operation: manualImportOperationStatusSchema,
		importMode: z.enum(["move", "copy"]),
		sourceFileCount: z.number().int().min(1).max(1000),
		sourceVerifiedFileCount: z.number().int().min(0).max(1000),
		verifiedEpisodeCount: z.number().int().min(0).max(10000),
		unavailableFileCount: z.number().int().min(0).max(1000),
		candidates: manualImportCandidateListSchema.max(1000),
	})
	.strict()
	.refine(
		(review) =>
			review.operation.canConsiderNewAttempt &&
			["unknown", "partial", "failed"].includes(review.operation.state) &&
			review.sourceFileCount <= review.operation.selectedFileCount &&
			review.sourceVerifiedFileCount <= review.operation.verifiedFileCount &&
			review.sourceFileCount ===
				review.sourceVerifiedFileCount + review.unavailableFileCount + review.candidates.length &&
			new Set(review.candidates.map((candidate) => candidate.path)).size ===
				review.candidates.length,
		{ message: "Remaining import review is inconsistent." },
	);
export type ManualImportRemainderReview = z.infer<typeof manualImportRemainderReviewSchema>;

export const manualImportSourceQuerySchema = manualImportLegacyQuerySchema.extend({
	cursor: z.string().min(1).max(128).optional(),
});
// Ordering history never establishes a current attempt or mutation permission.
export const manualImportSourceStatusSchema = z.discriminatedUnion("kind", [
	...manualImportLegacyStatusSchema.options,
	z
		.object({
			kind: z.literal("history"),
			operations: z.array(manualImportOperationStatusSchema).max(20),
			nextCursor: z.string().min(1).max(128).nullable(),
		})
		.strict()
		.refine(
			(page) =>
				new Set(page.operations.map((operation) => operation.operationId)).size ===
					page.operations.length &&
				(page.nextCursor === null || page.nextCursor === page.operations.at(-1)?.operationId),
			{ message: "Import history page is inconsistent." },
		),
]);
export type ManualImportSourceQuery = z.infer<typeof manualImportSourceQuerySchema>;
export type ManualImportSourceStatus = z.infer<typeof manualImportSourceStatusSchema>;

// Type-safe submission schemas per service
const manualImportAttemptKeySchema = z
	.string()
	.min(1)
	.max(128)
	.regex(/^[A-Za-z0-9][A-Za-z0-9:_-]*$/)
	.optional();

export const manualImportSonarrSubmissionSchema = z.object({
	instanceId: z.string(),
	idempotencyKey: manualImportAttemptKeySchema,
	service: z.literal("sonarr"),
	importMode: z.enum(["auto", "move", "copy"]).default("auto"),
	files: z.array(manualImportSonarrSubmissionFileSchema).min(1),
});

export const manualImportRadarrSubmissionSchema = z.object({
	instanceId: z.string(),
	idempotencyKey: manualImportAttemptKeySchema,
	service: z.literal("radarr"),
	importMode: z.enum(["auto", "move", "copy"]).default("auto"),
	files: z.array(manualImportRadarrSubmissionFileSchema).min(1),
});

export const manualImportLidarrSubmissionSchema = z.object({
	instanceId: z.string(),
	idempotencyKey: manualImportAttemptKeySchema,
	service: z.literal("lidarr"),
	importMode: z.enum(["auto", "move", "copy"]).default("auto"),
	files: z.array(manualImportLidarrSubmissionFileSchema).min(1),
});

export const manualImportReadarrSubmissionSchema = z.object({
	instanceId: z.string(),
	idempotencyKey: manualImportAttemptKeySchema,
	service: z.literal("readarr"),
	importMode: z.enum(["auto", "move", "copy"]).default("auto"),
	files: z.array(manualImportReadarrSubmissionFileSchema).min(1),
});

// Compatibility request shape; execution verifies mappings against current candidates.
export const manualImportSubmissionSchema = z
	.object({
		instanceId: z.string(),
		idempotencyKey: manualImportAttemptKeySchema,
		remainderOf: manualImportRemainderParamsSchema.shape.operationId.optional(),
		service: manualImportServiceSchema,
		importMode: z.enum(["auto", "move", "copy"]).default("auto"),
		files: z.array(manualImportSubmissionFileSchema).min(1),
	})
	.refine((request) => request.remainderOf === undefined || request.idempotencyKey !== undefined, {
		message: "A remaining-file intention requires its explicit attempt key.",
	});

// Type exports
export type ManualImportSubmissionFile = z.infer<typeof manualImportSubmissionFileSchema>;
export type ManualImportSonarrSubmissionFile = z.infer<
	typeof manualImportSonarrSubmissionFileSchema
>;
export type ManualImportRadarrSubmissionFile = z.infer<
	typeof manualImportRadarrSubmissionFileSchema
>;
export type ManualImportLidarrSubmissionFile = z.infer<
	typeof manualImportLidarrSubmissionFileSchema
>;
export type ManualImportReadarrSubmissionFile = z.infer<
	typeof manualImportReadarrSubmissionFileSchema
>;
export type ManualImportSubmission = z.infer<typeof manualImportSubmissionSchema>;
export type ManualImportSonarrSubmission = z.infer<typeof manualImportSonarrSubmissionSchema>;
export type ManualImportRadarrSubmission = z.infer<typeof manualImportRadarrSubmissionSchema>;
export type ManualImportLidarrSubmission = z.infer<typeof manualImportLidarrSubmissionSchema>;
export type ManualImportReadarrSubmission = z.infer<typeof manualImportReadarrSubmissionSchema>;

export const manualImportFetchQuerySchema = z.object({
	downloadId: z.string().optional(),
	folder: z.string().optional(),
	seriesId: z.coerce.number().optional(),
	seasonNumber: z.coerce.number().optional(),
	filterExistingFiles: z
		.union([z.boolean(), z.literal("true"), z.literal("false")])
		.transform((value) => value === true || value === "true")
		.optional(),
});

export type ManualImportFetchQuery = z.infer<typeof manualImportFetchQuerySchema>;
