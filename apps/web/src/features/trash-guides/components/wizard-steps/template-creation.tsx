"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useImportQualityProfileWizard, useUpdateQualityProfileTemplate, useCreateClonedProfileTemplate } from "../../../../hooks/api/useQualityProfiles";
import { Alert, AlertDescription, Skeleton } from "../../../../components/ui";
import { ChevronLeft, Download, CheckCircle, Info, Save, Edit2, TrendingUp, TrendingDown, Minus } from "lucide-react";
import { THEME_GRADIENTS } from "../../../../lib/theme-gradients";
import { useColorTheme } from "../../../../providers/color-theme-provider";
import type { QualityProfileSummary } from "../../../../lib/api-client/trash-guides";
import { apiRequest } from "../../../../lib/api-client/base";

/**
 * Check if a trashId indicates a cloned profile from an instance
 * Cloned profile trashIds have format: cloned-{instanceId}-{profileId}-{uuid}
 */
function isClonedProfile(trashId: string | undefined): boolean {
	return !!trashId && trashId.startsWith("cloned-");
}

/**
 * Parse cloned profile trashId to extract instanceId and profileId
 * Format: cloned-{instanceId}-{profileId}-{uuid}
 * Where instanceId can contain dashes, profileId is a number, and uuid can be:
 * - Standard UUID: 5 parts (xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx)
 * - Fallback: 2 parts (timestamp-random alphanumeric)
 */
function parseClonedProfileId(trashId: string): { instanceId: string; profileId: number } | null {
	if (!isClonedProfile(trashId)) return null;

	// Remove "cloned-" prefix
	const withoutPrefix = trashId.slice(7); // "cloned-".length = 7
	if (!withoutPrefix) return null;

	// Split by "-"
	const parts = withoutPrefix.split("-");

	// Need at least: instanceId (1+ parts) + profileId (1 part) + uuid (2 or 5 parts) = 4 or 7 parts minimum
	if (parts.length < 4) return null;

	// Try to detect UUID format by testing the last segments
	// First, try standard 5-part UUID format
	const uuidParts5 = parts.slice(-5);
	const uuidCandidate5 = uuidParts5.join("-");
	// UUID regex: 8-4-4-4-12 hex digits
	const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

	let profileIdIndex: number;

	if (uuidRegex.test(uuidCandidate5) && parts.length >= 7) {
		// Standard 5-part UUID format detected
		profileIdIndex = parts.length - 6; // profileId is second-to-last before UUID
	} else {
		// Try fallback 2-part format (timestamp-random)
		const uuidParts2 = parts.slice(-2);
		if (parts.length < 4) return null; // Need at least instanceId + profileId + 2-part ID

		// Check if first part is numeric (timestamp) and second is alphanumeric
		const timestampPart = uuidParts2[0];
		const randomPart = uuidParts2[1];

		if (timestampPart && randomPart && /^\d+$/.test(timestampPart) && /^[a-z0-9]+$/i.test(randomPart)) {
			// Fallback 2-part format detected
			profileIdIndex = parts.length - 3; // profileId is third-to-last before 2-part ID
		} else {
			// Neither format matches
			return null;
		}
	}

	// Extract profileId and instanceId based on detected format
	const profileIdStr = parts[profileIdIndex];
	const instanceIdParts = parts.slice(0, profileIdIndex);
	const instanceId = instanceIdParts.join("-");

	// Validate that profileId and instanceId are non-empty
	if (!instanceId || !profileIdStr) return null;

	// Parse profileId as number
	const profileId = parseInt(profileIdStr, 10);
	if (isNaN(profileId) || profileId < 0) return null;

	return { instanceId, profileId };
}

/**
 * Wizard-specific profile type that allows undefined trashId for edit mode.
 * In edit mode, templates don't persist the original TRaSH profile ID.
 */
type WizardSelectedProfile = Omit<QualityProfileSummary, 'trashId'> & {
	trashId?: string;
};

interface TemplateCreationProps {
	serviceType: "RADARR" | "SONARR";
	wizardState: {
		selectedProfile: WizardSelectedProfile;
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
	const { colorTheme } = useColorTheme();
	const themeGradient = THEME_GRADIENTS[colorTheme];
	const [templateName, setTemplateName] = useState(wizardState.templateName);
	const [templateDescription, setTemplateDescription] = useState(wizardState.templateDescription);

	const importMutation = useImportQualityProfileWizard();
	const updateMutation = useUpdateQualityProfileTemplate();
	const clonedMutation = useCreateClonedProfileTemplate();

	// Detect if this is a cloned profile
	const isCloned = isClonedProfile(wizardState.selectedProfile.trashId);
	const clonedProfileInfo = isCloned ? parseClonedProfileId(wizardState.selectedProfile.trashId!) : null;

	// Only fetch profile details when we have a valid trashId (not in edit mode and not cloned)
	// In edit mode, trashId is undefined and we don't need profile data from TRaSH Guides
	// For cloned profiles, we fetch from the instance, not TRaSH cache
	const hasTrashId = !!wizardState.selectedProfile.trashId;
	const { data, isLoading } = useQuery({
		queryKey: isCloned
			? ["cloned-profile-details", wizardState.selectedProfile.trashId]
			: ["quality-profile-details", serviceType, wizardState.selectedProfile.trashId],
		queryFn: async () => {
			if (isCloned && clonedProfileInfo) {
				// Fetch from cloned profile endpoint
				return await apiRequest<any>(
					`/api/trash-guides/profile-clone/profile-details/${clonedProfileInfo.instanceId}/${clonedProfileInfo.profileId}`,
				);
			}
			// Fetch from TRaSH Guides cache
			return await apiRequest<any>(
				`/api/trash-guides/quality-profiles/${serviceType}/${wizardState.selectedProfile.trashId}`,
			);
		},
		// Skip fetch in edit mode (no trashId) - we already have all data from the template
		enabled: hasTrashId && !isEditMode,
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
			} else if (isCloned && clonedProfileInfo) {
				// Create template from cloned profile (instance-based)
				if (!wizardState.selectedProfile.trashId) {
					throw new Error("Cannot create template: missing cloned profile ID");
				}

				// Extract profile config from the data we fetched
				const profileData = data?.data?.profile || data?.profile;
				const instanceLabel = wizardState.selectedProfile.description?.replace("Cloned from ", "") || "Unknown Instance";

				await clonedMutation.mutateAsync({
					serviceType,
					trashId: wizardState.selectedProfile.trashId,
					templateName: templateName.trim(),
					templateDescription: templateDescription.trim() || undefined,
					customFormatSelections: wizardState.customFormatSelections,
					sourceInstanceId: clonedProfileInfo.instanceId,
					sourceProfileId: clonedProfileInfo.profileId,
					sourceProfileName: wizardState.selectedProfile.name,
					sourceInstanceLabel: instanceLabel,
					profileConfig: {
						upgradeAllowed: profileData?.upgradeAllowed ?? wizardState.selectedProfile.upgradeAllowed ?? true,
						cutoff: profileData?.cutoff ?? 0,
						minFormatScore: profileData?.minFormatScore ?? 0,
						cutoffFormatScore: profileData?.cutoffFormatScore ?? 0,
						items: profileData?.items || [],
						language: profileData?.language,
					},
				});
			} else {
				// Create new template from TRaSH Guides (trashId required)
				if (!wizardState.selectedProfile.trashId) {
					throw new Error("Cannot create template: missing TRaSH profile ID");
				}
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
			console.error(isEditMode ? "Update failed:" : isCloned ? "Cloned template creation failed:" : "Import failed:", error);
		}
	};

	// Only show loading state when actually fetching (not in edit mode)
	if (isLoading && !isEditMode) {
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
			<div
				className="rounded-xl border p-4"
				style={{
					borderColor: themeGradient.fromMuted,
					backgroundColor: themeGradient.fromLight,
				}}
			>
				<h4 className="font-medium text-fg mb-2">✅ {isEditMode ? 'Ready to Save!' : 'Almost Done!'}</h4>
				<p className="text-sm text-fg/70 mb-3">
					{isEditMode
						? `You've made changes to your template. Review and save to apply the updates.`
						: `You've completed the configuration. Now just name your template and you're ready to deploy it to your ${serviceType} instances.`}
				</p>
				{!isEditMode && (
					<p className="text-xs text-fg/60 italic">
						💡 Tip: Choose a descriptive name that reflects the quality preferences (e.g., &quot;4K HDR Optimized&quot;, &quot;Anime Quality Profile&quot;).
					</p>
				)}
			</div>

			{/* Summary */}
			<div className="rounded-xl border border-border bg-bg-subtle p-6">
				<div className="flex items-center justify-between mb-4">
					<h3 className="text-lg font-medium text-fg">{isEditMode ? 'Review & Update Template' : 'Review & Create Template'}</h3>
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
				<p className="text-fg/70">
					Review your selections below. You can go back to make changes if needed.
				</p>

				<div className="mt-6 space-y-4">
					{/* Quality Profile */}
					<div className="rounded-lg border border-border bg-bg-subtle p-4">
						<div className="flex items-center justify-between">
							<div className="flex items-center gap-2 text-sm font-medium text-fg">
								<CheckCircle className="h-4 w-4 text-green-400" />
								Quality Profile
							</div>
							{onEditStep && !isEditMode && (
								<button
									type="button"
									onClick={() => onEditStep("profile")}
									className="text-xs text-fg/60 hover:text-primary transition"
								>
									Change
								</button>
							)}
						</div>
						<p className="mt-2 text-sm text-fg/70">{wizardState.selectedProfile.name}</p>
						<div className="mt-3 flex flex-wrap gap-2">
							{wizardState.selectedProfile.language && (
								<span
									className="inline-flex items-center gap-1 rounded px-2 py-1 text-xs font-medium"
									style={{
										backgroundColor: themeGradient.fromLight,
										color: themeGradient.from,
									}}
								>
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
						<div className="rounded-lg border border-border bg-bg-subtle p-4">
							<div className="flex items-center justify-between">
								<div className="flex items-center gap-2 text-sm font-medium text-fg">
									<CheckCircle className="h-4 w-4 text-green-400" />
									Custom Format Groups ({selectedCFGroups.length})
								</div>
								{onEditStep && !isEditMode && (
									<button
										type="button"
										onClick={() => onEditStep("customize")}
										className="text-xs text-fg/60 hover:text-primary transition"
									>
										Edit Custom Formats
									</button>
								)}
							</div>
							<div className="mt-2 grid grid-cols-1 sm:grid-cols-2 gap-2">
								{selectedCFGroups.map((group: any) => (
									<div key={group.trash_id} className="text-sm text-fg/70 flex items-start gap-2">
										<span className="text-green-400 mt-0.5">•</span>
										<span>{group.name}</span>
									</div>
								))}
							</div>
						</div>
					)}

					{/* Custom Formats Breakdown */}
					<div className="rounded-lg border border-border bg-bg-subtle p-4">
						<div className="flex items-center justify-between">
							<div className="flex items-center gap-2 text-sm font-medium text-fg">
								<CheckCircle className="h-4 w-4 text-green-400" />
								Custom Formats ({selectedCFs.length} total)
							</div>
							{onEditStep && !isEditMode && (
								<button
									type="button"
									onClick={() => onEditStep("customize")}
									className="text-xs text-fg/60 hover:text-primary transition"
								>
									Customize
								</button>
							)}
						</div>

						{/* CF Count Breakdown */}
						<div className="mt-4 grid grid-cols-1 sm:grid-cols-3 gap-3">
							<div className="rounded bg-amber-500/10 border border-amber-500/20 p-3">
								<div className="text-xs font-medium text-amber-300">🔒 Mandatory</div>
								<div className="text-2xl font-bold text-fg mt-1">{mandatoryCount}</div>
								<div className="text-xs text-fg/60 mt-1">From profile</div>
							</div>
							<div className="rounded bg-green-500/10 border border-green-500/20 p-3">
								<div className="text-xs font-medium text-green-300">📦 From Groups</div>
								<div className="text-2xl font-bold text-fg mt-1">{fromGroupsCount}</div>
								<div className="text-xs text-fg/60 mt-1">Auto-selected</div>
							</div>
							<div
								className="rounded border p-3"
								style={{
									backgroundColor: themeGradient.fromLight,
									borderColor: themeGradient.fromMuted,
								}}
							>
								<div className="text-xs font-medium" style={{ color: themeGradient.from }}>✋ Manual</div>
								<div className="text-2xl font-bold text-fg mt-1">{manuallySelectedCount}</div>
								<div className="text-xs text-fg/60 mt-1">User added</div>
							</div>
						</div>

						{/* Score Distribution */}
						{scoreOverridesCount > 0 && (
							<div className="mt-4 pt-4 border-t border-border">
								<div className="flex items-center gap-2 text-xs font-medium text-fg/70 mb-3">
									<Info className="h-3 w-3" />
									Score Overrides ({scoreOverridesCount})
								</div>
								<div className="grid grid-cols-3 gap-2">
									<div className="flex items-center gap-2 text-xs">
										<TrendingUp className="h-3 w-3 text-green-400" />
										<span className="text-fg/70">
											<span className="font-medium text-green-400">{positiveScores}</span> positive
										</span>
									</div>
									<div className="flex items-center gap-2 text-xs">
										<TrendingDown className="h-3 w-3 text-red-400" />
										<span className="text-fg/70">
											<span className="font-medium text-red-400">{negativeScores}</span> negative
										</span>
									</div>
									<div className="flex items-center gap-2 text-xs">
										<Minus className="h-3 w-3 text-gray-400" />
										<span className="text-fg/70">
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
					<label className="mb-2 block text-sm font-medium text-fg">
						Template Name <span className="text-red-400">*</span>
					</label>
					<input
						type="text"
						value={templateName}
						onChange={(e) => setTemplateName(e.target.value)}
						placeholder="Enter template name"
						className="w-full rounded border border-border bg-bg-subtle px-3 py-2 text-sm text-fg placeholder:text-fg/40 focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
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
						className="w-full rounded border border-border bg-bg-subtle px-3 py-2 text-sm text-fg placeholder:text-fg/40 focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
					/>
				</div>
			</div>

			{/* Error/Success Messages */}
			{(importMutation.isError || updateMutation.isError || clonedMutation.isError) && (
				<Alert variant="danger">
					<AlertDescription>
						{importMutation.error instanceof Error
							? importMutation.error.message
							: updateMutation.error instanceof Error
								? updateMutation.error.message
								: clonedMutation.error instanceof Error
									? clonedMutation.error.message
									: isEditMode
										? "Failed to update template"
										: isCloned
											? "Failed to create template from cloned profile"
											: "Failed to import quality profile"}
					</AlertDescription>
				</Alert>
			)}

			{(importMutation.isSuccess || updateMutation.isSuccess || clonedMutation.isSuccess) && (
				<Alert variant="success">
					<AlertDescription>
						{isEditMode
							? 'Successfully updated template!'
							: isCloned
								? 'Successfully created template from cloned profile!'
								: 'Successfully imported quality profile as template!'}
					</AlertDescription>
				</Alert>
			)}

			{/* Navigation */}
			<div className="flex items-center justify-between border-t border-border pt-6">
				<button
					type="button"
					onClick={onBack}
					disabled={importMutation.isPending || updateMutation.isPending || clonedMutation.isPending}
					className="inline-flex items-center gap-2 rounded-lg bg-bg-subtle px-4 py-2 text-sm font-medium text-fg transition hover:bg-bg-hover disabled:opacity-50"
				>
					<ChevronLeft className="h-4 w-4" />
					Back
				</button>

				<button
					type="button"
					onClick={handleSubmit}
					disabled={!templateName.trim() || importMutation.isPending || updateMutation.isPending || clonedMutation.isPending}
					className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-fg transition hover:bg-primary/90 disabled:opacity-50"
				>
					{(importMutation.isPending || updateMutation.isPending || clonedMutation.isPending) ? (
						<>
							<div className="h-4 w-4 animate-spin rounded-full border-2 border-border border-t-fg" />
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
