"use client";

import type {
	CleanupFieldOptionsResponse,
	CleanupRuleResponse,
	CleanupRuleType,
	CreateCleanupRule,
} from "@arr/shared";
import {
	BarChart3,
	Brain,
	ChevronDown,
	Film,
	HardDrive,
	Loader2,
	MessageSquare,
	Save,
	ShieldOff,
	SlidersHorizontal,
	Sparkles,
	Target,
	Tv,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { Switch } from "@/components/ui/switch";
import { useCleanupFieldOptions } from "@/hooks/api/useLibraryCleanup";
import { useServicesQuery } from "@/hooks/api/useServicesQuery";
import { useThemeGradient } from "@/hooks/useThemeGradient";
import { getServiceGradient } from "@/lib/theme-gradients";
import { getInputStyles } from "@/lib/theme-input-styles";
import { ConditionParamsFields, getDefaultConditionParams } from "./condition-params-fields";
import { MultiSelectField } from "./multi-select-field";

// ============================================================================
// Constants
// ============================================================================

const RULE_TYPES: Array<{ value: CleanupRuleType; label: string; desc: string }> = [
	{ value: "age", label: "Age", desc: "Flag items by age (older/newer than N days)" },
	{ value: "size", label: "Size", desc: "Flag items based on disk size" },
	{ value: "rating", label: "Rating", desc: "Flag items by TMDB rating" },
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
	// Tautulli rules
	{
		value: "tautulli_last_watched",
		label: "Tautulli: Last Watched",
		desc: "Flag items by when last watched",
	},
	{
		value: "tautulli_watch_count",
		label: "Tautulli: Watch Count",
		desc: "Flag items by total play count",
	},
	{
		value: "tautulli_watched_by",
		label: "Tautulli: Watched By",
		desc: "Flag items by which users watched",
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
	// Behavior-aware rules (Phase 2)
	{
		value: "plex_episode_completion",
		label: "Episode Completion",
		desc: "Flag series by % of episodes watched in Plex",
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
];

const RULE_CATEGORIES: Array<{
	id: string;
	label: string;
	icon: LucideIcon;
	types: CleanupRuleType[];
	requires?: "plex" | "tautulli";
}> = [
	{
		id: "content",
		label: "Content Attributes",
		icon: Film,
		types: ["age", "rating", "imdb_rating", "status", "unmonitored", "genre", "year_range", "language", "no_file", "tag_match"],
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
		id: "tautulli",
		label: "Tautulli Integration",
		icon: BarChart3,
		types: ["tautulli_last_watched", "tautulli_watch_count", "tautulli_watched_by"],
		requires: "tautulli" as const,
	},
	{
		id: "plex",
		label: "Plex Integration",
		icon: Tv,
		types: ["plex_last_watched", "plex_watch_count", "plex_on_deck", "plex_user_rating", "plex_watched_by", "plex_collection", "plex_label", "plex_added_at"],
		requires: "plex" as const,
	},
	{
		id: "behavior",
		label: "Behavior Analysis",
		icon: Brain,
		types: ["plex_episode_completion", "user_retention", "staleness_score", "recently_active"],
		requires: "plex" as const,
	},
];

const RULE_TYPE_MAP = new Map(RULE_TYPES.map((t) => [t.value, t]));

// ============================================================================
// Types
// ============================================================================

interface CleanupRuleDialogProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	/** When set, dialog is in edit mode pre-populated with this rule */
	editRule?: CleanupRuleResponse | null;
	onSave: (data: CreateCleanupRule) => void;
	isSaving: boolean;
}

// ============================================================================
// Component
// ============================================================================

export function CleanupRuleDialog({
	open,
	onOpenChange,
	editRule,
	onSave,
	isSaving,
}: CleanupRuleDialogProps) {
	const { gradient } = useThemeGradient();
	const isEdit = !!editRule;
	const { data: fieldOptions, isLoading: fieldOptionsLoading } = useCleanupFieldOptions();
	const { data: allServices } = useServicesQuery();
	const arrInstances = useMemo(
		() => (allServices ?? []).filter((s) => s.service === "sonarr" || s.service === "radarr"),
		[allServices],
	);

	// ── Basic fields ────────────────────────────────────────────────
	const [name, setName] = useState("");
	const [ruleType, setRuleType] = useState<CleanupRuleType>("age");
	const [enabled, setEnabled] = useState(true);
	const [expandedCategories, setExpandedCategories] = useState<Set<string>>(new Set(["content"]));

	// ── Params (varies by ruleType) ─────────────────────────────────
	const [days, setDays] = useState(180);
	const [ageOp, setAgeOp] = useState("older_than");
	const [sizeGb, setSizeGb] = useState(50);
	const [sizeOp, setSizeOp] = useState("greater_than");
	const [score, setScore] = useState(5);
	const [scoreOp, setScoreOp] = useState("less_than");
	const [statuses, setStatuses] = useState("ended,deleted");
	const [genreOp, setGenreOp] = useState("includes_any");
	const [genres, setGenres] = useState("");
	const [yearOp, setYearOp] = useState("before");
	const [year, setYear] = useState(2000);
	const [yearFrom, setYearFrom] = useState(1990);
	const [yearTo, setYearTo] = useState(2010);
	const [profileNames, setProfileNames] = useState("");
	const [langOp, setLangOp] = useState("includes_any");
	const [languages, setLanguages] = useState("");
	const [seerrUserNames, setSeerrUserNames] = useState("");
	const [seerrReqAgeOp, setSeerrReqAgeOp] = useState("older_than");
	const [seerrReqAgeDays, setSeerrReqAgeDays] = useState(90);
	const [seerrReqStatuses, setSeerrReqStatuses] = useState("pending,declined");

	// ── File metadata params (multi-select arrays) ──────────────────
	const [videoCodecOp, setVideoCodecOp] = useState("is");
	const [audioCodecOp, setAudioCodecOp] = useState("is");
	const [selectedVideoCodecs, setSelectedVideoCodecs] = useState<string[]>([]);
	const [selectedAudioCodecs, setSelectedAudioCodecs] = useState<string[]>([]);
	const [resolutionOp, setResolutionOp] = useState("is");
	const [selectedResolutions, setSelectedResolutions] = useState<string[]>([]);
	const [hdrOp, setHdrOp] = useState("is");
	const [selectedHdrTypes, setSelectedHdrTypes] = useState<string[]>([]);
	const [cfScoreOp, setCfScoreOp] = useState("less_than");
	const [cfScore, setCfScore] = useState(0);
	const [runtimeOp, setRuntimeOp] = useState("greater_than");
	const [runtimeMinutes, setRuntimeMinutes] = useState(180);
	const [releaseGroupOp, setReleaseGroupOp] = useState("is");
	const [selectedReleaseGroups, setSelectedReleaseGroups] = useState<string[]>([]);

	// ── Enhanced Seerr params ────────────────────────────────────────
	const [seerrIs4k, setSeerrIs4k] = useState(true);
	const [seerrModifiedAgeOp, setSeerrModifiedAgeOp] = useState("older_than");
	const [seerrModifiedAgeDays, setSeerrModifiedAgeDays] = useState(90);
	const [seerrModifiedByUsers, setSeerrModifiedByUsers] = useState("");

	// ── Tautulli params ──────────────────────────────────────────────
	const [tautulliLastWatchedOp, setTautulliLastWatchedOp] = useState("older_than");
	const [tautulliLastWatchedDays, setTautulliLastWatchedDays] = useState(90);
	const [tautulliWatchCountOp, setTautulliWatchCountOp] = useState("less_than");
	const [tautulliWatchCount, setTautulliWatchCount] = useState(1);
	const [tautulliWatchedByOp, setTautulliWatchedByOp] = useState("includes_any");
	const [selectedTautulliUsers, setSelectedTautulliUsers] = useState<string[]>([]);

	// ── Plex params ─────────────────────────────────────────────────
	const [plexLastWatchedOp, setPlexLastWatchedOp] = useState("older_than");
	const [plexLastWatchedDays, setPlexLastWatchedDays] = useState(90);
	const [plexWatchCountOp, setPlexWatchCountOp] = useState("less_than");
	const [plexWatchCountVal, setPlexWatchCountVal] = useState(1);
	const [plexOnDeckVal, setPlexOnDeckVal] = useState(false);
	const [plexUserRatingOp, setPlexUserRatingOp] = useState("less_than");
	const [plexUserRatingVal, setPlexUserRatingVal] = useState(5);
	const [plexWatchedByOp, setPlexWatchedByOp] = useState("includes_any");
	const [selectedPlexUsers, setSelectedPlexUsers] = useState<string[]>([]);

	// ── Action (Phase A) ────────────────────────────────────────────
	const [action, setAction] = useState<"delete" | "unmonitor" | "delete_files">("delete");

	// ── Composite mode (Phase B) ────────────────────────────────────
	const [isComposite, setIsComposite] = useState(false);
	const [compositeOperator, setCompositeOperator] = useState<"AND" | "OR">("AND");
	const [conditions, setConditions] = useState<
		Array<{ id: string; ruleType: CleanupRuleType; params: Record<string, unknown> }>
	>([]);

	// ── New rule params (Phase C) ───────────────────────────────────
	const [imdbRatingOp, setImdbRatingOp] = useState("less_than");
	const [imdbRatingScore, setImdbRatingScore] = useState(5);
	const [filePathOp, setFilePathOp] = useState("matches");
	const [filePathPattern, setFilePathPattern] = useState("");
	const [filePathField, setFilePathField] = useState("path");
	const [seerrIsRequested, setSeerrIsRequested] = useState(true);
	const [seerrRequestCountOp, setSeerrRequestCountOp] = useState("less_than");
	const [seerrRequestCountVal, setSeerrRequestCountVal] = useState(1);
	const [audioChannelsOp, setAudioChannelsOp] = useState("less_than");
	const [audioChannelsVal, setAudioChannelsVal] = useState(6);
	const [tagMatchOp, setTagMatchOp] = useState("includes_any");
	const [selectedTagIds, setSelectedTagIds] = useState<number[]>([]);

	// ── Plex collections & labels (Phase D) ─────────────────────────
	const [plexCollectionOp, setPlexCollectionOp] = useState("in");
	const [selectedPlexCollections, setSelectedPlexCollections] = useState<string[]>([]);
	const [plexLabelOp, setPlexLabelOp] = useState("has_any");
	const [selectedPlexLabels, setSelectedPlexLabels] = useState<string[]>([]);
	const [plexAddedAtOp, setPlexAddedAtOp] = useState("older_than");
	const [plexAddedAtDays, setPlexAddedAtDays] = useState(90);

	// ── Phase 2/3 behavior params (shared object pattern) ─────────
	const [behaviorParams, setBehaviorParams] = useState<Record<string, unknown>>({});

	// ── Retention mode ─────────────────────────────────────────────
	const [retentionMode, setRetentionMode] = useState(false);

	// ── Composite validation ────────────────────────────────────────
	const [compositeError, setCompositeError] = useState<string | null>(null);

	// ── Scope / Exclusions ──────────────────────────────────────────
	const [serviceFilter, setServiceFilter] = useState<string[]>([]);
	const [instanceFilter, setInstanceFilter] = useState<string[]>([]);
	const [selectedPlexLibraries, setSelectedPlexLibraries] = useState<string[]>([]);
	const [excludeTags, setExcludeTags] = useState<number[]>([]);
	const [excludeTitles, setExcludeTitles] = useState("");

	// ── Pre-populate on edit ────────────────────────────────────────
	useEffect(() => {
		if (!open) return;
		if (editRule) {
			setName(editRule.name);
			setRuleType(editRule.ruleType);
			setEnabled(editRule.enabled);
			setAction((editRule.action as "delete" | "unmonitor" | "delete_files") ?? "delete");
			setRetentionMode(editRule.retentionMode ?? false);
			// Composite mode
			if (editRule.operator && editRule.conditions) {
				setIsComposite(true);
				setCompositeOperator(editRule.operator as "AND" | "OR");
				setConditions(
					(editRule.conditions as Array<{ ruleType: CleanupRuleType; parameters: Record<string, unknown> }>).map(
						(c, i) => ({ id: `cond-${i}`, ruleType: c.ruleType, params: c.parameters ?? {} }),
					),
				);
			} else {
				setIsComposite(false);
				setCompositeOperator("AND");
				setConditions([]);
			}
			const activeCat = RULE_CATEGORIES.find((c) => c.types.includes(editRule.ruleType));
			setExpandedCategories(new Set([activeCat?.id ?? "content"]));

			const p = editRule.parameters as Record<string, unknown>;
			switch (editRule.ruleType) {
				case "age":
					setAgeOp((p.operator as string) ?? "older_than");
					setDays((p.days as number) ?? 180);
					break;
				case "size":
					setSizeOp((p.operator as string) ?? "greater_than");
					setSizeGb((p.sizeGb as number) ?? 50);
					break;
				case "rating":
					setScoreOp((p.operator as string) ?? "less_than");
					setScore((p.score as number) ?? 5);
					break;
				case "status":
					setStatuses(
						Array.isArray(p.statuses) ? (p.statuses as string[]).join(", ") : "ended,deleted",
					);
					break;
				case "genre":
					setGenreOp((p.operator as string) ?? "includes_any");
					setGenres(Array.isArray(p.genres) ? (p.genres as string[]).join(", ") : "");
					break;
				case "year_range":
					setYearOp((p.operator as string) ?? "before");
					setYear((p.year as number) ?? 2000);
					setYearFrom((p.yearFrom as number) ?? 1990);
					setYearTo((p.yearTo as number) ?? 2010);
					break;
				case "quality_profile":
					setProfileNames(
						Array.isArray(p.profileNames) ? (p.profileNames as string[]).join(", ") : "",
					);
					break;
				case "language":
					setLangOp((p.operator as string) ?? "includes_any");
					setLanguages(Array.isArray(p.languages) ? (p.languages as string[]).join(", ") : "");
					break;
				case "seerr_requested_by":
					setSeerrUserNames(Array.isArray(p.userNames) ? (p.userNames as string[]).join(", ") : "");
					break;
				case "seerr_request_age":
					setSeerrReqAgeOp((p.operator as string) ?? "older_than");
					setSeerrReqAgeDays((p.days as number) ?? 90);
					break;
				case "seerr_request_status":
					setSeerrReqStatuses(
						Array.isArray(p.statuses) ? (p.statuses as string[]).join(", ") : "pending,declined",
					);
					break;
				// File metadata rules — arrays directly
				case "video_codec":
					setVideoCodecOp((p.operator as string) ?? "is");
					setSelectedVideoCodecs(Array.isArray(p.codecs) ? (p.codecs as string[]) : []);
					break;
				case "audio_codec":
					setAudioCodecOp((p.operator as string) ?? "is");
					setSelectedAudioCodecs(Array.isArray(p.codecs) ? (p.codecs as string[]) : []);
					break;
				case "resolution":
					setResolutionOp((p.operator as string) ?? "is");
					setSelectedResolutions(Array.isArray(p.resolutions) ? (p.resolutions as string[]) : []);
					break;
				case "hdr_type":
					setHdrOp((p.operator as string) ?? "is");
					setSelectedHdrTypes(Array.isArray(p.types) ? (p.types as string[]) : []);
					break;
				case "custom_format_score":
					setCfScoreOp((p.operator as string) ?? "less_than");
					setCfScore((p.score as number) ?? 0);
					break;
				case "runtime":
					setRuntimeOp((p.operator as string) ?? "greater_than");
					setRuntimeMinutes((p.minutes as number) ?? 180);
					break;
				case "release_group":
					setReleaseGroupOp((p.operator as string) ?? "is");
					setSelectedReleaseGroups(Array.isArray(p.groups) ? (p.groups as string[]) : []);
					break;
				// Enhanced Seerr rules
				case "seerr_is_4k":
					setSeerrIs4k((p.is4k as boolean) ?? true);
					break;
				case "seerr_request_modified_age":
					setSeerrModifiedAgeOp((p.operator as string) ?? "older_than");
					setSeerrModifiedAgeDays((p.days as number) ?? 90);
					break;
				case "seerr_modified_by":
					setSeerrModifiedByUsers(
						Array.isArray(p.userNames) ? (p.userNames as string[]).join(", ") : "",
					);
					break;
				// Tautulli rules
				case "tautulli_last_watched":
					setTautulliLastWatchedOp((p.operator as string) ?? "older_than");
					setTautulliLastWatchedDays((p.days as number) ?? 90);
					break;
				case "tautulli_watch_count":
					setTautulliWatchCountOp((p.operator as string) ?? "less_than");
					setTautulliWatchCount((p.count as number) ?? 1);
					break;
				case "tautulli_watched_by":
					setTautulliWatchedByOp((p.operator as string) ?? "includes_any");
					setSelectedTautulliUsers(Array.isArray(p.userNames) ? (p.userNames as string[]) : []);
					break;
				// Plex rules
				case "plex_last_watched":
					setPlexLastWatchedOp((p.operator as string) ?? "older_than");
					setPlexLastWatchedDays((p.days as number) ?? 90);
					break;
				case "plex_watch_count":
					setPlexWatchCountOp((p.operator as string) ?? "less_than");
					setPlexWatchCountVal((p.count as number) ?? 1);
					break;
				case "plex_on_deck":
					setPlexOnDeckVal((p.isDeck as boolean) ?? false);
					break;
				case "plex_user_rating":
					setPlexUserRatingOp((p.operator as string) ?? "less_than");
					setPlexUserRatingVal((p.rating as number) ?? 5);
					break;
				case "plex_watched_by":
					setPlexWatchedByOp((p.operator as string) ?? "includes_any");
					setSelectedPlexUsers(Array.isArray(p.userNames) ? (p.userNames as string[]) : []);
					break;
				// Phase C: new rule types
				case "imdb_rating":
					setImdbRatingOp((p.operator as string) ?? "less_than");
					setImdbRatingScore((p.score as number) ?? 5);
					break;
				case "file_path":
					setFilePathOp((p.operator as string) ?? "matches");
					setFilePathPattern((p.pattern as string) ?? "");
					setFilePathField((p.field as string) ?? "path");
					break;
				case "seerr_is_requested":
					setSeerrIsRequested((p.isRequested as boolean) ?? true);
					break;
				case "seerr_request_count":
					setSeerrRequestCountOp((p.operator as string) ?? "less_than");
					setSeerrRequestCountVal((p.count as number) ?? 1);
					break;
				case "audio_channels":
					setAudioChannelsOp((p.operator as string) ?? "less_than");
					setAudioChannelsVal((p.channels as number) ?? 6);
					break;
				case "tag_match":
					setTagMatchOp((p.operator as string) ?? "includes_any");
					setSelectedTagIds(Array.isArray(p.tagIds) ? (p.tagIds as number[]) : []);
					break;
				// Phase D: Plex collections & labels
				case "plex_collection":
					setPlexCollectionOp((p.operator as string) ?? "in");
					setSelectedPlexCollections(Array.isArray(p.collections) ? (p.collections as string[]) : []);
					break;
				case "plex_label":
					setPlexLabelOp((p.operator as string) ?? "has_any");
					setSelectedPlexLabels(Array.isArray(p.labels) ? (p.labels as string[]) : []);
					break;
				case "plex_added_at":
					setPlexAddedAtOp((p.operator as string) ?? "older_than");
					setPlexAddedAtDays((p.days as number) ?? 90);
					break;
				// Phase 2/3: Behavior analysis (delegate to behaviorParams)
				case "plex_episode_completion":
				case "user_retention":
				case "staleness_score":
				case "recently_active":
					setBehaviorParams(p);
					break;
			}

			setServiceFilter(editRule.serviceFilter ?? []);
			setInstanceFilter(editRule.instanceFilter ?? []);
			setSelectedPlexLibraries(editRule.plexLibraryFilter ?? []);
			setExcludeTags(editRule.excludeTags ?? []);
			setExcludeTitles(editRule.excludeTitles ? editRule.excludeTitles.join(", ") : "");
		} else {
			// Reset to defaults for create mode
			setName("");
			setRuleType("age");
			setEnabled(true);
			setExpandedCategories(new Set(["content"]));
			setDays(180);
			setAgeOp("older_than");
			setSizeGb(50);
			setSizeOp("greater_than");
			setScore(5);
			setScoreOp("less_than");
			setStatuses("ended,deleted");
			setGenreOp("includes_any");
			setGenres("");
			setYearOp("before");
			setYear(2000);
			setYearFrom(1990);
			setYearTo(2010);
			setProfileNames("");
			setLangOp("includes_any");
			setLanguages("");
			setSeerrUserNames("");
			setSeerrReqAgeOp("older_than");
			setSeerrReqAgeDays(90);
			setSeerrReqStatuses("pending,declined");
			// File metadata defaults
			setVideoCodecOp("is");
			setAudioCodecOp("is");
			setSelectedVideoCodecs([]);
			setSelectedAudioCodecs([]);
			setResolutionOp("is");
			setSelectedResolutions([]);
			setHdrOp("is");
			setSelectedHdrTypes([]);
			setCfScoreOp("less_than");
			setCfScore(0);
			setRuntimeOp("greater_than");
			setRuntimeMinutes(180);
			setReleaseGroupOp("is");
			setSelectedReleaseGroups([]);
			// Enhanced Seerr defaults
			setSeerrIs4k(true);
			setSeerrModifiedAgeOp("older_than");
			setSeerrModifiedAgeDays(90);
			setSeerrModifiedByUsers("");
			// Tautulli defaults
			setTautulliLastWatchedOp("older_than");
			setTautulliLastWatchedDays(90);
			setTautulliWatchCountOp("less_than");
			setTautulliWatchCount(1);
			setTautulliWatchedByOp("includes_any");
			setSelectedTautulliUsers([]);
			// Plex defaults
			setPlexLastWatchedOp("older_than");
			setPlexLastWatchedDays(90);
			setPlexWatchCountOp("less_than");
			setPlexWatchCountVal(1);
			setPlexOnDeckVal(false);
			setPlexUserRatingOp("less_than");
			setPlexUserRatingVal(5);
			setPlexWatchedByOp("includes_any");
			setSelectedPlexUsers([]);
			// Phase A/B
			setAction("delete");
			setRetentionMode(false);
			setIsComposite(false);
			setCompositeOperator("AND");
			setConditions([]);
			// Phase C
			setImdbRatingOp("less_than");
			setImdbRatingScore(5);
			setFilePathOp("matches");
			setFilePathPattern("");
			setFilePathField("path");
			setSeerrIsRequested(true);
			setSeerrRequestCountOp("less_than");
			setSeerrRequestCountVal(1);
			setAudioChannelsOp("less_than");
			setAudioChannelsVal(6);
			setTagMatchOp("includes_any");
			setSelectedTagIds([]);
			setCompositeError(null);
			// Phase D
			setPlexCollectionOp("in");
			setSelectedPlexCollections([]);
			setPlexLabelOp("has_any");
			setSelectedPlexLabels([]);
			setPlexAddedAtOp("older_than");
			setPlexAddedAtDays(90);
			setBehaviorParams({});
			setServiceFilter([]);
			setInstanceFilter([]);
			setSelectedPlexLibraries([]);
			setExcludeTags([]);
			setExcludeTitles("");
		}
	}, [open, editRule]);

	// ── Build parameters ────────────────────────────────────────────
	const buildParams = useCallback((): Record<string, unknown> => {
		switch (ruleType) {
			case "age":
				return { field: "arrAddedAt", operator: ageOp, days };
			case "size":
				return { operator: sizeOp, sizeGb };
			case "rating":
				return scoreOp === "unrated"
					? { source: "tmdb", operator: "unrated" }
					: { source: "tmdb", operator: scoreOp, score };
			case "status":
				return { statuses: splitCsv(statuses) };
			case "unmonitored":
			case "no_file":
				return {};
			case "genre":
				return { operator: genreOp, genres: splitCsv(genres) };
			case "year_range": {
				if (yearOp === "between") return { operator: yearOp, yearFrom, yearTo };
				return { operator: yearOp, year };
			}
			case "quality_profile":
				return { profileNames: splitCsv(profileNames) };
			case "language":
				return { operator: langOp, languages: splitCsv(languages) };
			case "seerr_requested_by":
				return { userNames: splitCsv(seerrUserNames) };
			case "seerr_request_age":
				return { operator: seerrReqAgeOp, days: seerrReqAgeDays };
			case "seerr_request_status":
				return { statuses: splitCsv(seerrReqStatuses) };
			// File metadata rules — use arrays directly
			case "video_codec":
				return { operator: videoCodecOp, codecs: selectedVideoCodecs };
			case "audio_codec":
				return { operator: audioCodecOp, codecs: selectedAudioCodecs };
			case "resolution":
				return { operator: resolutionOp, resolutions: selectedResolutions };
			case "hdr_type":
				return hdrOp === "none"
					? { operator: "none" }
					: { operator: hdrOp, types: selectedHdrTypes };
			case "custom_format_score":
				return { operator: cfScoreOp, score: cfScore };
			case "runtime":
				return { operator: runtimeOp, minutes: runtimeMinutes };
			case "release_group":
				return { operator: releaseGroupOp, groups: selectedReleaseGroups };
			// Enhanced Seerr rules
			case "seerr_is_4k":
				return { is4k: seerrIs4k };
			case "seerr_request_modified_age":
				return { operator: seerrModifiedAgeOp, days: seerrModifiedAgeDays };
			case "seerr_modified_by":
				return { userNames: splitCsv(seerrModifiedByUsers) };
			// Tautulli rules
			case "tautulli_last_watched":
				return tautulliLastWatchedOp === "never"
					? { operator: "never" }
					: { operator: tautulliLastWatchedOp, days: tautulliLastWatchedDays };
			case "tautulli_watch_count":
				return { operator: tautulliWatchCountOp, count: tautulliWatchCount };
			case "tautulli_watched_by":
				return { operator: tautulliWatchedByOp, userNames: selectedTautulliUsers };
			// Plex rules
			case "plex_last_watched":
				return plexLastWatchedOp === "never"
					? { operator: "never" }
					: { operator: plexLastWatchedOp, days: plexLastWatchedDays };
			case "plex_watch_count":
				return { operator: plexWatchCountOp, count: plexWatchCountVal };
			case "plex_on_deck":
				return { isDeck: plexOnDeckVal };
			case "plex_user_rating":
				return plexUserRatingOp === "unrated"
					? { operator: "unrated" }
					: { operator: plexUserRatingOp, rating: plexUserRatingVal };
			case "plex_watched_by":
				return { operator: plexWatchedByOp, userNames: selectedPlexUsers };
			// Phase C rules
			case "imdb_rating":
				return imdbRatingOp === "unrated"
					? { operator: "unrated" }
					: { operator: imdbRatingOp, score: imdbRatingScore };
			case "file_path":
				return { operator: filePathOp, pattern: filePathPattern, field: filePathField };
			case "seerr_is_requested":
				return { isRequested: seerrIsRequested };
			case "seerr_request_count":
				return { operator: seerrRequestCountOp, count: seerrRequestCountVal };
			case "audio_channels":
				return { operator: audioChannelsOp, channels: audioChannelsVal };
			case "tag_match":
				return { operator: tagMatchOp, tagIds: selectedTagIds };
			// Phase D rules
			case "plex_collection":
				return { operator: plexCollectionOp, collections: selectedPlexCollections };
			case "plex_label":
				return { operator: plexLabelOp, labels: selectedPlexLabels };
			case "plex_added_at":
				return { operator: plexAddedAtOp, days: plexAddedAtDays };
			// Phase 2/3: Behavior analysis (delegate to behaviorParams)
			case "plex_episode_completion":
			case "user_retention":
			case "staleness_score":
			case "recently_active":
				return behaviorParams;
			default:
				return {};
		}
	}, [
		ruleType,
		days,
		ageOp,
		sizeOp,
		sizeGb,
		scoreOp,
		score,
		statuses,
		genreOp,
		genres,
		yearOp,
		year,
		yearFrom,
		yearTo,
		profileNames,
		langOp,
		languages,
		seerrUserNames,
		seerrReqAgeOp,
		seerrReqAgeDays,
		seerrReqStatuses,
		videoCodecOp,
		audioCodecOp,
		selectedVideoCodecs,
		selectedAudioCodecs,
		resolutionOp,
		selectedResolutions,
		hdrOp,
		selectedHdrTypes,
		cfScoreOp,
		cfScore,
		runtimeOp,
		runtimeMinutes,
		releaseGroupOp,
		selectedReleaseGroups,
		seerrIs4k,
		seerrModifiedAgeOp,
		seerrModifiedAgeDays,
		seerrModifiedByUsers,
		tautulliLastWatchedOp,
		tautulliLastWatchedDays,
		tautulliWatchCountOp,
		tautulliWatchCount,
		tautulliWatchedByOp,
		selectedTautulliUsers,
		plexLastWatchedOp,
		plexLastWatchedDays,
		plexWatchCountOp,
		plexWatchCountVal,
		plexOnDeckVal,
		plexUserRatingOp,
		plexUserRatingVal,
		plexWatchedByOp,
		selectedPlexUsers,
		imdbRatingOp,
		imdbRatingScore,
		filePathOp,
		filePathPattern,
		filePathField,
		seerrIsRequested,
		seerrRequestCountOp,
		seerrRequestCountVal,
		audioChannelsOp,
		audioChannelsVal,
		tagMatchOp,
		selectedTagIds,
		plexCollectionOp,
		selectedPlexCollections,
		plexLabelOp,
		selectedPlexLabels,
		plexAddedAtOp,
		plexAddedAtDays,
		behaviorParams,
	]);

	const handleSubmit = (e: React.FormEvent) => {
		e.preventDefault();
		if (isComposite && conditions.length === 0) {
			setCompositeError("Composite rules must have at least one condition");
			return;
		}
		setCompositeError(null);
		const base = {
			name,
			ruleType: isComposite ? ("composite" as const) : ruleType,
			enabled,
			priority: editRule?.priority ?? 0,
			parameters: isComposite ? {} : buildParams(),
			action,
			retentionMode,
			serviceFilter: serviceFilter.length > 0 ? serviceFilter : null,
			instanceFilter: instanceFilter.length > 0 ? instanceFilter : null,
			excludeTags: excludeTags.length > 0 ? excludeTags : null,
			excludeTitles: excludeTitles.trim() ? splitCsv(excludeTitles) : null,
			plexLibraryFilter: selectedPlexLibraries.length > 0 ? selectedPlexLibraries : null,
			operator: isComposite ? compositeOperator : null,
			conditions: isComposite
				? (conditions
						.filter((c) => c.ruleType !== "composite")
						.map((c) => ({
							ruleType: c.ruleType as Exclude<CleanupRuleType, "composite">,
							parameters: c.params,
						})))
				: null,
		};
		onSave(base as CreateCleanupRule);
	};

	const toggleService = (service: string) => {
		setServiceFilter((prev) =>
			prev.includes(service) ? prev.filter((s) => s !== service) : [...prev, service],
		);
	};

	const toggleCategory = (id: string) => {
		setExpandedCategories((prev) => {
			const next = new Set(prev);
			if (next.has(id)) next.delete(id);
			else next.add(id);
			return next;
		});
	};

	const inputStyles = getInputStyles(gradient);

	const inputClass = `${inputStyles.base} focus:outline-hidden`;
	const labelClass = "text-xs text-muted-foreground block mb-1";

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
				<DialogHeader>
					<DialogTitle>{isEdit ? "Edit Rule" : "New Cleanup Rule"}</DialogTitle>
					<DialogDescription>
						{isEdit
							? "Modify the rule settings and click Save."
							: "Configure when items should be flagged for cleanup."}
					</DialogDescription>
				</DialogHeader>

				<form
					onSubmit={handleSubmit}
					className="space-y-5 mt-2"
					onFocus={(e) => {
						const t = e.target;
						if (
							(t instanceof HTMLInputElement && t.type !== "checkbox") ||
							t instanceof HTMLSelectElement
						) {
							inputStyles.applyFocus(t);
						}
					}}
					onBlur={(e) => {
						const t = e.target;
						if (
							(t instanceof HTMLInputElement && t.type !== "checkbox") ||
							t instanceof HTMLSelectElement
						) {
							inputStyles.removeFocus(t);
						}
					}}
				>
					{/* ── Basic Section ─────────────────────────────── */}
					<div className="space-y-4">
						<label className="block">
							<span className={labelClass}>Rule Name</span>
							<input
								type="text"
								value={name}
								onChange={(e) => setName(e.target.value)}
								placeholder="e.g., Old low-rated movies"
								required
								className={inputClass}
							/>
						</label>

						<div className="flex items-center justify-between">
							<span className="text-sm font-medium">Enabled</span>
							<Switch
								checked={enabled}
								onCheckedChange={setEnabled}
								style={enabled ? { backgroundColor: gradient.from } : undefined}
							/>
						</div>

						{/* ── Retention Mode toggle ────────────────── */}
						<div className="flex items-center justify-between">
							<div className="flex items-center gap-2">
								<ShieldOff className="h-4 w-4 text-emerald-400" />
								<div>
									<span className="text-sm font-medium">Retention Rule</span>
									<p className="text-xs text-muted-foreground">Protects matching items from other rules</p>
								</div>
							</div>
							<Switch
								checked={retentionMode}
								onCheckedChange={setRetentionMode}
								style={retentionMode ? { backgroundColor: "rgb(16 185 129)" } : undefined}
							/>
						</div>

						{/* ── Action when matched ───────────────────── */}
						<div>
							<span className={labelClass}>Action when matched</span>
							<div className="flex gap-2 mt-1.5">
								{(["delete", "unmonitor", "delete_files"] as const).map((a) => (
									<button
										key={a}
										type="button"
										onClick={() => setAction(a)}
										className="rounded-lg border px-3 py-1.5 text-sm font-medium transition-all duration-200"
										style={
											action === a
												? {
														borderColor: gradient.from,
														backgroundColor: gradient.fromLight,
														color: gradient.from,
													}
												: { borderColor: "var(--color-border)" }
										}
									>
										{a === "delete" ? "Delete" : a === "unmonitor" ? "Unmonitor" : "Delete Files"}
									</button>
								))}
							</div>
							<p className="text-xs text-muted-foreground mt-1">
								{action === "delete"
									? "Remove the item entirely from the ARR instance."
									: action === "unmonitor"
										? "Set the item as unmonitored (keeps files and data)."
										: "Delete downloaded files but keep the item in the library."}
							</p>
						</div>

						{/* ── Rule Mode toggle ──────────────────────── */}
						<div>
							<span className={labelClass}>Rule Mode</span>
							<div className="flex gap-2 mt-1.5">
								<button
									type="button"
									onClick={() => { setIsComposite(false); setConditions([]); setCompositeError(null); }}
									className="rounded-lg border px-3 py-1.5 text-sm font-medium transition-all duration-200"
									style={
										!isComposite
											? { borderColor: gradient.from, backgroundColor: gradient.fromLight, color: gradient.from }
											: { borderColor: "var(--color-border)" }
									}
								>
									Single Condition
								</button>
								<button
									type="button"
									onClick={() => setIsComposite(true)}
									className="rounded-lg border px-3 py-1.5 text-sm font-medium transition-all duration-200"
									style={
										isComposite
											? { borderColor: gradient.from, backgroundColor: gradient.fromLight, color: gradient.from }
											: { borderColor: "var(--color-border)" }
									}
								>
									Composite Rule
								</button>
							</div>
						</div>

						{/* ── Rule Type Picker / Composite Builder ─── */}
						{isComposite ? (
							<div className="space-y-4">
								<div>
									<span className={labelClass}>Operator</span>
									<div className="flex gap-2 mt-1.5">
										{(["AND", "OR"] as const).map((op) => (
											<button
												key={op}
												type="button"
												onClick={() => setCompositeOperator(op)}
												className="rounded-lg border px-3 py-1.5 text-sm font-medium transition-all duration-200"
												style={
													compositeOperator === op
														? { borderColor: gradient.from, backgroundColor: gradient.fromLight, color: gradient.from }
														: { borderColor: "var(--color-border)" }
												}
											>
												{op}
											</button>
										))}
									</div>
									<p className="text-xs text-muted-foreground mt-1">
										{compositeOperator === "AND"
											? "All conditions must match for the rule to trigger."
											: "Any condition matching will trigger the rule."}
									</p>
								</div>
								{conditions.map((cond, idx) => (
									<div key={cond.id} className="rounded-lg border border-border/50 bg-card/20 p-3 space-y-2">
										<div className="flex items-center justify-between">
											<span className="text-xs font-medium text-muted-foreground">Condition {idx + 1}</span>
											<button
												type="button"
												onClick={() => setConditions((prev) => prev.filter((c) => c.id !== cond.id))}
												className="text-xs text-muted-foreground hover:text-destructive transition-colors"
											>
												Remove
											</button>
										</div>
										<select
											value={cond.ruleType}
											onChange={(e) => {
												const newType = e.target.value as CleanupRuleType;
												setConditions((prev) =>
													prev.map((c) =>
														c.id === cond.id ? { ...c, ruleType: newType, params: getDefaultConditionParams(newType) } : c,
													),
												);
											}}
											className={inputClass}
										>
											{RULE_TYPES.filter((rt) => rt.value !== "composite").map((rt) => (
												<option key={rt.value} value={rt.value}>{rt.label}</option>
											))}
										</select>
										<p className="text-xs text-muted-foreground">
											{RULE_TYPE_MAP.get(cond.ruleType)?.desc ?? ""}
										</p>
									<ConditionParamsFields
										ruleType={cond.ruleType}
										params={cond.params}
										onParamsChange={(newParams) =>
											setConditions((prev) =>
												prev.map((c) =>
													c.id === cond.id ? { ...c, params: newParams } : c,
												),
											)
										}
										fieldOptions={fieldOptions}
										fieldOptionsLoading={fieldOptionsLoading}
										inputClass={inputClass}
										labelClass={labelClass}
									/>
									</div>
								))}
								{compositeError && (
									<div className="rounded-md bg-red-500/10 border border-red-500/20 px-3 py-2 text-xs text-red-400">
										{compositeError}
									</div>
								)}
								<button
									type="button"
									onClick={() => {
										setConditions((prev) => [
											...prev,
											{ id: `cond-${Date.now()}`, ruleType: "age" as CleanupRuleType, params: getDefaultConditionParams("age") },
										]);
										setCompositeError(null);
									}}
									className="w-full rounded-lg border border-dashed border-border/50 px-3 py-2 text-sm text-muted-foreground hover:text-foreground hover:border-border transition-colors"
								>
									+ Add Condition
								</button>
							</div>
						) : isEdit ? (
							<div className="flex items-center gap-2">
								<span className="text-xs text-muted-foreground">Rule Type:</span>
								<span
									className="rounded-full border px-3 py-1 text-sm font-medium"
									style={{
										borderColor: gradient.fromMuted,
										backgroundColor: gradient.fromLight,
										color: gradient.from,
									}}
								>
									{RULE_TYPE_MAP.get(ruleType)?.label ?? ruleType}
								</span>
							</div>
						) : (
							<div className="space-y-1.5">
								<span className={labelClass}>Rule Type</span>
								<div className="space-y-1.5">
									{RULE_CATEGORIES.filter((cat) => {
										if (cat.requires === "plex" && !fieldOptions?.hasPlex) return false;
										if (cat.requires === "tautulli" && !fieldOptions?.hasTautulli) return false;
										return true;
									}).map((cat) => {
										const CatIcon = cat.icon;
										const isExpanded = expandedCategories.has(cat.id);
										const hasSelected = cat.types.includes(ruleType);
										return (
											<div
												key={cat.id}
												className="rounded-lg border border-border/30 overflow-hidden"
											>
												<button
													type="button"
													onClick={() => toggleCategory(cat.id)}
													className="flex items-center gap-2 w-full px-3 py-2 text-sm font-medium text-left hover:bg-card/50 transition-colors"
												>
													<CatIcon
														className="h-4 w-4 shrink-0"
														style={{ color: gradient.from }}
													/>
													<span className="flex-1">{cat.label}</span>
													{hasSelected && (
														<span
															className="h-1.5 w-1.5 rounded-full"
															style={{ backgroundColor: gradient.from }}
														/>
													)}
													<ChevronDown
														className={`h-3.5 w-3.5 text-muted-foreground transition-transform duration-200 ${
															isExpanded ? "" : "-rotate-90"
														}`}
													/>
												</button>
												{isExpanded && (
													<div className="grid grid-cols-2 gap-1.5 px-2 pb-2">
														{cat.types.map((typeValue) => {
															const ruleInfo = RULE_TYPE_MAP.get(typeValue);
															if (!ruleInfo) return null;
															const isSelected = ruleType === typeValue;
															return (
																<button
																	key={typeValue}
																	type="button"
																	onClick={() =>
																		setRuleType(
																			typeValue as CleanupRuleType,
																		)
																	}
																	className={`text-left rounded-lg border px-2.5 py-2 transition-all duration-200 ${
																		isSelected
																			? ""
																			: "border-border/30 hover:border-border/60"
																	}`}
																	style={
																		isSelected
																			? {
																					borderColor:
																						gradient.from,
																					backgroundColor:
																						gradient.fromLight,
																					color: gradient.from,
																				}
																			: undefined
																	}
																>
																	<div className="text-sm font-medium leading-tight">
																		{ruleInfo.label}
																	</div>
																	<div
																		className={`text-xs mt-0.5 leading-tight ${
																			isSelected
																				? "opacity-80"
																				: "text-muted-foreground"
																		}`}
																	>
																		{ruleInfo.desc}
																	</div>
																</button>
															);
														})}
													</div>
												)}
											</div>
										);
									})}
								</div>
							</div>
						)}
					</div>

					{/* ── Parameters Section ───────────────────────── */}
					{!isComposite && (
						<div className="rounded-xl border border-border/50 bg-card/30 backdrop-blur-sm p-4 space-y-3">
							<div className="flex items-center gap-2 mb-2">
								<SlidersHorizontal
									className="h-4 w-4"
									style={{ color: gradient.from }}
								/>
								<span className="text-sm font-medium">Parameters</span>
							</div>
							<ParamsFields
								ruleType={ruleType}
								days={days}
								setDays={setDays}
								ageOp={ageOp}
								setAgeOp={setAgeOp}
								sizeGb={sizeGb}
								setSizeGb={setSizeGb}
								sizeOp={sizeOp}
								setSizeOp={setSizeOp}
								score={score}
								setScore={setScore}
								scoreOp={scoreOp}
								setScoreOp={setScoreOp}
								statuses={statuses}
								setStatuses={setStatuses}
								genreOp={genreOp}
								setGenreOp={setGenreOp}
								genres={genres}
								setGenres={setGenres}
								yearOp={yearOp}
								setYearOp={setYearOp}
								year={year}
								setYear={setYear}
								yearFrom={yearFrom}
								setYearFrom={setYearFrom}
								yearTo={yearTo}
								setYearTo={setYearTo}
								profileNames={profileNames}
								setProfileNames={setProfileNames}
								langOp={langOp}
								setLangOp={setLangOp}
								languages={languages}
								setLanguages={setLanguages}
								seerrUserNames={seerrUserNames}
								setSeerrUserNames={setSeerrUserNames}
								seerrReqAgeOp={seerrReqAgeOp}
								setSeerrReqAgeOp={setSeerrReqAgeOp}
								seerrReqAgeDays={seerrReqAgeDays}
								setSeerrReqAgeDays={setSeerrReqAgeDays}
								seerrReqStatuses={seerrReqStatuses}
								setSeerrReqStatuses={setSeerrReqStatuses}
								videoCodecOp={videoCodecOp}
								setVideoCodecOp={setVideoCodecOp}
								audioCodecOp={audioCodecOp}
								setAudioCodecOp={setAudioCodecOp}
								selectedVideoCodecs={selectedVideoCodecs}
								setSelectedVideoCodecs={setSelectedVideoCodecs}
								selectedAudioCodecs={selectedAudioCodecs}
								setSelectedAudioCodecs={setSelectedAudioCodecs}
								resolutionOp={resolutionOp}
								setResolutionOp={setResolutionOp}
								selectedResolutions={selectedResolutions}
								setSelectedResolutions={setSelectedResolutions}
								hdrOp={hdrOp}
								setHdrOp={setHdrOp}
								selectedHdrTypes={selectedHdrTypes}
								setSelectedHdrTypes={setSelectedHdrTypes}
								cfScoreOp={cfScoreOp}
								setCfScoreOp={setCfScoreOp}
								cfScore={cfScore}
								setCfScore={setCfScore}
								runtimeOp={runtimeOp}
								setRuntimeOp={setRuntimeOp}
								runtimeMinutes={runtimeMinutes}
								setRuntimeMinutes={setRuntimeMinutes}
								releaseGroupOp={releaseGroupOp}
								setReleaseGroupOp={setReleaseGroupOp}
								selectedReleaseGroups={selectedReleaseGroups}
								setSelectedReleaseGroups={setSelectedReleaseGroups}
								seerrIs4k={seerrIs4k}
								setSeerrIs4k={setSeerrIs4k}
								seerrModifiedAgeOp={seerrModifiedAgeOp}
								setSeerrModifiedAgeOp={setSeerrModifiedAgeOp}
								seerrModifiedAgeDays={seerrModifiedAgeDays}
								setSeerrModifiedAgeDays={setSeerrModifiedAgeDays}
								seerrModifiedByUsers={seerrModifiedByUsers}
								setSeerrModifiedByUsers={setSeerrModifiedByUsers}
								tautulliLastWatchedOp={tautulliLastWatchedOp}
								setTautulliLastWatchedOp={setTautulliLastWatchedOp}
								tautulliLastWatchedDays={tautulliLastWatchedDays}
								setTautulliLastWatchedDays={setTautulliLastWatchedDays}
								tautulliWatchCountOp={tautulliWatchCountOp}
								setTautulliWatchCountOp={setTautulliWatchCountOp}
								tautulliWatchCount={tautulliWatchCount}
								setTautulliWatchCount={setTautulliWatchCount}
								tautulliWatchedByOp={tautulliWatchedByOp}
								setTautulliWatchedByOp={setTautulliWatchedByOp}
								selectedTautulliUsers={selectedTautulliUsers}
								setSelectedTautulliUsers={setSelectedTautulliUsers}
								plexLastWatchedOp={plexLastWatchedOp}
								setPlexLastWatchedOp={setPlexLastWatchedOp}
								plexLastWatchedDays={plexLastWatchedDays}
								setPlexLastWatchedDays={setPlexLastWatchedDays}
								plexWatchCountOp={plexWatchCountOp}
								setPlexWatchCountOp={setPlexWatchCountOp}
								plexWatchCountVal={plexWatchCountVal}
								setPlexWatchCountVal={setPlexWatchCountVal}
								plexOnDeckVal={plexOnDeckVal}
								setPlexOnDeckVal={setPlexOnDeckVal}
								plexUserRatingOp={plexUserRatingOp}
								setPlexUserRatingOp={setPlexUserRatingOp}
								plexUserRatingVal={plexUserRatingVal}
								setPlexUserRatingVal={setPlexUserRatingVal}
								plexWatchedByOp={plexWatchedByOp}
								setPlexWatchedByOp={setPlexWatchedByOp}
								selectedPlexUsers={selectedPlexUsers}
								setSelectedPlexUsers={setSelectedPlexUsers}
								imdbRatingOp={imdbRatingOp}
								setImdbRatingOp={setImdbRatingOp}
								imdbRatingScore={imdbRatingScore}
								setImdbRatingScore={setImdbRatingScore}
								filePathOp={filePathOp}
								setFilePathOp={setFilePathOp}
								filePathPattern={filePathPattern}
								setFilePathPattern={setFilePathPattern}
								filePathField={filePathField}
								setFilePathField={setFilePathField}
								seerrIsRequested={seerrIsRequested}
								setSeerrIsRequested={setSeerrIsRequested}
								seerrRequestCountOp={seerrRequestCountOp}
								setSeerrRequestCountOp={setSeerrRequestCountOp}
								seerrRequestCountVal={seerrRequestCountVal}
								setSeerrRequestCountVal={setSeerrRequestCountVal}
								audioChannelsOp={audioChannelsOp}
								setAudioChannelsOp={setAudioChannelsOp}
								audioChannelsVal={audioChannelsVal}
								setAudioChannelsVal={setAudioChannelsVal}
								tagMatchOp={tagMatchOp}
								setTagMatchOp={setTagMatchOp}
								selectedTagIds={selectedTagIds}
								setSelectedTagIds={setSelectedTagIds}
								plexCollectionOp={plexCollectionOp}
								setPlexCollectionOp={setPlexCollectionOp}
								selectedPlexCollections={selectedPlexCollections}
								setSelectedPlexCollections={setSelectedPlexCollections}
								plexLabelOp={plexLabelOp}
								setPlexLabelOp={setPlexLabelOp}
								selectedPlexLabels={selectedPlexLabels}
								setSelectedPlexLabels={setSelectedPlexLabels}
								plexAddedAtOp={plexAddedAtOp}
								setPlexAddedAtOp={setPlexAddedAtOp}
								plexAddedAtDays={plexAddedAtDays}
								setPlexAddedAtDays={setPlexAddedAtDays}
								behaviorParams={behaviorParams}
								setBehaviorParams={setBehaviorParams}
								fieldOptions={fieldOptions}
								fieldOptionsLoading={fieldOptionsLoading}
								inputClass={inputClass}
								labelClass={labelClass}
							/>
						</div>
					)}

					{/* ── Scope Section ─────────────────────────────── */}
					<div className="rounded-xl border border-border/50 bg-card/30 backdrop-blur-sm p-4 space-y-3">
						<div className="flex items-center gap-2 mb-2">
							<Target className="h-4 w-4" style={{ color: gradient.from }} />
							<span className="text-sm font-medium">Scope</span>
							<span className="text-xs text-muted-foreground">(optional)</span>
						</div>
						<div>
							<span className={labelClass}>Service Filter</span>
							<div className="flex gap-2 mt-1.5">
								{(["sonarr", "radarr"] as const).map((svc) => {
									const svcGradient = getServiceGradient(svc);
									const isActive = serviceFilter.includes(svc);
									return (
										<button
											key={svc}
											type="button"
											onClick={() => toggleService(svc)}
											aria-pressed={isActive}
											aria-label={`Filter by ${svc}`}
											className="rounded-lg border px-3 py-1.5 text-sm font-medium capitalize transition-all duration-200"
											style={
												isActive
													? {
															borderColor: svcGradient.from,
															backgroundColor: svcGradient.from,
															color: "#ffffff",
														}
													: {
															borderColor: `${svcGradient.from}40`,
															color: svcGradient.from,
														}
											}
										>
											{svc}
										</button>
									);
								})}
							</div>
							<p className="text-xs text-muted-foreground mt-1.5">
								Leave unselected to apply to all services.
							</p>
						</div>

						<div>
							<span className={labelClass}>Instance Filter</span>
							{arrInstances.length === 0 ? (
								<p className="text-xs text-muted-foreground mt-1">No Sonarr/Radarr instances configured.</p>
							) : (
								<div className="mt-1.5 space-y-1.5">
									{["sonarr", "radarr"].map((svc) => {
										const instances = arrInstances.filter((i) => i.service === svc);
										if (instances.length === 0) return null;
										return (
											<div key={svc}>
												<span className="text-[10px] uppercase tracking-wider text-muted-foreground/70 font-medium">{svc}</span>
												<div className="flex flex-wrap gap-2 mt-1">
													{instances.map((inst) => {
														const selected = instanceFilter.includes(inst.id);
														return (
															<button
																key={inst.id}
																type="button"
																onClick={() => {
																	setInstanceFilter((prev) =>
																		selected ? prev.filter((id) => id !== inst.id) : [...prev, inst.id],
																	);
																}}
																className={`rounded-md px-2.5 py-1 text-xs font-medium transition-colors border ${
																	selected
																		? "bg-primary/20 text-primary border-primary/30"
																		: "bg-card/30 text-muted-foreground hover:bg-card/50 border-border/30"
																}`}
															>
																{inst.label}
															</button>
														);
													})}
												</div>
											</div>
										);
									})}
									<p className="text-xs text-muted-foreground mt-1">Leave unselected for all instances.</p>
								</div>
							)}
						</div>

						{fieldOptions?.plexLibraries && fieldOptions.plexLibraries.length > 0 && (
							<div>
								<MultiSelectField
									label="Plex Library Filter"
									options={fieldOptions.plexLibraries}
									selected={selectedPlexLibraries}
									onChange={setSelectedPlexLibraries}
									loading={fieldOptionsLoading}
									inputClass={inputClass}
									labelClass={labelClass}
								/>
								<p className="text-xs text-muted-foreground mt-1.5">
									Limit Plex rules to specific libraries. Leave empty for all.
								</p>
							</div>
						)}
					</div>

					{/* ── Exclusions Section ────────────────────────── */}
					<div className="rounded-xl border border-border/50 bg-card/30 backdrop-blur-sm p-4 space-y-3">
						<div className="flex items-center gap-2 mb-2">
							<ShieldOff className="h-4 w-4" style={{ color: gradient.from }} />
							<span className="text-sm font-medium">Exclusions</span>
							<span className="text-xs text-muted-foreground">(optional)</span>
						</div>
						<ExcludeTagsPicker
							excludeTags={excludeTags}
							setExcludeTags={setExcludeTags}
							fieldOptions={fieldOptions}
							inputClass={inputClass}
							labelClass={labelClass}
						/>
						<label className="block">
							<span className={labelClass}>Exclude Titles (regex patterns, comma-separated)</span>
							<input
								type="text"
								value={excludeTitles}
								onChange={(e) => setExcludeTitles(e.target.value)}
								placeholder="e.g., ^The Office, Game of Thrones"
								className={inputClass}
							/>
						</label>
					</div>

					{/* ── Actions ───────────────────────────────────── */}
					<div className="flex justify-end gap-2 pt-2">
						<button
							type="button"
							onClick={() => onOpenChange(false)}
							className="rounded-lg px-4 py-2 text-sm text-muted-foreground hover:text-foreground transition-colors"
						>
							Cancel
						</button>
						<button
							type="submit"
							disabled={!name.trim() || isSaving}
							className="inline-flex items-center rounded-lg px-4 py-2 text-sm font-medium text-white transition-all duration-200 disabled:opacity-50"
							style={{
								background: `linear-gradient(135deg, ${gradient.from}, ${gradient.to})`,
							}}
							onMouseEnter={(e) => {
								e.currentTarget.style.boxShadow = `0 4px 15px -3px ${gradient.glow}`;
							}}
							onMouseLeave={(e) => {
								e.currentTarget.style.boxShadow = "";
							}}
						>
							{isSaving ? (
								<Loader2 className="mr-2 h-4 w-4 animate-spin" />
							) : (
								<Save className="mr-2 h-4 w-4" />
							)}
							{isEdit ? "Save Changes" : "Add Rule"}
						</button>
					</div>
				</form>
			</DialogContent>
		</Dialog>
	);
}

// ============================================================================
// Parameters Fields (per rule type)
// ============================================================================

interface ParamsFieldsProps {
	ruleType: CleanupRuleType;
	days: number;
	setDays: (v: number) => void;
	ageOp: string;
	setAgeOp: (v: string) => void;
	sizeGb: number;
	setSizeGb: (v: number) => void;
	sizeOp: string;
	setSizeOp: (v: string) => void;
	score: number;
	setScore: (v: number) => void;
	scoreOp: string;
	setScoreOp: (v: string) => void;
	statuses: string;
	setStatuses: (v: string) => void;
	genreOp: string;
	setGenreOp: (v: string) => void;
	genres: string;
	setGenres: (v: string) => void;
	yearOp: string;
	setYearOp: (v: string) => void;
	year: number;
	setYear: (v: number) => void;
	yearFrom: number;
	setYearFrom: (v: number) => void;
	yearTo: number;
	setYearTo: (v: number) => void;
	profileNames: string;
	setProfileNames: (v: string) => void;
	langOp: string;
	setLangOp: (v: string) => void;
	languages: string;
	setLanguages: (v: string) => void;
	seerrUserNames: string;
	setSeerrUserNames: (v: string) => void;
	seerrReqAgeOp: string;
	setSeerrReqAgeOp: (v: string) => void;
	seerrReqAgeDays: number;
	setSeerrReqAgeDays: (v: number) => void;
	seerrReqStatuses: string;
	setSeerrReqStatuses: (v: string) => void;
	// File metadata (multi-select arrays)
	videoCodecOp: string;
	setVideoCodecOp: (v: string) => void;
	audioCodecOp: string;
	setAudioCodecOp: (v: string) => void;
	selectedVideoCodecs: string[];
	setSelectedVideoCodecs: (v: string[]) => void;
	selectedAudioCodecs: string[];
	setSelectedAudioCodecs: (v: string[]) => void;
	resolutionOp: string;
	setResolutionOp: (v: string) => void;
	selectedResolutions: string[];
	setSelectedResolutions: (v: string[]) => void;
	hdrOp: string;
	setHdrOp: (v: string) => void;
	selectedHdrTypes: string[];
	setSelectedHdrTypes: (v: string[]) => void;
	cfScoreOp: string;
	setCfScoreOp: (v: string) => void;
	cfScore: number;
	setCfScore: (v: number) => void;
	runtimeOp: string;
	setRuntimeOp: (v: string) => void;
	runtimeMinutes: number;
	setRuntimeMinutes: (v: number) => void;
	releaseGroupOp: string;
	setReleaseGroupOp: (v: string) => void;
	selectedReleaseGroups: string[];
	setSelectedReleaseGroups: (v: string[]) => void;
	// Enhanced Seerr
	seerrIs4k: boolean;
	setSeerrIs4k: (v: boolean) => void;
	seerrModifiedAgeOp: string;
	setSeerrModifiedAgeOp: (v: string) => void;
	seerrModifiedAgeDays: number;
	setSeerrModifiedAgeDays: (v: number) => void;
	seerrModifiedByUsers: string;
	setSeerrModifiedByUsers: (v: string) => void;
	// Tautulli
	tautulliLastWatchedOp: string;
	setTautulliLastWatchedOp: (v: string) => void;
	tautulliLastWatchedDays: number;
	setTautulliLastWatchedDays: (v: number) => void;
	tautulliWatchCountOp: string;
	setTautulliWatchCountOp: (v: string) => void;
	tautulliWatchCount: number;
	setTautulliWatchCount: (v: number) => void;
	tautulliWatchedByOp: string;
	setTautulliWatchedByOp: (v: string) => void;
	selectedTautulliUsers: string[];
	setSelectedTautulliUsers: (v: string[]) => void;
	// Plex
	plexLastWatchedOp: string;
	setPlexLastWatchedOp: (v: string) => void;
	plexLastWatchedDays: number;
	setPlexLastWatchedDays: (v: number) => void;
	plexWatchCountOp: string;
	setPlexWatchCountOp: (v: string) => void;
	plexWatchCountVal: number;
	setPlexWatchCountVal: (v: number) => void;
	plexOnDeckVal: boolean;
	setPlexOnDeckVal: (v: boolean) => void;
	plexUserRatingOp: string;
	setPlexUserRatingOp: (v: string) => void;
	plexUserRatingVal: number;
	setPlexUserRatingVal: (v: number) => void;
	plexWatchedByOp: string;
	setPlexWatchedByOp: (v: string) => void;
	selectedPlexUsers: string[];
	setSelectedPlexUsers: (v: string[]) => void;
	// Phase C
	imdbRatingOp: string;
	setImdbRatingOp: (v: string) => void;
	imdbRatingScore: number;
	setImdbRatingScore: (v: number) => void;
	filePathOp: string;
	setFilePathOp: (v: string) => void;
	filePathPattern: string;
	setFilePathPattern: (v: string) => void;
	filePathField: string;
	setFilePathField: (v: string) => void;
	seerrIsRequested: boolean;
	setSeerrIsRequested: (v: boolean) => void;
	seerrRequestCountOp: string;
	setSeerrRequestCountOp: (v: string) => void;
	seerrRequestCountVal: number;
	setSeerrRequestCountVal: (v: number) => void;
	audioChannelsOp: string;
	setAudioChannelsOp: (v: string) => void;
	audioChannelsVal: number;
	setAudioChannelsVal: (v: number) => void;
	tagMatchOp: string;
	setTagMatchOp: (v: string) => void;
	selectedTagIds: number[];
	setSelectedTagIds: (v: number[]) => void;
	// Phase D
	plexCollectionOp: string;
	setPlexCollectionOp: (v: string) => void;
	selectedPlexCollections: string[];
	setSelectedPlexCollections: (v: string[]) => void;
	plexLabelOp: string;
	setPlexLabelOp: (v: string) => void;
	selectedPlexLabels: string[];
	setSelectedPlexLabels: (v: string[]) => void;
	// Phase E: Plex added_at
	plexAddedAtOp: string;
	setPlexAddedAtOp: (v: string) => void;
	plexAddedAtDays: number;
	setPlexAddedAtDays: (v: number) => void;
	// Phase 2/3: Behavior analysis (delegate to ConditionParamsFields)
	behaviorParams: Record<string, unknown>;
	setBehaviorParams: (v: Record<string, unknown>) => void;
	// Field options from library cache
	fieldOptions: CleanupFieldOptionsResponse | undefined;
	fieldOptionsLoading: boolean;
	inputClass: string;
	labelClass: string;
}

function ParamsFields(props: ParamsFieldsProps) {
	const {
		ruleType,
		days,
		setDays,
		ageOp,
		setAgeOp,
		sizeGb,
		setSizeGb,
		sizeOp,
		setSizeOp,
		score,
		setScore,
		scoreOp,
		setScoreOp,
		statuses,
		setStatuses,
		genreOp,
		setGenreOp,
		genres,
		setGenres,
		yearOp,
		setYearOp,
		year,
		setYear,
		yearFrom,
		setYearFrom,
		yearTo,
		setYearTo,
		profileNames,
		setProfileNames,
		langOp,
		setLangOp,
		languages,
		setLanguages,
		seerrUserNames,
		setSeerrUserNames,
		seerrReqAgeOp,
		setSeerrReqAgeOp,
		seerrReqAgeDays,
		setSeerrReqAgeDays,
		seerrReqStatuses,
		setSeerrReqStatuses,
		videoCodecOp,
		setVideoCodecOp,
		audioCodecOp,
		setAudioCodecOp,
		selectedVideoCodecs,
		setSelectedVideoCodecs,
		selectedAudioCodecs,
		setSelectedAudioCodecs,
		resolutionOp,
		setResolutionOp,
		selectedResolutions,
		setSelectedResolutions,
		hdrOp,
		setHdrOp,
		selectedHdrTypes,
		setSelectedHdrTypes,
		cfScoreOp,
		setCfScoreOp,
		cfScore,
		setCfScore,
		runtimeOp,
		setRuntimeOp,
		runtimeMinutes,
		setRuntimeMinutes,
		releaseGroupOp,
		setReleaseGroupOp,
		selectedReleaseGroups,
		setSelectedReleaseGroups,
		seerrIs4k,
		setSeerrIs4k,
		seerrModifiedAgeOp,
		setSeerrModifiedAgeOp,
		seerrModifiedAgeDays,
		setSeerrModifiedAgeDays,
		seerrModifiedByUsers,
		setSeerrModifiedByUsers,
		tautulliLastWatchedOp,
		setTautulliLastWatchedOp,
		tautulliLastWatchedDays,
		setTautulliLastWatchedDays,
		tautulliWatchCountOp,
		setTautulliWatchCountOp,
		tautulliWatchCount,
		setTautulliWatchCount,
		tautulliWatchedByOp,
		setTautulliWatchedByOp,
		selectedTautulliUsers,
		setSelectedTautulliUsers,
		plexLastWatchedOp,
		setPlexLastWatchedOp,
		plexLastWatchedDays,
		setPlexLastWatchedDays,
		plexWatchCountOp,
		setPlexWatchCountOp,
		plexWatchCountVal,
		setPlexWatchCountVal,
		plexOnDeckVal,
		setPlexOnDeckVal,
		plexUserRatingOp,
		setPlexUserRatingOp,
		plexUserRatingVal,
		setPlexUserRatingVal,
		plexWatchedByOp,
		setPlexWatchedByOp,
		selectedPlexUsers,
		setSelectedPlexUsers,
		imdbRatingOp,
		setImdbRatingOp,
		imdbRatingScore,
		setImdbRatingScore,
		filePathOp,
		setFilePathOp,
		filePathPattern,
		setFilePathPattern,
		filePathField,
		setFilePathField,
		seerrIsRequested,
		setSeerrIsRequested,
		seerrRequestCountOp,
		setSeerrRequestCountOp,
		seerrRequestCountVal,
		setSeerrRequestCountVal,
		audioChannelsOp,
		setAudioChannelsOp,
		audioChannelsVal,
		setAudioChannelsVal,
		tagMatchOp,
		setTagMatchOp,
		selectedTagIds,
		setSelectedTagIds,
		plexCollectionOp,
		setPlexCollectionOp,
		selectedPlexCollections,
		setSelectedPlexCollections,
		plexLabelOp,
		setPlexLabelOp,
		selectedPlexLabels,
		setSelectedPlexLabels,
		plexAddedAtOp,
		setPlexAddedAtOp,
		plexAddedAtDays,
		setPlexAddedAtDays,
		behaviorParams,
		setBehaviorParams,
		fieldOptions,
		fieldOptionsLoading,
		inputClass,
		labelClass,
	} = props;
	switch (ruleType) {
		case "age":
			return (
				<div className="flex gap-2">
					<label className="block flex-1">
						<span className={labelClass}>Operator</span>
						<select
							value={ageOp}
							onChange={(e) => setAgeOp(e.target.value)}
							className={inputClass}
						>
							<option value="older_than">Older than</option>
							<option value="newer_than">Newer than</option>
						</select>
					</label>
					<label className="block w-24">
						<span className={labelClass}>Days</span>
						<input
							type="number"
							value={days}
							onChange={(e) => setDays(Number(e.target.value))}
							min={1}
							className={inputClass}
						/>
					</label>
				</div>
			);
		case "size":
			return (
				<div className="flex gap-2">
					<label className="block flex-1">
						<span className={labelClass}>Operator</span>
						<select
							value={sizeOp}
							onChange={(e) => setSizeOp(e.target.value)}
							className={inputClass}
						>
							<option value="greater_than">Greater than</option>
							<option value="less_than">Less than</option>
						</select>
					</label>
					<label className="block w-24">
						<span className={labelClass}>Size (GB)</span>
						<input
							type="number"
							value={sizeGb}
							onChange={(e) => setSizeGb(Number(e.target.value))}
							min={0}
							className={inputClass}
						/>
					</label>
				</div>
			);
		case "rating":
			return (
				<div className="flex gap-2">
					<label className="block flex-1">
						<span className={labelClass}>Operator</span>
						<select
							value={scoreOp}
							onChange={(e) => setScoreOp(e.target.value)}
							className={inputClass}
						>
							<option value="less_than">Less than</option>
							<option value="greater_than">Greater than</option>
							<option value="unrated">Unrated</option>
						</select>
					</label>
					{scoreOp !== "unrated" && (
						<label className="block w-24">
							<span className={labelClass}>TMDB Score</span>
							<input
								type="number"
								value={score}
								onChange={(e) => setScore(Number(e.target.value))}
								min={0}
								max={10}
								step={0.5}
								className={inputClass}
							/>
						</label>
					)}
				</div>
			);
		case "status":
			return (
				<label className="block">
					<span className={labelClass}>Statuses (comma-separated)</span>
					<input
						type="text"
						value={statuses}
						onChange={(e) => setStatuses(e.target.value)}
						placeholder="ended, deleted, upcoming"
						className={inputClass}
					/>
				</label>
			);
		case "unmonitored":
			return (
				<p className="text-xs text-muted-foreground">
					Matches all unmonitored items. No additional parameters.
				</p>
			);
		case "no_file":
			return (
				<p className="text-xs text-muted-foreground">
					Matches items with no file on disk. No additional parameters.
				</p>
			);
		case "genre":
			return (
				<div className="space-y-2">
					<label className="block">
						<span className={labelClass}>Operator</span>
						<select
							value={genreOp}
							onChange={(e) => setGenreOp(e.target.value)}
							className={inputClass}
						>
							<option value="includes_any">Includes any of</option>
							<option value="excludes_all">Excludes all of</option>
						</select>
					</label>
					<label className="block">
						<span className={labelClass}>Genres (comma-separated)</span>
						<input
							type="text"
							value={genres}
							onChange={(e) => setGenres(e.target.value)}
							placeholder="Horror, Reality, Talk Show"
							className={inputClass}
						/>
					</label>
				</div>
			);
		case "year_range":
			return (
				<div className="space-y-2">
					<label className="block">
						<span className={labelClass}>Operator</span>
						<select
							value={yearOp}
							onChange={(e) => setYearOp(e.target.value)}
							className={inputClass}
						>
							<option value="before">Before year</option>
							<option value="after">After year</option>
							<option value="between">Between years</option>
						</select>
					</label>
					{yearOp === "between" ? (
						<div className="flex gap-2">
							<label className="block flex-1">
								<span className={labelClass}>From</span>
								<input
									type="number"
									value={yearFrom}
									onChange={(e) => setYearFrom(Number(e.target.value))}
									className={inputClass}
								/>
							</label>
							<label className="block flex-1">
								<span className={labelClass}>To</span>
								<input
									type="number"
									value={yearTo}
									onChange={(e) => setYearTo(Number(e.target.value))}
									className={inputClass}
								/>
							</label>
						</div>
					) : (
						<label className="block">
							<span className={labelClass}>Year</span>
							<input
								type="number"
								value={year}
								onChange={(e) => setYear(Number(e.target.value))}
								className={inputClass}
							/>
						</label>
					)}
				</div>
			);
		case "quality_profile":
			return (
				<label className="block">
					<span className={labelClass}>Profile names (comma-separated)</span>
					<input
						type="text"
						value={profileNames}
						onChange={(e) => setProfileNames(e.target.value)}
						placeholder="Any, Remux-2160p, HD-1080p"
						className={inputClass}
					/>
				</label>
			);
		case "language":
			return (
				<div className="space-y-2">
					<label className="block">
						<span className={labelClass}>Operator</span>
						<select
							value={langOp}
							onChange={(e) => setLangOp(e.target.value)}
							className={inputClass}
						>
							<option value="includes_any">Includes any of</option>
							<option value="excludes_all">Excludes all of</option>
						</select>
					</label>
					<label className="block">
						<span className={labelClass}>Languages (comma-separated)</span>
						<input
							type="text"
							value={languages}
							onChange={(e) => setLanguages(e.target.value)}
							placeholder="English, Japanese, French"
							className={inputClass}
						/>
					</label>
				</div>
			);
		case "seerr_requested_by":
			return (
				<div className="space-y-2">
					<label className="block">
						<span className={labelClass}>Seerr usernames (comma-separated)</span>
						<input
							type="text"
							value={seerrUserNames}
							onChange={(e) => setSeerrUserNames(e.target.value)}
							placeholder="john, jane_doe"
							className={inputClass}
						/>
					</label>
					<p className="text-xs text-muted-foreground">
						Flag items requested by these Seerr users. Requires a Seerr instance.
					</p>
				</div>
			);
		case "seerr_request_age":
			return (
				<div className="space-y-2">
					<div className="flex gap-2">
						<label className="block flex-1">
							<span className={labelClass}>Operator</span>
							<select
								value={seerrReqAgeOp}
								onChange={(e) => setSeerrReqAgeOp(e.target.value)}
								className={inputClass}
							>
								<option value="older_than">Older than</option>
								<option value="newer_than">Newer than</option>
							</select>
						</label>
						<label className="block w-24">
							<span className={labelClass}>Days</span>
							<input
								type="number"
								value={seerrReqAgeDays}
								onChange={(e) => setSeerrReqAgeDays(Number(e.target.value))}
								min={1}
								className={inputClass}
							/>
						</label>
					</div>
					<p className="text-xs text-muted-foreground">
						Flag items whose Seerr request is older/newer than N days.
					</p>
				</div>
			);
		case "seerr_request_status":
			return (
				<div className="space-y-2">
					<label className="block">
						<span className={labelClass}>Request statuses (comma-separated)</span>
						<input
							type="text"
							value={seerrReqStatuses}
							onChange={(e) => setSeerrReqStatuses(e.target.value)}
							placeholder="pending, approved, declined, failed, completed"
							className={inputClass}
						/>
					</label>
					<p className="text-xs text-muted-foreground">
						Flag items whose Seerr request has one of these statuses.
					</p>
				</div>
			);

		// ── File Metadata Rules (multi-select dropdowns) ────────────
		case "video_codec":
			return (
				<div className="space-y-2">
					<label className="block">
						<span className={labelClass}>Operator</span>
						<select
							value={videoCodecOp}
							onChange={(e) => setVideoCodecOp(e.target.value)}
							className={inputClass}
						>
							<option value="is">Is</option>
							<option value="is_not">Is not</option>
						</select>
					</label>
					<MultiSelectField
						label="Video Codecs"
						options={fieldOptions?.videoCodecs ?? []}
						selected={selectedVideoCodecs}
						onChange={setSelectedVideoCodecs}
						loading={fieldOptionsLoading}
						inputClass={inputClass}
						labelClass={labelClass}
					/>
				</div>
			);
		case "audio_codec":
			return (
				<div className="space-y-2">
					<label className="block">
						<span className={labelClass}>Operator</span>
						<select
							value={audioCodecOp}
							onChange={(e) => setAudioCodecOp(e.target.value)}
							className={inputClass}
						>
							<option value="is">Is</option>
							<option value="is_not">Is not</option>
						</select>
					</label>
					<MultiSelectField
						label="Audio Codecs"
						options={fieldOptions?.audioCodecs ?? []}
						selected={selectedAudioCodecs}
						onChange={setSelectedAudioCodecs}
						loading={fieldOptionsLoading}
						inputClass={inputClass}
						labelClass={labelClass}
					/>
				</div>
			);
		case "resolution":
			return (
				<div className="space-y-2">
					<label className="block">
						<span className={labelClass}>Operator</span>
						<select
							value={resolutionOp}
							onChange={(e) => setResolutionOp(e.target.value)}
							className={inputClass}
						>
							<option value="is">Is</option>
							<option value="is_not">Is not</option>
						</select>
					</label>
					<MultiSelectField
						label="Resolutions"
						options={fieldOptions?.resolutions ?? []}
						selected={selectedResolutions}
						onChange={setSelectedResolutions}
						loading={fieldOptionsLoading}
						inputClass={inputClass}
						labelClass={labelClass}
					/>
				</div>
			);
		case "hdr_type":
			return (
				<div className="space-y-2">
					<label className="block">
						<span className={labelClass}>Operator</span>
						<select value={hdrOp} onChange={(e) => setHdrOp(e.target.value)} className={inputClass}>
							<option value="is">Is</option>
							<option value="is_not">Is not</option>
							<option value="none">No HDR (SDR only)</option>
						</select>
					</label>
					{hdrOp !== "none" && (
						<MultiSelectField
							label="HDR Types"
							options={fieldOptions?.hdrTypes ?? []}
							selected={selectedHdrTypes}
							onChange={setSelectedHdrTypes}
							loading={fieldOptionsLoading}
							inputClass={inputClass}
							labelClass={labelClass}
						/>
					)}
				</div>
			);
		case "custom_format_score":
			return (
				<div className="flex gap-2">
					<label className="block flex-1">
						<span className={labelClass}>Operator</span>
						<select
							value={cfScoreOp}
							onChange={(e) => setCfScoreOp(e.target.value)}
							className={inputClass}
						>
							<option value="less_than">Less than</option>
							<option value="greater_than">Greater than</option>
						</select>
					</label>
					<label className="block w-24">
						<span className={labelClass}>Score</span>
						<input
							type="number"
							value={cfScore}
							onChange={(e) => setCfScore(Number(e.target.value))}
							className={inputClass}
						/>
					</label>
				</div>
			);
		case "runtime":
			return (
				<div className="flex gap-2">
					<label className="block flex-1">
						<span className={labelClass}>Operator</span>
						<select
							value={runtimeOp}
							onChange={(e) => setRuntimeOp(e.target.value)}
							className={inputClass}
						>
							<option value="greater_than">Greater than</option>
							<option value="less_than">Less than</option>
						</select>
					</label>
					<label className="block w-32">
						<span className={labelClass}>Minutes</span>
						<input
							type="number"
							value={runtimeMinutes}
							onChange={(e) => setRuntimeMinutes(Number(e.target.value))}
							min={0}
							className={inputClass}
						/>
					</label>
				</div>
			);
		case "release_group":
			return (
				<div className="space-y-2">
					<label className="block">
						<span className={labelClass}>Operator</span>
						<select
							value={releaseGroupOp}
							onChange={(e) => setReleaseGroupOp(e.target.value)}
							className={inputClass}
						>
							<option value="is">Is</option>
							<option value="is_not">Is not</option>
						</select>
					</label>
					<MultiSelectField
						label="Release Groups"
						options={fieldOptions?.releaseGroups ?? []}
						selected={selectedReleaseGroups}
						onChange={setSelectedReleaseGroups}
						loading={fieldOptionsLoading}
						inputClass={inputClass}
						labelClass={labelClass}
					/>
				</div>
			);

		// ── Enhanced Seerr Rules ─────────────────────────────────────
		case "seerr_is_4k":
			return (
				<div className="space-y-2">
					<label className="flex items-center gap-2 text-sm">
						<input
							type="checkbox"
							checked={seerrIs4k}
							onChange={(e) => setSeerrIs4k(e.target.checked)}
						/>
						Flag 4K requests
					</label>
					<p className="text-xs text-muted-foreground">
						{seerrIs4k
							? "Matches items with 4K Seerr requests."
							: "Matches items with non-4K Seerr requests."}
					</p>
				</div>
			);
		case "seerr_request_modified_age":
			return (
				<div className="space-y-2">
					<div className="flex gap-2">
						<label className="block flex-1">
							<span className={labelClass}>Operator</span>
							<select
								value={seerrModifiedAgeOp}
								onChange={(e) => setSeerrModifiedAgeOp(e.target.value)}
								className={inputClass}
							>
								<option value="older_than">Older than</option>
								<option value="newer_than">Newer than</option>
							</select>
						</label>
						<label className="block w-24">
							<span className={labelClass}>Days</span>
							<input
								type="number"
								value={seerrModifiedAgeDays}
								onChange={(e) => setSeerrModifiedAgeDays(Number(e.target.value))}
								min={1}
								className={inputClass}
							/>
						</label>
					</div>
					<p className="text-xs text-muted-foreground">
						Flag items by when their Seerr request was last modified.
					</p>
				</div>
			);
		case "seerr_modified_by":
			return (
				<div className="space-y-2">
					<label className="block">
						<span className={labelClass}>Seerr usernames (comma-separated)</span>
						<input
							type="text"
							value={seerrModifiedByUsers}
							onChange={(e) => setSeerrModifiedByUsers(e.target.value)}
							placeholder="admin, john_doe"
							className={inputClass}
						/>
					</label>
					<p className="text-xs text-muted-foreground">
						Flag items whose Seerr request was last modified by these users.
					</p>
				</div>
			);

		// ── Tautulli Rules ───────────────────────────────────────────
		case "tautulli_last_watched":
			return (
				<div className="space-y-2">
					<div className="flex gap-2">
						<label className="block flex-1">
							<span className={labelClass}>Operator</span>
							<select
								value={tautulliLastWatchedOp}
								onChange={(e) => setTautulliLastWatchedOp(e.target.value)}
								className={inputClass}
							>
								<option value="older_than">Last watched older than</option>
								<option value="never">Never watched</option>
							</select>
						</label>
						{tautulliLastWatchedOp !== "never" && (
							<label className="block w-24">
								<span className={labelClass}>Days</span>
								<input
									type="number"
									value={tautulliLastWatchedDays}
									onChange={(e) => setTautulliLastWatchedDays(Number(e.target.value))}
									min={1}
									className={inputClass}
								/>
							</label>
						)}
					</div>
					<p className="text-xs text-muted-foreground">
						Requires a Tautulli instance to be configured.
					</p>
				</div>
			);
		case "tautulli_watch_count":
			return (
				<div className="space-y-2">
					<div className="flex gap-2">
						<label className="block flex-1">
							<span className={labelClass}>Operator</span>
							<select
								value={tautulliWatchCountOp}
								onChange={(e) => setTautulliWatchCountOp(e.target.value)}
								className={inputClass}
							>
								<option value="less_than">Less than</option>
								<option value="greater_than">Greater than</option>
							</select>
						</label>
						<label className="block w-24">
							<span className={labelClass}>Count</span>
							<input
								type="number"
								value={tautulliWatchCount}
								onChange={(e) => setTautulliWatchCount(Number(e.target.value))}
								min={0}
								className={inputClass}
							/>
						</label>
					</div>
					<p className="text-xs text-muted-foreground">
						Flag items by total play count from Tautulli.
					</p>
				</div>
			);
		case "tautulli_watched_by":
			return (
				<div className="space-y-2">
					<label className="block">
						<span className={labelClass}>Operator</span>
						<select
							value={tautulliWatchedByOp}
							onChange={(e) => setTautulliWatchedByOp(e.target.value)}
							className={inputClass}
						>
							<option value="includes_any">Watched by any of</option>
							<option value="excludes_all">Not watched by any of</option>
						</select>
					</label>
					<MultiSelectField
						label="Tautulli Users"
						options={fieldOptions?.tautulliUsers ?? []}
						selected={selectedTautulliUsers}
						onChange={setSelectedTautulliUsers}
						loading={fieldOptionsLoading}
						inputClass={inputClass}
						labelClass={labelClass}
					/>
					<p className="text-xs text-muted-foreground">
						Flag items based on which Tautulli users have watched them.
					</p>
				</div>
			);

		// ── Plex Rules ──────────────────────────────────────────────
		case "plex_last_watched":
			return (
				<div className="space-y-2">
					<div className="flex gap-2">
						<label className="block flex-1">
							<span className={labelClass}>Operator</span>
							<select
								value={plexLastWatchedOp}
								onChange={(e) => setPlexLastWatchedOp(e.target.value)}
								className={inputClass}
							>
								<option value="older_than">Last watched older than</option>
								<option value="never">Never watched</option>
							</select>
						</label>
						{plexLastWatchedOp !== "never" && (
							<label className="block w-24">
								<span className={labelClass}>Days</span>
								<input
									type="number"
									value={plexLastWatchedDays}
									onChange={(e) => setPlexLastWatchedDays(Number(e.target.value))}
									min={1}
									className={inputClass}
								/>
							</label>
						)}
					</div>
					<p className="text-xs text-muted-foreground">
						Requires a Plex instance to be configured.
					</p>
				</div>
			);
		case "plex_watch_count":
			return (
				<div className="space-y-2">
					<div className="flex gap-2">
						<label className="block flex-1">
							<span className={labelClass}>Operator</span>
							<select
								value={plexWatchCountOp}
								onChange={(e) => setPlexWatchCountOp(e.target.value)}
								className={inputClass}
							>
								<option value="less_than">Less than</option>
								<option value="greater_than">Greater than</option>
							</select>
						</label>
						<label className="block w-24">
							<span className={labelClass}>Count</span>
							<input
								type="number"
								value={plexWatchCountVal}
								onChange={(e) => setPlexWatchCountVal(Number(e.target.value))}
								min={0}
								className={inputClass}
							/>
						</label>
					</div>
					<p className="text-xs text-muted-foreground">
						Flag items by total play count from Plex.
					</p>
				</div>
			);
		case "plex_on_deck":
			return (
				<div className="space-y-2">
					<label className="flex items-center gap-2 text-sm">
						<input
							type="checkbox"
							checked={plexOnDeckVal}
							onChange={(e) => setPlexOnDeckVal(e.target.checked)}
						/>
						Item is on Continue Watching
					</label>
					<p className="text-xs text-muted-foreground">
						{plexOnDeckVal
							? "Matches items currently on Plex's Continue Watching / On Deck."
							: "Matches items NOT on Plex's Continue Watching / On Deck."}
					</p>
				</div>
			);
		case "plex_user_rating":
			return (
				<div className="space-y-2">
					<div className="flex gap-2">
						<label className="block flex-1">
							<span className={labelClass}>Operator</span>
							<select
								value={plexUserRatingOp}
								onChange={(e) => setPlexUserRatingOp(e.target.value)}
								className={inputClass}
							>
								<option value="less_than">Less than</option>
								<option value="greater_than">Greater than</option>
								<option value="unrated">Unrated</option>
							</select>
						</label>
						{plexUserRatingOp !== "unrated" && (
							<label className="block w-24">
								<span className={labelClass}>Rating</span>
								<input
									type="number"
									value={plexUserRatingVal}
									onChange={(e) => setPlexUserRatingVal(Number(e.target.value))}
									min={0}
									max={10}
									step={0.5}
									className={inputClass}
								/>
							</label>
						)}
					</div>
					<p className="text-xs text-muted-foreground">
						Flag items by user star rating in Plex (0-10 scale).
					</p>
				</div>
			);
		case "plex_watched_by":
			return (
				<div className="space-y-2">
					<label className="block">
						<span className={labelClass}>Operator</span>
						<select
							value={plexWatchedByOp}
							onChange={(e) => setPlexWatchedByOp(e.target.value)}
							className={inputClass}
						>
							<option value="includes_any">Watched by any of</option>
							<option value="excludes_all">Not watched by any of</option>
						</select>
					</label>
					<MultiSelectField
						label="Plex Users"
						options={fieldOptions?.plexUsers ?? []}
						selected={selectedPlexUsers}
						onChange={setSelectedPlexUsers}
						loading={fieldOptionsLoading}
						inputClass={inputClass}
						labelClass={labelClass}
					/>
					<p className="text-xs text-muted-foreground">
						Flag items based on which Plex users have watched them.
					</p>
				</div>
			);

		// ── Phase C: New Rule Types ──────────────────────────────────
		case "imdb_rating":
			return (
				<div className="flex gap-2">
					<label className="block flex-1">
						<span className={labelClass}>Operator</span>
						<select
							value={imdbRatingOp}
							onChange={(e) => setImdbRatingOp(e.target.value)}
							className={inputClass}
						>
							<option value="less_than">Less than</option>
							<option value="greater_than">Greater than</option>
							<option value="unrated">Unrated</option>
						</select>
					</label>
					{imdbRatingOp !== "unrated" && (
						<label className="block w-24">
							<span className={labelClass}>IMDb Score</span>
							<input
								type="number"
								value={imdbRatingScore}
								onChange={(e) => setImdbRatingScore(Number(e.target.value))}
								min={0}
								max={10}
								step={0.1}
								className={inputClass}
							/>
						</label>
					)}
				</div>
			);
		case "file_path":
			return (
				<div className="space-y-2">
					<label className="block">
						<span className={labelClass}>Operator</span>
						<select
							value={filePathOp}
							onChange={(e) => setFilePathOp(e.target.value)}
							className={inputClass}
						>
							<option value="matches">Matches</option>
							<option value="not_matches">Does not match</option>
						</select>
					</label>
					<label className="block">
						<span className={labelClass}>Field</span>
						<select
							value={filePathField}
							onChange={(e) => setFilePathField(e.target.value)}
							className={inputClass}
						>
							<option value="path">File Path</option>
							<option value="rootFolderPath">Root Folder Path</option>
						</select>
					</label>
					<label className="block">
						<span className={labelClass}>Regex Pattern</span>
						<input
							type="text"
							value={filePathPattern}
							onChange={(e) => setFilePathPattern(e.target.value)}
							placeholder="/mnt/data/movies"
							className={inputClass}
						/>
					</label>
				</div>
			);
		case "seerr_is_requested":
			return (
				<div className="space-y-2">
					<label className="flex items-center gap-2 text-sm">
						<input
							type="checkbox"
							checked={seerrIsRequested}
							onChange={(e) => setSeerrIsRequested(e.target.checked)}
						/>
						Has a Seerr request
					</label>
					<p className="text-xs text-muted-foreground">
						{seerrIsRequested
							? "Matches items that have at least one Seerr request."
							: "Matches items that have no Seerr request."}
					</p>
				</div>
			);
		case "seerr_request_count":
			return (
				<div className="flex gap-2">
					<label className="block flex-1">
						<span className={labelClass}>Operator</span>
						<select
							value={seerrRequestCountOp}
							onChange={(e) => setSeerrRequestCountOp(e.target.value)}
							className={inputClass}
						>
							<option value="less_than">Less than</option>
							<option value="greater_than">Greater than</option>
							<option value="equals">Equals</option>
						</select>
					</label>
					<label className="block w-24">
						<span className={labelClass}>Count</span>
						<input
							type="number"
							value={seerrRequestCountVal}
							onChange={(e) => setSeerrRequestCountVal(Number(e.target.value))}
							min={0}
							className={inputClass}
						/>
					</label>
				</div>
			);
		case "audio_channels":
			return (
				<div className="flex gap-2">
					<label className="block flex-1">
						<span className={labelClass}>Operator</span>
						<select
							value={audioChannelsOp}
							onChange={(e) => setAudioChannelsOp(e.target.value)}
							className={inputClass}
						>
							<option value="is">Is</option>
							<option value="is_not">Is not</option>
							<option value="greater_than">Greater than</option>
							<option value="less_than">Less than</option>
						</select>
					</label>
					<label className="block w-24">
						<span className={labelClass}>Channels</span>
						<input
							type="number"
							value={audioChannelsVal}
							onChange={(e) => setAudioChannelsVal(Number(e.target.value))}
							min={1}
							className={inputClass}
						/>
					</label>
				</div>
			);
		case "tag_match":
			return (
				<TagMatchFields
					tagMatchOp={tagMatchOp}
					setTagMatchOp={setTagMatchOp}
					selectedTagIds={selectedTagIds}
					setSelectedTagIds={setSelectedTagIds}
					fieldOptions={fieldOptions}
					inputClass={inputClass}
					labelClass={labelClass}
				/>
			);

		// ── Phase D: Plex Collections & Labels ───────────────────────
		case "plex_collection":
			return (
				<div className="space-y-2">
					<label className="block">
						<span className={labelClass}>Operator</span>
						<select
							value={plexCollectionOp}
							onChange={(e) => setPlexCollectionOp(e.target.value)}
							className={inputClass}
						>
							<option value="in">In collection</option>
							<option value="not_in">Not in collection</option>
						</select>
					</label>
					<MultiSelectField
						label="Plex Collections"
						options={fieldOptions?.plexCollections ?? []}
						selected={selectedPlexCollections}
						onChange={setSelectedPlexCollections}
						loading={fieldOptionsLoading}
						inputClass={inputClass}
						labelClass={labelClass}
					/>
				</div>
			);
		case "plex_label":
			return (
				<div className="space-y-2">
					<label className="block">
						<span className={labelClass}>Operator</span>
						<select
							value={plexLabelOp}
							onChange={(e) => setPlexLabelOp(e.target.value)}
							className={inputClass}
						>
							<option value="has_any">Has any of</option>
							<option value="has_none">Has none of</option>
						</select>
					</label>
					<MultiSelectField
						label="Plex Labels"
						options={fieldOptions?.plexLabels ?? []}
						selected={selectedPlexLabels}
						onChange={setSelectedPlexLabels}
						loading={fieldOptionsLoading}
						inputClass={inputClass}
						labelClass={labelClass}
					/>
				</div>
			);

		// Phase E: Plex added_at
		case "plex_added_at":
			return (
				<div className="flex gap-2">
					<label className="block flex-1">
						<span className={labelClass}>Operator</span>
						<select
							value={plexAddedAtOp}
							onChange={(e) => setPlexAddedAtOp(e.target.value)}
							className={inputClass}
						>
							<option value="older_than">Added more than</option>
							<option value="newer_than">Added within last</option>
						</select>
					</label>
					<label className="block w-24">
						<span className={labelClass}>Days</span>
						<input
							type="number"
							value={plexAddedAtDays}
							onChange={(e) => setPlexAddedAtDays(Number(e.target.value))}
							min={1}
							className={inputClass}
						/>
					</label>
				</div>
			);

		// Phase 2/3: Behavior analysis — delegate to ConditionParamsFields
		case "plex_episode_completion":
		case "user_retention":
		case "staleness_score":
		case "recently_active":
			return (
				<ConditionParamsFields
					ruleType={ruleType}
					params={behaviorParams}
					onParamsChange={setBehaviorParams}
					fieldOptions={fieldOptions}
					fieldOptionsLoading={fieldOptionsLoading}
					inputClass={inputClass}
					labelClass={labelClass}
				/>
			);

		default:
			return null;
	}
}

// ============================================================================
// Tag Match Fields (shared by ParamsFields)
// ============================================================================

function TagMatchFields({
	tagMatchOp,
	setTagMatchOp,
	selectedTagIds,
	setSelectedTagIds,
	fieldOptions,
	inputClass,
	labelClass,
}: {
	tagMatchOp: string;
	setTagMatchOp: (v: string) => void;
	selectedTagIds: number[];
	setSelectedTagIds: (v: number[]) => void;
	fieldOptions: CleanupFieldOptionsResponse | undefined;
	inputClass: string;
	labelClass: string;
}) {
	const { gradient } = useThemeGradient();
	const tags = fieldOptions?.arrTags ?? [];

	const toggleTag = (id: number) => {
		setSelectedTagIds(
			selectedTagIds.includes(id)
				? selectedTagIds.filter((t) => t !== id)
				: [...selectedTagIds, id],
		);
	};

	return (
		<div className="space-y-2">
			<label className="block">
				<span className={labelClass}>Operator</span>
				<select
					value={tagMatchOp}
					onChange={(e) => setTagMatchOp(e.target.value)}
					className={inputClass}
				>
					<option value="includes_any">Includes any of</option>
					<option value="excludes_all">Excludes all of</option>
				</select>
			</label>
			{tags.length > 0 ? (
				<div>
					<span className={labelClass}>Tags</span>
					<div className="flex flex-wrap gap-1.5 mt-1.5">
						{tags.map((tag) => {
							const isSelected = selectedTagIds.includes(tag.id);
							return (
								<button
									key={tag.id}
									type="button"
									onClick={() => toggleTag(tag.id)}
									className="rounded-lg border px-2.5 py-1 text-xs font-medium transition-all duration-200"
									style={
										isSelected
											? {
													borderColor: gradient.from,
													backgroundColor: gradient.fromLight,
													color: gradient.from,
												}
											: { borderColor: "var(--color-border)" }
									}
								>
									{tag.label}
								</button>
							);
						})}
					</div>
				</div>
			) : (
				<label className="block">
					<span className={labelClass}>Tag IDs (comma-separated)</span>
					<input
						type="text"
						value={selectedTagIds.join(", ")}
						onChange={(e) =>
							setSelectedTagIds(
								e.target.value
									.split(",")
									.map((s) => Number(s.trim()))
									.filter((n) => !Number.isNaN(n) && n > 0),
							)
						}
						placeholder="1, 5, 12"
						className={inputClass}
					/>
				</label>
			)}
		</div>
	);
}

// ============================================================================
// Exclude Tags Picker
// ============================================================================

function ExcludeTagsPicker({
	excludeTags,
	setExcludeTags,
	fieldOptions,
	inputClass,
	labelClass,
}: {
	excludeTags: number[];
	setExcludeTags: (v: number[]) => void;
	fieldOptions: CleanupFieldOptionsResponse | undefined;
	inputClass: string;
	labelClass: string;
}) {
	const { gradient } = useThemeGradient();
	const tags = fieldOptions?.arrTags ?? [];

	const toggleTag = (id: number) => {
		setExcludeTags(
			excludeTags.includes(id) ? excludeTags.filter((t) => t !== id) : [...excludeTags, id],
		);
	};

	if (tags.length === 0) {
		return (
			<label className="block">
				<span className={labelClass}>Exclude Tag IDs (comma-separated)</span>
				<input
					type="text"
					value={excludeTags.join(", ")}
					onChange={(e) =>
						setExcludeTags(
							e.target.value
								.split(",")
								.map((s) => Number(s.trim()))
								.filter((n) => !Number.isNaN(n) && n > 0),
						)
					}
					placeholder="e.g., 1, 5, 12"
					className={inputClass}
				/>
			</label>
		);
	}

	return (
		<div>
			<span className={labelClass}>Exclude Tags</span>
			<div className="flex flex-wrap gap-1.5 mt-1.5">
				{tags.map((tag) => {
					const isSelected = excludeTags.includes(tag.id);
					return (
						<button
							key={tag.id}
							type="button"
							onClick={() => toggleTag(tag.id)}
							aria-pressed={isSelected}
							className="rounded-lg border px-2.5 py-1 text-xs font-medium transition-all duration-200"
							style={
								isSelected
									? {
											borderColor: gradient.from,
											backgroundColor: gradient.fromLight,
											color: gradient.from,
										}
									: { borderColor: "var(--color-border)" }
							}
						>
							{tag.label}
						</button>
					);
				})}
			</div>
		</div>
	);
}

// ============================================================================
// Helpers
// ============================================================================

function splitCsv(value: string): string[] {
	return value
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean);
}
