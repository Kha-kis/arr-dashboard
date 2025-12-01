/**
 * CF Configuration Step
 * Refactored: Query logic extracted to useCFConfiguration hook (reduces complexity)
 */

"use client";

import { useState, useEffect, useRef } from "react";
import { Alert, AlertDescription, Skeleton, Card, CardHeader, CardTitle, CardDescription, CardContent } from "../../../../components/ui";
import { ChevronLeft, ChevronRight, Info, AlertCircle, Search, ChevronDown, Lock, Edit, RotateCcw, Settings } from "lucide-react";
import { createSanitizedHtml } from "../../../../lib/sanitize-html";
import type { QualityProfileSummary } from "../../../../lib/api-client/trash-guides";
import { ConditionEditor } from "../condition-editor";
import { useCFConfiguration } from "../../../../hooks/api/useCFConfiguration";
import { ErrorBoundary } from "../../../../components/error-boundary";

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
	templateName: string;
	templateDescription: string;
	onNext: (
		selections: Record<string, {
			selected: boolean;
			scoreOverride?: number;
			conditionsEnabled: Record<string, boolean>;
		}>,
		name: string,
		description: string
	) => void;
	onBack?: () => void; // Optional - undefined means hide back button
	isEditMode?: boolean; // Edit mode flag to skip API call
	editingTemplate?: any; // Template being edited (contains all CF data)
}

export const CFConfiguration = ({
	serviceType,
	qualityProfile,
	initialSelections,
	templateName: initialTemplateName,
	templateDescription: initialTemplateDescription,
	onNext,
	onBack,
	isEditMode = false,
	editingTemplate,
}: CFConfigurationProps) => {
	const [selections, setSelections] = useState(initialSelections);
	const [templateName, setTemplateName] = useState(initialTemplateName);
	const [templateDescription, setTemplateDescription] = useState(initialTemplateDescription);
	const [searchQuery, setSearchQuery] = useState("");
	const [conditionEditorFormat, setConditionEditorFormat] = useState<{
		trashId: string;
		format: CustomFormatItem;
	} | null>(null);
	const hasInitializedSelections = useRef(false);

	// Fetch CF configuration data using extracted hook
	const { data, isLoading, error } = useCFConfiguration({
		serviceType,
		qualityProfile,
		isEditMode,
		editingTemplate,
	});

	// Initialize selections when data loads (one-time only)
	useEffect(() => {
		if (!data || hasInitializedSelections.current) {
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
	}, [data]);

	const toggleCF = (cfTrashId: string, isRequired: boolean = false) => {
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
				<span className="text-fg-muted">
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

	const handleNext = () => {
		if (!templateName.trim()) return;

		// Pass selections and template info to the next step (Summary/Review)
		onNext(selections, templateName.trim(), templateDescription.trim());
	};

	if (isLoading) {
		return (
			<div className="space-y-6 animate-in fade-in duration-300">
				{/* Header Skeleton */}
				<div className="space-y-3">
					<Skeleton className="h-8 w-3/4 animate-pulse" />
					<Skeleton className="h-4 w-full animate-pulse delay-75" />
					<Skeleton className="h-4 w-5/6 animate-pulse delay-100" />
				</div>

				{/* Search Bar Skeleton */}
				<Skeleton className="h-12 w-full animate-pulse delay-150" />

				{/* Mandatory CFs Skeleton */}
				<div className="space-y-3">
					<Skeleton className="h-6 w-48 animate-pulse delay-200" />
					<div className="space-y-2">
						<Skeleton className="h-24 w-full animate-pulse delay-250" />
						<Skeleton className="h-24 w-full animate-pulse delay-300" />
					</div>
				</div>

				{/* Optional CF Groups Skeleton */}
				<div className="space-y-3">
					<Skeleton className="h-6 w-56 animate-pulse delay-350" />
					<Skeleton className="h-48 w-full animate-pulse delay-400" />
					<Skeleton className="h-48 w-full animate-pulse delay-450" />
				</div>
			</div>
		);
	}

	if (error) {
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

	const cfGroups = data?.cfGroups || [];
	const mandatoryCFs = data?.mandatoryCFs || [];
	const selectedCount = Object.values(selections).filter(s => s?.selected).length;

	// Build CF Groups with their CFs
	// CF Groups already have enriched data from the API
	const groupedCFs = cfGroups.map((group: any) => {
		const cfs = Array.isArray(group.custom_formats) ? group.custom_formats : [];
		// CFs already enriched by API with description, displayName, score, source
		return {
			...group,
			customFormats: cfs.map((cf: any) => ({
				trash_id: cf.trash_id,
				name: cf.name,
				displayName: cf.displayName || cf.name,
				description: cf.description,
				score: cf.score ?? 0, // Explicit 0 for zero-score CFs
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

	// In edit mode, show quality profile's CFs first, then additional CFs section
	if (isEditMode) {
		// Separate profile CFs from additional CFs
		const profileCFIds = new Set(mandatoryCFs.map((cf: any) => cf.trash_id));
		const profileCFs = mandatoryCFs.filter((cf: any) => selections[cf.trash_id]?.selected);

		const additionalCFs = Object.entries(selections)
			.filter(([trashId, sel]) => sel?.selected && !profileCFIds.has(trashId))
			.map(([trashId]) => {
				// First try to find CF in CF groups
				for (const group of cfGroups) {
					const foundCF = group.custom_formats?.find((c: any) =>
						(typeof c === 'string' ? c : c.trash_id) === trashId
					);
					if (foundCF) {
						return typeof foundCF === 'string'
							? { trash_id: foundCF, name: foundCF }
							: foundCF;
					}
				}

				// If not found in CF groups, search in availableFormats (for browse section selections)
				if (data.availableFormats) {
					const foundInAvailable = data.availableFormats.find((cf: any) => cf.trash_id === trashId);
					if (foundInAvailable) {
						return {
							trash_id: foundInAvailable.trash_id,
							name: foundInAvailable.name,
							displayName: foundInAvailable.displayName,
							description: foundInAvailable.description,
							score: foundInAvailable.score,
							defaultScore: foundInAvailable.score,
							originalConfig: foundInAvailable.originalConfig,
						};
					}
				}

				return { trash_id: trashId, name: trashId };
			});

		const renderCFCard = (cf: any, isFromProfile: boolean) => {
			const selection = selections[cf.trash_id];
			const scoreOverride = selection?.scoreOverride;
			const isRequired = cf.required === true;

			return (
				<div
					key={cf.trash_id}
					className="rounded-lg p-4 border border-border/50 bg-bg-subtle transition-all hover:border-primary/50 hover:shadow-md"
				>
					<div className="flex items-start gap-3">
						<input
							type="checkbox"
							checked={selection?.selected ?? false}
							onChange={() => toggleCF(cf.trash_id, isRequired)}
							className="mt-1 h-5 w-5 rounded border-border/50 bg-bg-subtle text-primary focus:ring-2 focus:ring-primary/50 cursor-pointer transition"
						/>
						<div className="flex-1">
							<div className="flex items-center gap-2 mb-2">
								<span className="font-medium text-fg">{cf.displayName || cf.name}</span>
								{isRequired && (
									<span className="inline-flex items-center gap-1 rounded bg-amber-500/20 px-2 py-0.5 text-xs font-medium text-amber-300" title="TRaSH Guides recommends this CF as required">
										⭐ TRaSH Required
									</span>
								)}
								{isFromProfile && !isRequired && (
									<span className="inline-flex items-center gap-1 rounded bg-green-500/20 px-2 py-0.5 text-xs font-medium text-green-300">
										From Profile
									</span>
								)}
								{scoreOverride !== undefined && (
									<span className="inline-flex items-center gap-1 rounded bg-blue-500/20 px-2 py-0.5 text-xs font-medium text-blue-300">
										Custom Score
									</span>
								)}
							</div>

							<div className="space-y-2">
								{/* Show current score info */}
								<div className="flex items-center gap-2 text-xs text-fg-muted">
									<span>Current: {scoreOverride ?? cf.defaultScore ?? cf.score ?? 0}</span>
									{cf.defaultScore !== undefined && (
										<span>• TRaSH Default: {cf.defaultScore}</span>
									)}
								</div>

								{/* Score input */}
								<div className="flex items-center gap-2 flex-wrap">
									<button
										type="button"
										onClick={() => setConditionEditorFormat({ trashId: cf.trash_id, format: cf })}
										className="inline-flex items-center gap-1 rounded bg-white/10 px-2 py-1 text-xs font-medium text-white transition hover:bg-white/20"
										title="Advanced condition editing"
									>
										<Settings className="h-3 w-3" />
										Advanced
									</button>
									<label className="text-sm text-fg-muted">Override Score:</label>
									<input
										type="number"
										value={scoreOverride ?? ""}
										onChange={(e) => updateScore(cf.trash_id, e.target.value)}
										placeholder={cf.defaultScore?.toString() || cf.score?.toString() || "0"}
										className="w-20 rounded border border-border/50 bg-bg px-2 py-1 text-sm text-fg focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary/50 transition"
									/>
									{scoreOverride !== undefined && (
										<button
											type="button"
											onClick={() => updateScore(cf.trash_id, "")}
											className="text-xs text-primary hover:text-primary/80 transition"
											title="Reset to template default"
										>
											↺ Reset
										</button>
									)}
								</div>
							</div>
						</div>
					</div>
				</div>
			);
		};

		return (
			<div className="space-y-6 animate-in fade-in duration-500">
				{/* Header */}
				<Card className="border-primary/30 bg-primary/5">
					<CardHeader>
						<CardTitle>Edit Template Configuration</CardTitle>
						<CardDescription>
							Modify custom formats from the quality profile or add additional formats. {selectedCount} custom formats selected.
						</CardDescription>
					</CardHeader>
				</Card>

				{/* Quality Profile CFs */}
				<div className="space-y-3">
					<div className="flex items-center justify-between">
						<h3 className="text-lg font-medium text-fg">Quality Profile Custom Formats</h3>
						<span className="text-sm text-fg-muted">{profileCFs.length} formats</span>
					</div>
					<p className="text-sm text-fg-muted">
						These custom formats come from the TRaSH Guides quality profile &quot;{qualityProfile.name}&quot;. You can adjust scores or disable them.
					</p>

					{profileCFs.length > 0 ? (
						<div className="space-y-2">
							{profileCFs.map((cf: any) => renderCFCard(cf, true))}
						</div>
					) : (
						<Alert>
							<Info className="h-4 w-4" />
							<AlertDescription>
								All quality profile formats have been removed. Click &quot;Add More Formats&quot; to browse available formats.
							</AlertDescription>
						</Alert>
					)}
				</div>

				{/* Additional CFs */}
				{additionalCFs.length > 0 && (
					<div className="space-y-3">
						<div className="flex items-center justify-between">
							<h3 className="text-lg font-medium text-fg">Additional Custom Formats</h3>
							<span className="text-sm text-fg-muted">{additionalCFs.length} formats</span>
						</div>
						<p className="text-sm text-fg-muted">
							These custom formats were added beyond the quality profile&apos;s defaults.
						</p>

						<div className="space-y-2">
							{additionalCFs.map((cf: any) => renderCFCard(cf, false))}
						</div>
					</div>
				)}


			{/* Browse Custom Formats Section */}
			{data.availableFormats && (
				<div className="space-y-4">
					<div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
						<h3 className="text-lg font-semibold text-fg">
							<span className="flex flex-col sm:inline-flex sm:items-center sm:gap-2">
								<span>Browse Custom Formats</span>
								<span className="text-sm font-normal text-fg-muted">
									(Add additional custom formats to your template)
								</span>
							</span>
						</h3>
						<span className="text-sm text-fg-muted whitespace-nowrap">
							{data.availableFormats.length} formats available
						</span>
					</div>

					<Card className="border-blue-500/30 bg-blue-500/5">
						<CardHeader>
							<CardTitle className="text-base">Available Custom Formats</CardTitle>
							<CardDescription>
								Select additional custom formats to add to your template. Formats already in your template are hidden.
							</CardDescription>
						</CardHeader>
						<CardContent>
							<div className="space-y-2">
								{data.availableFormats
									.filter((cf: any) => {
										const isInTemplate = data.mandatoryCFs?.some((mandatoryCF: any) => mandatoryCF.trash_id === cf.trash_id);
										if (isInTemplate) return false;

										// Hide formats that are already selected (showing in Additional Custom Formats section)
										const isSelected = selections[cf.trash_id]?.selected ?? false;
										if (isSelected) return false;
										if (searchQuery) {
											const search = searchQuery.toLowerCase();
											return (
												cf.name?.toLowerCase().includes(search) ||
												cf.displayName?.toLowerCase().includes(search) ||
												cf.description?.toLowerCase().includes(search)
											);
										}
										return true;
									})
									.map((cf: any) => {
										const isSelected = selections[cf.trash_id]?.selected ?? false;
										const scoreOverride = selections[cf.trash_id]?.scoreOverride;
										const displayScore = cf.score ?? 0;
										const isRequired = cf.required === true;
										return (
											<div key={cf.trash_id} className="rounded-lg p-4 border border-border/50 bg-bg-subtle transition-all hover:border-primary/50 hover:bg-bg-hover hover:shadow-md cursor-pointer" onClick={() => toggleCF(cf.trash_id, isRequired)}>
												<div className="flex items-start gap-3">
													<input type="checkbox" checked={isSelected} onChange={() => toggleCF(cf.trash_id, isRequired)} className="mt-1 h-4 w-4 rounded border-border bg-bg-hover text-primary focus:ring-primary focus:ring-offset-0 cursor-pointer" onClick={(e) => e.stopPropagation()} />
													<div className="flex-1">
														<div className="flex items-center gap-2 mb-2">
															<span className="font-medium text-fg">{cf.displayName || cf.name}</span>
														</div>
														{cf.description && (
															<details className="mb-2 group">
																<summary className="cursor-pointer text-xs text-primary hover:text-primary/80 transition flex items-center gap-1">
																	<span className="group-open:rotate-90 transition-transform">▶</span>
																	<span>What is this?</span>
																</summary>
																<div className="mt-2 pl-4 text-sm text-fg-subtle prose prose-invert prose-sm max-w-none">
																	<div dangerouslySetInnerHTML={createSanitizedHtml(cf.description)} />
																</div>
															</details>
														)}
														{isSelected && (
															<div className="flex items-center gap-2">
																<label className="text-xs text-fg-muted">Score (Default: {displayScore}):</label>
																<input type="number" value={scoreOverride ?? ""} onChange={(e) => updateScore(cf.trash_id, e.target.value)} placeholder={String(displayScore)} className="w-24 rounded border border-border bg-bg-hover px-2 py-1 text-sm text-fg placeholder:text-fg-muted focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary" onClick={(e) => e.stopPropagation()} />
																{scoreOverride !== undefined && (
																	<button type="button" onClick={(e) => { e.stopPropagation(); updateScore(cf.trash_id, ""); }} className="text-xs text-primary hover:text-primary/80 transition" title="Reset to default">↺ Reset</button>
																)}
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
				</div>
			)}

				{/* Navigation */}
				<div className="flex items-center justify-between border-t border-border/50 pt-6">
					{onBack && (
						<button
							type="button"
							onClick={onBack}
							className="inline-flex items-center gap-2 rounded-lg bg-bg-hover px-4 py-2 text-sm font-medium text-fg transition hover:bg-bg-muted"
						>
							<ChevronLeft className="h-4 w-4" />
							Back
						</button>
					)}
					<div className="flex-1" />
					<button
						type="button"
						onClick={handleNext}
						disabled={!templateName.trim() || selectedCount === 0}
						className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white transition hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed"
					>
						Continue to Review
						<ChevronRight className="h-4 w-4" />
					</button>
				</div>

			{/* Condition Editor Modal */}
			{conditionEditorFormat && (() => {
				const selection = selections[conditionEditorFormat.trashId];

				// Get specifications from originalConfig if available
				const format = conditionEditorFormat.format as any;
				const specs = format.originalConfig?.specifications || format.specifications || [];

				const specificationsWithEnabled = specs.map((spec: any) => ({
					...spec,
					enabled: selection?.conditionsEnabled?.[spec.name] !== false,
				}));

				return (
					<div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm">
						<div className="relative w-full max-w-4xl max-h-[90vh] overflow-y-auto rounded-xl border border-white/20 bg-gradient-to-br from-slate-900 to-slate-800 p-6">
							{/* Close button */}
							<button
								type="button"
								onClick={() => setConditionEditorFormat(null)}
								className="absolute top-4 right-4 rounded p-1 text-white/60 hover:bg-white/10 hover:text-white z-10"
								aria-label="Close"
							>
								<svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
									<path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
								</svg>
							</button>

							<ConditionEditor
								customFormatId={conditionEditorFormat.trashId}
								customFormatName={(conditionEditorFormat.format as any).displayName || (conditionEditorFormat.format as any).name}
								specifications={specificationsWithEnabled}
								onChange={(updatedSpecs: any) => {
									const conditionsEnabled: Record<string, boolean> = {};
									for (const spec of updatedSpecs) {
										conditionsEnabled[spec.name] = spec.enabled !== false;
									}
									setSelections((prev) => {
										const current = prev[conditionEditorFormat.trashId] || { selected: true, conditionsEnabled: {} };
										return {
											...prev,
											[conditionEditorFormat.trashId]: {
												...current,
												conditionsEnabled,
											},
										};
									});
								}}
							/>
						</div>
					</div>
				);
			})()}
			</div>
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
				<Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-fg-muted" />
				<input
					type="text"
					value={searchQuery}
					onChange={(e) => setSearchQuery(e.target.value)}
					placeholder="Search custom formats by name or description..."
					className="w-full rounded-lg border border-border/50 bg-bg-subtle pl-10 pr-4 py-2.5 text-sm text-fg placeholder:text-fg-muted focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20 transition"
				/>
				{searchQuery && (
					<button
						type="button"
						onClick={() => setSearchQuery("")}
						className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-fg-muted hover:text-fg transition"
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
						<strong>TRaSH Recommended Formats</strong> are marked with ⭐ but can be toggled on/off based on your preferences. <strong>CF Groups</strong> can be toggled individually or in bulk. Browse all available formats below to add any additional custom formats.
					</AlertDescription>
				</Alert>
			)}

			{/* TRaSH Recommended Custom Formats (from profile.formatItems) */}
			{filteredMandatoryCFs.length > 0 && (
				<Card className="border-amber-500/30 bg-amber-500/5">
					<CardHeader>
						<CardTitle className="flex items-center gap-2">
							<span className="inline-flex items-center gap-1 rounded bg-amber-500/20 px-2 py-1 text-sm font-medium text-amber-300">
								⭐ TRaSH Recommended Formats
							</span>
							<span className="text-sm font-normal text-fg-muted">
								({filteredMandatoryCFs.length}{searchQuery ? ` of ${mandatoryCFs.length}` : ""} formats)
							</span>
						</CardTitle>
						<CardDescription>
							These custom formats are recommended by TRaSH Guides for this quality profile. You can toggle them on/off and override their scores.
						</CardDescription>
					</CardHeader>
					<CardContent>
						<div className="space-y-2">
							{filteredMandatoryCFs.map((cf: any) => {
								const isSelected = selections[cf.trash_id]?.selected ?? true;
								const scoreOverride = selections[cf.trash_id]?.scoreOverride;
								const displayScore = cf.score ?? 0;

								return (
									<div
										key={cf.trash_id}
										className="rounded-lg p-4 border border-amber-500/30 bg-amber-500/10 transition-all hover:border-amber-500/50 hover:bg-amber-500/15 hover:shadow-md"
									>
										<div className="flex items-start gap-3">
											<input
												type="checkbox"
												checked={isSelected}
												onChange={() => toggleCF(cf.trash_id, false)}
												className="mt-1 h-5 w-5 rounded border-border/50 bg-bg-subtle text-primary focus:ring-2 focus:ring-primary/50 cursor-pointer transition"
											/>
											<div className="flex-1">
												<div className="flex items-center gap-2 mb-2">
													<span className="font-medium text-fg">{cf.displayName || cf.name}</span>
													<span className="inline-flex items-center gap-1 rounded bg-amber-500/20 px-2 py-0.5 text-xs font-medium text-amber-300" title="TRaSH Guides recommends this format">
														⭐ Recommended
													</span>
												</div>

												{cf.description && (
													<details className="mb-2 group">
														<summary className="cursor-pointer text-xs text-primary hover:text-primary/80 transition flex items-center gap-1">
															<span className="group-open:rotate-90 transition-transform">▶</span>
															<span>What is this?</span>
														</summary>
														<div className="mt-2 pl-4 text-sm text-fg-subtle prose prose-invert prose-sm max-w-none">
															<div dangerouslySetInnerHTML={createSanitizedHtml(cf.description)} />
														</div>
													</details>
												)}

												<div className="flex items-center gap-2">
													<label className="text-xs text-fg-muted">
														Score:
														{scoreOverride === undefined && (
															<span className="ml-1">(default: {formatScore(cf.score)})</span>
														)}
													</label>
													<input
														type="number"
														value={scoreOverride ?? cf.score ?? 0}
														onChange={(e) => updateScore(cf.trash_id, e.target.value)}
														min={-10000}
														max={10000}
														className={`w-24 rounded border px-2 py-1 text-sm text-fg focus:outline-none focus:ring-1 ${
															scoreOverride !== undefined
																? "border-primary ring-1 ring-primary/20 bg-primary/5"
																: "border-border bg-bg-hover"
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
																className="flex items-center gap-1 text-xs text-fg-muted hover:text-primary transition"
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
						<h3 className="text-lg font-semibold text-fg">
							<span className="flex flex-col sm:inline-flex sm:items-center sm:gap-2">
								<span>Optional Custom Format Groups</span>
								<span className="text-sm font-normal text-fg-muted">
									(Select groups and formats based on your preferences)
								</span>
							</span>
						</h3>
						<span className="text-sm text-fg-muted whitespace-nowrap">
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
									? "!border-amber-500/50 !bg-amber-500/10"
									: isGroupRequired
										? "!border-red-500/50 !bg-red-500/10"
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
												className="h-5 w-5 rounded border-border bg-bg-hover text-primary focus:ring-primary cursor-pointer"
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
													<span className="inline-flex items-center gap-1 rounded bg-blue-500/20 px-2 py-0.5 text-xs font-medium text-blue-300">
														⚙️ Optional
													</span>
												)}
											</div>
										</div>
										<div className="flex gap-2 text-xs text-fg-muted items-center">
											<span>{selectedInGroup} of {groupCFs.length} selected</span>
										</div>
									</div>


									{group.trash_description && (
										<div className="rounded-lg border border-blue-500/30 bg-blue-500/10 p-3 mt-2">
											<div className="flex items-start gap-2">
												<AlertCircle className="h-4 w-4 text-blue-400 mt-0.5 flex-shrink-0" />
												<div
													className="text-sm text-blue-100"
													dangerouslySetInnerHTML={createSanitizedHtml(group.trash_description)}
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
															: "bg-bg-hover border-border/50 hover:border-border hover:bg-bg-active"
													}`}
												>
													<div className="flex items-start gap-3">
														<input
															type="checkbox"
															checked={isSelected}
															onChange={() => toggleCF(cf.trash_id, false)}
															className="mt-1 h-5 w-5 rounded border-border bg-bg-hover text-primary focus:ring-primary cursor-pointer"
														/>
														<div className="flex-1">
															<div className="flex items-center gap-2 flex-wrap mb-2">
																<span className="font-medium text-fg">{cf.displayName || cf.name}</span>
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
																<details className="mb-2 group">
																	<summary className="cursor-pointer text-xs text-primary hover:text-primary/80 transition flex items-center gap-1">
																		<span className="group-open:rotate-90 transition-transform">▶</span>
																		<span>What is this?</span>
																	</summary>
																	<div className="mt-2 pl-4 text-sm text-fg-subtle prose prose-invert prose-sm max-w-none">
																		<div dangerouslySetInnerHTML={createSanitizedHtml(cf.description)} />
																	</div>
																</details>
															)}

															{isSelected && (
																<div className="flex flex-col sm:flex-row sm:items-center gap-2">
																	<label className="text-xs text-fg-muted whitespace-nowrap">
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
																			className={`w-full sm:w-24 rounded border px-2 py-1 text-sm text-fg focus:outline-none focus:ring-1 ${
																				scoreOverride !== undefined
																					? "border-primary ring-1 ring-primary/20 bg-primary/5"
																					: "border-border bg-bg-hover"
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
																					className="flex items-center gap-1 text-xs text-fg-muted hover:text-primary transition whitespace-nowrap"
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
			{(() => {
				// Get all selected CFs that are NOT in mandatory or CF groups
				const mandatoryCFIds = new Set(data.mandatoryCFs?.map((cf: any) => cf.trash_id) || []);
				const cfGroupCFIds = new Set<string>();
				data.cfGroups?.forEach((group: any) => {
					group.custom_formats?.forEach((cf: any) => {
						const cfTrashId = typeof cf === 'string' ? cf : cf.trash_id;
						cfGroupCFIds.add(cfTrashId);
					});
				});

				const additionalCFs = Object.entries(selections)
					.filter(([trashId, sel]) =>
						sel?.selected &&
						!mandatoryCFIds.has(trashId) &&
						!cfGroupCFIds.has(trashId)
					)
					.map(([trashId]) => {
						// Find the CF in availableFormats
						const cf = data.availableFormats?.find((f: any) => f.trash_id === trashId);
						return cf ? { ...cf, trash_id: trashId } : null;
					})
					.filter(Boolean);

				if (additionalCFs.length === 0) return null;

				return (
					<div className="space-y-4">
						<div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
							<h3 className="text-lg font-semibold text-fg">
								<span className="flex flex-col sm:inline-flex sm:items-center sm:gap-2">
									<span>Additional Custom Formats</span>
									<span className="text-sm font-normal text-fg-muted">
										(Custom formats you&apos;ve added from the catalog)
									</span>
								</span>
							</h3>
							<span className="text-sm text-fg-muted whitespace-nowrap">
								{additionalCFs.length} format{additionalCFs.length !== 1 ? 's' : ''} added
							</span>
						</div>

						<Card className="border-green-500/30 bg-green-500/5">
							<CardHeader>
								<CardTitle className="text-base flex items-center gap-2">
									<span>✅ Your Additional Selections</span>
								</CardTitle>
								<CardDescription>
									These custom formats were manually added from the catalog. You can adjust scores or remove them.
								</CardDescription>
							</CardHeader>
							<CardContent>
								<div className="space-y-2">
									{additionalCFs.map((cf: any) => {
										const isSelected = selections[cf.trash_id]?.selected ?? false;
										const scoreOverride = selections[cf.trash_id]?.scoreOverride;
										const displayScore = cf.score ?? 0;

										return (
											<div
												key={cf.trash_id}
												className="rounded-lg p-4 border border-green-500/30 bg-green-500/10 transition-all hover:border-green-500/50 hover:bg-green-500/15 hover:shadow-md"
											>
												<div className="flex items-start gap-3">
													<input
														type="checkbox"
														checked={isSelected}
														onChange={() => toggleCF(cf.trash_id, false)}
														className="mt-1 h-5 w-5 rounded border-border/50 bg-bg-subtle text-green-500 focus:ring-2 focus:ring-green-500/50 cursor-pointer transition"
													/>
													<div className="flex-1">
														<div className="flex items-center gap-2 mb-2">
															<span className="font-medium text-fg">{cf.displayName || cf.name}</span>
															<span className="inline-flex items-center gap-1 rounded bg-green-500/20 px-2 py-0.5 text-xs font-medium text-green-300">
																➕ Added
															</span>
														</div>

														{cf.description && (
															<details className="mb-2 group">
																<summary className="cursor-pointer text-xs text-green-400 hover:text-green-300 transition flex items-center gap-1">
																	<span className="group-open:rotate-90 transition-transform">▶</span>
																	<span>What is this?</span>
																</summary>
																<div className="mt-2 pl-4 text-sm text-fg-subtle prose prose-invert prose-sm max-w-none">
																	<div dangerouslySetInnerHTML={createSanitizedHtml(cf.description)} />
																</div>
															</details>
														)}

														<div className="flex items-center gap-3 flex-wrap">
															<div className="flex items-center gap-2">
																<label className="text-sm text-fg-muted">TRaSH Score:</label>
																<span className="text-sm font-medium text-fg">{displayScore}</span>
															</div>
															<div className="flex items-center gap-2">
																<label className="text-sm text-fg-muted">Custom Score:</label>
																<input
																	type="number"
																	value={scoreOverride ?? ""}
																	onChange={(e) => {
																		const value = e.target.value === "" ? undefined : Number(e.target.value);
																		setSelections((prev) => ({
																			...prev,
																			[cf.trash_id]: {
																				...prev[cf.trash_id],
																				scoreOverride: value,
																			},
																		}));
																	}}
																	placeholder={`Default: ${displayScore}`}
																	className="w-28 rounded border border-border bg-bg-hover px-3 py-1.5 text-sm text-fg focus:border-green-500 focus:outline-none focus:ring-1 focus:ring-green-500"
																/>
															</div>
															<span className="text-xs text-fg-muted">
																(leave empty to use TRaSH score)
															</span>
														</div>
													</div>
												</div>
											</div>
										);
									})}
								</div>
							</CardContent>
						</Card>
					</div>
				);
			})()}

			{/* Browse All Custom Formats */}
			{data.availableFormats && data.availableFormats.length > 0 && (
				<div className="space-y-4">
					<div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
						<h3 className="text-lg font-semibold text-fg">
							<span className="flex flex-col sm:inline-flex sm:items-center sm:gap-2">
								<span>Browse All Custom Formats</span>
								<span className="text-sm font-normal text-fg-muted">
									(Add any additional custom formats to your template)
								</span>
							</span>
						</h3>
						<span className="text-sm text-fg-muted whitespace-nowrap">
							{data.availableFormats.filter((cf: any) => {
								// Hide formats already in template (mandatory or in groups)
								const isInMandatory = data.mandatoryCFs?.some((mandatoryCF: any) => mandatoryCF.trash_id === cf.trash_id);
								if (isInMandatory) return false;

								// Hide formats in CF groups
								const isInGroups = data.cfGroups?.some((group: any) =>
									group.custom_formats?.some((groupCF: any) =>
										(typeof groupCF === 'string' ? groupCF : groupCF.trash_id) === cf.trash_id
									)
								);
								if (isInGroups) return false;

								// Hide already selected formats
								const isSelected = selections[cf.trash_id]?.selected ?? false;
								if (isSelected) return false;

								return true;
							}).length} formats available
						</span>
					</div>

					<Card className="border-purple-500/30 bg-purple-500/5">
						<CardHeader>
							<CardTitle className="text-base">Additional Custom Formats Catalog</CardTitle>
							<CardDescription>
								Browse and select any additional custom formats from the TRaSH Guides catalog. Formats already in your template are hidden.
							</CardDescription>
						</CardHeader>
						<CardContent>
							<div className="space-y-2 max-h-96 overflow-y-auto">
								{data.availableFormats
									.filter((cf: any) => {
										// Hide formats already in template
										const isInMandatory = data.mandatoryCFs?.some((mandatoryCF: any) => mandatoryCF.trash_id === cf.trash_id);
										if (isInMandatory) return false;

										// Hide formats in CF groups
										const isInGroups = data.cfGroups?.some((group: any) =>
											group.custom_formats?.some((groupCF: any) =>
												(typeof groupCF === 'string' ? groupCF : groupCF.trash_id) === cf.trash_id
											)
										);
										if (isInGroups) return false;

										// Hide already selected formats
										const isSelected = selections[cf.trash_id]?.selected ?? false;
										if (isSelected) return false;

										// Apply search filter
										if (searchQuery) {
											const search = searchQuery.toLowerCase();
											return (
												cf.name?.toLowerCase().includes(search) ||
												cf.displayName?.toLowerCase().includes(search) ||
												cf.description?.toLowerCase().includes(search)
											);
										}

										return true;
									})
									.map((cf: any) => {
										const isSelected = selections[cf.trash_id]?.selected ?? false;
										const scoreOverride = selections[cf.trash_id]?.scoreOverride;
										const displayScore = cf.score ?? 0;

										return (
											<div
												key={cf.trash_id}
												className="rounded-lg p-3 border border-border/50 bg-bg-subtle transition-all hover:border-purple-500/50 hover:bg-bg-hover hover:shadow-md cursor-pointer"
												onClick={() => toggleCF(cf.trash_id, false)}
											>
												<div className="flex items-start gap-3">
													<input
														type="checkbox"
														checked={isSelected}
														onChange={() => toggleCF(cf.trash_id, false)}
														className="mt-1 h-4 w-4 rounded border-border bg-bg-hover text-purple-500 focus:ring-purple-500 focus:ring-offset-0 cursor-pointer"
														onClick={(e) => e.stopPropagation()}
													/>
													<div className="flex-1">
														<div className="flex items-center gap-2 mb-2">
															<span className="font-medium text-fg">{cf.displayName || cf.name}</span>
															<span className="text-xs text-fg-muted">
																(Score: {displayScore})
															</span>
														</div>

														{cf.description && (
															<details className="mb-2 group">
																<summary className="cursor-pointer text-xs text-purple-400 hover:text-purple-300 transition flex items-center gap-1">
																	<span className="group-open:rotate-90 transition-transform">▶</span>
																	<span>What is this?</span>
																</summary>
																<div className="mt-2 pl-4 text-sm text-fg-subtle prose prose-invert prose-sm max-w-none">
																	<div dangerouslySetInnerHTML={createSanitizedHtml(cf.description)} />
																</div>
															</details>
														)}

														{isSelected && (
															<div className="flex items-center gap-2 mt-2">
																<label className="text-xs text-fg-muted">Custom Score:</label>
																<input
																	type="number"
																	value={scoreOverride ?? ""}
																	onChange={(e) => {
																		const value = e.target.value === "" ? undefined : Number(e.target.value);
																		setSelections((prev) => ({
																			...prev,
																			[cf.trash_id]: {
																				...prev[cf.trash_id],
																				scoreOverride: value,
																			},
																		}));
																	}}
																	onClick={(e) => e.stopPropagation()}
																	placeholder={`Default: ${displayScore}`}
																	className="w-24 rounded border border-border bg-bg-hover px-2 py-1 text-xs text-fg focus:border-purple-500 focus:outline-none focus:ring-1 focus:ring-purple-500"
																/>
																<span className="text-xs text-fg-muted">
																	(leave empty for default: {displayScore})
																</span>
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
				</div>
			)}

			{/* Template Creation Section */}
			<Card>
				<CardHeader>
					<CardTitle>Create Template</CardTitle>
					<CardDescription>
						Name your template and add an optional description
					</CardDescription>
				</CardHeader>
				<CardContent className="space-y-4">
					<div>
						<label className="mb-2 block text-sm font-medium text-fg">
							Template Name <span className="text-red-400">*</span>
						</label>
						<input
							type="text"
							value={templateName}
							onChange={(e) => setTemplateName(e.target.value)}
							placeholder="Enter template name"
							className="w-full rounded border border-border bg-bg-hover px-3 py-2 text-sm text-fg placeholder:text-fg-muted focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
						/>
					</div>

					<div>
						<label className="mb-2 block text-sm font-medium text-fg">
							Description (Optional)
						</label>
						<textarea
							value={templateDescription}
							onChange={(e) => setTemplateDescription(e.target.value)}
							placeholder="Enter template description"
							rows={4}
							className="w-full rounded border border-border bg-bg-hover px-3 py-2 text-sm text-fg placeholder:text-fg-muted focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
						/>
					</div>
				</CardContent>
			</Card>

			{/* Navigation */}
			<div className={`flex flex-col-reverse sm:flex-row sm:items-center gap-3 border-t border-border pt-6 ${onBack ? 'sm:justify-between' : 'sm:justify-end'}`}>
				{onBack && (
					<button
						type="button"
						onClick={onBack}
						className="inline-flex items-center justify-center gap-2 rounded-lg bg-bg-hover px-4 py-2.5 text-sm font-medium text-fg transition hover:bg-bg-active disabled:opacity-50"
					>
						<ChevronLeft className="h-4 w-4" />
						<span>Back</span>
					</button>
				)}

				<button
					type="button"
					onClick={handleNext}
					disabled={!templateName.trim() || selectedCount === 0}
					className="inline-flex items-center justify-center gap-2 rounded-lg bg-primary px-4 py-2.5 text-sm font-medium text-white transition hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed"
				>
					<span>Next: Review</span>
					<ChevronRight className="h-4 w-4" />
				</button>
			</div>
		</div>
	);
};
