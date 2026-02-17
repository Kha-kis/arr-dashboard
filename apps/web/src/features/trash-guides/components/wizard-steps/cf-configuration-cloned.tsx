/**
 * CF Configuration - Cloned Profile Mode
 *
 * Renders a simplified UI for CFs resolved from the cf-resolution step.
 * This is a render-only component extracted from cf-configuration.tsx.
 */

"use client";

import { ChevronLeft, ChevronRight, RotateCcw, Search } from "lucide-react";
import { Card, CardHeader, CardTitle, CardDescription } from "../../../../components/ui";
import { useThemeGradient } from "../../../../hooks/useThemeGradient";
import type { ResolvedCF } from "./cf-resolution";
import type { CFSelectionState } from "./cf-configuration-types";

interface CFConfigurationClonedProps {
	cfResolutions: ResolvedCF[];
	selections: Record<string, CFSelectionState | undefined>;
	searchQuery: string;
	onSearchQueryChange: (query: string) => void;
	onToggleCF: (cfKey: string) => void;
	onUpdateScore: (cfKey: string, score: string) => void;
	onNext: () => void;
	onBack?: () => void;
}

/**
 * Resolution card for a single CF in cloned profile mode
 */
const ResolutionCard = ({
	resolution,
	selection,
	themeGradient,
	onToggle,
	onUpdateScore,
}: {
	resolution: ResolvedCF;
	selection: CFSelectionState | undefined;
	themeGradient: { from: string; fromLight: string };
	onToggle: () => void;
	onUpdateScore: (score: string) => void;
}) => {
	const scoreOverride = selection?.scoreOverride;
	const defaultScore = resolution.decision === "use_trash"
		? resolution.recommendedScore ?? 0
		: resolution.instanceScore ?? 0;

	return (
		<div className="rounded-lg p-4 border border-border/50 bg-card transition-all hover:border-primary/50 hover:shadow-md">
			<div className="flex items-start gap-3">
				<input
					type="checkbox"
					checked={selection?.selected ?? true}
					onChange={onToggle}
					className="mt-1 h-5 w-5 rounded border-border/50 bg-card text-primary focus:ring-2 focus:ring-primary/50 cursor-pointer transition"
				/>
				<div className="flex-1">
					<div className="flex items-center gap-2 mb-2">
						<span className="font-medium text-foreground">{resolution.instanceCFName}</span>
						{resolution.decision === "use_trash" && resolution.trashId && (
							<span className="inline-flex items-center gap-1 rounded bg-green-500/20 px-2 py-0.5 text-xs font-medium text-green-300">
								Linked to TRaSH
							</span>
						)}
						{resolution.decision === "keep_instance" && (
							<span className="inline-flex items-center gap-1 rounded bg-blue-500/20 px-2 py-0.5 text-xs font-medium text-blue-300">
								Instance Only
							</span>
						)}
						{scoreOverride !== undefined && (
							<span
								className="inline-flex items-center gap-1 rounded px-2 py-0.5 text-xs font-medium"
								style={{
									backgroundColor: themeGradient.fromLight,
									color: themeGradient.from,
								}}
							>
								Custom Score
							</span>
						)}
					</div>

					<div className="space-y-2">
						<div className="flex items-center gap-2 text-xs text-muted-foreground">
							<span>Current: {scoreOverride ?? defaultScore}</span>
							{resolution.decision === "use_trash" && resolution.recommendedScore !== undefined && (
								<span>• TRaSH Recommended: {resolution.recommendedScore}</span>
							)}
							{resolution.instanceScore !== undefined && resolution.instanceScore !== defaultScore && (
								<span>• Instance Score: {resolution.instanceScore}</span>
							)}
						</div>

						<div className="flex items-center gap-2 flex-wrap">
							<label className="text-sm text-muted-foreground">Override Score:</label>
							<input
								type="number"
								value={scoreOverride ?? ""}
								onChange={(e) => onUpdateScore(e.target.value)}
								placeholder={defaultScore.toString()}
								className="w-20 rounded border border-border/50 bg-background px-2 py-1 text-sm text-foreground focus:border-primary focus:outline-hidden focus:ring-1 focus:ring-primary/50 transition"
							/>
							{scoreOverride !== undefined && (
								<button
									type="button"
									onClick={() => onUpdateScore("")}
									className="text-xs text-primary hover:text-primary/80 transition"
									title="Reset to default"
								>
									<RotateCcw className="h-3 w-3 inline mr-1" />
									Reset
								</button>
							)}
						</div>
					</div>
				</div>
			</div>
		</div>
	);
};

/**
 * Cloned profile configuration view
 *
 * Shows CFs resolved from the cf-resolution step grouped by decision type
 * (linked to TRaSH vs instance-only).
 */
export const CFConfigurationCloned = ({
	cfResolutions,
	selections,
	searchQuery,
	onSearchQueryChange,
	onToggleCF,
	onUpdateScore,
	onNext,
	onBack,
}: CFConfigurationClonedProps) => {
	const { gradient: themeGradient } = useThemeGradient();
	const selectedCount = Object.values(selections).filter(s => s?.selected).length;

	// Group resolutions by decision type
	const linkedToTrash = cfResolutions.filter(r => r.decision === "use_trash");
	const keepInstance = cfResolutions.filter(r => r.decision === "keep_instance");

	const searchLower = searchQuery.toLowerCase();
	const filterBySearch = (r: ResolvedCF) =>
		!searchQuery || r.instanceCFName.toLowerCase().includes(searchLower);

	return (
		<div className="space-y-6 animate-in fade-in duration-500">
			{/* Header */}
			<Card className="border-primary/30 bg-primary/5">
				<CardHeader>
					<CardTitle>Configure Custom Format Scores</CardTitle>
					<CardDescription>
						Review and adjust scores for the {cfResolutions.length} custom formats from your profile.
						{selectedCount} formats selected for the template.
					</CardDescription>
				</CardHeader>
			</Card>

			{/* Search */}
			<div className="relative">
				<Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
				<input
					type="text"
					value={searchQuery}
					onChange={(e) => onSearchQueryChange(e.target.value)}
					placeholder="Search custom formats..."
					className="w-full rounded-lg border border-border/50 bg-background py-3 pr-4 text-foreground placeholder:text-muted-foreground focus:border-primary focus:outline-hidden focus:ring-2 focus:ring-primary/20 transition"
					style={{ paddingLeft: "2.5rem" }}
				/>
			</div>

			{/* Linked to TRaSH CFs */}
			{linkedToTrash.length > 0 && (
				<div className="space-y-3">
					<div className="flex items-center justify-between">
						<h3 className="text-lg font-medium text-foreground flex items-center gap-2">
							<span className="w-2 h-2 rounded-full bg-green-500" />
							Linked to TRaSH Guides
						</h3>
						<span className="text-sm text-muted-foreground">{linkedToTrash.length} formats</span>
					</div>
					<p className="text-sm text-muted-foreground">
						These CFs are linked to TRaSH Guides and will receive recommended scores and updates.
					</p>
					<div className="space-y-2">
						{linkedToTrash.filter(filterBySearch).map((resolution) => {
							const cfKey = resolution.trashId || `instance-${resolution.instanceCFId}`;
							return (
								<ResolutionCard
									key={cfKey}
									resolution={resolution}
									selection={selections[cfKey]}
									themeGradient={themeGradient}
									onToggle={() => onToggleCF(cfKey)}
									onUpdateScore={(score) => onUpdateScore(cfKey, score)}
								/>
							);
						})}
					</div>
				</div>
			)}

			{/* Instance Only CFs */}
			{keepInstance.length > 0 && (
				<div className="space-y-3">
					<div className="flex items-center justify-between">
						<h3 className="text-lg font-medium text-foreground flex items-center gap-2">
							<span className="w-2 h-2 rounded-full bg-blue-500" />
							Instance Custom Formats
						</h3>
						<span className="text-sm text-muted-foreground">{keepInstance.length} formats</span>
					</div>
					<p className="text-sm text-muted-foreground">
						These CFs are unique to your instance and will keep their current configuration.
					</p>
					<div className="space-y-2">
						{keepInstance.filter(filterBySearch).map((resolution) => {
							const cfKey = resolution.trashId || `instance-${resolution.instanceCFId}`;
							return (
								<ResolutionCard
									key={cfKey}
									resolution={resolution}
									selection={selections[cfKey]}
									themeGradient={themeGradient}
									onToggle={() => onToggleCF(cfKey)}
									onUpdateScore={(score) => onUpdateScore(cfKey, score)}
								/>
							);
						})}
					</div>
				</div>
			)}

			{/* Navigation Buttons */}
			<div className="flex items-center justify-between pt-4 border-t border-border/50">
				{onBack && (
					<button
						type="button"
						onClick={onBack}
						className="inline-flex items-center gap-2 rounded-lg px-4 py-2 text-muted-foreground hover:text-foreground hover:bg-muted transition"
					>
						<ChevronLeft className="h-4 w-4" />
						Back
					</button>
				)}
				<button
					type="button"
					onClick={onNext}
					disabled={selectedCount === 0}
					className="ml-auto inline-flex items-center gap-2 rounded-lg bg-primary px-6 py-2 font-medium text-primary-fg hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed transition"
				>
					Continue
					<ChevronRight className="h-4 w-4" />
				</button>
			</div>
		</div>
	);
};
