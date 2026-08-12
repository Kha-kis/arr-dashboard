"use client";

import type { CleanupFieldOptionsResponse, CleanupRuleType, CleanupTargetScope } from "@arr/shared";
import { useThemeGradient } from "@/hooks/useThemeGradient";
import { getLinuxUsername, useIncognitoMode } from "../../../lib/incognito";
import { ConditionParamsFields } from "../../rule-criteria/components/condition-params-fields";
import { MultiSelectField } from "../../rule-criteria/components/multi-select-field";

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
	tmdbListId: string;
	setTmdbListId: (v: string) => void;
	tmdbListOp: string;
	setTmdbListOp: (v: string) => void;
	traktListSlug: string;
	setTraktListSlug: (v: string) => void;
	traktListOp: string;
	setTraktListOp: (v: string) => void;
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
	// Jellyfin
	jellyfinLastWatchedOp: string;
	setJellyfinLastWatchedOp: (v: string) => void;
	jellyfinLastWatchedDays: number;
	setJellyfinLastWatchedDays: (v: number) => void;
	jellyfinWatchCountOp: string;
	setJellyfinWatchCountOp: (v: string) => void;
	jellyfinWatchCountVal: number;
	setJellyfinWatchCountVal: (v: number) => void;
	jellyfinOnDeckVal: boolean;
	setJellyfinOnDeckVal: (v: boolean) => void;
	jellyfinUserRatingOp: string;
	setJellyfinUserRatingOp: (v: string) => void;
	jellyfinUserRatingVal: number;
	setJellyfinUserRatingVal: (v: number) => void;
	jellyfinWatchedByOp: string;
	setJellyfinWatchedByOp: (v: string) => void;
	selectedJellyfinUsers: string[];
	setSelectedJellyfinUsers: (v: string[]) => void;
	jellyfinAddedAtOp: string;
	setJellyfinAddedAtOp: (v: string) => void;
	jellyfinAddedAtDays: number;
	setJellyfinAddedAtDays: (v: number) => void;
	// Phase 2/3: Behavior analysis (delegate to ConditionParamsFields)
	behaviorParams: Record<string, unknown>;
	setBehaviorParams: (v: Record<string, unknown>) => void;
	// Field options from library cache
	fieldOptions: CleanupFieldOptionsResponse | undefined;
	fieldOptionsLoading: boolean;
	inputClass: string;
	labelClass: string;
}

type DomainFields<Prefix extends string> = Pick<
	ParamsFieldsProps,
	{
		[K in keyof ParamsFieldsProps]: K extends string
			? K extends `${Prefix}${string}` | `set${Capitalize<Prefix>}${string}`
				? K
				: never
			: never;
	}[keyof ParamsFieldsProps]
>;

type ListFields = Pick<
	ParamsFieldsProps,
	| "tmdbListId"
	| "setTmdbListId"
	| "tmdbListOp"
	| "setTmdbListOp"
	| "traktListSlug"
	| "setTraktListSlug"
	| "traktListOp"
	| "setTraktListOp"
>;
type BehaviorFields = Pick<ParamsFieldsProps, "behaviorParams" | "setBehaviorParams">;
type PresentationFields = Pick<
	ParamsFieldsProps,
	"fieldOptions" | "fieldOptionsLoading" | "inputClass" | "labelClass"
>;
type GroupedFieldKeys =
	| keyof DomainFields<"seerr">
	| keyof DomainFields<"plex">
	| keyof DomainFields<"jellyfin">
	| keyof ListFields
	| keyof BehaviorFields
	| keyof PresentationFields;

export interface ParamsFieldsModel {
	ruleType: CleanupRuleType;
	targetScope: CleanupTargetScope;
	criteria: Omit<ParamsFieldsProps, "ruleType" | GroupedFieldKeys>;
	seerr: DomainFields<"seerr">;
	plex: DomainFields<"plex">;
	jellyfin: DomainFields<"jellyfin">;
	lists: ListFields;
	behavior: BehaviorFields;
	presentation: PresentationFields;
}

export function ParamsFields({ model }: { model: ParamsFieldsModel }) {
	const [incognitoMode] = useIncognitoMode();
	const { targetScope } = model;
	const props: ParamsFieldsProps = {
		ruleType: model.ruleType,
		...model.criteria,
		...model.seerr,
		...model.plex,
		...model.jellyfin,
		...model.lists,
		...model.behavior,
		...model.presentation,
	};
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
		tmdbListId,
		setTmdbListId,
		tmdbListOp,
		setTmdbListOp,
		traktListSlug,
		setTraktListSlug,
		traktListOp,
		setTraktListOp,
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
		selectedJellyfinUsers,
		setSelectedJellyfinUsers,
		jellyfinAddedAtOp,
		setJellyfinAddedAtOp,
		jellyfinAddedAtDays,
		setJellyfinAddedAtDays,
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
						<select value={ageOp} onChange={(e) => setAgeOp(e.target.value)} className={inputClass}>
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
								value={targetScope === "episode" ? "greater_than" : plexWatchCountOp}
								onChange={(e) => setPlexWatchCountOp(e.target.value)}
								disabled={targetScope === "episode"}
								className={inputClass}
							>
								{targetScope === "series" && <option value="less_than">Less than</option>}
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
						{targetScope === "episode"
							? "Flag individual Sonarr episodes whose Plex play count is greater than this value."
							: "Flag items by total play count from Plex."}
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
						displayValue={incognitoMode ? getLinuxUsername : undefined}
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

		// ── List membership (C3) ────────────────────────────────────
		case "tmdb_list_member":
			return (
				<div className="space-y-2">
					<label className="block">
						<span className={labelClass}>Operator</span>
						<select
							value={tmdbListOp}
							onChange={(e) => setTmdbListOp(e.target.value)}
							className={inputClass}
						>
							<option value="is_in">Is in list</option>
							<option value="not_in">Is not in list</option>
						</select>
					</label>
					<label className="block">
						<span className={labelClass}>TMDb list ID</span>
						<input
							type="text"
							value={tmdbListId}
							onChange={(e) => setTmdbListId(e.target.value)}
							placeholder="8068"
							className={inputClass}
						/>
					</label>
					<p className="text-xs text-muted-foreground">
						Numeric TMDb list id. Membership refreshes every 4 hours from your configured TMDb key;
						an unrefreshed or unknown list matches nothing.
					</p>
				</div>
			);
		case "trakt_list_member":
			return (
				<div className="space-y-2">
					<label className="block">
						<span className={labelClass}>Operator</span>
						<select
							value={traktListOp}
							onChange={(e) => setTraktListOp(e.target.value)}
							className={inputClass}
						>
							<option value="is_in">Is in list</option>
							<option value="not_in">Is not in list</option>
						</select>
					</label>
					<label className="block">
						<span className={labelClass}>Trakt list slug</span>
						<input
							type="text"
							value={traktListSlug}
							onChange={(e) => setTraktListSlug(e.target.value)}
							placeholder="username/oscar-winners"
							className={inputClass}
						/>
					</label>
					<p className="text-xs text-muted-foreground">
						Format: username/list-slug. Requires a Trakt access token (Settings → Account);
						membership refreshes every 4 hours.
					</p>
				</div>
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

		// ── Jellyfin Rules ──────────────────────────────────────────────
		case "jellyfin_last_watched":
			return (
				<div className="space-y-2">
					<div className="flex gap-2">
						<label className="block flex-1">
							<span className={labelClass}>Operator</span>
							<select
								value={jellyfinLastWatchedOp}
								onChange={(e) => setJellyfinLastWatchedOp(e.target.value)}
								className={inputClass}
							>
								<option value="older_than">Last watched older than</option>
								<option value="never">Never watched</option>
							</select>
						</label>
						{jellyfinLastWatchedOp !== "never" && (
							<label className="block w-24">
								<span className={labelClass}>Days</span>
								<input
									type="number"
									value={jellyfinLastWatchedDays}
									onChange={(e) => setJellyfinLastWatchedDays(Number(e.target.value))}
									min={1}
									className={inputClass}
								/>
							</label>
						)}
					</div>
					<p className="text-xs text-muted-foreground">
						Requires a Jellyfin instance to be configured.
					</p>
				</div>
			);
		case "jellyfin_watch_count":
			return (
				<div className="space-y-2">
					<div className="flex gap-2">
						<label className="block flex-1">
							<span className={labelClass}>Operator</span>
							<select
								value={jellyfinWatchCountOp}
								onChange={(e) => setJellyfinWatchCountOp(e.target.value)}
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
								value={jellyfinWatchCountVal}
								onChange={(e) => setJellyfinWatchCountVal(Number(e.target.value))}
								min={0}
								className={inputClass}
							/>
						</label>
					</div>
					<p className="text-xs text-muted-foreground">
						Flag items by total play count from Jellyfin.
					</p>
				</div>
			);
		case "jellyfin_on_deck":
			return (
				<div className="space-y-2">
					<label className="flex items-center gap-2 text-sm">
						<input
							type="checkbox"
							checked={jellyfinOnDeckVal}
							onChange={(e) => setJellyfinOnDeckVal(e.target.checked)}
						/>
						Item is on Continue Watching
					</label>
					<p className="text-xs text-muted-foreground">
						{jellyfinOnDeckVal
							? "Matches items currently on Jellyfin's Continue Watching."
							: "Matches items NOT on Jellyfin's Continue Watching."}
					</p>
				</div>
			);
		case "jellyfin_user_rating":
			return (
				<div className="space-y-2">
					<div className="flex gap-2">
						<label className="block flex-1">
							<span className={labelClass}>Operator</span>
							<select
								value={jellyfinUserRatingOp}
								onChange={(e) => setJellyfinUserRatingOp(e.target.value)}
								className={inputClass}
							>
								<option value="less_than">Less than</option>
								<option value="greater_than">Greater than</option>
								<option value="unrated">Unrated</option>
							</select>
						</label>
						{jellyfinUserRatingOp !== "unrated" && (
							<label className="block w-24">
								<span className={labelClass}>Rating</span>
								<input
									type="number"
									value={jellyfinUserRatingVal}
									onChange={(e) => setJellyfinUserRatingVal(Number(e.target.value))}
									min={0}
									max={10}
									step={0.5}
									className={inputClass}
								/>
							</label>
						)}
					</div>
					<p className="text-xs text-muted-foreground">
						Flag items by user rating in Jellyfin (0-10; favorites = 10).
					</p>
				</div>
			);
		case "jellyfin_watched_by":
			return (
				<div className="space-y-2">
					<label className="block">
						<span className={labelClass}>Operator</span>
						<select
							value={jellyfinWatchedByOp}
							onChange={(e) => setJellyfinWatchedByOp(e.target.value)}
							className={inputClass}
						>
							<option value="includes_any">Watched by any of</option>
							<option value="excludes_all">Not watched by any of</option>
						</select>
					</label>
					<MultiSelectField
						label="Jellyfin Users"
						options={fieldOptions?.jellyfinUsers ?? []}
						displayValue={incognitoMode ? getLinuxUsername : undefined}
						selected={selectedJellyfinUsers}
						onChange={setSelectedJellyfinUsers}
						loading={fieldOptionsLoading}
						inputClass={inputClass}
						labelClass={labelClass}
					/>
					<p className="text-xs text-muted-foreground">
						Flag items based on which Jellyfin users have watched them.
					</p>
				</div>
			);
		case "jellyfin_added_at":
			return (
				<div className="flex gap-2">
					<label className="block flex-1">
						<span className={labelClass}>Operator</span>
						<select
							value={jellyfinAddedAtOp}
							onChange={(e) => setJellyfinAddedAtOp(e.target.value)}
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
							value={jellyfinAddedAtDays}
							onChange={(e) => setJellyfinAddedAtDays(Number(e.target.value))}
							min={1}
							className={inputClass}
						/>
					</label>
				</div>
			);

		// Phase 2/3: Behavior analysis — delegate to ConditionParamsFields
		case "plex_episode_completion":
		case "jellyfin_episode_completion":
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

export function ExcludeTagsPicker({
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
