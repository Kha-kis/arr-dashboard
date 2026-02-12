"use client";

import type { ReactNode } from "react";
import {
	Sparkles,
	ChevronUp,
	ChevronDown,
} from "lucide-react";
import type { ProfileMatchResult } from "../../../../lib/api-client/trash-guides";
import type { LucideIcon } from "lucide-react";

// ---------- Profile Match Banner ----------

interface ProfileMatchBannerProps {
	profileMatchData?: ProfileMatchResult | null;
	isLoadingMatch: boolean;
	useRecommendations: boolean;
	onToggleRecommendations: () => void;
}

export const ProfileMatchBanner = ({
	profileMatchData,
	isLoadingMatch,
	useRecommendations,
	onToggleRecommendations,
}: ProfileMatchBannerProps) => {
	if (isLoadingMatch) {
		return (
			<div className="rounded-xl border border-border bg-card p-4">
				<div className="flex items-center gap-3">
					<div className="h-5 w-5 rounded-full border-2 border-purple-400 border-t-transparent animate-spin" />
					<span className="text-sm text-foreground/70">Matching profile to TRaSH Guides...</span>
				</div>
			</div>
		);
	}

	if (!profileMatchData) return null;

	return (
		<div className={`rounded-xl border p-4 ${
			profileMatchData.matched
				? "border-purple-500/30 bg-purple-500/5"
				: "border-gray-500/20 bg-gray-500/5"
		}`}>
			<div className="flex items-start justify-between gap-4">
				<div className="flex items-start gap-3">
					<Sparkles className={`h-5 w-5 mt-0.5 shrink-0 ${
						profileMatchData.matched ? "text-purple-400" : "text-gray-400"
					}`} />
					<div>
						{profileMatchData.matched ? (
							<>
								<h5 className="font-medium text-foreground mb-1">
									Matched to TRaSH Profile: <span className="text-purple-300">{profileMatchData.matchedProfile?.name}</span>
								</h5>
								<p className="text-xs text-foreground/70 mb-2">
									{profileMatchData.matchType === "exact" && "Exact name match"}
									{profileMatchData.matchType === "fuzzy" && "Fuzzy name match"}
									{profileMatchData.matchType === "partial" && "Partial name match"}
									{profileMatchData.matchedProfile?.description && (
										<span className="text-foreground/50"> — {profileMatchData.matchedProfile.description}</span>
									)}
								</p>
								{profileMatchData.recommendations && (
									<div className="flex items-center gap-3 text-xs">
										<span className="text-purple-300">
											{profileMatchData.recommendations.total} recommended CFs
										</span>
										<span className="text-foreground/50">•</span>
										<span className="text-foreground/60">
											{profileMatchData.recommendations.mandatory} mandatory
										</span>
										<span className="text-foreground/50">•</span>
										<span className="text-foreground/60">
											{profileMatchData.recommendations.fromGroups} from groups
										</span>
									</div>
								)}
							</>
						) : (
							<>
								<h5 className="font-medium text-foreground/80 mb-1">
									No matching TRaSH Profile found
								</h5>
								<p className="text-xs text-foreground/60">
									{profileMatchData.reason || "Profile name doesn't match any TRaSH Guides quality profiles"}
								</p>
							</>
						)}
					</div>
				</div>
				{/* Toggle for recommendations */}
				{profileMatchData.matched && profileMatchData.recommendations && (
					<div className="flex items-center gap-2 shrink-0">
						<label htmlFor="use-recommendations" className="text-xs text-foreground/70 cursor-pointer">
							Auto-exclude non-recommended
						</label>
						<button
							id="use-recommendations"
							type="button"
							role="switch"
							aria-checked={useRecommendations}
							onClick={onToggleRecommendations}
							className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${
								useRecommendations ? "bg-purple-500" : "bg-muted"
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
	);
};

// ---------- Resolution Statistics ----------

interface ResolutionStatisticsProps {
	matchStats: {
		totalInTemplate: number;
		willBeLinkingToTrash: number;
		willKeepInstance: number;
		activeCount: number;
		recommendedCount: number;
		matched: number;
		unmatched: number;
		excludedCount: number;
		excludedByScore: number;
		excludedByRec: number;
		manuallyExcludedCount: number;
	};
}

export const ResolutionStatistics = ({ matchStats }: ResolutionStatisticsProps) => (
	<div className="space-y-3">
		{/* Row 1: Template Summary - What will actually happen */}
		<div className="rounded-xl border border-primary/30 bg-primary/5 p-4">
			<div className="text-xs text-primary/70 uppercase tracking-wide mb-3 text-center">Template Summary</div>
			<div className="grid grid-cols-3 gap-4">
				<div className="text-center">
					<div className="text-3xl font-bold text-foreground">{matchStats.totalInTemplate}</div>
					<div className="text-xs text-foreground/60">CFs in Template</div>
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
			<div className="rounded-lg border border-border bg-card p-3">
				<div className="text-2xl font-bold text-foreground">{matchStats.activeCount}</div>
				<div className="text-xs text-foreground/60">Active CFs</div>
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
);

// ---------- Collapsible CF Section ----------

interface CollapsibleCFSectionProps {
	/** Section title */
	title: string;
	/** Item count to display */
	count: number;
	/** Icon component */
	icon: LucideIcon;
	/** Color scheme for borders/backgrounds */
	colorScheme: "purple" | "amber";
	/** Whether the section is expanded */
	isExpanded: boolean;
	/** Toggle expanded state */
	onToggle: () => void;
	/** Optional extra badge next to the title */
	extraBadge?: ReactNode;
	/** Optional info banner inside the expanded content */
	infoBanner?: ReactNode;
	/** The section content (list of items) */
	children: ReactNode;
}

const colorStyles = {
	purple: {
		border: "border-purple-500/30",
		bg: "bg-purple-500/5",
		innerBorder: "border-purple-500/20",
		iconColor: "text-purple-400",
		titleColor: "text-purple-300",
	},
	amber: {
		border: "border-amber-500/30",
		bg: "bg-amber-500/5",
		innerBorder: "border-amber-500/20",
		iconColor: "text-amber-400",
		titleColor: "text-amber-300",
	},
};

export const CollapsibleCFSection = ({
	title,
	count,
	icon: Icon,
	colorScheme,
	isExpanded,
	onToggle,
	extraBadge,
	infoBanner,
	children,
}: CollapsibleCFSectionProps) => {
	const styles = colorStyles[colorScheme];

	return (
		<div className={`rounded-lg border ${styles.border} ${styles.bg}`}>
			{/* Section Header */}
			<button
				type="button"
				onClick={onToggle}
				className="w-full flex items-center justify-between p-3 text-left"
			>
				<div className="flex items-center gap-2">
					<Icon className={`h-4 w-4 ${styles.iconColor}`} />
					<span className={`text-sm font-medium ${styles.titleColor}`}>
						{title} ({count})
					</span>
					{extraBadge}
				</div>
				{isExpanded ? (
					<ChevronUp className={`h-4 w-4 ${styles.iconColor}`} />
				) : (
					<ChevronDown className={`h-4 w-4 ${styles.iconColor}`} />
				)}
			</button>

			{/* Section Content */}
			{isExpanded && (
				<div className={`border-t ${styles.innerBorder} p-3`}>
					{infoBanner}
					{children}
				</div>
			)}
		</div>
	);
};
