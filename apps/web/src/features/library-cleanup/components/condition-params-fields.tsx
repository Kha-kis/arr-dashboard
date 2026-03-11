"use client";

import type { CleanupFieldOptionsResponse, CleanupRuleType } from "@arr/shared";
import { useThemeGradient } from "@/hooks/useThemeGradient";
import { MultiSelectField } from "./multi-select-field";

// ============================================================================
// Types
// ============================================================================

interface ConditionParamsFieldsProps {
	ruleType: CleanupRuleType;
	params: Record<string, unknown>;
	onParamsChange: (params: Record<string, unknown>) => void;
	fieldOptions: CleanupFieldOptionsResponse | undefined;
	fieldOptionsLoading: boolean;
	inputClass: string;
	labelClass: string;
}

// ============================================================================
// Default Params (ensures all required fields are present for backend validation)
// ============================================================================

export function getDefaultConditionParams(ruleType: CleanupRuleType): Record<string, unknown> {
	switch (ruleType) {
		case "age":
			return { operator: "older_than", days: 30 };
		case "size":
			return { operator: "greater_than", sizeGb: 50 };
		case "rating":
			return { source: "tmdb", operator: "less_than", score: 5 };
		case "status":
			return { statuses: [] };
		case "genre":
			return { operator: "includes_any", genres: [] };
		case "year_range":
			return { operator: "before", year: 2020 };
		case "quality_profile":
			return { profileNames: [] };
		case "language":
			return { operator: "includes_any", languages: [] };
		case "seerr_requested_by":
			return { userNames: [] };
		case "seerr_request_age":
			return { operator: "older_than", days: 90 };
		case "seerr_request_status":
			return { statuses: [] };
		case "video_codec":
			return { operator: "is", codecs: [] };
		case "audio_codec":
			return { operator: "is", codecs: [] };
		case "resolution":
			return { operator: "is", resolutions: [] };
		case "hdr_type":
			return { operator: "is", types: [] };
		case "custom_format_score":
			return { operator: "less_than", score: 0 };
		case "runtime":
			return { operator: "greater_than", minutes: 60 };
		case "release_group":
			return { operator: "is", groups: [] };
		case "seerr_is_4k":
			return { is4k: true };
		case "seerr_request_modified_age":
			return { operator: "older_than", days: 90 };
		case "seerr_modified_by":
			return { userNames: [] };
		case "tautulli_last_watched":
			return { operator: "older_than", days: 90 };
		case "tautulli_watch_count":
			return { operator: "less_than", count: 1 };
		case "tautulli_watched_by":
			return { operator: "includes_any", userNames: [] };
		case "plex_last_watched":
			return { operator: "older_than", days: 90 };
		case "plex_watch_count":
			return { operator: "less_than", count: 1 };
		case "plex_on_deck":
			return { isDeck: false };
		case "plex_user_rating":
			return { operator: "less_than", rating: 5 };
		case "plex_watched_by":
			return { operator: "includes_any", userNames: [] };
		case "imdb_rating":
			return { operator: "less_than", score: 5 };
		case "file_path":
			return { operator: "matches", field: "path", pattern: "" };
		case "seerr_is_requested":
			return { isRequested: true };
		case "seerr_request_count":
			return { operator: "less_than", count: 1 };
		case "audio_channels":
			return { operator: "less_than", channels: 6 };
		case "tag_match":
			return { operator: "includes_any", tagIds: [] };
		case "plex_collection":
			return { operator: "in", collections: [] };
		case "plex_label":
			return { operator: "has_any", labels: [] };
		case "plex_added_at":
			return { operator: "older_than", days: 90 };
		case "plex_episode_completion":
			return { operator: "less_than", percentage: 10 };
		case "user_retention":
			return { operator: "watched_by_none", source: "plex" };
		case "staleness_score":
			return { operator: "greater_than", threshold: 70 };
		case "recently_active":
			return { protectionDays: 30, requireActivity: true };
		default:
			return {};
	}
}

// ============================================================================
// Component
// ============================================================================

export function ConditionParamsFields({
	ruleType,
	params,
	onParamsChange,
	fieldOptions,
	fieldOptionsLoading,
	inputClass,
	labelClass,
}: ConditionParamsFieldsProps) {
	const { gradient } = useThemeGradient();
	const get = <T,>(key: string, def: T): T => (params[key] as T) ?? def;
	const set = (key: string, val: unknown) => onParamsChange({ ...params, [key]: val });

	switch (ruleType) {
		case "age":
			return (
				<div className="flex gap-2">
					<label className="block flex-1">
						<span className={labelClass}>Operator</span>
						<select
							value={get("operator", "older_than")}
							onChange={(e) => set("operator", e.target.value)}
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
							value={get("days", 30)}
							onChange={(e) => set("days", Number(e.target.value))}
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
							value={get("operator", "greater_than")}
							onChange={(e) => set("operator", e.target.value)}
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
							value={get("sizeGb", 50)}
							onChange={(e) => set("sizeGb", Number(e.target.value))}
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
							value={get("operator", "less_than")}
							onChange={(e) => set("operator", e.target.value)}
							className={inputClass}
						>
							<option value="less_than">Less than</option>
							<option value="greater_than">Greater than</option>
							<option value="unrated">Unrated</option>
						</select>
					</label>
					{String(get("operator", "less_than")) !== "unrated" && (
						<label className="block w-24">
							<span className={labelClass}>TMDB Score</span>
							<input
								type="number"
								value={get("score", 5)}
								onChange={(e) => set("score", Number(e.target.value))}
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
						value={(get("statuses", []) as string[]).join(", ")}
						onChange={(e) =>
							set(
								"statuses",
								e.target.value
									.split(",")
									.map((s: string) => s.trim())
									.filter(Boolean),
							)
						}
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
							value={get("operator", "includes_any")}
							onChange={(e) => set("operator", e.target.value)}
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
							value={(get("genres", []) as string[]).join(", ")}
							onChange={(e) =>
								set(
									"genres",
									e.target.value
										.split(",")
										.map((s: string) => s.trim())
										.filter(Boolean),
								)
							}
							placeholder="Horror, Reality, Talk Show"
							className={inputClass}
						/>
					</label>
				</div>
			);

		case "year_range": {
			const yearOp = get<string>("operator", "before");
			return (
				<div className="space-y-2">
					<label className="block">
						<span className={labelClass}>Operator</span>
						<select
							value={yearOp}
							onChange={(e) => set("operator", e.target.value)}
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
									value={get("yearFrom", 2000)}
									onChange={(e) => set("yearFrom", Number(e.target.value))}
									className={inputClass}
								/>
							</label>
							<label className="block flex-1">
								<span className={labelClass}>To</span>
								<input
									type="number"
									value={get("yearTo", 2020)}
									onChange={(e) => set("yearTo", Number(e.target.value))}
									className={inputClass}
								/>
							</label>
						</div>
					) : (
						<label className="block">
							<span className={labelClass}>Year</span>
							<input
								type="number"
								value={get("year", 2020)}
								onChange={(e) => set("year", Number(e.target.value))}
								className={inputClass}
							/>
						</label>
					)}
				</div>
			);
		}

		case "quality_profile":
			return (
				<label className="block">
					<span className={labelClass}>Profile names (comma-separated)</span>
					<input
						type="text"
						value={(get("profileNames", []) as string[]).join(", ")}
						onChange={(e) =>
							set(
								"profileNames",
								e.target.value
									.split(",")
									.map((s: string) => s.trim())
									.filter(Boolean),
							)
						}
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
							value={get("operator", "includes_any")}
							onChange={(e) => set("operator", e.target.value)}
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
							value={(get("languages", []) as string[]).join(", ")}
							onChange={(e) =>
								set(
									"languages",
									e.target.value
										.split(",")
										.map((s: string) => s.trim())
										.filter(Boolean),
								)
							}
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
							value={(get("userNames", []) as string[]).join(", ")}
							onChange={(e) =>
								set(
									"userNames",
									e.target.value
										.split(",")
										.map((s: string) => s.trim())
										.filter(Boolean),
								)
							}
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
								value={get("operator", "older_than")}
								onChange={(e) => set("operator", e.target.value)}
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
								value={get("days", 90)}
								onChange={(e) => set("days", Number(e.target.value))}
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

		case "seerr_request_status": {
			const SEERR_STATUSES = ["pending", "approved", "declined", "failed", "completed"] as const;
			const selectedStatuses = get("statuses", []) as string[];
			const toggleStatus = (s: string) => {
				set(
					"statuses",
					selectedStatuses.includes(s)
						? selectedStatuses.filter((v: string) => v !== s)
						: [...selectedStatuses, s],
				);
			};
			return (
				<div className="space-y-2">
					<span className={labelClass}>Request Statuses</span>
					<div className="flex flex-wrap gap-1.5">
						{SEERR_STATUSES.map((s) => {
							const isSelected = selectedStatuses.includes(s);
							return (
								<button
									key={s}
									type="button"
									onClick={() => toggleStatus(s)}
									aria-pressed={isSelected}
									className="rounded-lg border px-2.5 py-1 text-xs font-medium capitalize transition-all duration-200"
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
									{s}
								</button>
							);
						})}
					</div>
					<p className="text-xs text-muted-foreground">
						Flag items whose Seerr request has one of these statuses.
					</p>
				</div>
			);
		}

		case "video_codec":
			return (
				<div className="space-y-2">
					<label className="block">
						<span className={labelClass}>Operator</span>
						<select
							value={get("operator", "is")}
							onChange={(e) => set("operator", e.target.value)}
							className={inputClass}
						>
							<option value="is">Is</option>
							<option value="is_not">Is not</option>
						</select>
					</label>
					<MultiSelectField
						label="Video Codecs"
						options={fieldOptions?.videoCodecs ?? []}
						selected={get("codecs", []) as string[]}
						onChange={(v) => set("codecs", v)}
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
							value={get("operator", "is")}
							onChange={(e) => set("operator", e.target.value)}
							className={inputClass}
						>
							<option value="is">Is</option>
							<option value="is_not">Is not</option>
						</select>
					</label>
					<MultiSelectField
						label="Audio Codecs"
						options={fieldOptions?.audioCodecs ?? []}
						selected={get("codecs", []) as string[]}
						onChange={(v) => set("codecs", v)}
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
							value={get("operator", "is")}
							onChange={(e) => set("operator", e.target.value)}
							className={inputClass}
						>
							<option value="is">Is</option>
							<option value="is_not">Is not</option>
						</select>
					</label>
					<MultiSelectField
						label="Resolutions"
						options={fieldOptions?.resolutions ?? []}
						selected={get("resolutions", []) as string[]}
						onChange={(v) => set("resolutions", v)}
						loading={fieldOptionsLoading}
						inputClass={inputClass}
						labelClass={labelClass}
					/>
				</div>
			);

		case "hdr_type": {
			const hdrOp = get<string>("operator", "is");
			return (
				<div className="space-y-2">
					<label className="block">
						<span className={labelClass}>Operator</span>
						<select
							value={hdrOp}
							onChange={(e) => set("operator", e.target.value)}
							className={inputClass}
						>
							<option value="is">Is</option>
							<option value="is_not">Is not</option>
							<option value="none">No HDR (SDR only)</option>
						</select>
					</label>
					{hdrOp !== "none" && (
						<MultiSelectField
							label="HDR Types"
							options={fieldOptions?.hdrTypes ?? []}
							selected={get("types", []) as string[]}
							onChange={(v) => set("types", v)}
							loading={fieldOptionsLoading}
							inputClass={inputClass}
							labelClass={labelClass}
						/>
					)}
				</div>
			);
		}

		case "custom_format_score":
			return (
				<div className="flex gap-2">
					<label className="block flex-1">
						<span className={labelClass}>Operator</span>
						<select
							value={get("operator", "less_than")}
							onChange={(e) => set("operator", e.target.value)}
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
							value={get("score", 0)}
							onChange={(e) => set("score", Number(e.target.value))}
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
							value={get("operator", "greater_than")}
							onChange={(e) => set("operator", e.target.value)}
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
							value={get("minutes", 60)}
							onChange={(e) => set("minutes", Number(e.target.value))}
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
							value={get("operator", "is")}
							onChange={(e) => set("operator", e.target.value)}
							className={inputClass}
						>
							<option value="is">Is</option>
							<option value="is_not">Is not</option>
						</select>
					</label>
					<MultiSelectField
						label="Release Groups"
						options={fieldOptions?.releaseGroups ?? []}
						selected={get("groups", []) as string[]}
						onChange={(v) => set("groups", v)}
						loading={fieldOptionsLoading}
						inputClass={inputClass}
						labelClass={labelClass}
					/>
				</div>
			);

		case "seerr_is_4k": {
			const is4k = get("is4k", true);
			return (
				<div className="space-y-2">
					<label className="flex items-center gap-2 text-sm">
						<input type="checkbox" checked={is4k} onChange={(e) => set("is4k", e.target.checked)} />
						Flag 4K requests
					</label>
					<p className="text-xs text-muted-foreground">
						{is4k
							? "Matches items with 4K Seerr requests."
							: "Matches items with non-4K Seerr requests."}
					</p>
				</div>
			);
		}

		case "seerr_request_modified_age":
			return (
				<div className="space-y-2">
					<div className="flex gap-2">
						<label className="block flex-1">
							<span className={labelClass}>Operator</span>
							<select
								value={get("operator", "older_than")}
								onChange={(e) => set("operator", e.target.value)}
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
								value={get("days", 90)}
								onChange={(e) => set("days", Number(e.target.value))}
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
							value={(get("userNames", []) as string[]).join(", ")}
							onChange={(e) =>
								set(
									"userNames",
									e.target.value
										.split(",")
										.map((s: string) => s.trim())
										.filter(Boolean),
								)
							}
							placeholder="admin, john_doe"
							className={inputClass}
						/>
					</label>
					<p className="text-xs text-muted-foreground">
						Flag items whose Seerr request was last modified by these users.
					</p>
				</div>
			);

		case "tautulli_last_watched": {
			const tautulliOp = get<string>("operator", "older_than");
			return (
				<div className="space-y-2">
					<div className="flex gap-2">
						<label className="block flex-1">
							<span className={labelClass}>Operator</span>
							<select
								value={tautulliOp}
								onChange={(e) => set("operator", e.target.value)}
								className={inputClass}
							>
								<option value="older_than">Last watched older than</option>
								<option value="never">Never watched</option>
							</select>
						</label>
						{tautulliOp !== "never" && (
							<label className="block w-24">
								<span className={labelClass}>Days</span>
								<input
									type="number"
									value={get("days", 90)}
									onChange={(e) => set("days", Number(e.target.value))}
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
		}

		case "tautulli_watch_count":
			return (
				<div className="space-y-2">
					<div className="flex gap-2">
						<label className="block flex-1">
							<span className={labelClass}>Operator</span>
							<select
								value={get("operator", "less_than")}
								onChange={(e) => set("operator", e.target.value)}
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
								value={get("count", 1)}
								onChange={(e) => set("count", Number(e.target.value))}
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
							value={get("operator", "includes_any")}
							onChange={(e) => set("operator", e.target.value)}
							className={inputClass}
						>
							<option value="includes_any">Watched by any of</option>
							<option value="excludes_all">Not watched by any of</option>
						</select>
					</label>
					<MultiSelectField
						label="Tautulli Users"
						options={fieldOptions?.tautulliUsers ?? []}
						selected={get("userNames", []) as string[]}
						onChange={(v) => set("userNames", v)}
						loading={fieldOptionsLoading}
						inputClass={inputClass}
						labelClass={labelClass}
					/>
					<p className="text-xs text-muted-foreground">
						Flag items based on which Tautulli users have watched them.
					</p>
				</div>
			);

		case "plex_last_watched": {
			const plexLastOp = get<string>("operator", "older_than");
			return (
				<div className="space-y-2">
					<div className="flex gap-2">
						<label className="block flex-1">
							<span className={labelClass}>Operator</span>
							<select
								value={plexLastOp}
								onChange={(e) => set("operator", e.target.value)}
								className={inputClass}
							>
								<option value="older_than">Last watched older than</option>
								<option value="never">Never watched</option>
							</select>
						</label>
						{plexLastOp !== "never" && (
							<label className="block w-24">
								<span className={labelClass}>Days</span>
								<input
									type="number"
									value={get("days", 90)}
									onChange={(e) => set("days", Number(e.target.value))}
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
		}

		case "plex_watch_count":
			return (
				<div className="space-y-2">
					<div className="flex gap-2">
						<label className="block flex-1">
							<span className={labelClass}>Operator</span>
							<select
								value={get("operator", "less_than")}
								onChange={(e) => set("operator", e.target.value)}
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
								value={get("count", 1)}
								onChange={(e) => set("count", Number(e.target.value))}
								min={0}
								className={inputClass}
							/>
						</label>
					</div>
					<p className="text-xs text-muted-foreground">Flag items by total play count from Plex.</p>
				</div>
			);

		case "plex_on_deck": {
			const isDeck = get("isDeck", false);
			return (
				<div className="space-y-2">
					<label className="flex items-center gap-2 text-sm">
						<input
							type="checkbox"
							checked={isDeck}
							onChange={(e) => set("isDeck", e.target.checked)}
						/>
						Item is on Continue Watching
					</label>
					<p className="text-xs text-muted-foreground">
						{isDeck
							? "Matches items currently on Plex's Continue Watching / On Deck."
							: "Matches items NOT on Plex's Continue Watching / On Deck."}
					</p>
				</div>
			);
		}

		case "plex_user_rating": {
			const plexRatingOp = get<string>("operator", "less_than");
			return (
				<div className="space-y-2">
					<div className="flex gap-2">
						<label className="block flex-1">
							<span className={labelClass}>Operator</span>
							<select
								value={plexRatingOp}
								onChange={(e) => set("operator", e.target.value)}
								className={inputClass}
							>
								<option value="less_than">Less than</option>
								<option value="greater_than">Greater than</option>
								<option value="unrated">Unrated</option>
							</select>
						</label>
						{plexRatingOp !== "unrated" && (
							<label className="block w-24">
								<span className={labelClass}>Rating</span>
								<input
									type="number"
									value={get("rating", 5)}
									onChange={(e) => set("rating", Number(e.target.value))}
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
		}

		case "plex_watched_by":
			return (
				<div className="space-y-2">
					<label className="block">
						<span className={labelClass}>Operator</span>
						<select
							value={get("operator", "includes_any")}
							onChange={(e) => set("operator", e.target.value)}
							className={inputClass}
						>
							<option value="includes_any">Watched by any of</option>
							<option value="excludes_all">Not watched by any of</option>
						</select>
					</label>
					<MultiSelectField
						label="Plex Users"
						options={fieldOptions?.plexUsers ?? []}
						selected={get("userNames", []) as string[]}
						onChange={(v) => set("userNames", v)}
						loading={fieldOptionsLoading}
						inputClass={inputClass}
						labelClass={labelClass}
					/>
					<p className="text-xs text-muted-foreground">
						Flag items based on which Plex users have watched them.
					</p>
				</div>
			);

		case "imdb_rating":
			return (
				<div className="flex gap-2">
					<label className="block flex-1">
						<span className={labelClass}>Operator</span>
						<select
							value={get("operator", "less_than")}
							onChange={(e) => set("operator", e.target.value)}
							className={inputClass}
						>
							<option value="less_than">Less than</option>
							<option value="greater_than">Greater than</option>
							<option value="unrated">Unrated</option>
						</select>
					</label>
					{String(get("operator", "less_than")) !== "unrated" && (
						<label className="block w-24">
							<span className={labelClass}>IMDb Score</span>
							<input
								type="number"
								value={get("score", 5)}
								onChange={(e) => set("score", Number(e.target.value))}
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
							value={get("operator", "matches")}
							onChange={(e) => set("operator", e.target.value)}
							className={inputClass}
						>
							<option value="matches">Matches</option>
							<option value="not_matches">Does not match</option>
						</select>
					</label>
					<label className="block">
						<span className={labelClass}>Field</span>
						<select
							value={get("field", "path")}
							onChange={(e) => set("field", e.target.value)}
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
							value={get("pattern", "")}
							onChange={(e) => set("pattern", e.target.value)}
							placeholder="/mnt/data/movies"
							className={inputClass}
						/>
					</label>
				</div>
			);

		case "seerr_is_requested": {
			const isRequested = get("isRequested", true);
			return (
				<div className="space-y-2">
					<label className="flex items-center gap-2 text-sm">
						<input
							type="checkbox"
							checked={isRequested}
							onChange={(e) => set("isRequested", e.target.checked)}
						/>
						Has a Seerr request
					</label>
					<p className="text-xs text-muted-foreground">
						{isRequested
							? "Matches items that have at least one Seerr request."
							: "Matches items that have no Seerr request."}
					</p>
				</div>
			);
		}

		case "seerr_request_count":
			return (
				<div className="flex gap-2">
					<label className="block flex-1">
						<span className={labelClass}>Operator</span>
						<select
							value={get("operator", "less_than")}
							onChange={(e) => set("operator", e.target.value)}
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
							value={get("count", 1)}
							onChange={(e) => set("count", Number(e.target.value))}
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
							value={get("operator", "less_than")}
							onChange={(e) => set("operator", e.target.value)}
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
							value={get("channels", 6)}
							onChange={(e) => set("channels", Number(e.target.value))}
							min={1}
							className={inputClass}
						/>
					</label>
				</div>
			);

		case "tag_match":
			return (
				<ConditionTagMatchFields
					get={get}
					set={set}
					fieldOptions={fieldOptions}
					inputClass={inputClass}
					labelClass={labelClass}
				/>
			);

		case "plex_collection":
			return (
				<div className="space-y-2">
					<label className="block">
						<span className={labelClass}>Operator</span>
						<select
							value={get("operator", "in")}
							onChange={(e) => set("operator", e.target.value)}
							className={inputClass}
						>
							<option value="in">In collection</option>
							<option value="not_in">Not in collection</option>
						</select>
					</label>
					<MultiSelectField
						label="Plex Collections"
						options={fieldOptions?.plexCollections ?? []}
						selected={get("collections", []) as string[]}
						onChange={(v) => set("collections", v)}
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
							value={get("operator", "has_any")}
							onChange={(e) => set("operator", e.target.value)}
							className={inputClass}
						>
							<option value="has_any">Has any of</option>
							<option value="has_none">Has none of</option>
						</select>
					</label>
					<MultiSelectField
						label="Plex Labels"
						options={fieldOptions?.plexLabels ?? []}
						selected={get("labels", []) as string[]}
						onChange={(v) => set("labels", v)}
						loading={fieldOptionsLoading}
						inputClass={inputClass}
						labelClass={labelClass}
					/>
				</div>
			);

		case "plex_added_at":
			return (
				<div className="space-y-2">
					<div className="flex gap-2">
						<label className="block flex-1">
							<span className={labelClass}>Operator</span>
							<select
								value={get("operator", "older_than")}
								onChange={(e) => set("operator", e.target.value)}
								className={inputClass}
							>
								<option value="older_than">Added more than</option>
								<option value="newer_than">Added less than</option>
							</select>
						</label>
						<label className="block w-24">
							<span className={labelClass}>Days</span>
							<input
								type="number"
								value={get("days", 90)}
								onChange={(e) => set("days", Number(e.target.value))}
								min={1}
								className={inputClass}
							/>
						</label>
					</div>
					<p className="text-xs text-muted-foreground">
						Flag items by when they were added to Plex. Requires a Plex instance.
					</p>
				</div>
			);

		case "plex_episode_completion":
			return (
				<div className="space-y-2">
					<div className="flex gap-2">
						<label className="block flex-1">
							<span className={labelClass}>Operator</span>
							<select
								value={get("operator", "less_than")}
								onChange={(e) => set("operator", e.target.value)}
								className={inputClass}
							>
								<option value="less_than">Less than</option>
								<option value="greater_than">Greater than</option>
							</select>
						</label>
						<label className="block w-24">
							<span className={labelClass}>Percent</span>
							<input
								type="number"
								value={get("percentage", 10)}
								onChange={(e) => set("percentage", Number(e.target.value))}
								min={0}
								max={100}
								className={inputClass}
							/>
						</label>
						<label className="block w-28">
							<span className={labelClass}>Min Season</span>
							<input
								type="number"
								value={get("minSeason", 0)}
								onChange={(e) => set("minSeason", Number(e.target.value))}
								min={0}
								placeholder="0 = all"
								className={inputClass}
							/>
						</label>
					</div>
					<p className="text-xs text-muted-foreground">
						Only count episodes from this season onward. 0 or empty = all seasons.
					</p>
				</div>
			);

		case "user_retention":
			return (
				<div className="space-y-3">
					<div className="flex gap-2">
						<label className="block flex-1">
							<span className={labelClass}>Operator</span>
							<select
								value={get("operator", "watched_by_none")}
								onChange={(e) => set("operator", e.target.value)}
								className={inputClass}
							>
								<option value="watched_by_none">Watched by none</option>
								<option value="watched_by_all">Watched by all</option>
								<option value="watched_by_count">Watched by count</option>
							</select>
						</label>
						<label className="block w-32">
							<span className={labelClass}>Source</span>
							<select
								value={get("source", "plex")}
								onChange={(e) => set("source", e.target.value)}
								className={inputClass}
							>
								<option value="plex">Plex</option>
								<option value="tautulli">Tautulli</option>
								<option value="either">Either</option>
							</select>
						</label>
					</div>
					{get<string>("operator", "watched_by_none") === "watched_by_count" && (
						<label className="block w-24">
							<span className={labelClass}>Min Users</span>
							<input
								type="number"
								value={get("minUsers", 1)}
								onChange={(e) => set("minUsers", Number(e.target.value))}
								min={1}
								className={inputClass}
							/>
						</label>
					)}
					{get<string>("operator", "watched_by_none") === "watched_by_all" && (
						<label className="block">
							<span className={labelClass}>Users (comma-separated)</span>
							<input
								type="text"
								value={(get("userNames", []) as string[]).join(", ")}
								onChange={(e) =>
									set(
										"userNames",
										e.target.value
											.split(",")
											.map((s: string) => s.trim())
											.filter(Boolean),
									)
								}
								placeholder="alice, bob"
								className={inputClass}
							/>
						</label>
					)}
				</div>
			);

		case "staleness_score": {
			const weights = (get("weights", {}) as Record<string, number>) ?? {};
			const defaultWeights = {
				daysSinceLastWatch: 0.3,
				inverseWatchCount: 0.2,
				notOnDeck: 0.1,
				lowUserRating: 0.15,
				lowTmdbRating: 0.15,
				sizeOnDisk: 0.1,
			};
			const setWeight = (key: string, val: number) =>
				set("weights", { ...defaultWeights, ...weights, [key]: val });
			return (
				<div className="space-y-3">
					<div className="flex gap-2">
						<label className="block flex-1">
							<span className={labelClass}>Threshold (0-100)</span>
							<input
								type="number"
								value={get("threshold", 70)}
								onChange={(e) => set("threshold", Number(e.target.value))}
								min={0}
								max={100}
								className={inputClass}
							/>
						</label>
					</div>
					<p className="text-xs text-muted-foreground">
						Weighted score combining watch recency, play count, deck status, ratings, and file size.
						Higher = more stale.
					</p>
					<details className="text-xs">
						<summary className="cursor-pointer text-muted-foreground hover:text-foreground transition-colors">
							Custom weights (must sum to 1.0)
						</summary>
						<div className="mt-2 grid grid-cols-2 gap-2">
							{(Object.entries(defaultWeights) as [string, number][]).map(([key, def]) => (
								<label key={key} className="block">
									<span className={labelClass}>
										{key.replace(/([A-Z])/g, " $1").replace(/^./, (c) => c.toUpperCase())}
									</span>
									<input
										type="number"
										value={weights[key] ?? def}
										onChange={(e) => setWeight(key, Number(e.target.value))}
										min={0}
										max={1}
										step={0.05}
										className={inputClass}
									/>
								</label>
							))}
						</div>
					</details>
				</div>
			);
		}

		case "recently_active":
			return (
				<div className="space-y-3">
					<div className="flex gap-2">
						<label className="block flex-1">
							<span className={labelClass}>Protection Window (days)</span>
							<input
								type="number"
								value={get("protectionDays", 30)}
								onChange={(e) => set("protectionDays", Number(e.target.value))}
								min={1}
								max={365}
								className={inputClass}
							/>
						</label>
					</div>
					<label className="flex items-center gap-2 cursor-pointer">
						<input
							type="checkbox"
							checked={get("requireActivity", true) as boolean}
							onChange={(e) => set("requireActivity", e.target.checked)}
							className="rounded border-border"
						/>
						<span className="text-xs text-muted-foreground">
							Require watch activity (not just recent addition)
						</span>
					</label>
					<p className="text-xs text-muted-foreground">
						Protects items with recent activity. Best used as a retention rule — items matching this
						rule will be shielded from cleanup.
					</p>
				</div>
			);

		case "composite":
			return null;

		default:
			return null;
	}
}

// ============================================================================
// Tag Match Fields for Conditions
// ============================================================================

function ConditionTagMatchFields({
	get,
	set,
	fieldOptions,
	inputClass,
	labelClass,
}: {
	get: (key: string, fallback: unknown) => unknown;
	set: (key: string, value: unknown) => void;
	fieldOptions: CleanupFieldOptionsResponse | undefined;
	inputClass: string;
	labelClass: string;
}) {
	const { gradient } = useThemeGradient();
	const tags = fieldOptions?.arrTags ?? [];
	const selectedIds = (get("tagIds", []) as number[]) ?? [];

	const toggleTag = (id: number) => {
		set(
			"tagIds",
			selectedIds.includes(id) ? selectedIds.filter((t) => t !== id) : [...selectedIds, id],
		);
	};

	return (
		<div className="space-y-2">
			<label className="block">
				<span className={labelClass}>Operator</span>
				<select
					value={get("operator", "includes_any") as string}
					onChange={(e) => set("operator", e.target.value)}
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
							const isSelected = selectedIds.includes(tag.id);
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
						value={selectedIds.join(", ")}
						onChange={(e) =>
							set(
								"tagIds",
								e.target.value
									.split(",")
									.map((s: string) => Number(s.trim()))
									.filter((n: number) => !Number.isNaN(n) && n > 0),
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
