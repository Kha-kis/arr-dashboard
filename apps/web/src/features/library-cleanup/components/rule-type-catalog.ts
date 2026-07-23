import type { CleanupRuleType } from "@arr/shared";
import type { LucideIcon } from "lucide-react";
import {
	Brain,
	Film,
	HardDrive,
	ListChecks,
	MessageSquare,
	Sparkles,
	Target,
	Tv,
} from "lucide-react";

// ============================================================================
// Constants
// ============================================================================

export const RULE_TYPES: Array<{ value: CleanupRuleType; label: string; desc: string }> = [
	{ value: "age", label: "Age", desc: "Flag items by age (older/newer than N days)" },
	{ value: "size", label: "Size", desc: "Flag items based on disk size" },
	{
		value: "rating",
		label: "Rating",
		desc: "Flag items by the available Radarr or Sonarr rating",
	},
	{ value: "status", label: "Status", desc: "Flag items with specific statuses" },
	{ value: "unmonitored", label: "Unmonitored", desc: "Flag unmonitored items" },
	{ value: "genre", label: "Genre", desc: "Flag items by genre" },
	{ value: "year_range", label: "Year Range", desc: "Flag items by release year" },
	{ value: "no_file", label: "No File", desc: "Flag items without files on disk" },
	{ value: "quality_profile", label: "Quality Profile", desc: "Flag items by quality profile" },
	{ value: "language", label: "Language", desc: "Flag items by language" },
	// File metadata rules
	{
		value: "video_codec",
		label: "Video Codec",
		desc: "Flag items by video codec (x264, x265, AV1)",
	},
	{
		value: "audio_codec",
		label: "Audio Codec",
		desc: "Flag items by audio codec (AAC, DTS, TrueHD)",
	},
	{
		value: "resolution",
		label: "Resolution",
		desc: "Flag items by resolution (720p, 1080p, 2160p)",
	},
	{ value: "hdr_type", label: "HDR Type", desc: "Flag items by dynamic range (HDR, DV, none)" },
	{
		value: "custom_format_score",
		label: "CF Score",
		desc: "Flag items by custom format score",
	},
	{ value: "runtime", label: "Runtime", desc: "Flag items by runtime in minutes" },
	{ value: "release_group", label: "Release Group", desc: "Flag items by release group" },
	// Seerr rules
	{
		value: "seerr_requested_by",
		label: "Seerr: Requested By",
		desc: "Flag items requested by specific users",
	},
	{
		value: "seerr_request_age",
		label: "Seerr: Request Age",
		desc: "Flag items by Seerr request age",
	},
	{
		value: "seerr_request_status",
		label: "Seerr: Request Status",
		desc: "Flag items by Seerr request status",
	},
	{ value: "seerr_is_4k", label: "Seerr: Is 4K", desc: "Flag items by 4K request status" },
	{
		value: "seerr_request_modified_age",
		label: "Seerr: Modified Age",
		desc: "Flag items by Seerr request last-modified age",
	},
	{
		value: "seerr_modified_by",
		label: "Seerr: Modified By",
		desc: "Flag items by who last modified the request",
	},
	// New Phase C rules
	{
		value: "imdb_rating",
		label: "IMDb Rating",
		desc: "Flag items by IMDb rating score",
	},
	{
		value: "file_path",
		label: "File Path",
		desc: "Flag items by file path regex pattern",
	},
	{
		value: "seerr_is_requested",
		label: "Seerr: Is Requested",
		desc: "Flag items with or without Seerr requests",
	},
	{
		value: "seerr_request_count",
		label: "Seerr: Request Count",
		desc: "Flag items by number of Seerr requests",
	},
	{
		value: "audio_channels",
		label: "Audio Channels",
		desc: "Flag items by audio channel count (2, 6, 8)",
	},
	{
		value: "tag_match",
		label: "Tag Match",
		desc: "Flag items that have specific ARR tags",
	},
	// Plex integration rules
	{
		value: "plex_last_watched",
		label: "Plex: Last Watched",
		desc: "Flag items by when last watched in Plex",
	},
	{
		value: "plex_watch_count",
		label: "Plex: Watch Count",
		desc: "Flag items by Plex play count",
	},
	{
		value: "plex_on_deck",
		label: "Plex: On Deck",
		desc: "Flag items on Plex Continue Watching",
	},
	{
		value: "plex_user_rating",
		label: "Plex: User Rating",
		desc: "Flag items by user star rating in Plex",
	},
	{
		value: "plex_watched_by",
		label: "Plex: Watched By",
		desc: "Flag items by which Plex users watched",
	},
	{
		value: "plex_collection",
		label: "Plex: Collection",
		desc: "Flag items in specific Plex collections",
	},
	{
		value: "plex_label",
		label: "Plex: Label",
		desc: "Flag items with specific Plex labels",
	},
	{
		value: "plex_added_at",
		label: "Plex: Added At",
		desc: "Flag items by when added to Plex",
	},
	// Jellyfin integration rules
	{
		value: "jellyfin_last_watched",
		label: "Jellyfin Last Watched",
		desc: "Days since last watched on Jellyfin",
	},
	{
		value: "jellyfin_watch_count",
		label: "Jellyfin Watch Count",
		desc: "Number of times played on Jellyfin",
	},
	{
		value: "jellyfin_on_deck",
		label: "Jellyfin Continue Watching",
		desc: "Whether the item is on Jellyfin's Continue Watching",
	},
	{
		value: "jellyfin_user_rating",
		label: "Jellyfin User Rating",
		desc: "User rating on Jellyfin (favorites = 10)",
	},
	{
		value: "jellyfin_watched_by",
		label: "Jellyfin Watched By",
		desc: "Which Jellyfin users have watched an item",
	},
	{
		value: "jellyfin_added_at",
		label: "Jellyfin Added At",
		desc: "When the item was added to Jellyfin",
	},
	// Behavior-aware rules (Phase 2)
	{
		value: "plex_episode_completion",
		label: "Episode Completion",
		desc: "Flag series by % of episodes watched in Plex",
	},
	{
		value: "jellyfin_episode_completion",
		label: "Jellyfin Episode Completion",
		desc: "Watched percentage of episodes on Jellyfin",
	},
	{
		value: "user_retention",
		label: "User Retention",
		desc: "Flag items by which users have watched (none/all/count)",
	},
	{
		value: "staleness_score",
		label: "Staleness Score",
		desc: "Weighted score combining watch activity, ratings, and size",
	},
	// Phase 3
	{
		value: "recently_active",
		label: "Recently Active",
		desc: "Protect items with recent activity (best used as retention rule)",
	},
	// Phase 4: Requester-aware cross-service
	{
		value: "seerr_requester_watched",
		label: "Requester Watched",
		desc: "Matches when the Seerr requester has watched the item (Plex, Emby, or Jellyfin)",
	},
	{
		value: "seerr_requester_not_watched",
		label: "Requester Not Watched",
		desc: "Matches when the Seerr requester has not watched the item (Plex, Emby, or Jellyfin)",
	},
	// List membership (auto-tagger sub-arc 4 closeout — C3)
	{
		value: "tmdb_list_member",
		label: "TMDb List Member",
		desc: "Flag items by membership in a TMDb list",
	},
	{
		value: "trakt_list_member",
		label: "Trakt List Member",
		desc: "Flag items by membership in a Trakt list",
	},
];

export const RULE_CATEGORIES: Array<{
	id: string;
	label: string;
	icon: LucideIcon;
	types: CleanupRuleType[];
	requires?: "plex" | "plex+seerr" | "jellyfin";
}> = [
	{
		id: "content",
		label: "Content Attributes",
		icon: Film,
		types: [
			"age",
			"rating",
			"imdb_rating",
			"status",
			"unmonitored",
			"genre",
			"year_range",
			"language",
			"no_file",
			"tag_match",
		],
	},
	{
		id: "quality",
		label: "Quality & Format",
		icon: Sparkles,
		types: ["quality_profile", "custom_format_score"],
	},
	{
		id: "file",
		label: "File Properties",
		icon: HardDrive,
		types: [
			"size",
			"video_codec",
			"audio_codec",
			"audio_channels",
			"resolution",
			"hdr_type",
			"runtime",
			"release_group",
			"file_path",
		],
	},
	{
		id: "seerr",
		label: "Seerr Integration",
		icon: MessageSquare,
		types: [
			"seerr_requested_by",
			"seerr_request_age",
			"seerr_request_status",
			"seerr_is_4k",
			"seerr_request_modified_age",
			"seerr_modified_by",
			"seerr_is_requested",
			"seerr_request_count",
		],
	},
	{
		id: "plex",
		label: "Plex Integration",
		icon: Tv,
		types: [
			"plex_last_watched",
			"plex_watch_count",
			"plex_on_deck",
			"plex_user_rating",
			"plex_watched_by",
			"plex_collection",
			"plex_label",
			"plex_added_at",
		],
		requires: "plex" as const,
	},
	{
		id: "lists",
		label: "List Membership",
		icon: ListChecks,
		types: ["tmdb_list_member", "trakt_list_member"],
	},
	{
		id: "jellyfin",
		label: "Jellyfin Integration",
		icon: Tv,
		types: [
			"jellyfin_last_watched",
			"jellyfin_watch_count",
			"jellyfin_on_deck",
			"jellyfin_user_rating",
			"jellyfin_watched_by",
			"jellyfin_added_at",
			"jellyfin_episode_completion",
		],
		requires: "jellyfin" as const,
	},
	{
		id: "behavior",
		label: "Behavior Analysis",
		icon: Brain,
		types: ["plex_episode_completion", "user_retention", "staleness_score", "recently_active"],
		requires: "plex" as const,
	},
	{
		id: "cross-service",
		label: "Cross-Service",
		icon: Target,
		types: ["seerr_requester_watched", "seerr_requester_not_watched"],
		requires: "plex+seerr" as const,
	},
];

export const RULE_TYPE_MAP = new Map(RULE_TYPES.map((t) => [t.value, t]));
