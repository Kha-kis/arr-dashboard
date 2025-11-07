"use client";

import { useState } from "react";
import type { TrashTemplate } from "@arr/shared";
import {
	useTemplates,
	useDeleteTemplate,
	useDuplicateTemplate,
} from "../../../hooks/api/useTemplates";
import { Alert, AlertTitle, AlertDescription, EmptyState, Skeleton } from "../../../components/ui";
import { AlertCircle, Plus, Download, Copy, Trash2, Edit, FileText, RefreshCw, Star } from "lucide-react";
import { exportTemplate } from "../../../lib/api-client/templates";
import { TemplateStats } from "./template-stats";
import { SyncValidationModal } from "./sync-validation-modal";
import { SyncProgressModal } from "./sync-progress-modal";
import { useExecuteSync } from "../../../hooks/api/useSync";

interface TemplateListProps {
	serviceType?: "RADARR" | "SONARR";
	onCreateNew: () => void;
	onEdit: (template: TrashTemplate) => void;
	onImport: () => void;
	onBrowseQualityProfiles: (serviceType: "RADARR" | "SONARR") => void;
}

export const TemplateList = ({ serviceType, onCreateNew, onEdit, onImport, onBrowseQualityProfiles }: TemplateListProps) => {
	const { data, isLoading, error } = useTemplates({ serviceType });
	const deleteMutation = useDeleteTemplate();
	const duplicateMutation = useDuplicateTemplate();
	const executeSync = useExecuteSync();

	const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null);
	const [duplicateName, setDuplicateName] = useState<string>("");
	const [duplicatingId, setDuplicatingId] = useState<string | null>(null);
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

	const handleExport = async (templateId: string, templateName: string) => {
		try {
			const jsonData = await exportTemplate(templateId);
			const blob = new Blob([jsonData], { type: "application/json" });
			const url = URL.createObjectURL(blob);
			const a = document.createElement("a");
			a.href = url;
			a.download = `${templateName.toLowerCase().replace(/\s+/g, "-")}-template.json`;
			document.body.appendChild(a);
			a.click();
			document.body.removeChild(a);
			URL.revokeObjectURL(url);
		} catch (error) {
			console.error("Export failed:", error);
			alert("Failed to export template");
		}
	};

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
						onClick={onImport}
						className="inline-flex items-center gap-2 rounded-lg bg-white/10 px-4 py-2 text-sm font-medium text-white transition hover:bg-white/20"
						title="Import an existing template from JSON file"
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

			{templates.length === 0 ? (
				<EmptyState
					icon={FileText}
					title="No templates yet"
					description="Create your first template to get started with TRaSH Guides deployment"
				/>
			) : (
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

								<div className="flex items-center gap-2 text-xs text-white/60">
									<span>{template.config.customFormats.length} formats</span>
									<span>•</span>
									<span>{template.config.customFormatGroups.length} groups</span>
								</div>

								{/* Template Stats */}
								<TemplateStats templateId={template.id} onSync={(instanceId, instanceName) => {
									setValidationModal({
										templateId: template.id,
										templateName: template.name,
										instanceId,
										instanceName,
									});
								}} />

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
										onClick={() => handleExport(template.id, template.name)}
										className="flex-1 rounded bg-white/10 px-3 py-2 text-xs font-medium text-white transition hover:bg-white/20"
										title="Export template"
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
		</div>
	);
};
