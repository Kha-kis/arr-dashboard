/**
 * Custom Format Form Modal
 * Comprehensive form for creating/editing custom formats with tabs
 */

"use client";

import { useState, useEffect, useMemo } from "react";
import type { CustomFormat, CustomFormatSpecification } from "@arr/shared";
import {
	Dialog,
	DialogContent,
	DialogHeader,
	DialogTitle,
	DialogDescription,
	DialogFooter,
	Button,
	Input,
	Tabs,
	TabsList,
	TabsTrigger,
	TabsContent,
	Badge,
} from "../../../components/ui";
import { cn } from "../../../lib/utils";
import { SpecificationFields } from "./specification-fields";
import { useCustomFormatSchema } from "../../../hooks/api/useCustomFormats";

/**
 * Transform form data to clean export format (for JSON preview)
 * Matches the format used by Radarr/Sonarr export and TRaSH guides
 */
function transformToExportFormat(formData: Omit<CustomFormat, "id">): any {
	return {
		name: formData.name,
		includeCustomFormatWhenRenaming: formData.includeCustomFormatWhenRenaming,
		specifications: formData.specifications?.map((spec) => {
			// Convert fields array to object (key-value pairs)
			const fieldsObj: Record<string, any> = {};
			if (Array.isArray(spec.fields)) {
				for (const field of spec.fields) {
					if (field.name && field.value !== undefined) {
						fieldsObj[field.name] = field.value;
					}
				}
			} else if (spec.fields && typeof spec.fields === 'object') {
				// Already in object format
				Object.assign(fieldsObj, spec.fields);
			}

			return {
				name: spec.name,
				implementation: spec.implementation,
				negate: spec.negate,
				required: spec.required,
				fields: fieldsObj,
			};
		}) || [],
	};
}

interface CustomFormatFormModalProps {
	isOpen: boolean;
	onClose: () => void;
	onSubmit: (data: Omit<CustomFormat, "id">, trashData?: { trashId: string; service: string; enableAutoSync: boolean }) => void | Promise<void>;
	initialData?: CustomFormat | null;
	isSubmitting?: boolean;
	instanceId?: string;
	instances?: Array<{ instanceId: string; instanceLabel: string; instanceService: string }>;
	onInstanceChange?: (instanceId: string) => void;
	isTrackedByTrash?: boolean;
	isSyncExcluded?: boolean;
	onToggleSyncExclusion?: () => void;
	isTogglingExclusion?: boolean;
	onBrowseTrash?: (instanceId: string, instanceLabel: string, service: string) => void;
	trashData?: { trashId: string; service: "SONARR" | "RADARR" } | null;
}

export function CustomFormatFormModal({
	isOpen,
	onClose,
	onSubmit,
	initialData,
	isSubmitting = false,
	instanceId,
	instances = [],
	onInstanceChange,
	isTrackedByTrash = false,
	isSyncExcluded = false,
	onToggleSyncExclusion,
	isTogglingExclusion = false,
	onBrowseTrash,
	trashData,
}: CustomFormatFormModalProps) {
	const [activeTab, setActiveTab] = useState("details");
	const [formData, setFormData] = useState<Omit<CustomFormat, "id">>({
		name: "",
		includeCustomFormatWhenRenaming: false,
		specifications: [],
	});

	// JSON editing state
	const [jsonValue, setJsonValue] = useState("");
	const [jsonError, setJsonError] = useState<string | null>(null);
	const [isJsonDirty, setIsJsonDirty] = useState(false);

	// Auto-sync toggle for new TRaSH imports
	const [enableAutoSync, setEnableAutoSync] = useState(true);

	// Fetch schema for field definitions
	const { data: schema } = useCustomFormatSchema(instanceId);

	// Initialize form data when modal opens or initialData changes
	useEffect(() => {
		if (initialData) {
			const { id, ...data } = initialData;
			setFormData(data);
		} else {
			setFormData({
				name: "",
				includeCustomFormatWhenRenaming: false,
				specifications: [],
			});
		}
		setIsJsonDirty(false);
		setJsonError(null);
	}, [initialData, isOpen]);

	// Sync JSON when formData changes or when switching to JSON tab
	useEffect(() => {
		if (!isJsonDirty) {
			const exportFormat = transformToExportFormat(formData);
			setJsonValue(JSON.stringify(exportFormat, null, 2));
		}
	}, [formData, isJsonDirty]);

	const handleJsonChange = (value: string) => {
		setJsonValue(value);
		setIsJsonDirty(true);
		setJsonError(null);
	};

	const applyJsonToForm = () => {
		try {
			const parsed = JSON.parse(jsonValue);

			// Validate required fields
			if (!parsed.name || typeof parsed.name !== 'string') {
				throw new Error("JSON must include a 'name' field");
			}

			// Transform specifications from export format to internal format
			const specifications = (parsed.specifications || []).map((spec: any) => {
				// Convert fields object to array format expected by schema
				const fieldsArray = spec.fields && typeof spec.fields === 'object'
					? Object.entries(spec.fields).map(([name, value]) => ({
						name,
						value,
						label: name,
						type: 'textbox',
						order: 0,
					}))
					: [];

				return {
					name: spec.name || "Unnamed Specification",
					implementation: spec.implementation || "ReleaseTitleSpecification",
					negate: spec.negate || false,
					required: spec.required || false,
					fields: fieldsArray.length > 0 ? fieldsArray : spec.fields || {},
				};
			});

			setFormData({
				name: parsed.name,
				includeCustomFormatWhenRenaming: parsed.includeCustomFormatWhenRenaming || false,
				specifications,
			});

			setIsJsonDirty(false);
			setJsonError(null);
		} catch (error) {
			setJsonError(error instanceof Error ? error.message : "Invalid JSON");
		}
	};

	const formatJson = () => {
		try {
			const parsed = JSON.parse(jsonValue);
			setJsonValue(JSON.stringify(parsed, null, 2));
			setJsonError(null);
		} catch (error) {
			setJsonError("Cannot format invalid JSON");
		}
	};

	const handleSubmit = async (e: React.FormEvent) => {
		e.preventDefault();

		// If this is a TRaSH import, pass the trash data
		if (trashData) {
			await onSubmit(formData, {
				trashId: trashData.trashId,
				service: trashData.service,
				enableAutoSync,
			});
		} else {
			await onSubmit(formData);
		}
	};

	const addSpecification = () => {
		// Get field definitions from schema for default implementation
		const defaultImplementation = "ReleaseTitleSpecification";
		const implementationSchema = schema?.find(
			(s: any) => s.implementation === defaultImplementation
		);
		const fields = implementationSchema?.fields || [];

		setFormData((prev) => ({
			...prev,
			specifications: [
				...prev.specifications,
				{
					name: "New Specification",
					implementation: defaultImplementation,
					negate: false,
					required: false,
					fields: fields,
				},
			],
		}));
	};

	const updateSpecification = (
		index: number,
		updates: Partial<CustomFormatSpecification>,
	) => {
		setFormData((prev) => ({
			...prev,
			specifications: prev.specifications.map((spec, i) => {
				if (i !== index) return spec;

				// If implementation is changing, update fields from schema
				if (updates.implementation && updates.implementation !== spec.implementation) {
					const implementationSchema = schema?.find(
						(s: any) => s.implementation === updates.implementation
					);
					const fields = implementationSchema?.fields || [];
					return { ...spec, ...updates, fields };
				}

				return { ...spec, ...updates };
			}),
		}));
	};

	const deleteSpecification = (index: number) => {
		setFormData((prev) => ({
			...prev,
			specifications: prev.specifications.filter((_, i) => i !== index),
		}));
	};

	if (!isOpen) return null;

	return (
		<Dialog open={isOpen} onOpenChange={onClose}>
			<DialogContent className="max-w-4xl max-h-[90vh] overflow-hidden flex flex-col">
				<DialogHeader>
					<DialogTitle>
						{initialData ? "Edit Custom Format" : "Create Custom Format"}
					</DialogTitle>
					<DialogDescription>
						{initialData
							? "Modify the custom format details, specifications, and scoring."
							: "Create a new custom format with specifications and scoring."}
					</DialogDescription>
				</DialogHeader>

				<form onSubmit={handleSubmit} className="flex-1 flex flex-col overflow-hidden">
					<Tabs defaultValue="details" className="flex-1 flex flex-col overflow-hidden">
						<TabsList className="w-full justify-start">
							<TabsTrigger value="details">Details</TabsTrigger>
							<TabsTrigger value="specifications">
								Specifications ({formData.specifications.length})
							</TabsTrigger>
							<TabsTrigger value="json">JSON</TabsTrigger>
						</TabsList>

						{/* Details Tab */}
						<TabsContent value="details" className="flex-1 overflow-y-auto p-4 space-y-4">
						{/* Instance Selector - only show when creating new format */}
						{!initialData?.id && instances.length > 0 && (
							<div className="space-y-2">
								<label htmlFor="instance" className="text-sm font-medium text-fg">
									Instance <span className="text-danger">*</span>
								</label>
								<select
									id="instance"
									value={instanceId || ""}
									onChange={(e) => onInstanceChange?.(e.target.value)}
									className="w-full rounded-lg border border-border bg-bg px-3 py-2 text-sm text-fg focus:ring-2 focus:ring-primary focus:ring-offset-2"
									required
								>
									{instances.map((instance) => (
										<option key={instance.instanceId} value={instance.instanceId}>
											{instance.instanceLabel} ({instance.instanceService})
										</option>
									))}
								</select>
								<p className="text-xs text-fg-muted">
									Select the Sonarr or Radarr instance to create this custom format in.
									Different instances may have different specification types available.
								</p>
							</div>
						)}

						{/* TRaSH Guides Import Option - only show when creating new format */}
						{!initialData?.id && onBrowseTrash && instanceId && !trashData && (
							<div className="rounded-lg border border-success/30 bg-success/5 p-4 space-y-3">
								<div className="flex items-start gap-3">
									<Badge variant="success" className="text-xs shrink-0 mt-0.5">
										TRaSH
									</Badge>
									<div className="flex-1 space-y-2">
										<h4 className="text-sm font-medium text-fg">
											Import from TRaSH Guides
										</h4>
										<p className="text-xs text-fg-muted">
											Browse and import pre-configured custom formats from the TRaSH Guides community collection.
											These formats are maintained and regularly updated with the latest standards.
										</p>
										<Button
											type="button"
											size="sm"
											variant="secondary"
											onClick={() => {
												const instance = instances.find(i => i.instanceId === instanceId);
												if (instance) {
													onBrowseTrash(instance.instanceId, instance.instanceLabel, instance.instanceService);
													onClose(); // Close this modal when opening TRaSH browser
												}
											}}
										>
											Browse TRaSH Guides
										</Button>
									</div>
								</div>
							</div>
						)}

						{/* Instance Info - show when editing existing format */}
						{initialData?.id && (
							<div className="space-y-2">
								<label className="text-sm font-medium text-fg">Instance</label>
								<div className="flex items-center gap-2 px-3 py-2 rounded-lg border border-border bg-bg-subtle/30">
									<span className="text-sm text-fg">
										{instances.find((i) => i.instanceId === instanceId)?.instanceLabel || "Unknown"}
									</span>
									<span className="text-xs text-fg-muted">
										({instances.find((i) => i.instanceId === instanceId)?.instanceService || "Unknown"})
									</span>
								</div>
								<p className="text-xs text-fg-muted">
									Instance cannot be changed when editing an existing custom format.
								</p>
							</div>
						)}

							<div className="space-y-2">
								<label htmlFor="name" className="text-sm font-medium text-fg">
									Name <span className="text-danger">*</span>
								</label>
								<Input
									id="name"
									type="text"
									value={formData.name}
									onChange={(e) =>
										setFormData((prev) => ({ ...prev, name: e.target.value }))
									}
									placeholder="e.g., DV HDR10+"
									required
								/>
							</div>

							<div className="flex items-center gap-2">
								<input
									id="includeWhenRenaming"
									type="checkbox"
									checked={formData.includeCustomFormatWhenRenaming}
									onChange={(e) =>
										setFormData((prev) => ({
											...prev,
											includeCustomFormatWhenRenaming: e.target.checked,
										}))
									}
									className="h-4 w-4 rounded border-border bg-bg-subtle text-primary focus:ring-2 focus:ring-primary focus:ring-offset-2"
								/>
								<label
									htmlFor="includeWhenRenaming"
									className="text-sm font-medium text-fg cursor-pointer"
								>
									Include when renaming
								</label>
							</div>
							<p className="text-xs text-fg-muted">
								When enabled, this custom format name will be included in renamed
								files.
							</p>

							{/* TRaSH Auto-Sync Setting for new imports */}
							{!initialData?.id && trashData && (
								<div className="mt-4 p-4 rounded-lg border border-success/30 bg-success/5 space-y-3">
									<div className="flex items-start gap-3">
										<Badge variant="success" className="text-xs shrink-0 mt-0.5">
											TRaSH
										</Badge>
										<div className="flex-1 space-y-3">
											<h4 className="text-sm font-medium text-fg">
												TRaSH Guides Integration
											</h4>
											<p className="text-xs text-fg-muted">
												This custom format will be tracked and can receive automatic updates from TRaSH Guides.
											</p>

											<div className="flex items-center justify-between pt-2 border-t border-success/20">
												<div className="flex-1">
													<label className="text-sm font-medium text-fg">
														Enable Automatic Updates
													</label>
													<p className="text-xs text-fg-muted mt-1">
														{enableAutoSync ? (
															<>Auto-sync will keep this format updated with TRaSH Guides. You can customize it now, but changes may be overwritten during sync.</>
														) : (
															<>Auto-sync is disabled. Your customizations will be preserved and won't be overwritten by TRaSH updates.</>
														)}
													</p>
												</div>
												<button
													type="button"
													onClick={() => setEnableAutoSync(!enableAutoSync)}
													className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors focus:outline-none focus:ring-2 focus:ring-primary focus:ring-offset-2 ml-4 ${
														enableAutoSync ? 'bg-success' : 'bg-border'
													}`}
												>
													<span
														className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
															enableAutoSync ? 'translate-x-6' : 'translate-x-1'
														}`}
													/>
												</button>
											</div>
										</div>
									</div>
								</div>
							)}

							{/* TRaSH Auto-Sync Setting - only show if format is tracked */}
							{initialData?.id && isTrackedByTrash && onToggleSyncExclusion && (
								<div className="mt-4 p-4 rounded-lg border border-border bg-bg-subtle/30 space-y-3">
									<div className="flex items-start gap-3">
										<div className="flex items-center gap-2 flex-1">
											<Badge variant="success" className="text-xs shrink-0">
												TRaSH
											</Badge>
											<span className="text-sm font-medium text-fg">
												TRaSH Guides Integration
											</span>
										</div>
									</div>

									<div className="space-y-2">
										<div className="flex items-center justify-between">
											<label className="text-sm font-medium text-fg">
												Automatic Updates
											</label>
											<button
												type="button"
												onClick={onToggleSyncExclusion}
												disabled={isTogglingExclusion}
												className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors focus:outline-none focus:ring-2 focus:ring-primary focus:ring-offset-2 ${
													isSyncExcluded ? 'bg-border' : 'bg-success'
												}`}
											>
												<span
													className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
														isSyncExcluded ? 'translate-x-1' : 'translate-x-6'
													}`}
												/>
											</button>
										</div>
										<p className="text-xs text-fg-muted">
											{isSyncExcluded ? (
												<>
													<strong>Auto-sync is disabled.</strong> Your manual changes to this format will be preserved. It will not receive automatic updates from TRaSH Guides.
												</>
											) : (
												<>
													<strong>Auto-sync is enabled.</strong> This format will automatically receive updates from TRaSH Guides based on your sync schedule. Manual changes may be overwritten.
												</>
											)}
										</p>
									</div>
								</div>
							)}
						</TabsContent>

						{/* Specifications Tab */}
						<TabsContent
							value="specifications"
							className="flex-1 overflow-y-auto p-4 space-y-4"
						>
							<div className="flex items-center justify-between">
								<p className="text-sm text-fg-muted">
									Define conditions that must match for this custom format to apply.
								</p>
								<Button type="button" size="sm" onClick={addSpecification}>
									Add Specification
								</Button>
							</div>

							{formData.specifications.length === 0 ? (
								<div className="flex flex-col items-center justify-center py-12 border border-dashed border-border rounded-lg bg-bg-subtle/30">
									<p className="text-fg-muted mb-2">No specifications yet</p>
									<p className="text-xs text-fg-subtle mb-4">
										Add conditions to define when this custom format applies
									</p>
									<Button type="button" variant="secondary" onClick={addSpecification}>
										Add First Specification
									</Button>
								</div>
							) : (
								<div className="space-y-3">
									{formData.specifications.map((spec, index) => (
										<div
											key={index}
											className="border border-border rounded-lg p-4 bg-bg-subtle/30 space-y-3"
										>
											<div className="flex items-start justify-between gap-2">
												<div className="flex-1 space-y-3">
													<div className="space-y-2">
														<label className="text-sm font-medium text-fg">
															Name
														</label>
														<Input
															type="text"
															value={spec.name}
															onChange={(e) =>
																updateSpecification(index, {
																	name: e.target.value,
																})
															}
															placeholder="Specification name"
														/>
													</div>

													<div className="space-y-2">
														<div className="flex items-center justify-between">
															<label className="text-sm font-medium text-fg">
																Implementation
															</label>
															{/* Info link if available in schema */}
															{schema && Array.isArray(schema) && (() => {
																const schemaItem = schema.find(
																	(s: any) => s.implementation === spec.implementation
																);
																return schemaItem?.infoLink ? (
																	<a
																		href={schemaItem.infoLink}
																		target="_blank"
																		rel="noopener noreferrer"
																		className="text-xs text-primary hover:underline"
																	>
																		More Info ↗
																	</a>
																) : null;
															})()}
														</div>
														<select
															value={spec.implementation}
															onChange={(e) =>
																updateSpecification(index, {
																	implementation: e.target.value,
																})
															}
															className="w-full rounded-lg border border-border bg-bg px-3 py-2 text-sm text-fg focus:ring-2 focus:ring-primary focus:ring-offset-2"
														>
															{schema && Array.isArray(schema) ? (
																schema.map((schemaItem: any) => (
																	<option
																		key={schemaItem.implementation}
																		value={schemaItem.implementation}
																	>
																		{schemaItem.implementationName || schemaItem.implementation}
																	</option>
																))
															) : (
																<option value={spec.implementation}>
																	{spec.implementation}
																</option>
															)}
														</select>
														{/* Presets if available */}
														{schema && Array.isArray(schema) && (() => {
															const schemaItem = schema.find(
																(s: any) => s.implementation === spec.implementation
															);
															const presets = schemaItem?.presets;
															return presets && Array.isArray(presets) && presets.length > 0 ? (
																<div className="space-y-2">
																	<label className="text-sm font-medium text-fg">
																		Apply Preset
																	</label>
																	<select
																		value=""
																		onChange={(e) => {
																			if (e.target.value) {
																				const preset = presets.find((p: any) => p.name === e.target.value);
																				if (preset) {
																					updateSpecification(index, {
																						name: preset.name,
																						fields: preset.fields || preset,
																					});
																				}
																				// Reset dropdown after selection
																				e.target.value = "";
																			}
																		}}
																		className="w-full rounded-lg border border-border bg-bg px-3 py-2 text-sm text-fg focus:ring-2 focus:ring-primary focus:ring-offset-2"
																	>
																		<option value="">Select a preset...</option>
																		{presets.map((preset: any) => (
																			<option key={preset.name} value={preset.name}>
																				{preset.name}
																			</option>
																		))}
																	</select>
																	<p className="text-xs text-fg-muted">
																		Choose a preset to auto-fill specification fields
																	</p>
																</div>
															) : null;
														})()}
													</div>

													{/* Dynamic fields based on specification type */}
													{spec.fields && (
														<div className="space-y-2">
															<label className="text-sm font-medium text-fg">
																Specification Fields
															</label>
															<SpecificationFields
																fields={spec.fields}
																onChange={(updatedFields) =>
																	updateSpecification(index, {
																		fields: updatedFields,
																	})
																}
															/>
														</div>
													)}

													<div className="grid grid-cols-2 gap-3">
														<div className="flex items-center gap-2">
															<input
																type="checkbox"
																id={`negate-${index}`}
																checked={spec.negate}
																onChange={(e) =>
																	updateSpecification(index, {
																		negate: e.target.checked,
																	})
																}
																className="h-4 w-4 rounded border-border bg-bg-subtle text-primary focus:ring-2 focus:ring-primary focus:ring-offset-2"
															/>
															<label
																htmlFor={`negate-${index}`}
																className="text-sm text-fg cursor-pointer"
															>
																Negate
															</label>
														</div>

														<div className="flex items-center gap-2">
															<input
																type="checkbox"
																id={`required-${index}`}
																checked={spec.required}
																onChange={(e) =>
																	updateSpecification(index, {
																		required: e.target.checked,
																	})
																}
																className="h-4 w-4 rounded border-border bg-bg-subtle text-primary focus:ring-2 focus:ring-primary focus:ring-offset-2"
															/>
															<label
																htmlFor={`required-${index}`}
																className="text-sm text-fg cursor-pointer"
															>
																Required
															</label>
														</div>
													</div>
												</div>

												<Button
													type="button"
													variant="ghost"
													size="sm"
													onClick={() => deleteSpecification(index)}
													className="text-danger hover:bg-danger/10"
												>
													Delete
												</Button>
											</div>
										</div>
									))}
								</div>
							)}
						</TabsContent>

						{/* JSON Editor Tab */}
						<TabsContent value="json" className="flex-1 overflow-y-auto p-4 space-y-4">
							<div className="space-y-2">
								<div className="flex items-center justify-between">
									<div>
										<label className="text-sm font-medium text-fg">
											JSON Editor
										</label>
										<p className="text-xs text-fg-muted">
											Edit the custom format JSON directly. Changes must be applied to update the form.
										</p>
									</div>
									<div className="flex gap-2">
										<Button
											type="button"
											size="sm"
											variant="ghost"
											onClick={formatJson}
										>
											Format
										</Button>
										{isJsonDirty && (
											<Button
												type="button"
												size="sm"
												onClick={applyJsonToForm}
											>
												Apply Changes
											</Button>
										)}
									</div>
								</div>

								{jsonError && (
									<div className="rounded-lg border border-danger bg-danger/10 px-3 py-2">
										<p className="text-sm text-danger">{jsonError}</p>
									</div>
								)}

								{isJsonDirty && !jsonError && (
									<div className="rounded-lg border border-warning bg-warning/10 px-3 py-2">
										<p className="text-sm text-warning">
											You have unsaved JSON changes. Click "Apply Changes" to update the form.
										</p>
									</div>
								)}

								<textarea
									value={jsonValue}
									onChange={(e) => handleJsonChange(e.target.value)}
									className="w-full h-[500px] rounded-lg border border-border bg-bg px-3 py-2 text-xs font-mono text-fg focus:ring-2 focus:ring-primary focus:ring-offset-2 resize-none"
									spellCheck={false}
								/>

								<div className="text-xs text-fg-muted space-y-1">
									<p><strong>Tips:</strong></p>
									<ul className="list-disc list-inside space-y-1 ml-2">
										<li>Paste JSON from TRaSH guides or other sources</li>
										<li>Format: Click "Format" to auto-indent the JSON</li>
										<li>Apply: Click "Apply Changes" to sync JSON to form fields</li>
										<li>Required fields: name, specifications array</li>
									</ul>
								</div>
							</div>
						</TabsContent>
					</Tabs>

					<DialogFooter className="mt-4">
						<Button type="button" variant="ghost" onClick={onClose}>
							Cancel
						</Button>
						<Button type="submit" disabled={isSubmitting || !formData.name}>
							{isSubmitting
								? initialData
									? "Updating..."
									: "Creating..."
								: initialData
									? "Update"
									: "Create"}
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}
