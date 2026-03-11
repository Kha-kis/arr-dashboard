/**
 * Zod schemas for Tautulli API responses.
 *
 * These validate the inner `data` field of Tautulli's
 * `{ response: { result, message, data } }` wrapper.
 * All schemas use z.looseObject() to tolerate extra fields.
 */

import { z } from "zod";

/** Outer Tautulli response wrapper — validated first, then inner data with a separate schema */
export const tautulliResponseWrapperSchema = z.looseObject({
	response: z.looseObject({
		result: z.enum(["success", "error"]),
		message: z.string().nullable(),
		data: z.unknown(),
	}),
});

/** get_tautulli_info */
export const tautulliInfoSchema = z.looseObject({
	tautulli_version: z.string(),
});

/** get_libraries — array item */
export const tautulliLibrarySchema = z.looseObject({
	section_id: z.string(),
	section_name: z.string(),
	section_type: z.string(),
	count: z.string(),
});

/** get_history — inner data */
export const tautulliHistoryDataSchema = z.looseObject({
	data: z.array(
		z.looseObject({
			rating_key: z.string(),
			parent_rating_key: z.string(),
			grandparent_rating_key: z.string(),
			title: z.string(),
			grandparent_title: z.string(),
			media_type: z.string(),
			user: z.string(),
			date: z.number(),
			play_count: z.number().optional(),
		}),
	),
	recordsFiltered: z.number(),
	recordsTotal: z.number(),
});

/** get_activity — inner data */
export const tautulliActivityDataSchema = z.looseObject({
	sessions: z.array(
		z.looseObject({
			session_key: z.string(),
			rating_key: z.string(),
			title: z.string(),
			grandparent_title: z.string().optional(),
			media_type: z.string(),
			user: z.string(),
			friendly_name: z.string(),
			player: z.string(),
			platform: z.string(),
			product: z.string(),
			state: z.string(),
			progress_percent: z.string(),
			transcode_decision: z.string(),
			stream_video_decision: z.string(),
			stream_audio_decision: z.string(),
			video_resolution: z.string(),
			audio_codec: z.string(),
			video_codec: z.string(),
			bandwidth: z.string(),
			location: z.string(),
			thumb: z.string().optional(),
		}),
	),
	stream_count: z.string(),
	total_bandwidth: z.number(),
	lan_bandwidth: z.number(),
	wan_bandwidth: z.number(),
});

/** get_plays_by_date — inner data */
export const tautulliPlaysByDateDataSchema = z.looseObject({
	categories: z.array(z.string()),
	series: z.array(
		z.looseObject({
			name: z.string(),
			data: z.array(z.number()),
		}),
	),
});

/** get_home_stats — array item */
export const tautulliHomeStatSchema = z.looseObject({
	stat_id: z.string(),
	stat_title: z.string(),
	rows: z.array(
		z.looseObject({
			title: z.string(),
			friendly_name: z.string().optional(),
			total_plays: z.number(),
			total_duration: z.number(),
			platform: z.string().optional(),
			thumb: z.string().optional(),
		}),
	),
});

/** get_user_watch_time_stats — array item */
export const tautulliUserWatchTimeStatsSchema = z.looseObject({
	user_id: z.number(),
	friendly_name: z.string(),
	total_plays: z.number(),
	total_duration: z.number(),
});

/** get_metadata — inner data */
export const tautulliMetadataSchema = z.looseObject({
	guids: z.array(z.string()),
	media_type: z.string(),
	title: z.string(),
	rating_key: z.string(),
});
