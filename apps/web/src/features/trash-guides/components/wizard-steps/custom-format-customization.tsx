"use client";

import { useState, useEffect, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { Alert, AlertDescription } from "../../../../components/ui";
import { PremiumSkeleton } from "../../../../components/layout/premium-components";
import { ChevronRight, ChevronLeft, Info, Settings } from "lucide-react";
import { useThemeGradient } from "../../../../hooks/useThemeGradient";
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
	const { gradient: themeGradient } = useThemeGradient();
	const [selections, setSelections] = useState(initialSelections);
	const [expandedCF, setExpandedCF] = useState<string | null>(null);
	// Track initialization key to avoid re-running when data/selectedCFGroups haven't changed
	const initKeyRef = useRef<string | null>(null);

	const { data, isLoading, error } = useQuery({
		queryKey: ["quality-profile-details", serviceType, qualityProfile.trashId],
		queryFn: async () => {
			return await apiRequest<any>(
				`/api/trash-guides/quality-profiles/${serviceType}/${qualityProfile.trashId}`,
			);
		},
	});

	// Initialize selections when data loads or selectedCFGroups change
	useEffect(() => {
		if (!data) return;

		// Create a key based on data identity and selectedCFGroups
		const selectedGroupsKey = Array.from(selectedCFGroups).sort().join(',');
		const currentKey = `${qualityProfile.trashId}:${selectedGroupsKey}`;

		// Skip if already initialized for this key
		if (initKeyRef.current === currentKey) return;

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
		initKeyRef.current = currentKey;
		// eslint-disable-next-line react-hooks/exhaustive-deps -- qualityProfile.trashId is stable for this component's lifecycle
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
		const trimmed = score.trim();
		const parsed = Number.parseInt(trimmed, 10);
		const scoreValue = trimmed === "" || Number.isNaN(parsed) ? undefined : parsed;
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
				<PremiumSkeleton variant="card" className="h-32" />
				<PremiumSkeleton variant="card" className="h-48" style={{ animationDelay: "50ms" }} />
				<PremiumSkeleton variant="card" className="h-48" style={{ animationDelay: "100ms" }} />
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
			<div
				className="rounded-xl border p-4"
				style={{
					borderColor: themeGradient.fromMuted,
					backgroundColor: themeGradient.fromLight,
				}}
			>
				<h4 className="font-medium text-foregroundmb-2">⚙️ Review & Customize Formats</h4>
				<p className="text-sm text-foreground/70 mb-3">
					TRaSH Guides recommends specific Custom Formats for this profile. <strong className="text-foreground">Pre-selected formats are based on the quality profile&apos;s configuration</strong>. You can adjust as needed:
				</p>
				<div className="space-y-2 text-sm text-foreground/70 ml-4 mb-3">
					<div>• <strong className="text-foreground">Pre-selected</strong> - Recommended by TRaSH for this profile</div>
					<div>• <strong className="text-foreground">Unselected</strong> - Optional, choose based on your preferences</div>
					<div>• <strong className="text-foreground">Score overrides</strong> - Click gear icon to customize priority/conditions</div>
				</div>
				<p className="text-xs text-foreground/60 italic">
					💡 Tip: The defaults are carefully chosen for this quality profile. Only change if you have specific requirements.
				</p>
			</div>

			{/* Overview */}
			<div className="rounded-xl border border-border bg-card p-6">
				<h3 className="text-lg font-medium text-foreground">Customize Custom Formats</h3>
				<p className="mt-2 text-sm text-foreground/70">
					Review and customize the Custom Formats from your selected CF Groups.
				</p>
				<div className="mt-4 flex items-center gap-2 text-sm text-foreground/60">
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
									: "border-border bg-card"
							}`}
						>
							<div className="flex items-start gap-4 p-6">
								{/* Selection Checkbox */}
								<input
									type="checkbox"
									checked={isSelected}
									onChange={() => toggleCF(cf.trash_id)}
									className="mt-1 h-5 w-5 rounded border-border bg-card text-primary focus:ring-primary"
								/>

								<div className="flex-1">
									<div className="flex items-start justify-between">
										<div>
											<div className="flex items-center gap-2 flex-wrap">
												<h4 className="font-medium text-foreground">{cf.name}</h4>
												{cf.isRequired && (
													<span className="inline-flex items-center gap-1 rounded bg-red-500/20 px-2 py-0.5 text-xs font-medium text-red-300">
														Required
													</span>
												)}
											</div>
											{cf.trash_description && (
												<p
													className="mt-1 text-sm text-foreground/70"
													dangerouslySetInnerHTML={createSanitizedHtml(cf.trash_description)}
												/>
											)}
										</div>

										<button
											type="button"
											onClick={() => setExpandedCF(isExpanded ? null : cf.trash_id)}
											className="rounded p-1 text-foreground/60 hover:bg-card hover:text-foreground"
											disabled={!isSelected}
										>
											<Settings className="h-4 w-4" />
										</button>
									</div>

									{/* Expanded Options */}
									{isExpanded && isSelected && (
										<div className="mt-4 space-y-4 border-t border-border pt-4">
											{/* Score Override */}
											<div>
												<label className="mb-2 block text-sm font-medium text-foreground">
													Score Override (optional)
												</label>
												<input
													type="number"
													value={scoreOverride ?? ""}
													onChange={(e) => updateScoreOverride(cf.trash_id, e.target.value)}
													placeholder="Leave empty for default score"
													className="w-full rounded border border-border bg-card px-3 py-2 text-sm text-foregroundplaceholder:text-foreground/40 focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
												/>
											</div>

											{/* Conditions */}
											{cf.specifications && cf.specifications.length > 0 && (
												<div>
													<label className="mb-2 block text-sm font-medium text-foreground">
														Conditions ({cf.specifications.length})
													</label>
													<div className="space-y-2">
														{cf.specifications.map((spec: any) => (
															<label
																key={spec.name}
																className="flex items-center gap-2 rounded bg-card px-3 py-2"
															>
																<input
																	type="checkbox"
																	checked={conditionsEnabled[spec.name] ?? true}
																	onChange={() => toggleCondition(cf.trash_id, spec.name)}
																	className="h-4 w-4 rounded border-border bg-card text-primary focus:ring-primary"
																/>
																<span className="text-sm text-foreground/70">{spec.name}</span>
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
				<div className="rounded-xl border border-border bg-card p-8 text-center">
					<p className="text-foreground/60">
						No Custom Formats available. Please select some CF Groups in the previous step.
					</p>
				</div>
			)}

			{/* Navigation */}
			<div className="flex items-center justify-between border-t border-border pt-6">
				<button
					type="button"
					onClick={onBack}
					className="inline-flex items-center gap-2 rounded-lg bg-card px-4 py-2 text-sm font-medium text-foregroundtransition hover:bg-muted"
				>
					<ChevronLeft className="h-4 w-4" />
					Back
				</button>

				<button
					type="button"
					onClick={() => onNext(selections)}
					disabled={selectedCount === 0}
					className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-foregroundtransition hover:bg-primary/90 disabled:opacity-50"
				>
					Next: Create Template
					<ChevronRight className="h-4 w-4" />
				</button>
			</div>
		</div>
	);
};
