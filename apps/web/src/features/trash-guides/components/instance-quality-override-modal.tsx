"use client";

import type { CustomQualityConfig } from "@arr/shared";
import { AlertCircle, Check, Info, Loader2, RotateCcw, Save, Server, Sliders } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "../../../components/ui";
import { useUpdateInstanceOverrides } from "../../../hooks/api/useInstanceOverrides";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "../../../components/ui/dialog";
import {
	type GetInstanceOverridesResponse,
	getInstanceOverrides,
} from "../../../lib/api-client/trash-guides";
import { getErrorMessage } from "../../../lib/error-utils";
import { cn } from "../../../lib/utils";
import { QualityGroupEditor } from "./quality-group-editor";

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
	onSaved?: (readback: GetInstanceOverridesResponse) => void;
}

/**
 * Modal for editing instance-specific quality configuration overrides.
 * Starts with the template default and allows customization for this instance only.
 */
export const InstanceQualityOverrideModal = (props: InstanceQualityOverrideModalProps) => (
	<ScopedQualityOverrideModal
		key={JSON.stringify([props.templateId, props.instanceId, props.open])}
		{...props}
	/>
);

// A target/open change starts a new editor session. Issued work still settles,
// but its completion cannot update or confirm a different editor.
const ScopedQualityOverrideModal = ({
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
	const [config, setConfig] = useState<CustomQualityConfig>({
		useCustomQualities: false,
		items: [],
	});
	const [hasOverride, setHasOverride] = useState(false);
	const [isLoading, setIsLoading] = useState(true);
	const [initialReadConfirmed, setInitialReadConfirmed] = useState(false);
	const [isSaving, setIsSaving] = useState(false);
	const [awaitingReadback, setAwaitingReadback] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [hasChanges, setHasChanges] = useState(false);
	const [mode, setMode] = useState<"default" | "override">("default");
	const operation = useRef({
		active: true,
		serial: 0,
		pending: false,
		acknowledged: false,
		initialReadPending: false,
	});
	const presentation = useRef({ templateDefaultConfig, onSaved });
	useEffect(() => {
		presentation.current = { templateDefaultConfig, onSaved };
	}, [templateDefaultConfig, onSaved]);
	const { mutateAsync: updateOverrides } = useUpdateInstanceOverrides();
	const current = useCallback(
		(serial: number) => operation.current.active && operation.current.serial === serial,
		[],
	);
	useEffect(() => {
		const session = operation.current;
		session.active = true;
		return () => {
			session.active = false;
			session.serial++;
		};
	}, []);

	const readOverride = useCallback(
		async (serial: number, confirm: boolean) => {
			const readback = await getInstanceOverrides(templateId, instanceId);
			if (!current(serial)) return;
			// The API returns {} when there is no override. An optional nested identity,
			// if present, must agree with the exact outer selected-link identities.
			if (
				readback.templateId !== templateId ||
				readback.instanceId !== instanceId ||
				!readback.overrides ||
				typeof readback.overrides !== "object" ||
				(readback.overrides.instanceId !== undefined &&
					readback.overrides.instanceId !== instanceId)
			) {
				throw new Error("Override readback identity mismatch");
			}
			const override = readback.overrides.qualityConfigOverride;
			setConfig(
				override ??
					presentation.current.templateDefaultConfig ?? { useCustomQualities: false, items: [] },
			);
			setHasOverride(Boolean(override));
			setMode(override ? "override" : "default");
			setHasChanges(false);
			if (!confirm) setInitialReadConfirmed(true);
			if (confirm) {
				operation.current.acknowledged = false;
				setAwaitingReadback(false);
				presentation.current.onSaved?.(readback);
			}
		},
		[templateId, instanceId, current],
	);

	const loadInitialOverride = useCallback(async () => {
		const session = operation.current;
		if (!session.active || session.initialReadPending) return;
		session.initialReadPending = true;
		const serial = ++session.serial;
		setIsLoading(true);
		setError(null);
		try {
			await readOverride(serial, false);
		} catch (err) {
			if (current(serial))
				setError(
					`Current quality settings are unknown. Retry loading before editing. ${getErrorMessage(err, "Failed to load override")}`,
				);
		} finally {
			if (current(serial)) {
				session.initialReadPending = false;
				setIsLoading(false);
			}
		}
	}, [readOverride, current]);

	useEffect(() => {
		if (!open) return;
		const session = operation.current;
		void loadInitialOverride();
		return () => {
			session.serial++;
			session.initialReadPending = false;
		};
	}, [open, loadInitialOverride]);

	const confirmError = "Saved changes could not be confirmed. Retry readback without saving again.";
	const saveQuality = useCallback(
		async (qualityConfigOverride: CustomQualityConfig | null) => {
			if (
				!initialReadConfirmed ||
				operation.current.pending ||
				operation.current.acknowledged ||
				!operation.current.active
			)
				return;
			operation.current.pending = true;
			const serial = ++operation.current.serial;
			setIsSaving(true);
			setError(null);
			try {
				await updateOverrides({ templateId, instanceId, payload: { qualityConfigOverride } });
				if (!current(serial)) return;
				operation.current.acknowledged = true;
				setAwaitingReadback(true);
				await readOverride(serial, true);
			} catch (err) {
				if (current(serial))
					setError(
						operation.current.acknowledged
							? confirmError
							: getErrorMessage(err, "Failed to save override"),
					);
			} finally {
				if (current(serial)) {
					operation.current.pending = false;
					setIsSaving(false);
				}
			}
		},
		[templateId, instanceId, updateOverrides, readOverride, current, initialReadConfirmed],
	);

	const retryReadback = async () => {
		if (operation.current.pending || !operation.current.acknowledged || !operation.current.active)
			return;
		operation.current.pending = true;
		const serial = ++operation.current.serial;
		setIsSaving(true);
		setError(null);
		try {
			await readOverride(serial, true);
		} catch {
			if (current(serial)) setError(confirmError);
		} finally {
			if (current(serial)) {
				operation.current.pending = false;
				setIsSaving(false);
			}
		}
	};
	const handleConfigChange = useCallback((newConfig: CustomQualityConfig) => {
		setConfig(newConfig);
		setHasChanges(true);
	}, []);
	const resetToDefault = () => saveQuality(null);
	const saveOverride = () =>
		saveQuality({
			...config,
			useCustomQualities: true,
			customizedAt: new Date().toISOString(),
			origin: "instance",
		});
	const enableOverride = useCallback(() => {
		setMode("override");
		if (templateDefaultConfig?.items.length)
			setConfig({
				...templateDefaultConfig,
				customizedAt: new Date().toISOString(),
				origin: "instance",
			});
		setHasChanges(true);
	}, [templateDefaultConfig]);

	// Check if template has quality config to override
	const hasTemplateQualityConfig =
		templateDefaultConfig?.useCustomQualities &&
		templateDefaultConfig?.items &&
		templateDefaultConfig.items.length > 0;

	return (
		<Dialog
			open={open}
			onOpenChange={(isOpen) => !isOpen && !operation.current.pending && onClose()}
		>
			<DialogContent className="max-w-3xl max-h-[90vh] overflow-hidden flex flex-col">
				<DialogHeader>
					<DialogTitle className="flex items-center gap-2">
						<Server className="h-5 w-5 text-purple-500" />
						Quality Settings for {instanceLabel}
					</DialogTitle>
					<DialogDescription>
						Customize quality settings for{" "}
						<strong className="text-foreground">{instanceLabel}</strong> only. Other instances using
						&ldquo;{templateName}&rdquo; will not be affected.
					</DialogDescription>
				</DialogHeader>

				<fieldset
					disabled={!initialReadConfirmed || isLoading || isSaving || awaitingReadback}
					className="flex-1 overflow-y-auto space-y-4 py-4"
				>
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
					{initialReadConfirmed && !isLoading && (
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
												You can still set up quality settings for this instance by loading from its
												current profile.
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
													: "border-border bg-background hover:border-border/80 hover:bg-card",
											)}
										>
											<div className="flex items-center gap-2">
												<div
													className={cn(
														"flex h-5 w-5 items-center justify-center rounded-full border-2",
														mode === "default"
															? "border-primary bg-primary text-white"
															: "border-border",
													)}
												>
													{mode === "default" && <Check className="h-3 w-3" />}
												</div>
												<span className="text-sm font-medium text-foreground">
													Use Template Default
												</span>
											</div>
											<p className="text-xs text-muted-foreground pl-7">
												Same as other instances using this template.
											</p>
										</button>

										{/* Use Custom Override */}
										<button
											type="button"
											onClick={() => mode === "default" && enableOverride()}
											disabled={isSaving || awaitingReadback}
											className={cn(
												"flex flex-col items-start gap-2 rounded-lg border p-4 text-left transition",
												mode === "override"
													? "border-purple-500 bg-purple-500/5 ring-1 ring-purple-500/30"
													: "border-border bg-background hover:border-border/80 hover:bg-card",
											)}
										>
											<div className="flex items-center gap-2">
												<div
													className={cn(
														"flex h-5 w-5 items-center justify-center rounded-full border-2",
														mode === "override"
															? "border-purple-500 bg-purple-500 text-white"
															: "border-border",
													)}
												>
													{mode === "override" && <Check className="h-3 w-3" />}
												</div>
												<span className="text-sm font-medium text-foreground">
													Customize for This Instance
												</span>
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
				</fieldset>

				<DialogFooter className="border-t border-border pt-4">
					<div className="flex items-center justify-between w-full">
						<div className="flex items-center gap-2">
							{hasChanges && (
								<span className="text-xs text-amber-600 dark:text-amber-400">Unsaved changes</span>
							)}
						</div>
						<div className="flex items-center gap-2">
							{!initialReadConfirmed && (
								<Button variant="ghost" onClick={loadInitialOverride} disabled={isLoading}>
									Retry loading
								</Button>
							)}
							{awaitingReadback && (
								<Button variant="ghost" onClick={retryReadback} disabled={isSaving}>
									Retry readback
								</Button>
							)}
							{initialReadConfirmed && hasOverride && mode === "override" && (
								<Button
									variant="ghost"
									onClick={resetToDefault}
									disabled={isSaving || awaitingReadback}
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
							{initialReadConfirmed &&
								((mode === "override" && hasTemplateQualityConfig) ||
									(!hasTemplateQualityConfig && config.items.length > 0)) && (
									<Button
										variant="primary"
										onClick={saveOverride}
										disabled={isSaving || awaitingReadback || !hasChanges}
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
