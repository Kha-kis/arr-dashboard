"use client";

/**
 * Bulk Deployment Modal
 *
 * Premium modal for deploying templates to multiple instances with:
 * - SEMANTIC_COLORS for status indicators
 * - Theme-aware styling using THEME_GRADIENTS
 * - Glassmorphic content cards
 */

import { useState, useEffect, useMemo } from "react";
import {
	LegacyDialog,
	LegacyDialogHeader,
	LegacyDialogTitle,
	LegacyDialogDescription,
	LegacyDialogContent,
	LegacyDialogFooter,
	LegacyDialogClose,
} from "../../../components/ui";
import { Button } from "../../../components/ui";
import {
	AlertCircle,
	CheckCircle2,
	Server,
	Layers,
	AlertTriangle,
	Rocket,
	RefreshCw,
	Bell,
	Hand,
	ChevronDown,
	Loader2,
} from "lucide-react";
import { useBulkDeploymentPreviews, useExecuteBulkDeployment } from "../../../hooks/api/useDeploymentPreview";
import { cn } from "../../../lib/utils";
import { THEME_GRADIENTS, SEMANTIC_COLORS } from "../../../lib/theme-gradients";
import { useColorTheme } from "../../../providers/color-theme-provider";

type SyncStrategy = "auto" | "manual" | "notify";

interface InstancePreview {
	instanceId: string;
	instanceLabel: string;
	selected: boolean;
	syncStrategy: SyncStrategy;
	preview?: {
		reachable: boolean;
		totalItems: number;
		newCustomFormats: number;
		updatedCustomFormats: number;
		conflicts: number;
		canDeploy: boolean;
	};
	loading: boolean;
	error?: Error;
}

interface BulkDeploymentModalProps {
	open: boolean;
	onClose: () => void;
	templateId: string | null;
	templateName?: string;
	instances: Array<{
		instanceId: string;
		instanceLabel: string;
		instanceType: string;
	}>;
	onDeploySuccess?: () => void;
}

const syncStrategyOptions: Array<{ value: SyncStrategy; label: string; icon: typeof RefreshCw; colorKey: keyof typeof SEMANTIC_COLORS }> = [
	{ value: "auto", label: "Auto-sync", icon: RefreshCw, colorKey: "success" },
	{ value: "notify", label: "Notify", icon: Bell, colorKey: "info" },
	{ value: "manual", label: "Manual", icon: Hand, colorKey: "warning" },
];

// Compact sync strategy selector for each instance row
const SyncStrategySelector = ({
	value,
	onChange,
	disabled,
}: {
	value: SyncStrategy;
	onChange: (strategy: SyncStrategy) => void;
	disabled?: boolean;
}) => {
	const { colorTheme } = useColorTheme();
	const themeGradient = THEME_GRADIENTS[colorTheme];
	const [isOpen, setIsOpen] = useState(false);
	const current = syncStrategyOptions.find((opt) => opt.value === value) ?? syncStrategyOptions[0]!;
	const Icon = current.icon;
	const color = SEMANTIC_COLORS[current.colorKey];

	return (
		<div className="relative">
			<button
				type="button"
				onClick={() => !disabled && setIsOpen(!isOpen)}
				disabled={disabled}
				className={cn(
					"flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs font-medium transition-all duration-200",
					"border-border/50 bg-card/50 backdrop-blur-sm hover:bg-card/80",
					disabled && "opacity-50 cursor-not-allowed"
				)}
			>
				<Icon className="h-3 w-3" style={{ color: color.from }} />
				<span className="text-foreground">{current.label}</span>
				<ChevronDown className="h-3 w-3 text-muted-foreground" />
			</button>

			{isOpen && (
				<>
					{/* Backdrop */}
					<div className="fixed inset-0 z-40" onClick={() => setIsOpen(false)} />
					{/* Dropdown */}
					<div
						className="absolute right-0 top-full mt-1 z-50 rounded-xl border border-border/50 bg-card/95 backdrop-blur-xl shadow-xl min-w-[130px] overflow-hidden"
						style={{
							boxShadow: `0 10px 40px -10px rgba(0, 0, 0, 0.3), 0 0 0 1px ${themeGradient.from}10`,
						}}
					>
						{syncStrategyOptions.map((option) => {
							const OptionIcon = option.icon;
							const optColor = SEMANTIC_COLORS[option.colorKey];
							return (
								<button
									key={option.value}
									type="button"
									onClick={() => {
										onChange(option.value);
										setIsOpen(false);
									}}
									className={cn(
										"flex w-full items-center gap-2 px-3 py-2.5 text-xs transition-colors",
										option.value === value
											? "bg-card/80"
											: "hover:bg-card/50"
									)}
								>
									<OptionIcon className="h-3.5 w-3.5" style={{ color: optColor.from }} />
									<span className="text-foreground">{option.label}</span>
								</button>
							);
						})}
					</div>
				</>
			)}
		</div>
	);
};

export const BulkDeploymentModal = ({
	open,
	onClose,
	templateId,
	templateName,
	instances,
	onDeploySuccess,
}: BulkDeploymentModalProps) => {
	const { colorTheme } = useColorTheme();
	const themeGradient = THEME_GRADIENTS[colorTheme];
	// Track selection state and sync strategies per instance
	const [selectedInstances, setSelectedInstances] = useState<Set<string>>(new Set());
	const [syncStrategies, setSyncStrategies] = useState<Record<string, SyncStrategy>>({});

	// Get all instance IDs for the bulk preview query
	const allInstanceIds = useMemo(() => instances.map((i) => i.instanceId), [instances]);

	// Use React Query hook for fetching all previews in parallel
	const { results: previewResults, isLoading: isLoadingPreviews } = useBulkDeploymentPreviews(
		open ? templateId : null, // Only fetch when modal is open
		open ? allInstanceIds : [], // Only fetch when modal is open
	);

	// Use React Query mutation for bulk deployment
	const bulkDeployMutation = useExecuteBulkDeployment();

	// Build combined instance preview data from React Query results
	const instancePreviews: InstancePreview[] = useMemo(() => {
		return instances.map((inst) => {
			const result = previewResults.find((r) => r.instanceId === inst.instanceId);
			const preview = result?.data?.data;

			return {
				instanceId: inst.instanceId,
				instanceLabel: inst.instanceLabel,
				selected: selectedInstances.has(inst.instanceId),
				syncStrategy: syncStrategies[inst.instanceId] ?? "notify",
				loading: result?.isLoading ?? true,
				error: result?.error ?? undefined,
				preview: preview
					? {
							reachable: preview.instanceReachable,
							totalItems: preview.summary.totalItems,
							newCustomFormats: preview.summary.newCustomFormats,
							updatedCustomFormats: preview.summary.updatedCustomFormats,
							conflicts: preview.summary.totalConflicts,
							canDeploy: preview.canDeploy,
						}
					: undefined,
			};
		});
	}, [instances, previewResults, selectedInstances, syncStrategies]);

	// Initialize selection state when modal opens
	useEffect(() => {
		if (open && instances.length > 0) {
			// Select all instances by default
			setSelectedInstances(new Set(instances.map((i) => i.instanceId)));
			// Initialize sync strategies
			const strategies: Record<string, SyncStrategy> = {};
			for (const inst of instances) {
				strategies[inst.instanceId] = "notify";
			}
			setSyncStrategies(strategies);
		}
	}, [open, instances]);

	// Reset state when modal closes
	useEffect(() => {
		if (!open) {
			setSelectedInstances(new Set());
			setSyncStrategies({});
			bulkDeployMutation.reset();
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps -- Intentionally exclude bulkDeployMutation to avoid reset loops
	}, [open]);

	const toggleInstance = (instanceId: string) => {
		setSelectedInstances((prev) => {
			const next = new Set(prev);
			if (next.has(instanceId)) {
				next.delete(instanceId);
			} else {
				next.add(instanceId);
			}
			return next;
		});
	};

	const updateInstanceStrategy = (instanceId: string, strategy: SyncStrategy) => {
		setSyncStrategies((prev) => ({
			...prev,
			[instanceId]: strategy,
		}));
	};

	const setAllStrategies = (strategy: SyncStrategy) => {
		setSyncStrategies((prev) => {
			const next: Record<string, SyncStrategy> = {};
			for (const id of Object.keys(prev)) {
				next[id] = strategy;
			}
			return next;
		});
	};

	const selectAll = () => {
		setSelectedInstances(new Set(instances.map((i) => i.instanceId)));
	};

	const deselectAll = () => {
		setSelectedInstances(new Set());
	};

	const handleDeploy = () => {
		if (!templateId) return;

		const deployableInstances = instancePreviews.filter(
			(inst) => inst.selected && inst.preview?.canDeploy,
		);

		if (deployableInstances.length === 0) return;

		// Build per-instance sync strategies map
		const instanceSyncStrategies: Record<string, SyncStrategy> = {};
		for (const inst of deployableInstances) {
			instanceSyncStrategies[inst.instanceId] = inst.syncStrategy;
		}

		bulkDeployMutation.mutate(
			{
				templateId,
				instanceIds: deployableInstances.map((inst) => inst.instanceId),
				instanceSyncStrategies,
			},
			{
				onSuccess: (response) => {
					if (response.success) {
						// Notify parent component of success
						onDeploySuccess?.();
						// Close after showing success message for 2 seconds
						setTimeout(() => {
							onClose();
						}, 2000);
					}
				},
			},
		);
	};

	const selectedCount = instancePreviews.filter((inst) => inst.selected).length;
	const previewsLoading = instancePreviews.some((inst) => inst.selected && inst.loading);
	const allPreviewsLoaded =
		selectedCount > 0 &&
		instancePreviews.filter((inst) => inst.selected).every((inst) => inst.preview && !inst.loading);
	const deployableCount = instancePreviews.filter((inst) => inst.selected && inst.preview?.canDeploy).length;

	const totalChanges = instancePreviews
		.filter((inst) => inst.selected && inst.preview)
		.reduce((sum, inst) => sum + (inst.preview?.totalItems || 0), 0);

	// Can deploy if at least one selected instance can be deployed
	const canDeploy = deployableCount > 0 && !previewsLoading;

	return (
		<LegacyDialog open={open} onOpenChange={onClose} size="xl">
			<LegacyDialogClose onClick={onClose} />
			<LegacyDialogHeader
				icon={<Layers className="h-6 w-6" style={{ color: themeGradient.from }} />}
			>
				<div>
					<LegacyDialogTitle>Bulk Deployment</LegacyDialogTitle>
					<LegacyDialogDescription>
						Deploy template to multiple instances at once
						{templateName && ` - Template: "${templateName}"`}
					</LegacyDialogDescription>
				</div>
			</LegacyDialogHeader>

			<LegacyDialogContent className="space-y-5">
				{/* Instance Selection with Per-Instance Strategy */}
				<div className="rounded-xl border border-border/50 bg-card/30 backdrop-blur-sm p-4">
					<div className="flex items-center justify-between mb-3">
						<h3 className="text-sm font-semibold text-foreground">
							Select Instances ({selectedCount} / {instancePreviews.length})
						</h3>
						<div className="flex items-center gap-3">
							{/* Bulk strategy setter */}
							<div className="flex items-center gap-2 text-xs text-muted-foreground">
								<span>Set all:</span>
								{syncStrategyOptions.map((opt) => {
									const Icon = opt.icon;
									const color = SEMANTIC_COLORS[opt.colorKey];
									return (
										<button
											key={opt.value}
											type="button"
											onClick={() => setAllStrategies(opt.value)}
											className="p-1.5 rounded-lg hover:bg-card/50 transition-colors"
											title={`Set all to ${opt.label}`}
										>
											<Icon className="h-3.5 w-3.5" style={{ color: color.from }} />
										</button>
									);
								})}
							</div>
							<span className="text-muted-foreground/30">|</span>
							<div className="flex gap-2">
								<button
									type="button"
									onClick={selectAll}
									className="text-xs font-medium transition-colors hover:opacity-80"
									style={{ color: themeGradient.from }}
								>
									Select All
								</button>
								<span className="text-xs text-muted-foreground/30">|</span>
								<button
									type="button"
									onClick={deselectAll}
									className="text-xs text-muted-foreground hover:text-foreground transition-colors"
								>
									Deselect All
								</button>
							</div>
						</div>
					</div>

					<div className="space-y-2 max-h-64 overflow-y-auto pr-1">
						{instancePreviews.map((inst) => (
							<div
								key={inst.instanceId}
								className="flex items-center gap-3 p-3 rounded-xl border transition-all duration-200"
								style={{
									borderColor: inst.selected ? `${themeGradient.from}40` : "hsl(var(--border) / 0.5)",
									backgroundColor: inst.selected ? `${themeGradient.from}08` : "transparent",
								}}
							>
								{/* Checkbox */}
								<input
									type="checkbox"
									checked={inst.selected}
									onChange={() => toggleInstance(inst.instanceId)}
									className="w-4 h-4 rounded border-border/50 cursor-pointer"
								/>

								{/* Instance info */}
								<Server className="h-4 w-4 text-muted-foreground shrink-0" />
								<span className="text-sm font-medium text-foreground flex-1 min-w-0 truncate">
									{inst.instanceLabel}
								</span>

								{/* Preview status */}
								{inst.loading && (
									<Loader2 className="h-4 w-4 animate-spin shrink-0" style={{ color: themeGradient.from }} />
								)}

								{inst.preview && (
									<div className="flex items-center gap-2 text-xs shrink-0">
										{inst.preview.reachable ? (
											<>
												<span style={{ color: SEMANTIC_COLORS.success.text }}>
													{inst.preview.totalItems} changes
												</span>
												{inst.preview.conflicts > 0 && (
													<span style={{ color: SEMANTIC_COLORS.warning.text }}>
														{inst.preview.conflicts} conflicts
													</span>
												)}
											</>
										) : (
											<span style={{ color: SEMANTIC_COLORS.error.text }}>Unreachable</span>
										)}
									</div>
								)}

								{inst.error && (
									<span className="text-xs shrink-0" style={{ color: SEMANTIC_COLORS.error.text }}>Error</span>
								)}

								{/* Per-instance sync strategy selector */}
								{inst.selected && (
									<SyncStrategySelector
										value={inst.syncStrategy}
										onChange={(strategy) => updateInstanceStrategy(inst.instanceId, strategy)}
										disabled={!inst.preview?.canDeploy}
									/>
								)}
							</div>
						))}
					</div>
				</div>

				{/* Summary Statistics */}
				{allPreviewsLoaded && (
					<div className="rounded-xl border border-border/50 bg-card/30 backdrop-blur-sm p-4">
						<h3 className="text-sm font-semibold text-foreground mb-3">Deployment Summary</h3>
						<div className="grid grid-cols-2 md:grid-cols-4 gap-4">
							<div className="space-y-1">
								<p className="text-xs text-muted-foreground">Total Instances</p>
								<p className="text-2xl font-semibold text-foreground">{selectedCount}</p>
							</div>
							<div className="space-y-1">
								<p className="text-xs text-muted-foreground">Total Changes</p>
								<p className="text-2xl font-semibold text-foreground">{totalChanges}</p>
							</div>
							<div className="space-y-1">
								<p className="text-xs" style={{ color: SEMANTIC_COLORS.success.text }}>New CFs</p>
								<p className="text-2xl font-semibold" style={{ color: SEMANTIC_COLORS.success.from }}>
									{instancePreviews
										.filter((inst) => inst.selected && inst.preview)
										.reduce(
											(sum, inst) => sum + (inst.preview?.newCustomFormats || 0),
											0,
										)}
								</p>
							</div>
							<div className="space-y-1">
								<p className="text-xs" style={{ color: themeGradient.from }}>Updates</p>
								<p className="text-2xl font-semibold" style={{ color: themeGradient.from }}>
									{instancePreviews
										.filter((inst) => inst.selected && inst.preview)
										.reduce(
											(sum, inst) => sum + (inst.preview?.updatedCustomFormats || 0),
											0,
										)}
								</p>
							</div>
						</div>

						{!canDeploy && selectedCount > 0 && (
							<div
								className="mt-3 pt-3 border-t border-border/30 flex items-center gap-2 text-sm"
								style={{ color: SEMANTIC_COLORS.warning.text }}
							>
								<AlertTriangle className="h-4 w-4" style={{ color: SEMANTIC_COLORS.warning.from }} />
								<span>Some instances have conflicts or are unreachable</span>
							</div>
						)}
					</div>
				)}
			</LegacyDialogContent>

			<LegacyDialogFooter>
				{bulkDeployMutation.isError && (
					<div
						className="flex items-start gap-2 rounded-xl p-3 mr-auto"
						style={{
							backgroundColor: SEMANTIC_COLORS.error.bg,
							border: `1px solid ${SEMANTIC_COLORS.error.border}`,
						}}
					>
						<AlertCircle className="h-5 w-5 mt-0.5 shrink-0" style={{ color: SEMANTIC_COLORS.error.from }} />
						<div>
							<p className="text-sm font-medium" style={{ color: SEMANTIC_COLORS.error.text }}>Deployment Failed</p>
							<p className="text-sm mt-1 opacity-80" style={{ color: SEMANTIC_COLORS.error.text }}>
								{bulkDeployMutation.error?.message ?? "Failed to execute bulk deployment"}
							</p>
						</div>
					</div>
				)}
				{bulkDeployMutation.isSuccess && !bulkDeployMutation.data?.success && (
					<div
						className="flex items-start gap-2 rounded-xl p-3 mr-auto"
						style={{
							backgroundColor: SEMANTIC_COLORS.error.bg,
							border: `1px solid ${SEMANTIC_COLORS.error.border}`,
						}}
					>
						<AlertCircle className="h-5 w-5 mt-0.5 shrink-0" style={{ color: SEMANTIC_COLORS.error.from }} />
						<div>
							<p className="text-sm font-medium" style={{ color: SEMANTIC_COLORS.error.text }}>Deployment Partially Failed</p>
							<p className="text-sm mt-1 opacity-80" style={{ color: SEMANTIC_COLORS.error.text }}>
								{bulkDeployMutation.data?.result.failedInstances} of{" "}
								{bulkDeployMutation.data?.result.totalInstances} deployments failed
							</p>
						</div>
					</div>
				)}
				{bulkDeployMutation.isSuccess && bulkDeployMutation.data?.success && (
					<div
						className="flex items-start gap-2 rounded-xl p-3 mr-auto"
						style={{
							backgroundColor: SEMANTIC_COLORS.success.bg,
							border: `1px solid ${SEMANTIC_COLORS.success.border}`,
						}}
					>
						<CheckCircle2 className="h-5 w-5 mt-0.5 shrink-0" style={{ color: SEMANTIC_COLORS.success.from }} />
						<div>
							<p className="text-sm font-medium" style={{ color: SEMANTIC_COLORS.success.text }}>Deployment Successful</p>
							<p className="text-sm mt-1 opacity-80" style={{ color: SEMANTIC_COLORS.success.text }}>Custom Formats deployed to all selected instances</p>
						</div>
					</div>
				)}
				<Button
					variant="outline"
					onClick={onClose}
					disabled={bulkDeployMutation.isPending}
					className="rounded-xl"
				>
					Cancel
				</Button>
				<Button
					onClick={handleDeploy}
					disabled={!canDeploy || bulkDeployMutation.isPending || bulkDeployMutation.isSuccess}
					className="gap-2 rounded-xl font-medium"
					style={
						canDeploy && !bulkDeployMutation.isPending && !bulkDeployMutation.isSuccess
							? {
									background: `linear-gradient(135deg, ${themeGradient.from}, ${themeGradient.to})`,
									boxShadow: `0 4px 12px -4px ${themeGradient.glow}`,
								}
							: undefined
					}
				>
					{previewsLoading ? (
						<>
							<Loader2 className="h-4 w-4 animate-spin" />
							Loading Previews...
						</>
					) : bulkDeployMutation.isPending ? (
						<>
							<Loader2 className="h-4 w-4 animate-spin" />
							Deploying to {deployableCount} Instance{deployableCount !== 1 ? "s" : ""}...
						</>
					) : (
						<>
							<Rocket className="h-4 w-4" />
							Deploy to {deployableCount} Instance{deployableCount !== 1 ? "s" : ""}
						</>
					)}
				</Button>
			</LegacyDialogFooter>
		</LegacyDialog>
	);
};
