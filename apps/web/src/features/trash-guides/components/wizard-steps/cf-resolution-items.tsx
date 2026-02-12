/**
 * CF Resolution Sub-Components
 *
 * Extracted from cf-resolution.tsx to reduce file size.
 * Contains rendering components for individual CF items in the resolution step:
 * - CFResolutionItem: Active/recommended CF card with decision toggle
 * - CFComparisonView: Side-by-side instance vs TRaSH comparison
 * - ExcludedCFItem: Excluded CF card with include/expand actions
 */

"use client";

import { useState } from "react";
import {
	ChevronUp,
	CheckCircle,
	AlertCircle,
	Link2,
	Unlink,
	ArrowRight,
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
} from "../../../../lib/api-client/trash-guides";
import { useThemeGradient } from "../../../../hooks/useThemeGradient";
import type { CFResolutionDecision } from "./cf-resolution";

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

export const CFComparisonView = ({ instanceCF, trashCF, matchDetails, recommendedScore, scoreSet }: CFComparisonViewProps) => {
	const instanceSpecs = instanceCF.specifications || [];
	const trashSpecs = trashCF?.specifications || [];

	return (
		<div className="space-y-3 text-xs">
			{/* Score Comparison - matches deployment-preview-modal style */}
			<div className="grid grid-cols-2 gap-3">
				<div className="bg-amber-500/10 rounded-lg p-2.5 border border-amber-500/20">
					<p className="font-semibold text-amber-600 dark:text-amber-400 mb-1.5">Instance:</p>
					<div className="text-foreground">
						<div>Score: <span className="font-bold">{instanceCF.score ?? "Not set"}</span></div>
						<div className="text-foreground/60">{instanceSpecs.length} specification{instanceSpecs.length !== 1 ? "s" : ""}</div>
					</div>
				</div>
				<div className="bg-green-500/10 rounded-lg p-2.5 border border-green-500/20">
					<p className="font-semibold text-green-600 dark:text-green-400 mb-1.5">TRaSH Guides:</p>
					<div className="text-foreground">
						<div>
							Score: <span className="font-bold">{recommendedScore ?? trashCF?.score ?? "N/A"}</span>
							{scoreSet && <span className="text-foreground/60 ml-1">({scoreSet})</span>}
						</div>
						<div className="text-foreground/60">{trashSpecs.length} specification{trashSpecs.length !== 1 ? "s" : ""}</div>
					</div>
					{trashCF?.trash_scores && Object.keys(trashCF.trash_scores).length > 1 && (
						<details className="mt-2">
							<summary className="text-green-400 cursor-pointer hover:text-green-300">
								All score sets ({Object.keys(trashCF.trash_scores).length})
							</summary>
							<div className="mt-1 text-foreground/70 space-y-0.5">
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
					<p className="font-medium text-foreground/80">Specifications:</p>
					<div className="grid grid-cols-2 gap-3">
						<div className="bg-amber-500/10 rounded-lg p-2.5 border border-amber-500/20">
							<p className="font-semibold text-amber-600 dark:text-amber-400 mb-1.5">Instance:</p>
							<pre className="p-2 rounded bg-black/20 overflow-auto max-h-48 whitespace-pre-wrap wrap-break-word text-foreground/70 font-mono text-[10px]">
								{instanceSpecs.length > 0
									? JSON.stringify(instanceSpecs, null, 2)
									: "(no specifications)"}
							</pre>
						</div>
						<div className="bg-green-500/10 rounded-lg p-2.5 border border-green-500/20">
							<p className="font-semibold text-green-600 dark:text-green-400 mb-1.5">TRaSH Guides:</p>
							<pre className="p-2 rounded bg-black/20 overflow-auto max-h-48 whitespace-pre-wrap wrap-break-word text-foreground/70 font-mono text-[10px]">
								{trashSpecs.length > 0
									? JSON.stringify(trashSpecs, null, 2)
									: "(no specifications)"}
							</pre>
						</div>
					</div>
				</div>
			)}

			{/* Match Details Summary - only show meaningful comparisons for instance imports */}
			<div className="flex flex-wrap gap-2 pt-2 border-t border-border">
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

// Individual CF resolution item
interface CFResolutionItemProps {
	result: CFMatchResult;
	decision: CFResolutionDecision;
	onDecisionChange: (decision: CFResolutionDecision) => void;
	onExclude: () => void;
	/** Whether this CF is in the "TRaSH Recommended" section (not configured in instance) */
	isRecommended?: boolean;
}

export const CFResolutionItem = ({ result, decision, onDecisionChange, onExclude, isRecommended }: CFResolutionItemProps) => {
	const { gradient: themeGradient } = useThemeGradient();
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
							: "border-border bg-card"
						: "border-border bg-card opacity-75"
			}`}
		>
			{/* Main Row */}
			<div className="p-3">
				<div className="flex items-start gap-3">
					{/* CF Info */}
					<div className="flex-1 min-w-0">
						<div className="flex items-center gap-2 flex-wrap">
							<span className="font-medium text-foreground truncate">{result.instanceCF.name}</span>
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
									<span
										className="inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-xs"
										style={scoreDiff > 0 ? {
											backgroundColor: themeGradient.fromLight,
											color: themeGradient.from,
											borderColor: themeGradient.fromMuted,
										} : {
											backgroundColor: "rgb(249 115 22 / 0.2)",
											color: "rgb(253 186 116)",
											borderColor: "rgb(249 115 22 / 0.3)",
										}}
									>
										{result.instanceCF.score} → {result.recommendedScore} ({scoreDiff > 0 ? "+" : ""}{scoreDiff})
									</span>
								)
							)}
						</div>

						{/* Match details */}
						{hasMatch && result.trashCF && (
							<div className="mt-1 flex items-center gap-1 text-xs text-foreground/60">
								<ArrowRight className="h-3 w-3" />
								<span>TRaSH: <span className="text-foreground/80">{result.trashCF.name}</span></span>
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
					<div className="flex items-center gap-1 shrink-0">
						{/* Expand/Compare button for matched CFs */}
						{hasComparableData && (
							<button
								type="button"
								onClick={() => setIsExpanded(!isExpanded)}
								className="rounded px-2 py-1 text-xs transition"
								style={isExpanded ? {
									backgroundColor: themeGradient.fromMedium,
									color: themeGradient.from,
								} : {
									backgroundColor: "var(--color-bg-subtle)",
									color: "var(--color-fg-60)",
								}}
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
											: "bg-card text-foreground/60 hover:bg-card"
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
											: "bg-card text-foreground/60 hover:bg-card"
									}`}
									title="Keep instance version (no TRaSH link)"
								>
									<Unlink className="h-3 w-3" />
								</button>
							</>
						)}

						{/* Instance score for unmatched */}
						{!hasMatch && result.instanceCF.score !== undefined && (
							<div className="text-xs text-foreground/60 shrink-0">
								Score: {result.instanceCF.score}
							</div>
						)}
					</div>
				</div>
			</div>

			{/* Expanded Comparison View */}
			{isExpanded && hasComparableData && (
				<div className="border-t border-border p-3 bg-black/20">
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

export const ExcludedCFItem = ({
	result,
	exclusionReason,
	onToggleInclude,
	decision: _decision,
	onDecisionChange: _onDecisionChange,
}: ExcludedCFItemProps) => {
	const { gradient: themeGradient } = useThemeGradient();
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
							<span className="font-medium text-foreground truncate">{result.instanceCF.name}</span>
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
							<div className="mt-1 flex items-center gap-1 text-xs text-foreground/60">
								<ArrowRight className="h-3 w-3" />
								<span>TRaSH: <span className="text-foreground/80">{result.trashCF.name}</span></span>
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
					<div className="flex items-center gap-1 shrink-0">
						{/* Expand/Compare button */}
						{hasComparableData && (
							<button
								type="button"
								onClick={() => setIsExpanded(!isExpanded)}
								className="rounded px-2 py-1 text-xs transition"
								style={isExpanded ? {
									backgroundColor: themeGradient.fromMedium,
									color: themeGradient.from,
								} : {
									backgroundColor: "var(--color-bg-subtle)",
									color: "var(--color-fg-60)",
								}}
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
				<div className="border-t border-border p-3 bg-black/20">
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
