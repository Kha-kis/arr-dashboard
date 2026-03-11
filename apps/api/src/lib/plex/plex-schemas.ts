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
					title: z.string(),
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
					title: z.string(),
					type: z.string(),
					year: z.number().optional(),
					userRating: z.number().optional(),
					addedAt: z.number().optional(),
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
					ratingKey: z.string(),
					parentRatingKey: z.string().optional(),
					parentKey: z.string().optional(),
					grandparentRatingKey: z.string().optional(),
					grandparentKey: z.string().optional(),
					title: z.string(),
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

/** /status/sessions endpoint */
export const plexSessionsResponseSchema = z.looseObject({
	MediaContainer: z.looseObject({
		size: z.number().optional(),
		Metadata: z
			.array(
				z.looseObject({
					sessionKey: z.string(),
					ratingKey: z.string(),
					title: z.string(),
					grandparentTitle: z.string().optional(),
					type: z.string(),
					viewOffset: z.number().optional(),
					duration: z.number().optional(),
					thumb: z.string().optional(),
					User: z
						.looseObject({
							id: z.number(),
							title: z.string(),
							thumb: z.string().optional(),
						})
						.optional(),
					Player: z
						.looseObject({
							title: z.string(),
							platform: z.string(),
							product: z.string(),
							state: z.string(),
						})
						.optional(),
					Session: z
						.looseObject({
							id: z.string(),
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
					title: z.string(),
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
