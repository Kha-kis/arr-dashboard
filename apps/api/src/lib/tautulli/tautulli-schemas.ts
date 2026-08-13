import { z } from "zod";

export const tautulliResponseWrapperSchema = z.looseObject({
	response: z.looseObject({
		result: z.enum(["success", "error"]),
		message: z.string().nullable(),
		data: z.unknown(),
	}),
});

export const tautulliInfoSchema = z.looseObject({
	tautulli_version: z.string(),
});

export const tautulliLibrarySchema = z.looseObject({
	section_id: z.coerce.string(),
	section_name: z.string(),
	section_type: z.string(),
	count: z.coerce.string(),
});

const nonnegativeSafeIntegerFromStringOrNumber = z.preprocess((value) => {
	if (typeof value === "string" && value.trim() !== "") return Number(value);
	return value;
}, z.number().int().nonnegative().safe());

export const tautulliHistoryDataSchema = z.looseObject({
	data: z.array(
		z.looseObject({
			row_id: z.coerce.number().int().nonnegative().optional(),
			rating_key: z.coerce.string(),
			parent_rating_key: z.coerce.string(),
			grandparent_rating_key: z.coerce.string(),
			title: z.string(),
			grandparent_title: z.string(),
			media_type: z.string(),
			user: z.string(),
			date: z.coerce.number(),
			play_count: z.coerce.number().optional(),
			group_count: z.coerce.number().int().positive().optional(),
		}),
	),
	recordsFiltered: nonnegativeSafeIntegerFromStringOrNumber,
	recordsTotal: nonnegativeSafeIntegerFromStringOrNumber,
});

export const tautulliActivityDataSchema = z.looseObject({
	sessions: z.preprocess(
		(value) => value ?? [],
		z.array(
			z.looseObject({
				session_key: z.string(),
				rating_key: z.coerce.string(),
				title: z.string(),
				grandparent_title: z.string().optional(),
				media_type: z.string(),
				user: z.string(),
				friendly_name: z.string(),
				player: z.string(),
				platform: z.string(),
				product: z.string(),
				state: z.string(),
				progress_percent: z.coerce.string(),
				transcode_decision: z.string(),
				stream_video_decision: z.string(),
				stream_audio_decision: z.string(),
				video_resolution: z.string(),
				audio_codec: z.string(),
				video_codec: z.string(),
				bandwidth: z.coerce.string(),
				location: z.string(),
				thumb: z.string().optional(),
			}),
		),
	),
	stream_count: z.preprocess((value) => value ?? "0", z.coerce.string()),
	total_bandwidth: z.preprocess((value) => value ?? 0, z.coerce.number()),
	lan_bandwidth: z.preprocess((value) => value ?? 0, z.coerce.number()),
	wan_bandwidth: z.preprocess((value) => value ?? 0, z.coerce.number()),
});

export const tautulliPlaysByDateDataSchema = z.looseObject({
	categories: z.array(z.string()),
	series: z.array(z.looseObject({ name: z.string(), data: z.array(z.coerce.number()) })),
});

export const tautulliHomeStatSchema = z.looseObject({
	stat_id: z.string(),
	stat_title: z.string(),
	rows: z.array(
		z.looseObject({
			title: z.string(),
			friendly_name: z.string().optional(),
			total_plays: z.coerce.number().optional().default(0),
			total_duration: z.coerce.number().optional().default(0),
			platform: z.string().optional(),
			thumb: z.string().optional(),
		}),
	),
});

export const tautulliUserWatchTimeStatsSchema = z.looseObject({
	query_days: z.coerce.number().int().nonnegative(),
	total_plays: z.coerce.number().int().nonnegative(),
	total_time: z.coerce.number().int().nonnegative(),
});

export const tautulliMetadataSchema = z.looseObject({
	guids: z.preprocess((value) => value ?? [], z.array(z.string())),
	media_type: z.preprocess((value) => value ?? "unknown", z.string()),
	title: z.preprocess((value) => value ?? "", z.string()),
	rating_key: z.preprocess(
		(value) => (value === null || value === undefined ? undefined : String(value)),
		z.string().optional(),
	),
});
