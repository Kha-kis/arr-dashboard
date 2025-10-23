"use client";

import React, { useState, useEffect, lazy, Suspense } from "react";
import {
	useCustomFormats,
	useCreateCustomFormat,
	useUpdateCustomFormat,
	useDeleteCustomFormat,
	useCopyCustomFormat,
	useExportCustomFormat,
	useImportCustomFormat,
} from "../../../hooks/api/useCustomFormats";
import {
	useTrashTracked,
	useSyncTrashFormats,
	useToggleSyncExclusion,
	useImportTrashFormat,
} from "../../../hooks/api/useTrashGuides";
import * as customFormatsApi from "../../../lib/api-client/custom-formats";
import { Card, CardHeader, CardTitle, CardDescription, CardContent, Button, Badge, Input, toast } from "../../../components/ui";
import type { CustomFormat } from "@arr/shared";
import { TrackedCFGroups } from "./tracked-cf-groups";

// Lazy load heavy modal components
const CustomFormatFormModal = lazy(() => import("./custom-format-form-modal").then(module => ({ default: module.CustomFormatFormModal })));
const ExportModal = lazy(() => import("./export-modal").then(module => ({ default: module.ExportModal })));
const ImportModal = lazy(() => import("./import-modal").then(module => ({ default: module.ImportModal })));
const TrashBrowserModal = lazy(() => import("./trash-browser-modal").then(module => ({ default: module.TrashBrowserModal })));

/**
 * Custom Formats Management Client
 * Unified view for managing custom formats across all Sonarr/Radarr instances
 */
export const CustomFormatsClient = () => {
	const { data, isLoading } = useCustomFormats();
	const createMutation = useCreateCustomFormat();
	const updateMutation = useUpdateCustomFormat();
	const deleteMutation = useDeleteCustomFormat();
	const copyMutation = useCopyCustomFormat();
	const { exportCustomFormat } = useExportCustomFormat();
	const importMutation = useImportCustomFormat();

	// TRaSH Guides tracking
	const { data: trashTrackedData } = useTrashTracked();
	const syncTrashMutation = useSyncTrashFormats();
	const toggleExclusionMutation = useToggleSyncExclusion();
	const trashImportMutation = useImportTrashFormat();

	const [selectedInstance, setSelectedInstance] = useState<string | null>(null);
	const [selectedFormat, setSelectedFormat] = useState<CustomFormat | null>(null);
	const [isModalOpen, setIsModalOpen] = useState(false);

	// Import modal state
	const [isImportModalOpen, setIsImportModalOpen] = useState(false);
	const [importingToInstance, setImportingToInstance] = useState<string | null>(null);
	const [importingInstanceLabel, setImportingInstanceLabel] = useState<string>("");

	// Enhanced filtering and selection
	const [searchQuery, setSearchQuery] = useState("");
	const [instanceFilter, setInstanceFilter] = useState<string>("all");
	const [showOnlyTrash, setShowOnlyTrash] = useState(false);
	const [showOnlyExcluded, setShowOnlyExcluded] = useState(false);
	const [viewMode, setViewMode] = useState<"cards" | "table">("cards");
	const [selectedFormats, setSelectedFormats] = useState<Set<string>>(new Set());
	const [sortColumn, setSortColumn] = useState<"name" | "instance" | "specifications">("name");
	const [sortDirection, setSortDirection] = useState<"asc" | "desc">("asc");

	// Export modal state
	const [isExportModalOpen, setIsExportModalOpen] = useState(false);
	const [exportingFormat, setExportingFormat] = useState<any>(null);
	const [exportFormatName, setExportFormatName] = useState("");

	// TRaSH browser modal state
	const [isTrashBrowserOpen, setIsTrashBrowserOpen] = useState(false);

	// TRaSH format selection state (for pre-filling form)
	const [selectedTrashFormat, setSelectedTrashFormat] = useState<any | null>(null);



	// Handlers
	const handleCreate = () => {
		if (!instances.length) {
			toast.error("No instances available. Add a Sonarr or Radarr instance first.");
			return;
		}
		// Default to first instance
		const firstInstance = instances[0];
		if (firstInstance) {
			setSelectedInstance(firstInstance.instanceId);
			setSelectedFormat(null);
			setIsModalOpen(true);
		}
	};

	const handleBrowseTrashClick = () => {
		if (!instances.length) {
			toast.error("No instances available. Add a Sonarr or Radarr instance first.");
			return;
		}
		setIsTrashBrowserOpen(true);
	};

	const handleImportMultipleTrash = async (formats: any[], instanceId: string, service: string) => {
		try {
			let successCount = 0;
			let failCount = 0;

			// Import each format sequentially to avoid overwhelming the API
			for (const format of formats) {
				try {
					await trashImportMutation.mutateAsync({
						instanceId,
						trashId: format.trash_id,
						service: service as "SONARR" | "RADARR",
					});
					successCount++;
				} catch (error) {
					failCount++;
					console.error(`Failed to import ${format.name}:`, error);
				}
			}

			if (successCount > 0) {
				toast.success(
					`Successfully imported ${successCount} custom format${successCount !== 1 ? 's' : ''}${
						failCount > 0 ? ` (${failCount} failed)` : ''
					}`
				);
			}
			if (failCount > 0 && successCount === 0) {
				toast.error(`Failed to import ${failCount} custom format${failCount !== 1 ? 's' : ''}`);
			}
		} catch (error) {
			toast.error(
				error instanceof Error ? error.message : "Failed to import custom formats"
			);
		}
	};

	const handleEdit = (format: CustomFormat, instanceId: string) => {
		setSelectedFormat(format);
		setSelectedInstance(instanceId);
		setIsModalOpen(true);
	};

	const handleModalClose = () => {
		setIsModalOpen(false);
		setSelectedFormat(null);
		setSelectedInstance(null);
		setSelectedTrashFormat(null);
	};

	const handleInstanceChange = (newInstanceId: string) => {
		setSelectedInstance(newInstanceId);
	};

	const handleFormSubmit = async (
		formData: Omit<CustomFormat, "id">,
		trashData?: { trashId: string; service: string; enableAutoSync: boolean }
	) => {
		if (!selectedInstance) {
			toast.error("No instance selected");
			return;
		}

		try {
			if (selectedFormat?.id) {
				// Update existing
				await updateMutation.mutateAsync({
					instanceId: selectedInstance,
					customFormatId: selectedFormat.id,
					customFormat: formData,
				});
				toast.success(`Custom format "${formData.name}" updated successfully`);
			} else if (trashData) {
				// Import from TRaSH
				const result = await trashImportMutation.mutateAsync({
					instanceId: selectedInstance,
					trashId: trashData.trashId,
					service: trashData.service as "SONARR" | "RADARR",
				});

				// If auto-sync should be disabled, toggle the exclusion
				if (!trashData.enableAutoSync && result.customFormat?.id) {
					await toggleExclusionMutation.mutateAsync({
						instanceId: selectedInstance,
						customFormatId: result.customFormat.id,
						syncExcluded: true,
					});
				}

				toast.success(
					result.action === "created"
						? `"${formData.name}" imported successfully`
						: `"${formData.name}" updated successfully`
				);
			} else {
				// Create new
				await createMutation.mutateAsync({
					instanceId: selectedInstance,
					customFormat: formData,
				});
				toast.success(`Custom format "${formData.name}" created successfully`);
			}
			handleModalClose();
		} catch (error) {
			toast.error(
				error instanceof Error ? error.message : "Failed to save custom format",
			);
		}
	};

	const handleDelete = async (instanceId: string, customFormatId: number, name: string) => {
		if (!window.confirm(`Delete custom format "${name}"?`)) return;

		try {
			await deleteMutation.mutateAsync({ instanceId, customFormatId });
			toast.success(`Custom format "${name}" deleted successfully`);
		} catch (error) {
			toast.error(
				error instanceof Error ? error.message : "Failed to delete custom format",
			);
		}
	};

	const handleExport = async (instanceId: string, customFormatId: number, formatName: string) => {
		try {
			// Fetch the format data from API (without triggering download)
			const formatData = await customFormatsApi.exportCustomFormat(instanceId, customFormatId);
			// Show in modal
			setExportingFormat(formatData);
			setExportFormatName(formatName);
			setIsExportModalOpen(true);
		} catch (error) {
			toast.error(
				error instanceof Error ? error.message : "Failed to export custom format",
			);
		}
	};

	const handleImportClick = (instanceId: string, instanceLabel: string) => {
		setImportingToInstance(instanceId);
		setImportingInstanceLabel(instanceLabel);
		setIsImportModalOpen(true);
	};

	const handleImport = async (customFormat: any) => {
		if (!importingToInstance) return;

		await importMutation.mutateAsync({
			instanceId: importingToInstance,
			customFormat,
		});
	};


	// Handler for when a TRaSH format is selected from the browser
	const handleSelectTrashFormat = (trashFormat: any, instanceId: string, service: string) => {
		// Convert TRaSH format to CustomFormat format
		const formattedFormat: Omit<CustomFormat, "id"> = {
			name: trashFormat.name,
			includeCustomFormatWhenRenaming: trashFormat.includeCustomFormatWhenRenaming || false,
			specifications: trashFormat.specifications || [],
		};

		// Set the pre-filled format and TRaSH metadata
		setSelectedFormat(formattedFormat as any);
		setSelectedTrashFormat({
			trashId: trashFormat.trash_id,
			service,
		});
		setSelectedInstance(instanceId);

		// Open the form modal
		setIsModalOpen(true);
	};

	const handleSyncTrash = async (instanceId: string, instanceLabel: string) => {
		try {
			const result = await syncTrashMutation.mutateAsync({ instanceId });
			if (result.synced > 0) {
				toast.success(`Synced ${result.synced} TRaSH custom format(s) for ${instanceLabel}`);
			} else {
				toast.info(`No TRaSH-managed custom formats to sync for ${instanceLabel}`);
			}
			if (result.failed > 0) {
				toast.warning(`${result.failed} format(s) failed to sync`);
			}
		} catch (error) {
			toast.error(
				error instanceof Error ? error.message : "Failed to sync TRaSH formats",
			);
		}
	};

	// Helper to check if a format is tracked by TRaSH
	const isTrackedByTrash = (instanceId: string, customFormatId: number) => {
		if (!trashTrackedData?.tracked) return false;
		const instanceTracked = trashTrackedData.tracked[instanceId] || [];
		return instanceTracked.some((t) => t.customFormatId === customFormatId);
	};

	// Get TRaSH tracking info for a format
	const getTrashInfo = (instanceId: string, customFormatId: number) => {
		if (!trashTrackedData?.tracked) return null;
		const instanceTracked = trashTrackedData.tracked[instanceId] || [];
		return instanceTracked.find((t) => t.customFormatId === customFormatId);
	};

	// Check if a TRaSH format is excluded from sync
	const isSyncExcluded = (instanceId: string, customFormatId: number) => {
		const trashInfo = getTrashInfo(instanceId, customFormatId);
		return trashInfo?.syncExcluded ?? false;
	};

	// Toggle sync exclusion for a TRaSH-managed format
	const handleToggleSyncExclusion = async (instanceId: string, customFormatId: number, currentlyExcluded: boolean, formatName: string) => {
		try {
			await toggleExclusionMutation.mutateAsync({
				instanceId,
				customFormatId,
				syncExcluded: !currentlyExcluded,
			});
			toast.success(
				!currentlyExcluded
					? `Auto-sync disabled for "${formatName}" - manual changes will be preserved`
					: `Auto-sync enabled for "${formatName}" - will receive TRaSH updates`
			);
		} catch (error) {
			toast.error(
				error instanceof Error ? error.message : "Failed to toggle auto-sync setting"
			);
		}
	};

	// Auto-sync handler for per-instance settings
	const handleUpdateInstanceSync = async (
		instanceId: string,
		enabled: boolean,
		intervalType: "DISABLED" | "HOURLY" | "DAILY" | "WEEKLY",
		intervalValue: number,
		syncFormats: boolean,
		syncCFGroups: boolean,
		syncQualityProfiles: boolean
	) => {
		try {
			await updateSyncSettingsMutation.mutateAsync({
				instanceId,
				settings: {
					enabled,
					intervalType,
					intervalValue,
					syncFormats,
					syncCFGroups,
					syncQualityProfiles,
				},
			});
			toast.success("Auto-sync settings saved successfully");
		} catch (error) {
			toast.error(
				error instanceof Error ? error.message : "Failed to save auto-sync settings",
			);
		}
	};

	// Bulk operations
	const toggleSelectAll = () => {
		if (selectedFormats.size === sortedFormats.length) {
			setSelectedFormats(new Set());
		} else {
			setSelectedFormats(new Set(sortedFormats.map((f) => `${f.instanceId}-${f.id}`)));
		}
	};

	const toggleSelectFormat = (instanceId: string, formatId: number) => {
		const key = `${instanceId}-${formatId}`;
		const newSelected = new Set(selectedFormats);
		if (newSelected.has(key)) {
			newSelected.delete(key);
		} else {
			newSelected.add(key);
		}
		setSelectedFormats(newSelected);
	};

	const handleBulkDelete = async () => {
		if (selectedFormats.size === 0) return;

		if (!window.confirm(`Delete ${selectedFormats.size} selected custom format(s)?`)) {
			return;
		}

		const deletePromises: Promise<void>[] = [];
		for (const key of selectedFormats) {
			const [instanceId, formatId] = key.split("-");
			if (!instanceId || !formatId) continue;
			deletePromises.push(
				deleteMutation.mutateAsync({
					instanceId,
					customFormatId: Number(formatId),
				}),
			);
		}

		try {
			await Promise.all(deletePromises);
			toast.success(`${selectedFormats.size} custom format(s) deleted successfully`);
			setSelectedFormats(new Set());
		} catch (error) {
			toast.error(
				error instanceof Error ? error.message : "Failed to delete some custom formats",
			);
		}
	};

	const handleBulkExport = async () => {
		if (selectedFormats.size === 0) return;

		try {
			for (const key of selectedFormats) {
				const [instanceId, formatId] = key.split("-");
				if (!instanceId || !formatId) continue;
				await exportCustomFormat(instanceId, Number(formatId));
			}
			toast.success(`${selectedFormats.size} custom format(s) exported successfully`);
		} catch (error) {
			toast.error(
				error instanceof Error ? error.message : "Failed to export some custom formats",
			);
		}
	};

	const instances = data?.instances || [];
	const allFormats = instances.flatMap((instance) => {
		const formats = Array.isArray(instance.customFormats) ? instance.customFormats : [];
		return formats.map((cf) => ({
			...cf,
			instanceId: instance.instanceId,
			instanceLabel: instance.instanceLabel,
			instanceService: instance.instanceService,
		}));
	});

	// Sorting handler
	const handleSort = (column: "name" | "instance" | "specifications") => {
		if (sortColumn === column) {
			// Toggle direction if same column
			setSortDirection(sortDirection === "asc" ? "desc" : "asc");
		} else {
			// New column, default to ascending
			setSortColumn(column);
			setSortDirection("asc");
		}
	};

	// Apply filters
	const filteredFormats = allFormats.filter((format) => {
		// Search filter
		if (searchQuery && !format.name.toLowerCase().includes(searchQuery.toLowerCase())) {
			return false;
		}
		// Instance filter
		if (instanceFilter !== "all" && format.instanceId !== instanceFilter) {
			return false;
		}
		// TRaSH filter
		if (showOnlyTrash && format.id && !isTrackedByTrash(format.instanceId, format.id)) {
			return false;
		}
		// Excluded filter
		if (showOnlyExcluded && format.id) {
			if (!isTrackedByTrash(format.instanceId, format.id)) {
				return false;
			}
			if (!isSyncExcluded(format.instanceId, format.id)) {
				return false;
			}
		}
		return true;
	});

	// Apply sorting
	const sortedFormats = [...filteredFormats].sort((a, b) => {
		let compareValue = 0;

		if (sortColumn === "name") {
			compareValue = a.name.localeCompare(b.name);
		} else if (sortColumn === "instance") {
			compareValue = a.instanceLabel.localeCompare(b.instanceLabel);
		} else if (sortColumn === "specifications") {
			compareValue = (a.specifications?.length || 0) - (b.specifications?.length || 0);
		}

		return sortDirection === "asc" ? compareValue : -compareValue;
	});

	if (isLoading) {
		return (
			<div className="flex items-center justify-center py-12">
				<div className="text-fg-muted">Loading custom formats...</div>
			</div>
		);
	}

	return (
		<div className="space-y-6">
					{/* Header */}
					<Card>
						<CardHeader>
							<CardTitle>Custom Formats</CardTitle>
							<CardDescription>
								Manage custom formats across all your Sonarr and Radarr instances
							</CardDescription>
						</CardHeader>
						<CardContent className="space-y-4">
							{/* Actions row */}
							<div className="flex flex-wrap gap-3 items-center">
								<Button onClick={handleCreate}>Create Custom Format</Button>
								<Button onClick={handleBrowseTrashClick}>
									Import from TRaSH Guides
								</Button>

								{/* View mode toggle */}
								<div className="flex border border-border rounded-lg overflow-hidden">
									<button
										type="button"
										onClick={() => setViewMode("cards")}
										className={`px-3 py-1.5 text-sm transition-colors ${
											viewMode === "cards"
												? "bg-primary text-white"
												: "bg-bg-subtle text-fg-muted hover:text-fg"
										}`}
									>
										Cards
									</button>
									<button
										type="button"
										onClick={() => setViewMode("table")}
										className={`px-3 py-1.5 text-sm transition-colors ${
											viewMode === "table"
												? "bg-primary text-white"
												: "bg-bg-subtle text-fg-muted hover:text-fg"
										}`}
									>
										Table
									</button>
								</div>

								<div className="ml-auto text-sm text-fg-muted">
									Showing {filteredFormats.length} of {allFormats.length} format
									{allFormats.length !== 1 ? "s" : ""}
								</div>
							</div>

							{/* Filters row */}
							<div className="flex flex-wrap gap-3">
								{/* Search */}
								<Input
									type="text"
									placeholder="Search custom formats..."
									value={searchQuery}
									onChange={(e) => setSearchQuery(e.target.value)}
									className="flex-1 min-w-[200px] max-w-sm"
								/>

								{/* Instance filter */}
								<select
									value={instanceFilter}
									onChange={(e) => setInstanceFilter(e.target.value)}
									className="rounded-lg border border-border bg-bg px-3 py-2 text-sm text-fg focus:ring-2 focus:ring-primary focus:ring-offset-2"
								>
									<option value="all">All Instances</option>
									{instances.map((instance) => (
										<option key={instance.instanceId} value={instance.instanceId}>
											{instance.instanceLabel}
										</option>
									))}
								</select>

								{/* TRaSH filter */}
								<label className="flex items-center gap-2 px-3 py-2 rounded-lg border border-border bg-bg cursor-pointer hover:bg-bg-subtle transition-colors">
									<input
										type="checkbox"
										checked={showOnlyTrash}
										onChange={(e) => setShowOnlyTrash(e.target.checked)}
										className="h-4 w-4 rounded border-border bg-bg-subtle text-success focus:ring-2 focus:ring-success focus:ring-offset-2"
									/>
									<span className="text-sm text-fg whitespace-nowrap">
										TRaSH Guides Only
									</span>
								</label>

								{/* Excluded filter */}
								<label className="flex items-center gap-2 px-3 py-2 rounded-lg border border-border bg-bg cursor-pointer hover:bg-bg-subtle transition-colors">
									<input
										type="checkbox"
										checked={showOnlyExcluded}
										onChange={(e) => setShowOnlyExcluded(e.target.checked)}
										className="h-4 w-4 rounded border-border bg-bg-subtle text-danger focus:ring-2 focus:ring-danger focus:ring-offset-2"
									/>
									<span className="text-sm text-fg whitespace-nowrap">
										Excluded from Auto-Sync
									</span>
								</label>

								{/* Bulk actions (only in table view) */}
								{viewMode === "table" && selectedFormats.size > 0 && (
									<div className="flex gap-2 items-center">
										<span className="text-sm text-fg-muted">
											{selectedFormats.size} selected
										</span>
										<Button
											size="sm"
											variant="ghost"
											onClick={handleBulkExport}
											disabled={importMutation.isPending}
										>
											Export Selected
										</Button>
										<Button
											size="sm"
											variant="danger"
											onClick={handleBulkDelete}
											disabled={deleteMutation.isPending}
										>
											Delete Selected
										</Button>
									</div>
								)}
							</div>
						</CardContent>
					</Card>

			{/* Content */}
			{instances.length === 0 ? (
				<Card>
					<CardContent className="py-12">
						<div className="text-center space-y-4">
							<p className="text-fg-muted">
								No Sonarr or Radarr instances configured.
							</p>
							<p className="text-sm text-fg-subtle">
								Add instances in Settings → Services to get started.
							</p>
							<Button asChild>
								<a href="/settings">Go to Settings</a>
							</Button>
						</div>
					</CardContent>
				</Card>
			) : viewMode === "table" ? (
				/* Table View */
				<Card>
					<CardContent className="p-0">
						<div className="overflow-x-auto">
							<table className="w-full">
								<thead className="border-b border-border bg-bg-subtle/50">
									<tr>
										<th className="text-left p-4 w-12">
											<input
												type="checkbox"
												checked={selectedFormats.size === sortedFormats.length && sortedFormats.length > 0}
												onChange={toggleSelectAll}
												className="h-4 w-4 rounded border-border bg-bg-subtle text-primary focus:ring-2 focus:ring-primary focus:ring-offset-2"
											/>
										</th>
										<th
											className="text-left p-4 text-sm font-medium text-fg cursor-pointer hover:text-primary transition-colors select-none"
											onClick={() => handleSort("name")}
										>
											<div className="flex items-center gap-2">
												Name
												{sortColumn === "name" && (
													<span className="text-primary">
														{sortDirection === "asc" ? "↑" : "↓"}
													</span>
												)}
											</div>
										</th>
										<th
											className="text-left p-4 text-sm font-medium text-fg cursor-pointer hover:text-primary transition-colors select-none"
											onClick={() => handleSort("instance")}
										>
											<div className="flex items-center gap-2">
												Instance
												{sortColumn === "instance" && (
													<span className="text-primary">
														{sortDirection === "asc" ? "↑" : "↓"}
													</span>
												)}
											</div>
										</th>
										<th
											className="text-left p-4 text-sm font-medium text-fg cursor-pointer hover:text-primary transition-colors select-none"
											onClick={() => handleSort("specifications")}
										>
											<div className="flex items-center gap-2">
												Specifications
												{sortColumn === "specifications" && (
													<span className="text-primary">
														{sortDirection === "asc" ? "↑" : "↓"}
													</span>
												)}
											</div>
										</th>
										<th className="text-right p-4 text-sm font-medium text-fg">Actions</th>
									</tr>
								</thead>
								<tbody>
									{sortedFormats.length === 0 ? (
										<tr>
											<td colSpan={5} className="p-12 text-center text-fg-muted">
												No custom formats found
											</td>
										</tr>
									) : (
										sortedFormats.map((format) => {
											const key = `${format.instanceId}-${format.id}`;
											const isSelected = selectedFormats.has(key);

											return (
												<tr
													key={key}
													className={`border-b border-border/50 hover:bg-bg-subtle/30 transition-colors ${
														isSelected ? "bg-primary/5" : ""
													}`}
												>
													<td className="p-4">
														<input
															type="checkbox"
															checked={isSelected}
															onChange={() => toggleSelectFormat(format.instanceId, format.id!)}
															className="h-4 w-4 rounded border-border bg-bg-subtle text-primary focus:ring-2 focus:ring-primary focus:ring-offset-2"
														/>
													</td>
													<td className="p-4">
														<div className="flex items-start gap-2">
															<span className="font-medium text-sm text-fg">
																{format.name}
															</span>
															{isTrackedByTrash(format.instanceId, format.id!) && (
																<div className="flex items-start gap-1 flex-wrap">
																	<Badge variant="success" className="text-xs shrink-0" title="Managed by TRaSH Guides">
																		TRaSH
																	</Badge>
																	{(() => {
																		const trashInfo = getTrashInfo(format.instanceId, format.id!);
																		if (trashInfo?.importSource) {
																			const sourceType = trashInfo.importSource === "CF_GROUP" ? "CF" : trashInfo.importSource === "QUALITY_PROFILE" ? "QP" : "Individual";
																			const sourceTypeFull = trashInfo.importSource === "CF_GROUP" ? "CF Group" : trashInfo.importSource === "QUALITY_PROFILE" ? "Quality Profile" : "Individual";
																			// Use sourceDisplayName (friendly name) if available, otherwise fall back to sourceReference (filename)
																			const displayName = (trashInfo as any).sourceDisplayName || trashInfo.sourceReference;
																			const badgeLabel = displayName
																				? `${sourceType}: ${displayName}`
																				: sourceType;
																			const sourceTitle = displayName
																				? `Imported from ${sourceTypeFull}: ${displayName}`
																				: `Imported as ${sourceTypeFull}`;
																			return (
																				<Badge variant="info" className="text-xs shrink-0" title={sourceTitle}>
																					{badgeLabel}
																				</Badge>
																			);
																		}
																		return null;
																	})()}
																	{(() => {
																		const trashInfo = getTrashInfo(format.instanceId, format.id!);
																		if (trashInfo?.importSource === "CF_GROUP" && (trashInfo as any).associatedQualityProfile) {
																			return (
																				<Badge variant="info" className="text-xs shrink-0" title={`Part of Quality Profile: ${(trashInfo as any).associatedQualityProfile}`}>
																					QP: {(trashInfo as any).associatedQualityProfile}
																				</Badge>
																			);
																		}
																		return null;
																	})()}
																	{isSyncExcluded(format.instanceId, format.id!) && (
																		<Badge variant="warning" className="text-xs shrink-0" title="Excluded from automatic TRaSH sync - will not be updated during sync operations">
																			Auto-Sync Off
																		</Badge>
																	)}
																</div>
															)}
														</div>
													</td>
													<td className="p-4">
														<div className="flex items-center gap-2">
															<Badge variant="default" className="text-xs">
																{format.instanceService}
															</Badge>
															<span className="text-sm text-fg-muted">
																{format.instanceLabel}
															</span>
														</div>
													</td>
													<td className="p-4">
														<span className="text-sm text-fg-muted">
															{format.specifications?.length || 0} specification
															{format.specifications?.length !== 1 ? "s" : ""}
														</span>
													</td>
													<td className="p-4">
														<div className="flex gap-1 justify-end">
															{isTrackedByTrash(format.instanceId, format.id!) && (
																<Button
																	size="sm"
																	variant="ghost"
																	onClick={() => handleToggleSyncExclusion(
																		format.instanceId,
																		format.id!,
																		isSyncExcluded(format.instanceId, format.id!),
																		format.name
																	)}
																	disabled={toggleExclusionMutation.isPending}
																	title={isSyncExcluded(format.instanceId, format.id!) ? "Enable auto-sync for this format" : "Disable auto-sync for this format"}
																>
																	{isSyncExcluded(format.instanceId, format.id!) ? "Enable Auto-Sync" : "Disable Auto-Sync"}
																</Button>
															)}
															<Button
																size="sm"
																variant="ghost"
																onClick={() => handleEdit(format, format.instanceId)}
															>
																Edit
															</Button>
															<Button
																size="sm"
																variant="ghost"
																onClick={() => handleExport(format.instanceId, format.id!, format.name)}
															>
																Export
															</Button>
															<Button
																size="sm"
																variant="ghost"
																onClick={() => handleDelete(format.instanceId, format.id!, format.name)}
																disabled={deleteMutation.isPending}
															>
																Delete
															</Button>
														</div>
													</td>
												</tr>
											);
										})
									)}
								</tbody>
							</table>
						</div>
					</CardContent>
				</Card>
			) : (
				/* Cards View - Individual format cards grouped by instance */
				<div className="space-y-6">
					{instances.map((instance) => {
						// Filter formats for this instance
						const instanceFormats = sortedFormats.filter(
							(f) => f.instanceId === instance.instanceId
						);

						// Skip instance if no formats after filtering
						if (instanceFormats.length === 0) {
							return null;
						}

						return (
							<div key={instance.instanceId} className="space-y-3">
								{/* Instance header */}
								<div className="flex items-center justify-between gap-3 px-1">
									<div className="flex items-center gap-3">
										<h3 className="text-lg font-semibold text-fg">
											{instance.instanceLabel}
										</h3>
										<Badge variant="default" className="text-xs">
											{instance.instanceService}
										</Badge>
										<span className="text-sm text-fg-muted">
											{instanceFormats.length} format{instanceFormats.length !== 1 ? "s" : ""}
										</span>
										{/* Show TRaSH managed count */}
										{(() => {
											const trashCount = trashTrackedData?.tracked?.[instance.instanceId]?.length ?? 0;
											return trashCount > 0 ? (
												<Badge variant="success" className="text-xs">
													{trashCount} TRaSH
												</Badge>
											) : null;
										})()}
									</div>
									<div className="flex gap-2">
										{/* Sync TRaSH button - only show if there are tracked formats */}
										{(() => {
											const trashCount = trashTrackedData?.tracked?.[instance.instanceId]?.length ?? 0;
											return trashCount > 0 ? (
												<Button
													size="sm"
													variant="secondary"
													onClick={() => handleSyncTrash(instance.instanceId, instance.instanceLabel)}
													disabled={syncTrashMutation.isPending}
												>
													{syncTrashMutation.isPending ? "Syncing..." : "Sync TRaSH"}
												</Button>
											) : null;
										})()}
										<Button
											size="sm"
											variant="secondary"
											onClick={() => handleImportClick(instance.instanceId, instance.instanceLabel)}
											disabled={importMutation.isPending}
										>
											Import JSON
										</Button>
									</div>
								</div>

								{/* Format cards grid */}
								<div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
									{instanceFormats.map((format) => {
										const trashInfo = format.id ? getTrashInfo(instance.instanceId, format.id) : null;
										const isTrash = format.id ? isTrackedByTrash(instance.instanceId, format.id) : false;

										return (
											<Card key={format.id} className="hover:border-primary/50 transition-colors">
												<CardHeader className="pb-3">
													<div className="space-y-2">
														<CardTitle className="text-sm" title={format.name}>
															{format.name}
														</CardTitle>
														{isTrash && (
															<div className="flex items-start gap-1 flex-wrap">
																<Badge variant="success" className="text-xs shrink-0" title={`Managed by TRaSH Guides\nLast synced: ${trashInfo?.lastSyncedAt ? new Date(trashInfo.lastSyncedAt).toLocaleString() : 'Unknown'}`}>
																	TRaSH
																</Badge>
																{format.id && trashInfo?.importSource && (() => {
																	const sourceType = trashInfo.importSource === "CF_GROUP" ? "CF" : trashInfo.importSource === "QUALITY_PROFILE" ? "QP" : "Individual";
																	const sourceTypeFull = trashInfo.importSource === "CF_GROUP" ? "CF Group" : trashInfo.importSource === "QUALITY_PROFILE" ? "Quality Profile" : "Individual";
																	// Use sourceDisplayName (friendly name) if available, otherwise fall back to sourceReference (filename)
																	const displayName = (trashInfo as any).sourceDisplayName || trashInfo.sourceReference;
																	const badgeLabel = displayName
																		? `${sourceType}: ${displayName}`
																		: sourceType;
																	const sourceTitle = displayName
																		? `Imported from ${sourceTypeFull}: ${displayName}`
																		: `Imported as ${sourceTypeFull}`;
																	return (
																		<Badge
																			variant="info"
																			className="text-xs shrink-0"
																			title={sourceTitle}
																		>
																			{badgeLabel}
																		</Badge>
																	);
																})()}
																{format.id && trashInfo?.importSource === "CF_GROUP" && (trashInfo as any).associatedQualityProfile && (
																	<Badge variant="info" className="text-xs shrink-0" title={`Part of Quality Profile: ${(trashInfo as any).associatedQualityProfile}`}>
																		QP: {(trashInfo as any).associatedQualityProfile}
																	</Badge>
																)}
																{format.id && isSyncExcluded(instance.instanceId, format.id) && (
																	<Badge variant="warning" className="text-xs shrink-0" title="Excluded from automatic TRaSH sync - will not be updated during sync operations">
																		Auto-Sync Off
																	</Badge>
																)}
															</div>
														)}
													</div>
												</CardHeader>
												<CardContent className="space-y-3">
													<div className="text-xs text-fg-muted">
														{format.specifications?.length || 0} specification
														{format.specifications?.length !== 1 ? "s" : ""}
													</div>

													{/* Actions */}
													<div className="space-y-2">
														{isTrash && format.id && (
															<Button
																size="sm"
																variant={isSyncExcluded(instance.instanceId, format.id) ? "secondary" : "ghost"}
																onClick={() => handleToggleSyncExclusion(
																	instance.instanceId,
																	format.id!,
																	isSyncExcluded(instance.instanceId, format.id!),
																	format.name
																)}
																disabled={toggleExclusionMutation.isPending}
																className="w-full"
																title={isSyncExcluded(instance.instanceId, format.id) ? "Enable auto-sync for this format" : "Disable auto-sync for this format"}
															>
																{isSyncExcluded(instance.instanceId, format.id) ? "Enable Auto-Sync" : "Disable Auto-Sync"}
															</Button>
														)}
														<div className="flex gap-1">
															<Button
																size="sm"
																variant="ghost"
																onClick={() => handleEdit(format, instance.instanceId)}
																className="flex-1"
															>
																Edit
															</Button>
															<Button
																size="sm"
																variant="ghost"
																onClick={() => handleExport(instance.instanceId, format.id!, format.name)}
															>
																Export
															</Button>
															<Button
																size="sm"
																variant="ghost"
																onClick={() => handleDelete(instance.instanceId, format.id!, format.name)}
																disabled={deleteMutation.isPending}
															>
																Delete
															</Button>
														</div>
													</div>
												</CardContent>
											</Card>
										);
									})}
								</div>
							</div>
						);
					})}

					{/* Empty state when all instances filtered out */}
					{sortedFormats.length === 0 && (
						<Card>
							<CardContent className="py-12">
								<div className="text-center text-fg-muted">
									No custom formats found
								</div>
							</CardContent>
						</Card>
					)}
				</div>
			)}

			{/* Tracked CF Groups */}
			<TrackedCFGroups />

			{/* Modals (outside tabs, lazy loaded with Suspense) */}
			{/* Create/Edit Modal */}
			{isModalOpen && (
				<Suspense fallback={<div />}>
					<CustomFormatFormModal
						isOpen={isModalOpen}
						onClose={handleModalClose}
						onSubmit={handleFormSubmit}
						initialData={selectedFormat}
						isSubmitting={createMutation.isPending || updateMutation.isPending}
						instanceId={selectedInstance || undefined}
						instances={instances}
						onInstanceChange={handleInstanceChange}
						isTrackedByTrash={selectedFormat?.id && selectedInstance ? isTrackedByTrash(selectedInstance, selectedFormat.id) : false}
						isSyncExcluded={selectedFormat?.id && selectedInstance ? isSyncExcluded(selectedInstance, selectedFormat.id) : false}
						onToggleSyncExclusion={selectedFormat?.id && selectedInstance ? () => handleToggleSyncExclusion(selectedInstance, selectedFormat.id!, isSyncExcluded(selectedInstance, selectedFormat.id!), selectedFormat.name) : undefined}
						isTogglingExclusion={toggleExclusionMutation.isPending}
						trashData={selectedTrashFormat}
					/>
				</Suspense>
			)}

			{/* Export Modal */}
			{isExportModalOpen && (
				<Suspense fallback={<div />}>
					<ExportModal
						isOpen={isExportModalOpen}
						onClose={() => setIsExportModalOpen(false)}
						customFormat={exportingFormat}
						formatName={exportFormatName}
					/>
				</Suspense>
			)}

			{/* Import Modal */}
			{isImportModalOpen && (
				<Suspense fallback={<div />}>
					<ImportModal
						isOpen={isImportModalOpen}
						onClose={() => setIsImportModalOpen(false)}
						onImport={handleImport}
						instanceLabel={importingInstanceLabel}
					/>
				</Suspense>
			)}

			{/* TRaSH Browser Modal */}
			{isTrashBrowserOpen && (
				<Suspense fallback={<div />}>
					<TrashBrowserModal
						isOpen={isTrashBrowserOpen}
						onClose={() => setIsTrashBrowserOpen(false)}
						instances={instances}
						onSelectFormat={handleSelectTrashFormat}
						onImportMultiple={handleImportMultipleTrash}
					/>
				</Suspense>
			)}
		</div>
	);
};
