/**
 * Zod schemas for Plex Media Server API responses.
 *
 * These validate the raw MediaContainer-wrapped responses from the Plex API.
 * All schemas use z.looseObject() to tolerate extra fields across Plex versions.
 */

import { z } from "zod";

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
		Directory: z
			.array(
				z.looseObject({
					key: z.string(),
					title: z.string().optional().default(""),
					type: z.string(),
				}),
			)
			.optional(),
	}),
});

/** /library/sections/{id}/all endpoint */
export const plexLibraryItemsResponseSchema = z.looseObject({
	MediaContainer: z.looseObject({
		Metadata: z
			.array(
				z.looseObject({
					ratingKey: z.string(),
					title: z.string().optional().default(""),
					type: z.string(),
					year: z.number().optional(),
					userRating: z.number().optional(),
					addedAt: z.number().optional(),
					thumb: z.string().optional(),
					Guid: z.array(z.looseObject({ id: z.string() })).optional(),
					Collection: z.array(z.looseObject({ tag: z.string() })).optional(),
					Label: z.array(z.looseObject({ tag: z.string() })).optional(),
				}),
			)
			.optional(),
	}),
});

/** /status/sessions/history/all endpoint (paginated) */
export const plexHistoryResponseSchema = z.looseObject({
	MediaContainer: z.looseObject({
		size: z.number().optional(),
		Metadata: z
			.array(
				z.looseObject({
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
				}),
			)
			.optional(),
	}),
});

/** /library/onDeck endpoint */
export const plexOnDeckResponseSchema = z.looseObject({
	MediaContainer: z.looseObject({
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
 * Plex returns sessionKey/ratingKey as numbers in some server versions and
 * strings in others (JSON encoding inconsistency). Use z.coerce.string() to
 * handle both. Player fields are optional with defaults because some clients
 * (PlexAmp, web player) don't report all device metadata. Session.id is also
 * coerced since it can appear as a numeric ID.
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

/** /accounts endpoint */
export const plexAccountsResponseSchema = z.looseObject({
	MediaContainer: z.looseObject({
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
