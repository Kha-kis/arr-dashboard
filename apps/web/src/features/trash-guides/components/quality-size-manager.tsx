"use client";

import { useState } from "react";
import {
	Ruler,
	Server,
	CheckCircle2,
	AlertTriangle,
	AlertCircle,
	MinusCircle,
	RotateCcw,
	Loader2,
} from "lucide-react";
import { useServicesQuery } from "../../../hooks/api/useServicesQuery";
import {
	useQualitySizePresets,
	useQualitySizeMapping,
	useQualitySizePreview,
	useApplyQualitySize,
	useUpdateQualitySizeSyncStrategy,
} from "../../../hooks/api/useQualitySize";
import { SyncStrategyControl } from "./sync-strategy-control";
import {
	GlassmorphicCard,
	ServiceBadge,
} from "../../../components/layout/premium-components";
import { useThemeGradient } from "../../../hooks/useThemeGradient";
import { SEMANTIC_COLORS, getServiceGradient } from "../../../lib/theme-gradients";
import type { ServiceInstanceSummary } from "@arr/shared";

// ============================================================================
// Constants
// ============================================================================

const PRESET_LABELS: Record<string, string> = {
	movie: "Movie",
	series: "Series",
	anime: "Anime",
	"sqp-streaming": "SQP Streaming",
	"sqp-uhd": "SQP UHD",
};

const DEFAULT_PRESET_ID = "default";

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

// ============================================================================
// Component
// ============================================================================

export function QualitySizeManager() {
	const { gradient: themeGradient } = useThemeGradient();
	const { data: services, isLoading: servicesLoading, error: servicesError } = useServicesQuery();

	// Phase state
	const [selectedInstanceId, setSelectedInstanceId] = useState<string | null>(null);
	const [selectedPresetId, setSelectedPresetId] = useState<string | null>(null);
	const [syncStrategy, setSyncStrategy] = useState<"auto" | "manual" | "notify">("manual");

	// Derived: selected instance and its service type
	const selectedInstance = services?.find((s) => s.id === selectedInstanceId) ?? null;
	const serviceType =
		selectedInstance?.service === "sonarr"
			? ("SONARR" as const)
			: selectedInstance?.service === "radarr"
				? ("RADARR" as const)
				: null;

	// Data fetching
	const { data: presetsData, isLoading: presetsLoading, error: presetsError } = useQualitySizePresets(serviceType);
	const { data: mappingData, error: mappingError } = useQualitySizeMapping(selectedInstanceId);
	const previewPresetId = selectedPresetId === DEFAULT_PRESET_ID ? null : selectedPresetId;
	const { data: previewData, isLoading: previewLoading, error: previewError } = useQualitySizePreview(
		selectedInstanceId,
		previewPresetId,
	);
	const applyMutation = useApplyQualitySize();
	const syncStrategyMutation = useUpdateQualitySizeSyncStrategy();

	// Filtered instances: only Radarr and Sonarr
	const arrInstances = services?.filter(
		(s) => (s.service === "radarr" || s.service === "sonarr") && s.enabled,
	) ?? [];

	// Current mapping for the selected instance (independent of preset selection)
	const existingMapping = mappingData?.mapping ?? null;

	function handleInstanceSelect(instance: ServiceInstanceSummary) {
		if (selectedInstanceId === instance.id) return;
		setSelectedInstanceId(instance.id);
		setSelectedPresetId(null); // Reset preset when instance changes
		applyMutation.reset(); // Clear stale error/success state
	}

	function handlePresetSelect(trashId: string) {
		setSelectedPresetId(trashId);
		applyMutation.reset(); // Clear stale error/success state
		// If there's an existing mapping, use its sync strategy; otherwise default
		if (existingMapping?.presetTrashId === trashId) {
			setSyncStrategy(existingMapping.syncStrategy);
		} else {
			setSyncStrategy("manual");
		}
	}

	function handleApply() {
		if (!selectedInstanceId || !selectedPresetId) return;
		applyMutation.mutate({
			instanceId: selectedInstanceId,
			presetTrashId: selectedPresetId,
			syncStrategy,
		});
	}

	function handleSyncStrategyChange(newStrategy: "auto" | "manual" | "notify") {
		setSyncStrategy(newStrategy);
		// Only persist via PATCH if the selected preset matches the currently applied one
		if (existingMapping && existingMapping.presetTrashId === selectedPresetId) {
			syncStrategyMutation.mutate({
				instanceId: selectedInstanceId!,
				syncStrategy: newStrategy,
			});
		}
	}

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
					<Ruler className="h-5 w-5" style={{ color: themeGradient.from }} />
				</div>
				<div>
					<h2 className="text-lg font-semibold">Quality Size Definitions</h2>
					<p className="text-sm text-muted-foreground">
						Apply TRaSH Guides file size presets to your instances
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
							No Radarr or Sonarr instances configured. Add an instance in Settings first.
						</p>
					</GlassmorphicCard>
				) : (
					<div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
						{arrInstances.map((instance, index) => {
							const isSelected = selectedInstanceId === instance.id;
							const gradient = getServiceGradient(instance.service);

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
											style={{ color: isSelected ? themeGradient.from : gradient.from }}
										/>
										<div className="min-w-0 flex-1">
											<div className="flex items-center gap-2">
												<span className="text-sm font-medium truncate">{instance.label}</span>
												<ServiceBadge service={instance.service} />
											</div>
										</div>
									</div>
								</button>
							);
						})}
					</div>
				)}
			</div>

			{/* Phase 2: Preset Selection */}
			{selectedInstance && (
				<div
					className="space-y-3 animate-in fade-in slide-in-from-bottom-2 duration-300"
				>
					<h3 className="text-sm font-medium text-muted-foreground">Select Preset</h3>
					{presetsError ? (
						<ErrorBanner message={`Failed to load presets: ${presetsError.message}`} />
					) : presetsLoading ? (
						<div className="flex items-center gap-2 text-sm text-muted-foreground">
							<Loader2 className="h-4 w-4 animate-spin" />
							Loading presets...
						</div>
					) : !presetsData?.presets?.length ? (
						<GlassmorphicCard padding="md">
							<p className="text-sm text-muted-foreground">
								No quality size presets found for {serviceType}. Try refreshing the cache.
							</p>
						</GlassmorphicCard>
					) : (
						<div className="flex flex-wrap gap-3">
							{presetsData.presets.map((preset) => {
								const isSelected = selectedPresetId === preset.trash_id;
								const isCurrentlyApplied =
									existingMapping?.presetTrashId === preset.trash_id;

								return (
									<button
										key={preset.trash_id}
										type="button"
										disabled={applyMutation.isPending}
										onClick={() => handlePresetSelect(preset.trash_id)}
										className={`relative rounded-xl border px-5 py-3 text-sm font-medium transition-all ${
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
									>
										{PRESET_LABELS[preset.type] ?? preset.type}
										{isCurrentlyApplied && (
											<span className="ml-2 text-xs text-muted-foreground">(Applied)</span>
										)}
									</button>
								);
							})}
							{/* Default (factory reset) option */}
							<button
								type="button"
								disabled={applyMutation.isPending}
								onClick={() => handlePresetSelect(DEFAULT_PRESET_ID)}
								className={`relative flex items-center gap-2 rounded-xl border px-5 py-3 text-sm font-medium transition-all ${
									selectedPresetId === DEFAULT_PRESET_ID
										? "ring-2"
										: "border-border/50 bg-card/30 hover:border-border/80 hover:bg-card/50"
								}`}
								style={
									selectedPresetId === DEFAULT_PRESET_ID
										? {
												borderColor: themeGradient.fromMuted,
												backgroundColor: themeGradient.fromLight,
												color: themeGradient.from,
											}
										: undefined
								}
							>
								<RotateCcw className="h-3.5 w-3.5" />
								Default
								{!existingMapping && (
									<span className="ml-1 text-xs text-muted-foreground">(Current)</span>
								)}
							</button>
						</div>
					)}
				</div>
			)}

			{/* Mapping load error — show when we can't determine if a preset is already applied */}
			{mappingError && selectedInstance && (
				<ErrorBanner message={`Could not load current mapping: ${mappingError.message}. Applied preset status may be inaccurate.`} />
			)}

			{/* Sync Strategy (shown when a TRaSH preset is selected, not for "default") */}
			{selectedInstance && selectedPresetId && selectedPresetId !== DEFAULT_PRESET_ID && (
				<div className="max-w-lg animate-in fade-in slide-in-from-bottom-2 duration-300">
					<SyncStrategyControl
						value={syncStrategy}
						onChange={handleSyncStrategyChange}
						disabled={applyMutation.isPending}
					/>
				</div>
			)}

			{/* Phase 3a: Default reset confirmation */}
			{selectedPresetId === DEFAULT_PRESET_ID && (
				<div className="space-y-4 animate-in fade-in slide-in-from-bottom-2 duration-300">
					<GlassmorphicCard padding="md">
						<div className="flex items-start gap-3">
							<RotateCcw className="h-5 w-5 shrink-0 text-muted-foreground mt-0.5" />
							<div>
								<p className="text-sm font-medium">Reset to Factory Defaults</p>
								<p className="text-sm text-muted-foreground mt-1">
									This will restore all quality size definitions on{" "}
									<span className="font-medium text-foreground">{selectedInstance?.label}</span>{" "}
									to the original values set by {selectedInstance?.service === "sonarr" ? "Sonarr" : "Radarr"}.
									Any previously applied TRaSH preset will be removed.
								</p>
							</div>
						</div>
					</GlassmorphicCard>
					<button
						type="button"
						onClick={handleApply}
						disabled={applyMutation.isPending}
						className="rounded-xl px-6 py-2.5 text-sm font-medium text-white transition-all disabled:opacity-50 disabled:cursor-not-allowed hover:brightness-110"
						style={{
							background: `linear-gradient(135deg, ${themeGradient.from}, ${themeGradient.to})`,
						}}
					>
						{applyMutation.isPending ? (
							<span className="flex items-center gap-2">
								<Loader2 className="h-4 w-4 animate-spin" />
								Resetting...
							</span>
						) : (
							`Reset ${selectedInstance?.label ?? "Instance"} to Defaults`
						)}
					</button>
				</div>
			)}

			{/* Phase 3b: TRaSH preset preview + apply */}
			{selectedPresetId && selectedPresetId !== DEFAULT_PRESET_ID && (
				<div className="space-y-4 animate-in fade-in slide-in-from-bottom-2 duration-300">
					<div className="flex items-center justify-between">
						<h3 className="text-sm font-medium text-muted-foreground">Preview Changes</h3>
						{previewData?.summary && (
							<div className="flex items-center gap-4 text-xs text-muted-foreground">
								<span className="flex items-center gap-1">
									<CheckCircle2 className="h-3.5 w-3.5" style={{ color: SEMANTIC_COLORS.success.text }} />
									{previewData.summary.matched - previewData.summary.changed} unchanged
								</span>
								<span className="flex items-center gap-1">
									<AlertTriangle className="h-3.5 w-3.5" style={{ color: SEMANTIC_COLORS.warning.text }} />
									{previewData.summary.changed} changed
								</span>
								{previewData.summary.unmatched > 0 && (
									<span className="flex items-center gap-1">
										<MinusCircle className="h-3.5 w-3.5 text-muted-foreground" />
										{previewData.summary.unmatched} unmatched
									</span>
								)}
							</div>
						)}
					</div>

					{previewError ? (
						<ErrorBanner message={`Failed to load preview: ${previewError.message}`} />
					) : previewLoading ? (
						<div className="flex items-center gap-2 text-sm text-muted-foreground py-8 justify-center">
							<Loader2 className="h-4 w-4 animate-spin" />
							Comparing quality definitions...
						</div>
					) : previewData?.comparisons ? (
						<GlassmorphicCard padding="none">
							<div className="overflow-x-auto">
								<table className="w-full text-sm">
									<thead>
										<tr className="border-b border-border/50">
											<th className="px-4 py-3 text-left font-medium text-muted-foreground">Quality</th>
											<th className="px-4 py-3 text-right font-medium text-muted-foreground">Current Min</th>
											<th className="px-4 py-3 text-right font-medium text-muted-foreground">Current Preferred</th>
											<th className="px-4 py-3 text-right font-medium text-muted-foreground">Current Max</th>
											<th className="px-4 py-3 text-right font-medium" style={{ color: themeGradient.from }}>TRaSH Min</th>
											<th className="px-4 py-3 text-right font-medium" style={{ color: themeGradient.from }}>TRaSH Preferred</th>
											<th className="px-4 py-3 text-right font-medium" style={{ color: themeGradient.from }}>TRaSH Max</th>
											<th className="px-4 py-3 text-center font-medium text-muted-foreground">Status</th>
										</tr>
									</thead>
									<tbody>
										{previewData.comparisons.map((row, idx) => (
											<tr
												key={row.qualityName}
												className="border-b border-border/30 last:border-0 animate-in fade-in duration-200"
												style={{
													animationDelay: `${idx * 20}ms`,
													animationFillMode: "backwards",
												}}
											>
												<td className="px-4 py-2.5 font-medium">
													{row.instanceTitle ?? row.qualityName}
												</td>
												<td className="px-4 py-2.5 text-right tabular-nums text-muted-foreground">
													{row.current?.min ?? "—"}
												</td>
												<td className="px-4 py-2.5 text-right tabular-nums text-muted-foreground">
													{row.current?.preferred ?? "—"}
												</td>
												<td className="px-4 py-2.5 text-right tabular-nums text-muted-foreground">
													{row.current?.max ?? "—"}
												</td>
												<td
													className="px-4 py-2.5 text-right tabular-nums font-medium"
													style={row.changed ? { color: SEMANTIC_COLORS.warning.text } : undefined}
												>
													{row.trash.min}
												</td>
												<td
													className="px-4 py-2.5 text-right tabular-nums font-medium"
													style={row.changed ? { color: SEMANTIC_COLORS.warning.text } : undefined}
												>
													{row.trash.preferred}
												</td>
												<td
													className="px-4 py-2.5 text-right tabular-nums font-medium"
													style={row.changed ? { color: SEMANTIC_COLORS.warning.text } : undefined}
												>
													{row.trash.max}
												</td>
												<td className="px-4 py-2.5 text-center">
													{!row.matched ? (
														<MinusCircle className="h-4 w-4 mx-auto text-muted-foreground" />
													) : row.changed ? (
														<AlertTriangle className="h-4 w-4 mx-auto" style={{ color: SEMANTIC_COLORS.warning.text }} />
													) : (
														<CheckCircle2 className="h-4 w-4 mx-auto" style={{ color: SEMANTIC_COLORS.success.text }} />
													)}
												</td>
											</tr>
										))}
									</tbody>
								</table>
							</div>
						</GlassmorphicCard>
					) : null}

					{/* Apply Button */}
					{previewData && (
						<div className="space-y-3">
							<div className="flex items-center gap-4">
								<button
									type="button"
									onClick={handleApply}
									disabled={
										applyMutation.isPending ||
										previewData.summary.matched === 0 ||
										(previewData.summary.changed === 0 && existingMapping?.presetTrashId === selectedPresetId)
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
								{previewData.summary.changed === 0 && previewData.summary.matched > 0 && (
									<span className="text-sm text-muted-foreground">
										{existingMapping?.presetTrashId === selectedPresetId
											? "All values already match — no changes needed"
											: existingMapping
												? "Values match — applying will switch sync tracking to this preset"
												: "Values already match — applying will enable sync tracking"}
									</span>
								)}
							</div>
							{applyMutation.isError && (
								<ErrorBanner message={`Apply failed: ${applyMutation.error.message}`} />
							)}
						</div>
					)}
				</div>
			)}
		</div>
	);
}
