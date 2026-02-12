"use client";

import { useState, useEffect, useMemo, useCallback } from "react";
import { useClonedCFValidation, useProfileMatch } from "../../../../hooks/api/useQualityProfiles";
import { Alert, AlertDescription } from "../../../../components/ui";
import { PremiumSkeleton } from "../../../../components/layout/premium-components";
import {
	ChevronLeft,
	ChevronRight,
	CheckCircle,
	Link2,
	Unlink,
	RotateCcw,
	Info,
	Filter,
	Search,
	AlertTriangle,
	Plus,
	Sparkles,
} from "lucide-react";
import type { CFMatchResult } from "../../../../lib/api-client/trash-guides";
import { useThemeGradient } from "../../../../hooks/useThemeGradient";
import { CFResolutionItem, ExcludedCFItem } from "./cf-resolution-items";
import { ProfileMatchBanner, ResolutionStatistics, CollapsibleCFSection } from "./cf-resolution-panels";

/**
 * User's decision for a matched CF
 */
export type CFResolutionDecision = "use_trash" | "keep_instance";

/**
 * Resolved CF data to be passed forward
 */
export interface ResolvedCF {
	instanceCFId: number;
	instanceCFName: string;
	decision: CFResolutionDecision;
	/** If decision is use_trash, this contains the TRaSH CF trash_id */
	trashId?: string;
	/** Recommended score from TRaSH if applicable */
	recommendedScore?: number;
	/** Original instance score */
	instanceScore?: number;
}

interface CFResolutionProps {
	serviceType: "RADARR" | "SONARR";
	instanceId: string;
	profileId: number;
	profileName: string;
	onComplete: (resolutions: ResolvedCF[]) => void;
	onBack: () => void;
	/** Pre-existing resolutions (for editing/returning to this step) */
	initialResolutions?: ResolvedCF[];
}

type FilterMode = "all" | "matched" | "unmatched";

/**
 * Determine if a CF should be in the "excluded" section based on score logic
 *
 * IMPORTANT: All CFs we receive are from the profile's formatItems - meaning
 * the user explicitly added them to this profile. We should NOT auto-exclude
 * based on score alone. Score 0 means "track but don't affect ranking", which
 * is a valid configuration choice.
 *
 * We only use this for recommendation-based filtering now, not score-based exclusion.
 */
function shouldBeExcludedByScore(_result: CFMatchResult): boolean {
	// Never auto-exclude based on score - CFs in formatItems are intentionally configured
	// Users can manually exclude if they don't want a CF
	return false;
}

/**
 * Determine if a CF is "TRaSH Recommended but Not Configured"
 * This means: instance score is 0 BUT TRaSH recommends a non-zero score
 * These are CFs that exist in the instance but the user hasn't enabled for this profile,
 * but TRaSH recommends enabling them.
 */
function isTrashRecommendedNotConfigured(result: CFMatchResult): boolean {
	// Only applies to matched CFs
	if (result.confidence === "no_match") return false;

	const instanceScore = result.instanceCF.score ?? 0;
	const trashScore = result.recommendedScore ?? 0;

	// Instance has it at 0, but TRaSH recommends non-zero
	return instanceScore === 0 && trashScore !== 0;
}

/**
 * Determine if a CF should be excluded based on TRaSH profile recommendations
 * If a matched TRaSH CF's trash_id is NOT in the recommendations, it should be excluded
 */
function shouldBeExcludedByRecommendations(
	result: CFMatchResult,
	recommendedTrashIds: Set<string> | null,
): boolean {
	// If no recommendations available, don't exclude based on this
	if (!recommendedTrashIds || recommendedTrashIds.size === 0) return false;

	// Only applies to matched CFs (we need a trash_id to check)
	if (result.confidence === "no_match" || !result.trashCF?.trash_id) return false;

	// If the matched TRaSH CF's trash_id is NOT in the recommended list, exclude it
	return !recommendedTrashIds.has(result.trashCF.trash_id);
}

export const CFResolution = ({
	serviceType,
	instanceId,
	profileId,
	profileName,
	onComplete,
	onBack,
	initialResolutions,
}: CFResolutionProps) => {
	const { gradient: themeGradient } = useThemeGradient();
	const [searchQuery, setSearchQuery] = useState("");
	const [filterMode, setFilterMode] = useState<FilterMode>("all");

	// State for user decisions (keyed by instance CF id)
	const [decisions, setDecisions] = useState<Record<number, CFResolutionDecision>>({});

	// State for tracking which excluded CFs the user wants to include anyway
	const [includedExcluded, setIncludedExcluded] = useState<Set<number>>(new Set());

	// State for tracking which active CFs the user wants to manually exclude
	const [manuallyExcluded, setManuallyExcluded] = useState<Set<number>>(new Set());

	// State for excluded section visibility (expanded by default so users don't miss it)
	const [excludedExpanded, setExcludedExpanded] = useState(true);

	// State for recommended section visibility (expanded by default to highlight opportunities)
	const [recommendedExpanded, setRecommendedExpanded] = useState(true);

	// State for whether to use TRaSH recommendations for exclusion
	const [useRecommendations, setUseRecommendations] = useState(true);

	// Fetch CF validation data
	const { data, isLoading, error } = useClonedCFValidation(
		instanceId,
		profileId,
		serviceType,
	);

	// Fetch profile match data for recommendations
	const { data: profileMatchData, isLoading: isLoadingMatch } = useProfileMatch(
		profileName,
		serviceType,
		true, // Always enabled
	);

	// Build a Set of recommended trash_ids for quick lookup
	const recommendedTrashIds = useMemo(() => {
		if (!profileMatchData?.matched || !profileMatchData?.recommendations?.recommendedTrashIds) {
			return null;
		}
		return new Set(profileMatchData.recommendations.recommendedTrashIds);
	}, [profileMatchData]);

	// Determine if a CF should be excluded (combines score logic and recommendation logic)
	const shouldBeExcluded = useCallback((result: CFMatchResult): { excluded: boolean; reason: "score" | "recommendation" | null } => {
		// First check score-based exclusion
		if (shouldBeExcludedByScore(result)) {
			return { excluded: true, reason: "score" };
		}

		// Then check recommendation-based exclusion (only if user enabled it and we have recommendations)
		if (useRecommendations && recommendedTrashIds) {
			if (shouldBeExcludedByRecommendations(result, recommendedTrashIds)) {
				return { excluded: true, reason: "recommendation" };
			}
		}

		return { excluded: false, reason: null };
	}, [useRecommendations, recommendedTrashIds]);

	// Initialize decisions from initial resolutions or default based on match confidence
	useEffect(() => {
		if (data?.results) {
			// Only initialize if decisions haven't been set yet
			if (Object.keys(decisions).length > 0) return;

			const initialDecisions: Record<number, CFResolutionDecision> = {};

			// First check for pre-existing resolutions
			if (initialResolutions?.length) {
				for (const res of initialResolutions) {
					initialDecisions[res.instanceCFId] = res.decision;
				}
			} else {
				// Default: use TRaSH for exact/name matches, keep instance for others
				for (const result of data.results) {
					if (result.confidence === "exact" || result.confidence === "name_only") {
						initialDecisions[result.instanceCF.id] = "use_trash";
					} else {
						initialDecisions[result.instanceCF.id] = "keep_instance";
					}
				}
			}

			setDecisions(initialDecisions);
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps -- Intentionally exclude decisions to prevent re-initialization
	}, [data, initialResolutions]);

	// Split results into active, recommended (not configured), and excluded sections
	// Takes into account: auto-excluded (score/recommendation logic), manually excluded, and manually included
	// Also tracks exclusion reasons for display
	const { activeCFs, recommendedCFs, excludedCFs, exclusionReasons } = useMemo(() => {
		if (!data?.results) return {
			activeCFs: [],
			recommendedCFs: [],
			excludedCFs: [],
			exclusionReasons: {} as Record<number, "score" | "recommendation" | "manual">
		};

		const active: CFMatchResult[] = [];
		const recommended: CFMatchResult[] = [];
		const excluded: CFMatchResult[] = [];
		const reasons: Record<number, "score" | "recommendation" | "manual"> = {};

		for (const result of data.results) {
			const cfId = result.instanceCF.id;
			const autoExcludeResult = shouldBeExcluded(result);
			const isRecommendedNotConfigured = isTrashRecommendedNotConfigured(result);

			// Determine final status:
			// - Auto-excluded CFs go to excluded UNLESS manually included
			// - Recommended (not configured) CFs go to recommended section UNLESS manually excluded
			// - Non-auto-excluded CFs go to active UNLESS manually excluded
			if (autoExcludeResult.excluded) {
				if (includedExcluded.has(cfId)) {
					active.push(result); // User overrode auto-exclude
				} else {
					excluded.push(result);
					if (autoExcludeResult.reason) {
						reasons[cfId] = autoExcludeResult.reason;
					}
				}
			} else if (isRecommendedNotConfigured) {
				// CFs with instanceScore=0 but TRaSH recommends non-zero
				if (manuallyExcluded.has(cfId)) {
					excluded.push(result);
					reasons[cfId] = "manual";
				} else {
					recommended.push(result);
				}
			} else {
				if (manuallyExcluded.has(cfId)) {
					excluded.push(result); // User manually excluded
					reasons[cfId] = "manual";
				} else {
					active.push(result);
				}
			}
		}

		return { activeCFs: active, recommendedCFs: recommended, excludedCFs: excluded, exclusionReasons: reasons };
	}, [data, includedExcluded, manuallyExcluded, shouldBeExcluded]);

	// Filter and search results (applies to active CFs only for the main list)
	const filteredResults = useMemo(() => {
		let filtered = activeCFs;

		// Apply filter mode
		if (filterMode === "matched") {
			filtered = filtered.filter((r) => r.confidence !== "no_match");
		} else if (filterMode === "unmatched") {
			filtered = filtered.filter((r) => r.confidence === "no_match");
		}

		// Apply search
		if (searchQuery.trim()) {
			const query = searchQuery.toLowerCase();
			filtered = filtered.filter(
				(r) =>
					r.instanceCF.name.toLowerCase().includes(query) ||
					(r.trashCF?.name.toLowerCase().includes(query) ?? false),
			);
		}

		return filtered;
	}, [activeCFs, filterMode, searchQuery]);

	// Filter and search recommended CFs separately
	const filteredRecommendedCFs = useMemo(() => {
		let filtered = recommendedCFs;

		// Apply filter mode (recommended are always matched, so only "unmatched" filter hides them)
		if (filterMode === "unmatched") {
			return []; // Recommended CFs are matched CFs, so hide them in "unmatched" mode
		}

		// Apply search
		if (searchQuery.trim()) {
			const query = searchQuery.toLowerCase();
			filtered = filtered.filter(
				(r) =>
					r.instanceCF.name.toLowerCase().includes(query) ||
					(r.trashCF?.name.toLowerCase().includes(query) ?? false),
			);
		}

		return filtered;
	}, [recommendedCFs, filterMode, searchQuery]);

	// Filter and search excluded CFs separately
	const filteredExcludedCFs = useMemo(() => {
		let filtered = excludedCFs;

		// Apply filter mode (excluded are always matched, so only "unmatched" filter hides them)
		if (filterMode === "unmatched") {
			return []; // Excluded CFs are matched CFs, so hide them in "unmatched" mode
		}

		// Apply search
		if (searchQuery.trim()) {
			const query = searchQuery.toLowerCase();
			filtered = filtered.filter(
				(r) =>
					r.instanceCF.name.toLowerCase().includes(query) ||
					(r.trashCF?.name.toLowerCase().includes(query) ?? false),
			);
		}

		return filtered;
	}, [excludedCFs, filterMode, searchQuery]);

	// Stats - dynamically calculated based on what will actually be in the template
	const matchStats = useMemo(() => {
		if (!data?.results) return null;

		const total = data.results.length;
		const matched = data.results.filter((r) => r.confidence !== "no_match").length;
		const exact = data.results.filter((r) => r.confidence === "exact").length;
		const nameOnly = data.results.filter((r) => r.confidence === "name_only").length;
		const specsSimilar = data.results.filter((r) => r.confidence === "specs_similar").length;
		const unmatched = data.results.filter((r) => r.confidence === "no_match").length;

		// Count active vs recommended vs excluded
		const activeCount = activeCFs.length;
		const recommendedCount = recommendedCFs.length;
		const excludedCount = excludedCFs.length;
		const manuallyExcludedCount = manuallyExcluded.size;

		// Count exclusions by reason
		let excludedByScore = 0;
		let excludedByRec = 0;
		for (const reason of Object.values(exclusionReasons)) {
			if (reason === "score") excludedByScore++;
			else if (reason === "recommendation") excludedByRec++;
		}

		// Calculate what will ACTUALLY be linked to TRaSH (only from CFs that will be in the template)
		// This includes: activeCFs + recommendedCFs + manually included excluded CFs
		let willBeLinkingToTrash = 0;
		let willKeepInstance = 0;
		let totalInTemplate = 0;

		// Count from active CFs
		for (const cf of activeCFs) {
			totalInTemplate++;
			const decision = decisions[cf.instanceCF.id];
			if (cf.confidence !== "no_match" && decision === "use_trash") {
				willBeLinkingToTrash++;
			} else if (cf.confidence !== "no_match" && decision === "keep_instance") {
				willKeepInstance++;
			}
		}

		// Count from recommended CFs (default to use_trash)
		for (const cf of recommendedCFs) {
			totalInTemplate++;
			const decision = decisions[cf.instanceCF.id] || "use_trash";
			if (decision === "use_trash") {
				willBeLinkingToTrash++;
			} else {
				willKeepInstance++;
			}
		}

		// Count from manually included excluded CFs
		for (const cfId of includedExcluded) {
			const cf = excludedCFs.find((r) => r.instanceCF.id === cfId);
			if (cf) {
				totalInTemplate++;
				const decision = decisions[cf.instanceCF.id] || "keep_instance";
				if (cf.confidence !== "no_match" && decision === "use_trash") {
					willBeLinkingToTrash++;
				} else if (cf.confidence !== "no_match" && decision === "keep_instance") {
					willKeepInstance++;
				}
			}
		}

		return {
			total,
			matched,
			exact,
			nameOnly,
			specsSimilar,
			unmatched,
			activeCount,
			recommendedCount,
			excludedCount,
			manuallyExcludedCount,
			excludedByScore,
			excludedByRec,
			// New dynamic stats
			willBeLinkingToTrash,
			willKeepInstance,
			totalInTemplate,
		};
	}, [data, decisions, activeCFs, recommendedCFs, excludedCFs, manuallyExcluded, includedExcluded, exclusionReasons]);

	const handleDecisionChange = (cfId: number, decision: CFResolutionDecision) => {
		setDecisions((prev) => ({ ...prev, [cfId]: decision }));
	};

	// Toggle a CF between active and excluded
	// For auto-excluded CFs: toggle includedExcluded set
	// For manually excluded CFs: toggle manuallyExcluded set
	const handleToggleExclusion = (cfId: number, isCurrentlyExcluded: boolean, isAutoExcluded: boolean) => {
		if (isAutoExcluded) {
			// This CF was auto-excluded by score logic
			setIncludedExcluded((prev) => {
				const newSet = new Set(prev);
				if (isCurrentlyExcluded) {
					// Currently excluded, user wants to include
					newSet.add(cfId);
				} else {
					// Currently included (user overrode), user wants to exclude again
					newSet.delete(cfId);
				}
				return newSet;
			});
		} else {
			// This CF was NOT auto-excluded, so manual exclusion applies
			setManuallyExcluded((prev) => {
				const newSet = new Set(prev);
				if (isCurrentlyExcluded) {
					// Currently excluded (manually), user wants to include
					newSet.delete(cfId);
				} else {
					// Currently active, user wants to exclude
					newSet.add(cfId);
				}
				return newSet;
			});
		}
	};

	const handleBulkAction = (action: "use_trash_all" | "keep_instance_all" | "reset") => {
		if (!data?.results) return;

		if (action === "reset") {
			// Reset to defaults based on match confidence (only for active CFs)
			const newDecisions: Record<number, CFResolutionDecision> = {};
			for (const result of activeCFs) {
				if (result.confidence === "exact" || result.confidence === "name_only") {
					newDecisions[result.instanceCF.id] = "use_trash";
				} else {
					newDecisions[result.instanceCF.id] = "keep_instance";
				}
			}
			// Also reset any manually included excluded CFs
			for (const cfId of includedExcluded) {
				const result = excludedCFs.find((r) => r.instanceCF.id === cfId);
				if (result && (result.confidence === "exact" || result.confidence === "name_only")) {
					newDecisions[cfId] = "use_trash";
				} else if (result) {
					newDecisions[cfId] = "keep_instance";
				}
			}
			setDecisions(newDecisions);
		} else {
			// Apply to all matched active CFs only
			const newDecisions: Record<number, CFResolutionDecision> = { ...decisions };
			for (const result of activeCFs) {
				if (result.confidence !== "no_match") {
					newDecisions[result.instanceCF.id] =
						action === "use_trash_all" ? "use_trash" : "keep_instance";
				}
			}
			setDecisions(newDecisions);
		}
	};

	const handleContinue = () => {
		if (!data?.results) return;

		// Build resolutions from active CFs + recommended CFs + manually included excluded CFs
		const resolutions: ResolvedCF[] = [];

		// Add all active CFs
		for (const result of activeCFs) {
			const decision = decisions[result.instanceCF.id] || "keep_instance";
			resolutions.push({
				instanceCFId: result.instanceCF.id,
				instanceCFName: result.instanceCF.name,
				decision,
				trashId: decision === "use_trash" ? result.trashCF?.trash_id : undefined,
				recommendedScore: result.recommendedScore,
				instanceScore: result.instanceCF.score,
			});
		}

		// Add all recommended CFs (not manually excluded)
		for (const result of recommendedCFs) {
			const decision = decisions[result.instanceCF.id] || "use_trash"; // Default to use_trash for recommended
			resolutions.push({
				instanceCFId: result.instanceCF.id,
				instanceCFName: result.instanceCF.name,
				decision,
				trashId: decision === "use_trash" ? result.trashCF?.trash_id : undefined,
				recommendedScore: result.recommendedScore,
				instanceScore: result.instanceCF.score,
			});
		}

		// Add manually included excluded CFs
		for (const cfId of includedExcluded) {
			const result = excludedCFs.find((r) => r.instanceCF.id === cfId);
			if (result) {
				const decision = decisions[result.instanceCF.id] || "keep_instance";
				resolutions.push({
					instanceCFId: result.instanceCF.id,
					instanceCFName: result.instanceCF.name,
					decision,
					trashId: decision === "use_trash" ? result.trashCF?.trash_id : undefined,
					recommendedScore: result.recommendedScore,
					instanceScore: result.instanceCF.score,
				});
			}
		}

		onComplete(resolutions);
	};

	if (isLoading) {
		return (
			<div className="space-y-4">
				<PremiumSkeleton variant="card" className="h-20" />
				<PremiumSkeleton variant="card" className="h-12" style={{ animationDelay: "50ms" }} />
				<div className="space-y-2">
					{Array.from({ length: 5 }).map((_, i) => (
						<PremiumSkeleton
							key={i}
							variant="card"
							className="h-16"
							style={{ animationDelay: `${(i + 2) * 50}ms` }}
						/>
					))}
				</div>
			</div>
		);
	}

	if (error) {
		return (
			<div className="space-y-6">
				<Alert variant="danger">
					<AlertDescription>
						Failed to validate Custom Formats: {error instanceof Error ? error.message : "Unknown error"}
					</AlertDescription>
				</Alert>
				<div className="flex items-center justify-between border-t border-border pt-6">
					<button
						type="button"
						onClick={onBack}
						className="inline-flex items-center gap-2 rounded-lg bg-card px-4 py-2 text-sm font-medium text-foreground transition hover:bg-card"
					>
						<ChevronLeft className="h-4 w-4" />
						Back
					</button>
				</div>
			</div>
		);
	}

	// Guard against undefined data (shouldn't happen after loading/error checks, but just in case)
	if (!data?.results) {
		return (
			<div className="space-y-4">
				<PremiumSkeleton variant="card" className="h-20" />
				<PremiumSkeleton variant="card" className="h-12" style={{ animationDelay: "50ms" }} />
				<div className="space-y-2">
					{Array.from({ length: 5 }).map((_, i) => (
						<PremiumSkeleton
							key={i}
							variant="card"
							className="h-16"
							style={{ animationDelay: `${(i + 2) * 50}ms` }}
						/>
					))}
				</div>
			</div>
		);
	}

	return (
		<div className="space-y-6">
			{/* Header */}
			<div
				className="rounded-xl border p-4"
				style={{
					borderColor: themeGradient.fromMuted,
					backgroundColor: themeGradient.fromLight,
				}}
			>
				<h4 className="font-medium text-foreground mb-2">🔗 Link Custom Formats to TRaSH Guides</h4>
				<p className="text-sm text-foreground/70">
					We found <span className="font-medium text-foreground">{matchStats?.matched || 0}</span> Custom Formats in &quot;{profileName}&quot; that match TRaSH Guides entries.
					{matchStats && matchStats.excludedCount > 0 && (
						<> (<span className="text-amber-400">{matchStats.excludedCount}</span> auto-excluded based on scores/recommendations)</>
					)}
				</p>
				<p className="text-sm text-foreground/60 mt-1">
					Choose which CFs to include in your template and whether to link them (for automatic updates) or keep instance versions.
				</p>
			</div>

			{/* TRaSH Profile Match Banner + Loading State */}
			{(profileMatchData || isLoadingMatch) && (
				<ProfileMatchBanner
					profileMatchData={profileMatchData}
					isLoadingMatch={isLoadingMatch}
					useRecommendations={useRecommendations}
					onToggleRecommendations={() => setUseRecommendations(!useRecommendations)}
				/>
			)}

			{/* Summary Stats */}
			{matchStats && <ResolutionStatistics matchStats={matchStats} />}

			{/* Bulk Actions */}
			<div className="flex flex-wrap items-center gap-2 py-2 border-y border-border">
				<span className="text-xs text-foreground/60 mr-2">Bulk Actions:</span>
				<button
					type="button"
					onClick={() => handleBulkAction("use_trash_all")}
					className="inline-flex items-center gap-1 rounded bg-green-500/20 px-2 py-1 text-xs text-green-300 hover:bg-green-500/30 transition"
				>
					<Link2 className="h-3 w-3" />
					Link All Matched
				</button>
				<button
					type="button"
					onClick={() => handleBulkAction("keep_instance_all")}
					className="inline-flex items-center gap-1 rounded bg-gray-500/20 px-2 py-1 text-xs text-gray-300 hover:bg-gray-500/30 transition"
				>
					<Unlink className="h-3 w-3" />
					Keep All Instance
				</button>
				<button
					type="button"
					onClick={() => handleBulkAction("reset")}
					className="inline-flex items-center gap-1 rounded bg-card px-2 py-1 text-xs text-foreground/70 hover:bg-card transition"
				>
					<RotateCcw className="h-3 w-3" />
					Reset to Defaults
				</button>
			</div>

			{/* Filter and Search */}
			<div className="flex flex-col sm:flex-row gap-3">
				<div className="flex items-center gap-2">
					<Filter className="h-4 w-4 text-foreground/60" />
					<select
						value={filterMode}
						onChange={(e) => setFilterMode(e.target.value as FilterMode)}
						className="rounded border border-border bg-card px-2 py-1 text-sm text-foreground focus:border-primary focus:outline-hidden"
					>
						<option value="all">All ({data?.results?.length ?? 0})</option>
						<option value="matched">Matched ({matchStats?.matched || 0})</option>
						<option value="unmatched">Unmatched ({matchStats?.unmatched || 0})</option>
					</select>
				</div>
				<div className="flex-1 relative">
					<Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-foreground/40" />
					<input
						type="text"
						value={searchQuery}
						onChange={(e) => setSearchQuery(e.target.value)}
						placeholder="Search Custom Formats..."
						className="w-full rounded border border-border bg-card pr-3 py-1 text-sm text-foreground placeholder:text-foreground/40 focus:border-primary focus:outline-hidden"
						style={{ paddingLeft: "2.25rem" }}
					/>
				</div>
			</div>

			{/* Active CF List */}
			<div className="space-y-2">
				<h5 className="text-sm font-medium text-foreground/80 flex items-center gap-2">
					<CheckCircle className="h-4 w-4 text-green-400" />
					Active Custom Formats ({filteredResults.length})
				</h5>
				<div className="space-y-2 max-h-[300px] overflow-y-auto pr-1">
					{filteredResults.length === 0 ? (
						<div className="text-center py-8 text-foreground/60">
							No Custom Formats match your filter criteria.
						</div>
					) : (
						filteredResults.map((result) => (
							<CFResolutionItem
								key={result.instanceCF.id}
								result={result}
								decision={decisions[result.instanceCF.id] || "keep_instance"}
								onDecisionChange={(decision) => handleDecisionChange(result.instanceCF.id, decision)}
								onExclude={() => handleToggleExclusion(result.instanceCF.id, false, shouldBeExcluded(result).excluded)}
							/>
						))
					)}
				</div>
			</div>

			{/* TRaSH Recommended (Not Configured) Section - Collapsible */}
			{filteredRecommendedCFs.length > 0 && (
				<CollapsibleCFSection
					title="TRaSH Recommended - Not Configured"
					count={filteredRecommendedCFs.length}
					icon={Sparkles}
					colorScheme="purple"
					isExpanded={recommendedExpanded}
					onToggle={() => setRecommendedExpanded(!recommendedExpanded)}
					infoBanner={
						<div className="flex items-start gap-2 rounded-lg bg-purple-500/10 p-3 mb-3">
							<Info className="h-4 w-4 text-purple-400 mt-0.5 shrink-0" />
							<div className="text-xs text-purple-200/80">
								<p>
									These Custom Formats exist in your instance but have a <span className="font-medium text-foreground">score of 0</span> in this profile.
									TRaSH Guides recommends enabling them. They will be included in your template with TRaSH&apos;s recommended scores.
								</p>
							</div>
						</div>
					}
				>
					<div className="space-y-2 max-h-[200px] overflow-y-auto pr-1">
						{filteredRecommendedCFs.map((result) => (
							<CFResolutionItem
								key={result.instanceCF.id}
								result={result}
								decision={decisions[result.instanceCF.id] || "use_trash"}
								onDecisionChange={(decision) => handleDecisionChange(result.instanceCF.id, decision)}
								onExclude={() => handleToggleExclusion(result.instanceCF.id, false, false)}
								isRecommended
							/>
						))}
					</div>
				</CollapsibleCFSection>
			)}

			{/* Excluded CFs Section - Collapsible */}
			{filteredExcludedCFs.length > 0 && (
				<CollapsibleCFSection
					title="Excluded Custom Formats"
					count={filteredExcludedCFs.length}
					icon={AlertTriangle}
					colorScheme="amber"
					isExpanded={excludedExpanded}
					onToggle={() => setExcludedExpanded(!excludedExpanded)}
					extraBadge={includedExcluded.size > 0 ? (
						<span className="text-xs bg-green-500/20 text-green-300 px-2 py-0.5 rounded">
							{includedExcluded.size} included
						</span>
					) : undefined}
					infoBanner={
						<div className="flex items-start gap-2 rounded-lg bg-amber-500/10 p-3 mb-3">
							<Info className="h-4 w-4 text-amber-400 mt-0.5 shrink-0" />
							<div className="text-xs text-amber-200/80 space-y-1">
								{matchStats && matchStats.excludedByScore > 0 && (
									<p>
										<span className="font-medium text-amber-300">Score-excluded:</span> CFs with a score of 0 in the source profile
										and TRaSH also recommends a score of 0 (not used for this profile type).
									</p>
								)}
								{useRecommendations && profileMatchData?.matched && matchStats && matchStats.excludedByRec > 0 && (
									<p>
										<span className="font-medium text-purple-300">Recommendation-excluded:</span> CFs not in the recommended list
										for the matched &quot;{profileMatchData.matchedProfile?.name}&quot; profile.
									</p>
								)}
								<p className="text-foreground/60">
									Click <Plus className="h-3 w-3 inline" /> to include any CF in your template.
								</p>
							</div>
						</div>
					}
				>
					<div className="space-y-2 max-h-[200px] overflow-y-auto pr-1">
						{filteredExcludedCFs.map((result) => {
							const cfId = result.instanceCF.id;
							const reason = exclusionReasons[cfId] || "manual";
							const isAutoExcluded = reason === "score" || reason === "recommendation";
							return (
								<ExcludedCFItem
									key={cfId}
									result={result}
									exclusionReason={reason}
									onToggleInclude={() => handleToggleExclusion(cfId, true, isAutoExcluded)}
									decision={decisions[cfId] || "keep_instance"}
									onDecisionChange={(decision) => handleDecisionChange(cfId, decision)}
								/>
							);
						})}
					</div>
				</CollapsibleCFSection>
			)}

			{/* Info about unmatched */}
			{matchStats && matchStats.unmatched > 0 && (
				<div className="flex items-start gap-2 rounded-lg border border-border bg-card p-3">
					<Info className="h-4 w-4 text-foreground/60 mt-0.5 shrink-0" />
					<div className="text-xs text-foreground/60">
						<span className="font-medium text-foreground/80">{matchStats.unmatched} Custom Format{matchStats.unmatched > 1 ? "s" : ""}</span> couldn&apos;t be matched to TRaSH Guides.
						These are likely custom formats you created or from a different source.
						They will be included in the template as-is.
					</div>
				</div>
			)}

			{/* Navigation */}
			<div className="flex items-center justify-between border-t border-border pt-6">
				<button
					type="button"
					onClick={onBack}
					className="inline-flex items-center gap-2 rounded-lg bg-card px-4 py-2 text-sm font-medium text-foreground transition hover:bg-card"
				>
					<ChevronLeft className="h-4 w-4" />
					Back
				</button>

				<button
					type="button"
					onClick={handleContinue}
					className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-foreground transition hover:bg-primary/90"
				>
					Continue
					<ChevronRight className="h-4 w-4" />
				</button>
			</div>
		</div>
	);
};
