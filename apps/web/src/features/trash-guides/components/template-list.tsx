"use client";

import { useState, useEffect } from "react";
import type { TrashTemplate } from "@arr/shared";
import {
	useTemplates,
	useDeleteTemplate,
	useDuplicateTemplate,
} from "../../../hooks/api/useTemplates";
import { Alert, AlertTitle, AlertDescription, EmptyState, Skeleton } from "../../../components/ui";
import { AlertCircle, Plus, Download, Copy, Trash2, Edit, FileText, RefreshCw, Star, Rocket, Layers } from "lucide-react";
import { exportTemplate } from "../../../lib/api-client/templates";
import { unlinkTemplateFromInstance } from "../../../lib/api-client/trash-guides";
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
import { EnhancedTemplateExportModal } from "./enhanced-template-export-modal";
import { EnhancedTemplateImportModal } from "./enhanced-template-import-modal";

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
	const [unlinking, setUnlinking] = useState(false);
	const [bulkDeployModal, setBulkDeployModal] = useState<{
		templateId: string;
		templateName: string;
		instances: Array<{ instanceId: string; instanceLabel: string; instanceType: string }>;
	} | null>(null);

	const handleDelete = async (templateId: string) => {
		try {
			await deleteMutation.mutateAsync(templateId);
			setDeleteConfirm(null);
		} catch (error) {
			console.error("Delete failed:", error);
			alert("Failed to delete template");
		}
	};

	const handleDuplicate = async (templateId: string) => {
		if (!duplicateName.trim()) {
			alert("Please enter a name for the duplicate");
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
			alert("Failed to duplicate template");
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
			alert("Failed to start sync operation");
		}
	};

	const handleSyncComplete = () => {
		setProgressModal(null);
		// Optionally refetch templates or show success message
	};

	const handleUnlinkInstance = async () => {
		if (!unlinkConfirm) return;

		setUnlinking(true);
		try {
			await unlinkTemplateFromInstance({
				templateId: unlinkConfirm.templateId,
				instanceId: unlinkConfirm.instanceId,
			});
			// Refetch templates and stats after unlinking
			queryClient.invalidateQueries({ queryKey: ["trash-guides", "templates"] });
			queryClient.invalidateQueries({ queryKey: ["template-stats", unlinkConfirm.templateId] });
			setUnlinkConfirm(null);
		} catch (error) {
			console.error("Unlink failed:", error);
			alert("Failed to unlink template from instance");
		} finally {
			setUnlinking(false);
		}
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
				<h2 className="text-xl font-semibold text-white">
					Templates {serviceType ? `(${serviceType})` : ""}
				</h2>
				<div className="flex gap-2">
					{/* Primary Actions: TRaSH Guides Quality Profile Wizard */}
					<button
						type="button"
						onClick={() => onBrowseQualityProfiles("RADARR")}
						className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white transition hover:bg-primary/90"
						title="Import quality profile from TRaSH Guides for Radarr using the wizard"
					>
						<Star className="h-4 w-4" />
						Radarr Profiles
					</button>
					<button
						type="button"
						onClick={() => onBrowseQualityProfiles("SONARR")}
						className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white transition hover:bg-primary/90"
						title="Import quality profile from TRaSH Guides for Sonarr using the wizard"
					>
						<Star className="h-4 w-4" />
						Sonarr Profiles
					</button>

					{/* Secondary Actions: Manual/Import */}
					<button
						type="button"
						onClick={() => setImportModal(true)}
						className="inline-flex items-center gap-2 rounded-lg bg-white/10 px-4 py-2 text-sm font-medium text-white transition hover:bg-white/20"
						title="Import an existing template from JSON file with validation"
					>
						<Download className="h-4 w-4" />
						Import JSON
					</button>
					<button
						type="button"
						onClick={onCreateNew}
						className="inline-flex items-center gap-2 rounded-lg bg-white/10 px-4 py-2 text-sm font-medium text-white transition hover:bg-white/20"
						title="Create a custom template manually (advanced)"
					>
						<Plus className="h-4 w-4" />
						Custom Template
					</button>
				</div>
			</div>

			{/* Search, Filter, and Sort Controls */}
			<div className="flex flex-col gap-3 rounded-lg border border-white/10 bg-white/5 p-4 sm:flex-row sm:items-center sm:justify-between">
				{/* Search Input */}
				<div className="flex-1 max-w-md">
					<div className="relative">
						<input
							type="text"
							placeholder="Search templates by name or description..."
							value={searchInput}
							onChange={(e) => setSearchInput(e.target.value)}
							className="w-full rounded-lg border border-white/20 bg-white/10 px-4 py-2 pl-10 text-sm text-white placeholder:text-white/40 focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
						/>
						<svg
							className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-white/40"
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
						className="rounded-lg border border-white/20 bg-white/10 px-3 py-2 text-sm text-white focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
					>
						<option value="updatedAt">Last Updated</option>
						<option value="createdAt">Date Created</option>
						<option value="name">Name</option>
						<option value="usageCount">Usage Count</option>
					</select>

					{/* Sort Order Toggle */}
					<button
						type="button"
						onClick={() => setSortOrder(sortOrder === "asc" ? "desc" : "asc")}
						className="inline-flex items-center gap-2 rounded-lg bg-white/10 px-3 py-2 text-sm font-medium text-white transition hover:bg-white/20"
						title={sortOrder === "asc" ? "Sort ascending" : "Sort descending"}
					>
						{sortOrder === "asc" ? "↑" : "↓"}
					</button>
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
					<div className="flex items-center justify-between text-sm text-white/60">
						<span>
							Showing {templates.length} template{templates.length !== 1 ? "s" : ""}
							{debouncedSearch && ` matching "${debouncedSearch}"`}
						</span>
					</div>

					<div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
					{templates.map((template) => (
						<article
							key={template.id}
							className="group relative rounded-xl border border-white/10 bg-white/5 p-6 transition hover:border-white/20 hover:bg-white/10"
						>
							{/* Delete Confirmation Overlay */}
							{deleteConfirm === template.id && (
								<div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 rounded-xl bg-black/80 p-6">
									<p className="text-center text-sm text-white">
										Delete &quot;{template.name}&quot;?
									</p>
									<div className="flex gap-2">
										<button
											type="button"
											onClick={() => handleDelete(template.id)}
											disabled={deleteMutation.isPending}
											className="rounded bg-red-500 px-3 py-1 text-sm font-medium text-white hover:bg-red-600 disabled:opacity-50"
										>
											{deleteMutation.isPending ? "Deleting..." : "Delete"}
										</button>
										<button
											type="button"
											onClick={() => setDeleteConfirm(null)}
											className="rounded bg-white/10 px-3 py-1 text-sm font-medium text-white hover:bg-white/20"
										>
											Cancel
										</button>
									</div>
								</div>
							)}

							{/* Duplicate Dialog Overlay */}
							{duplicatingId === template.id && (
								<div className="absolute inset-0 z-10 flex flex-col gap-3 rounded-xl bg-black/90 p-6">
									<p className="text-sm text-white">Duplicate as:</p>
									<input
										type="text"
										value={duplicateName}
										onChange={(e) => setDuplicateName(e.target.value)}
										placeholder="New template name"
										className="rounded border border-white/20 bg-white/10 px-3 py-2 text-sm text-white placeholder:text-white/40 focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
										autoFocus
									/>
									<div className="flex gap-2">
										<button
											type="button"
											onClick={() => handleDuplicate(template.id)}
											disabled={duplicateMutation.isPending || !duplicateName.trim()}
											className="rounded bg-primary px-3 py-1 text-sm font-medium text-white hover:bg-primary/90 disabled:opacity-50"
										>
											{duplicateMutation.isPending ? "Creating..." : "Create"}
										</button>
										<button
											type="button"
											onClick={() => {
												setDuplicatingId(null);
												setDuplicateName("");
											}}
											className="rounded bg-white/10 px-3 py-1 text-sm font-medium text-white hover:bg-white/20"
										>
											Cancel
										</button>
									</div>
								</div>
							)}

							{/* Template Card Content */}
							<div className="space-y-3">
								<div className="flex items-start justify-between">
									<div>
										<h3 className="font-medium text-white">{template.name}</h3>
										<p className="mt-1 text-xs text-white/60">{template.serviceType}</p>
									</div>
									<span className="text-xs text-white/40">
										v{template.updatedAt ? new Date(template.updatedAt).toLocaleDateString() : ""}
									</span>
								</div>

								{template.description && (
									<p className="text-sm text-white/70 line-clamp-2">{template.description}</p>
								)}

								<div className="space-y-2">
									<div className="flex items-center gap-2 text-xs text-white/60">
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
								{updatesData?.data.templatesWithUpdates.find((u) => u.templateId === template.id) && (
									<TemplateUpdateBanner
										update={updatesData.data.templatesWithUpdates.find((u) => u.templateId === template.id)!}
										onSyncSuccess={() => {
											// Refetch templates and updates after successful sync
											queryClient.invalidateQueries({ queryKey: ["trash-guides", "templates"] });
											queryClient.invalidateQueries({ queryKey: ["trash-guides", "updates"] });
										}}
									/>
								)}

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
								<button
									type="button"
									onClick={() => setInstanceSelectorTemplate({
										templateId: template.id,
										templateName: template.name,
										serviceType: template.serviceType
									})}
									className="w-full rounded-lg bg-primary px-4 py-3 text-sm font-medium text-white transition hover:bg-primary/90 flex items-center justify-center gap-2"
									title="Deploy this template to an instance"
								>
									<Rocket className="h-4 w-4" />
									Deploy to Instance
								</button>

								{/* Action Buttons */}
								<div className="flex gap-2 pt-2">
									<button
										type="button"
										onClick={() => onEdit(template)}
										className="flex-1 rounded bg-white/10 px-3 py-2 text-xs font-medium text-white transition hover:bg-white/20"
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
										className="flex-1 rounded bg-white/10 px-3 py-2 text-xs font-medium text-white transition hover:bg-white/20"
										title="Duplicate template"
									>
										<Copy className="mx-auto h-4 w-4" />
									</button>
									<button
										type="button"
										onClick={() => setExportModal({ templateId: template.id, templateName: template.name })}
										className="flex-1 rounded bg-white/10 px-3 py-2 text-xs font-medium text-white transition hover:bg-white/20"
										title="Export template with metadata"
									>
										<Download className="mx-auto h-4 w-4" />
									</button>
									<button
										type="button"
										onClick={() => setDeleteConfirm(template.id)}
										className="flex-1 rounded bg-red-500/20 px-3 py-2 text-xs font-medium text-red-200 transition hover:bg-red-500/30"
										title="Delete template"
									>
										<Trash2 className="mx-auto h-4 w-4" />
									</button>
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
					onDeploySuccess={() => {
						// Refetch templates, updates, and deployment history after successful deployment
						queryClient.invalidateQueries({ queryKey: ["trash-guides", "templates"] });
						queryClient.invalidateQueries({ queryKey: ["trash-guides", "updates"] });
						queryClient.invalidateQueries({ queryKey: ["deployment-history"] });
					}}
				/>
			)}

			{/* Instance Selector Modal */}
			{instanceSelectorTemplate && (
				<div className="fixed inset-0 bg-black/80 backdrop-blur-sm flex items-center justify-center z-50 p-4">
					<div className="bg-gradient-to-br from-slate-900 to-slate-800 rounded-xl shadow-2xl border border-white/20 max-w-2xl w-full max-h-[90vh] overflow-hidden flex flex-col">
						{/* Header */}
						<div className="flex items-center justify-between p-6 border-b border-white/10 bg-gradient-to-r from-primary/10 to-transparent">
							<div>
								<h2 className="text-xl font-semibold text-white flex items-center gap-2">
									<Rocket className="h-5 w-5 text-primary" />
									Deploy Template
								</h2>
								<p className="text-sm text-white/70 mt-1">
									{instanceSelectorTemplate.templateName}
								</p>
							</div>
							<button
								onClick={() => setInstanceSelectorTemplate(null)}
								className="p-2 rounded-lg hover:bg-white/10 transition-colors group"
								aria-label="Close"
							>
								<Copy className="h-5 w-5 text-white/60 group-hover:text-white rotate-45" />
							</button>
						</div>

						{/* Instance List */}
						<div className="flex-1 overflow-y-auto p-6 bg-slate-900/50">
							{/* Deploy to Multiple Button */}
							{(() => {
								const matchingInstances = servicesData?.filter(instance =>
									instance.service.toUpperCase() === instanceSelectorTemplate.serviceType
								) || [];

								if (matchingInstances.length > 1) {
									return (
										<button
											onClick={() => {
												setBulkDeployModal({
													templateId: instanceSelectorTemplate.templateId,
													templateName: instanceSelectorTemplate.templateName,
													instances: matchingInstances.map(inst => ({
														instanceId: inst.id,
														instanceLabel: inst.label,
														instanceType: inst.service.toUpperCase(),
													})),
												});
												setInstanceSelectorTemplate(null);
											}}
											className="w-full flex items-center justify-center gap-2 p-3 mb-4 rounded-lg border border-primary/30 bg-primary/10 hover:bg-primary/20 hover:border-primary/50 transition-all text-primary font-medium"
										>
											<Layers className="h-5 w-5" />
											Deploy to Multiple Instances ({matchingInstances.length} available)
										</button>
									);
								}
								return null;
							})()}

							<h3 className="text-sm font-medium text-white/90 mb-4">Select an instance to deploy to:</h3>
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
												onClick={() => {
													setDeploymentModal({
														templateId: instanceSelectorTemplate.templateId,
														templateName: instanceSelectorTemplate.templateName,
														instanceId: instance.id,
														instanceLabel: instance.label,
													});
													setInstanceSelectorTemplate(null);
												}}
												className="w-full flex items-center justify-between p-4 rounded-lg border border-white/20 bg-white/5 hover:bg-primary/20 hover:border-primary/50 transition-all text-left group shadow-lg hover:shadow-primary/20"
											>
												<div>
													<div className="font-medium text-white group-hover:text-primary transition-colors">
														{instance.label}
													</div>
													<div className="text-sm text-white/60 mt-1">
														{instance.service}
													</div>
												</div>
												<Rocket className="h-5 w-5 text-primary group-hover:scale-110 transition-transform" />
											</button>
										))
								) : (
									<div className="text-center py-12 px-4 rounded-lg border border-dashed border-white/20 bg-white/5">
										<AlertCircle className="h-12 w-12 text-white/40 mx-auto mb-4" />
										<p className="text-white/70 font-medium">No instances available.</p>
										<p className="text-sm text-white/50 mt-2">
											Add a Radarr or Sonarr instance in Settings first.
										</p>
									</div>
								)}
							</div>
						</div>

						{/* Footer */}
						<div className="flex items-center justify-end gap-3 p-6 border-t border-white/10 bg-slate-900/80">
							<button
								onClick={() => setInstanceSelectorTemplate(null)}
								className="px-4 py-2 text-sm rounded-lg border border-white/20 text-white/80 hover:bg-white/10 hover:text-white transition-colors"
							>
								Cancel
							</button>
						</div>
					</div>
				</div>
			)}

			{/* Enhanced Export Modal */}
			{exportModal && (
				<div className="fixed inset-0 bg-black/80 backdrop-blur-sm flex items-center justify-center z-50 p-4">
					<div className="bg-gradient-to-br from-slate-900 to-slate-800 rounded-xl shadow-2xl border border-white/20 max-w-2xl w-full max-h-[90vh] overflow-auto">
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
					<div className="bg-gradient-to-br from-slate-900 to-slate-800 rounded-xl shadow-2xl border border-white/20 max-w-2xl w-full max-h-[90vh] overflow-auto">
						<EnhancedTemplateImportModal
							onImportComplete={() => {
								queryClient.invalidateQueries({ queryKey: ["trash-guides", "templates"] });
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
					<div className="bg-gradient-to-br from-slate-900 to-slate-800 rounded-xl shadow-2xl border border-white/20 max-w-md w-full p-6">
						<div className="text-center space-y-4">
							<div className="flex items-center justify-center w-12 h-12 rounded-full bg-red-500/20 mx-auto">
								<AlertCircle className="h-6 w-6 text-red-400" />
							</div>
							<h3 className="text-lg font-semibold text-white">
								Remove from Instance?
							</h3>
							<p className="text-sm text-white/70">
								Are you sure you want to unlink template &quot;{unlinkConfirm.templateName}&quot; from instance &quot;{unlinkConfirm.instanceName}&quot;?
							</p>
							<p className="text-xs text-white/50">
								This will remove the deployment mapping. Custom Formats already on the instance will not be deleted.
							</p>
							<div className="flex gap-3 justify-center pt-2">
								<button
									type="button"
									onClick={() => setUnlinkConfirm(null)}
									disabled={unlinking}
									className="px-4 py-2 text-sm rounded-lg border border-white/20 text-white/80 hover:bg-white/10 transition-colors disabled:opacity-50"
								>
									Cancel
								</button>
								<button
									type="button"
									onClick={handleUnlinkInstance}
									disabled={unlinking}
									className="px-4 py-2 text-sm rounded-lg bg-red-500 text-white hover:bg-red-600 transition-colors disabled:opacity-50 flex items-center gap-2"
								>
									{unlinking ? (
										<>
											<RefreshCw className="h-4 w-4 animate-spin" />
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
					instances={bulkDeployModal.instances}
					onDeploySuccess={() => {
						setBulkDeployModal(null);
						queryClient.invalidateQueries({ queryKey: ["trash-guides", "templates"] });
					}}
				/>
			)}
		</div>
	);
};
