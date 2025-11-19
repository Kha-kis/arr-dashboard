"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useImportQualityProfileWizard, useUpdateQualityProfileTemplate } from "../../../../hooks/api/useQualityProfiles";
import { Alert, AlertDescription, Skeleton } from "../../../../components/ui";
import { ChevronLeft, Download, CheckCircle, Info, Save, Edit2, TrendingUp, TrendingDown, Minus } from "lucide-react";
import type { QualityProfileSummary } from "../../../../lib/api-client/trash-guides";
import { apiRequest } from "../../../../lib/api-client/base";

interface TemplateCreationProps {
	serviceType: "RADARR" | "SONARR";
	wizardState: {
		selectedProfile: QualityProfileSummary;
		customFormatSelections: Record<string, {
			selected: boolean;
			scoreOverride?: number;
			conditionsEnabled: Record<string, boolean>;
		}>;
		templateName: string;
		templateDescription: string;
	};
	templateId?: string; // For editing existing templates
	isEditMode?: boolean;
	onComplete: () => void;
	onBack: () => void;
	onEditStep?: (step: "profile" | "customize") => void; // Quick edit navigation
}

export const TemplateCreation = ({
	serviceType,
	wizardState,
	templateId,
	isEditMode = false,
	onComplete,
	onBack,
	onEditStep,
}: TemplateCreationProps) => {
	const [templateName, setTemplateName] = useState(wizardState.templateName);
	const [templateDescription, setTemplateDescription] = useState(wizardState.templateDescription);

	const importMutation = useImportQualityProfileWizard();
	const updateMutation = useUpdateQualityProfileTemplate();

	const { data, isLoading } = useQuery({
		queryKey: ["quality-profile-details", serviceType, wizardState.selectedProfile.trashId],
		queryFn: async () => {
			return await apiRequest<any>(
				`/api/trash-guides/quality-profiles/${serviceType}/${wizardState.selectedProfile.trashId}`,
			);
		},
	});

	const handleSubmit = async () => {
		if (!templateName.trim()) {
			return;
		}

		// Compute which CF groups to send based on selected CFs
		const selectedCFTrashIds = new Set(
			Object.entries(wizardState.customFormatSelections)
				.filter(([_, sel]) => sel.selected)
				.map(([trashId]) => trashId)
		);

		// Find all groups that contain at least one selected CF
		const cfGroups = data?.cfGroups || [];
		const relevantGroupIds = cfGroups
			.filter((group: any) => {
				const groupCFs = Array.isArray(group.custom_formats) ? group.custom_formats : [];
				return groupCFs.some((cf: any) => {
					const cfTrashId = typeof cf === 'string' ? cf : cf.trash_id;
					return selectedCFTrashIds.has(cfTrashId);
				});
			})
			.map((group: any) => group.trash_id);

		try {
			if (isEditMode && templateId) {
				// Update existing template (no trashId needed - we're updating existing config)
				await updateMutation.mutateAsync({
					templateId,
					serviceType,
					templateName: templateName.trim(),
					templateDescription: templateDescription.trim() || undefined,
					selectedCFGroups: relevantGroupIds,
					customFormatSelections: wizardState.customFormatSelections,
				});
			} else {
				// Create new template (trashId required to fetch from TRaSH Guides)
				await importMutation.mutateAsync({
					serviceType,
					trashId: wizardState.selectedProfile.trashId,
					templateName: templateName.trim(),
					templateDescription: templateDescription.trim() || undefined,
					selectedCFGroups: relevantGroupIds,
					customFormatSelections: wizardState.customFormatSelections,
				});
			}

			onComplete();
		} catch (error) {
			// Error will be displayed through mutation state
			console.error(isEditMode ? "Update failed:" : "Import failed:", error);
		}
	};

	if (isLoading) {
		return (
			<div className="space-y-4">
				<Skeleton className="h-32" />
				<Skeleton className="h-48" />
			</div>
		);
	}

	// Build list of selected CF Groups for display (groups with at least one selected CF)
	const cfGroups = data?.cfGroups || [];
	const selectedCFTrashIds = new Set(
		Object.entries(wizardState.customFormatSelections)
			.filter(([_, sel]) => sel.selected)
			.map(([trashId]) => trashId)
	);

	const selectedCFGroups = cfGroups.filter((group: any) => {
		const groupCFs = Array.isArray(group.custom_formats) ? group.custom_formats : [];
		return groupCFs.some((cf: any) => {
			const cfTrashId = typeof cf === 'string' ? cf : cf.trash_id;
			return selectedCFTrashIds.has(cfTrashId);
		});
	});

	const selectedCFs = Object.entries(wizardState.customFormatSelections).filter(
		([_, sel]) => sel.selected,
	);

	// Categorize CFs by their properties
	const mandatoryCFs = data?.mandatoryCFs || [];
	const mandatoryCFIds = new Set(mandatoryCFs.map((cf: any) => cf.trash_id));

	// CFs from groups that have at least one selected CF
	// (this replaces the previous step 2 group selection - now inferred from CF selections)
	const groupsWithSelectedCFs = new Set(selectedCFGroups.map((g: any) => g.trash_id));
	const cfsFromSelectedGroups = cfGroups
		.filter((group: any) => groupsWithSelectedCFs.has(group.trash_id))
		.flatMap((group: any) => {
			const groupCFs = Array.isArray(group.custom_formats) ? group.custom_formats : [];
			return groupCFs.map((cf: any) => (typeof cf === 'string' ? cf : cf.trash_id));
		});
	const cfsFromSelectedGroupsSet = new Set(cfsFromSelectedGroups);

	// Count breakdown
	const mandatoryCount = selectedCFs.filter(([trashId]) => mandatoryCFIds.has(trashId)).length;
	const fromGroupsCount = selectedCFs.filter(([trashId]) =>
		!mandatoryCFIds.has(trashId) && cfsFromSelectedGroupsSet.has(trashId)
	).length;
	const manuallySelectedCount = selectedCFs.filter(([trashId]) =>
		!mandatoryCFIds.has(trashId) && !cfsFromSelectedGroupsSet.has(trashId)
	).length;

	// Score distribution
	const scoreOverridesCount = selectedCFs.filter(([_, sel]) => sel.scoreOverride !== undefined).length;
	const positiveScores = selectedCFs.filter(([_, sel]) => {
		const score = sel.scoreOverride ?? 0;
		return score > 0;
	}).length;
	const negativeScores = selectedCFs.filter(([_, sel]) => {
		const score = sel.scoreOverride ?? 0;
		return score < 0;
	}).length;
	const neutralScores = selectedCFs.filter(([_, sel]) => {
		const score = sel.scoreOverride ?? 0;
		return score === 0;
	}).length;

	return (
		<div className="space-y-6">
			{/* Introduction */}
			<div className="rounded-xl border border-blue-500/20 bg-blue-500/5 p-4">
				<h4 className="font-medium text-white mb-2">✅ {isEditMode ? 'Ready to Save!' : 'Almost Done!'}</h4>
				<p className="text-sm text-white/70 mb-3">
					{isEditMode
						? `You've made changes to your template. Review and save to apply the updates.`
						: `You've completed the configuration. Now just name your template and you're ready to deploy it to your ${serviceType} instances.`}
				</p>
				{!isEditMode && (
					<p className="text-xs text-white/60 italic">
						💡 Tip: Choose a descriptive name that reflects the quality preferences (e.g., "4K HDR Optimized", "Anime Quality Profile").
					</p>
				)}
			</div>

			{/* Summary */}
			<div className="rounded-xl border border-white/10 bg-white/5 p-6">
				<div className="flex items-center justify-between mb-4">
					<h3 className="text-lg font-medium text-white">{isEditMode ? 'Review & Update Template' : 'Review & Create Template'}</h3>
					{onEditStep && !isEditMode && (
						<button
							type="button"
							onClick={() => onEditStep("customize")}
							className="inline-flex items-center gap-1 text-xs text-primary hover:text-primary/80 transition"
						>
							<Edit2 className="h-3 w-3" />
							Edit Selections
						</button>
					)}
				</div>
				<p className="text-white/70">
					Review your selections below. You can go back to make changes if needed.
				</p>

				<div className="mt-6 space-y-4">
					{/* Quality Profile */}
					<div className="rounded-lg border border-white/10 bg-white/5 p-4">
						<div className="flex items-center justify-between">
							<div className="flex items-center gap-2 text-sm font-medium text-white">
								<CheckCircle className="h-4 w-4 text-green-400" />
								Quality Profile
							</div>
							{onEditStep && !isEditMode && (
								<button
									type="button"
									onClick={() => onEditStep("profile")}
									className="text-xs text-white/60 hover:text-primary transition"
								>
									Change
								</button>
							)}
						</div>
						<p className="mt-2 text-sm text-white/70">{wizardState.selectedProfile.name}</p>
						<div className="mt-3 flex flex-wrap gap-2">
							{wizardState.selectedProfile.language && (
								<span className="inline-flex items-center gap-1 rounded bg-blue-500/20 px-2 py-1 text-xs font-medium text-blue-300">
									🌐 {wizardState.selectedProfile.language}
								</span>
							)}
							{wizardState.selectedProfile.scoreSet && (
								<span className="inline-flex items-center gap-1 rounded bg-purple-500/20 px-2 py-1 text-xs font-medium text-purple-300">
									📊 {wizardState.selectedProfile.scoreSet}
								</span>
							)}
							<span className="inline-flex items-center gap-1 rounded bg-green-500/20 px-2 py-1 text-xs font-medium text-green-300">
								🎬 {wizardState.selectedProfile.cutoff}
							</span>
						</div>
					</div>

					{/* CF Groups */}
					{selectedCFGroups.length > 0 && (
						<div className="rounded-lg border border-white/10 bg-white/5 p-4">
							<div className="flex items-center justify-between">
								<div className="flex items-center gap-2 text-sm font-medium text-white">
									<CheckCircle className="h-4 w-4 text-green-400" />
									Custom Format Groups ({selectedCFGroups.length})
								</div>
								{onEditStep && !isEditMode && (
									<button
										type="button"
										onClick={() => onEditStep("customize")}
										className="text-xs text-white/60 hover:text-primary transition"
									>
										Edit Custom Formats
									</button>
								)}
							</div>
							<div className="mt-2 grid grid-cols-1 sm:grid-cols-2 gap-2">
								{selectedCFGroups.map((group: any) => (
									<div key={group.trash_id} className="text-sm text-white/70 flex items-start gap-2">
										<span className="text-green-400 mt-0.5">•</span>
										<span>{group.name}</span>
									</div>
								))}
							</div>
						</div>
					)}

					{/* Custom Formats Breakdown */}
					<div className="rounded-lg border border-white/10 bg-white/5 p-4">
						<div className="flex items-center justify-between">
							<div className="flex items-center gap-2 text-sm font-medium text-white">
								<CheckCircle className="h-4 w-4 text-green-400" />
								Custom Formats ({selectedCFs.length} total)
							</div>
							{onEditStep && !isEditMode && (
								<button
									type="button"
									onClick={() => onEditStep("customize")}
									className="text-xs text-white/60 hover:text-primary transition"
								>
									Customize
								</button>
							)}
						</div>

						{/* CF Count Breakdown */}
						<div className="mt-4 grid grid-cols-1 sm:grid-cols-3 gap-3">
							<div className="rounded bg-amber-500/10 border border-amber-500/20 p-3">
								<div className="text-xs font-medium text-amber-300">🔒 Mandatory</div>
								<div className="text-2xl font-bold text-white mt-1">{mandatoryCount}</div>
								<div className="text-xs text-white/60 mt-1">From profile</div>
							</div>
							<div className="rounded bg-green-500/10 border border-green-500/20 p-3">
								<div className="text-xs font-medium text-green-300">📦 From Groups</div>
								<div className="text-2xl font-bold text-white mt-1">{fromGroupsCount}</div>
								<div className="text-xs text-white/60 mt-1">Auto-selected</div>
							</div>
							<div className="rounded bg-blue-500/10 border border-blue-500/20 p-3">
								<div className="text-xs font-medium text-blue-300">✋ Manual</div>
								<div className="text-2xl font-bold text-white mt-1">{manuallySelectedCount}</div>
								<div className="text-xs text-white/60 mt-1">User added</div>
							</div>
						</div>

						{/* Score Distribution */}
						{scoreOverridesCount > 0 && (
							<div className="mt-4 pt-4 border-t border-white/10">
								<div className="flex items-center gap-2 text-xs font-medium text-white/70 mb-3">
									<Info className="h-3 w-3" />
									Score Overrides ({scoreOverridesCount})
								</div>
								<div className="grid grid-cols-3 gap-2">
									<div className="flex items-center gap-2 text-xs">
										<TrendingUp className="h-3 w-3 text-green-400" />
										<span className="text-white/70">
											<span className="font-medium text-green-400">{positiveScores}</span> positive
										</span>
									</div>
									<div className="flex items-center gap-2 text-xs">
										<TrendingDown className="h-3 w-3 text-red-400" />
										<span className="text-white/70">
											<span className="font-medium text-red-400">{negativeScores}</span> negative
										</span>
									</div>
									<div className="flex items-center gap-2 text-xs">
										<Minus className="h-3 w-3 text-gray-400" />
										<span className="text-white/70">
											<span className="font-medium text-gray-400">{neutralScores}</span> neutral
										</span>
									</div>
								</div>
							</div>
						)}
					</div>
				</div>
			</div>

			{/* Template Details */}
			<div className="space-y-4">
				<div>
					<label className="mb-2 block text-sm font-medium text-white">
						Template Name <span className="text-red-400">*</span>
					</label>
					<input
						type="text"
						value={templateName}
						onChange={(e) => setTemplateName(e.target.value)}
						placeholder="Enter template name"
						className="w-full rounded border border-white/20 bg-white/10 px-3 py-2 text-sm text-white placeholder:text-white/40 focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
					/>
				</div>

				<div>
					<label className="mb-2 block text-sm font-medium text-white">
						Description (Optional)
					</label>
					<textarea
						value={templateDescription}
						onChange={(e) => setTemplateDescription(e.target.value)}
						placeholder="Enter template description"
						rows={4}
						className="w-full rounded border border-white/20 bg-white/10 px-3 py-2 text-sm text-white placeholder:text-white/40 focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
					/>
				</div>
			</div>

			{/* Error/Success Messages */}
			{(importMutation.isError || updateMutation.isError) && (
				<Alert variant="danger">
					<AlertDescription>
						{importMutation.error instanceof Error
							? importMutation.error.message
							: updateMutation.error instanceof Error
								? updateMutation.error.message
								: isEditMode
									? "Failed to update template"
									: "Failed to import quality profile"}
					</AlertDescription>
				</Alert>
			)}

			{(importMutation.isSuccess || updateMutation.isSuccess) && (
				<Alert variant="success">
					<AlertDescription>
						{isEditMode ? 'Successfully updated template!' : 'Successfully imported quality profile as template!'}
					</AlertDescription>
				</Alert>
			)}

			{/* Navigation */}
			<div className="flex items-center justify-between border-t border-white/10 pt-6">
				<button
					type="button"
					onClick={onBack}
					disabled={importMutation.isPending || updateMutation.isPending}
					className="inline-flex items-center gap-2 rounded-lg bg-white/10 px-4 py-2 text-sm font-medium text-white transition hover:bg-white/20 disabled:opacity-50"
				>
					<ChevronLeft className="h-4 w-4" />
					Back
				</button>

				<button
					type="button"
					onClick={handleSubmit}
					disabled={!templateName.trim() || importMutation.isPending || updateMutation.isPending}
					className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white transition hover:bg-primary/90 disabled:opacity-50"
				>
					{(importMutation.isPending || updateMutation.isPending) ? (
						<>
							<div className="h-4 w-4 animate-spin rounded-full border-2 border-white/30 border-t-white" />
							{isEditMode ? 'Updating Template...' : 'Creating Template...'}
						</>
					) : (
						<>
							{isEditMode ? <Save className="h-4 w-4" /> : <Download className="h-4 w-4" />}
							{isEditMode ? 'Update Template' : 'Create Template'}
						</>
					)}
				</button>
			</div>
		</div>
	);
};
