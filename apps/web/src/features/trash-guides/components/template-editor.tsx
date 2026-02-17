"use client";

import { useState, useEffect } from "react";
import type { TrashTemplate, TemplateConfig, TrashCustomFormat, TrashCustomFormatGroup, CustomQualityConfig } from "@arr/shared";
import { QualityGroupEditor } from "./quality-group-editor";
import { useCreateTemplate, useUpdateTemplate } from "../../../hooks/api/useTemplates";
import { useTrashCacheEntries } from "../../../hooks/api/useTrashCache";
import { Alert, AlertDescription, Input, Button } from "../../../components/ui";
import { X, Save, Minus, Settings, AlertTriangle, Trash2, Shield, Gauge, Sliders } from "lucide-react";
import { toast } from "sonner";
import { ConditionEditor } from "./condition-editor";
import { InstanceOverridesPanel } from "./instance-overrides-panel";
import { useServicesQuery } from "../../../hooks/api/useServicesQuery";
import { getEffectiveQualityConfig } from "../lib/quality-config-utils";
import { getErrorMessage } from "../../../lib/error-utils";

/** Specification type from TrashCustomFormat with enabled flag for UI */
type SpecificationWithEnabled = TrashCustomFormat["specifications"][number] & { enabled: boolean };

interface TemplateEditorProps {
	open: boolean;
	onClose: () => void;
	template?: TrashTemplate;
}

export const TemplateEditor = ({ open, onClose, template }: TemplateEditorProps) => {
	const [name, setName] = useState("");
	const [description, setDescription] = useState("");
	const [serviceType, setServiceType] = useState<"RADARR" | "SONARR">("RADARR");
	const [selectedFormats, setSelectedFormats] = useState<Map<string, {
		scoreOverride?: number;
		conditionsEnabled: Record<string, boolean>;
	}>>(new Map());
	const [selectedGroups, setSelectedGroups] = useState<Set<string>>(new Set());
	const [conditionEditorFormat, setConditionEditorFormat] = useState<{
		trashId: string;
		format: TrashCustomFormat;
	} | null>(null);
	// Sync settings
	const [deleteRemovedCFs, setDeleteRemovedCFs] = useState(false);
	// Quality configuration
	const [customQualityConfig, setCustomQualityConfig] = useState<CustomQualityConfig>({
		useCustomQualities: false,
		items: [],
	});

	const createMutation = useCreateTemplate();
	const updateMutation = useUpdateTemplate();
	const { data: cacheEntries } = useTrashCacheEntries(serviceType);
	const { data: servicesData } = useServicesQuery();

	// Initialize form when template changes
	useEffect(() => {
		if (template) {
			setName(template.name);
			setDescription(template.description || "");
			setServiceType(template.serviceType);

			// Convert config to form state
			const formatsMap = new Map();
			for (const cf of template.config.customFormats) {
				formatsMap.set(cf.trashId, {
					scoreOverride: cf.scoreOverride,
					conditionsEnabled: cf.conditionsEnabled,
				});
			}
			setSelectedFormats(formatsMap);

			const groupsSet = new Set<string>();
			for (const group of template.config.customFormatGroups) {
				if (group.enabled) {
					groupsSet.add(group.trashId);
				}
			}
			setSelectedGroups(groupsSet);

			// Initialize sync settings
			setDeleteRemovedCFs(template.config.syncSettings?.deleteRemovedCFs ?? false);

			// Initialize quality configuration - use effective config from template
			// (considers both customQualityConfig and qualityProfile)
			setCustomQualityConfig(getEffectiveQualityConfig(template.config) ?? {
				useCustomQualities: false,
				items: [],
			});
		} else {
			// Reset for new template
			setName("");
			setDescription("");
			setServiceType("RADARR");
			setSelectedFormats(new Map());
			setSelectedGroups(new Set());
			setDeleteRemovedCFs(false);
			setCustomQualityConfig({
				useCustomQualities: false,
				items: [],
			});
		}
	}, [template]);

	if (!open) return null;

	const handleSave = async () => {
		if (!name.trim()) return;

		// Get cache entries for the selected service type
		const customFormatsCache = cacheEntries?.find(e => e.configType === "CUSTOM_FORMATS");
		const groupsCache = cacheEntries?.find(e => e.configType === "CF_GROUPS");

		// Build lookup maps from existing template data
		// These are used for EXISTING items - we preserve their stored data and only apply user's changes
		const existingCfMap = new Map<string, TemplateConfig['customFormats'][number]>();
		const existingGroupMap = new Map<string, TemplateConfig['customFormatGroups'][number]>();
		if (template) {
			for (const cf of template.config.customFormats) {
				existingCfMap.set(cf.trashId, cf);
			}
			for (const group of template.config.customFormatGroups) {
				existingGroupMap.set(group.trashId, group);
			}
		}

		// Build config using patch-based approach:
		// - Spread existing config to preserve qualityProfile, completeQualityProfile,
		//   qualitySize, naming, and other fields not edited here
		// - Existing items: Use template's stored data, apply user's changed settings only
		// - New items: Look up from cache (normal behavior)
		const config: TemplateConfig = {
			...(template?.config ?? {}),
			customFormats: [],
			customFormatGroups: [],
			syncSettings: {
				deleteRemovedCFs,
			},
			// Explicitly set: when disabled, override the base spread's value
			// with undefined so it doesn't resurrect a stale customQualityConfig
			customQualityConfig: customQualityConfig.useCustomQualities
				? customQualityConfig
				: undefined,
		};

		// Track items that couldn't be resolved (new items not in cache)
		const unresolvedNewCfs: string[] = [];
		const unresolvedNewGroups: string[] = [];

		// Process selected custom formats
		const formats = (customFormatsCache?.data as TrashCustomFormat[] | undefined) ?? [];
		for (const [trashId, settings] of selectedFormats.entries()) {
			const existingCf = existingCfMap.get(trashId);

			if (existingCf) {
				// EXISTING CF: Use template's stored data, only apply user's changed settings
				// This ensures editing a score/condition never causes data loss from cache issues
				config.customFormats.push({
					trashId,
					name: existingCf.name,
					scoreOverride: settings.scoreOverride,
					conditionsEnabled: settings.conditionsEnabled,
					originalConfig: existingCf.originalConfig,
					// Preserve origin and deprecation tracking
					origin: existingCf.origin,
					addedAt: existingCf.addedAt,
					deprecated: existingCf.deprecated,
					deprecatedAt: existingCf.deprecatedAt,
					deprecatedReason: existingCf.deprecatedReason,
				});
			} else {
				// NEW CF: Look up from cache (this is what cache is for - discovering new items)
				const cacheFormat = formats.find(f => f.trash_id === trashId);
				if (cacheFormat) {
					config.customFormats.push({
						trashId,
						name: cacheFormat.name,
						scoreOverride: settings.scoreOverride,
						conditionsEnabled: settings.conditionsEnabled,
						originalConfig: cacheFormat,
						// New CFs added via editor are user_added
						origin: "user_added",
						addedAt: new Date().toISOString(),
					});
				} else {
					// New CF not in cache - shouldn't happen normally but track it
					unresolvedNewCfs.push(trashId);
				}
			}
		}

		// Process selected custom format groups
		const groups = (groupsCache?.data as TrashCustomFormatGroup[] | undefined) ?? [];
		for (const trashId of selectedGroups) {
			const existingGroup = existingGroupMap.get(trashId);

			if (existingGroup) {
				// EXISTING GROUP: Use template's stored data
				config.customFormatGroups.push({
					trashId,
					name: existingGroup.name,
					enabled: true,
					originalConfig: existingGroup.originalConfig,
					// Preserve origin and deprecation tracking
					origin: existingGroup.origin,
					addedAt: existingGroup.addedAt,
					deprecated: existingGroup.deprecated,
					deprecatedAt: existingGroup.deprecatedAt,
					deprecatedReason: existingGroup.deprecatedReason,
				});
			} else {
				// NEW GROUP: Look up from cache
				const cacheGroup = groups.find(g => g.trash_id === trashId);
				if (cacheGroup) {
					config.customFormatGroups.push({
						trashId,
						name: cacheGroup.name,
						enabled: true,
						originalConfig: cacheGroup,
						// New groups added via editor are user_added
						origin: "user_added",
						addedAt: new Date().toISOString(),
					});
				} else {
					unresolvedNewGroups.push(trashId);
				}
			}
		}

		try {
			if (template) {
				await updateMutation.mutateAsync({
					templateId: template.id,
					payload: { name, description, config },
				});
			} else {
				await createMutation.mutateAsync({ name, description, serviceType, config });
			}

			// Show warning only if we couldn't resolve NEW items (shouldn't normally happen)
			const totalUnresolved = unresolvedNewCfs.length + unresolvedNewGroups.length;
			if (totalUnresolved > 0) {
				toast.warning("Some new items could not be added", {
					description: `${totalUnresolved} newly selected item(s) were not found in cache. Try refreshing the cache.`,
					duration: 8000,
				});
			}
			onClose();
		} catch {
			// Error displayed via mutation state
		}
	};

	const handleToggleFormat = (trashId: string, format: TrashCustomFormat) => {
		const newMap = new Map(selectedFormats);
		if (newMap.has(trashId)) {
			newMap.delete(trashId);
		} else {
			// Initialize with all conditions enabled
			const conditionsEnabled: Record<string, boolean> = {};
			for (const spec of format.specifications) {
				conditionsEnabled[spec.name] = true;
			}
			newMap.set(trashId, { conditionsEnabled });
		}
		setSelectedFormats(newMap);
	};

	const handleScoreChange = (trashId: string, score: number | undefined) => {
		const newMap = new Map(selectedFormats);
		const current = newMap.get(trashId);
		if (current) {
			newMap.set(trashId, { ...current, scoreOverride: score });
			setSelectedFormats(newMap);
		}
	};

	const handleToggleCondition = (trashId: string, conditionName: string) => {
		const newMap = new Map(selectedFormats);
		const current = newMap.get(trashId);
		if (current) {
			newMap.set(trashId, {
				...current,
				conditionsEnabled: {
					...current.conditionsEnabled,
					[conditionName]: !current.conditionsEnabled[conditionName],
				},
			});
			setSelectedFormats(newMap);
		}
	};

	const handleToggleGroup = (trashId: string) => {
		const newSet = new Set(selectedGroups);
		if (newSet.has(trashId)) {
			newSet.delete(trashId);
		} else {
			newSet.add(trashId);
		}
		setSelectedGroups(newSet);
	};

	const customFormatsCache = cacheEntries?.find(e => e.configType === "CUSTOM_FORMATS");
	const groupsCache = cacheEntries?.find(e => e.configType === "CF_GROUPS");
	const availableFormats = (customFormatsCache?.data as TrashCustomFormat[]) || [];
	const availableGroups = (groupsCache?.data as TrashCustomFormatGroup[]) || [];

	// Find deprecated CFs (in template but not in cache)
	const availableFormatIds = new Set(availableFormats.map(f => f.trash_id));
	const deprecatedCFs = template?.config.customFormats.filter(
		cf => cf.deprecated || !availableFormatIds.has(cf.trashId)
	) || [];

	// Find deprecated CF groups
	const availableGroupIds = new Set(availableGroups.map(g => g.trash_id));
	const _deprecatedGroups = template?.config.customFormatGroups.filter(
		g => g.deprecated || !availableGroupIds.has(g.trashId)
	) || [];

	const mutation = template ? updateMutation : createMutation;

	return (
		<div
			className="fixed inset-0 z-modal flex items-center justify-center bg-black/50 backdrop-blur-xs"
			role="dialog"
			aria-modal="true"
			aria-labelledby="template-editor-title"
		>
			<div className="relative w-full max-w-4xl max-h-[90vh] overflow-y-auto rounded-xl border border-border bg-card p-6">
				{/* Header */}
				<div className="mb-6 flex items-center justify-between border-b border-border pb-4">
					<h2 id="template-editor-title" className="text-2xl font-semibold text-foreground">
						{template ? "Edit Template" : "Create Template"}
					</h2>
					<Button
						variant="ghost"
						size="sm"
						onClick={onClose}
						aria-label="Close editor"
					>
						<X className="h-5 w-5" />
					</Button>
				</div>

				{/* Error Alert */}
				{mutation.isError && (
					<Alert variant="danger" className="mb-4">
						<AlertDescription>
							{getErrorMessage(mutation.error, "Failed to save template")}
						</AlertDescription>
					</Alert>
				)}

				<div className="space-y-6">
					{/* Basic Info */}
					<div className="space-y-4">
						<div>
							<label className="mb-2 block text-sm font-medium text-foreground">Template Name</label>
							<Input
								type="text"
								value={name}
								onChange={(e) => setName(e.target.value)}
								placeholder="My Custom Template"
								className="w-full"
							/>
						</div>

						<div>
							<label className="mb-2 block text-sm font-medium text-foreground">Description (Optional)</label>
							<textarea
								value={description}
								onChange={(e) => setDescription(e.target.value)}
								placeholder="Describe what this template is for..."
								rows={3}
								className="w-full rounded-xl border border-border bg-card px-4 py-3 text-sm text-foreground placeholder:text-muted-foreground/60 transition-all duration-200 hover:border-border/80 hover:bg-card/80 focus:border-primary focus:outline-hidden focus:ring-2 focus:ring-primary/20 focus:bg-card/80"
							/>
						</div>

						{!template && (
							<div>
								<label className="mb-2 block text-sm font-medium text-foreground">Service Type</label>
								<div className="flex gap-4">
									<Button
										variant={serviceType === "RADARR" ? "primary" : "secondary"}
										onClick={() => setServiceType("RADARR")}
										className="flex-1"
									>
										Radarr
									</Button>
									<Button
										variant={serviceType === "SONARR" ? "primary" : "secondary"}
										onClick={() => setServiceType("SONARR")}
										className="flex-1"
									>
										Sonarr
									</Button>
								</div>
							</div>
						)}
					</div>

					{/* Sync Settings */}
					<div className="space-y-3">
						<div className="flex items-center gap-2">
							<Settings className="h-5 w-5 text-muted-foreground" />
							<h3 className="text-lg font-medium text-foreground">Sync Settings</h3>
						</div>
						<div className="rounded-xl border border-border bg-card/50 p-4 space-y-4">
							<div className="flex items-start gap-3">
								<input
									type="checkbox"
									id="deleteRemovedCFs"
									checked={deleteRemovedCFs}
									onChange={(e) => setDeleteRemovedCFs(e.target.checked)}
									className="mt-1 h-4 w-4 rounded border-border bg-card text-primary focus:ring-primary"
								/>
								<div className="flex-1">
									<label htmlFor="deleteRemovedCFs" className="flex items-center gap-2 text-sm font-medium text-foreground cursor-pointer">
										<Trash2 className="h-4 w-4 text-red-500" />
										Delete removed Custom Formats during sync
									</label>
									<p className="mt-1 text-xs text-muted-foreground">
										When TRaSH Guides removes a Custom Format, delete it from this template instead of marking it as deprecated.
									</p>
								</div>
							</div>
							<div className="flex items-start gap-2 rounded-lg border border-blue-500/20 bg-blue-500/5 p-3">
								<Shield className="h-4 w-4 text-blue-400 mt-0.5 shrink-0" />
								<div className="text-xs text-muted-foreground">
									<span className="font-medium text-blue-400">Note:</span> Custom Formats you manually add (marked as &ldquo;User Added&rdquo;) are always preserved regardless of this setting.
								</div>
							</div>
						</div>
					</div>

					{/* Quality Configuration (Power User Feature) */}
					<div className="space-y-3">
						<div className="flex items-center gap-2">
							<Gauge className="h-5 w-5 text-muted-foreground" />
							<h3 className="text-lg font-medium text-foreground">Quality Configuration</h3>
							<span className="rounded bg-amber-500/20 px-2 py-0.5 text-xs text-amber-400">
								Advanced
							</span>
						</div>
						<QualityGroupEditor
							config={customQualityConfig}
							onChange={setCustomQualityConfig}
							showToggle={true}
						/>
					</div>

					{/* Instance Quality Overrides - Only show for existing templates with custom quality config */}
					{template && customQualityConfig.useCustomQualities && servicesData && (
						<div className="space-y-3">
							<div className="flex items-center gap-2">
								<Sliders className="h-5 w-5 text-purple-500" />
								<h3 className="text-lg font-medium text-foreground">Per-Instance Quality Overrides</h3>
								<span className="rounded bg-purple-500/20 px-2 py-0.5 text-xs text-purple-400">
									Optional
								</span>
							</div>
							<InstanceOverridesPanel
								template={template}
								instances={servicesData.map(s => ({
									id: s.id,
									label: s.label,
									service: s.service,
								}))}
							/>
						</div>
					)}

					{/* Custom Formats */}
					<div className="space-y-3">
						<h3 className="text-lg font-medium text-foreground">Custom Formats</h3>
						{availableFormats.length === 0 ? (
							<p className="text-sm text-muted-foreground">No custom formats available in cache. Refresh cache first.</p>
						) : (
							<div className="space-y-2 max-h-64 overflow-y-auto rounded border border-border bg-card/50 p-4">
								{availableFormats.map((format) => {
									const isSelected = selectedFormats.has(format.trash_id);
									const settings = selectedFormats.get(format.trash_id);

									return (
										<div key={format.trash_id} className="space-y-2 rounded border border-border bg-card/50 p-3">
											<div className="flex items-center justify-between">
												<label className="flex items-center gap-2">
													<input
														type="checkbox"
														checked={isSelected}
														onChange={() => handleToggleFormat(format.trash_id, format)}
														className="h-4 w-4 rounded border-border bg-card text-primary focus:ring-primary"
													/>
													<span className="text-sm font-medium text-foreground">{format.name}</span>
												</label>
												{isSelected && (
													<div className="flex items-center gap-2">
														<Button
															variant="secondary"
															size="sm"
															onClick={() => {
																setConditionEditorFormat({ trashId: format.trash_id, format });
															}}
															title="Advanced condition editing"
															className="gap-1"
														>
															<Settings className="h-3 w-3" />
															Advanced
														</Button>
														<label className="text-xs text-muted-foreground">Score:</label>
														<input
															type="number"
															value={settings?.scoreOverride ?? ""}
															onChange={(e) => handleScoreChange(format.trash_id, e.target.value ? Number(e.target.value) : undefined)}
															placeholder="Default"
															className="w-20 rounded border border-border bg-card px-2 py-1 text-xs text-foreground"
														/>
														<Button
															variant="danger"
															size="sm"
															onClick={() => handleToggleFormat(format.trash_id, format)}
															title="Remove this custom format"
															className="gap-1"
														>
															<Minus className="h-3 w-3" />
															Remove
														</Button>
													</div>
												)}
											</div>
											{isSelected && format.specifications.length > 0 && (
												<div className="ml-6 space-y-1">
													<p className="text-xs font-medium text-muted-foreground">Conditions:</p>
													{format.specifications.map((spec) => (
														<label key={spec.name} className="flex items-center gap-2">
															<input
																type="checkbox"
																checked={settings?.conditionsEnabled[spec.name] !== false}
																onChange={() => handleToggleCondition(format.trash_id, spec.name)}
																className="h-3 w-3 rounded border-border bg-card text-primary focus:ring-primary"
															/>
															<span className="text-xs text-muted-foreground">{spec.name}</span>
														</label>
													))}
												</div>
											)}
										</div>
									);
								})}
							</div>
						)}
					</div>

					{/* Deprecated Custom Formats Warning */}
					{deprecatedCFs.length > 0 && (
						<div className="space-y-3">
							<div className="flex items-center gap-2">
								<AlertTriangle className="h-5 w-5 text-amber-500" />
								<h3 className="text-lg font-medium text-amber-500">
									Deprecated Custom Formats ({deprecatedCFs.length})
								</h3>
							</div>
							<p className="text-sm text-muted-foreground">
								These custom formats are no longer available in TRaSH Guides. They will be preserved
								in your template but may not work correctly. Consider removing them.
							</p>
							<div className="space-y-2 max-h-48 overflow-y-auto rounded border border-amber-500/30 bg-amber-500/5 p-4">
								{deprecatedCFs.map((cf) => (
									<div key={cf.trashId} className="flex items-center justify-between rounded border border-border bg-card/50 p-3">
										<div className="flex items-center gap-2">
											<input
												type="checkbox"
												checked={selectedFormats.has(cf.trashId)}
												onChange={() => {
													const newMap = new Map(selectedFormats);
													if (newMap.has(cf.trashId)) {
														newMap.delete(cf.trashId);
													} else {
														newMap.set(cf.trashId, {
															scoreOverride: cf.scoreOverride,
															conditionsEnabled: cf.conditionsEnabled,
														});
													}
													setSelectedFormats(newMap);
												}}
												className="h-4 w-4 rounded border-border bg-card text-primary focus:ring-primary"
											/>
											<span className="text-sm font-medium text-foreground opacity-70">{cf.name}</span>
											<span className="rounded bg-amber-500/20 px-1.5 py-0.5 text-xs text-amber-500">
												Deprecated
											</span>
											{cf.origin === "user_added" && (
												<span className="rounded bg-blue-500/20 px-1.5 py-0.5 text-xs text-blue-400">
													User Added
												</span>
											)}
										</div>
										{cf.deprecatedReason && (
											<span className="text-xs text-muted-foreground">{cf.deprecatedReason}</span>
										)}
									</div>
								))}
							</div>
						</div>
					)}

					{/* Custom Format Groups */}
					<div className="space-y-3">
						<h3 className="text-lg font-medium text-foreground">Custom Format Groups</h3>
						{availableGroups.length === 0 ? (
							<p className="text-sm text-muted-foreground">No CF groups available in cache.</p>
						) : (
							<div className="space-y-2 max-h-48 overflow-y-auto rounded border border-border bg-card/50 p-4">
								{availableGroups.map((group) => (
									<label key={group.trash_id} className="flex items-center gap-2">
										<input
											type="checkbox"
											checked={selectedGroups.has(group.trash_id)}
											onChange={() => handleToggleGroup(group.trash_id)}
											className="h-4 w-4 rounded border-border bg-card text-primary focus:ring-primary"
										/>
										<span className="text-sm text-foreground">{group.name}</span>
										<span className="text-xs text-muted-foreground">({group.custom_formats.length} formats)</span>
									</label>
								))}
							</div>
						)}
					</div>

					{/* Actions */}
					<div className="flex justify-end gap-2 border-t border-border pt-4">
						<Button variant="secondary" onClick={onClose}>
							Cancel
						</Button>
						<Button
							variant="primary"
							onClick={handleSave}
							disabled={!name.trim() || mutation.isPending}
							className="gap-2"
						>
							<Save className="h-4 w-4" />
							{mutation.isPending ? "Saving..." : template ? "Update Template" : "Create Template"}
						</Button>
					</div>
				</div>

				{/* Condition Editor Modal */}
				{conditionEditorFormat && (() => {
					const settings = selectedFormats.get(conditionEditorFormat.trashId);
					const specificationsWithEnabled: SpecificationWithEnabled[] = conditionEditorFormat.format.specifications.map((spec) => ({
						...spec,
						enabled: settings?.conditionsEnabled[spec.name] !== false,
					}));

					return (
						<div
							className="fixed inset-0 z-popover flex items-center justify-center bg-black/80 backdrop-blur-xs"
							role="dialog"
							aria-modal="true"
							aria-label="Condition Editor"
						>
							<div className="relative w-full max-w-4xl max-h-[90vh] overflow-y-auto rounded-xl border border-border bg-card p-6">
								{/* Close button */}
								<Button
									variant="ghost"
									size="sm"
									onClick={() => setConditionEditorFormat(null)}
									aria-label="Close condition editor"
									className="absolute top-4 right-4"
								>
									<X className="h-5 w-5" />
								</Button>

								<ConditionEditor
									customFormatId={conditionEditorFormat.trashId}
									customFormatName={conditionEditorFormat.format.name}
									specifications={specificationsWithEnabled}
									onChange={(updatedSpecs) => {
										const newMap = new Map(selectedFormats);
										const current = newMap.get(conditionEditorFormat.trashId);
										if (current) {
											const conditionsEnabled: Record<string, boolean> = {};
											for (const spec of updatedSpecs) {
												conditionsEnabled[spec.name] = spec.enabled !== false;
											}
											newMap.set(conditionEditorFormat.trashId, {
												...current,
												conditionsEnabled,
											});
											setSelectedFormats(newMap);
										}
										// Don't close modal on every change - let user close explicitly
									}}
								/>
							</div>
						</div>
					);
				})()}
			</div>
		</div>
	);
};

