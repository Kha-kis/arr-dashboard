"use client";

import { useState, useEffect, useCallback } from "react";
import type { CustomQualityConfig } from "@arr/shared";
import {
	Dialog,
	DialogContent,
	DialogHeader,
	DialogTitle,
	DialogDescription,
	DialogFooter,
} from "../../../components/ui/dialog";
import { Button } from "../../../components/ui";
import {
	Server,
	Sliders,
	RotateCcw,
	Save,
	AlertCircle,
	Check,
	Loader2,
	Info,
} from "lucide-react";
import { QualityGroupEditor } from "./quality-group-editor";
import {
	getInstanceOverrides,
	updateInstanceOverrides,
} from "../../../lib/api-client/trash-guides";
import { cn } from "../../../lib/utils";
import { getErrorMessage } from "../../../lib/error-utils";

interface InstanceQualityOverrideModalProps {
	open: boolean;
	onClose: () => void;
	templateId: string;
	templateName: string;
	instanceId: string;
	instanceLabel: string;
	serviceType: "RADARR" | "SONARR";
	/** The template's default quality config (used as starting point) */
	templateDefaultConfig?: CustomQualityConfig;
	onSaved?: () => void;
}

/**
 * Modal for editing instance-specific quality configuration overrides.
 * Starts with the template default and allows customization for this instance only.
 */
export const InstanceQualityOverrideModal = ({
	open,
	onClose,
	templateId,
	templateName,
	instanceId,
	instanceLabel,
	serviceType,
	templateDefaultConfig,
	onSaved,
}: InstanceQualityOverrideModalProps) => {
	// State
	const [config, setConfig] = useState<CustomQualityConfig>({
		useCustomQualities: false,
		items: [],
		cutoffId: undefined,
	});
	const [hasOverride, setHasOverride] = useState(false);
	const [isLoading, setIsLoading] = useState(true);
	const [isSaving, setIsSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [hasChanges, setHasChanges] = useState(false);
	const [mode, setMode] = useState<"default" | "override">("default");

	// Load existing override - wrapped in useCallback for proper dependency tracking
	const loadOverride = useCallback(async () => {
		setIsLoading(true);
		setError(null);

		try {
			const response = await getInstanceOverrides(templateId, instanceId);
			const override = response.overrides?.qualityConfigOverride;

			if (override) {
				// Instance has an existing override
				setConfig(override);
				setHasOverride(true);
				setMode("override");
			} else {
				// No override - use template default
				setConfig(templateDefaultConfig ?? {
					useCustomQualities: false,
					items: [],
					cutoffId: undefined,
				});
				setHasOverride(false);
				setMode("default");
			}
			setHasChanges(false);
		} catch (err) {
			setError(getErrorMessage(err, "Failed to load override"));
		} finally {
			setIsLoading(false);
		}
	}, [templateId, instanceId, templateDefaultConfig]);

	// Load existing override on open
	useEffect(() => {
		if (open && templateId && instanceId) {
			loadOverride();
		}
	}, [open, templateId, instanceId, loadOverride]);

	// Handle config changes
	const handleConfigChange = useCallback((newConfig: CustomQualityConfig) => {
		setConfig(newConfig);
		setHasChanges(true);
	}, []);

	// Reset to use template default (clear override)
	const resetToDefault = useCallback(async () => {
		setIsSaving(true);
		setError(null);

		try {
			await updateInstanceOverrides(templateId, instanceId, {
				qualityConfigOverride: null, // Clear the override
			});

			setConfig(templateDefaultConfig ?? {
				useCustomQualities: false,
				items: [],
				cutoffId: undefined,
			});
			setHasOverride(false);
			setMode("default");
			setHasChanges(false);
			onSaved?.();
		} catch (err) {
			setError(getErrorMessage(err, "Failed to reset override"));
		} finally {
			setIsSaving(false);
		}
	}, [templateId, instanceId, templateDefaultConfig, onSaved]);

	// Save override
	const saveOverride = useCallback(async () => {
		setIsSaving(true);
		setError(null);

		try {
			await updateInstanceOverrides(templateId, instanceId, {
				qualityConfigOverride: {
					...config,
					useCustomQualities: true,
					customizedAt: new Date().toISOString(),
					origin: "instance",
				},
			});

			setHasOverride(true);
			setHasChanges(false);
			onSaved?.();
		} catch (err) {
			setError(getErrorMessage(err, "Failed to save override"));
		} finally {
			setIsSaving(false);
		}
	}, [templateId, instanceId, config, onSaved]);

	// Switch to override mode - start with template default
	const enableOverride = useCallback(() => {
		setMode("override");
		// Start with a copy of the template default
		if (templateDefaultConfig && templateDefaultConfig.items.length > 0) {
			setConfig({
				...templateDefaultConfig,
				customizedAt: new Date().toISOString(),
				origin: "instance",
			});
		}
		setHasChanges(true);
	}, [templateDefaultConfig]);

	// Check if template has quality config to override
	const hasTemplateQualityConfig = templateDefaultConfig?.useCustomQualities &&
		templateDefaultConfig?.items &&
		templateDefaultConfig.items.length > 0;

	return (
		<Dialog open={open} onOpenChange={(isOpen) => !isOpen && onClose()}>
			<DialogContent className="max-w-3xl max-h-[90vh] overflow-hidden flex flex-col">
				<DialogHeader>
					<DialogTitle className="flex items-center gap-2">
						<Server className="h-5 w-5 text-purple-500" />
						Quality Settings for {instanceLabel}
					</DialogTitle>
					<DialogDescription>
						Customize quality settings for <strong className="text-foreground">{instanceLabel}</strong> only.
						Other instances using &ldquo;{templateName}&rdquo; will not be affected.
					</DialogDescription>
				</DialogHeader>

				<div className="flex-1 overflow-y-auto space-y-4 py-4">
					{/* Loading state */}
					{isLoading && (
						<div className="flex items-center justify-center py-8">
							<Loader2 className="h-6 w-6 animate-spin text-primary" />
							<span className="ml-2 text-muted-foreground">Loading configuration...</span>
						</div>
					)}

					{/* Error state */}
					{error && (
						<div className="flex items-center gap-2 rounded-lg border border-red-500/30 bg-red-500/5 p-4 text-red-600 dark:text-red-400">
							<AlertCircle className="h-5 w-5 shrink-0" />
							<span className="text-sm">{error}</span>
						</div>
					)}

					{/* Content when loaded */}
					{!isLoading && (
						<>
							{/* No template quality config - allow loading from instance */}
							{!hasTemplateQualityConfig && (
								<div className="space-y-4">
									<div className="flex items-start gap-3 rounded-lg border border-blue-500/30 bg-blue-500/5 p-4">
										<Info className="h-5 w-5 text-blue-500 shrink-0 mt-0.5" />
										<div className="space-y-1">
											<p className="text-sm text-foreground">
												This template doesn&apos;t have a default quality configuration.
											</p>
											<p className="text-xs text-muted-foreground">
												You can still set up quality settings for this instance by loading from its current profile.
											</p>
										</div>
									</div>

									{/* Quality editor for instance without template default */}
									<QualityGroupEditor
										config={config}
										onChange={handleConfigChange}
										showToggle={false}
										serviceType={serviceType}
									/>
								</div>
							)}

							{/* Mode selector - only show if template has quality config */}
							{hasTemplateQualityConfig && (
								<div className="rounded-lg border border-border p-4 space-y-3">
									<div className="flex items-center justify-between">
										<div className="text-sm font-medium text-foreground">Quality Configuration</div>
										{hasOverride && (
											<span className="flex items-center gap-1 rounded-full bg-purple-500/10 px-2 py-0.5 text-xs font-medium text-purple-600 dark:text-purple-400">
												<Sliders className="h-3 w-3" />
												Has Override
											</span>
										)}
									</div>

									<div className="grid grid-cols-2 gap-3">
										{/* Use Template Default */}
										<button
											type="button"
											onClick={() => {
												if (hasOverride) {
													resetToDefault();
												} else {
													setMode("default");
												}
											}}
											disabled={isSaving}
											className={cn(
												"flex flex-col items-start gap-2 rounded-lg border p-4 text-left transition",
												mode === "default"
													? "border-primary bg-primary/5 ring-1 ring-primary/30"
													: "border-border bg-background hover:border-border/80 hover:bg-card"
											)}
										>
											<div className="flex items-center gap-2">
												<div className={cn(
													"flex h-5 w-5 items-center justify-center rounded-full border-2",
													mode === "default"
														? "border-primary bg-primary text-white"
														: "border-border"
												)}>
													{mode === "default" && <Check className="h-3 w-3" />}
												</div>
												<span className="text-sm font-medium text-foreground">Use Template Default</span>
											</div>
											<p className="text-xs text-muted-foreground pl-7">
												Same as other instances using this template.
											</p>
										</button>

										{/* Use Custom Override */}
										<button
											type="button"
											onClick={() => mode === "default" && enableOverride()}
											disabled={isSaving}
											className={cn(
												"flex flex-col items-start gap-2 rounded-lg border p-4 text-left transition",
												mode === "override"
													? "border-purple-500 bg-purple-500/5 ring-1 ring-purple-500/30"
													: "border-border bg-background hover:border-border/80 hover:bg-card"
											)}
										>
											<div className="flex items-center gap-2">
												<div className={cn(
													"flex h-5 w-5 items-center justify-center rounded-full border-2",
													mode === "override"
														? "border-purple-500 bg-purple-500 text-white"
														: "border-border"
												)}>
													{mode === "override" && <Check className="h-3 w-3" />}
												</div>
												<span className="text-sm font-medium text-foreground">Customize for This Instance</span>
											</div>
											<p className="text-xs text-muted-foreground pl-7">
												Different settings just for {instanceLabel}.
											</p>
										</button>
									</div>
								</div>
							)}

							{/* Quality Editor - show when in override mode */}
							{mode === "override" && hasTemplateQualityConfig && (
								<div className="space-y-3">
									{/* Quality Group Editor */}
									<QualityGroupEditor
										config={config}
										onChange={handleConfigChange}
										showToggle={false}
										serviceType={serviceType}
									/>
								</div>
							)}

							{/* Show template default preview when using default */}
							{mode === "default" && hasTemplateQualityConfig && (
								<div className="space-y-3">
									<div className="flex items-center gap-2 text-sm text-muted-foreground">
										<Info className="h-4 w-4" />
										<span>Preview of template&apos;s quality configuration:</span>
									</div>
									<div className="opacity-60 pointer-events-none">
										<QualityGroupEditor
											config={templateDefaultConfig!}
											onChange={() => {}}
											showToggle={false}
											serviceType={serviceType}
										/>
									</div>
								</div>
							)}
						</>
					)}
				</div>

				<DialogFooter className="border-t border-border pt-4">
					<div className="flex items-center justify-between w-full">
						<div className="flex items-center gap-2">
							{hasChanges && (
								<span className="text-xs text-amber-600 dark:text-amber-400">
									Unsaved changes
								</span>
							)}
						</div>
						<div className="flex items-center gap-2">
							{hasOverride && mode === "override" && (
								<Button
									variant="ghost"
									onClick={resetToDefault}
									disabled={isSaving}
									className="gap-1 text-muted-foreground"
								>
									<RotateCcw className="h-4 w-4" />
									Reset to Template Default
								</Button>
							)}
							<Button variant="ghost" onClick={onClose} disabled={isSaving}>
								Cancel
							</Button>
							{/* Show save when: override mode with template config, OR no template config but has items */}
							{((mode === "override" && hasTemplateQualityConfig) || (!hasTemplateQualityConfig && config.items.length > 0)) && (
								<Button
									variant="primary"
									onClick={saveOverride}
									disabled={isSaving || !hasChanges}
									className="gap-1 bg-purple-600 hover:bg-purple-700"
								>
									{isSaving ? (
										<>
											<Loader2 className="h-4 w-4 animate-spin" />
											Saving...
										</>
									) : (
										<>
											<Save className="h-4 w-4" />
											Save Override
										</>
									)}
								</Button>
							)}
						</div>
					</div>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
};
