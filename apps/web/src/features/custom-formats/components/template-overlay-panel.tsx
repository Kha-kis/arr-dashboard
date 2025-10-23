"use client";

import React, { useState, useEffect } from "react";
import {
	useTemplateOverlay,
	useUpdateTemplateOverlay,
	usePreviewTemplateMerge,
	useApplyTemplateMerge,
} from "../../../hooks/api/useCustomFormats";
import { Card, CardHeader, CardTitle, CardDescription, CardContent, Button, Badge, Input, toast } from "../../../components/ui";
import type { TemplateOverlayDto, CfOverride } from "@arr/shared";

interface TemplateOverlayPanelProps {
	instanceId: string;
	instanceLabel: string;
	instanceService: string;
}

/**
 * Template Overlay Panel
 * Configure template includes, excludes, and per-CF overrides for an instance
 */
export function TemplateOverlayPanel({
	instanceId,
	instanceLabel,
	instanceService,
}: TemplateOverlayPanelProps) {
	const { data: overlayData, isLoading } = useTemplateOverlay(instanceId);
	const updateOverlayMutation = useUpdateTemplateOverlay();
	const previewMutation = usePreviewTemplateMerge();
	const applyMutation = useApplyTemplateMerge();

	// Migration state
	const [showMigrationReport, setShowMigrationReport] = useState(false);
	const [migrationReport, setMigrationReport] = useState<any>(null);
	const [isMigrating, setIsMigrating] = useState(false);

	// Local state for editing
	const [includes, setIncludes] = useState<string[]>([]);
	const [excludes, setExcludes] = useState<string[]>([]);
	const [overrides, setOverrides] = useState<Record<string, CfOverride>>({});

	// Input state for adding new items
	const [newInclude, setNewInclude] = useState("");
	const [newExclude, setNewExclude] = useState("");

	// Override editor state
	const [showOverrideEditor, setShowOverrideEditor] = useState(false);
	const [editingOverrideId, setEditingOverrideId] = useState("");
	const [overrideForm, setOverrideForm] = useState<CfOverride>({});

	// Preview state
	const [showPreview, setShowPreview] = useState(false);
	const [previewData, setPreviewData] = useState<any>(null);

	// Load overlay data when it arrives
	useEffect(() => {
		if (overlayData?.overlay) {
			setIncludes(overlayData.overlay.includes || []);
			setExcludes(overlayData.overlay.excludes || []);
			setOverrides(overlayData.overlay.overrides || {});
		}
	}, [overlayData]);

	// Handlers for includes
	const handleAddInclude = () => {
		if (!newInclude.trim()) return;
		if (includes.includes(newInclude.trim())) {
			toast.error("Template already included");
			return;
		}
		setIncludes([...includes, newInclude.trim()]);
		setNewInclude("");
	};

	const handleRemoveInclude = (templateId: string) => {
		setIncludes(includes.filter((id) => id !== templateId));
	};

	// Handlers for excludes
	const handleAddExclude = () => {
		if (!newExclude.trim()) return;
		if (excludes.includes(newExclude.trim())) {
			toast.error("Already excluded");
			return;
		}
		setExcludes([...excludes, newExclude.trim()]);
		setNewExclude("");
	};

	const handleRemoveExclude = (cfId: string) => {
		setExcludes(excludes.filter((id) => id !== cfId));
	};

	// Handlers for overrides
	const handleOpenOverrideEditor = (cfId?: string) => {
		if (cfId && overrides[cfId]) {
			setEditingOverrideId(cfId);
			setOverrideForm(overrides[cfId]);
		} else {
			setEditingOverrideId("");
			setOverrideForm({});
		}
		setShowOverrideEditor(true);
	};

	const handleSaveOverride = () => {
		if (!editingOverrideId.trim()) {
			toast.error("CF ID is required");
			return;
		}

		// Remove empty fields from override
		const cleanedOverride = Object.fromEntries(
			Object.entries(overrideForm).filter(([_, value]) => value !== undefined && value !== "")
		) as CfOverride;

		if (Object.keys(cleanedOverride).length === 0) {
			// Remove override if empty
			const newOverrides = { ...overrides };
			delete newOverrides[editingOverrideId];
			setOverrides(newOverrides);
		} else {
			setOverrides({
				...overrides,
				[editingOverrideId]: cleanedOverride,
			});
		}

		setShowOverrideEditor(false);
		setEditingOverrideId("");
		setOverrideForm({});
	};

	const handleRemoveOverride = (cfId: string) => {
		const newOverrides = { ...overrides };
		delete newOverrides[cfId];
		setOverrides(newOverrides);
	};

	// Save overlay
	const handleSave = async () => {
		const overlay: TemplateOverlayDto = {
			includes,
			excludes,
			overrides,
		};

		try {
			await updateOverlayMutation.mutateAsync({
				instanceId,
				overlay,
			});
			toast.success("Template overlay saved successfully");
		} catch (error) {
			toast.error(
				error instanceof Error ? error.message : "Failed to save template overlay"
			);
		}
	};

	// Preview changes
	const handlePreview = async () => {
		try {
			const result = await previewMutation.mutateAsync({
				instanceId,
				instanceLabel,
				request: {
					includes,
					excludes,
					overrides,
				},
			});
			setPreviewData(result);
			setShowPreview(true);
		} catch (error) {
			toast.error(
				error instanceof Error ? error.message : "Failed to preview changes"
			);
		}
	};

	// Migrate from ARR Sync
	const handleMigrateFromArrSync = async () => {
		if (!window.confirm(
			`Migrate ARR Sync settings for ${instanceLabel}?\n\nThis will convert your existing ARR Sync configuration to the new Template Overlay format. Any existing overlay will be replaced.`
		)) {
			return;
		}

		setIsMigrating(true);
		try {
			const response = await fetch(`/api/custom-formats/${instanceId}/migrate-from-arr-sync`, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
				},
			});

			if (!response.ok) {
				const error = await response.json();
				throw new Error(error.message || error.error || "Migration failed");
			}

			const result = await response.json();
			setMigrationReport(result);
			setShowMigrationReport(true);

			// Reload overlay data to show migrated settings
			// The useTemplateOverlay hook will automatically refetch
			toast.success("Successfully migrated ARR Sync settings");
		} catch (error) {
			toast.error(
				error instanceof Error ? error.message : "Failed to migrate ARR Sync settings"
			);
		} finally {
			setIsMigrating(false);
		}
	};

	// Apply changes to instance
	const handleApply = async () => {
		if (!window.confirm(
			`Apply template overlay to ${instanceLabel}?\n\nThis will modify custom formats on your ${instanceService} instance.`
		)) {
			return;
		}

		try{
			const result = await applyMutation.mutateAsync({
				instanceId,
				instanceLabel,
				request: {
					includes,
					excludes,
					overrides,
					dryRun: false,
				},
			});
			const totalApplied = result.applied.created + result.applied.updated + result.applied.deleted;
			toast.success(
				`Applied ${totalApplied} change(s) to ${instanceLabel} (${result.applied.created} created, ${result.applied.updated} updated, ${result.applied.deleted} deleted)`
			);
			setShowPreview(false);
		} catch (error) {
			toast.error(
				error instanceof Error ? error.message : "Failed to apply changes"
			);
		}
	};

	if (isLoading) {
		return (
			<div className="flex items-center justify-center py-12">
				<div className="text-fg-muted">Loading template overlay...</div>
			</div>
		);
	}

	return (
		<div className="space-y-6">
			{/* Header */}
			<Card>
				<CardHeader>
					<CardTitle>Template Overlay: {instanceLabel}</CardTitle>
					<CardDescription>
						Configure which TRaSH templates to include, which CFs to exclude, and per-CF overrides
					</CardDescription>
				</CardHeader>
				<CardContent className="space-y-4">
					<div className="flex gap-3 flex-wrap">
						<Button
							onClick={handleSave}
							disabled={updateOverlayMutation.isPending}
						>
							{updateOverlayMutation.isPending ? "Saving..." : "Save Configuration"}
						</Button>
						<Button
							variant="secondary"
							onClick={handlePreview}
							disabled={previewMutation.isPending}
						>
							{previewMutation.isPending ? "Loading Preview..." : "Preview Changes"}
						</Button>
						<Button
							variant="ghost"
							onClick={handleMigrateFromArrSync}
							disabled={isMigrating}
							className="ml-auto"
						>
							{isMigrating ? "Migrating..." : "Migrate from ARR Sync"}
						</Button>
					</div>

					{overlayData?.lastAppliedAt && (
						<div className="text-sm text-fg-muted">
							Last applied: {new Date(overlayData.lastAppliedAt).toLocaleString()}
						</div>
					)}
				</CardContent>
			</Card>

			{/* Includes Section */}
			<Card>
				<CardHeader>
					<CardTitle>Include Templates</CardTitle>
					<CardDescription>
						Select TRaSH template IDs to include (e.g., &quot;trash-anime-template&quot;, &quot;trash-video-codecs&quot;)
					</CardDescription>
				</CardHeader>
				<CardContent className="space-y-4">
					{/* Add new include */}
					<div className="flex gap-2">
						<Input
							type="text"
							placeholder="Enter template ID..."
							value={newInclude}
							onChange={(e) => setNewInclude(e.target.value)}
							onKeyDown={(e) => {
								if (e.key === "Enter") {
									handleAddInclude();
								}
							}}
							className="flex-1"
						/>
						<Button onClick={handleAddInclude}>Add</Button>
					</div>

					{/* List of includes */}
					{includes.length > 0 ? (
						<div className="flex flex-wrap gap-2">
							{includes.map((templateId) => (
								<Badge
									key={templateId}
									variant="default"
									className="flex items-center gap-2 px-3 py-1.5"
								>
									<span>{templateId}</span>
									<button
										type="button"
										onClick={() => handleRemoveInclude(templateId)}
										className="text-fg-muted hover:text-danger transition-colors"
										title="Remove"
									>
										×
									</button>
								</Badge>
							))}
						</div>
					) : (
						<div className="text-sm text-fg-muted">
							No templates included. Add template IDs above.
						</div>
					)}
				</CardContent>
			</Card>

			{/* Excludes Section */}
			<Card>
				<CardHeader>
					<CardTitle>Exclude Custom Formats</CardTitle>
					<CardDescription>
						Exclude specific CFs by trash_id, local ID, or name
					</CardDescription>
				</CardHeader>
				<CardContent className="space-y-4">
					{/* Add new exclude */}
					<div className="flex gap-2">
						<Input
							type="text"
							placeholder="Enter trash_id, ID, or name..."
							value={newExclude}
							onChange={(e) => setNewExclude(e.target.value)}
							onKeyDown={(e) => {
								if (e.key === "Enter") {
									handleAddExclude();
								}
							}}
							className="flex-1"
						/>
						<Button onClick={handleAddExclude}>Add</Button>
					</div>

					{/* List of excludes */}
					{excludes.length > 0 ? (
						<div className="flex flex-wrap gap-2">
							{excludes.map((cfId) => (
								<Badge
									key={cfId}
									variant="warning"
									className="flex items-center gap-2 px-3 py-1.5"
								>
									<span>{cfId}</span>
									<button
										type="button"
										onClick={() => handleRemoveExclude(cfId)}
										className="text-fg-muted hover:text-danger transition-colors"
										title="Remove"
									>
										×
									</button>
								</Badge>
							))}
						</div>
					) : (
						<div className="text-sm text-fg-muted">
							No CFs excluded. Add IDs above to skip specific formats.
						</div>
					)}
				</CardContent>
			</Card>

			{/* Overrides Section */}
			<Card>
				<CardHeader>
					<CardTitle>Per-CF Overrides</CardTitle>
					<CardDescription>
						Customize individual custom formats (name, score, tags, spec fields)
					</CardDescription>
				</CardHeader>
				<CardContent className="space-y-4">
					<Button onClick={() => handleOpenOverrideEditor()}>
						Add Override
					</Button>

					{/* List of overrides */}
					{Object.keys(overrides).length > 0 ? (
						<div className="space-y-2">
							{Object.entries(overrides).map(([cfId, override]) => (
								<div
									key={cfId}
									className="flex items-start justify-between p-3 rounded-lg border border-border bg-bg-subtle/30"
								>
									<div className="space-y-1">
										<div className="font-medium text-sm">{cfId}</div>
										<div className="text-xs text-fg-muted space-y-1">
											{override.name && <div>Name: {override.name}</div>}
											{override.score !== undefined && <div>Score: {override.score}</div>}
											{override.tags && <div>Tags: {override.tags.join(", ")}</div>}
											{override.spec && <div>Spec overrides: {Object.keys(override.spec).length} field(s)</div>}
											{override.qualityProfileLinks && (
												<div>Quality profile links: {override.qualityProfileLinks.length}</div>
											)}
										</div>
									</div>
									<div className="flex gap-1">
										<Button
											size="sm"
											variant="ghost"
											onClick={() => handleOpenOverrideEditor(cfId)}
										>
											Edit
										</Button>
										<Button
											size="sm"
											variant="ghost"
											onClick={() => handleRemoveOverride(cfId)}
										>
											Remove
										</Button>
									</div>
								</div>
							))}
						</div>
					) : (
						<div className="text-sm text-fg-muted">
							No overrides configured. Click &quot;Add Override&quot; to customize a CF.
						</div>
					)}
				</CardContent>
			</Card>

			{/* Override Editor Modal */}
			{showOverrideEditor && (
				<div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50">
					<div className="bg-bg rounded-lg shadow-lg w-full max-w-2xl max-h-[90vh] overflow-y-auto">
						<div className="p-6 space-y-4">
							<h3 className="text-lg font-semibold text-fg">
								{editingOverrideId ? `Edit Override: ${editingOverrideId}` : "Add Override"}
							</h3>

							{/* CF ID */}
							<div className="space-y-2">
								<label className="text-sm font-medium text-fg">
									CF Identifier (trash_id, name, or id:{"{"}id{"}"})
								</label>
								<Input
									type="text"
									value={editingOverrideId}
									onChange={(e) => setEditingOverrideId(e.target.value)}
									placeholder="e.g., trash-anime, x265, id:42"
									disabled={!!overrides[editingOverrideId]}
								/>
							</div>

							{/* Name Override */}
							<div className="space-y-2">
								<label className="text-sm font-medium text-fg">Name</label>
								<Input
									type="text"
									value={overrideForm.name || ""}
									onChange={(e) => setOverrideForm({ ...overrideForm, name: e.target.value || undefined })}
									placeholder="Custom name..."
								/>
							</div>

							{/* Score Override */}
							<div className="space-y-2">
								<label className="text-sm font-medium text-fg">Score</label>
								<Input
									type="number"
									value={overrideForm.score ?? ""}
									onChange={(e) => {
										const value = e.target.value === "" ? undefined : Number(e.target.value);
										setOverrideForm({ ...overrideForm, score: value });
									}}
									placeholder="Score..."
								/>
							</div>

							{/* Tags Override */}
							<div className="space-y-2">
								<label className="text-sm font-medium text-fg">Tags (comma-separated)</label>
								<Input
									type="text"
									value={overrideForm.tags?.join(", ") || ""}
									onChange={(e) => {
										const tags = e.target.value ? e.target.value.split(",").map(t => t.trim()).filter(Boolean) : undefined;
										setOverrideForm({ ...overrideForm, tags });
									}}
									placeholder="tag1, tag2, tag3"
								/>
							</div>

							{/* Spec Override (Advanced - JSON) */}
							<div className="space-y-2">
								<label className="text-sm font-medium text-fg">
									Spec Overrides (JSON)
								</label>
								<textarea
									value={overrideForm.spec ? JSON.stringify(overrideForm.spec, null, 2) : ""}
									onChange={(e) => {
										try {
											const spec = e.target.value ? JSON.parse(e.target.value) : undefined;
											setOverrideForm({ ...overrideForm, spec });
										} catch {
											// Invalid JSON, ignore
										}
									}}
									placeholder='{"value": "x265|HEVC", "negate": false}'
									className="w-full min-h-[100px] p-3 rounded-lg border border-border bg-bg font-mono text-sm"
								/>
								<p className="text-xs text-fg-muted">
									Deep merge with existing spec fields. Example: {`{"value": "x265|HEVC"}`}
								</p>
							</div>

							{/* Actions */}
							<div className="flex gap-2 justify-end pt-4 border-t border-border">
								<Button
									variant="ghost"
									onClick={() => {
										setShowOverrideEditor(false);
										setEditingOverrideId("");
										setOverrideForm({});
									}}
								>
									Cancel
								</Button>
								<Button onClick={handleSaveOverride}>Save Override</Button>
							</div>
						</div>
					</div>
				</div>
			)}

			{/* Migration Report Modal */}
			{showMigrationReport && migrationReport && (
				<div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50">
					<div className="bg-bg rounded-lg shadow-lg w-full max-w-2xl max-h-[90vh] overflow-y-auto">
						<div className="p-6 space-y-4">
							<div className="flex items-start justify-between">
								<div>
									<h3 className="text-lg font-semibold text-fg">Migration Complete</h3>
									<p className="text-sm text-fg-muted mt-1">
										{migrationReport.message}
									</p>
								</div>
								<button
									type="button"
									onClick={() => setShowMigrationReport(false)}
									className="text-fg-muted hover:text-fg transition-colors"
								>
									×
								</button>
							</div>

							{/* Report Details */}
							{migrationReport.report && (
								<div className="space-y-3">
									<div className="font-medium text-sm text-fg">
										{migrationReport.report.summary}
									</div>

									{migrationReport.report.details && migrationReport.report.details.length > 0 && (
										<div className="space-y-1">
											{migrationReport.report.details.map((detail: string, i: number) => (
												<div key={i} className="text-sm text-fg-muted font-mono">
													{detail}
												</div>
											))}
										</div>
									)}

									{migrationReport.report.warnings && migrationReport.report.warnings.length > 0 && (
										<div className="p-3 rounded-lg bg-warning/10 border border-warning/20">
											<div className="text-sm font-medium text-warning mb-2">Warnings:</div>
											<ul className="text-xs text-fg-muted space-y-1">
												{migrationReport.report.warnings.map((warning: string, i: number) => (
													<li key={i}>{warning}</li>
												))}
											</ul>
										</div>
									)}

									{/* Show migrated overlay */}
									{migrationReport.overlay && (
										<div className="p-3 rounded-lg bg-bg-subtle/30 border border-border">
											<div className="text-sm font-medium text-fg mb-2">Migrated Configuration:</div>
											<div className="text-xs font-mono text-fg-muted space-y-1">
												<div>Includes: {migrationReport.overlay.includes?.length || 0}</div>
												<div>Excludes: {migrationReport.overlay.excludes?.length || 0}</div>
												<div>Overrides: {Object.keys(migrationReport.overlay.overrides || {}).length}</div>
											</div>
										</div>
									)}
								</div>
							)}

							{/* Actions */}
							<div className="flex gap-2 justify-end pt-4 border-t border-border">
								<Button
									onClick={() => {
										setShowMigrationReport(false);
										// Trigger a reload of the overlay data
										window.location.reload();
									}}
								>
									Reload Page
								</Button>
							</div>
						</div>
					</div>
				</div>
			)}

			{/* Preview Modal */}
			{showPreview && previewData && (
				<div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50">
					<div className="bg-bg rounded-lg shadow-lg w-full max-w-4xl max-h-[90vh] overflow-y-auto">
						<div className="p-6 space-y-4">
							<div className="flex items-start justify-between">
								<div>
									<h3 className="text-lg font-semibold text-fg">Preview Changes</h3>
									<p className="text-sm text-fg-muted mt-1">
										Review changes before applying to {instanceLabel}
									</p>
								</div>
								<button
									type="button"
									onClick={() => setShowPreview(false)}
									className="text-fg-muted hover:text-fg transition-colors"
								>
									×
								</button>
							</div>

							{/* Summary */}
							<div className="flex gap-4 text-sm">
								<Badge variant="success" className="px-3 py-1.5">
									{previewData.changes?.filter((c: any) => c.changeType === "added").length || 0} Added
								</Badge>
								<Badge variant="info" className="px-3 py-1.5">
									{previewData.changes?.filter((c: any) => c.changeType === "modified").length || 0} Modified
								</Badge>
								<Badge variant="danger" className="px-3 py-1.5">
									{previewData.changes?.filter((c: any) => c.changeType === "removed").length || 0} Removed
								</Badge>
								<Badge variant="default" className="px-3 py-1.5">
									{previewData.changes?.filter((c: any) => c.changeType === "unchanged").length || 0} Unchanged
								</Badge>
							</div>

							{/* Warnings */}
							{previewData.warnings && previewData.warnings.length > 0 && (
								<div className="p-3 rounded-lg bg-warning/10 border border-warning/20">
									<div className="text-sm font-medium text-warning mb-2">Warnings:</div>
									<ul className="text-xs text-fg-muted space-y-1">
										{previewData.warnings.map((warning: string, i: number) => (
											<li key={i}>• {warning}</li>
										))}
									</ul>
								</div>
							)}

							{/* Changes List */}
							<div className="space-y-2 max-h-96 overflow-y-auto">
								{previewData.changes?.map((change: any, i: number) => (
									<div
										key={i}
										className={`p-3 rounded-lg border ${
											change.changeType === "added"
												? "bg-success/5 border-success/20"
												: change.changeType === "modified"
													? "bg-info/5 border-info/20"
													: change.changeType === "removed"
														? "bg-danger/5 border-danger/20"
														: "bg-bg-subtle/30 border-border"
										}`}
									>
										<div className="flex items-start gap-3">
											<Badge
												variant={
													change.changeType === "added"
														? "success"
														: change.changeType === "modified"
															? "info"
															: change.changeType === "removed"
																? "danger"
																: "default"
												}
												className="text-xs"
											>
												{change.changeType}
											</Badge>
											<div className="flex-1 min-w-0">
												<div className="font-medium text-sm text-fg">{change.name}</div>
												{change.changes && change.changes.length > 0 && (
													<ul className="text-xs text-fg-muted mt-1 space-y-0.5">
														{change.changes.map((desc: string, j: number) => (
															<li key={j}>• {desc}</li>
														))}
													</ul>
												)}
											</div>
										</div>
									</div>
								))}
							</div>

							{/* Actions */}
							<div className="flex gap-2 justify-end pt-4 border-t border-border">
								<Button
									variant="ghost"
									onClick={() => setShowPreview(false)}
								>
									Close
								</Button>
								<Button
									onClick={handleApply}
									disabled={applyMutation.isPending}
								>
									{applyMutation.isPending ? "Applying..." : "Apply to ARR Instance"}
								</Button>
							</div>
						</div>
					</div>
				</div>
			)}
		</div>
	);
}
