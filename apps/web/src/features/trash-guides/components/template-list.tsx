"use client";

import { useState, useEffect, lazy, Suspense } from "react";
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
	FileText,
	Star,
	Search,
	ArrowUpDown,
	Loader2,
} from "lucide-react";
import { SEMANTIC_COLORS } from "../../../lib/theme-gradients";
import { useThemeGradient } from "../../../hooks/useThemeGradient";
import { useUnlinkTemplateFromInstance } from "../../../hooks/api/useDeploymentPreview";
import { useExecuteSync } from "../../../hooks/api/useSync";
import { useTemplateUpdates } from "../../../hooks/api/useTemplateUpdates";
import { useServicesQuery } from "../../../hooks/api/useServicesQuery";
import { TemplateCardContent } from "./template-card-content";
import { TemplateInstanceSelector } from "./template-instance-selector";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { useTemplateListModals } from "../hooks/use-template-list-modals";

// Lazy-loaded modals — only fetched when the user opens them
const SyncValidationModal = lazy(() => import("./sync-validation-modal").then(m => ({ default: m.SyncValidationModal })));
const SyncProgressModal = lazy(() => import("./sync-progress-modal").then(m => ({ default: m.SyncProgressModal })));
const DeploymentPreviewModal = lazy(() => import("./deployment-preview-modal").then(m => ({ default: m.DeploymentPreviewModal })));
const BulkDeploymentModal = lazy(() => import("./bulk-deployment-modal").then(m => ({ default: m.BulkDeploymentModal })));
const EnhancedTemplateExportModal = lazy(() => import("./enhanced-template-export-modal").then(m => ({ default: m.EnhancedTemplateExportModal })));
const EnhancedTemplateImportModal = lazy(() => import("./enhanced-template-import-modal").then(m => ({ default: m.EnhancedTemplateImportModal })));
import { getEffectiveQualityConfig } from "../lib/quality-config-utils";
import { getErrorMessage } from "../../../lib/error-utils";

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
export const TemplateList = ({ serviceType, onCreateNew, onEdit, onImport: _onImport, onBrowseQualityProfiles }: TemplateListProps) => {
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

	// Modal states (consolidated via useReducer)
	const [modals, dispatch] = useTemplateListModals();

	const handleDelete = async (templateId: string) => {
		try {
			await deleteMutation.mutateAsync(templateId);
			dispatch({ type: "CLOSE_DELETE" });
		} catch (error) {
			console.error("Delete failed:", error);
			const errorMessage = getErrorMessage(error, "Unknown error occurred");
			toast.error("Failed to delete template", { description: errorMessage });
		}
	};

	const handleDuplicate = async (templateId: string) => {
		if (!modals.duplicateName.trim()) {
			toast.error("Please enter a name for the duplicate");
			return;
		}

		try {
			await duplicateMutation.mutateAsync({
				templateId,
				newName: modals.duplicateName,
			});
			dispatch({ type: "CLOSE_DUPLICATE" });
		} catch (error) {
			console.error("Duplicate failed:", error);
			const errorMessage = getErrorMessage(error, "Unknown error occurred");
			toast.error("Failed to duplicate template", { description: errorMessage });
		}
	};

	const handleSyncValidationComplete = async (resolutions: Record<string, "REPLACE" | "SKIP">) => {
		if (!modals.validationModal) return;

		try {
			const result = await executeSync.mutateAsync({
				templateId: modals.validationModal.templateId,
				instanceId: modals.validationModal.instanceId,
				syncType: "MANUAL",
				conflictResolutions: resolutions,
			});

			dispatch({
				type: "VALIDATION_TO_PROGRESS",
				data: {
					syncId: result.syncId,
					templateName: modals.validationModal.templateName,
					instanceName: modals.validationModal.instanceName,
				},
			});
		} catch (error) {
			console.error("Sync execution failed:", error);
			const errorMessage = getErrorMessage(error, "Unknown error occurred");
			toast.error("Failed to start sync operation", { description: errorMessage });
		}
	};

	const handleSyncComplete = () => {
		dispatch({ type: "CLOSE_PROGRESS" });
	};

	const handleUnlinkInstance = () => {
		if (!modals.unlinkConfirm) return;

		unlinkMutation.mutate(
			{
				templateId: modals.unlinkConfirm.templateId,
				instanceId: modals.unlinkConfirm.instanceId,
			},
			{
				onSuccess: () => {
					dispatch({ type: "CLOSE_UNLINK" });
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
				className="rounded-2xl border p-6 backdrop-blur-xs"
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
							{getErrorMessage(error, "Please try again")}
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
						onClick={() => dispatch({ type: "OPEN_IMPORT" })}
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
				className="flex flex-col gap-4 rounded-2xl border border-border/50 bg-card/30 backdrop-blur-xs p-4 sm:flex-row sm:items-center sm:justify-between"
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
							className="w-full rounded-xl border border-border/50 bg-card/50 px-4 py-2.5 text-sm text-foreground placeholder:text-muted-foreground focus:border-border focus:outline-hidden focus:ring-2 transition-all duration-200"
							style={{ focusRing: `${themeGradient.from}40`, paddingLeft: "2.5rem" } as React.CSSProperties}
						/>
					</div>
				</div>

				{/* Sort Controls */}
				<div className="flex items-center gap-2">
					<select
						value={sortBy}
						onChange={(e) => setSortBy(e.target.value as typeof sortBy)}
						className="rounded-xl border border-border/50 bg-card/50 px-3 py-2.5 text-sm text-foreground focus:border-border focus:outline-hidden focus:ring-2 transition-all duration-200"
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
								className="group relative flex flex-col overflow-hidden rounded-2xl border border-border/50 bg-card/30 backdrop-blur-xs p-6 transition-all duration-300 hover:border-border hover:bg-card/50 hover:shadow-lg animate-in fade-in slide-in-from-bottom-2"
								style={{
									animationDelay: `${index * 50}ms`,
									animationFillMode: "backwards",
								}}
							>
								{/* Delete Confirmation Overlay */}
								{modals.deleteConfirm === template.id && (
									<div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-4 rounded-2xl bg-black/90 backdrop-blur-xs p-6">
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
												onClick={() => dispatch({ type: "CLOSE_DELETE" })}
												className="rounded-xl px-4 py-2 text-sm font-medium border border-border/50 bg-card/50 hover:bg-card/80 transition-all"
											>
												Cancel
											</button>
										</div>
									</div>
								)}

								{/* Duplicate Dialog Overlay */}
								{modals.duplicatingId === template.id && (
									<div className="absolute inset-0 z-10 flex flex-col gap-4 rounded-2xl bg-black/90 backdrop-blur-xs p-6">
										<p className="text-sm text-foreground">Duplicate as:</p>
										<input
											type="text"
											value={modals.duplicateName}
											onChange={(e) => dispatch({ type: "SET_DUPLICATE_NAME", name: e.target.value })}
											placeholder="New template name"
											className="rounded-xl border border-border/50 bg-card/50 px-4 py-2.5 text-sm text-foreground placeholder:text-muted-foreground focus:border-border focus:outline-hidden"
											autoFocus
										/>
										<div className="flex gap-2">
											<button
												type="button"
												onClick={() => handleDuplicate(template.id)}
												disabled={duplicateMutation.isPending || !modals.duplicateName.trim()}
												className="rounded-xl px-4 py-2 text-sm font-medium transition-all disabled:opacity-50"
												style={{
													background: `linear-gradient(135deg, ${themeGradient.from}, ${themeGradient.to})`,
												}}
											>
												{duplicateMutation.isPending ? "Creating..." : "Create"}
											</button>
											<button
												type="button"
												onClick={() => dispatch({ type: "CLOSE_DUPLICATE" })}
												className="rounded-xl px-4 py-2 text-sm font-medium border border-border/50 bg-card/50 hover:bg-card/80 transition-all"
											>
												Cancel
											</button>
										</div>
									</div>
								)}

								{/* Template Card Content */}
								<TemplateCardContent
									template={template}
									themeGradient={themeGradient}
									templateUpdate={updatesData?.data.templatesWithUpdates.find((u) => u.templateId === template.id)}
									onEdit={() => onEdit(template)}
									onDeploy={(instanceId, instanceLabel) => {
										dispatch({
											type: "OPEN_DEPLOYMENT",
											data: {
												templateId: template.id,
												templateName: template.name,
												instanceId,
												instanceLabel,
											},
										});
									}}
									onUnlinkInstance={(instanceId, instanceName) => {
										dispatch({
											type: "OPEN_UNLINK",
											data: {
												templateId: template.id,
												templateName: template.name,
												instanceId,
												instanceName,
											},
										});
									}}
									onOpenInstanceSelector={() => dispatch({
										type: "OPEN_INSTANCE_SELECTOR",
										data: {
											templateId: template.id,
											templateName: template.name,
											serviceType: template.serviceType,
										},
									})}
									onOpenDuplicate={() => dispatch({ type: "OPEN_DUPLICATE", templateId: template.id, defaultName: `${template.name} Copy` })}
									onOpenExport={() => dispatch({ type: "OPEN_EXPORT", data: { templateId: template.id, templateName: template.name } })}
									onOpenDelete={() => dispatch({ type: "OPEN_DELETE", templateId: template.id })}
								/>
							</article>
						))}
					</div>
				</>
			)}

			{/* Sync Modals (lazy-loaded) */}
			{modals.validationModal && (
				<Suspense>
					<SyncValidationModal
						templateId={modals.validationModal.templateId}
						templateName={modals.validationModal.templateName}
						instanceId={modals.validationModal.instanceId}
						instanceName={modals.validationModal.instanceName}
						onConfirm={handleSyncValidationComplete}
						onCancel={() => dispatch({ type: "CLOSE_VALIDATION" })}
					/>
				</Suspense>
			)}

			{modals.progressModal && (
				<Suspense>
					<SyncProgressModal
						syncId={modals.progressModal.syncId}
						templateName={modals.progressModal.templateName}
						instanceName={modals.progressModal.instanceName}
						onComplete={handleSyncComplete}
						onClose={() => dispatch({ type: "CLOSE_PROGRESS" })}
					/>
				</Suspense>
			)}

			{modals.deploymentModal && (
				<Suspense>
					<DeploymentPreviewModal
						open={true}
						onClose={() => dispatch({ type: "CLOSE_DEPLOYMENT" })}
						templateId={modals.deploymentModal.templateId}
						templateName={modals.deploymentModal.templateName}
						instanceId={modals.deploymentModal.instanceId}
						instanceLabel={modals.deploymentModal.instanceLabel}
					/>
				</Suspense>
			)}

			{/* Instance Selector Modal */}
			{modals.instanceSelectorTemplate && (
				<TemplateInstanceSelector
					templateName={modals.instanceSelectorTemplate.templateName}
					matchingInstances={(servicesData || [])
						.filter(inst => inst.service.toUpperCase() === modals.instanceSelectorTemplate!.serviceType)
						.map(inst => ({ id: inst.id, label: inst.label, service: inst.service }))}
					themeGradient={themeGradient}
					onSelectInstance={(instanceId, instanceLabel) => {
						dispatch({
							type: "INSTANCE_TO_DEPLOY",
							data: {
								templateId: modals.instanceSelectorTemplate!.templateId,
								templateName: modals.instanceSelectorTemplate!.templateName,
								instanceId,
								instanceLabel,
							},
						});
					}}
					onBulkDeploy={() => {
						const fullTemplate = templates.find(t => t.id === modals.instanceSelectorTemplate!.templateId);
						const instances = (servicesData || [])
							.filter(inst => inst.service.toUpperCase() === modals.instanceSelectorTemplate!.serviceType);
						dispatch({
							type: "INSTANCE_TO_BULK",
							data: {
								templateId: modals.instanceSelectorTemplate!.templateId,
								templateName: modals.instanceSelectorTemplate!.templateName,
								serviceType: modals.instanceSelectorTemplate!.serviceType,
								templateDefaultQualityConfig: getEffectiveQualityConfig(fullTemplate?.config),
								instanceOverrides: fullTemplate?.instanceOverrides,
								instances: instances.map(inst => ({
									instanceId: inst.id,
									instanceLabel: inst.label,
									instanceType: inst.service.toUpperCase(),
								})),
							},
						});
					}}
					onClose={() => dispatch({ type: "CLOSE_INSTANCE_SELECTOR" })}
				/>
			)}

			{/* Export Modal (lazy-loaded) */}
			{modals.exportModal && (
				<div
					className="fixed inset-0 bg-black/80 backdrop-blur-xs flex items-center justify-center z-modal p-4 animate-in fade-in duration-200"
					role="dialog"
					aria-modal="true"
					aria-label="Export Template"
				>
					<div className="rounded-2xl shadow-2xl border border-border/50 bg-card/95 backdrop-blur-xl max-w-2xl w-full max-h-[90vh] overflow-auto animate-in zoom-in-95 duration-300">
						<Suspense>
							<EnhancedTemplateExportModal
								templateId={modals.exportModal.templateId}
								templateName={modals.exportModal.templateName}
								onClose={() => dispatch({ type: "CLOSE_EXPORT" })}
							/>
						</Suspense>
					</div>
				</div>
			)}

			{/* Import Modal (lazy-loaded) */}
			{modals.importModal && (
				<div
					className="fixed inset-0 bg-black/80 backdrop-blur-xs flex items-center justify-center z-modal p-4 animate-in fade-in duration-200"
					role="dialog"
					aria-modal="true"
					aria-label="Import Template"
				>
					<div className="rounded-2xl shadow-2xl border border-border/50 bg-card/95 backdrop-blur-xl max-w-2xl w-full max-h-[90vh] overflow-auto animate-in zoom-in-95 duration-300">
						<Suspense>
							<EnhancedTemplateImportModal
								onImportComplete={() => {
									queryClient.invalidateQueries({ queryKey: TEMPLATES_QUERY_KEY });
									dispatch({ type: "CLOSE_IMPORT" });
								}}
								onClose={() => dispatch({ type: "CLOSE_IMPORT" })}
							/>
						</Suspense>
					</div>
				</div>
			)}

			{/* Unlink Confirmation Modal */}
			{modals.unlinkConfirm && (
				<div
					className="fixed inset-0 bg-black/80 backdrop-blur-xs flex items-center justify-center z-modal p-4 animate-in fade-in duration-200"
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
								Are you sure you want to unlink template &quot;{modals.unlinkConfirm.templateName}&quot; from instance &quot;{modals.unlinkConfirm.instanceName}&quot;?
							</p>
							<p className="text-xs text-muted-foreground">
								This will remove the deployment mapping. Custom Formats already on the instance will not be deleted.
							</p>
							<div className="flex gap-3 justify-center pt-2">
								<button
									type="button"
									onClick={() => dispatch({ type: "CLOSE_UNLINK" })}
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

			{/* Bulk Deployment Modal (lazy-loaded) */}
			{modals.bulkDeployModal && (
				<Suspense>
					<BulkDeploymentModal
						open={!!modals.bulkDeployModal}
						onClose={() => dispatch({ type: "CLOSE_BULK_DEPLOY" })}
						templateId={modals.bulkDeployModal.templateId}
						templateName={modals.bulkDeployModal.templateName}
						serviceType={modals.bulkDeployModal.serviceType}
						templateDefaultQualityConfig={modals.bulkDeployModal.templateDefaultQualityConfig}
						instanceOverrides={modals.bulkDeployModal.instanceOverrides}
						instances={modals.bulkDeployModal.instances}
						onDeploySuccess={() => {
							dispatch({ type: "CLOSE_BULK_DEPLOY" });
							queryClient.invalidateQueries({ queryKey: TEMPLATES_QUERY_KEY });
						}}
					/>
				</Suspense>
			)}
		</div>
	);
};
