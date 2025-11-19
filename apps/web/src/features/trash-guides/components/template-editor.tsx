"use client";

import { useState, useEffect } from "react";
import type { TrashTemplate, TemplateConfig, TrashCustomFormat, TrashCustomFormatGroup } from "@arr/shared";
import { useCreateTemplate, useUpdateTemplate } from "../../../hooks/api/useTemplates";
import { useTrashCacheEntries } from "../../../hooks/api/useTrashCache";
import { Alert, AlertDescription } from "../../../components/ui";
import { X, Save, Plus, Minus, Settings } from "lucide-react";
import { SyncStrategyControl } from "./sync-strategy-control";
import { ConditionEditor } from "./condition-editor";

interface TemplateEditorProps {
	open: boolean;
	onClose: () => void;
	template?: TrashTemplate;
}

export const TemplateEditor = ({ open, onClose, template }: TemplateEditorProps) => {
	const [name, setName] = useState("");
	const [description, setDescription] = useState("");
	const [serviceType, setServiceType] = useState<"RADARR" | "SONARR">("RADARR");
	const [syncStrategy, setSyncStrategy] = useState<"auto" | "manual" | "notify">("notify");
	const [selectedFormats, setSelectedFormats] = useState<Map<string, {
		scoreOverride?: number;
		conditionsEnabled: Record<string, boolean>;
	}>>(new Map());
	const [selectedGroups, setSelectedGroups] = useState<Set<string>>(new Set());
	const [conditionEditorFormat, setConditionEditorFormat] = useState<{
		trashId: string;
		format: TrashCustomFormat;
	} | null>(null);

	const createMutation = useCreateTemplate();
	const updateMutation = useUpdateTemplate();
	const { data: cacheEntries } = useTrashCacheEntries(serviceType);

	// Initialize form when template changes
	useEffect(() => {
		if (template) {
			setName(template.name);
			setDescription(template.description || "");
			setServiceType(template.serviceType);
			setSyncStrategy(template.syncStrategy);

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
		} else {
			// Reset for new template
			setName("");
			setDescription("");
			setServiceType("RADARR");
			setSyncStrategy("notify");
			setSelectedFormats(new Map());
			setSelectedGroups(new Set());
		}
	}, [template]);

	if (!open) return null;

	const handleSave = async () => {
		if (!name.trim()) return;

		// Get cache entries for the selected service type
		const customFormatsCache = cacheEntries?.find(e => e.configType === "CUSTOM_FORMATS");
		const groupsCache = cacheEntries?.find(e => e.configType === "CF_GROUPS");

		// Build config
		const config: TemplateConfig = {
			customFormats: [],
			customFormatGroups: [],
		};

		// Add selected custom formats
		if (customFormatsCache?.data) {
			const formats = customFormatsCache.data as TrashCustomFormat[];
			for (const [trashId, settings] of selectedFormats.entries()) {
				const originalFormat = formats.find(f => f.trash_id === trashId);
				if (originalFormat) {
					config.customFormats.push({
						trashId,
						name: originalFormat.name,
						scoreOverride: settings.scoreOverride,
						conditionsEnabled: settings.conditionsEnabled,
						originalConfig: originalFormat,
					});
				}
			}
		}

		// Add selected custom format groups
		if (groupsCache?.data) {
			const groups = groupsCache.data as TrashCustomFormatGroup[];
			for (const trashId of selectedGroups) {
				const originalGroup = groups.find(g => g.trash_id === trashId);
				if (originalGroup) {
					config.customFormatGroups.push({
						trashId,
						name: originalGroup.name,
						enabled: true,
						originalConfig: originalGroup,
					});
				}
			}
		}

		try {
			if (template) {
				await updateMutation.mutateAsync({
					templateId: template.id,
					payload: { name, description, config, syncStrategy },
				});
			} else {
				await createMutation.mutateAsync({ name, description, serviceType, config, syncStrategy });
			}
			onClose();
		} catch (error) {
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

	const mutation = template ? updateMutation : createMutation;

	return (
		<div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
			<div className="relative w-full max-w-4xl max-h-[90vh] overflow-y-auto rounded-xl border border-white/10 bg-slate-900 p-6">
				{/* Header */}
				<div className="mb-6 flex items-center justify-between border-b border-white/10 pb-4">
					<h2 className="text-2xl font-semibold text-white">
						{template ? "Edit Template" : "Create Template"}
					</h2>
					<button
						type="button"
						onClick={onClose}
						className="rounded p-1 text-white/60 hover:bg-white/10 hover:text-white"
					>
						<X className="h-5 w-5" />
					</button>
				</div>

				{/* Error Alert */}
				{mutation.isError && (
					<Alert variant="danger" className="mb-4">
						<AlertDescription>
							{mutation.error instanceof Error ? mutation.error.message : "Failed to save template"}
						</AlertDescription>
					</Alert>
				)}

				<div className="space-y-6">
					{/* Basic Info */}
					<div className="space-y-4">
						<div>
							<label className="mb-2 block text-sm font-medium text-white">Template Name</label>
							<input
								type="text"
								value={name}
								onChange={(e) => setName(e.target.value)}
								placeholder="My Custom Template"
								className="w-full rounded border border-white/20 bg-white/10 px-3 py-2 text-white placeholder:text-white/40 focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
							/>
						</div>

						<div>
							<label className="mb-2 block text-sm font-medium text-white">Description (Optional)</label>
							<textarea
								value={description}
								onChange={(e) => setDescription(e.target.value)}
								placeholder="Describe what this template is for..."
								rows={3}
								className="w-full rounded border border-white/20 bg-white/10 px-3 py-2 text-white placeholder:text-white/40 focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
							/>
						</div>

						{!template && (
							<div>
								<label className="mb-2 block text-sm font-medium text-white">Service Type</label>
								<div className="flex gap-4">
									<button
										type="button"
										onClick={() => setServiceType("RADARR")}
										className={`flex-1 rounded-lg border px-4 py-2 text-sm font-medium transition ${
											serviceType === "RADARR"
												? "border-primary bg-primary text-white"
												: "border-white/20 bg-white/10 text-white/70 hover:bg-white/20"
										}`}
									>
										Radarr
									</button>
									<button
										type="button"
										onClick={() => setServiceType("SONARR")}
										className={`flex-1 rounded-lg border px-4 py-2 text-sm font-medium transition ${
											serviceType === "SONARR"
												? "border-primary bg-primary text-white"
												: "border-white/20 bg-white/10 text-white/70 hover:bg-white/20"
										}`}
									>
										Sonarr
									</button>
								</div>
							</div>
						)}

						{/* TRaSH Guides Sync Strategy */}
						<div>
							<SyncStrategyControl
								value={syncStrategy}
								onChange={setSyncStrategy}
								disabled={mutation.isPending}
							/>
						</div>
					</div>

					{/* Custom Formats */}
					<div className="space-y-3">
						<h3 className="text-lg font-medium text-white">Custom Formats</h3>
						{availableFormats.length === 0 ? (
							<p className="text-sm text-white/60">No custom formats available in cache. Refresh cache first.</p>
						) : (
							<div className="space-y-2 max-h-64 overflow-y-auto rounded border border-white/10 bg-white/5 p-4">
								{availableFormats.map((format) => {
									const isSelected = selectedFormats.has(format.trash_id);
									const settings = selectedFormats.get(format.trash_id);

									return (
										<div key={format.trash_id} className="space-y-2 rounded border border-white/10 bg-white/5 p-3">
											<div className="flex items-center justify-between">
												<label className="flex items-center gap-2">
													<input
														type="checkbox"
														checked={isSelected}
														onChange={() => handleToggleFormat(format.trash_id, format)}
														className="h-4 w-4 rounded border-white/20 bg-white/10 text-primary focus:ring-primary"
													/>
													<span className="text-sm font-medium text-white">{format.name}</span>
												</label>
												{isSelected && (
													<div className="flex items-center gap-2">
														<button
															type="button"
															onClick={() => {
																console.log('Advanced clicked for format:', format.trash_id, format);
																setConditionEditorFormat({ trashId: format.trash_id, format });
															}}
															className="inline-flex items-center gap-1 rounded bg-white/10 px-2 py-1 text-xs font-medium text-white transition hover:bg-white/20"
															title="Advanced condition editing"
														>
															<Settings className="h-3 w-3" />
															Advanced
														</button>
														<label className="text-xs text-white/60">Score:</label>
														<input
															type="number"
															value={settings?.scoreOverride ?? ""}
															onChange={(e) => handleScoreChange(format.trash_id, e.target.value ? Number(e.target.value) : undefined)}
															placeholder="Default"
															className="w-20 rounded border border-white/20 bg-white/10 px-2 py-1 text-xs text-white"
														/>
														<button
															type="button"
															onClick={() => handleToggleFormat(format.trash_id, format)}
															className="inline-flex items-center gap-1 rounded bg-red-500/20 px-2 py-1 text-xs font-medium text-red-300 transition hover:bg-red-500/30"
															title="Remove this custom format"
														>
															<Minus className="h-3 w-3" />
															Remove
														</button>
													</div>
												)}
											</div>
											{isSelected && format.specifications.length > 0 && (
												<div className="ml-6 space-y-1">
													<p className="text-xs font-medium text-white/70">Conditions:</p>
													{format.specifications.map((spec) => (
														<label key={spec.name} className="flex items-center gap-2">
															<input
																type="checkbox"
																checked={settings?.conditionsEnabled[spec.name] !== false}
																onChange={() => handleToggleCondition(format.trash_id, spec.name)}
																className="h-3 w-3 rounded border-white/20 bg-white/10 text-primary focus:ring-primary"
															/>
															<span className="text-xs text-white/60">{spec.name}</span>
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

					{/* Custom Format Groups */}
					<div className="space-y-3">
						<h3 className="text-lg font-medium text-white">Custom Format Groups</h3>
						{availableGroups.length === 0 ? (
							<p className="text-sm text-white/60">No CF groups available in cache.</p>
						) : (
							<div className="space-y-2 max-h-48 overflow-y-auto rounded border border-white/10 bg-white/5 p-4">
								{availableGroups.map((group) => (
									<label key={group.trash_id} className="flex items-center gap-2">
										<input
											type="checkbox"
											checked={selectedGroups.has(group.trash_id)}
											onChange={() => handleToggleGroup(group.trash_id)}
											className="h-4 w-4 rounded border-white/20 bg-white/10 text-primary focus:ring-primary"
										/>
										<span className="text-sm text-white">{group.name}</span>
										<span className="text-xs text-white/40">({group.custom_formats.length} formats)</span>
									</label>
								))}
							</div>
						)}
					</div>

					{/* Actions */}
					<div className="flex justify-end gap-2 border-t border-white/10 pt-4">
						<button
							type="button"
							onClick={onClose}
							className="rounded-lg bg-white/10 px-4 py-2 text-sm font-medium text-white transition hover:bg-white/20"
						>
							Cancel
						</button>
						<button
							type="button"
							onClick={handleSave}
							disabled={!name.trim() || mutation.isPending}
							className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white transition hover:bg-primary/90 disabled:opacity-50"
						>
							<Save className="h-4 w-4" />
							{mutation.isPending ? "Saving..." : template ? "Update Template" : "Create Template"}
						</button>
					</div>
				</div>

				{/* Condition Editor Modal */}
				{conditionEditorFormat && (() => {
					console.log('Rendering modal for:', conditionEditorFormat);
					const settings = selectedFormats.get(conditionEditorFormat.trashId);
					const specificationsWithEnabled = conditionEditorFormat.format.specifications.map((spec: any) => ({
						...spec,
						enabled: settings?.conditionsEnabled[spec.name] !== false,
					}));
					console.log('Specifications with enabled:', specificationsWithEnabled);

					return (
						<div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm">
							<div className="relative w-full max-w-4xl max-h-[90vh] overflow-y-auto rounded-xl border border-white/20 bg-gradient-to-br from-slate-900 to-slate-800 p-6">
								{/* Close button */}
								<button
									type="button"
									onClick={() => setConditionEditorFormat(null)}
									className="absolute top-4 right-4 rounded p-1 text-white/60 hover:bg-white/10 hover:text-white"
								>
									<X className="h-5 w-5" />
								</button>

								<ConditionEditor
									customFormatId={conditionEditorFormat.trashId}
									customFormatName={conditionEditorFormat.format.name}
									specifications={specificationsWithEnabled}
									onChange={(updatedSpecs: any) => {
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

