/**
 * Zod schemas for Plex Media Server API responses.
 *
 * These validate the raw MediaContainer-wrapped responses from the Plex API.
 * All schemas use z.looseObject() to tolerate extra fields across Plex versions.
 */

import { z } from "zod";

const plexPaginationFields = {
	offset: z.coerce.number().int().nonnegative().refine(Number.isSafeInteger),
	size: z.coerce.number().int().nonnegative().refine(Number.isSafeInteger),
	totalSize: z.coerce.number().int().nonnegative().refine(Number.isSafeInteger),
};

/** /identity endpoint */
export const plexIdentityResponseSchema = z.looseObject({
	MediaContainer: z.looseObject({
		machineIdentifier: z.string(),
		version: z.string(),
	}),
});

/** / (root) endpoint — richer server info */
export const plexServerInfoResponseSchema = z.looseObject({
	MediaContainer: z.looseObject({
		machineIdentifier: z.string(),
		version: z.string(),
		friendlyName: z.string().optional(),
		platform: z.string().optional(),
	}),
});

/** /library/sections endpoint */
export const plexSectionsResponseSchema = z.looseObject({
	MediaContainer: z.looseObject({
		offset: plexPaginationFields.offset.optional(),
		size: plexPaginationFields.size.optional(),
		totalSize: plexPaginationFields.totalSize.optional(),
		Directory: z
			.array(
				z.looseObject({
					key: z.string(),
					title: z.string().optional().default(""),
					type: z.string(),
					agent: z.string().optional(),
				}),
			)
			.optional(),
	}),
});

const plexBooleanFlagSchema = z
	.union([z.boolean(), z.literal(0), z.literal(1), z.literal("0"), z.literal("1")])
	.transform((value) => value === true || value === 1 || value === "1");

const plexUnixTimestampSchema = z.coerce.number().int().nonnegative().refine(Number.isSafeInteger);

const plexUninitializedUnixTimestampSchema = z.preprocess(
	(value) => (value === undefined || value === null || value === "" ? null : value),
	plexUnixTimestampSchema.nullable(),
);

/** Strict /library/sections settlement probe. */
export const plexSettlementSectionsResponseSchema = z.looseObject({
	MediaContainer: z.looseObject({
		offset: plexPaginationFields.offset.optional(),
		size: plexPaginationFields.size,
		totalSize: plexPaginationFields.totalSize.optional(),
		Directory: z
			.array(
				z.looseObject({
					key: z.coerce.string().min(1),
					uuid: z.string().min(1),
					title: z.string(),
					type: z.string().min(1),
					agent: z.string().optional(),
					refreshing: plexBooleanFlagSchema,
					scannedAt: plexUninitializedUnixTimestampSchema,
					updatedAt: plexUnixTimestampSchema,
				}),
			)
			.optional(),
	}),
});

/** Strict complete /activities settlement probe. */
export const plexActivitiesResponseSchema = z.looseObject({
	MediaContainer: z.looseObject({
		offset: plexPaginationFields.offset.optional(),
		size: plexPaginationFields.size,
		totalSize: plexPaginationFields.totalSize.optional(),
		Activity: z
			.array(
				z.looseObject({
					type: z.string().min(1),
					Context: z
						.looseObject({ librarySectionID: z.coerce.string().min(1).optional() })
						.optional(),
				}),
			)
			.optional(),
	}),
});

/** /library/sections/{id}/all endpoint */
export const plexLibraryItemsResponseSchema = z.looseObject({
	MediaContainer: z.looseObject({
		...plexPaginationFields,
		Metadata: z
			.array(
				z.looseObject({
					ratingKey: z.string(),
					title: z.string().optional().default(""),
					type: z.string(),
					year: z.number().optional(),
					userRating: z.number().optional(),
					addedAt: z.number().optional(),
					viewCount: plexUnixTimestampSchema.optional(),
					lastViewedAt: plexUnixTimestampSchema.optional(),
					thumb: z.string().optional(),
					Guid: z.array(z.looseObject({ id: z.string() })).optional(),
					Collection: z.array(z.looseObject({ tag: z.string() })).optional(),
					Label: z.array(z.looseObject({ tag: z.string() })).optional(),
				}),
			)
			.optional(),
	}),
});

const isValidPlexNativeRatingKey = (value: string): boolean =>
	value.trim().length > 0 && !value.includes("\0");

const plexNativeRatingKeySchema = z.string().refine(isValidPlexNativeRatingKey);

const plexNativeOptionalStringSchema = z.preprocess(
	(value) => (typeof value === "string" && isValidPlexNativeRatingKey(value) ? value : null),
	z.string().nullable(),
);

const plexNativeTitleSchema = z.preprocess(
	(value) => (typeof value === "string" ? value : ""),
	z.string(),
);

const plexNativeEpisodeOptionalIntegerSchema = (minimum: number) =>
	z.preprocess((value) => {
		if (typeof value === "number" && Number.isSafeInteger(value) && value >= minimum) {
			return value;
		}
		if (typeof value === "string" && value.trim() !== "" && /^\d+$/.test(value.trim())) {
			const parsed = Number(value);
			if (Number.isSafeInteger(parsed) && parsed >= minimum) return parsed;
		}
		return null;
	}, z.number().int().min(minimum).nullable());

/** /library/sections/{id}/all?type=4 native episode inventory endpoint. */
export const plexNativeEpisodeItemsResponseSchema = z.looseObject({
	MediaContainer: z.looseObject({
		...plexPaginationFields,
		Metadata: z
			.array(
				z.looseObject({
					ratingKey: plexNativeRatingKeySchema,
					type: z.literal("episode"),
					title: plexNativeTitleSchema,
					grandparentRatingKey: plexNativeOptionalStringSchema,
					parentIndex: plexNativeEpisodeOptionalIntegerSchema(0),
					index: plexNativeEpisodeOptionalIntegerSchema(0),
				}),
			)
			.optional(),
	}),
});

/** /library/sections/{id}/all native movie/show/container inventory endpoint. */
export const plexNativeLibraryItemsResponseSchema = z.looseObject({
	MediaContainer: z.looseObject({
		...plexPaginationFields,
		Metadata: z
			.array(
				z.looseObject({
					ratingKey: plexNativeRatingKeySchema,
					type: z.union([z.literal("movie"), z.literal("show"), z.literal("collection")]),
					title: plexNativeTitleSchema,
					Guid: z.array(z.looseObject({ id: z.string() })).optional(),
				}),
			)
			.optional(),
	}),
});

/** /library/metadata/{ids} bounded tag enrichment response. */
export const plexMetadataTagsResponseSchema = z.looseObject({
	MediaContainer: z.looseObject({
		size: plexPaginationFields.size,
		Metadata: z
			.array(
				z.looseObject({
					ratingKey: z.string().min(1),
					Collection: z.array(z.looseObject({ tag: z.string() })).optional(),
					Label: z.array(z.looseObject({ tag: z.string() })).optional(),
				}),
			)
			.optional(),
	}),
});

const plexMediaPartSchema = z.looseObject({
	file: z.string().min(1),
	size: z.coerce.number().positive().refine(Number.isSafeInteger, "Expected a safe integer"),
});

const plexMediaSchema = z.looseObject({
	Part: z.array(plexMediaPartSchema).min(1),
});

/** /library/sections/{id}/all with includeMedia=1 */
export const plexLibraryMediaItemsResponseSchema = z.looseObject({
	MediaContainer: z.looseObject({
		...plexPaginationFields,
		Metadata: z
			.array(
				z.looseObject({
					ratingKey: z.string(),
					Guid: z.array(z.looseObject({ id: z.string() })).optional(),
					Media: z.array(plexMediaSchema).min(1),
				}),
			)
			.optional(),
	}),
});

/** Targeted /library/all show lookup used by deletion-safety checks. */
export const plexLibraryGuidItemsResponseSchema = z.looseObject({
	MediaContainer: z.looseObject({
		...plexPaginationFields,
		Metadata: z
			.array(
				z.looseObject({
					ratingKey: z.string(),
					type: z.string(),
					Guid: z.array(z.looseObject({ id: z.string() })).optional(),
				}),
			)
			.optional(),
	}),
});

const plexTargetMetadataBaseSchema = z.looseObject({
	ratingKey: z.string().trim().min(1),
	guid: z.string().trim().min(1),
	Guid: z.array(z.looseObject({ id: z.string().trim().min(1) })).min(1),
	librarySectionID: z.coerce.string().trim().min(1),
});

const plexTargetMetadataIdentitySchema = z.union([
	plexTargetMetadataBaseSchema.extend({
		type: z.union([z.literal("movie"), z.literal("show")]),
		parentRatingKey: z.string().trim().min(1).optional(),
		grandparentRatingKey: z.string().trim().min(1).optional(),
	}),
	plexTargetMetadataBaseSchema.extend({
		type: z.literal("episode"),
		parentRatingKey: z.string().trim().min(1),
		grandparentRatingKey: z.string().trim().min(1),
	}),
]);

/** Strict single-item metadata used to bind Tautulli history GUIDs. */
export const plexTargetMetadataResponseSchema = z.looseObject({
	MediaContainer: z.looseObject({
		Metadata: z.array(plexTargetMetadataIdentitySchema),
	}),
});

/** /library/metadata/{showId}/allLeaves with includeMedia=1 */
export const plexEpisodeMediaItemsResponseSchema = z.looseObject({
	MediaContainer: z.looseObject({
		...plexPaginationFields,
		Metadata: z
			.array(
				z.looseObject({
					ratingKey: z.string(),
					parentIndex: z.number().int().nonnegative().optional(),
					index: z.number().int().positive().optional(),
					Media: z.array(plexMediaSchema).min(1),
				}),
			)
			.optional(),
	}),
});

/** /status/sessions/history/all endpoint (paginated) */
export const plexHistoryResponseSchema = z.looseObject({
	MediaContainer: z.looseObject({
		...plexPaginationFields,
		Metadata: z
			.array(
				z.looseObject({
					historyKey: z.string().min(1).optional(),
					ratingKey: z.string().optional().default(""),
					parentRatingKey: z.string().optional(),
					parentKey: z.string().optional(),
					grandparentRatingKey: z.string().optional(),
					grandparentKey: z.string().optional(),
					title: z.string().optional().default(""),
					grandparentTitle: z.string().optional(),
					type: z.string(),
					viewedAt: z.number(),
					accountID: z.number(),
					librarySectionID: z.coerce.string().optional(),
				}),
			)
			.optional(),
	}),
});

/** /library/onDeck endpoint */
export const plexOnDeckResponseSchema = z.looseObject({
	MediaContainer: z.looseObject({
		...plexPaginationFields,
		Metadata: z
			.array(
				z.looseObject({
					ratingKey: z.string(),
					parentRatingKey: z.string().optional(),
					grandparentRatingKey: z.string().optional(),
					type: z.string(),
				}),
			)
			.optional(),
	}),
});

/** /status/sessions endpoint
 *
 * Plex JSON responses vary in field types across server versions — the XML
 * and JSON outputs have documented inconsistencies (see Plex forum thread
 * "Inconsistencies between the XML and JSON outputs of status/sessions").
 * Use z.coerce.string() / z.coerce.number() for defensive parsing of fields
 * that may arrive as either type. Player fields are optional with defaults
 * because some clients (PlexAmp, web player) don't report all device metadata.
 * Note: official API docs type User.id as string, but this codebase consumes
 * it as number (PlexSessionItem.user.id) — coerce handles both safely.
 */
export const plexSessionsResponseSchema = z.looseObject({
	MediaContainer: z.looseObject({
		size: z.number().optional(),
		Metadata: z
			.array(
				z.looseObject({
					sessionKey: z.coerce.string(),
					ratingKey: z.coerce.string(),
					title: z.string().optional().default(""),
					grandparentTitle: z.string().optional(),
					type: z.string().optional().default("unknown"),
					viewOffset: z.number().optional(),
					duration: z.number().optional(),
					thumb: z.string().optional(),
					User: z
						.looseObject({
							id: z.coerce.number(),
							title: z.string().optional().default(""),
							thumb: z.string().optional(),
						})
						.optional(),
					Player: z
						.looseObject({
							title: z.string().optional().default(""),
							platform: z.string().optional().default("unknown"),
							product: z.string().optional().default("unknown"),
							state: z.string().optional().default("unknown"),
						})
						.optional(),
					Session: z
						.looseObject({
							id: z.coerce.string(),
							bandwidth: z.number().optional(),
						})
						.optional(),
					TranscodeSession: z
						.looseObject({
							videoDecision: z.string().optional(),
							audioDecision: z.string().optional(),
						})
						.optional(),
				}),
			)
			.optional(),
	}),
});

/** /library/metadata/{id}/allLeaves endpoint */
export const plexEpisodesResponseSchema = z.looseObject({
	MediaContainer: z.looseObject({
		Metadata: z
			.array(
				z.looseObject({
					ratingKey: z.string(),
					title: z.string().optional().default(""),
					parentIndex: z.number().optional(),
					index: z.number().optional(),
					viewCount: z.number().optional(),
					lastViewedAt: z.number().optional(),
				}),
			)
			.optional(),
	}),
});

/** Paginated /library/metadata/{id}/allLeaves response used as cleanup authority. */
export const plexAllLeavesResponseSchema = z.looseObject({
	MediaContainer: z.looseObject({
		...plexPaginationFields,
		Metadata: z
			.array(
				z.looseObject({
					ratingKey: z.string(),
					title: z.string().optional().default(""),
					parentIndex: z.number().int().nonnegative().optional(),
					index: z.number().int().positive().optional(),
					viewCount: z.number().int().nonnegative().optional(),
					lastViewedAt: z.number().optional(),
				}),
			)
			.optional(),
	}),
});

/** /accounts endpoint */
export const plexAccountsResponseSchema = z.looseObject({
	MediaContainer: z.looseObject({
		offset: plexPaginationFields.offset.optional(),
		size: plexPaginationFields.size.optional(),
		totalSize: plexPaginationFields.totalSize.optional(),
		Account: z
			.array(
				z.looseObject({
					id: z.number(),
					name: z.string(),
				}),
			)
			.optional(),
	}),
});
