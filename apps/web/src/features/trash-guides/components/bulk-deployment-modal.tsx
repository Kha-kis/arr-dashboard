"use client";

import { useState, useEffect, useMemo } from "react";
import {
	Dialog,
	DialogHeader,
	DialogTitle,
	DialogDescription,
	DialogContent,
	DialogFooter,
} from "../../../components/ui/dialog";
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
	Sliders,
} from "lucide-react";
import { useBulkDeploymentPreviews, useExecuteBulkDeployment } from "../../../hooks/api/useDeploymentPreview";
import { cn } from "../../../lib/utils";
import { InstanceQualityOverrideModal } from "./instance-quality-override-modal";
import type { CustomQualityConfig, TemplateInstanceOverride } from "@arr/shared";

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
	serviceType?: "RADARR" | "SONARR";
	/** The template's default quality config (used for override editor) */
	templateDefaultQualityConfig?: CustomQualityConfig;
	instances: Array<{
		instanceId: string;
		instanceLabel: string;
		instanceType: string;
	}>;
	/** Map of instanceId to override info (from template.instanceOverrides) */
	instanceOverrides?: Record<string, TemplateInstanceOverride>;
	onDeploySuccess?: () => void;
}

const syncStrategyOptions: Array<{ value: SyncStrategy; label: string; icon: typeof RefreshCw; color: string }> = [
	{ value: "auto", label: "Auto-sync", icon: RefreshCw, color: "text-green-500" },
	{ value: "notify", label: "Notify", icon: Bell, color: "text-blue-500" },
	{ value: "manual", label: "Manual", icon: Hand, color: "text-amber-500" },
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
	const [isOpen, setIsOpen] = useState(false);
	const current = syncStrategyOptions.find((opt) => opt.value === value) ?? syncStrategyOptions[0]!;
	const Icon = current.icon;

	return (
		<div className="relative">
			<button
				type="button"
				onClick={() => !disabled && setIsOpen(!isOpen)}
				disabled={disabled}
				className={cn(
					"flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs font-medium transition",
					"border-border bg-bg hover:bg-bg-subtle",
					disabled && "opacity-50 cursor-not-allowed"
				)}
			>
				<Icon className={cn("h-3 w-3", current.color)} />
				<span className="text-fg">{current.label}</span>
				<ChevronDown className="h-3 w-3 text-fg-muted" />
			</button>

			{isOpen && (
				<>
					{/* Backdrop */}
					<div className="fixed inset-0 z-40" onClick={() => setIsOpen(false)} />
					{/* Dropdown */}
					<div className="absolute right-0 top-full mt-1 z-50 rounded-md border border-border bg-bg shadow-lg min-w-[120px]">
						{syncStrategyOptions.map((option) => {
							const OptionIcon = option.icon;
							return (
								<button
									key={option.value}
									type="button"
									onClick={() => {
										onChange(option.value);
										setIsOpen(false);
									}}
									className={cn(
										"flex w-full items-center gap-2 px-3 py-2 text-xs hover:bg-bg-subtle transition",
										option.value === value && "bg-bg-subtle"
									)}
								>
									<OptionIcon className={cn("h-3.5 w-3.5", option.color)} />
									<span className="text-fg">{option.label}</span>
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
	serviceType,
	templateDefaultQualityConfig,
	instances,
	instanceOverrides,
	onDeploySuccess,
}: BulkDeploymentModalProps) => {
	// Track selection state and sync strategies per instance
	const [selectedInstances, setSelectedInstances] = useState<Set<string>>(new Set());
	const [syncStrategies, setSyncStrategies] = useState<Record<string, SyncStrategy>>({});
	// Quality override editor state
	const [editingQualityOverride, setEditingQualityOverride] = useState<{
		instanceId: string;
		instanceLabel: string;
	} | null>(null);

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
		<Dialog open={open} onOpenChange={onClose} size="xl">
			<DialogHeader>
				<DialogTitle>
					<div className="flex items-center gap-2">
						<Layers className="h-5 w-5" />
						Bulk Deployment
					</div>
				</DialogTitle>
				<DialogDescription>
					Deploy template to multiple instances at once
					{templateName && ` - Template: "${templateName}"`}
				</DialogDescription>
			</DialogHeader>

			<DialogContent className="space-y-4">
				{/* Instance Selection with Per-Instance Strategy */}
				<div className="rounded-lg border border-border bg-bg-subtle p-4">
					<div className="flex items-center justify-between mb-3">
						<h3 className="text-sm font-medium text-fg">
							Select Instances ({selectedCount} / {instancePreviews.length})
						</h3>
						<div className="flex items-center gap-3">
							{/* Bulk strategy setter */}
							<div className="flex items-center gap-2 text-xs text-fg-muted">
								<span>Set all:</span>
								{syncStrategyOptions.map((opt) => {
									const Icon = opt.icon;
									return (
										<button
											key={opt.value}
											type="button"
											onClick={() => setAllStrategies(opt.value)}
											className={cn(
												"p-1 rounded hover:bg-bg transition",
												"hover:ring-1 hover:ring-border"
											)}
											title={`Set all to ${opt.label}`}
										>
											<Icon className={cn("h-3.5 w-3.5", opt.color)} />
										</button>
									);
								})}
							</div>
							<span className="text-fg-muted">|</span>
							<div className="flex gap-2">
								<button
									type="button"
									onClick={selectAll}
									className="text-xs text-primary hover:underline"
								>
									Select All
								</button>
								<span className="text-xs text-fg-muted">|</span>
								<button
									type="button"
									onClick={deselectAll}
									className="text-xs text-fg-muted hover:underline"
								>
									Deselect All
								</button>
							</div>
						</div>
					</div>

					<div className="space-y-2 max-h-64 overflow-y-auto">
						{instancePreviews.map((inst) => (
							<div
								key={inst.instanceId}
								className={cn(
									"flex items-center gap-3 p-3 rounded-lg border transition",
									inst.selected
										? "border-primary/30 bg-primary/5"
										: "border-border bg-bg",
								)}
							>
								{/* Checkbox */}
								<input
									type="checkbox"
									checked={inst.selected}
									onChange={() => toggleInstance(inst.instanceId)}
									className="w-4 h-4 rounded border-border cursor-pointer"
								/>

								{/* Instance info */}
								<Server className="h-4 w-4 text-fg-muted shrink-0" />
								<span className="text-sm font-medium text-fg flex-1 min-w-0 truncate">
									{inst.instanceLabel}
								</span>

								{/* Quality config override indicator/button */}
								{templateDefaultQualityConfig?.useCustomQualities && templateId && serviceType && (
									<button
										type="button"
										onClick={() => setEditingQualityOverride({
											instanceId: inst.instanceId,
											instanceLabel: inst.instanceLabel,
										})}
										className={cn(
											"flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium shrink-0 transition-colors",
											instanceOverrides?.[inst.instanceId]?.qualityConfigOverride
												? "bg-purple-500/10 text-purple-600 dark:text-purple-400 hover:bg-purple-500/20"
												: "bg-bg-subtle border border-dashed border-border text-fg-muted hover:bg-bg-hover hover:border-primary/30"
										)}
										title={instanceOverrides?.[inst.instanceId]?.qualityConfigOverride
											? "Click to edit custom quality configuration"
											: "Click to customize quality configuration for this instance"
										}
									>
										<Sliders className="h-3 w-3" />
										{instanceOverrides?.[inst.instanceId]?.qualityConfigOverride
											? "Custom Quality"
											: "Customize"
										}
									</button>
								)}

								{/* Preview status */}
								{inst.loading && (
									<div className="h-4 w-4 animate-spin rounded-full border-2 border-primary border-t-transparent shrink-0" />
								)}

								{inst.preview && (
									<div className="flex items-center gap-2 text-xs shrink-0">
										{inst.preview.reachable ? (
											<>
												<span className="text-green-600 dark:text-green-400">
													{inst.preview.totalItems} changes
												</span>
												{inst.preview.conflicts > 0 && (
													<span className="text-amber-600 dark:text-amber-400">
														{inst.preview.conflicts} conflicts
													</span>
												)}
											</>
										) : (
											<span className="text-red-600 dark:text-red-400">Unreachable</span>
										)}
									</div>
								)}

								{inst.error && (
									<span className="text-xs text-red-600 dark:text-red-400 shrink-0">Error</span>
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
					<div className="rounded-lg border border-border bg-bg-subtle p-4">
						<h3 className="text-sm font-medium text-fg mb-3">Deployment Summary</h3>
						<div className="grid grid-cols-2 md:grid-cols-4 gap-4">
							<div className="space-y-1">
								<p className="text-xs text-fg-muted">Total Instances</p>
								<p className="text-2xl font-semibold text-fg">{selectedCount}</p>
							</div>
							<div className="space-y-1">
								<p className="text-xs text-fg-muted">Total Changes</p>
								<p className="text-2xl font-semibold text-fg">{totalChanges}</p>
							</div>
							<div className="space-y-1">
								<p className="text-xs text-green-700 dark:text-green-300">New CFs</p>
								<p className="text-2xl font-semibold text-green-600 dark:text-green-400">
									{instancePreviews
										.filter((inst) => inst.selected && inst.preview)
										.reduce(
											(sum, inst) => sum + (inst.preview?.newCustomFormats || 0),
											0,
										)}
								</p>
							</div>
							<div className="space-y-1">
								<p className="text-xs text-blue-700 dark:text-blue-300">Updates</p>
								<p className="text-2xl font-semibold text-blue-600 dark:text-blue-400">
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
							<div className="mt-3 pt-3 border-t border-border">
								<div className="flex items-center gap-2 text-sm text-amber-700 dark:text-amber-300">
									<AlertTriangle className="h-4 w-4" />
									<span>Some instances have conflicts or are unreachable</span>
								</div>
							</div>
						)}
					</div>
				)}
			</DialogContent>

			<DialogFooter>
				{bulkDeployMutation.isError && (
					<div className="flex items-start gap-2 rounded-lg border border-red-500/30 bg-red-500/10 p-3 mr-auto">
						<AlertCircle className="h-5 w-5 text-red-600 dark:text-red-400 mt-0.5 shrink-0" />
						<div>
							<p className="text-sm font-medium text-fg">Deployment Failed</p>
							<p className="text-sm text-fg-muted mt-1">
								{bulkDeployMutation.error?.message ?? "Failed to execute bulk deployment"}
							</p>
						</div>
					</div>
				)}
				{bulkDeployMutation.isSuccess && !bulkDeployMutation.data?.success && (
					<div className="flex items-start gap-2 rounded-lg border border-red-500/30 bg-red-500/10 p-3 mr-auto">
						<AlertCircle className="h-5 w-5 text-red-600 dark:text-red-400 mt-0.5 shrink-0" />
						<div>
							<p className="text-sm font-medium text-fg">Deployment Partially Failed</p>
							<p className="text-sm text-fg-muted mt-1">
								{bulkDeployMutation.data?.result.failedInstances} of{" "}
								{bulkDeployMutation.data?.result.totalInstances} deployments failed
							</p>
						</div>
					</div>
				)}
				{bulkDeployMutation.isSuccess && bulkDeployMutation.data?.success && (
					<div className="flex items-start gap-2 rounded-lg border border-green-500/30 bg-green-500/10 p-3 mr-auto">
						<CheckCircle2 className="h-5 w-5 text-green-600 dark:text-green-400 mt-0.5 shrink-0" />
						<div>
							<p className="text-sm font-medium text-fg">Deployment Successful</p>
							<p className="text-sm text-fg-muted mt-1">Custom Formats deployed to all selected instances</p>
						</div>
					</div>
				)}
				<button
					type="button"
					onClick={onClose}
					disabled={bulkDeployMutation.isPending}
					className="px-4 py-2 text-sm font-medium text-fg-muted hover:text-fg transition-colors disabled:opacity-50"
				>
					Cancel
				</button>
				<button
					type="button"
					onClick={handleDeploy}
					disabled={!canDeploy || bulkDeployMutation.isPending || bulkDeployMutation.isSuccess}
					className="px-4 py-2 text-sm font-medium bg-primary text-primary-fg hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed rounded-lg transition-colors flex items-center gap-2"
				>
					{previewsLoading ? (
						<>
							<div className="h-4 w-4 animate-spin rounded-full border-2 border-primary-fg border-t-transparent" />
							Loading Previews...
						</>
					) : bulkDeployMutation.isPending ? (
						<>
							<div className="h-4 w-4 animate-spin rounded-full border-2 border-primary-fg border-t-transparent" />
							Deploying to {deployableCount} Instance{deployableCount !== 1 ? "s" : ""}...
						</>
					) : (
						<>
							<Rocket className="h-4 w-4" />
							Deploy to {deployableCount} Instance{deployableCount !== 1 ? "s" : ""}
						</>
					)}
				</button>
			</DialogFooter>

			{/* Instance Quality Override Modal */}
			{editingQualityOverride && templateId && serviceType && (
				<InstanceQualityOverrideModal
					open={true}
					onClose={() => setEditingQualityOverride(null)}
					templateId={templateId}
					templateName={templateName ?? "Template"}
					instanceId={editingQualityOverride.instanceId}
					instanceLabel={editingQualityOverride.instanceLabel}
					serviceType={serviceType}
					templateDefaultConfig={templateDefaultQualityConfig}
					onSaved={() => {
						setEditingQualityOverride(null);
						// Note: The deployment previews will need to be refetched
						// to reflect the new quality config
					}}
				/>
			)}
		</Dialog>
	);
};
