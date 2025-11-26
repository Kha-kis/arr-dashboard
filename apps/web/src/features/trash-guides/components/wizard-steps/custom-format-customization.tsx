"use client";

import { useState, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { Alert, AlertDescription, Skeleton } from "../../../../components/ui";
import { ChevronRight, ChevronLeft, Info, CheckCircle2, Settings } from "lucide-react";
import { createSanitizedHtml } from "../../../../lib/sanitize-html";
import type { QualityProfileSummary } from "../../../../lib/api-client/trash-guides";
import { apiRequest } from "../../../../lib/api-client/base";

interface CustomFormatCustomizationProps {
	serviceType: "RADARR" | "SONARR";
	qualityProfile: QualityProfileSummary;
	selectedCFGroups: Set<string>;
	initialSelections: Record<string, {
		selected: boolean;
		scoreOverride?: number;
		conditionsEnabled: Record<string, boolean>;
	}>;
	onNext: (selections: Record<string, any>) => void;
	onBack: () => void;
}

export const CustomFormatCustomization = ({
	serviceType,
	qualityProfile,
	selectedCFGroups,
	initialSelections,
	onNext,
	onBack,
}: CustomFormatCustomizationProps) => {
	const [selections, setSelections] = useState(initialSelections);
	const [expandedCF, setExpandedCF] = useState<string | null>(null);

	const { data, isLoading, error } = useQuery({
		queryKey: ["quality-profile-details", serviceType, qualityProfile.trashId],
		queryFn: async () => {
			return await apiRequest<any>(
				`/api/trash-guides/quality-profiles/${serviceType}/${qualityProfile.trashId}`,
			);
		},
	});

	// Initialize selections when data loads
	useEffect(() => {
		if (data && Object.keys(selections).length === 0) {
			const cfGroups = data.cfGroups || [];
			const customFormats = data.directCustomFormats || [];
			const allCFs = new Map();

			// Get all CFs from selected CF Groups
			for (const group of cfGroups) {
				if (selectedCFGroups.has(group.trash_id)) {
					if (Array.isArray(group.custom_formats)) {
						for (const cf of group.custom_formats) {
							const cfTrashId = typeof cf === 'string' ? cf : cf.trash_id;
							// Store the CF with its required flag from the group
							allCFs.set(cfTrashId, cf);
						}
					}
				}
			}

			// Add direct CFs from profile
			for (const cf of customFormats) {
				allCFs.set(cf.trash_id, cf);
			}

			// Initialize selections for all CFs
			const newSelections: Record<string, any> = {};

			// Get the list of CF trash IDs that are in the quality profile's formatItems
			const profileFormatIds = data.profile?.formatItems
				? Object.values(data.profile.formatItems)
				: [];

			for (const [cfTrashId, cf] of allCFs) {
				const cfData = typeof cf === 'string' ? data.directCustomFormats.find((c: any) => c.trash_id === cfTrashId) : cf;

				if (cfData) {
					const conditionsEnabled: Record<string, boolean> = {};
					if (cfData.specifications && Array.isArray(cfData.specifications)) {
						for (const spec of cfData.specifications) {
							conditionsEnabled[spec.name] = true;
						}
					}

					// Auto-select if:
					// 1. Marked as required in CF Group, OR
					// 2. Present in the quality profile's formatItems
					const isRequired = typeof cf === 'object' && cf.required === true;
					const isInProfile = profileFormatIds.includes(cfTrashId);

					newSelections[cfTrashId] = {
						selected: isRequired || isInProfile, // Select if required OR in profile
						scoreOverride: undefined,
						conditionsEnabled,
					};
				}
			}

			setSelections(newSelections);
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps -- Only initialize on data/selectedCFGroups change, selections.length checked inside
	}, [data, selectedCFGroups]);

	const toggleCF = (cfTrashId: string) => {
		setSelections((prev) => ({
			...prev,
			[cfTrashId]: {
				selected: !prev[cfTrashId]?.selected,
				scoreOverride: prev[cfTrashId]?.scoreOverride,
				conditionsEnabled: prev[cfTrashId]?.conditionsEnabled || {},
			},
		}));
	};

	const updateScoreOverride = (cfTrashId: string, score: string) => {
		const scoreValue = score === "" ? undefined : Number.parseInt(score, 10);
		setSelections((prev) => ({
			...prev,
			[cfTrashId]: {
				selected: prev[cfTrashId]?.selected || false,
				scoreOverride: scoreValue,
				conditionsEnabled: prev[cfTrashId]?.conditionsEnabled || {},
			},
		}));
	};

	const toggleCondition = (cfTrashId: string, conditionName: string) => {
		setSelections((prev) => ({
			...prev,
			[cfTrashId]: {
				selected: prev[cfTrashId]?.selected || false,
				scoreOverride: prev[cfTrashId]?.scoreOverride,
				conditionsEnabled: {
					...(prev[cfTrashId]?.conditionsEnabled || {}),
					[conditionName]: !(prev[cfTrashId]?.conditionsEnabled?.[conditionName] ?? false),
				},
			},
		}));
	};

	if (isLoading) {
		return (
			<div className="space-y-4">
				<Skeleton className="h-32" />
				<Skeleton className="h-48" />
				<Skeleton className="h-48" />
			</div>
		);
	}

	if (error) {
		return (
			<Alert variant="danger">
				<AlertDescription>
					{error instanceof Error
						? error.message
						: "Failed to load quality profile details"}
				</AlertDescription>
			</Alert>
		);
	}

	// Build list of all CFs from selected groups and direct CFs
	const allCFs = new Map();
	const cfGroups = data?.cfGroups || [];
	const customFormats = data?.directCustomFormats || [];

	for (const group of cfGroups) {
		if (selectedCFGroups.has(group.trash_id)) {
			if (Array.isArray(group.custom_formats)) {
				for (const cf of group.custom_formats) {
					const cfTrashId = typeof cf === 'string' ? cf : cf.trash_id;
					const cfData = customFormats.find((c: any) => c.trash_id === cfTrashId);
					if (cfData) {
						// Preserve the 'required' flag from the CF Group
						const isRequired = typeof cf === 'object' && cf.required === true;
						allCFs.set(cfTrashId, { ...cfData, isRequired });
					}
				}
			}
		}
	}

	// Add direct CFs from profile
	for (const cf of customFormats) {
		if (!allCFs.has(cf.trash_id)) {
			allCFs.set(cf.trash_id, { ...cf, isRequired: false });
		}
	}

	const cfList = Array.from(allCFs.values());
	const selectedCount = Object.values(selections).filter(s => s?.selected).length;

	return (
		<div className="space-y-6">
			{/* Introduction */}
			<div className="rounded-xl border border-blue-500/20 bg-blue-500/5 p-4">
				<h4 className="font-medium text-white mb-2">⚙️ Review & Customize Formats</h4>
				<p className="text-sm text-white/70 mb-3">
					TRaSH Guides recommends specific Custom Formats for this profile. <strong className="text-white">Pre-selected formats are based on the quality profile's configuration</strong>. You can adjust as needed:
				</p>
				<div className="space-y-2 text-sm text-white/70 ml-4 mb-3">
					<div>• <strong className="text-white">Pre-selected</strong> - Recommended by TRaSH for this profile</div>
					<div>• <strong className="text-white">Unselected</strong> - Optional, choose based on your preferences</div>
					<div>• <strong className="text-white">Score overrides</strong> - Click gear icon to customize priority/conditions</div>
				</div>
				<p className="text-xs text-white/60 italic">
					💡 Tip: The defaults are carefully chosen for this quality profile. Only change if you have specific requirements.
				</p>
			</div>

			{/* Overview */}
			<div className="rounded-xl border border-white/10 bg-white/5 p-6">
				<h3 className="text-lg font-medium text-white">Customize Custom Formats</h3>
				<p className="mt-2 text-sm text-white/70">
					Review and customize the Custom Formats from your selected CF Groups.
				</p>
				<div className="mt-4 flex items-center gap-2 text-sm text-white/60">
					<Info className="h-4 w-4" />
					<span>
						{cfList.length} Custom Formats available • {selectedCount} selected
					</span>
				</div>
			</div>

			{/* Custom Formats List */}
			<div className="space-y-3">
				{cfList.map((cf: any) => {
					const isSelected = selections[cf.trash_id]?.selected ?? false;
					const isExpanded = expandedCF === cf.trash_id;
					const scoreOverride = selections[cf.trash_id]?.scoreOverride;
					const conditionsEnabled = selections[cf.trash_id]?.conditionsEnabled || {};

					return (
						<div
							key={cf.trash_id}
							className={`rounded-xl border ${
								isSelected
									? "border-primary/50 bg-primary/5"
									: "border-white/10 bg-white/5"
							}`}
						>
							<div className="flex items-start gap-4 p-6">
								{/* Selection Checkbox */}
								<input
									type="checkbox"
									checked={isSelected}
									onChange={() => toggleCF(cf.trash_id)}
									className="mt-1 h-5 w-5 rounded border-white/20 bg-white/10 text-primary focus:ring-primary"
								/>

								<div className="flex-1">
									<div className="flex items-start justify-between">
										<div>
											<div className="flex items-center gap-2 flex-wrap">
												<h4 className="font-medium text-white">{cf.name}</h4>
												{cf.isRequired && (
													<span className="inline-flex items-center gap-1 rounded bg-red-500/20 px-2 py-0.5 text-xs font-medium text-red-300">
														Required
													</span>
												)}
											</div>
											{cf.trash_description && (
												<p
													className="mt-1 text-sm text-white/70"
													dangerouslySetInnerHTML={createSanitizedHtml(cf.trash_description)}
												/>
											)}
										</div>

										<button
											type="button"
											onClick={() => setExpandedCF(isExpanded ? null : cf.trash_id)}
											className="rounded p-1 text-white/60 hover:bg-white/10 hover:text-white"
											disabled={!isSelected}
										>
											<Settings className="h-4 w-4" />
										</button>
									</div>

									{/* Expanded Options */}
									{isExpanded && isSelected && (
										<div className="mt-4 space-y-4 border-t border-white/10 pt-4">
											{/* Score Override */}
											<div>
												<label className="mb-2 block text-sm font-medium text-white">
													Score Override (optional)
												</label>
												<input
													type="number"
													value={scoreOverride ?? ""}
													onChange={(e) => updateScoreOverride(cf.trash_id, e.target.value)}
													placeholder="Leave empty for default score"
													className="w-full rounded border border-white/20 bg-white/10 px-3 py-2 text-sm text-white placeholder:text-white/40 focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
												/>
											</div>

											{/* Conditions */}
											{cf.specifications && cf.specifications.length > 0 && (
												<div>
													<label className="mb-2 block text-sm font-medium text-white">
														Conditions ({cf.specifications.length})
													</label>
													<div className="space-y-2">
														{cf.specifications.map((spec: any) => (
															<label
																key={spec.name}
																className="flex items-center gap-2 rounded bg-white/5 px-3 py-2"
															>
																<input
																	type="checkbox"
																	checked={conditionsEnabled[spec.name] ?? true}
																	onChange={() => toggleCondition(cf.trash_id, spec.name)}
																	className="h-4 w-4 rounded border-white/20 bg-white/10 text-primary focus:ring-primary"
																/>
																<span className="text-sm text-white/70">{spec.name}</span>
															</label>
														))}
													</div>
												</div>
											)}
										</div>
									)}
								</div>
							</div>
						</div>
					);
				})}
			</div>

			{cfList.length === 0 && (
				<div className="rounded-xl border border-white/10 bg-white/5 p-8 text-center">
					<p className="text-white/60">
						No Custom Formats available. Please select some CF Groups in the previous step.
					</p>
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
					onClick={() => onNext(selections)}
					disabled={selectedCount === 0}
					className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white transition hover:bg-primary/90 disabled:opacity-50"
				>
					Next: Create Template
					<ChevronRight className="h-4 w-4" />
				</button>
			</div>
		</div>
	);
};
