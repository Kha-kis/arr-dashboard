"use client";

import { useState, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { Alert, AlertDescription, Skeleton, Card, CardHeader, CardTitle, CardDescription, CardContent } from "../../../../components/ui";
import { ChevronLeft, ChevronRight, Info, AlertCircle } from "lucide-react";
import type { QualityProfileSummary } from "../../../../lib/api-client/trash-guides";
import { apiRequest } from "../../../../lib/api-client/base";

interface CFConfigurationProps {
	serviceType: "RADARR" | "SONARR";
	qualityProfile: QualityProfileSummary;
	selectedGroups: Set<string>; // Groups selected in Step 2a
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
	onBack: () => void;
}

export const CFConfiguration = ({
	serviceType,
	qualityProfile,
	selectedGroups,
	initialSelections,
	templateName: initialTemplateName,
	templateDescription: initialTemplateDescription,
	onNext,
	onBack,
}: CFConfigurationProps) => {
	const [selections, setSelections] = useState(initialSelections);
	const [templateName, setTemplateName] = useState(initialTemplateName);
	const [templateDescription, setTemplateDescription] = useState(initialTemplateDescription);

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
				const isGroupDefault = group.defaultEnabled === true;

				if (Array.isArray(group.custom_formats)) {
					for (const cf of group.custom_formats) {
						const cfTrashId = typeof cf === 'string' ? cf : cf.trash_id;
						const isCFRequired = typeof cf === 'object' && cf.required === true;
						const isCFDefault = typeof cf === 'object' && cf.defaultChecked === true;
						// Auto-select if group is default AND (CF is required OR CF has default checked)
						const shouldAutoSelect = isGroupDefault && (isCFRequired || isCFDefault);

						newSelections[cfTrashId] = {
							selected: shouldAutoSelect,
							scoreOverride: undefined,
							conditionsEnabled: {},
						};
					}
				}
			}

			setSelections(newSelections);
		}
	}, [data]);

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

	const handleNext = () => {
		if (!templateName.trim()) return;

		// Pass selections and template info to the next step (Summary/Review)
		onNext(selections, templateName.trim(), templateDescription.trim());
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

	return (
		<div className="space-y-6">
			{/* Profile Summary */}
			<Card>
				<CardHeader>
					<CardTitle>{qualityProfile.name}</CardTitle>
					<CardDescription>
						Configure custom formats and create your template. {selectedCount} custom formats selected.
					</CardDescription>
				</CardHeader>
			</Card>

			{/* Introduction */}
			<Alert>
				<Info className="h-4 w-4" />
				<AlertDescription>
					<strong>Mandatory Custom Formats</strong> (from the quality profile) are required and locked, followed by <strong>Optional CF Groups</strong> organized by category. You have full control to enable/disable optional formats.
				</AlertDescription>
			</Alert>

			{/* Mandatory Custom Formats (from profile.formatItems) */}
			{mandatoryCFs.length > 0 && (
				<Card className="border-amber-500/30 bg-amber-500/5">
					<CardHeader>
						<CardTitle className="flex items-center gap-2">
							<span className="inline-flex items-center gap-1 rounded bg-amber-500/20 px-2 py-1 text-sm font-medium text-amber-300">
								🔒 Mandatory Custom Formats
							</span>
							<span className="text-sm font-normal text-fg-muted">
								({mandatoryCFs.length} required)
							</span>
						</CardTitle>
						<CardDescription>
							These custom formats are required by the TRaSH Guides quality profile and cannot be removed. You can override their scores.
						</CardDescription>
					</CardHeader>
					<CardContent>
						<div className="space-y-2">
							{mandatoryCFs.map((cf: any) => {
								const isSelected = selections[cf.trash_id]?.selected ?? true;
								const scoreOverride = selections[cf.trash_id]?.scoreOverride;
								const displayScore = cf.score ?? 0;

								return (
									<div
										key={cf.trash_id}
										className="rounded-lg p-4 border border-amber-500/30 bg-amber-500/10"
									>
										<div className="flex items-start gap-3">
											<div className="mt-1 h-5 w-5 flex items-center justify-center rounded border border-amber-500/50 bg-amber-500/20 text-amber-400">
												<span className="text-xs">🔒</span>
											</div>
											<div className="flex-1">
												<div className="flex items-center gap-2 mb-2">
													<span className="font-medium text-fg">{cf.displayName || cf.name}</span>
													<span className="inline-flex items-center gap-1 rounded bg-amber-500/20 px-2 py-0.5 text-xs font-medium text-amber-300">
														Mandatory
													</span>
												</div>

												{cf.description && (
													<details className="mb-2 group">
														<summary className="cursor-pointer text-xs text-primary hover:text-primary/80 transition flex items-center gap-1">
															<span className="group-open:rotate-90 transition-transform">▶</span>
															<span>What is this?</span>
														</summary>
														<div className="mt-2 pl-4 text-sm text-fg-subtle prose prose-invert prose-sm max-w-none">
															<div dangerouslySetInnerHTML={{ __html: cf.description }} />
														</div>
													</details>
												)}

												<div className="flex items-center gap-2">
													<label className="text-xs text-fg-muted">
														Score (Default: {displayScore}):
													</label>
													<input
														type="number"
														value={scoreOverride ?? ""}
														onChange={(e) => updateScore(cf.trash_id, e.target.value)}
														placeholder={String(displayScore)}
														className="w-24 rounded border border-border bg-bg-hover px-2 py-1 text-sm text-fg placeholder:text-fg-muted focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
														onClick={(e) => e.stopPropagation()}
													/>
													{scoreOverride !== undefined && (
														<button
															type="button"
															onClick={() => updateScore(cf.trash_id, "")}
															className="text-xs text-primary hover:text-primary/80 transition"
															title="Reset to default"
														>
															↺ Reset
														</button>
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
			{groupedCFs.length > 0 && (
				<div className="space-y-4">
					<div className="flex items-center justify-between">
						<h3 className="text-lg font-semibold text-fg">
							<span className="inline-flex items-center gap-2">
								Optional Custom Format Groups
								<span className="text-sm font-normal text-fg-muted">
									(Select groups and formats based on your preferences)
								</span>
							</span>
						</h3>
						<span className="text-sm text-fg-muted">{groupedCFs.length} groups available</span>
					</div>

					{groupedCFs.map((group: any) => {
						const groupCFs = group.customFormats || [];
						const selectedInGroup = groupCFs.filter((cf: any) =>
							selections[cf.trash_id]?.selected
						).length;
						const isGroupDefault = group.default === true;
						const isRecommended = group.quality_profiles?.score && group.quality_profiles.score > 0;

						return (
							<Card key={group.trash_id}>
								<CardHeader>
									<div className="flex items-center justify-between gap-2 flex-wrap">
										<div className="flex items-center gap-2 flex-wrap">
											<CardTitle>{group.name}</CardTitle>
											{isGroupDefault && (
												<span className="inline-flex items-center gap-1 rounded bg-green-500/20 px-2 py-0.5 text-xs font-medium text-green-300">
													✅ Default
												</span>
											)}
											{!isGroupDefault && (
												<span className="inline-flex items-center gap-1 rounded bg-blue-500/20 px-2 py-0.5 text-xs font-medium text-blue-300">
													⚙️ Optional
												</span>
											)}
											{isRecommended && (
												<span className="inline-flex items-center gap-1 rounded bg-amber-500/20 px-2 py-0.5 text-xs font-medium text-amber-300">
													📘 Recommended
												</span>
											)}
										</div>
										<div className="flex gap-2">
											<button
												type="button"
												onClick={() => selectAllInGroup(groupCFs)}
												className="text-xs px-2 py-1 rounded bg-bg-hover text-fg hover:bg-bg-active transition"
											>
												Select All
											</button>
											<button
												type="button"
												onClick={() => deselectAllInGroup(groupCFs)}
												className="text-xs px-2 py-1 rounded bg-bg-hover text-fg hover:bg-bg-active transition"
											>
												Deselect All
											</button>
										</div>
									</div>

									<CardDescription>
										<span className="text-fg-muted">
											{groupCFs.length} formats • {selectedInGroup} selected
										</span>
									</CardDescription>

									{group.trash_description && (
										<div className="rounded-lg border border-blue-500/30 bg-blue-500/10 p-3 mt-2">
											<div className="flex items-start gap-2">
												<AlertCircle className="h-4 w-4 text-blue-400 mt-0.5 flex-shrink-0" />
												<div
													className="text-sm text-blue-100"
													dangerouslySetInnerHTML={{
														__html: group.trash_description,
													}}
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
											const isRequired = cf.required === true;

											return (
												<div
													key={cf.trash_id}
													className={`rounded-lg p-3 border transition ${
														isSelected
															? "bg-primary/10 border-primary/30"
															: "bg-bg-hover border-border/50"
													}`}
												>
													<div className="flex items-start gap-3">
														<input
															type="checkbox"
															checked={isSelected}
															onChange={() => !isRequired && toggleCF(cf.trash_id)}
															disabled={isRequired}
															className={`mt-1 h-5 w-5 rounded border-border bg-bg-hover text-primary focus:ring-primary ${
																isRequired ? "cursor-not-allowed opacity-50" : "cursor-pointer"
															}`}
														/>
														<div className="flex-1">
															<div className="flex items-center gap-2 flex-wrap mb-2">
																<span className="font-medium text-fg">{cf.displayName || cf.name}</span>
																{isRequired && (
																	<span className="inline-flex items-center gap-1 rounded bg-red-500/20 px-2 py-0.5 text-xs font-medium text-red-300">
																		🔒 Required
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
																		<div dangerouslySetInnerHTML={{ __html: cf.description }} />
																	</div>
																</details>
															)}

															{isSelected && (
																<div className="flex items-center gap-2">
																	<label className="text-xs text-fg-muted">
																		Score (Default: {cf.score ?? 0}):
																	</label>
																	<input
																		type="number"
																		value={scoreOverride ?? ""}
																		onChange={(e) => updateScore(cf.trash_id, e.target.value)}
																		placeholder={String(cf.score ?? 0)}
																		className="w-24 rounded border border-border bg-bg-hover px-2 py-1 text-sm text-fg placeholder:text-fg-muted focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
																		onClick={(e) => e.stopPropagation()}
																	/>
																	{scoreOverride !== undefined && (
																		<button
																			type="button"
																			onClick={() => updateScore(cf.trash_id, "")}
																			className="text-xs text-primary hover:text-primary/80 transition"
																			title="Reset to default"
																		>
																			↺ Reset
																		</button>
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
						);
					})}
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
			<div className="flex items-center justify-between border-t border-border pt-6">
				<button
					type="button"
					onClick={onBack}
					className="inline-flex items-center gap-2 rounded-lg bg-bg-hover px-4 py-2 text-sm font-medium text-fg transition hover:bg-bg-active disabled:opacity-50"
				>
					<ChevronLeft className="h-4 w-4" />
					Back
				</button>

				<button
					type="button"
					onClick={handleNext}
					disabled={!templateName.trim() || selectedCount === 0}
					className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white transition hover:bg-primary/90 disabled:opacity-50"
				>
					Next: Review
					<ChevronRight className="h-4 w-4" />
				</button>
			</div>
		</div>
	);
};
