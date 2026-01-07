"use client";

import { useState, useEffect } from "react";
import type { TrashTemplate } from "@arr/shared";
import {
	useTemplates,
	useDeleteTemplate,
	useDuplicateTemplate,
	TEMPLATES_QUERY_KEY,
} from "../../../hooks/api/useTemplates";
import { Alert, AlertTitle, AlertDescription, EmptyState, Skeleton, Button } from "../../../components/ui";
import { AlertCircle, Plus, Download, Copy, Trash2, Edit, FileText, RefreshCw, Star, Rocket, Layers, X } from "lucide-react";
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

export const TemplateList = ({ serviceType, onCreateNew, onEdit, onImport, onBrowseQualityProfiles }: TemplateListProps) => {
	// Search, filter, and sort state
	const [searchInput, setSearchInput] = useState("");
	const [debouncedSearch, setDebouncedSearch] = useState("");
	const [sortBy, setSortBy] = useState<"name" | "createdAt" | "updatedAt" | "usageCount">("updatedAt");
	const [sortOrder, setSortOrder] = useState<"asc" | "desc">("desc");

	// Debounce search input to avoid excessive API calls and prevent focus loss
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

			// Close validation modal and open progress modal
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
		// Optionally refetch templates or show success message
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

	if (isLoading) {
		return (
			<div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
				<Skeleton className="h-48" />
				<Skeleton className="h-48" />
				<Skeleton className="h-48" />
			</div>
		);
	}

	if (error) {
		return (
			<Alert variant="danger">
				<AlertTitle>Failed to load templates</AlertTitle>
				<AlertDescription>
					{error instanceof Error ? error.message : "Please try again"}
				</AlertDescription>
			</Alert>
		);
	}

	const templates = data?.templates || [];

	return (
		<div className="space-y-4">
			{/* Header with Title and Actions */}
			<div className="flex items-center justify-between">
				<h2 className="text-xl font-semibold text-fg">
					Templates {serviceType ? `(${serviceType})` : ""}
				</h2>
				<div className="flex gap-2">
					{/* Primary Actions: TRaSH Guides Quality Profile Wizard */}
					<Button
						variant="primary"
						onClick={() => onBrowseQualityProfiles("RADARR")}
						title="Import quality profile from TRaSH Guides for Radarr using the wizard"
						className="gap-2"
					>
						<Star className="h-4 w-4" />
						Radarr Profiles
					</Button>
					<Button
						variant="primary"
						onClick={() => onBrowseQualityProfiles("SONARR")}
						title="Import quality profile from TRaSH Guides for Sonarr using the wizard"
						className="gap-2"
					>
						<Star className="h-4 w-4" />
						Sonarr Profiles
					</Button>

					{/* Secondary Actions: Manual/Import */}
					<Button
						variant="secondary"
						onClick={() => setImportModal(true)}
						title="Import an existing template from JSON file with validation"
						className="gap-2"
					>
						<Download className="h-4 w-4" />
						Import JSON
					</Button>
					<Button
						variant="secondary"
						onClick={onCreateNew}
						title="Create a custom template manually (advanced)"
						className="gap-2"
					>
						<Plus className="h-4 w-4" />
						Custom Template
					</Button>
				</div>
			</div>

			{/* Search, Filter, and Sort Controls */}
			<div className="flex flex-col gap-3 rounded-lg border border-border bg-bg-subtle/50 p-4 sm:flex-row sm:items-center sm:justify-between">
				{/* Search Input */}
				<div className="flex-1 max-w-md">
					<div className="relative">
						<input
							type="text"
							placeholder="Search templates by name or description..."
							value={searchInput}
							onChange={(e) => setSearchInput(e.target.value)}
							className="w-full rounded-lg border border-border bg-bg-subtle px-4 py-2 pl-10 text-sm text-fg placeholder:text-fg-muted focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
						/>
						<svg
							className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-fg-muted"
							fill="none"
							stroke="currentColor"
							viewBox="0 0 24 24"
						>
							<path
								strokeLinecap="round"
								strokeLinejoin="round"
								strokeWidth={2}
								d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
							/>
						</svg>
					</div>
				</div>

				{/* Sort and Filter Controls */}
				<div className="flex items-center gap-2">
					{/* Sort By Dropdown */}
					<select
						value={sortBy}
						onChange={(e) => setSortBy(e.target.value as typeof sortBy)}
						className="rounded-lg border border-border bg-bg-subtle px-3 py-2 text-sm text-fg focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
					>
						<option value="updatedAt">Last Updated</option>
						<option value="createdAt">Date Created</option>
						<option value="name">Name</option>
						<option value="usageCount">Usage Count</option>
					</select>

					{/* Sort Order Toggle */}
					<Button
						variant="secondary"
						size="sm"
						onClick={() => setSortOrder(sortOrder === "asc" ? "desc" : "asc")}
						title={sortOrder === "asc" ? "Sort ascending" : "Sort descending"}
					>
						{sortOrder === "asc" ? "↑" : "↓"}
					</Button>
				</div>
			</div>

			{templates.length === 0 ? (
				<EmptyState
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
					<div className="flex items-center justify-between text-sm text-fg-muted">
						<span>
							Showing {templates.length} template{templates.length !== 1 ? "s" : ""}
							{debouncedSearch && ` matching "${debouncedSearch}"`}
						</span>
					</div>

					<div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
					{templates.map((template) => (
						<article
							key={template.id}
							className="group relative flex flex-col rounded-xl border border-border bg-bg-subtle/50 p-6 transition hover:border-border/80 hover:bg-bg-hover"
						>
							{/* Delete Confirmation Overlay */}
							{deleteConfirm === template.id && (
								<div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 rounded-xl bg-black/80 p-6">
									<p className="text-center text-sm text-fg">
										Delete &quot;{template.name}&quot;?
									</p>
									<div className="flex gap-2">
										<Button
											variant="danger"
											size="sm"
											onClick={() => handleDelete(template.id)}
											disabled={deleteMutation.isPending}
										>
											{deleteMutation.isPending ? "Deleting..." : "Delete"}
										</Button>
										<Button
											variant="secondary"
											size="sm"
											onClick={() => setDeleteConfirm(null)}
										>
											Cancel
										</Button>
									</div>
								</div>
							)}

							{/* Duplicate Dialog Overlay */}
							{duplicatingId === template.id && (
								<div className="absolute inset-0 z-10 flex flex-col gap-3 rounded-xl bg-black/90 p-6">
									<p className="text-sm text-fg">Duplicate as:</p>
									<input
										type="text"
										value={duplicateName}
										onChange={(e) => setDuplicateName(e.target.value)}
										placeholder="New template name"
										className="rounded border border-border bg-bg-subtle px-3 py-2 text-sm text-fg placeholder:text-fg-muted focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
										autoFocus
									/>
									<div className="flex gap-2">
										<Button
											variant="primary"
											size="sm"
											onClick={() => handleDuplicate(template.id)}
											disabled={duplicateMutation.isPending || !duplicateName.trim()}
										>
											{duplicateMutation.isPending ? "Creating..." : "Create"}
										</Button>
										<Button
											variant="secondary"
											size="sm"
											onClick={() => {
												setDuplicatingId(null);
												setDuplicateName("");
											}}
										>
											Cancel
										</Button>
									</div>
								</div>
							)}

							{/* Template Card Content */}
							<div className="flex flex-1 flex-col">
								{/* Variable height content section */}
								<div className="space-y-3">
									<div className="flex items-start justify-between">
										<div>
											<h3 className="font-medium text-fg">{template.name}</h3>
											<p className="mt-1 text-xs text-fg-muted">{template.serviceType}</p>
										</div>
										<span className="text-xs text-fg-muted">
											v{template.updatedAt ? new Date(template.updatedAt).toLocaleDateString() : ""}
										</span>
									</div>

									{template.description && (
										<p className="text-sm text-fg-muted line-clamp-2">{template.description}</p>
									)}

									<div className="space-y-2">
										<div className="flex items-center gap-2 text-xs text-fg-muted">
											<span>{template.config.customFormats.length} formats</span>
											<span>•</span>
											<span>{template.config.customFormatGroups.length} groups</span>
										</div>
										{template.config.qualityProfile && (
											<div className="flex flex-wrap gap-1.5">
												{template.config.qualityProfile.language && (
													<span className="inline-flex items-center gap-1 rounded bg-blue-500/20 px-1.5 py-0.5 text-xs font-medium text-blue-300">
														🌐 {template.config.qualityProfile.language}
													</span>
												)}
												{template.config.qualityProfile.trash_score_set && (
													<span className="inline-flex items-center gap-1 rounded bg-purple-500/20 px-1.5 py-0.5 text-xs font-medium text-purple-300">
														📊 {template.config.qualityProfile.trash_score_set}
													</span>
												)}
												{template.config.qualityProfile.cutoff && (
													<span className="inline-flex items-center gap-1 rounded bg-green-500/20 px-1.5 py-0.5 text-xs font-medium text-green-300">
														🎬 {template.config.qualityProfile.cutoff}
													</span>
												)}
											</div>
										)}
									</div>

									{/* Update Notification Banner */}
									{(() => {
										const templateUpdate = updatesData?.data.templatesWithUpdates.find((u) => u.templateId === template.id);
										return templateUpdate ? (
											<TemplateUpdateBanner
												update={templateUpdate}
											/>
										) : null;
									})()}
								</div>

								{/* Fixed bottom section - always aligned across cards */}
								<div className="mt-auto space-y-3 pt-3">
									{/* Template Stats */}
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

									{/* Primary Deploy Button */}
									<Button
										variant="primary"
										onClick={() => setInstanceSelectorTemplate({
											templateId: template.id,
											templateName: template.name,
											serviceType: template.serviceType
										})}
										className="w-full gap-2"
										title="Deploy this template to an instance"
									>
										<Rocket className="h-4 w-4" />
										Deploy to Instance
									</Button>

									{/* Action Buttons */}
									<div className="flex gap-2">
										<Button
											variant="secondary"
											size="sm"
											onClick={() => onEdit(template)}
											className="flex-1"
											title="Edit template"
										>
											<Edit className="mx-auto h-4 w-4" />
										</Button>
										<Button
											variant="secondary"
											size="sm"
											onClick={() => {
												setDuplicatingId(template.id);
												setDuplicateName(`${template.name} Copy`);
											}}
											className="flex-1"
											title="Duplicate template"
										>
											<Copy className="mx-auto h-4 w-4" />
										</Button>
										<Button
											variant="secondary"
											size="sm"
											onClick={() => setExportModal({ templateId: template.id, templateName: template.name })}
											className="flex-1"
											title="Export template with metadata"
										>
											<Download className="mx-auto h-4 w-4" />
										</Button>
										<Button
											variant="danger"
											size="sm"
											onClick={() => setDeleteConfirm(template.id)}
											className="flex-1"
											title="Delete template"
										>
											<Trash2 className="mx-auto h-4 w-4" />
										</Button>
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
				<div className="fixed inset-0 bg-black/80 backdrop-blur-sm flex items-center justify-center z-50 p-4">
					<div className="bg-bg-subtle rounded-xl shadow-2xl border border-border max-w-2xl w-full max-h-[90vh] overflow-hidden flex flex-col">
						{/* Header */}
						<div className="flex items-center justify-between p-6 border-b border-border bg-gradient-to-r from-primary/10 to-transparent">
							<div>
								<h2 className="text-xl font-semibold text-fg flex items-center gap-2">
									<Rocket className="h-5 w-5 text-primary" />
									Deploy Template
								</h2>
								<p className="text-sm text-fg-muted mt-1">
									{instanceSelectorTemplate.templateName}
								</p>
							</div>
							<Button
								variant="ghost"
								size="sm"
								onClick={() => setInstanceSelectorTemplate(null)}
								aria-label="Close"
							>
								<X className="h-5 w-5" />
							</Button>
						</div>

						{/* Instance List */}
						<div className="flex-1 overflow-y-auto p-6 bg-bg-subtle/50">
							{/* Deploy to Multiple Button */}
							{(() => {
								const matchingInstances = servicesData?.filter(instance =>
									instance.service.toUpperCase() === instanceSelectorTemplate.serviceType
								) || [];

								if (matchingInstances.length > 1) {
									// Find the full template to get quality config and instance overrides
									const fullTemplate = templates.find(t => t.id === instanceSelectorTemplate.templateId);

									return (
										<Button
											variant="secondary"
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
											className="w-full justify-center gap-2 mb-4 border-primary/30 bg-primary/10 hover:bg-primary/20 hover:border-primary/50 text-primary"
										>
											<Layers className="h-5 w-5" />
											Deploy to Multiple Instances ({matchingInstances.length} available)
										</Button>
									);
								}
								return null;
							})()}

							<h3 className="text-sm font-medium text-fg mb-4">Select an instance to deploy to:</h3>
							<div className="space-y-3">
								{servicesData && servicesData.length > 0 ? (
									servicesData
										.filter(instance =>
											// Only show instances matching the template's service type
											// Compare uppercase versions since API returns lowercase "radarr"/"sonarr"
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
												className="w-full flex items-center justify-between p-4 rounded-lg border border-border bg-bg-subtle/50 hover:bg-primary/20 hover:border-primary/50 transition-all text-left group shadow-lg hover:shadow-primary/20"
											>
												<div>
													<div className="font-medium text-fg group-hover:text-primary transition-colors">
														{instance.label}
													</div>
													<div className="text-sm text-fg-muted mt-1">
														{instance.service}
													</div>
												</div>
												<Rocket className="h-5 w-5 text-primary group-hover:scale-110 transition-transform" />
											</button>
										))
								) : (
									<div className="text-center py-12 px-4 rounded-lg border border-dashed border-border bg-bg-subtle/50">
										<AlertCircle className="h-12 w-12 text-fg-muted mx-auto mb-4" />
										<p className="text-fg-muted font-medium">No instances available.</p>
										<p className="text-sm text-fg-muted mt-2">
											Add a Radarr or Sonarr instance in Settings first.
										</p>
									</div>
								)}
							</div>
						</div>

						{/* Footer */}
						<div className="flex items-center justify-end gap-3 p-6 border-t border-border bg-bg-subtle/80">
							<Button variant="secondary" onClick={() => setInstanceSelectorTemplate(null)}>
								Cancel
							</Button>
						</div>
					</div>
				</div>
			)}

			{/* Enhanced Export Modal */}
			{exportModal && (
				<div className="fixed inset-0 bg-black/80 backdrop-blur-sm flex items-center justify-center z-50 p-4">
					<div className="bg-bg-subtle rounded-xl shadow-2xl border border-border max-w-2xl w-full max-h-[90vh] overflow-auto">
						<EnhancedTemplateExportModal
							templateId={exportModal.templateId}
							templateName={exportModal.templateName}
							onClose={() => setExportModal(null)}
						/>
					</div>
				</div>
			)}

			{/* Enhanced Import Modal */}
			{importModal && (
				<div className="fixed inset-0 bg-black/80 backdrop-blur-sm flex items-center justify-center z-50 p-4">
					<div className="bg-bg-subtle rounded-xl shadow-2xl border border-border max-w-2xl w-full max-h-[90vh] overflow-auto">
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
				<div className="fixed inset-0 bg-black/80 backdrop-blur-sm flex items-center justify-center z-50 p-4">
					<div className="bg-bg-subtle rounded-xl shadow-2xl border border-border max-w-md w-full p-6">
						<div className="text-center space-y-4">
							<div className="flex items-center justify-center w-12 h-12 rounded-full bg-danger/20 mx-auto">
								<AlertCircle className="h-6 w-6 text-danger" />
							</div>
							<h3 className="text-lg font-semibold text-fg">
								Remove from Instance?
							</h3>
							<p className="text-sm text-fg-muted">
								Are you sure you want to unlink template &quot;{unlinkConfirm.templateName}&quot; from instance &quot;{unlinkConfirm.instanceName}&quot;?
							</p>
							<p className="text-xs text-fg-muted">
								This will remove the deployment mapping. Custom Formats already on the instance will not be deleted.
							</p>
							<div className="flex gap-3 justify-center pt-2">
								<Button
									variant="secondary"
									onClick={() => setUnlinkConfirm(null)}
									disabled={unlinkMutation.isPending}
								>
									Cancel
								</Button>
								<Button
									variant="danger"
									onClick={handleUnlinkInstance}
									disabled={unlinkMutation.isPending}
									className="gap-2"
								>
									{unlinkMutation.isPending ? (
										<>
											<RefreshCw className="h-4 w-4 animate-spin" />
											Unlinking...
										</>
									) : (
										"Unlink"
									)}
								</Button>
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
