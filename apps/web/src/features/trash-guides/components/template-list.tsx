"use client";

import { useState, useEffect } from "react";
import type { TrashTemplate } from "@arr/shared";
import {
	useTemplates,
	useDeleteTemplate,
	useDuplicateTemplate,
	TEMPLATES_QUERY_KEY,
} from "../../../hooks/api/useTemplates";
import { PremiumEmptyState } from "../../../components/layout";
import {
	AlertCircle,
	Plus,
	Download,
	Copy,
	Trash2,
	Edit,
	FileText,
	RefreshCw,
	Star,
	Rocket,
	Layers,
	X,
	Search,
	ArrowUpDown,
	Loader2,
} from "lucide-react";
import { SEMANTIC_COLORS, getServiceGradient } from "../../../lib/theme-gradients";
import { useThemeGradient } from "../../../hooks/useThemeGradient";
import { useUnlinkTemplateFromInstance } from "../../../hooks/api/useDeploymentPreview";
import { TemplateStats } from "./template-stats";
import { SyncValidationModal } from "./sync-validation-modal";
import { SyncProgressModal } from "./sync-progress-modal";
import { useExecuteSync } from "../../../hooks/api/useSync";
import { useTemplateUpdates } from "../../../hooks/api/useTemplateUpdates";
import { TemplateUpdateBanner } from "./template-update-banner";
import { DeploymentPreviewModal } from "./deployment-preview-modal";
import { BulkDeploymentModal } from "./bulk-deployment-modal";
import { useServicesQuery } from "../../../hooks/api/useServicesQuery";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { EnhancedTemplateExportModal } from "./enhanced-template-export-modal";
import { EnhancedTemplateImportModal } from "./enhanced-template-import-modal";
import { getEffectiveQualityConfig } from "../lib/quality-config-utils";

interface TemplateListProps {
	serviceType?: "RADARR" | "SONARR";
	onCreateNew: () => void;
	onEdit: (template: TrashTemplate) => void;
	onImport: () => void;
	onBrowseQualityProfiles: (serviceType: "RADARR" | "SONARR") => void;
}

/**
 * Premium Template List Component
 *
 * Features:
 * - Glassmorphic template cards
 * - Theme-aware styling
 * - Staggered animations
 * - Premium action buttons
 */
export const TemplateList = ({ serviceType, onCreateNew, onEdit, onImport, onBrowseQualityProfiles }: TemplateListProps) => {
	const { gradient: themeGradient } = useThemeGradient();

	// Search, filter, and sort state
	const [searchInput, setSearchInput] = useState("");
	const [debouncedSearch, setDebouncedSearch] = useState("");
	const [sortBy, setSortBy] = useState<"name" | "createdAt" | "updatedAt" | "usageCount">("updatedAt");
	const [sortOrder, setSortOrder] = useState<"asc" | "desc">("desc");

	// Debounce search input
	useEffect(() => {
		const timer = setTimeout(() => {
			setDebouncedSearch(searchInput);
		}, 300);
		return () => clearTimeout(timer);
	}, [searchInput]);

	const { data, isLoading, error } = useTemplates({
		serviceType,
		search: debouncedSearch || undefined,
		sortBy,
		sortOrder,
	});
	const { data: updatesData } = useTemplateUpdates();
	const { data: servicesData } = useServicesQuery();
	const deleteMutation = useDeleteTemplate();
	const duplicateMutation = useDuplicateTemplate();
	const executeSync = useExecuteSync();
	const unlinkMutation = useUnlinkTemplateFromInstance();
	const queryClient = useQueryClient();

	// Modal states
	const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null);
	const [duplicateName, setDuplicateName] = useState<string>("");
	const [duplicatingId, setDuplicatingId] = useState<string | null>(null);
	const [instanceSelectorTemplate, setInstanceSelectorTemplate] = useState<{
		templateId: string;
		templateName: string;
		serviceType: "RADARR" | "SONARR";
	} | null>(null);
	const [validationModal, setValidationModal] = useState<{
		templateId: string;
		templateName: string;
		instanceId: string;
		instanceName: string;
	} | null>(null);
	const [progressModal, setProgressModal] = useState<{
		syncId: string;
		templateName: string;
		instanceName: string;
	} | null>(null);
	const [deploymentModal, setDeploymentModal] = useState<{
		templateId: string;
		templateName: string;
		instanceId: string;
		instanceLabel: string;
	} | null>(null);
	const [exportModal, setExportModal] = useState<{
		templateId: string;
		templateName: string;
	} | null>(null);
	const [importModal, setImportModal] = useState(false);
	const [unlinkConfirm, setUnlinkConfirm] = useState<{
		templateId: string;
		templateName: string;
		instanceId: string;
		instanceName: string;
	} | null>(null);
	const [bulkDeployModal, setBulkDeployModal] = useState<{
		templateId: string;
		templateName: string;
		serviceType: "RADARR" | "SONARR";
		templateDefaultQualityConfig?: TrashTemplate["config"]["customQualityConfig"];
		instanceOverrides?: TrashTemplate["instanceOverrides"];
		instances: Array<{ instanceId: string; instanceLabel: string; instanceType: string }>;
	} | null>(null);

	const handleDelete = async (templateId: string) => {
		try {
			await deleteMutation.mutateAsync(templateId);
			setDeleteConfirm(null);
		} catch (error) {
			console.error("Delete failed:", error);
			const errorMessage = error instanceof Error ? error.message : "Unknown error occurred";
			toast.error("Failed to delete template", { description: errorMessage });
		}
	};

	const handleDuplicate = async (templateId: string) => {
		if (!duplicateName.trim()) {
			toast.error("Please enter a name for the duplicate");
			return;
		}

		try {
			await duplicateMutation.mutateAsync({
				templateId,
				newName: duplicateName,
			});
			setDuplicatingId(null);
			setDuplicateName("");
		} catch (error) {
			console.error("Duplicate failed:", error);
			const errorMessage = error instanceof Error ? error.message : "Unknown error occurred";
			toast.error("Failed to duplicate template", { description: errorMessage });
		}
	};

	const handleSyncValidationComplete = async (resolutions: Record<string, "REPLACE" | "SKIP">) => {
		if (!validationModal) return;

		try {
			const result = await executeSync.mutateAsync({
				templateId: validationModal.templateId,
				instanceId: validationModal.instanceId,
				syncType: "MANUAL",
				conflictResolutions: resolutions,
			});

			setValidationModal(null);
			setProgressModal({
				syncId: result.syncId,
				templateName: validationModal.templateName,
				instanceName: validationModal.instanceName,
			});
		} catch (error) {
			console.error("Sync execution failed:", error);
			const errorMessage = error instanceof Error ? error.message : "Unknown error occurred";
			toast.error("Failed to start sync operation", { description: errorMessage });
		}
	};

	const handleSyncComplete = () => {
		setProgressModal(null);
	};

	const handleUnlinkInstance = () => {
		if (!unlinkConfirm) return;

		unlinkMutation.mutate(
			{
				templateId: unlinkConfirm.templateId,
				instanceId: unlinkConfirm.instanceId,
			},
			{
				onSuccess: () => {
					setUnlinkConfirm(null);
				},
			}
		);
	};

	// Loading State
	if (isLoading) {
		return (
			<div className="space-y-6 animate-in fade-in duration-500">
				<div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
					{Array.from({ length: 6 }).map((_, i) => (
						<div
							key={i}
							className="rounded-2xl border border-border/30 bg-card/20 p-6 space-y-4 animate-pulse"
							style={{ animationDelay: `${i * 100}ms` }}
						>
							<div className="h-6 w-24 rounded-lg bg-muted/20" />
							<div className="h-5 w-3/4 rounded bg-muted/15" />
							<div className="h-16 w-full rounded-xl bg-muted/10" />
							<div className="flex gap-2">
								<div className="h-10 flex-1 rounded-xl bg-muted/15" />
							</div>
						</div>
					))}
				</div>
			</div>
		);
	}

	// Error State
	if (error) {
		return (
			<div
				className="rounded-2xl border p-6 backdrop-blur-sm"
				style={{
					backgroundColor: SEMANTIC_COLORS.error.bg,
					borderColor: SEMANTIC_COLORS.error.border,
				}}
			>
				<div className="flex items-start gap-4">
					<div
						className="flex h-10 w-10 items-center justify-center rounded-xl shrink-0"
						style={{ backgroundColor: `${SEMANTIC_COLORS.error.from}20` }}
					>
						<AlertCircle className="h-5 w-5" style={{ color: SEMANTIC_COLORS.error.from }} />
					</div>
					<div>
						<h3 className="font-semibold text-foreground mb-1">Failed to load templates</h3>
						<p className="text-sm text-muted-foreground">
							{error instanceof Error ? error.message : "Please try again"}
						</p>
					</div>
				</div>
			</div>
		);
	}

	const templates = data?.templates || [];

	return (
		<div className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-500">
			{/* Header with Actions */}
			<div className="flex flex-wrap items-center justify-between gap-4">
				<h2 className="text-xl font-semibold text-foreground">
					Templates {serviceType ? `(${serviceType})` : ""}
				</h2>
				<div className="flex flex-wrap gap-2">
					{/* Primary Actions: TRaSH Guides Quality Profile Wizard */}
					<button
						type="button"
						onClick={() => onBrowseQualityProfiles("RADARR")}
						title="Import quality profile from TRaSH Guides for Radarr"
						className="inline-flex items-center gap-2 rounded-xl px-4 py-2.5 text-sm font-medium transition-all duration-200"
						style={{
							background: `linear-gradient(135deg, #f97316, #ea580c)`,
							boxShadow: "0 4px 12px -4px rgba(249, 115, 22, 0.5)",
						}}
					>
						<Star className="h-4 w-4" />
						Radarr Profiles
					</button>
					<button
						type="button"
						onClick={() => onBrowseQualityProfiles("SONARR")}
						title="Import quality profile from TRaSH Guides for Sonarr"
						className="inline-flex items-center gap-2 rounded-xl px-4 py-2.5 text-sm font-medium transition-all duration-200"
						style={{
							background: `linear-gradient(135deg, #06b6d4, #0891b2)`,
							boxShadow: "0 4px 12px -4px rgba(6, 182, 212, 0.5)",
						}}
					>
						<Star className="h-4 w-4" />
						Sonarr Profiles
					</button>

					{/* Secondary Actions */}
					<button
						type="button"
						onClick={() => setImportModal(true)}
						title="Import an existing template from JSON"
						className="inline-flex items-center gap-2 rounded-xl px-4 py-2.5 text-sm font-medium border border-border/50 bg-card/30 hover:bg-card/50 transition-all duration-200"
					>
						<Download className="h-4 w-4" />
						Import JSON
					</button>
					<button
						type="button"
						onClick={onCreateNew}
						title="Create a custom template manually"
						className="inline-flex items-center gap-2 rounded-xl px-4 py-2.5 text-sm font-medium border border-border/50 bg-card/30 hover:bg-card/50 transition-all duration-200"
					>
						<Plus className="h-4 w-4" />
						Custom Template
					</button>
				</div>
			</div>

			{/* Search and Sort Controls */}
			<div
				className="flex flex-col gap-4 rounded-2xl border border-border/50 bg-card/30 backdrop-blur-sm p-4 sm:flex-row sm:items-center sm:justify-between"
			>
				{/* Search Input */}
				<div className="flex-1 max-w-md">
					<div className="relative">
						<Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
						<input
							type="text"
							placeholder="Search templates..."
							value={searchInput}
							onChange={(e) => setSearchInput(e.target.value)}
							className="w-full rounded-xl border border-border/50 bg-card/50 px-4 py-2.5 text-sm text-foreground placeholder:text-muted-foreground focus:border-border focus:outline-none focus:ring-2 transition-all duration-200"
							style={{ focusRing: `${themeGradient.from}40`, paddingLeft: "2.5rem" } as React.CSSProperties}
						/>
					</div>
				</div>

				{/* Sort Controls */}
				<div className="flex items-center gap-2">
					<select
						value={sortBy}
						onChange={(e) => setSortBy(e.target.value as typeof sortBy)}
						className="rounded-xl border border-border/50 bg-card/50 px-3 py-2.5 text-sm text-foreground focus:border-border focus:outline-none focus:ring-2 transition-all duration-200"
					>
						<option value="updatedAt">Last Updated</option>
						<option value="createdAt">Date Created</option>
						<option value="name">Name</option>
						<option value="usageCount">Usage Count</option>
					</select>

					<button
						type="button"
						onClick={() => setSortOrder(sortOrder === "asc" ? "desc" : "asc")}
						aria-label={sortOrder === "asc" ? "Sort descending" : "Sort ascending"}
						title={sortOrder === "asc" ? "Sort ascending" : "Sort descending"}
						className="rounded-xl border border-border/50 bg-card/50 p-2.5 hover:bg-card/80 transition-all duration-200"
					>
						<ArrowUpDown className="h-4 w-4" />
					</button>
				</div>
			</div>

			{/* Empty State */}
			{templates.length === 0 ? (
				<PremiumEmptyState
					icon={FileText}
					title={debouncedSearch ? "No templates found" : "No templates yet"}
					description={
						debouncedSearch
							? `No templates match "${debouncedSearch}". Try a different search term.`
							: "Create your first template to get started with TRaSH Guides deployment"
					}
				/>
			) : (
				<>
					{/* Results Counter */}
					<div className="flex items-center justify-between">
						<p className="text-sm text-muted-foreground">
							Showing <span className="font-medium text-foreground">{templates.length}</span> template{templates.length !== 1 ? "s" : ""}
							{debouncedSearch && ` matching "${debouncedSearch}"`}
						</p>
					</div>

					{/* Template Grid */}
					<div className="grid gap-6 md:grid-cols-2 lg:grid-cols-3">
						{templates.map((template, index) => (
							<article
								key={template.id}
								className="group relative flex flex-col rounded-2xl border border-border/50 bg-card/30 backdrop-blur-sm p-6 transition-all duration-300 hover:border-border hover:bg-card/50 hover:shadow-lg animate-in fade-in slide-in-from-bottom-2"
								style={{
									animationDelay: `${index * 50}ms`,
									animationFillMode: "backwards",
								}}
							>
								{/* Delete Confirmation Overlay */}
								{deleteConfirm === template.id && (
									<div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-4 rounded-2xl bg-black/90 backdrop-blur-sm p-6">
										<p className="text-center text-sm text-foreground">
											Delete &quot;{template.name}&quot;?
										</p>
										<div className="flex gap-2">
											<button
												type="button"
												onClick={() => handleDelete(template.id)}
												disabled={deleteMutation.isPending}
												className="rounded-xl px-4 py-2 text-sm font-medium transition-all"
												style={{
													backgroundColor: SEMANTIC_COLORS.error.bg,
													border: `1px solid ${SEMANTIC_COLORS.error.border}`,
													color: SEMANTIC_COLORS.error.text,
												}}
											>
												{deleteMutation.isPending ? "Deleting..." : "Delete"}
											</button>
											<button
												type="button"
												onClick={() => setDeleteConfirm(null)}
												className="rounded-xl px-4 py-2 text-sm font-medium border border-border/50 bg-card/50 hover:bg-card/80 transition-all"
											>
												Cancel
											</button>
										</div>
									</div>
								)}

								{/* Duplicate Dialog Overlay */}
								{duplicatingId === template.id && (
									<div className="absolute inset-0 z-10 flex flex-col gap-4 rounded-2xl bg-black/90 backdrop-blur-sm p-6">
										<p className="text-sm text-foreground">Duplicate as:</p>
										<input
											type="text"
											value={duplicateName}
											onChange={(e) => setDuplicateName(e.target.value)}
											placeholder="New template name"
											className="rounded-xl border border-border/50 bg-card/50 px-4 py-2.5 text-sm text-foreground placeholder:text-muted-foreground focus:border-border focus:outline-none"
											autoFocus
										/>
										<div className="flex gap-2">
											<button
												type="button"
												onClick={() => handleDuplicate(template.id)}
												disabled={duplicateMutation.isPending || !duplicateName.trim()}
												className="rounded-xl px-4 py-2 text-sm font-medium transition-all disabled:opacity-50"
												style={{
													background: `linear-gradient(135deg, ${themeGradient.from}, ${themeGradient.to})`,
												}}
											>
												{duplicateMutation.isPending ? "Creating..." : "Create"}
											</button>
											<button
												type="button"
												onClick={() => {
													setDuplicatingId(null);
													setDuplicateName("");
												}}
												className="rounded-xl px-4 py-2 text-sm font-medium border border-border/50 bg-card/50 hover:bg-card/80 transition-all"
											>
												Cancel
											</button>
										</div>
									</div>
								)}

								{/* Template Card Content */}
								<div className="flex flex-1 flex-col">
									{/* Header */}
									<div className="space-y-3 mb-4">
										<div className="flex items-start justify-between">
											<div>
												<h3 className="font-semibold text-foreground">{template.name}</h3>
												<p
													className="mt-1 text-xs font-medium"
													style={{ color: getServiceGradient(template.serviceType).from }}
												>
													{template.serviceType}
												</p>
											</div>
											<span className="text-xs text-muted-foreground">
												{template.updatedAt ? new Date(template.updatedAt).toLocaleDateString() : ""}
											</span>
										</div>

										{template.description && (
											<p className="text-sm text-muted-foreground line-clamp-2">{template.description}</p>
										)}

										<div className="space-y-2">
											<div className="flex items-center gap-2 text-xs text-muted-foreground">
												<span>{template.config.customFormats.length} formats</span>
												<span className="text-border">•</span>
												<span>{template.config.customFormatGroups.length} groups</span>
											</div>
											{template.config.qualityProfile && (
												<div className="flex flex-wrap gap-1.5">
													{template.config.qualityProfile.language && (
														<span
															className="inline-flex items-center gap-1 rounded-lg px-2 py-0.5 text-xs font-medium"
															style={{
																backgroundColor: `${themeGradient.from}15`,
																border: `1px solid ${themeGradient.from}25`,
																color: themeGradient.from,
															}}
														>
															🌐 {template.config.qualityProfile.language}
														</span>
													)}
													{template.config.qualityProfile.trash_score_set && (
														<span className="inline-flex items-center gap-1 rounded-lg bg-purple-500/15 border border-purple-500/25 px-2 py-0.5 text-xs font-medium text-purple-400">
															📊 {template.config.qualityProfile.trash_score_set}
														</span>
													)}
													{template.config.qualityProfile.cutoff && (
														<span
															className="inline-flex items-center gap-1 rounded-lg px-2 py-0.5 text-xs font-medium"
															style={{
																backgroundColor: SEMANTIC_COLORS.success.bg,
																border: `1px solid ${SEMANTIC_COLORS.success.border}`,
																color: SEMANTIC_COLORS.success.text,
															}}
														>
															🎬 {template.config.qualityProfile.cutoff}
														</span>
													)}
												</div>
											)}
										</div>

										{/* Update Banner */}
										{(() => {
											const templateUpdate = updatesData?.data.templatesWithUpdates.find((u) => u.templateId === template.id);
											return templateUpdate ? (
												<TemplateUpdateBanner update={templateUpdate} />
											) : null;
										})()}
									</div>

									{/* Fixed Bottom Section */}
									<div className="mt-auto space-y-3 pt-3 border-t border-border/30">
										<TemplateStats
											templateId={template.id}
											templateName={template.name}
											onDeploy={(instanceId, instanceLabel) => {
												setDeploymentModal({
													templateId: template.id,
													templateName: template.name,
													instanceId,
													instanceLabel,
												});
											}}
											onUnlinkInstance={(instanceId, instanceName) => {
												setUnlinkConfirm({
													templateId: template.id,
													templateName: template.name,
													instanceId,
													instanceName,
												});
											}}
										/>

										{/* Deploy Button */}
										<button
											type="button"
											onClick={() => setInstanceSelectorTemplate({
												templateId: template.id,
												templateName: template.name,
												serviceType: template.serviceType
											})}
											className="w-full inline-flex items-center justify-center gap-2 rounded-xl px-4 py-2.5 text-sm font-medium transition-all duration-200"
											style={{
												background: `linear-gradient(135deg, ${themeGradient.from}, ${themeGradient.to})`,
												boxShadow: `0 4px 12px -4px ${themeGradient.glow}`,
											}}
										>
											<Rocket className="h-4 w-4" />
											Deploy to Instance
										</button>

										{/* Action Buttons */}
										<div className="flex gap-2">
											<button
												type="button"
												onClick={() => onEdit(template)}
												className="flex-1 rounded-xl p-2.5 border border-border/50 bg-card/30 hover:bg-card/50 transition-all"
												aria-label={`Edit template ${template.name}`}
												title="Edit template"
											>
												<Edit className="mx-auto h-4 w-4" />
											</button>
											<button
												type="button"
												onClick={() => {
													setDuplicatingId(template.id);
													setDuplicateName(`${template.name} Copy`);
												}}
												className="flex-1 rounded-xl p-2.5 border border-border/50 bg-card/30 hover:bg-card/50 transition-all"
												aria-label={`Duplicate template ${template.name}`}
												title="Duplicate template"
											>
												<Copy className="mx-auto h-4 w-4" />
											</button>
											<button
												type="button"
												onClick={() => setExportModal({ templateId: template.id, templateName: template.name })}
												className="flex-1 rounded-xl p-2.5 border border-border/50 bg-card/30 hover:bg-card/50 transition-all"
												aria-label={`Export template ${template.name}`}
												title="Export template"
											>
												<Download className="mx-auto h-4 w-4" />
											</button>
											<button
												type="button"
												onClick={() => setDeleteConfirm(template.id)}
												className="flex-1 rounded-xl p-2.5 transition-all"
												style={{
													backgroundColor: SEMANTIC_COLORS.error.bg,
													border: `1px solid ${SEMANTIC_COLORS.error.border}`,
													color: SEMANTIC_COLORS.error.text,
												}}
												aria-label={`Delete template ${template.name}`}
												title="Delete template"
											>
												<Trash2 className="mx-auto h-4 w-4" />
											</button>
										</div>
									</div>
								</div>
							</article>
						))}
					</div>
				</>
			)}

			{/* Sync Modals */}
			{validationModal && (
				<SyncValidationModal
					templateId={validationModal.templateId}
					templateName={validationModal.templateName}
					instanceId={validationModal.instanceId}
					instanceName={validationModal.instanceName}
					onConfirm={handleSyncValidationComplete}
					onCancel={() => setValidationModal(null)}
				/>
			)}

			{progressModal && (
				<SyncProgressModal
					syncId={progressModal.syncId}
					templateName={progressModal.templateName}
					instanceName={progressModal.instanceName}
					onComplete={handleSyncComplete}
					onClose={() => setProgressModal(null)}
				/>
			)}

			{deploymentModal && (
				<DeploymentPreviewModal
					open={true}
					onClose={() => setDeploymentModal(null)}
					templateId={deploymentModal.templateId}
					templateName={deploymentModal.templateName}
					instanceId={deploymentModal.instanceId}
					instanceLabel={deploymentModal.instanceLabel}
				/>
			)}

			{/* Instance Selector Modal */}
			{instanceSelectorTemplate && (
				<div
					className="fixed inset-0 bg-black/80 backdrop-blur-sm flex items-center justify-center z-modal p-4 animate-in fade-in duration-200"
					role="dialog"
					aria-modal="true"
					aria-labelledby="deploy-template-title"
				>
					<div
						className="rounded-2xl shadow-2xl border border-border/50 bg-card/95 backdrop-blur-xl max-w-2xl w-full max-h-[90vh] overflow-hidden flex flex-col animate-in zoom-in-95 duration-300"
					>
						{/* Header */}
						<div
							className="flex items-center justify-between p-6 border-b border-border/50"
							style={{
								background: `linear-gradient(135deg, ${themeGradient.from}10, transparent)`,
							}}
						>
							<div className="flex items-center gap-3">
								<div
									className="flex h-10 w-10 items-center justify-center rounded-xl"
									style={{
										background: `linear-gradient(135deg, ${themeGradient.from}20, ${themeGradient.to}20)`,
									}}
								>
									<Rocket className="h-5 w-5" style={{ color: themeGradient.from }} />
								</div>
								<div>
									<h2 id="deploy-template-title" className="text-lg font-semibold text-foreground">Deploy Template</h2>
									<p className="text-sm text-muted-foreground">{instanceSelectorTemplate.templateName}</p>
								</div>
							</div>
							<button
								type="button"
								onClick={() => setInstanceSelectorTemplate(null)}
								aria-label="Close modal"
								className="rounded-lg p-2 hover:bg-card/80 transition-colors"
							>
								<X className="h-5 w-5" />
							</button>
						</div>

						{/* Instance List */}
						<div className="flex-1 overflow-y-auto p-6">
							{/* Bulk Deploy Button */}
							{(() => {
								const matchingInstances = servicesData?.filter(instance =>
									instance.service.toUpperCase() === instanceSelectorTemplate.serviceType
								) || [];

								if (matchingInstances.length > 1) {
									// Find the full template to get quality config and instance overrides
									const fullTemplate = templates.find(t => t.id === instanceSelectorTemplate.templateId);

									return (
										<button
											type="button"
											onClick={() => {
												setBulkDeployModal({
													templateId: instanceSelectorTemplate.templateId,
													templateName: instanceSelectorTemplate.templateName,
													serviceType: instanceSelectorTemplate.serviceType,
													templateDefaultQualityConfig: getEffectiveQualityConfig(fullTemplate?.config),
													instanceOverrides: fullTemplate?.instanceOverrides,
													instances: matchingInstances.map(inst => ({
														instanceId: inst.id,
														instanceLabel: inst.label,
														instanceType: inst.service.toUpperCase(),
													})),
												});
												setInstanceSelectorTemplate(null);
											}}
											className="w-full flex items-center justify-center gap-2 rounded-xl px-4 py-3 mb-4 text-sm font-medium transition-all duration-200"
											style={{
												background: `linear-gradient(135deg, ${themeGradient.from}15, ${themeGradient.to}15)`,
												border: `1px solid ${themeGradient.from}30`,
												color: themeGradient.from,
											}}
										>
											<Layers className="h-5 w-5" />
											Deploy to Multiple Instances ({matchingInstances.length} available)
										</button>
									);
								}
								return null;
							})()}

							<h3 className="text-sm font-medium text-foreground mb-4">Select an instance:</h3>
							<div className="space-y-3">
								{servicesData && servicesData.length > 0 ? (
									servicesData
										.filter(instance =>
											instance.service.toUpperCase() === instanceSelectorTemplate.serviceType
										)
										.map((instance) => (
											<button
												key={instance.id}
												type="button"
												onClick={() => {
													setDeploymentModal({
														templateId: instanceSelectorTemplate.templateId,
														templateName: instanceSelectorTemplate.templateName,
														instanceId: instance.id,
														instanceLabel: instance.label,
													});
													setInstanceSelectorTemplate(null);
												}}
												className="w-full flex items-center justify-between p-4 rounded-xl border border-border/50 bg-card/30 hover:bg-card/50 hover:border-border transition-all text-left group"
											>
												<div>
													<div className="font-medium text-foreground group-hover:text-foreground transition-colors">
														{instance.label}
													</div>
													<div className="text-sm text-muted-foreground mt-1">
														{instance.service}
													</div>
												</div>
												<Rocket
													className="h-5 w-5 transition-transform group-hover:scale-110"
													style={{ color: themeGradient.from }}
												/>
											</button>
										))
								) : (
									<div className="text-center py-12 px-4 rounded-xl border border-dashed border-border/50">
										<AlertCircle className="h-12 w-12 mx-auto mb-4 text-muted-foreground" />
										<p className="text-foreground font-medium">No instances available.</p>
										<p className="text-sm text-muted-foreground mt-2">
											Add a Radarr or Sonarr instance in Settings first.
										</p>
									</div>
								)}
							</div>
						</div>

						{/* Footer */}
						<div className="flex items-center justify-end p-6 border-t border-border/50">
							<button
								type="button"
								onClick={() => setInstanceSelectorTemplate(null)}
								className="rounded-xl px-4 py-2.5 text-sm font-medium border border-border/50 bg-card/30 hover:bg-card/50 transition-all"
							>
								Cancel
							</button>
						</div>
					</div>
				</div>
			)}

			{/* Export Modal */}
			{exportModal && (
				<div
					className="fixed inset-0 bg-black/80 backdrop-blur-sm flex items-center justify-center z-modal p-4 animate-in fade-in duration-200"
					role="dialog"
					aria-modal="true"
					aria-label="Export Template"
				>
					<div className="rounded-2xl shadow-2xl border border-border/50 bg-card/95 backdrop-blur-xl max-w-2xl w-full max-h-[90vh] overflow-auto animate-in zoom-in-95 duration-300">
						<EnhancedTemplateExportModal
							templateId={exportModal.templateId}
							templateName={exportModal.templateName}
							onClose={() => setExportModal(null)}
						/>
					</div>
				</div>
			)}

			{/* Import Modal */}
			{importModal && (
				<div
					className="fixed inset-0 bg-black/80 backdrop-blur-sm flex items-center justify-center z-modal p-4 animate-in fade-in duration-200"
					role="dialog"
					aria-modal="true"
					aria-label="Import Template"
				>
					<div className="rounded-2xl shadow-2xl border border-border/50 bg-card/95 backdrop-blur-xl max-w-2xl w-full max-h-[90vh] overflow-auto animate-in zoom-in-95 duration-300">
						<EnhancedTemplateImportModal
							onImportComplete={() => {
								queryClient.invalidateQueries({ queryKey: TEMPLATES_QUERY_KEY });
								setImportModal(false);
							}}
							onClose={() => setImportModal(false)}
						/>
					</div>
				</div>
			)}

			{/* Unlink Confirmation Modal */}
			{unlinkConfirm && (
				<div
					className="fixed inset-0 bg-black/80 backdrop-blur-sm flex items-center justify-center z-modal p-4 animate-in fade-in duration-200"
					role="dialog"
					aria-modal="true"
					aria-labelledby="unlink-confirm-title"
				>
					<div className="rounded-2xl shadow-2xl border border-border/50 bg-card/95 backdrop-blur-xl max-w-md w-full p-6 animate-in zoom-in-95 duration-300">
						<div className="text-center space-y-4">
							<div
								className="flex items-center justify-center w-14 h-14 rounded-2xl mx-auto"
								style={{
									backgroundColor: SEMANTIC_COLORS.error.bg,
									border: `1px solid ${SEMANTIC_COLORS.error.border}`,
								}}
							>
								<AlertCircle className="h-7 w-7" style={{ color: SEMANTIC_COLORS.error.from }} />
							</div>
							<h3 id="unlink-confirm-title" className="text-lg font-semibold text-foreground">
								Remove from Instance?
							</h3>
							<p className="text-sm text-muted-foreground">
								Are you sure you want to unlink template &quot;{unlinkConfirm.templateName}&quot; from instance &quot;{unlinkConfirm.instanceName}&quot;?
							</p>
							<p className="text-xs text-muted-foreground">
								This will remove the deployment mapping. Custom Formats already on the instance will not be deleted.
							</p>
							<div className="flex gap-3 justify-center pt-2">
								<button
									type="button"
									onClick={() => setUnlinkConfirm(null)}
									disabled={unlinkMutation.isPending}
									className="rounded-xl px-4 py-2.5 text-sm font-medium border border-border/50 bg-card/30 hover:bg-card/50 transition-all disabled:opacity-50"
								>
									Cancel
								</button>
								<button
									type="button"
									onClick={handleUnlinkInstance}
									disabled={unlinkMutation.isPending}
									className="inline-flex items-center gap-2 rounded-xl px-4 py-2.5 text-sm font-medium transition-all disabled:opacity-50"
									style={{
										backgroundColor: SEMANTIC_COLORS.error.bg,
										border: `1px solid ${SEMANTIC_COLORS.error.border}`,
										color: SEMANTIC_COLORS.error.text,
									}}
								>
									{unlinkMutation.isPending ? (
										<>
											<Loader2 className="h-4 w-4 animate-spin" />
											Unlinking...
										</>
									) : (
										"Unlink"
									)}
								</button>
							</div>
						</div>
					</div>
				</div>
			)}

			{/* Bulk Deployment Modal */}
			{bulkDeployModal && (
				<BulkDeploymentModal
					open={!!bulkDeployModal}
					onClose={() => setBulkDeployModal(null)}
					templateId={bulkDeployModal.templateId}
					templateName={bulkDeployModal.templateName}
					serviceType={bulkDeployModal.serviceType}
					templateDefaultQualityConfig={bulkDeployModal.templateDefaultQualityConfig}
					instanceOverrides={bulkDeployModal.instanceOverrides}
					instances={bulkDeployModal.instances}
					onDeploySuccess={() => {
						setBulkDeployModal(null);
						queryClient.invalidateQueries({ queryKey: TEMPLATES_QUERY_KEY });
					}}
				/>
			)}
		</div>
	);
};
