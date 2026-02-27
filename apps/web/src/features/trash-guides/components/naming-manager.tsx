"use client";

import type { ServiceInstanceSummary } from "@arr/shared";
import type { NamingFieldComparison, NamingPresetsResponse } from "@arr/shared";
import {
	AlertCircle,
	AlertTriangle,
	CheckCircle2,
	FileType,
	Loader2,
	Server,
	Trash2,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { GlassmorphicCard, ServiceBadge } from "../../../components/layout/premium-components";
import {
	useApplyNaming,
	useDeleteNamingConfig,
	useNamingConfig,
	useNamingPresets,
	useNamingPreview,
	useSaveNamingConfig,
} from "../../../hooks/api/useNaming";
import { useServicesQuery } from "../../../hooks/api/useServicesQuery";
import { useThemeGradient } from "../../../hooks/useThemeGradient";
import { getServiceGradient, SEMANTIC_COLORS } from "../../../lib/theme-gradients";
import { SyncStrategyControl } from "./sync-strategy-control";

// ============================================================================
// Types
// ============================================================================

type ServiceType = "RADARR" | "SONARR";

/** Maps a preset category key to its display label */
const RADARR_CATEGORIES: Array<{ key: "filePreset" | "folderPreset"; label: string }> = [
	{ key: "filePreset", label: "Movie File Naming" },
	{ key: "folderPreset", label: "Movie Folder Format" },
];

const SONARR_CATEGORIES: Array<{
	key:
		| "standardEpisodePreset"
		| "dailyEpisodePreset"
		| "animeEpisodePreset"
		| "seriesFolderPreset"
		| "seasonFolderPreset";
	label: string;
}> = [
	{ key: "standardEpisodePreset", label: "Standard Episode" },
	{ key: "dailyEpisodePreset", label: "Daily Episode" },
	{ key: "animeEpisodePreset", label: "Anime Episode" },
	{ key: "seriesFolderPreset", label: "Series Folder" },
	{ key: "seasonFolderPreset", label: "Season Folder" },
];

// ============================================================================
// Helpers
// ============================================================================

function ErrorBanner({ message }: { message: string }) {
	return (
		<div
			className="flex items-center gap-2 rounded-lg border px-4 py-3 text-sm"
			style={{
				borderColor: SEMANTIC_COLORS.error.border,
				backgroundColor: SEMANTIC_COLORS.error.bg,
				color: SEMANTIC_COLORS.error.text,
			}}
		>
			<AlertCircle className="h-4 w-4 shrink-0" />
			{message}
		</div>
	);
}

function getPresetsForCategory(
	presets: NamingPresetsResponse,
	category: string,
): Array<{ name: string; formatString: string }> {
	if (presets.serviceType === "RADARR") {
		const radarr = presets;
		if (category === "filePreset") return radarr.filePresets;
		if (category === "folderPreset") return radarr.folderPresets;
	} else {
		const sonarr = presets;
		if (category === "standardEpisodePreset") return sonarr.standardEpisodePresets;
		if (category === "dailyEpisodePreset") return sonarr.dailyEpisodePresets;
		if (category === "animeEpisodePreset") return sonarr.animeEpisodePresets;
		if (category === "seriesFolderPreset") return sonarr.seriesFolderPresets;
		if (category === "seasonFolderPreset") return sonarr.seasonFolderPresets;
	}
	return [];
}

// ============================================================================
// Sub-components
// ============================================================================

interface PresetSelectorProps {
	label: string;
	presetOptions: Array<{ name: string; formatString: string }>;
	selectedPreset: string | null;
	onSelect: (name: string | null) => void;
	disabled?: boolean;
	themeGradient: ReturnType<typeof useThemeGradient>["gradient"];
}

function PresetSelector({
	label,
	presetOptions,
	selectedPreset,
	onSelect,
	disabled,
	themeGradient,
}: PresetSelectorProps) {
	if (presetOptions.length === 0) {
		return (
			<div className="space-y-2">
				<label className="text-sm font-medium text-muted-foreground">{label}</label>
				<p className="text-xs text-muted-foreground italic">No presets available</p>
			</div>
		);
	}

	const selectedFormatString = presetOptions.find((p) => p.name === selectedPreset)?.formatString;

	return (
		<div className="space-y-2">
			<label className="text-sm font-medium text-muted-foreground">{label}</label>
			<div className="flex flex-wrap gap-2">
				{presetOptions.map((preset) => {
					const isSelected = selectedPreset === preset.name;
					return (
						<button
							key={preset.name}
							type="button"
							disabled={disabled}
							onClick={() => onSelect(isSelected ? null : preset.name)}
							className={`rounded-lg border px-3 py-2 text-sm transition-all ${
								isSelected
									? "ring-2"
									: "border-border/50 bg-card/30 hover:border-border/80 hover:bg-card/50"
							}`}
							style={
								isSelected
									? {
											borderColor: themeGradient.fromMuted,
											backgroundColor: themeGradient.fromLight,
											color: themeGradient.from,
										}
									: undefined
							}
							title={preset.formatString}
						>
							{preset.name}
						</button>
					);
				})}
			</div>
			{selectedFormatString && (
				<div className="rounded-md border border-border/30 bg-card/20 px-3 py-2 max-h-24 overflow-y-auto">
					<code className="text-xs text-muted-foreground break-all">
						{selectedFormatString}
					</code>
				</div>
			)}
		</div>
	);
}

// ============================================================================
// Preview Table
// ============================================================================

function PreviewTable({
	comparisons,
	themeGradient,
}: {
	comparisons: NamingFieldComparison[];
	themeGradient: ReturnType<typeof useThemeGradient>["gradient"];
}) {
	return (
		<GlassmorphicCard padding="none">
			<div className="overflow-x-auto">
				<table className="w-full text-sm">
					<thead>
						<tr className="border-b border-border/50">
							<th className="px-4 py-3 text-left font-medium text-muted-foreground">
								Field
							</th>
							<th className="px-4 py-3 text-left font-medium text-muted-foreground">
								Current
							</th>
							<th
								className="px-4 py-3 text-left font-medium"
								style={{ color: themeGradient.from }}
							>
								TRaSH Preset
							</th>
							<th className="px-4 py-3 text-center font-medium text-muted-foreground">
								Status
							</th>
						</tr>
					</thead>
					<tbody>
						{comparisons.map((row, idx) => (
							<tr
								key={row.arrApiField}
								className="border-b border-border/30 last:border-0 animate-in fade-in duration-200"
								style={{
									animationDelay: `${idx * 30}ms`,
									animationFillMode: "backwards",
								}}
							>
								<td className="px-4 py-2.5">
									<div>
										<div className="font-medium">{row.fieldGroup}</div>
										<div className="text-xs text-muted-foreground">
											{row.presetName}
										</div>
									</div>
								</td>
								<td className="px-4 py-2.5">
									<code className="text-xs text-muted-foreground break-all">
										{row.currentValue || "—"}
									</code>
								</td>
								<td className="px-4 py-2.5">
									<code
										className="text-xs break-all font-medium"
										style={
											row.changed
												? { color: SEMANTIC_COLORS.warning.text }
												: undefined
										}
									>
										{row.presetValue}
									</code>
								</td>
								<td className="px-4 py-2.5 text-center">
									{row.changed ? (
										<AlertTriangle
											className="h-4 w-4 mx-auto"
											style={{ color: SEMANTIC_COLORS.warning.text }}
										/>
									) : (
										<CheckCircle2
											className="h-4 w-4 mx-auto"
											style={{ color: SEMANTIC_COLORS.success.text }}
										/>
									)}
								</td>
							</tr>
						))}
					</tbody>
				</table>
			</div>
		</GlassmorphicCard>
	);
}

// ============================================================================
// Main Component
// ============================================================================

export function NamingManager() {
	const { gradient: themeGradient } = useThemeGradient();
	const { data: services, isLoading: servicesLoading, error: servicesError } = useServicesQuery();

	// Phase state
	const [selectedInstanceId, setSelectedInstanceId] = useState<string | null>(null);
	const [selections, setSelections] = useState<Record<string, string | null>>({});
	const [syncStrategy, setSyncStrategy] = useState<"auto" | "manual" | "notify">("manual");

	// Derived
	const selectedInstance = services?.find((s) => s.id === selectedInstanceId) ?? null;
	const serviceType: ServiceType | null =
		selectedInstance?.service === "sonarr"
			? "SONARR"
			: selectedInstance?.service === "radarr"
				? "RADARR"
				: null;

	// Data fetching
	const {
		data: presetsData,
		isLoading: presetsLoading,
		error: presetsError,
	} = useNamingPresets(serviceType ?? "RADARR", !!serviceType);
	const { data: configData } = useNamingConfig(selectedInstanceId ?? undefined, !!selectedInstanceId);
	const previewMutation = useNamingPreview();
	const applyMutation = useApplyNaming();
	const saveConfigMutation = useSaveNamingConfig();
	const deleteConfigMutation = useDeleteNamingConfig();

	const presets = presetsData?.presets ?? null;
	const categories = serviceType === "SONARR" ? SONARR_CATEGORIES : RADARR_CATEGORIES;

	// Count how many categories have a preset selected
	const selectedCount = useMemo(
		() => Object.values(selections).filter((v) => v != null).length,
		[selections],
	);

	const arrInstances =
		services?.filter(
			(s) => (s.service === "radarr" || s.service === "sonarr") && s.enabled,
		) ?? [];

	// ========================================================================
	// Handlers
	// ========================================================================

	function handleInstanceSelect(instance: ServiceInstanceSummary) {
		if (selectedInstanceId === instance.id) return;
		setSelectedInstanceId(instance.id);
		setSelections({});
		setSyncStrategy("manual");
		populatedForRef.current = null; // Allow auto-populate for new instance
		previewMutation.reset();
		applyMutation.reset();
	}

	function handlePresetChange(categoryKey: string, presetName: string | null) {
		setSelections((prev) => ({ ...prev, [categoryKey]: presetName }));
		previewMutation.reset();
		applyMutation.reset();
	}

	function buildSelectedPresets() {
		if (serviceType === "RADARR") {
			return {
				serviceType: "RADARR" as const,
				filePreset: selections.filePreset ?? null,
				folderPreset: selections.folderPreset ?? null,
			};
		}
		return {
			serviceType: "SONARR" as const,
			standardEpisodePreset: selections.standardEpisodePreset ?? null,
			dailyEpisodePreset: selections.dailyEpisodePreset ?? null,
			animeEpisodePreset: selections.animeEpisodePreset ?? null,
			seriesFolderPreset: selections.seriesFolderPreset ?? null,
			seasonFolderPreset: selections.seasonFolderPreset ?? null,
		};
	}

	function handlePreview() {
		if (!selectedInstanceId || !serviceType || selectedCount === 0) return;
		previewMutation.mutate({
			instanceId: selectedInstanceId,
			selectedPresets: buildSelectedPresets(),
		});
	}

	function handleApply() {
		if (!selectedInstanceId || !serviceType || selectedCount === 0) return;
		const presets = buildSelectedPresets();
		applyMutation.mutate(
			{ instanceId: selectedInstanceId, selectedPresets: presets },
			{
				onSuccess: () => {
					// Save config with sync strategy after successful apply
					saveConfigMutation.mutate({
						instanceId: selectedInstanceId,
						selectedPresets: presets,
						syncStrategy,
					});
				},
			},
		);
	}

	function handleSyncStrategyChange(newStrategy: "auto" | "manual" | "notify") {
		setSyncStrategy(newStrategy);
		// If there's already a saved config, persist the strategy change immediately
		if (configData?.config) {
			saveConfigMutation.mutate({
				instanceId: selectedInstanceId!,
				selectedPresets: buildSelectedPresets(),
				syncStrategy: newStrategy,
			});
		}
	}

	function handleDeleteConfig() {
		if (!selectedInstanceId) return;
		deleteConfigMutation.mutate(selectedInstanceId, {
			onSuccess: () => {
				setSelections({});
				setSyncStrategy("manual");
				populatedForRef.current = null;
				previewMutation.reset();
				applyMutation.reset();
			},
		});
	}

	// Auto-populate selections from saved config when config data arrives
	const populatedForRef = useRef<string | null>(null);

	useEffect(() => {
		const config = configData?.config;
		if (!config || config.instanceId !== selectedInstanceId) return;
		// Only auto-populate once per instance selection
		if (populatedForRef.current === selectedInstanceId) return;
		populatedForRef.current = selectedInstanceId;

		if (config.syncStrategy) {
			setSyncStrategy(config.syncStrategy);
		}
		const initial: Record<string, string | null> = {};
		const saved = config.selectedPresets;
		if (saved.serviceType === "RADARR") {
			initial.filePreset = saved.filePreset;
			initial.folderPreset = saved.folderPreset;
		} else {
			initial.standardEpisodePreset = saved.standardEpisodePreset;
			initial.dailyEpisodePreset = saved.dailyEpisodePreset;
			initial.animeEpisodePreset = saved.animeEpisodePreset;
			initial.seriesFolderPreset = saved.seriesFolderPreset;
			initial.seasonFolderPreset = saved.seasonFolderPreset;
		}
		setSelections(initial);
	}, [configData, selectedInstanceId]);

	// ========================================================================
	// Render
	// ========================================================================

	return (
		<div className="space-y-8">
			{/* Section Header */}
			<div className="flex items-center gap-3">
				<div
					className="flex h-10 w-10 items-center justify-center rounded-xl"
					style={{
						background: `linear-gradient(135deg, ${themeGradient.from}20, ${themeGradient.to}20)`,
					}}
				>
					<FileType className="h-5 w-5" style={{ color: themeGradient.from }} />
				</div>
				<div>
					<h2 className="text-lg font-semibold">Naming Schemes</h2>
					<p className="text-sm text-muted-foreground">
						Apply TRaSH Guides naming presets to your instances
					</p>
				</div>
			</div>

			{/* Phase 1: Instance Selection */}
			<div className="space-y-3">
				<h3 className="text-sm font-medium text-muted-foreground">Select Instance</h3>
				{servicesError ? (
					<ErrorBanner message={`Failed to load instances: ${servicesError.message}`} />
				) : servicesLoading ? (
					<div className="flex items-center gap-2 text-sm text-muted-foreground">
						<Loader2 className="h-4 w-4 animate-spin" />
						Loading instances...
					</div>
				) : arrInstances.length === 0 ? (
					<GlassmorphicCard padding="md">
						<p className="text-sm text-muted-foreground">
							No Radarr or Sonarr instances configured. Add an instance in Settings
							first.
						</p>
					</GlassmorphicCard>
				) : (
					<div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
						{arrInstances.map((instance, index) => {
							const isSelected = selectedInstanceId === instance.id;
							const gradient = getServiceGradient(instance.service);
							const hasSavedConfig =
								configData?.config?.instanceId === instance.id;

							return (
								<button
									key={instance.id}
									type="button"
									disabled={applyMutation.isPending}
									onClick={() => handleInstanceSelect(instance)}
									className={`group relative rounded-xl border p-4 text-left transition-all animate-in fade-in slide-in-from-bottom-2 duration-300 ${
										isSelected
											? "ring-2"
											: "border-border/50 bg-card/30 hover:border-border/80 hover:bg-card/50"
									}`}
									style={{
										animationDelay: `${index * 30}ms`,
										animationFillMode: "backwards",
										...(isSelected
											? {
													borderColor: themeGradient.fromMuted,
													backgroundColor: themeGradient.fromLight,
												}
											: {}),
									}}
								>
									<div className="flex items-center gap-3">
										<Server
											className="h-5 w-5 shrink-0"
											style={{
												color: isSelected
													? themeGradient.from
													: gradient.from,
											}}
										/>
										<div className="min-w-0 flex-1">
											<div className="flex items-center gap-2">
												<span className="text-sm font-medium truncate">
													{instance.label}
												</span>
												<ServiceBadge service={instance.service} />
											</div>
											{hasSavedConfig && (
												<span className="text-xs text-muted-foreground">
													Naming configured
												</span>
											)}
										</div>
									</div>
								</button>
							);
						})}
					</div>
				)}
			</div>

			{/* Phase 2: Preset Selection */}
			{selectedInstance && serviceType && (
				<div className="space-y-4 animate-in fade-in slide-in-from-bottom-2 duration-300">
					<h3 className="text-sm font-medium text-muted-foreground">
						Configure Naming Presets
					</h3>
					{presetsError ? (
						<ErrorBanner
							message={`Failed to load presets: ${presetsError.message}`}
						/>
					) : presetsLoading || !presets ? (
						<div className="flex items-center gap-2 text-sm text-muted-foreground">
							<Loader2 className="h-4 w-4 animate-spin" />
							Loading presets...
						</div>
					) : (
						<GlassmorphicCard padding="md">
							<div className="space-y-5">
								{categories.map((cat) => (
									<PresetSelector
										key={cat.key}
										label={cat.label}
										presetOptions={getPresetsForCategory(
											presets,
											cat.key,
										)}
										selectedPreset={
											(selections[cat.key] as string | undefined) ?? null
										}
										onSelect={(name) =>
											handlePresetChange(cat.key, name)
										}
										disabled={applyMutation.isPending}
										themeGradient={themeGradient}
									/>
								))}
							</div>
						</GlassmorphicCard>
					)}

					{/* Preview Button */}
					{selectedCount > 0 && (
						<div className="flex items-center gap-3">
							<button
								type="button"
								onClick={handlePreview}
								disabled={previewMutation.isPending}
								className="rounded-xl border border-border/50 bg-card/30 px-5 py-2.5 text-sm font-medium transition-all hover:border-border/80 hover:bg-card/50 disabled:opacity-50"
							>
								{previewMutation.isPending ? (
									<span className="flex items-center gap-2">
										<Loader2 className="h-4 w-4 animate-spin" />
										Loading preview...
									</span>
								) : (
									`Preview Changes (${selectedCount} ${selectedCount === 1 ? "field" : "fields"})`
								)}
							</button>
						</div>
					)}
				</div>
			)}

			{/* Sync Strategy + Delete Config */}
			{selectedInstance && selectedCount > 0 && (
				<div className="max-w-lg animate-in fade-in slide-in-from-bottom-2 duration-300 space-y-3">
					<SyncStrategyControl
						value={syncStrategy}
						onChange={handleSyncStrategyChange}
						disabled={applyMutation.isPending}
					/>
					{configData?.config && (
						<button
							type="button"
							onClick={handleDeleteConfig}
							disabled={deleteConfigMutation.isPending}
							className="flex items-center gap-2 rounded-lg border px-3 py-2 text-xs transition-all hover:brightness-110 disabled:opacity-50"
							style={{
								borderColor: SEMANTIC_COLORS.error.border,
								color: SEMANTIC_COLORS.error.text,
								backgroundColor: SEMANTIC_COLORS.error.bg,
							}}
						>
							<Trash2 className="h-3.5 w-3.5" />
							{deleteConfigMutation.isPending ? "Removing..." : "Remove Saved Config"}
						</button>
					)}
				</div>
			)}

			{/* Phase 3: Preview Results */}
			{previewMutation.data?.preview && (
				<div className="space-y-4 animate-in fade-in slide-in-from-bottom-2 duration-300">
					<div className="flex items-center justify-between">
						<h3 className="text-sm font-medium text-muted-foreground">
							Preview Changes
						</h3>
						<div className="flex items-center gap-4 text-xs text-muted-foreground">
							<span className="flex items-center gap-1">
								<CheckCircle2
									className="h-3.5 w-3.5"
									style={{ color: SEMANTIC_COLORS.success.text }}
								/>
								{previewMutation.data.preview.unchangedCount} unchanged
							</span>
							<span className="flex items-center gap-1">
								<AlertTriangle
									className="h-3.5 w-3.5"
									style={{ color: SEMANTIC_COLORS.warning.text }}
								/>
								{previewMutation.data.preview.changedCount} changed
							</span>
						</div>
					</div>

					<PreviewTable
						comparisons={previewMutation.data.preview.comparisons}
						themeGradient={themeGradient}
					/>

					{/* Apply Button */}
					<div className="space-y-3">
						<div className="flex items-center gap-4">
							<button
								type="button"
								onClick={handleApply}
								disabled={
									applyMutation.isPending ||
									previewMutation.data.preview.changedCount === 0
								}
								className="rounded-xl px-6 py-2.5 text-sm font-medium text-white transition-all disabled:opacity-50 disabled:cursor-not-allowed hover:brightness-110"
								style={{
									background: `linear-gradient(135deg, ${themeGradient.from}, ${themeGradient.to})`,
								}}
							>
								{applyMutation.isPending ? (
									<span className="flex items-center gap-2">
										<Loader2 className="h-4 w-4 animate-spin" />
										Applying...
									</span>
								) : (
									`Apply to ${selectedInstance?.label ?? "Instance"}`
								)}
							</button>
							{previewMutation.data.preview.changedCount === 0 && (
								<span className="text-sm text-muted-foreground">
									All naming fields already match — no changes needed
								</span>
							)}
						</div>
						{applyMutation.isError && (
							<ErrorBanner
								message={`Apply failed: ${applyMutation.error.message}`}
							/>
						)}
						{applyMutation.isSuccess && (
							<div
								className="flex items-center gap-2 rounded-lg border px-4 py-3 text-sm"
								style={{
									borderColor: SEMANTIC_COLORS.success.border,
									backgroundColor: SEMANTIC_COLORS.success.bg,
									color: SEMANTIC_COLORS.success.text,
								}}
							>
								<CheckCircle2 className="h-4 w-4 shrink-0" />
								{applyMutation.data?.message ?? "Naming presets applied successfully."}
								{applyMutation.data?.warning && (
									<span className="ml-2 text-xs opacity-80">
										{applyMutation.data.warning}
									</span>
								)}
							</div>
						)}
					</div>
				</div>
			)}

			{/* Preview error */}
			{previewMutation.isError && (
				<ErrorBanner
					message={`Preview failed: ${previewMutation.error.message}`}
				/>
			)}
		</div>
	);
}
