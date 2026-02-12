/**
 * CF Configuration Step
 * Refactored: Query logic extracted to useCFConfiguration hook (reduces complexity)
 */

"use client";

import { useState, useEffect, useRef } from "react";
import { Alert, AlertDescription, Card, CardHeader, CardTitle, CardDescription, CardContent } from "../../../../components/ui";
import { PremiumSkeleton } from "../../../../components/layout/premium-components";
import { ChevronLeft, ChevronRight, Info, AlertCircle, Search, Edit, RotateCcw } from "lucide-react";
import { SanitizedHtml } from "../sanitized-html";
import { useThemeGradient } from "../../../../hooks/useThemeGradient";
import type { QualityProfileSummary } from "../../../../lib/api-client/trash-guides";
import { useCFConfiguration } from "../../../../hooks/api/useCFConfiguration";
import type { ResolvedCF } from "./cf-resolution";
import { CFConfigurationCloned } from "./cf-configuration-cloned";
import { CFConfigurationEdit } from "./cf-configuration-edit";
import { AdditionalCFSection, BrowseCFCatalog } from "./cf-configuration-catalog";

interface CustomFormatItem {
	displayName?: string;
	name: string;
	description?: string;
	trash_id?: string;
	[key: string]: unknown;
}

interface CFGroup {
	customFormats: CustomFormatItem[];
	[key: string]: unknown;
}

/**
 * Wizard-specific profile type that allows undefined trashId for edit mode.
 * In edit mode, templates don't persist the original TRaSH profile ID.
 */
type WizardSelectedProfile = Omit<QualityProfileSummary, 'trashId'> & {
	trashId?: string;
};

interface CFConfigurationProps {
	serviceType: "RADARR" | "SONARR";
	qualityProfile: WizardSelectedProfile;
	initialSelections: Record<string, {
		selected: boolean;
		scoreOverride?: number;
		conditionsEnabled: Record<string, boolean>;
	}>;
	onNext: (
		selections: Record<string, {
			selected: boolean;
			scoreOverride?: number;
			conditionsEnabled: Record<string, boolean>;
		}>
	) => void;
	onBack?: () => void; // Optional - undefined means hide back button
	isEditMode?: boolean; // Edit mode flag to skip API call
	editingTemplate?: any; // Template being edited (contains all CF data)
	cfResolutions?: ResolvedCF[]; // CF resolutions from cf-resolution step (for cloned profiles)
}

export const CFConfiguration = ({
	serviceType,
	qualityProfile,
	initialSelections,
	onNext,
	onBack,
	isEditMode = false,
	editingTemplate,
	cfResolutions,
}: CFConfigurationProps) => {
	const { gradient: themeGradient } = useThemeGradient();
	const [selections, setSelections] = useState(initialSelections);
	const [searchQuery, setSearchQuery] = useState("");
	const [conditionEditorFormat, setConditionEditorFormat] = useState<{
		trashId: string;
		format: CustomFormatItem;
	} | null>(null);
	const hasInitializedSelections = useRef(false);

	// Check if we're in cloned profile mode (cfResolutions provided from previous step)
	const isClonedProfileMode = !!cfResolutions && cfResolutions.length > 0;

	// Fetch CF configuration data using extracted hook (skip if we have cfResolutions)
	const { data, isLoading, error } = useCFConfiguration({
		serviceType,
		qualityProfile,
		isEditMode,
		editingTemplate,
	});

	// Initialize selections from cfResolutions (for cloned profiles)
	useEffect(() => {
		if (!isClonedProfileMode || hasInitializedSelections.current) {
			return;
		}

		const newSelections: Record<string, any> = {};

		for (const resolution of cfResolutions) {
			// Use trashId if linked to TRaSH, otherwise use instance CF name as key
			const cfKey = resolution.trashId || `instance-${resolution.instanceCFId}`;
			newSelections[cfKey] = {
				selected: true, // All resolved CFs are selected
				scoreOverride: undefined, // Start with recommended/instance score, user can override
				conditionsEnabled: {},
			};
		}

		hasInitializedSelections.current = true;
		setSelections(newSelections);
	}, [isClonedProfileMode, cfResolutions]);

	// Initialize selections when data loads (one-time only) - for non-cloned profiles
	useEffect(() => {
		if (isClonedProfileMode || !data || hasInitializedSelections.current) {
			return;
		}

		const cfGroups = data.cfGroups || [];
		const mandatoryCFs = data.mandatoryCFs || [];
		const newSelections: Record<string, any> = {};

		// Add mandatory CFs (always selected)
		for (const cf of mandatoryCFs) {
			newSelections[cf.trash_id] = {
				selected: true, // Mandatory CFs always selected
				scoreOverride: undefined,
				conditionsEnabled: {},
			};
		}

		// Build map of all CFs from all CF Groups
		for (const group of cfGroups) {
			const isGroupDefault = group.defaultEnabled === true || group.default === true || group.default === 'true';

			if (Array.isArray(group.custom_formats)) {
				for (const cf of group.custom_formats) {
					const cfTrashId = typeof cf === 'string' ? cf : cf.trash_id;
					const isCFRequired = typeof cf === 'object' && cf.required === true;
					const isCFDefault = typeof cf === 'object' && (cf.default === true || cf.default === 'true' || cf.defaultChecked === true);

					// Auto-select if:
					// 1. Group is default AND CF is required
					// 2. Group is default AND CF has default:true
					// 3. Otherwise, don't auto-select (user chooses in the UI)
					const shouldAutoSelect = isGroupDefault && (isCFRequired || isCFDefault);

					newSelections[cfTrashId] = {
						selected: shouldAutoSelect,
						scoreOverride: undefined,
						conditionsEnabled: {},
					};
				}
			}
		}

		hasInitializedSelections.current = true;
		setSelections(newSelections);
	}, [isClonedProfileMode, data]);

	const toggleCF = (cfTrashId: string, _isRequired: boolean = false) => {
		// Allow toggling all CFs, including required ones
		// "Required" is just a TRaSH recommendation, users have final control
		setSelections((prev) => ({
			...prev,
			[cfTrashId]: {
				selected: !prev[cfTrashId]?.selected,
				scoreOverride: prev[cfTrashId]?.scoreOverride,
				conditionsEnabled: prev[cfTrashId]?.conditionsEnabled || {},
			},
		}));
	};

	const updateScore = (cfTrashId: string, score: string) => {
		const scoreValue = score === "" ? undefined : Number.parseInt(score, 10);
		setSelections((prev) => ({
			...prev,
			[cfTrashId]: {
				selected: prev[cfTrashId]?.selected ?? false,
				scoreOverride: scoreValue,
				conditionsEnabled: prev[cfTrashId]?.conditionsEnabled || {},
			},
		}));
	};

	const selectAllInGroup = (groupCFs: any[]) => {
		setSelections((prev) => {
			const updated = { ...prev };
			for (const cf of groupCFs) {
				// Skip required CFs - they are always selected/deselected with the group
				if (cf.required !== true) {
					updated[cf.trash_id] = {
						selected: true,
						scoreOverride: updated[cf.trash_id]?.scoreOverride,
						conditionsEnabled: updated[cf.trash_id]?.conditionsEnabled || {},
					};
				}
			}
			return updated;
		});
	};

	const deselectAllInGroup = (groupCFs: any[]) => {
		setSelections((prev) => {
			const updated = { ...prev };
			for (const cf of groupCFs) {
				// Skip required CFs - they are always selected/deselected with the group
				if (cf.required !== true) {
					updated[cf.trash_id] = {
						selected: false,
						scoreOverride: updated[cf.trash_id]?.scoreOverride,
						conditionsEnabled: updated[cf.trash_id]?.conditionsEnabled || {},
					};
				}
			}
			return updated;
		});
	};

	const resetScore = (cfTrashId: string) => {
		setSelections((prev) => ({
			...prev,
			[cfTrashId]: {
				selected: prev[cfTrashId]?.selected || false,
				scoreOverride: undefined,
				conditionsEnabled: prev[cfTrashId]?.conditionsEnabled || {},
			},
		}));
	};

	const formatScore = (score: number | undefined, defaultScore?: number) => {
		const displayScore = score ?? defaultScore ?? 0;

		if (displayScore === 0) {
			return (
				<span className="text-muted-foreground">
					0 <span className="text-xs">(neutral)</span>
				</span>
			);
		}

		const color = displayScore > 0
			? "text-green-600 dark:text-green-400"
			: "text-red-600 dark:text-red-400";
		const sign = displayScore > 0 ? "+" : "";

		return <span className={color}>{sign}{displayScore}</span>;
	};

	const updateSelection = (cfTrashId: string, update: Partial<{ selected: boolean; scoreOverride: number | undefined; conditionsEnabled: Record<string, boolean> }>) => {
		setSelections((prev) => ({
			...prev,
			[cfTrashId]: {
				...prev[cfTrashId],
				selected: prev[cfTrashId]?.selected ?? false,
				conditionsEnabled: prev[cfTrashId]?.conditionsEnabled || {},
				...update,
			},
		}));
	};

	const handleNext = () => {
		// Pass selections to the next step (Summary/Review)
		// Template naming is now handled in the Review step
		onNext(selections);
	};

	// For cloned profile mode, skip loading state (we have cfResolutions)
	if (!isClonedProfileMode && isLoading) {
		return (
			<div className="space-y-6 animate-in fade-in duration-300">
				{/* Header Skeleton */}
				<div className="space-y-3">
					<PremiumSkeleton variant="line" className="h-8 w-3/4" />
					<PremiumSkeleton variant="line" className="h-4 w-full" style={{ animationDelay: "50ms" }} />
					<PremiumSkeleton variant="line" className="h-4 w-5/6" style={{ animationDelay: "100ms" }} />
				</div>

				{/* Search Bar Skeleton */}
				<PremiumSkeleton variant="card" className="h-12 w-full" style={{ animationDelay: "150ms" }} />

				{/* Mandatory CFs Skeleton */}
				<div className="space-y-3">
					<PremiumSkeleton variant="line" className="h-6 w-48" style={{ animationDelay: "200ms" }} />
					<div className="space-y-2">
						<PremiumSkeleton variant="card" className="h-24 w-full" style={{ animationDelay: "250ms" }} />
						<PremiumSkeleton variant="card" className="h-24 w-full" style={{ animationDelay: "300ms" }} />
					</div>
				</div>

				{/* Optional CF Groups Skeleton */}
				<div className="space-y-3">
					<PremiumSkeleton variant="line" className="h-6 w-56" style={{ animationDelay: "350ms" }} />
					<PremiumSkeleton variant="card" className="h-48 w-full" style={{ animationDelay: "400ms" }} />
					<PremiumSkeleton variant="card" className="h-48 w-full" style={{ animationDelay: "450ms" }} />
				</div>
			</div>
		);
	}

	if (!isClonedProfileMode && error) {
		return (
			<div className="animate-in fade-in duration-300">
				<Alert variant="danger">
					<AlertCircle className="h-4 w-4" />
					<AlertDescription>
						{error instanceof Error
							? error.message
							: "Failed to load quality profile details"}
					</AlertDescription>
				</Alert>
			</div>
		);
	}

	// === CLONED PROFILE MODE ===
	// Delegates to extracted component for CFs resolved from the previous step
	if (isClonedProfileMode && cfResolutions) {
		return (
			<CFConfigurationCloned
				cfResolutions={cfResolutions}
				selections={selections}
				searchQuery={searchQuery}
				onSearchQueryChange={setSearchQuery}
				onToggleCF={toggleCF}
				onUpdateScore={updateScore}
				onNext={handleNext}
				onBack={onBack}
			/>
		);
	}

	const cfGroups = data?.cfGroups || [];
	const mandatoryCFs = data?.mandatoryCFs || [];
	const selectedCount = Object.values(selections).filter(s => s?.selected).length;
	const isClonedProfile = data?.isClonedProfile === true;

	// Build CF Groups with their CFs
	// CF Groups already have enriched data from the API
	// Get score set from quality profile to read correct scores from trash_scores
	const scoreSet = qualityProfile.scoreSet || 'default';

	// Helper to resolve score from trash_scores using profile's score set
	// Priority: trash_scores[scoreSet] → trash_scores.default → fallback → 0
	const resolveScore = (cf: any, fallback?: number): number => {
		const trashScores = cf.originalConfig?.trash_scores ?? cf.trash_scores;
		return trashScores?.[scoreSet] ?? trashScores?.default ?? fallback ?? 0;
	};

	const groupedCFs = cfGroups.map((group: any) => {
		const cfs = Array.isArray(group.custom_formats) ? group.custom_formats : [];
		return {
			...group,
			customFormats: cfs.map((cf: any) => ({
				trash_id: cf.trash_id,
				name: cf.name,
				displayName: cf.displayName || cf.name,
				description: cf.description,
				score: resolveScore(cf, cf.score),
				isRequired: cf.required === true,
				source: cf.source,
			})),
		};
	});

	// Filter CFs and groups based on search query
	const searchLower = searchQuery.toLowerCase().trim();
	const filteredGroupedCFs = searchLower
		? groupedCFs.map((group: CFGroup) => ({
				...group,
				customFormats: group.customFormats.filter((cf: CustomFormatItem) =>
					(cf.displayName?.toLowerCase().includes(searchLower) ?? false) ||
					cf.name.toLowerCase().includes(searchLower) ||
					(cf.description?.toLowerCase().includes(searchLower) ?? false)
				),
			})).filter((group: CFGroup) => group.customFormats.length > 0)
		: groupedCFs;

	const filteredMandatoryCFs = searchLower
		? mandatoryCFs.filter((cf: CustomFormatItem) =>
				(cf.displayName?.toLowerCase().includes(searchLower) ?? false) ||
				cf.name.toLowerCase().includes(searchLower) ||
				cf.description?.toLowerCase().includes(searchLower)
			)
		: mandatoryCFs;

	// Edit mode delegates to extracted component
	if (isEditMode) {
		return (
			<CFConfigurationEdit
				qualityProfile={qualityProfile}
				selections={selections}
				onSelectionsChange={setSelections}
				selectedCount={selectedCount}
				mandatoryCFs={mandatoryCFs}
				cfGroups={cfGroups}
				availableFormats={data?.availableFormats}
				searchQuery={searchQuery}
				onToggleCF={toggleCF}
				onUpdateScore={updateScore}
				resolveScore={resolveScore}
				onNext={handleNext}
				onBack={onBack}
				conditionEditorFormat={conditionEditorFormat}
				onConditionEditorOpen={setConditionEditorFormat}
				onConditionEditorClose={() => setConditionEditorFormat(null)}
			/>
		);
	}

	return (
		<div className="space-y-6 animate-in fade-in duration-500">
			{/* Profile Summary */}
			<Card className="transition-all hover:shadow-lg">
				<CardHeader>
					<CardTitle>{qualityProfile.name}</CardTitle>
					<CardDescription>
						{isEditMode
							? `Browse and add custom formats to your template. ${selectedCount} custom formats selected.`
							: `Configure custom formats and create your template. ${selectedCount} custom formats selected.`
						}
					</CardDescription>
				</CardHeader>
			</Card>

			{/* Search Bar */}
			<div className="relative">
				<Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
				<input
					type="text"
					value={searchQuery}
					onChange={(e) => setSearchQuery(e.target.value)}
					placeholder="Search custom formats by name or description..."
					className="w-full rounded-lg border border-border/50 bg-card pr-4 py-2.5 text-sm text-foreground placeholder:text-muted-foreground focus:border-primary focus:outline-hidden focus:ring-2 focus:ring-primary/20 transition"
					style={{ paddingLeft: "2.5rem" }}
				/>
				{searchQuery && (
					<button
						type="button"
						onClick={() => setSearchQuery("")}
						className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-muted-foreground hover:text-foreground transition"
					>
						Clear
					</button>
				)}
			</div>

			{/* Search Results Info */}
			{searchQuery && (
				<div className="animate-in fade-in slide-in-from-top-2 duration-300">
					<Alert>
						<Info className="h-4 w-4" />
						<AlertDescription>
							Found {filteredMandatoryCFs.length + filteredGroupedCFs.reduce((acc: number, g: CFGroup) => acc + g.customFormats.length, 0)} custom formats matching &quot;{searchQuery}&quot;
						</AlertDescription>
					</Alert>
				</div>
			)}

			{/* Introduction */}
			{!searchQuery && (
				<Alert>
					<Info className="h-4 w-4" />
					<AlertDescription>
						{isClonedProfile ? (
							<>
								<strong>Custom Formats from Instance</strong> - These are the custom formats configured in your source instance&apos;s quality profile. You can adjust scores, toggle formats, or add additional formats from the instance&apos;s catalog.
							</>
						) : (
							<>
								<strong>TRaSH Recommended Formats</strong> are marked with ⭐ but can be toggled on/off based on your preferences. <strong>CF Groups</strong> can be toggled individually or in bulk. Browse all available formats below to add any additional custom formats.
							</>
						)}
					</AlertDescription>
				</Alert>
			)}

			{/* Profile Custom Formats (TRaSH Recommended or Instance CFs) */}
			{filteredMandatoryCFs.length > 0 && (
				<Card className={isClonedProfile ? "border-blue-500/30 bg-blue-500/5" : "border-amber-500/30 bg-amber-500/5"}>
					<CardHeader>
						<CardTitle className="flex items-center gap-2">
							{isClonedProfile ? (
								<span className="inline-flex items-center gap-1 rounded bg-blue-500/20 px-2 py-1 text-sm font-medium text-blue-300">
									📦 Instance Custom Formats
								</span>
							) : (
								<span className="inline-flex items-center gap-1 rounded bg-amber-500/20 px-2 py-1 text-sm font-medium text-amber-300">
									⭐ TRaSH Recommended Formats
								</span>
							)}
							<span className="text-sm font-normal text-muted-foreground">
								({filteredMandatoryCFs.length}{searchQuery ? ` of ${mandatoryCFs.length}` : ""} formats)
							</span>
						</CardTitle>
						<CardDescription>
							{isClonedProfile
								? "These custom formats are configured in the source instance's quality profile. You can toggle them on/off and override their scores."
								: "These custom formats are recommended by TRaSH Guides for this quality profile. You can toggle them on/off and override their scores."
							}
						</CardDescription>
					</CardHeader>
					<CardContent>
						<div className="space-y-2">
							{filteredMandatoryCFs.map((cf: any) => {
								const isSelected = selections[cf.trash_id]?.selected ?? true;
								const scoreOverride = selections[cf.trash_id]?.scoreOverride;
								const displayScore = resolveScore(cf, cf.defaultScore ?? cf.score);

								return (
									<div
										key={cf.trash_id}
										className={`rounded-lg p-4 border transition-all hover:shadow-md ${
											isClonedProfile
												? "border-blue-500/30 bg-blue-500/10 hover:border-blue-500/50 hover:bg-blue-500/15"
												: "border-amber-500/30 bg-amber-500/10 hover:border-amber-500/50 hover:bg-amber-500/15"
										}`}
									>
										<div className="flex items-start gap-3">
											<input
												type="checkbox"
												checked={isSelected}
												onChange={() => toggleCF(cf.trash_id, false)}
												className="mt-1 h-5 w-5 rounded border-border/50 bg-card text-primary focus:ring-2 focus:ring-primary/50 cursor-pointer transition"
											/>
											<div className="flex-1">
												<div className="flex items-center gap-2 mb-2">
													<span className="font-medium text-foreground">{cf.displayName || cf.name}</span>
													{isClonedProfile ? (
														<span className="inline-flex items-center gap-1 rounded bg-blue-500/20 px-2 py-0.5 text-xs font-medium text-blue-300" title="From source instance">
															Score: {displayScore}
														</span>
													) : (
														<span className="inline-flex items-center gap-1 rounded bg-amber-500/20 px-2 py-0.5 text-xs font-medium text-amber-300" title="TRaSH Guides recommends this format">
															⭐ Recommended
														</span>
													)}
												</div>

												{cf.description && (
													<details className="mb-2 group" onClick={(e) => e.stopPropagation()}>
														<summary className="cursor-pointer text-xs text-primary hover:text-primary/80 transition flex items-center gap-1">
															<span className="group-open:rotate-90 transition-transform">▶</span>
															<span>What is this?</span>
														</summary>
														<div className="mt-2 pl-4 text-sm text-muted-foreground prose prose-invert prose-sm max-w-none">
															<SanitizedHtml html={cf.description} />
														</div>
													</details>
												)}

												<div className="flex items-center gap-2">
													<label className="text-xs text-muted-foreground">
														Score:
														{scoreOverride === undefined && (
															<span className="ml-1">(default: {formatScore(displayScore)})</span>
														)}
													</label>
													<input
														type="number"
														value={scoreOverride ?? displayScore}
														onChange={(e) => updateScore(cf.trash_id, e.target.value)}
														min={-10000}
														max={10000}
														className={`w-24 rounded border px-2 py-1 text-sm text-foreground focus:outline-none focus:ring-1 ${
															scoreOverride !== undefined
																? "border-primary ring-1 ring-primary/20 bg-primary/5"
																: "border-border bg-muted"
														}`}
														onClick={(e) => e.stopPropagation()}
													/>
													{scoreOverride !== undefined && (
														<>
															<span title="Custom score">
																<Edit className="h-3 w-3 text-primary" />
															</span>
															<button
																type="button"
																onClick={() => resetScore(cf.trash_id)}
																className="flex items-center gap-1 text-xs text-muted-foreground hover:text-primary transition"
																title="Reset to default"
															>
																<RotateCcw className="h-3 w-3" />
															</button>
														</>
													)}
												</div>
											</div>
										</div>
									</div>
								);
							})}
						</div>
					</CardContent>
				</Card>
			)}


			{/* Optional CF Groups */}
			{!isEditMode && filteredGroupedCFs.length > 0 && (
				<div className="space-y-4">
					<div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
						<h3 className="text-lg font-semibold text-foreground">
							<span className="flex flex-col sm:inline-flex sm:items-center sm:gap-2">
								<span>Optional Custom Format Groups</span>
								<span className="text-sm font-normal text-muted-foreground">
									(Select groups and formats based on your preferences)
								</span>
							</span>
						</h3>
						<span className="text-sm text-muted-foreground whitespace-nowrap">
							{filteredGroupedCFs.length}{searchQuery ? ` of ${groupedCFs.length}` : ""} groups {searchQuery ? "matching" : "available"}
						</span>
					</div>

					{filteredGroupedCFs.map((group: any) => {
						const groupCFs = group.customFormats || [];
						const selectedInGroup = groupCFs.filter((cf: any) =>
							selections[cf.trash_id]?.selected
						).length;
						const isGroupDefault = group.default === true || group.default === 'true' || group.defaultEnabled === true;
						const isGroupRequired = group.required === true;

						return (
							<Card key={group.trash_id} className={`transition-all hover:shadow-lg ${
								isGroupDefault
									? "border-amber-500/50! bg-amber-500/10!"
									: isGroupRequired
										? "border-red-500/50! bg-red-500/10!"
										: "hover:border-primary/20"
							}`}>
								<CardHeader>
									<div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
										<div className="flex items-center gap-3">
											<input
												type="checkbox"
												checked={selectedInGroup === groupCFs.length}
												ref={(el) => {
													if (el) {
														el.indeterminate = selectedInGroup > 0 && selectedInGroup < groupCFs.length;
													}
												}}
												onChange={(e) => {
													if (e.target.checked) {
														selectAllInGroup(groupCFs);
													} else {
														deselectAllInGroup(groupCFs);
													}
												}}
												className="h-5 w-5 rounded border-border bg-muted text-primary focus:ring-primary cursor-pointer"
												title={selectedInGroup === groupCFs.length ? "Deselect all formats in this group" : "Select all formats in this group"}
											/>
											<div className="flex items-center gap-2 flex-wrap">
												<CardTitle className="text-base sm:text-lg">{group.name}</CardTitle>
												{isGroupDefault && (
													<span className="inline-flex items-center gap-1 rounded bg-amber-500/20 px-2 py-0.5 text-xs font-medium text-amber-300" title="TRaSH Guides recommends this group">
														⭐ Recommended
													</span>
												)}
												{!isGroupDefault && !isGroupRequired && (
													<span
														className="inline-flex items-center gap-1 rounded px-2 py-0.5 text-xs font-medium"
														style={{
															backgroundColor: themeGradient.fromLight,
															color: themeGradient.from,
														}}
													>
														⚙️ Optional
													</span>
												)}
											</div>
										</div>
										<div className="flex gap-2 text-xs text-muted-foreground items-center">
											<span>{selectedInGroup} of {groupCFs.length} selected</span>
										</div>
									</div>


									{group.trash_description && (
										<div
											className="rounded-lg border p-3 mt-2"
											style={{
												borderColor: themeGradient.fromMuted,
												backgroundColor: themeGradient.fromLight,
											}}
										>
											<div className="flex items-start gap-2">
												<AlertCircle className="h-4 w-4 mt-0.5 shrink-0" style={{ color: themeGradient.from }} />
												<SanitizedHtml
													html={group.trash_description}
													className="text-sm"
													style={{ color: themeGradient.from }}
												/>
											</div>
										</div>
									)}
								</CardHeader>

								<CardContent>
										<div className="space-y-2">
											{groupCFs.map((cf: any) => {
											const isSelected = selections[cf.trash_id]?.selected ?? false;
											const scoreOverride = selections[cf.trash_id]?.scoreOverride;
											const isCFRequired = cf.required === true;
											const isCFDefault = cf.default === true || cf.default === 'true' || cf.defaultChecked === true;

											return (
												<div
													key={cf.trash_id}
													className={`rounded-lg p-3 border transition-all duration-200 hover:shadow-md ${
														isSelected
															? "bg-primary/10 border-primary/30 hover:border-primary/50"
															: "bg-muted border-border/50 hover:border-border hover:bg-accent"
													}`}
												>
													<div className="flex items-start gap-3">
														<input
															type="checkbox"
															checked={isSelected}
															onChange={() => toggleCF(cf.trash_id, false)}
															className="mt-1 h-5 w-5 rounded border-border bg-muted text-primary focus:ring-primary cursor-pointer"
														/>
														<div className="flex-1">
															<div className="flex items-center gap-2 flex-wrap mb-2">
																<span className="font-medium text-foreground">{cf.displayName || cf.name}</span>
																{isCFRequired && (
																	<span className="inline-flex items-center gap-1 rounded bg-amber-500/20 px-2 py-0.5 text-xs font-medium text-amber-300" title="TRaSH Guides recommends this format">
																		⭐ Recommended
																	</span>
																)}
																{!isCFRequired && isCFDefault && (
																	<span className="inline-flex items-center gap-1 rounded bg-green-500/20 px-2 py-0.5 text-xs font-medium text-green-300" title="TRaSH Guides recommends this as a default selection">
																		✅ Default
																	</span>
																)}
																{cf.includeCustomFormatWhenRenaming && (
																	<span className="inline-flex items-center gap-1 rounded bg-amber-500/20 px-2 py-0.5 text-xs font-medium text-amber-300">
																		📝 Affects Naming
																	</span>
																)}
																{cf.specifications && cf.specifications.length > 0 && (
																	<span className="inline-flex items-center gap-1 rounded bg-gray-500/20 px-2 py-0.5 text-xs font-medium text-gray-300">
																		{cf.specifications.length} {cf.specifications.length === 1 ? 'condition' : 'conditions'}
																	</span>
																)}
															</div>

															{cf.description && (
																<details className="mb-2 group" onClick={(e) => e.stopPropagation()}>
																	<summary className="cursor-pointer text-xs text-primary hover:text-primary/80 transition flex items-center gap-1">
																		<span className="group-open:rotate-90 transition-transform">▶</span>
																		<span>What is this?</span>
																	</summary>
																	<div className="mt-2 pl-4 text-sm text-muted-foreground prose prose-invert prose-sm max-w-none">
																		<SanitizedHtml html={cf.description} />
																	</div>
																</details>
															)}

															{isSelected && (
																<div className="flex flex-col sm:flex-row sm:items-center gap-2">
																	<label className="text-xs text-muted-foreground whitespace-nowrap">
																		Score:
																		{scoreOverride === undefined && (
																			<span className="ml-1">(default: {formatScore(cf.score)})</span>
																		)}
																	</label>
																	<div className="flex items-center gap-2">
																		<input
																			type="number"
																			value={scoreOverride ?? cf.score ?? 0}
																			onChange={(e) => updateScore(cf.trash_id, e.target.value)}
																			min={-10000}
																			max={10000}
																			className={`w-full sm:w-24 rounded border px-2 py-1 text-sm text-foreground focus:outline-none focus:ring-1 ${
																				scoreOverride !== undefined
																					? "border-primary ring-1 ring-primary/20 bg-primary/5"
																					: "border-border bg-muted"
																			}`}
																			onClick={(e) => e.stopPropagation()}
																		/>
																		{scoreOverride !== undefined && (
																			<>
																				<span title="Custom score">
																					<Edit className="h-3 w-3 text-primary" />
																				</span>
																				<button
																					type="button"
																					onClick={() => resetScore(cf.trash_id)}
																					className="flex items-center gap-1 text-xs text-muted-foreground hover:text-primary transition whitespace-nowrap"
																					title="Reset to default"
																				>
																					<RotateCcw className="h-3 w-3" />
																				</button>
																			</>
																		)}
																	</div>
																</div>
															)}
														</div>
													</div>
												</div>
												);
											})}
										</div>
								</CardContent>
							</Card>
						);
					})}
				</div>
			)}

			{/* Additional Custom Formats - Selected from Browse */}
			<AdditionalCFSection
				data={data}
				selections={selections}
				onToggleCF={(trashId) => toggleCF(trashId)}
				onUpdateSelection={updateSelection}
				resolveScore={resolveScore}
			/>

			{/* Browse All Custom Formats */}
			<BrowseCFCatalog
				data={data}
				selections={selections}
				onToggleCF={(trashId) => toggleCF(trashId)}
				onUpdateSelection={updateSelection}
				resolveScore={resolveScore}
				searchQuery={searchQuery}
				isClonedProfile={isClonedProfile}
				themeGradient={themeGradient}
			/>

			{/* Navigation */}
			<div className={`flex flex-col-reverse sm:flex-row sm:items-center gap-3 border-t border-border pt-6 ${onBack ? 'sm:justify-between' : 'sm:justify-end'}`}>
				{onBack && (
					<button
						type="button"
						onClick={onBack}
						className="inline-flex items-center justify-center gap-2 rounded-lg bg-muted px-4 py-2.5 text-sm font-medium text-foreground transition hover:bg-accent disabled:opacity-50"
					>
						<ChevronLeft className="h-4 w-4" />
						<span>Back</span>
					</button>
				)}

				<button
					type="button"
					onClick={handleNext}
					disabled={selectedCount === 0}
					className="inline-flex items-center justify-center gap-2 rounded-lg bg-primary px-4 py-2.5 text-sm font-medium text-primary-fg transition hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed"
				>
					<span>Next: Review</span>
					<ChevronRight className="h-4 w-4" />
				</button>
			</div>
		</div>
	);
};
