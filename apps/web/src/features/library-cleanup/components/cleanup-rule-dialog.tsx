"use client";

import type { CleanupRuleResponse, CleanupRuleType, CreateCleanupRule } from "@arr/shared";
import { ChevronDown, Loader2, Save, ShieldOff, SlidersHorizontal, Target } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
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
import {
	ConditionParamsFields,
	getDefaultConditionParams,
} from "../../rule-criteria/components/condition-params-fields";
import { MultiSelectField } from "../../rule-criteria/components/multi-select-field";
import {
	type BuildParamsState,
	buildParams as buildParamsPure,
	splitCsv,
} from "../lib/rule-dialog-logic";
import { ExcludeTagsPicker, ParamsFields } from "./cleanup-rule-params-fields";
import { RULE_CATEGORIES, RULE_TYPE_MAP, RULE_TYPES } from "./rule-type-catalog";

// ============================================================================
// Types
// ============================================================================

interface CleanupRuleDialogProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	/** When set, dialog is in edit mode pre-populated with this rule */
	editRule?: CleanupRuleResponse | null;
	/** When set, dialog is in create mode pre-populated from a template */
	templateData?: CreateCleanupRule | null;
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
	templateData,
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
	const hasSeerr = useMemo(
		() => (allServices ?? []).some((s) => s.service === "seerr"),
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

	// ── Jellyfin params ─────────────────────────────────────────────
	const [jellyfinLastWatchedOp, setJellyfinLastWatchedOp] = useState("older_than");
	const [jellyfinLastWatchedDays, setJellyfinLastWatchedDays] = useState(90);
	const [jellyfinWatchCountOp, setJellyfinWatchCountOp] = useState("less_than");
	const [jellyfinWatchCountVal, setJellyfinWatchCountVal] = useState(1);
	const [jellyfinOnDeckVal, setJellyfinOnDeckVal] = useState(false);
	const [jellyfinUserRatingOp, setJellyfinUserRatingOp] = useState("less_than");
	const [jellyfinUserRatingVal, setJellyfinUserRatingVal] = useState(5);
	const [jellyfinWatchedByOp, setJellyfinWatchedByOp] = useState("includes_any");
	const [selectedJellyfinUsers, setSelectedJellyfinUsers] = useState<string[]>([]);
	const [jellyfinAddedAtOp, setJellyfinAddedAtOp] = useState("older_than");
	const [jellyfinAddedAtDays, setJellyfinAddedAtDays] = useState(90);

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
	// List membership params (C3)
	const [tmdbListId, setTmdbListId] = useState("");
	const [tmdbListOp, setTmdbListOp] = useState("is_in");
	const [traktListSlug, setTraktListSlug] = useState("");
	const [traktListOp, setTraktListOp] = useState("is_in");
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
	const [targetScope, setTargetScope] = useState<"series" | "episode">("series");

	// ── Rejection-memory override (issue #474) ────────────────────
	// When `useGlobalRejectionMemory` is true the rule inherits the config
	// default; when false, this rule's own value applies. Encoding mirrors
	// the config: 0 = off, N>0 = days, null = forever.
	const [useGlobalRejectionMemory, setUseGlobalRejectionMemory] = useState(true);
	const [rejectionMode, setRejectionMode] = useState<"off" | "days" | "forever">("off");
	const [rejectionDays, setRejectionDays] = useState("30");

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
			setTargetScope(editRule.targetScope);
			setName(editRule.name);
			setRuleType(editRule.ruleType);
			setEnabled(editRule.enabled);
			setAction((editRule.action as "delete" | "unmonitor" | "delete_files") ?? "delete");
			setRetentionMode(editRule.retentionMode ?? false);
			setUseGlobalRejectionMemory(editRule.useGlobalRejectionMemory ?? true);
			setRejectionMode(
				editRule.rejectionMemoryDays === null
					? "forever"
					: editRule.rejectionMemoryDays === 0 || editRule.rejectionMemoryDays === undefined
						? "off"
						: "days",
			);
			if (editRule.rejectionMemoryDays && editRule.rejectionMemoryDays > 0) {
				setRejectionDays(String(editRule.rejectionMemoryDays));
			}
			// Composite mode
			if (editRule.operator && editRule.conditions) {
				setIsComposite(true);
				setCompositeOperator(editRule.operator as "AND" | "OR");
				setConditions(
					(
						editRule.conditions as Array<{
							ruleType: CleanupRuleType;
							parameters: Record<string, unknown>;
						}>
					).map((c, i) => ({ id: `cond-${i}`, ruleType: c.ruleType, params: c.parameters ?? {} })),
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
				case "tmdb_list_member":
					setTmdbListId((p.listId as string) ?? "");
					setTmdbListOp((p.operator as string) ?? "is_in");
					break;
				case "trakt_list_member":
					setTraktListSlug((p.listSlug as string) ?? "");
					setTraktListOp((p.operator as string) ?? "is_in");
					break;
				// Phase D: Plex collections & labels
				case "plex_collection":
					setPlexCollectionOp((p.operator as string) ?? "in");
					setSelectedPlexCollections(
						Array.isArray(p.collections) ? (p.collections as string[]) : [],
					);
					break;
				case "plex_label":
					setPlexLabelOp((p.operator as string) ?? "has_any");
					setSelectedPlexLabels(Array.isArray(p.labels) ? (p.labels as string[]) : []);
					break;
				case "plex_added_at":
					setPlexAddedAtOp((p.operator as string) ?? "older_than");
					setPlexAddedAtDays((p.days as number) ?? 90);
					break;
				// Jellyfin rules
				case "jellyfin_last_watched":
					setJellyfinLastWatchedOp((p.operator as string) ?? "older_than");
					setJellyfinLastWatchedDays((p.days as number) ?? 90);
					break;
				case "jellyfin_watch_count":
					setJellyfinWatchCountOp((p.operator as string) ?? "less_than");
					setJellyfinWatchCountVal((p.count as number) ?? 1);
					break;
				case "jellyfin_on_deck":
					setJellyfinOnDeckVal((p.isDeck as boolean) ?? false);
					break;
				case "jellyfin_user_rating":
					setJellyfinUserRatingOp((p.operator as string) ?? "less_than");
					setJellyfinUserRatingVal((p.rating as number) ?? 5);
					break;
				case "jellyfin_watched_by":
					setJellyfinWatchedByOp((p.operator as string) ?? "includes_any");
					setSelectedJellyfinUsers(Array.isArray(p.userNames) ? (p.userNames as string[]) : []);
					break;
				case "jellyfin_added_at":
					setJellyfinAddedAtOp((p.operator as string) ?? "older_than");
					setJellyfinAddedAtDays((p.days as number) ?? 90);
					break;
				// Phase 2/3: Behavior analysis (delegate to behaviorParams)
				case "plex_episode_completion":
				case "jellyfin_episode_completion":
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
			setTargetScope("series");
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
			// Jellyfin defaults
			setJellyfinLastWatchedOp("older_than");
			setJellyfinLastWatchedDays(90);
			setJellyfinWatchCountOp("less_than");
			setJellyfinWatchCountVal(1);
			setJellyfinOnDeckVal(false);
			setJellyfinUserRatingOp("less_than");
			setJellyfinUserRatingVal(5);
			setJellyfinWatchedByOp("includes_any");
			setSelectedJellyfinUsers([]);
			setJellyfinAddedAtOp("older_than");
			setJellyfinAddedAtDays(90);
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
			setTmdbListId("");
			setTmdbListOp("is_in");
			setTraktListSlug("");
			setTraktListOp("is_in");
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

			// Overlay template data on top of defaults (create mode only)
			if (templateData) {
				setTargetScope(templateData.targetScope);
				setName(templateData.name);
				setAction((templateData.action as "delete" | "unmonitor" | "delete_files") ?? "delete");
				setRetentionMode(templateData.retentionMode ?? false);
				if (templateData.serviceFilter) {
					setServiceFilter(templateData.serviceFilter);
				}
				if (templateData.operator && templateData.conditions) {
					// Composite template
					setIsComposite(true);
					setCompositeOperator(templateData.operator as "AND" | "OR");
					setRuleType("composite");
					setConditions(
						templateData.conditions.map((c, i) => ({
							id: `tpl-${i}`,
							ruleType: c.ruleType,
							params: c.parameters ?? {},
						})),
					);
				} else if (templateData.ruleType && templateData.ruleType !== "composite") {
					// Single-rule template
					setRuleType(templateData.ruleType);
					const activeCat = RULE_CATEGORIES.find((c) => c.types.includes(templateData.ruleType));
					if (activeCat) {
						setExpandedCategories(new Set([activeCat.id]));
					}
					const p = templateData.parameters ?? {};
					switch (templateData.ruleType) {
						case "staleness_score":
						case "plex_episode_completion":
						case "jellyfin_episode_completion":
						case "user_retention":
						case "recently_active":
							setBehaviorParams(p);
							break;
					}
				}
			}
		}
	}, [open, editRule, templateData]);

	// ── Build parameters (delegates to extracted pure function) ─────
	const buildParamsState: BuildParamsState = {
		ruleType,
		ageOp,
		days,
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
		selectedVideoCodecs,
		audioCodecOp,
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
		tmdbListId,
		tmdbListOp,
		traktListSlug,
		traktListOp,
		plexCollectionOp,
		selectedPlexCollections,
		plexLabelOp,
		selectedPlexLabels,
		plexAddedAtOp,
		plexAddedAtDays,
		jellyfinLastWatchedOp,
		jellyfinLastWatchedDays,
		jellyfinWatchCountOp,
		jellyfinWatchCountVal,
		jellyfinOnDeckVal,
		jellyfinUserRatingOp,
		jellyfinUserRatingVal,
		jellyfinWatchedByOp,
		selectedJellyfinUsers,
		jellyfinAddedAtOp,
		jellyfinAddedAtDays,
		behaviorParams,
	};
	const buildParams = () => buildParamsPure(buildParamsState);
	const effectiveRuleType: CleanupRuleType =
		targetScope === "episode" ? "plex_watch_count" : ruleType;
	const visibleArrInstances =
		targetScope === "episode"
			? arrInstances.filter((instance) => instance.service === "sonarr")
			: arrInstances;

	const selectTargetScope = (scope: "series" | "episode") => {
		if (isEdit || scope === targetScope) return;
		setTargetScope(scope);
		if (scope === "episode") {
			setRuleType("plex_watch_count");
			setPlexWatchCountOp("greater_than");
			setServiceFilter(["sonarr"]);
			setInstanceFilter((current) =>
				current.filter((id) =>
					arrInstances.some((instance) => instance.id === id && instance.service === "sonarr"),
				),
			);
			setSelectedPlexLibraries([]);
			setIsComposite(false);
			setConditions([]);
			setCompositeError(null);
			setRetentionMode(false);
			setExpandedCategories(new Set(["plex"]));
		}
	};

	const handleSubmit = (e: React.FormEvent) => {
		e.preventDefault();
		const isEpisodeScope = targetScope === "episode";
		if (!isEpisodeScope && isComposite && conditions.length === 0) {
			setCompositeError("Composite rules must have at least one condition");
			return;
		}
		// Validate composite conditions have required fields filled in
		if (!isEpisodeScope && isComposite) {
			for (const cond of conditions) {
				const p = cond.params;
				if (
					(cond.ruleType === "seerr_requested_by" ||
						cond.ruleType === "plex_watched_by" ||
						cond.ruleType === "seerr_modified_by") &&
					Array.isArray(p.userNames) &&
					p.userNames.length === 0
				) {
					setCompositeError(
						"Each condition that targets users must have at least one username selected.",
					);
					return;
				}
			}
		}
		setCompositeError(null);
		// Issue #474: encode the per-rule rejection-memory choice. Same scheme
		// as the config: 0 = off, N>0 = days, null = forever. Only sent when
		// the override toggle is on; otherwise the rule inherits the config.
		const ruleRejectionDays =
			rejectionMode === "forever"
				? null
				: rejectionMode === "days"
					? Math.max(1, Math.min(36500, Number(rejectionDays) || 30))
					: 0;
		const effectiveInstanceFilter = isEpisodeScope
			? instanceFilter.filter((id) =>
					arrInstances.some((instance) => instance.id === id && instance.service === "sonarr"),
				)
			: instanceFilter;
		const base: CreateCleanupRule = {
			name,
			targetScope,
			ruleType: isEpisodeScope
				? ("plex_watch_count" as const)
				: isComposite
					? ("composite" as const)
					: ruleType,
			enabled,
			priority: editRule?.priority ?? 0,
			parameters: isEpisodeScope
				? { operator: "greater_than", count: plexWatchCountVal }
				: isComposite
					? {}
					: buildParams(),
			action,
			retentionMode: isEpisodeScope ? false : retentionMode,
			useGlobalRejectionMemory,
			// When override is off, omit `rejectionMemoryDays` from the payload
			// entirely. The PATCH route's `!== undefined` discipline preserves
			// the stored value, so toggling override off→on later won't have
			// silently zeroed the user's prior days/forever choice. On create
			// the route defaults `undefined` to `0`, which is the right
			// pre-#474 behavior when override is off.
			...(useGlobalRejectionMemory ? {} : { rejectionMemoryDays: ruleRejectionDays }),
			serviceFilter: isEpisodeScope ? ["sonarr"] : serviceFilter.length > 0 ? serviceFilter : null,
			instanceFilter: effectiveInstanceFilter.length > 0 ? effectiveInstanceFilter : null,
			excludeTags: excludeTags.length > 0 ? excludeTags : null,
			excludeTitles: excludeTitles.trim() ? splitCsv(excludeTitles) : null,
			plexLibraryFilter:
				!isEpisodeScope && selectedPlexLibraries.length > 0 ? selectedPlexLibraries : null,
			operator: !isEpisodeScope && isComposite ? compositeOperator : null,
			conditions:
				!isEpisodeScope && isComposite
					? conditions
							.filter((c) => c.ruleType !== "composite")
							.map((c) => ({
								ruleType: c.ruleType as Exclude<CleanupRuleType, "composite">,
								parameters: c.params,
							}))
					: null,
		};
		onSave(base);
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

				{!isEdit && templateData && (
					<div className="rounded-lg border border-blue-500/20 bg-blue-500/10 px-3 py-2 text-xs text-blue-400">
						{templateData.conditions?.some((c) => "userNames" in (c.parameters ?? {}))
							? "Template applied. Fill in the usernames in each condition below, then save."
							: "Template applied. Review the settings below and save when ready."}
					</div>
				)}

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

						<div>
							<span className={labelClass}>Target</span>
							<div className="mt-1.5 grid grid-cols-2 gap-2">
								{(["series", "episode"] as const).map((scope) => (
									<button
										key={scope}
										type="button"
										onClick={() => selectTargetScope(scope)}
										disabled={isEdit}
										aria-pressed={targetScope === scope}
										title={
											isEdit ? "Target scope cannot be changed while editing a rule" : undefined
										}
										className="rounded-lg border px-3 py-2 text-left text-sm font-medium transition-all disabled:cursor-not-allowed disabled:opacity-60"
										style={
											targetScope === scope
												? {
														borderColor: gradient.from,
														backgroundColor: gradient.fromLight,
														color: gradient.from,
													}
												: { borderColor: "var(--color-border)" }
										}
									>
										{scope === "series" ? "Series" : "Episodes"}
									</button>
								))}
							</div>
							{isEdit && (
								<p className="mt-2 text-xs text-muted-foreground">
									Target scope cannot be changed while editing. Create a new rule to use a different
									scope.
								</p>
							)}
							<p className="mt-1 text-xs text-muted-foreground">
								{targetScope === "episode"
									? "Episode cleanup is a Sonarr-only workflow using Plex watch count."
									: "Plex totals and destructive actions apply to the full series and its episode files."}
							</p>
						</div>

						{/* ── Retention Mode toggle ────────────────── */}
						{targetScope === "series" && (
							<div className="flex items-center justify-between">
								<div className="flex items-center gap-2">
									<ShieldOff className="h-4 w-4 text-emerald-400" />
									<div>
										<span className="text-sm font-medium">Retention Rule</span>
										<p className="text-xs text-muted-foreground">
											Protects matching items from other rules
										</p>
									</div>
								</div>
								<Switch
									checked={retentionMode}
									onCheckedChange={setRetentionMode}
									style={retentionMode ? { backgroundColor: "rgb(16 185 129)" } : undefined}
								/>
							</div>
						)}

						{/* ── Rejection-memory override (issue #474) ───── */}
						<div className="space-y-2">
							<div className="flex items-center justify-between">
								<div>
									<span className="text-sm font-medium">Override rejection memory</span>
									<p className="text-xs text-muted-foreground">
										Uses the cleanup-config default unless overridden here (#474).
									</p>
								</div>
								<Switch
									checked={!useGlobalRejectionMemory}
									onCheckedChange={(v) => setUseGlobalRejectionMemory(!v)}
								/>
							</div>
							{!useGlobalRejectionMemory && (
								<div className="grid gap-2 sm:grid-cols-2 pl-1">
									<label className="block">
										<span className="text-xs text-muted-foreground block mb-1">
											Memory mode (this rule)
										</span>
										<select
											value={rejectionMode}
											onChange={(e) =>
												setRejectionMode(e.target.value as "off" | "days" | "forever")
											}
											className="w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm"
										>
											<option value="off">Off — re-propose rejected items</option>
											<option value="days">Remember for N days</option>
											<option value="forever">Remember forever</option>
										</select>
									</label>
									{rejectionMode === "days" && (
										<label className="block">
											<span className="text-xs text-muted-foreground block mb-1">Days</span>
											<input
												type="number"
												value={rejectionDays}
												onChange={(e) => setRejectionDays(e.target.value)}
												min={1}
												max={36500}
												className="w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm"
											/>
										</label>
									)}
								</div>
							)}
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
								{targetScope === "episode"
									? action === "delete"
										? "Unmonitor the exact Sonarr episode, then delete its verified episode file. The series and other episodes remain."
										: action === "unmonitor"
											? "Unmonitor only the exact Sonarr episode and keep its file."
											: "Delete only the exact verified episode file. The episode remains monitored, so Sonarr may download it again."
									: action === "delete"
										? "Remove the item and its verified media files from the ARR instance. For Plex library updates, arr-dashboard applies the ARR connection's path mapping and matches exact live paths and sizes. Unverifiable media-server updates are blocked."
										: action === "unmonitor"
											? "Set the item as unmonitored (keeps files and data)."
											: "Delete verified media files but keep the item in the ARR library. Exact live Plex matching blocks merged or unverifiable items, and other unverified media-server updates are blocked."}
							</p>
						</div>

						{/* ── Rule Mode toggle ──────────────────────── */}
						{targetScope === "series" && (
							<div>
								<span className={labelClass}>Rule Mode</span>
								<div className="flex gap-2 mt-1.5">
									<button
										type="button"
										onClick={() => {
											setIsComposite(false);
											setConditions([]);
											setCompositeError(null);
										}}
										className="rounded-lg border px-3 py-1.5 text-sm font-medium transition-all duration-200"
										style={
											!isComposite
												? {
														borderColor: gradient.from,
														backgroundColor: gradient.fromLight,
														color: gradient.from,
													}
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
												? {
														borderColor: gradient.from,
														backgroundColor: gradient.fromLight,
														color: gradient.from,
													}
												: { borderColor: "var(--color-border)" }
										}
									>
										Composite Rule
									</button>
								</div>
							</div>
						)}

						{/* ── Rule Type Picker / Composite Builder ─── */}
						{targetScope === "episode" ? (
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
									Plex Watch Count
								</span>
								<span className="text-xs text-muted-foreground">
									Only Plex Watch Count is supported for episode targets.
								</span>
							</div>
						) : isComposite ? (
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
														? {
																borderColor: gradient.from,
																backgroundColor: gradient.fromLight,
																color: gradient.from,
															}
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
									<div
										key={cond.id}
										className="rounded-lg border border-border/50 bg-card/20 p-3 space-y-2"
									>
										<div className="flex items-center justify-between">
											<span className="text-xs font-medium text-muted-foreground">
												Condition {idx + 1}
											</span>
											<button
												type="button"
												onClick={() =>
													setConditions((prev) => prev.filter((c) => c.id !== cond.id))
												}
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
														c.id === cond.id
															? {
																	...c,
																	ruleType: newType,
																	params: getDefaultConditionParams(newType),
																}
															: c,
													),
												);
											}}
											className={inputClass}
										>
											{RULE_TYPES.filter((rt) => rt.value !== "composite").map((rt) => (
												<option key={rt.value} value={rt.value}>
													{rt.label}
												</option>
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
													prev.map((c) => (c.id === cond.id ? { ...c, params: newParams } : c)),
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
											{
												id: `cond-${Date.now()}`,
												ruleType: "age" as CleanupRuleType,
												params: getDefaultConditionParams("age"),
											},
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
										if (cat.requires === "jellyfin" && !fieldOptions?.hasJellyfin) return false;
										if (cat.requires === "plex+seerr" && (!fieldOptions?.hasPlex || !hasSeerr))
											return false;
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
													<CatIcon className="h-4 w-4 shrink-0" style={{ color: gradient.from }} />
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
																	onClick={() => setRuleType(typeValue as CleanupRuleType)}
																	className={`text-left rounded-lg border px-2.5 py-2 transition-all duration-200 ${
																		isSelected ? "" : "border-border/30 hover:border-border/60"
																	}`}
																	style={
																		isSelected
																			? {
																					borderColor: gradient.from,
																					backgroundColor: gradient.fromLight,
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
																			isSelected ? "opacity-80" : "text-muted-foreground"
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
					{(targetScope === "episode" || !isComposite) && (
						<div className="rounded-xl border border-border/50 bg-card/30 backdrop-blur-sm p-4 space-y-3">
							<div className="flex items-center gap-2 mb-2">
								<SlidersHorizontal className="h-4 w-4" style={{ color: gradient.from }} />
								<span className="text-sm font-medium">Parameters</span>
							</div>
							<ParamsFields
								model={{
									ruleType: effectiveRuleType,
									targetScope,
									criteria: {
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
										audioChannelsOp,
										setAudioChannelsOp,
										audioChannelsVal,
										setAudioChannelsVal,
										tagMatchOp,
										setTagMatchOp,
										selectedTagIds,
										setSelectedTagIds,
										selectedPlexCollections,
										setSelectedPlexCollections,
										selectedPlexLabels,
										setSelectedPlexLabels,
										selectedJellyfinUsers,
										setSelectedJellyfinUsers,
									},
									seerr: {
										seerrUserNames,
										setSeerrUserNames,
										seerrReqAgeOp,
										setSeerrReqAgeOp,
										seerrReqAgeDays,
										setSeerrReqAgeDays,
										seerrReqStatuses,
										setSeerrReqStatuses,
										seerrIs4k,
										setSeerrIs4k,
										seerrModifiedAgeOp,
										setSeerrModifiedAgeOp,
										seerrModifiedAgeDays,
										setSeerrModifiedAgeDays,
										seerrModifiedByUsers,
										setSeerrModifiedByUsers,
										seerrIsRequested,
										setSeerrIsRequested,
										seerrRequestCountOp,
										setSeerrRequestCountOp,
										seerrRequestCountVal,
										setSeerrRequestCountVal,
									},
									plex: {
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
										plexCollectionOp,
										setPlexCollectionOp,
										plexLabelOp,
										setPlexLabelOp,
										plexAddedAtOp,
										setPlexAddedAtOp,
										plexAddedAtDays,
										setPlexAddedAtDays,
									},
									jellyfin: {
										jellyfinLastWatchedOp,
										setJellyfinLastWatchedOp,
										jellyfinLastWatchedDays,
										setJellyfinLastWatchedDays,
										jellyfinWatchCountOp,
										setJellyfinWatchCountOp,
										jellyfinWatchCountVal,
										setJellyfinWatchCountVal,
										jellyfinOnDeckVal,
										setJellyfinOnDeckVal,
										jellyfinUserRatingOp,
										setJellyfinUserRatingOp,
										jellyfinUserRatingVal,
										setJellyfinUserRatingVal,
										jellyfinWatchedByOp,
										setJellyfinWatchedByOp,
										jellyfinAddedAtOp,
										setJellyfinAddedAtOp,
										jellyfinAddedAtDays,
										setJellyfinAddedAtDays,
									},
									lists: {
										tmdbListId,
										setTmdbListId,
										tmdbListOp,
										setTmdbListOp,
										traktListSlug,
										setTraktListSlug,
										traktListOp,
										setTraktListOp,
									},
									behavior: {
										behaviorParams,
										setBehaviorParams,
									},
									presentation: {
										fieldOptions,
										fieldOptionsLoading,
										inputClass,
										labelClass,
									},
								}}
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
								{(targetScope === "episode"
									? (["sonarr"] as const)
									: (["sonarr", "radarr"] as const)
								).map((svc) => {
									const svcGradient = getServiceGradient(svc);
									const isActive = targetScope === "episode" || serviceFilter.includes(svc);
									return (
										<button
											key={svc}
											type="button"
											onClick={() => targetScope === "series" && toggleService(svc)}
											aria-pressed={isActive}
											aria-label={`Filter by ${svc}`}
											className="rounded-lg border px-3 py-1.5 text-sm font-medium capitalize transition-all duration-200"
											style={
												isActive
													? {
															borderColor: svcGradient.from,
															backgroundColor: svcGradient.from,
															// eslint-disable-next-line no-restricted-syntax -- white-on-accent chip text (B2 carve-out: not semantic)
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
								{targetScope === "episode"
									? "Episode targets always apply to Sonarr."
									: "Leave unselected to apply to all services."}
							</p>
						</div>

						<div>
							<span className={labelClass}>Instance Filter</span>
							{visibleArrInstances.length === 0 ? (
								<p className="text-xs text-muted-foreground mt-1">
									{targetScope === "episode"
										? "No Sonarr instances configured."
										: "No Sonarr/Radarr instances configured."}
								</p>
							) : (
								<div className="mt-1.5 space-y-1.5">
									{(targetScope === "episode" ? ["sonarr"] : ["sonarr", "radarr"]).map((svc) => {
										const instances = visibleArrInstances.filter((i) => i.service === svc);
										if (instances.length === 0) return null;
										return (
											<div key={svc}>
												<span className="text-[10px] uppercase tracking-wider text-muted-foreground/70 font-medium">
													{svc}
												</span>
												<div className="flex flex-wrap gap-2 mt-1">
													{instances.map((inst) => {
														const selected = instanceFilter.includes(inst.id);
														return (
															<button
																key={inst.id}
																type="button"
																onClick={() => {
																	setInstanceFilter((prev) =>
																		selected
																			? prev.filter((id) => id !== inst.id)
																			: [...prev, inst.id],
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
									<p className="text-xs text-muted-foreground mt-1">
										Leave unselected for all instances.
									</p>
								</div>
							)}
						</div>

						{targetScope === "series" &&
							fieldOptions?.plexLibraries &&
							fieldOptions.plexLibraries.length > 0 && (
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
