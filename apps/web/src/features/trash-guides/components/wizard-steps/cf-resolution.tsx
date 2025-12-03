"use client";

import { useState, useEffect, useMemo } from "react";
import { useClonedCFValidation, useProfileMatch } from "../../../../hooks/api/useQualityProfiles";
import { Alert, AlertDescription, Skeleton } from "../../../../components/ui";
import {
	ChevronLeft,
	ChevronRight,
	CheckCircle,
	AlertCircle,
	Link2,
	Unlink,
	ArrowRight,
	RotateCcw,
	Info,
	Filter,
	Search,
	ChevronUp,
	ChevronDown,
	GitCompare,
	AlertTriangle,
	Plus,
	Minus,
	Sparkles,
	X,
} from "lucide-react";
import type {
	CFMatchResult,
	MatchConfidence,
	ProfileMatchResult,
} from "../../../../lib/api-client/trash-guides";

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

function getConfidenceBadge(confidence: MatchConfidence) {
	switch (confidence) {
		case "exact":
			return {
				label: "Exact Match",
				className: "bg-green-500/20 text-green-300 border-green-500/30",
				icon: CheckCircle,
			};
		case "name_only":
			return {
				label: "Name Match",
				className: "bg-yellow-500/20 text-yellow-300 border-yellow-500/30",
				icon: Link2,
			};
		case "specs_similar":
			return {
				label: "Specs Similar",
				className: "bg-orange-500/20 text-orange-300 border-orange-500/30",
				icon: Link2,
			};
		case "no_match":
			return {
				label: "No Match",
				className: "bg-gray-500/20 text-gray-300 border-gray-500/30",
				icon: Unlink,
			};
	}
}

/**
 * Determine if a CF should be in the "excluded" section based on score logic
 * Excluded = instance score is 0 AND TRaSH doesn't recommend it (score is also 0)
 * This indicates the CF exists in the instance but isn't configured AND isn't recommended
 *
 * If TRaSH recommends a non-zero score, we DON'T exclude - we want users to see
 * these CFs so they can adopt TRaSH's recommendation when cloning.
 */
function shouldBeExcludedByScore(result: CFMatchResult): boolean {
	// Only applies to matched CFs
	if (result.confidence === "no_match") return false;

	// Check if instance score is 0 and TRaSH also recommends 0 (or no recommendation)
	// This means: not active in instance AND not recommended by TRaSH = exclude
	const instanceScore = result.instanceCF.score ?? 0;
	const trashScore = result.recommendedScore ?? 0;

	// Only exclude if BOTH are 0 - if TRaSH recommends it, keep it active
	const isExcluded = instanceScore === 0 && trashScore === 0;

	return isExcluded;
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
	const shouldBeExcluded = (result: CFMatchResult): { excluded: boolean; reason: "score" | "recommendation" | null } => {
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
	};

	// Initialize decisions from initial resolutions or default based on match confidence
	useEffect(() => {
		if (data?.results && Object.keys(decisions).length === 0) {
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
	}, [data, initialResolutions, decisions]);

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
	}, [data, includedExcluded, manuallyExcluded, useRecommendations, recommendedTrashIds]);

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
				<Skeleton className="h-20" />
				<Skeleton className="h-12" />
				<div className="space-y-2">
					{[1, 2, 3, 4, 5].map((i) => (
						<Skeleton key={i} className="h-16" />
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
				<div className="flex items-center justify-between border-t border-white/10 pt-6">
					<button
						type="button"
						onClick={onBack}
						className="inline-flex items-center gap-2 rounded-lg bg-white/10 px-4 py-2 text-sm font-medium text-white transition hover:bg-white/20"
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
				<Skeleton className="h-20" />
				<Skeleton className="h-12" />
				<div className="space-y-2">
					{[1, 2, 3, 4, 5].map((i) => (
						<Skeleton key={i} className="h-16" />
					))}
				</div>
			</div>
		);
	}

	return (
		<div className="space-y-6">
			{/* Header */}
			<div className="rounded-xl border border-blue-500/20 bg-blue-500/5 p-4">
				<h4 className="font-medium text-white mb-2">🔗 Link Custom Formats to TRaSH Guides</h4>
				<p className="text-sm text-white/70">
					We found <span className="font-medium text-white">{matchStats?.matched || 0}</span> Custom Formats in &quot;{profileName}&quot; that match TRaSH Guides entries.
					{matchStats && matchStats.excludedCount > 0 && (
						<> (<span className="text-amber-400">{matchStats.excludedCount}</span> auto-excluded based on scores/recommendations)</>
					)}
				</p>
				<p className="text-sm text-white/60 mt-1">
					Choose which CFs to include in your template and whether to link them (for automatic updates) or keep instance versions.
				</p>
			</div>

			{/* TRaSH Profile Match Banner */}
			{profileMatchData && (
				<div className={`rounded-xl border p-4 ${
					profileMatchData.matched
						? "border-purple-500/30 bg-purple-500/5"
						: "border-gray-500/20 bg-gray-500/5"
				}`}>
					<div className="flex items-start justify-between gap-4">
						<div className="flex items-start gap-3">
							<Sparkles className={`h-5 w-5 mt-0.5 flex-shrink-0 ${
								profileMatchData.matched ? "text-purple-400" : "text-gray-400"
							}`} />
							<div>
								{profileMatchData.matched ? (
									<>
										<h5 className="font-medium text-white mb-1">
											Matched to TRaSH Profile: <span className="text-purple-300">{profileMatchData.matchedProfile?.name}</span>
										</h5>
										<p className="text-xs text-white/70 mb-2">
											{profileMatchData.matchType === "exact" && "Exact name match"}
											{profileMatchData.matchType === "fuzzy" && "Fuzzy name match"}
											{profileMatchData.matchType === "partial" && "Partial name match"}
											{profileMatchData.matchedProfile?.description && (
												<span className="text-white/50"> — {profileMatchData.matchedProfile.description}</span>
											)}
										</p>
										{profileMatchData.recommendations && (
											<div className="flex items-center gap-3 text-xs">
												<span className="text-purple-300">
													{profileMatchData.recommendations.total} recommended CFs
												</span>
												<span className="text-white/50">•</span>
												<span className="text-white/60">
													{profileMatchData.recommendations.mandatory} mandatory
												</span>
												<span className="text-white/50">•</span>
												<span className="text-white/60">
													{profileMatchData.recommendations.fromGroups} from groups
												</span>
											</div>
										)}
									</>
								) : (
									<>
										<h5 className="font-medium text-white/80 mb-1">
											No matching TRaSH Profile found
										</h5>
										<p className="text-xs text-white/60">
											{profileMatchData.reason || "Profile name doesn't match any TRaSH Guides quality profiles"}
										</p>
									</>
								)}
							</div>
						</div>
						{/* Toggle for recommendations */}
						{profileMatchData.matched && profileMatchData.recommendations && (
							<div className="flex items-center gap-2 flex-shrink-0">
								<label htmlFor="use-recommendations" className="text-xs text-white/70 cursor-pointer">
									Auto-exclude non-recommended
								</label>
								<button
									id="use-recommendations"
									type="button"
									role="switch"
									aria-checked={useRecommendations}
									onClick={() => setUseRecommendations(!useRecommendations)}
									className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${
										useRecommendations ? "bg-purple-500" : "bg-white/20"
									}`}
								>
									<span
										className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform ${
											useRecommendations ? "translate-x-5" : "translate-x-1"
										}`}
									/>
								</button>
							</div>
						)}
					</div>
				</div>
			)}

			{/* Loading state for profile match */}
			{isLoadingMatch && (
				<div className="rounded-xl border border-white/10 bg-white/5 p-4">
					<div className="flex items-center gap-3">
						<div className="h-5 w-5 rounded-full border-2 border-purple-400 border-t-transparent animate-spin" />
						<span className="text-sm text-white/70">Matching profile to TRaSH Guides...</span>
					</div>
				</div>
			)}

			{/* Summary Stats - Two rows for clarity */}
			{matchStats && (
				<div className="space-y-3">
					{/* Row 1: Template Summary - What will actually happen */}
					<div className="rounded-xl border border-primary/30 bg-primary/5 p-4">
						<div className="text-xs text-primary/70 uppercase tracking-wide mb-3 text-center">Template Summary</div>
						<div className="grid grid-cols-3 gap-4">
							<div className="text-center">
								<div className="text-3xl font-bold text-white">{matchStats.totalInTemplate}</div>
								<div className="text-xs text-white/60">CFs in Template</div>
							</div>
							<div className="text-center">
								<div className="text-3xl font-bold text-primary">{matchStats.willBeLinkingToTrash}</div>
								<div className="text-xs text-primary/70">Linking to TRaSH</div>
							</div>
							<div className="text-center">
								<div className="text-3xl font-bold text-gray-400">{matchStats.willKeepInstance}</div>
								<div className="text-xs text-gray-400/70">Keeping Instance</div>
							</div>
						</div>
					</div>

					{/* Row 2: Breakdown Stats */}
					<div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
						<div className="rounded-lg border border-white/10 bg-white/5 p-3">
							<div className="text-2xl font-bold text-white">{matchStats.activeCount}</div>
							<div className="text-xs text-white/60">Active CFs</div>
						</div>
						<div className="rounded-lg border border-purple-500/20 bg-purple-500/5 p-3">
							<div className="text-2xl font-bold text-purple-400">{matchStats.recommendedCount}</div>
							<div className="text-xs text-purple-300/60">TRaSH Suggested</div>
						</div>
						<div className="rounded-lg border border-green-500/20 bg-green-500/5 p-3">
							<div className="text-2xl font-bold text-green-400">{matchStats.matched}</div>
							<div className="text-xs text-green-300/60">Total Matched</div>
						</div>
						<div className="rounded-lg border border-gray-500/20 bg-gray-500/5 p-3">
							<div className="text-2xl font-bold text-gray-400">{matchStats.unmatched}</div>
							<div className="text-xs text-gray-300/60">Custom/Unmatched</div>
						</div>
						<div className="rounded-lg border border-amber-500/20 bg-amber-500/5 p-3">
							<div className="text-2xl font-bold text-amber-400">{matchStats.excludedCount}</div>
							<div className="text-xs text-amber-300/60">
								Excluded
								{matchStats.excludedByScore > 0 && matchStats.excludedByRec > 0 ? (
									<span className="text-gray-400 ml-1">({matchStats.excludedByScore} score, {matchStats.excludedByRec} rec)</span>
								) : matchStats.excludedByScore > 0 ? (
									<span className="text-gray-400 ml-1">({matchStats.excludedByScore} score)</span>
								) : matchStats.excludedByRec > 0 ? (
									<span className="text-gray-400 ml-1">({matchStats.excludedByRec} rec)</span>
								) : matchStats.manuallyExcludedCount > 0 ? (
									<span className="text-gray-400 ml-1">({matchStats.manuallyExcludedCount} manual)</span>
								) : null}
							</div>
						</div>
					</div>
				</div>
			)}

			{/* Bulk Actions */}
			<div className="flex flex-wrap items-center gap-2 py-2 border-y border-white/10">
				<span className="text-xs text-white/60 mr-2">Bulk Actions:</span>
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
					className="inline-flex items-center gap-1 rounded bg-white/10 px-2 py-1 text-xs text-white/70 hover:bg-white/20 transition"
				>
					<RotateCcw className="h-3 w-3" />
					Reset to Defaults
				</button>
			</div>

			{/* Filter and Search */}
			<div className="flex flex-col sm:flex-row gap-3">
				<div className="flex items-center gap-2">
					<Filter className="h-4 w-4 text-white/60" />
					<select
						value={filterMode}
						onChange={(e) => setFilterMode(e.target.value as FilterMode)}
						className="rounded border border-white/20 bg-white/10 px-2 py-1 text-sm text-white focus:border-primary focus:outline-none"
					>
						<option value="all">All ({data?.results?.length ?? 0})</option>
						<option value="matched">Matched ({matchStats?.matched || 0})</option>
						<option value="unmatched">Unmatched ({matchStats?.unmatched || 0})</option>
					</select>
				</div>
				<div className="flex-1 relative">
					<Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-white/40" />
					<input
						type="text"
						value={searchQuery}
						onChange={(e) => setSearchQuery(e.target.value)}
						placeholder="Search Custom Formats..."
						className="w-full rounded border border-white/20 bg-white/10 pl-9 pr-3 py-1 text-sm text-white placeholder:text-white/40 focus:border-primary focus:outline-none"
					/>
				</div>
			</div>

			{/* Active CF List */}
			<div className="space-y-2">
				<h5 className="text-sm font-medium text-white/80 flex items-center gap-2">
					<CheckCircle className="h-4 w-4 text-green-400" />
					Active Custom Formats ({filteredResults.length})
				</h5>
				<div className="space-y-2 max-h-[300px] overflow-y-auto pr-1">
					{filteredResults.length === 0 ? (
						<div className="text-center py-8 text-white/60">
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
				<div className="rounded-lg border border-purple-500/30 bg-purple-500/5">
					{/* Recommended Section Header */}
					<button
						type="button"
						onClick={() => setRecommendedExpanded(!recommendedExpanded)}
						className="w-full flex items-center justify-between p-3 text-left"
					>
						<div className="flex items-center gap-2">
							<Sparkles className="h-4 w-4 text-purple-400" />
							<span className="text-sm font-medium text-purple-300">
								TRaSH Recommended - Not Configured ({filteredRecommendedCFs.length})
							</span>
						</div>
						{recommendedExpanded ? (
							<ChevronUp className="h-4 w-4 text-purple-400" />
						) : (
							<ChevronDown className="h-4 w-4 text-purple-400" />
						)}
					</button>

					{/* Recommended Section Content */}
					{recommendedExpanded && (
						<div className="border-t border-purple-500/20 p-3">
							{/* Info banner */}
							<div className="flex items-start gap-2 rounded-lg bg-purple-500/10 p-3 mb-3">
								<Info className="h-4 w-4 text-purple-400 mt-0.5 flex-shrink-0" />
								<div className="text-xs text-purple-200/80">
									<p>
										These Custom Formats exist in your instance but have a <span className="font-medium text-white">score of 0</span> in this profile.
										TRaSH Guides recommends enabling them. They will be included in your template with TRaSH&apos;s recommended scores.
									</p>
								</div>
							</div>

							{/* Recommended CF List */}
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
						</div>
					)}
				</div>
			)}

			{/* Excluded CFs Section - Collapsible */}
			{filteredExcludedCFs.length > 0 && (
				<div className="rounded-lg border border-amber-500/30 bg-amber-500/5">
					{/* Excluded Section Header */}
					<button
						type="button"
						onClick={() => setExcludedExpanded(!excludedExpanded)}
						className="w-full flex items-center justify-between p-3 text-left"
					>
						<div className="flex items-center gap-2">
							<AlertTriangle className="h-4 w-4 text-amber-400" />
							<span className="text-sm font-medium text-amber-300">
								Excluded Custom Formats ({filteredExcludedCFs.length})
							</span>
							{includedExcluded.size > 0 && (
								<span className="text-xs bg-green-500/20 text-green-300 px-2 py-0.5 rounded">
									{includedExcluded.size} included
								</span>
							)}
						</div>
						{excludedExpanded ? (
							<ChevronUp className="h-4 w-4 text-amber-400" />
						) : (
							<ChevronDown className="h-4 w-4 text-amber-400" />
						)}
					</button>

					{/* Excluded Section Content */}
					{excludedExpanded && (
						<div className="border-t border-amber-500/20 p-3">
							{/* Info banner */}
							<div className="flex items-start gap-2 rounded-lg bg-amber-500/10 p-3 mb-3">
								<Info className="h-4 w-4 text-amber-400 mt-0.5 flex-shrink-0" />
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
									<p className="text-white/60">
										Click <Plus className="h-3 w-3 inline" /> to include any CF in your template.
									</p>
								</div>
							</div>

							{/* Excluded CF List */}
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
						</div>
					)}
				</div>
			)}

			{/* Info about unmatched */}
			{matchStats && matchStats.unmatched > 0 && (
				<div className="flex items-start gap-2 rounded-lg border border-white/10 bg-white/5 p-3">
					<Info className="h-4 w-4 text-white/60 mt-0.5 flex-shrink-0" />
					<div className="text-xs text-white/60">
						<span className="font-medium text-white/80">{matchStats.unmatched} Custom Format{matchStats.unmatched > 1 ? "s" : ""}</span> couldn&apos;t be matched to TRaSH Guides.
						These are likely custom formats you created or from a different source.
						They will be included in the template as-is.
					</div>
				</div>
			)}

			{/* Navigation */}
			<div className="flex items-center justify-between border-t border-white/10 pt-6">
				<button
					type="button"
					onClick={onBack}
					className="inline-flex items-center gap-2 rounded-lg bg-white/10 px-4 py-2 text-sm font-medium text-white transition hover:bg-white/20"
				>
					<ChevronLeft className="h-4 w-4" />
					Back
				</button>

				<button
					type="button"
					onClick={handleContinue}
					className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white transition hover:bg-primary/90"
				>
					Continue
					<ChevronRight className="h-4 w-4" />
				</button>
			</div>
		</div>
	);
};

// Individual CF resolution item
interface CFResolutionItemProps {
	result: CFMatchResult;
	decision: CFResolutionDecision;
	onDecisionChange: (decision: CFResolutionDecision) => void;
	onExclude: () => void;
	/** Whether this CF is in the "TRaSH Recommended" section (not configured in instance) */
	isRecommended?: boolean;
}

const CFResolutionItem = ({ result, decision, onDecisionChange, onExclude, isRecommended }: CFResolutionItemProps) => {
	const [isExpanded, setIsExpanded] = useState(false);
	const badge = getConfidenceBadge(result.confidence);
	const BadgeIcon = badge.icon;
	const hasMatch = result.confidence !== "no_match";
	const scoreDiff = result.recommendedScore !== undefined && result.instanceCF.score !== undefined
		? result.recommendedScore - result.instanceCF.score
		: null;

	// Check if we have spec data to compare
	const instanceSpecs = (result.instanceCF as any).specifications || [];
	const trashSpecs = (result.trashCF as any)?.specifications || [];
	const hasSpecsDiff = result.matchDetails.specsDiffer && result.matchDetails.specsDiffer.length > 0;
	const hasComparableData = hasMatch && (instanceSpecs.length > 0 || trashSpecs.length > 0);

	// Determine spec status for display
	const specsMatch = hasMatch && result.matchDetails.specsMatch;

	return (
		<div
			className={`rounded-lg border transition ${
				isRecommended
					? decision === "use_trash"
						? "border-purple-500/30 bg-purple-500/5"
						: "border-purple-500/20 bg-purple-500/5 opacity-75"
					: hasMatch
						? decision === "use_trash"
							? "border-green-500/30 bg-green-500/5"
							: "border-white/10 bg-white/5"
						: "border-white/10 bg-white/5 opacity-75"
			}`}
		>
			{/* Main Row */}
			<div className="p-3">
				<div className="flex items-start gap-3">
					{/* CF Info */}
					<div className="flex-1 min-w-0">
						<div className="flex items-center gap-2 flex-wrap">
							<span className="font-medium text-white truncate">{result.instanceCF.name}</span>
							<span className={`inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-xs ${badge.className}`}>
								<BadgeIcon className="h-3 w-3" />
								{badge.label}
							</span>
							{/* Show "Not Configured" badge for recommended CFs */}
							{isRecommended && (
								<span className="inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-xs bg-purple-500/20 text-purple-300 border-purple-500/30">
									<Sparkles className="h-3 w-3" />
									Not Configured
								</span>
							)}
							{/* Show specs status badge for all matched CFs */}
							{hasMatch && !isRecommended && (
								hasSpecsDiff ? (
									<span className="inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-xs bg-yellow-500/20 text-yellow-300 border-yellow-500/30">
										<AlertCircle className="h-3 w-3" />
										Specs Differ
									</span>
								) : specsMatch ? (
									<span className="inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-xs bg-green-500/20 text-green-300 border-green-500/30">
										<CheckCircle className="h-3 w-3" />
										Specs Match
									</span>
								) : null
							)}
							{/* Show score status badge */}
							{hasMatch && scoreDiff !== null && (
								isRecommended ? (
									<span className="inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-xs bg-purple-500/20 text-purple-300 border-purple-500/30">
										0 → {result.recommendedScore} (TRaSH)
									</span>
								) : scoreDiff === 0 ? (
									<span className="inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-xs bg-green-500/20 text-green-300 border-green-500/30">
										Score: {result.instanceCF.score}
									</span>
								) : (
									<span className={`inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-xs ${
										scoreDiff > 0 ? "bg-blue-500/20 text-blue-300 border-blue-500/30" : "bg-orange-500/20 text-orange-300 border-orange-500/30"
									}`}>
										{result.instanceCF.score} → {result.recommendedScore} ({scoreDiff > 0 ? "+" : ""}{scoreDiff})
									</span>
								)
							)}
						</div>

						{/* Match details */}
						{hasMatch && result.trashCF && (
							<div className="mt-1 flex items-center gap-1 text-xs text-white/60">
								<ArrowRight className="h-3 w-3" />
								<span>TRaSH: <span className="text-white/80">{result.trashCF.name}</span></span>
							</div>
						)}

						{/* Spec differences warning - clickable to expand */}
						{hasSpecsDiff && !isExpanded && (
							<button
								type="button"
								onClick={() => setIsExpanded(true)}
								className="mt-1 text-xs text-yellow-400/80 hover:text-yellow-300 flex items-center gap-1"
							>
								<GitCompare className="h-3 w-3" />
								View {result.matchDetails.specsDiffer?.length} specification difference{result.matchDetails.specsDiffer?.length !== 1 ? "s" : ""}
							</button>
						)}
					</div>

					{/* Actions */}
					<div className="flex items-center gap-1 flex-shrink-0">
						{/* Expand/Compare button for matched CFs */}
						{hasComparableData && (
							<button
								type="button"
								onClick={() => setIsExpanded(!isExpanded)}
								className={`rounded px-2 py-1 text-xs transition ${
									isExpanded
										? "bg-blue-500/30 text-blue-300"
										: "bg-white/10 text-white/60 hover:bg-white/20"
								}`}
								title={isExpanded ? "Hide comparison" : "View detailed comparison"}
							>
								{isExpanded ? <ChevronUp className="h-3 w-3" /> : <GitCompare className="h-3 w-3" />}
							</button>
						)}

						{/* Exclude button - moves CF to excluded section */}
						<button
							type="button"
							onClick={onExclude}
							className="rounded px-2 py-1 text-xs transition bg-amber-500/20 text-amber-300 hover:bg-amber-500/30"
							title="Exclude from template"
						>
							<Minus className="h-3 w-3" />
						</button>

						{/* Decision Toggle (only for matched CFs) */}
						{hasMatch && (
							<>
								<button
									type="button"
									onClick={() => onDecisionChange("use_trash")}
									className={`rounded px-2 py-1 text-xs transition ${
										decision === "use_trash"
											? "bg-green-500/30 text-green-300"
											: "bg-white/10 text-white/60 hover:bg-white/20"
									}`}
									title="Link to TRaSH Guides (receive updates)"
								>
									<Link2 className="h-3 w-3" />
								</button>
								<button
									type="button"
									onClick={() => onDecisionChange("keep_instance")}
									className={`rounded px-2 py-1 text-xs transition ${
										decision === "keep_instance"
											? "bg-gray-500/30 text-gray-300"
											: "bg-white/10 text-white/60 hover:bg-white/20"
									}`}
									title="Keep instance version (no TRaSH link)"
								>
									<Unlink className="h-3 w-3" />
								</button>
							</>
						)}

						{/* Instance score for unmatched */}
						{!hasMatch && result.instanceCF.score !== undefined && (
							<div className="text-xs text-white/60 flex-shrink-0">
								Score: {result.instanceCF.score}
							</div>
						)}
					</div>
				</div>
			</div>

			{/* Expanded Comparison View */}
			{isExpanded && hasComparableData && (
				<div className="border-t border-white/10 p-3 bg-black/20">
					<CFComparisonView
						instanceCF={result.instanceCF as any}
						trashCF={result.trashCF as any}
						matchDetails={result.matchDetails}
						recommendedScore={result.recommendedScore}
						scoreSet={result.scoreSet}
					/>
				</div>
			)}
		</div>
	);
};

/**
 * Comparison view component - follows the same pattern as deployment-preview-modal
 * and template-diff-modal for consistency
 */
interface CFComparisonViewProps {
	instanceCF: {
		id: number;
		name: string;
		score?: number;
		specifications?: unknown[];
		includeCustomFormatWhenRenaming?: boolean;
	};
	trashCF: {
		trash_id: string;
		name: string;
		score?: number;
		specifications?: unknown[];
		trash_scores?: Record<string, number>;
	} | null;
	matchDetails: {
		nameMatch: boolean;
		specsMatch: boolean;
		specsDiffer?: string[];
	};
	recommendedScore?: number;
	scoreSet?: string;
}

const CFComparisonView = ({ instanceCF, trashCF, matchDetails, recommendedScore, scoreSet }: CFComparisonViewProps) => {
	const instanceSpecs = instanceCF.specifications || [];
	const trashSpecs = trashCF?.specifications || [];

	return (
		<div className="space-y-3 text-xs">
			{/* Score Comparison - matches deployment-preview-modal style */}
			<div className="grid grid-cols-2 gap-3">
				<div className="bg-amber-500/10 rounded-lg p-2.5 border border-amber-500/20">
					<p className="font-semibold text-amber-600 dark:text-amber-400 mb-1.5">Instance:</p>
					<div className="text-white">
						<div>Score: <span className="font-bold">{instanceCF.score ?? "Not set"}</span></div>
						<div className="text-white/60">{instanceSpecs.length} specification{instanceSpecs.length !== 1 ? "s" : ""}</div>
					</div>
				</div>
				<div className="bg-green-500/10 rounded-lg p-2.5 border border-green-500/20">
					<p className="font-semibold text-green-600 dark:text-green-400 mb-1.5">TRaSH Guides:</p>
					<div className="text-white">
						<div>
							Score: <span className="font-bold">{recommendedScore ?? trashCF?.score ?? "N/A"}</span>
							{scoreSet && <span className="text-white/60 ml-1">({scoreSet})</span>}
						</div>
						<div className="text-white/60">{trashSpecs.length} specification{trashSpecs.length !== 1 ? "s" : ""}</div>
					</div>
					{trashCF?.trash_scores && Object.keys(trashCF.trash_scores).length > 1 && (
						<details className="mt-2">
							<summary className="text-green-400 cursor-pointer hover:text-green-300">
								All score sets ({Object.keys(trashCF.trash_scores).length})
							</summary>
							<div className="mt-1 text-white/70 space-y-0.5">
								{Object.entries(trashCF.trash_scores).map(([set, score]) => (
									<div key={set} className={set === scoreSet ? "text-green-300 font-medium" : ""}>
										{set}: {score}
									</div>
								))}
							</div>
						</details>
					)}
				</div>
			</div>

			{/* Specification Comparison - same JSON display pattern as template-diff-modal */}
			{(instanceSpecs.length > 0 || trashSpecs.length > 0) && (
				<div className="space-y-2">
					<p className="font-medium text-white/80">Specifications:</p>
					<div className="grid grid-cols-2 gap-3">
						<div className="bg-amber-500/10 rounded-lg p-2.5 border border-amber-500/20">
							<p className="font-semibold text-amber-600 dark:text-amber-400 mb-1.5">Instance:</p>
							<pre className="p-2 rounded bg-black/20 overflow-auto max-h-48 whitespace-pre-wrap break-words text-white/70 font-mono text-[10px]">
								{instanceSpecs.length > 0
									? JSON.stringify(instanceSpecs, null, 2)
									: "(no specifications)"}
							</pre>
						</div>
						<div className="bg-green-500/10 rounded-lg p-2.5 border border-green-500/20">
							<p className="font-semibold text-green-600 dark:text-green-400 mb-1.5">TRaSH Guides:</p>
							<pre className="p-2 rounded bg-black/20 overflow-auto max-h-48 whitespace-pre-wrap break-words text-white/70 font-mono text-[10px]">
								{trashSpecs.length > 0
									? JSON.stringify(trashSpecs, null, 2)
									: "(no specifications)"}
							</pre>
						</div>
					</div>
				</div>
			)}

			{/* Match Details Summary - only show meaningful comparisons for instance imports */}
			<div className="flex flex-wrap gap-2 pt-2 border-t border-white/10">
				<span className={`rounded px-2 py-1 ${matchDetails.nameMatch ? "bg-green-500/20 text-green-300" : "bg-yellow-500/20 text-yellow-300"}`}>
					Name: {matchDetails.nameMatch ? "Matched" : "Similar"}
				</span>
				<span className={`rounded px-2 py-1 ${matchDetails.specsMatch ? "bg-green-500/20 text-green-300" : "bg-yellow-500/20 text-yellow-300"}`}>
					Specs: {matchDetails.specsMatch ? "Identical" : `${matchDetails.specsDiffer?.length || 0} differences`}
				</span>
			</div>
		</div>
	);
};

/**
 * Excluded CF Item - for CFs that are in the excluded section
 * Shows warning badge, include/exclude toggle, and detailed comparison view
 */
interface ExcludedCFItemProps {
	result: CFMatchResult;
	/** Reason for exclusion: score, recommendation, or manual */
	exclusionReason: "score" | "recommendation" | "manual";
	onToggleInclude: () => void;
	decision: CFResolutionDecision;
	onDecisionChange: (decision: CFResolutionDecision) => void;
}

const ExcludedCFItem = ({
	result,
	exclusionReason,
	onToggleInclude,
	decision,
	onDecisionChange,
}: ExcludedCFItemProps) => {
	const [isExpanded, setIsExpanded] = useState(false);
	const badge = getConfidenceBadge(result.confidence);
	const BadgeIcon = badge.icon;

	// Check if we have spec data to compare
	const instanceSpecs = (result.instanceCF as any).specifications || [];
	const trashSpecs = (result.trashCF as any)?.specifications || [];
	const hasSpecsDiff = result.matchDetails.specsDiffer && result.matchDetails.specsDiffer.length > 0;
	const hasComparableData = instanceSpecs.length > 0 || trashSpecs.length > 0;

	// Determine spec status for display
	const specsMatch = result.matchDetails.specsMatch;

	// Get exclusion badge based on reason
	const getExclusionBadge = () => {
		switch (exclusionReason) {
			case "score":
				return (
					<span className="inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-xs bg-amber-500/20 text-amber-300 border-amber-500/30">
						<AlertTriangle className="h-3 w-3" />
						Score: 0 → {result.recommendedScore}
					</span>
				);
			case "recommendation":
				return (
					<span className="inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-xs bg-purple-500/20 text-purple-300 border-purple-500/30">
						<Sparkles className="h-3 w-3" />
						Not in profile recommendations
					</span>
				);
			case "manual":
				return (
					<span className="inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-xs bg-gray-500/20 text-gray-300 border-gray-500/30">
						<X className="h-3 w-3" />
						Manually excluded
					</span>
				);
		}
	};

	return (
		<div className={`rounded-lg border transition ${
			exclusionReason === "recommendation"
				? "border-purple-500/20 bg-purple-500/5"
				: "border-amber-500/20 bg-amber-500/5"
		}`}>
			<div className="p-3">
				<div className="flex items-start gap-3">
					{/* CF Info */}
					<div className="flex-1 min-w-0">
						<div className="flex items-center gap-2 flex-wrap">
							<span className="font-medium text-white truncate">{result.instanceCF.name}</span>
							<span className={`inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-xs ${badge.className}`}>
								<BadgeIcon className="h-3 w-3" />
								{badge.label}
							</span>
							{/* Specs status badge */}
							{hasSpecsDiff ? (
								<span className="inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-xs bg-yellow-500/20 text-yellow-300 border-yellow-500/30">
									<AlertCircle className="h-3 w-3" />
									Specs Differ
								</span>
							) : specsMatch ? (
								<span className="inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-xs bg-green-500/20 text-green-300 border-green-500/30">
									<CheckCircle className="h-3 w-3" />
									Specs Match
								</span>
							) : null}
							{/* Badge showing why it's excluded */}
							{getExclusionBadge()}
						</div>

						{/* Match details */}
						{result.trashCF && (
							<div className="mt-1 flex items-center gap-1 text-xs text-white/60">
								<ArrowRight className="h-3 w-3" />
								<span>TRaSH: <span className="text-white/80">{result.trashCF.name}</span></span>
							</div>
						)}

						{/* Spec differences warning - clickable to expand */}
						{hasSpecsDiff && !isExpanded && (
							<button
								type="button"
								onClick={() => setIsExpanded(true)}
								className="mt-1 text-xs text-yellow-400/80 hover:text-yellow-300 flex items-center gap-1"
							>
								<GitCompare className="h-3 w-3" />
								View {result.matchDetails.specsDiffer?.length} specification difference{result.matchDetails.specsDiffer?.length !== 1 ? "s" : ""}
							</button>
						)}
					</div>

					{/* Actions */}
					<div className="flex items-center gap-1 flex-shrink-0">
						{/* Expand/Compare button */}
						{hasComparableData && (
							<button
								type="button"
								onClick={() => setIsExpanded(!isExpanded)}
								className={`rounded px-2 py-1 text-xs transition ${
									isExpanded
										? "bg-blue-500/30 text-blue-300"
										: "bg-white/10 text-white/60 hover:bg-white/20"
								}`}
								title={isExpanded ? "Hide comparison" : "View detailed comparison"}
							>
								{isExpanded ? <ChevronUp className="h-3 w-3" /> : <GitCompare className="h-3 w-3" />}
							</button>
						)}

						{/* Include button - moves CF back to active section */}
						<button
							type="button"
							onClick={onToggleInclude}
							className="rounded px-2 py-1 text-xs transition bg-green-500/20 text-green-300 hover:bg-green-500/30"
							title="Include in template"
						>
							<Plus className="h-3 w-3" />
						</button>
					</div>
				</div>
			</div>

			{/* Expanded Comparison View */}
			{isExpanded && hasComparableData && (
				<div className="border-t border-white/10 p-3 bg-black/20">
					<CFComparisonView
						instanceCF={result.instanceCF as any}
						trashCF={result.trashCF as any}
						matchDetails={result.matchDetails}
						recommendedScore={result.recommendedScore}
						scoreSet={result.scoreSet}
					/>
				</div>
			)}
		</div>
	);
};
