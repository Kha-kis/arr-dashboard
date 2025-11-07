"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useImportQualityProfileWizard } from "../../../../hooks/api/useQualityProfiles";
import { Alert, AlertDescription, Skeleton } from "../../../../components/ui";
import { ChevronLeft, Download, CheckCircle, Info } from "lucide-react";
import type { QualityProfileSummary } from "../../../../lib/api-client/trash-guides";
import { apiRequest } from "../../../../lib/api-client/base";

interface TemplateCreationProps {
	serviceType: "RADARR" | "SONARR";
	wizardState: {
		selectedProfile: QualityProfileSummary;
		selectedGroups: Set<string>;
		customFormatSelections: Record<string, {
			selected: boolean;
			scoreOverride?: number;
			conditionsEnabled: Record<string, boolean>;
		}>;
		templateName: string;
		templateDescription: string;
	};
	onComplete: () => void;
	onBack: () => void;
}

export const TemplateCreation = ({
	serviceType,
	wizardState,
	onComplete,
	onBack,
}: TemplateCreationProps) => {
	const [templateName, setTemplateName] = useState(wizardState.templateName);
	const [templateDescription, setTemplateDescription] = useState(wizardState.templateDescription);

	const importMutation = useImportQualityProfileWizard();

	const { data, isLoading } = useQuery({
		queryKey: ["quality-profile-details", serviceType, wizardState.selectedProfile.trashId],
		queryFn: async () => {
			return await apiRequest<any>(
				`/api/trash-guides/quality-profiles/${serviceType}/${wizardState.selectedProfile.trashId}`,
			);
		},
	});

	const handleImport = async () => {
		if (!templateName.trim()) {
			return;
		}

		try {
			await importMutation.mutateAsync({
				serviceType,
				trashId: wizardState.selectedProfile.trashId,
				templateName: templateName.trim(),
				templateDescription: templateDescription.trim() || undefined,
				selectedCFGroups: Array.from(wizardState.selectedGroups),
				customFormatSelections: wizardState.customFormatSelections,
			});

			onComplete();
		} catch (error) {
			// Error will be displayed through mutation state
			console.error("Import failed:", error);
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

	// Build list of selected CF Groups for display
	const cfGroups = data?.cfGroups || [];
	const selectedCFGroups = cfGroups.filter((group: any) =>
		wizardState.selectedGroups.has(group.trash_id)
	);

	const selectedCFs = Object.entries(wizardState.customFormatSelections).filter(
		([_, sel]) => sel.selected,
	);

	return (
		<div className="space-y-6">
			{/* Introduction */}
			<div className="rounded-xl border border-blue-500/20 bg-blue-500/5 p-4">
				<h4 className="font-medium text-white mb-2">✅ Almost Done!</h4>
				<p className="text-sm text-white/70 mb-3">
					You've completed the configuration. Now just name your template and you're ready to deploy it to your {serviceType} instances.
				</p>
				<p className="text-xs text-white/60 italic">
					💡 Tip: Choose a descriptive name that reflects the quality preferences (e.g., "4K HDR Optimized", "Anime Quality Profile").
				</p>
			</div>

			{/* Summary */}
			<div className="rounded-xl border border-white/10 bg-white/5 p-6">
				<h3 className="text-lg font-medium text-white">Review & Create Template</h3>
				<p className="mt-2 text-sm text-white/70">
					Review your selections below. You can go back to make changes if needed.
				</p>

				<div className="mt-6 space-y-4">
					{/* Quality Profile */}
					<div className="rounded-lg border border-white/10 bg-white/5 p-4">
						<div className="flex items-center gap-2 text-sm font-medium text-white">
							<CheckCircle className="h-4 w-4 text-green-400" />
							Quality Profile
						</div>
						<p className="mt-2 text-sm text-white/70">{wizardState.selectedProfile.name}</p>
					</div>

					{/* CF Groups */}
					<div className="rounded-lg border border-white/10 bg-white/5 p-4">
						<div className="flex items-center gap-2 text-sm font-medium text-white">
							<CheckCircle className="h-4 w-4 text-green-400" />
							Custom Format Groups ({selectedCFGroups.length})
						</div>
						<div className="mt-2 space-y-1">
							{selectedCFGroups.map((group: any) => (
								<div key={group.trash_id} className="text-sm text-white/70">
									• {group.name}
								</div>
							))}
						</div>
					</div>

					{/* Custom Formats */}
					<div className="rounded-lg border border-white/10 bg-white/5 p-4">
						<div className="flex items-center gap-2 text-sm font-medium text-white">
							<CheckCircle className="h-4 w-4 text-green-400" />
							Custom Formats ({selectedCFs.length})
						</div>
						<div className="mt-2 flex items-center gap-2 text-xs text-white/60">
							<Info className="h-3 w-3" />
							<span>
								{selectedCFs.filter(([_, sel]) => sel.scoreOverride !== undefined).length} with
								score overrides
							</span>
						</div>
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
			{importMutation.isError && (
				<Alert variant="danger">
					<AlertDescription>
						{importMutation.error instanceof Error
							? importMutation.error.message
							: "Failed to import quality profile"}
					</AlertDescription>
				</Alert>
			)}

			{importMutation.isSuccess && (
				<Alert variant="success">
					<AlertDescription>
						Successfully imported quality profile as template!
					</AlertDescription>
				</Alert>
			)}

			{/* Navigation */}
			<div className="flex items-center justify-between border-t border-white/10 pt-6">
				<button
					type="button"
					onClick={onBack}
					disabled={importMutation.isPending}
					className="inline-flex items-center gap-2 rounded-lg bg-white/10 px-4 py-2 text-sm font-medium text-white transition hover:bg-white/20 disabled:opacity-50"
				>
					<ChevronLeft className="h-4 w-4" />
					Back
				</button>

				<button
					type="button"
					onClick={handleImport}
					disabled={!templateName.trim() || importMutation.isPending}
					className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white transition hover:bg-primary/90 disabled:opacity-50"
				>
					{importMutation.isPending ? (
						<>
							<div className="h-4 w-4 animate-spin rounded-full border-2 border-white/30 border-t-white" />
							Creating Template...
						</>
					) : (
						<>
							<Download className="h-4 w-4" />
							Create Template
						</>
					)}
				</button>
			</div>
		</div>
	);
};
