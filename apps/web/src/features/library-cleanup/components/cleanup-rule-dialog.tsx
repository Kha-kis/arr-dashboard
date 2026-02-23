"use client";

import type {
	CleanupFieldOptionsResponse,
	CleanupRuleResponse,
	CleanupRuleType,
	CreateCleanupRule,
} from "@arr/shared";
import { Loader2, Save } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { useCleanupFieldOptions } from "@/hooks/api/useLibraryCleanup";
import { useThemeGradient } from "@/hooks/useThemeGradient";
import { MultiSelectField } from "./multi-select-field";

// ============================================================================
// Constants
// ============================================================================

const RULE_TYPES: Array<{ value: CleanupRuleType; label: string; desc: string }> = [
	{ value: "age", label: "Age", desc: "Flag items older than N days" },
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
];

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

	// ── Basic fields ────────────────────────────────────────────────
	const [name, setName] = useState("");
	const [ruleType, setRuleType] = useState<CleanupRuleType>("age");
	const [enabled, setEnabled] = useState(true);

	// ── Params (varies by ruleType) ─────────────────────────────────
	const [days, setDays] = useState(180);
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
	const [codecOp, setCodecOp] = useState("is");
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

	// ── Scope / Exclusions ──────────────────────────────────────────
	const [serviceFilter, setServiceFilter] = useState<string[]>([]);
	const [instanceFilter, setInstanceFilter] = useState("");
	const [excludeTags, setExcludeTags] = useState("");
	const [excludeTitles, setExcludeTitles] = useState("");

	// ── Pre-populate on edit ────────────────────────────────────────
	useEffect(() => {
		if (!open) return;
		if (editRule) {
			setName(editRule.name);
			setRuleType(editRule.ruleType);
			setEnabled(editRule.enabled);

			const p = editRule.parameters as Record<string, unknown>;
			switch (editRule.ruleType) {
				case "age":
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
					setCodecOp((p.operator as string) ?? "is");
					setSelectedVideoCodecs(Array.isArray(p.codecs) ? (p.codecs as string[]) : []);
					break;
				case "audio_codec":
					setCodecOp((p.operator as string) ?? "is");
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
			}

			setServiceFilter(editRule.serviceFilter ?? []);
			setInstanceFilter(editRule.instanceFilter ? editRule.instanceFilter.join(", ") : "");
			setExcludeTags(editRule.excludeTags ? editRule.excludeTags.join(", ") : "");
			setExcludeTitles(editRule.excludeTitles ? editRule.excludeTitles.join(", ") : "");
		} else {
			// Reset to defaults for create mode
			setName("");
			setRuleType("age");
			setEnabled(true);
			setDays(180);
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
			setCodecOp("is");
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
			setServiceFilter([]);
			setInstanceFilter("");
			setExcludeTags("");
			setExcludeTitles("");
		}
	}, [open, editRule]);

	// ── Build parameters ────────────────────────────────────────────
	const buildParams = useCallback((): Record<string, unknown> => {
		switch (ruleType) {
			case "age":
				return { field: "arrAddedAt", operator: "older_than", days };
			case "size":
				return { operator: sizeOp, sizeGb };
			case "rating":
				return { source: "tmdb", operator: scoreOp, score };
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
				return { operator: codecOp, codecs: selectedVideoCodecs };
			case "audio_codec":
				return { operator: codecOp, codecs: selectedAudioCodecs };
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
			default:
				return {};
		}
	}, [
		ruleType,
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
		codecOp,
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
	]);

	const handleSubmit = (e: React.FormEvent) => {
		e.preventDefault();
		const data: CreateCleanupRule = {
			name,
			ruleType,
			enabled,
			priority: editRule?.priority ?? 0,
			parameters: buildParams(),
			serviceFilter: serviceFilter.length > 0 ? serviceFilter : null,
			instanceFilter: instanceFilter.trim() ? splitCsv(instanceFilter) : null,
			excludeTags: excludeTags.trim()
				? splitCsv(excludeTags)
						.map(Number)
						.filter((n) => !Number.isNaN(n))
				: null,
			excludeTitles: excludeTitles.trim() ? splitCsv(excludeTitles) : null,
		};
		onSave(data);
	};

	const toggleService = (service: string) => {
		setServiceFilter((prev) =>
			prev.includes(service) ? prev.filter((s) => s !== service) : [...prev, service],
		);
	};

	const inputClass =
		"w-full rounded-md border border-border/50 bg-background/50 px-3 py-1.5 text-sm focus:outline-none";
	const labelClass = "text-xs text-muted-foreground block mb-1";

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="max-w-lg max-h-[85vh] overflow-y-auto">
				<DialogHeader>
					<DialogTitle>{isEdit ? "Edit Rule" : "New Cleanup Rule"}</DialogTitle>
					<DialogDescription>
						{isEdit
							? "Modify the rule settings and click Save."
							: "Configure when items should be flagged for cleanup."}
					</DialogDescription>
				</DialogHeader>

				<form onSubmit={handleSubmit} className="space-y-5 mt-2">
					{/* ── Basic Section ─────────────────────────────── */}
					<div className="space-y-3">
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

						<div className="grid gap-3 sm:grid-cols-2">
							<label className="block">
								<span className={labelClass}>Rule Type</span>
								<select
									value={ruleType}
									onChange={(e) => setRuleType(e.target.value as CleanupRuleType)}
									className={inputClass}
									disabled={isEdit}
								>
									{RULE_TYPES.map((t) => (
										<option key={t.value} value={t.value}>
											{t.label} — {t.desc}
										</option>
									))}
								</select>
							</label>

							<label className="flex items-center gap-2 text-sm self-end pb-1">
								<input
									type="checkbox"
									checked={enabled}
									onChange={(e) => setEnabled(e.target.checked)}
								/>
								Enabled
							</label>
						</div>
					</div>

					{/* ── Parameters Section ───────────────────────── */}
					<fieldset className="rounded-lg border border-border/30 p-3 space-y-3">
						<legend className="text-xs font-medium text-muted-foreground px-2">Parameters</legend>
						<ParamsFields
							ruleType={ruleType}
							days={days}
							setDays={setDays}
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
							codecOp={codecOp}
							setCodecOp={setCodecOp}
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
							fieldOptions={fieldOptions}
							fieldOptionsLoading={fieldOptionsLoading}
							inputClass={inputClass}
							labelClass={labelClass}
						/>
					</fieldset>

					{/* ── Scope Section ─────────────────────────────── */}
					<fieldset className="rounded-lg border border-border/30 p-3 space-y-3">
						<legend className="text-xs font-medium text-muted-foreground px-2">
							Scope (optional)
						</legend>
						<div>
							<span className={labelClass}>Service Filter</span>
							<div className="flex gap-3 mt-1">
								{["sonarr", "radarr"].map((svc) => (
									<label key={svc} className="flex items-center gap-1.5 text-sm capitalize">
										<input
											type="checkbox"
											checked={serviceFilter.includes(svc)}
											onChange={() => toggleService(svc)}
										/>
										{svc}
									</label>
								))}
							</div>
							<p className="text-xs text-muted-foreground mt-1">
								Leave unchecked to apply to all services.
							</p>
						</div>

						<label className="block">
							<span className={labelClass}>Instance IDs (comma-separated)</span>
							<input
								type="text"
								value={instanceFilter}
								onChange={(e) => setInstanceFilter(e.target.value)}
								placeholder="Leave empty for all instances"
								className={inputClass}
							/>
						</label>
					</fieldset>

					{/* ── Exclusions Section ────────────────────────── */}
					<fieldset className="rounded-lg border border-border/30 p-3 space-y-3">
						<legend className="text-xs font-medium text-muted-foreground px-2">
							Exclusions (optional)
						</legend>
						<label className="block">
							<span className={labelClass}>Exclude Tag IDs (comma-separated)</span>
							<input
								type="text"
								value={excludeTags}
								onChange={(e) => setExcludeTags(e.target.value)}
								placeholder="e.g., 1, 5, 12"
								className={inputClass}
							/>
						</label>
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
					</fieldset>

					{/* ── Actions ───────────────────────────────────── */}
					<div className="flex justify-end gap-2 pt-1">
						<button
							type="button"
							onClick={() => onOpenChange(false)}
							className="rounded-md px-4 py-2 text-sm text-muted-foreground hover:text-foreground transition-colors"
						>
							Cancel
						</button>
						<button
							type="submit"
							disabled={!name.trim() || isSaving}
							className="inline-flex items-center rounded-lg px-4 py-2 text-sm font-medium text-white transition-colors disabled:opacity-50"
							style={{ backgroundColor: gradient.from }}
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
	codecOp: string;
	setCodecOp: (v: string) => void;
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
		codecOp,
		setCodecOp,
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
		fieldOptions,
		fieldOptionsLoading,
		inputClass,
		labelClass,
	} = props;
	switch (ruleType) {
		case "age":
			return (
				<label className="block">
					<span className={labelClass}>Older than (days)</span>
					<input
						type="number"
						value={days}
						onChange={(e) => setDays(Number(e.target.value))}
						min={1}
						className={inputClass}
					/>
				</label>
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
						</select>
					</label>
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
							value={codecOp}
							onChange={(e) => setCodecOp(e.target.value)}
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
							value={codecOp}
							onChange={(e) => setCodecOp(e.target.value)}
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

		default:
			return null;
	}
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
