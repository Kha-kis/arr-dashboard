"use client";

import { useState, useEffect } from "react";
import {
	Dialog,
	DialogHeader,
	DialogTitle,
	DialogDescription,
	DialogContent,
	DialogFooter,
} from "../../../components/ui/dialog";
import { Skeleton } from "../../../components/ui";
import {
	AlertCircle,
	CheckCircle2,
	Server,
	Layers,
	AlertTriangle,
	Rocket,
	RefreshCw,
} from "lucide-react";
import { useDeploymentPreview } from "../../../hooks/api/useDeploymentPreview";
import { executeBulkDeployment } from "../../../lib/api-client/trash-guides";
import { cn } from "../../../lib/utils";

interface InstancePreview {
	instanceId: string;
	instanceLabel: string;
	selected: boolean;
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

export const BulkDeploymentModal = ({
	open,
	onClose,
	templateId,
	templateName,
	instances,
	onDeploySuccess,
}: BulkDeploymentModalProps) => {
	const [instancePreviews, setInstancePreviews] = useState<InstancePreview[]>([]);
	const [isLoadingPreviews, setIsLoadingPreviews] = useState(false);

	// Initialize instance previews with all instances selected
	useEffect(() => {
		if (open && instances.length > 0) {
			setInstancePreviews(
				instances.map((inst) => ({
					instanceId: inst.instanceId,
					instanceLabel: inst.instanceLabel,
					selected: true,
					loading: false,
				})),
			);
		}
	}, [open, instances]);

	const toggleInstance = (instanceId: string) => {
		setInstancePreviews((prev) =>
			prev.map((inst) =>
				inst.instanceId === instanceId
					? { ...inst, selected: !inst.selected }
					: inst,
			),
		);
	};

	const selectAll = () => {
		setInstancePreviews((prev) =>
			prev.map((inst) => ({ ...inst, selected: true })),
		);
	};

	const deselectAll = () => {
		setInstancePreviews((prev) =>
			prev.map((inst) => ({ ...inst, selected: false })),
		);
	};

	const loadPreviews = async () => {
		if (!templateId) return;

		setIsLoadingPreviews(true);

		// Load previews for all selected instances in parallel
		const selectedInstances = instancePreviews.filter((inst) => inst.selected);

		const previewPromises = selectedInstances.map(async (inst) => {
			try {
				setInstancePreviews((prev) =>
					prev.map((i) =>
						i.instanceId === inst.instanceId ? { ...i, loading: true } : i,
					),
				);

				const response = await fetch("/api/trash-guides/deployment/preview", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						templateId,
						instanceId: inst.instanceId,
					}),
				});

				if (!response.ok) {
					throw new Error("Failed to load preview");
				}

				const data = await response.json();

				setInstancePreviews((prev) =>
					prev.map((i) =>
						i.instanceId === inst.instanceId
							? {
									...i,
									loading: false,
									preview: {
										reachable: data.data.instanceReachable,
										totalItems: data.data.summary.totalItems,
										newCustomFormats: data.data.summary.newCustomFormats,
										updatedCustomFormats: data.data.summary.updatedCustomFormats,
										conflicts: data.data.summary.totalConflicts,
										canDeploy: data.data.canDeploy,
									},
								}
							: i,
					),
				);
			} catch (error) {
				setInstancePreviews((prev) =>
					prev.map((i) =>
						i.instanceId === inst.instanceId
							? {
									...i,
									loading: false,
									error: error instanceof Error ? error : new Error("Unknown error"),
								}
							: i,
					),
				);
			}
		});

		await Promise.all(previewPromises);
		setIsLoadingPreviews(false);
	};

	const [isDeploying, setIsDeploying] = useState(false);
	const [deploymentError, setDeploymentError] = useState<string | null>(null);
	const [deploymentSuccess, setDeploymentSuccess] = useState(false);

	const handleDeploy = async () => {
		if (!templateId) return;

		const selectedInstanceIds = instancePreviews
			.filter((inst) => inst.selected && inst.preview?.canDeploy)
			.map((inst) => inst.instanceId);

		if (selectedInstanceIds.length === 0) return;

		setIsDeploying(true);
		setDeploymentError(null);
		setDeploymentSuccess(false);

		try {
			const response = await executeBulkDeployment({
				templateId,
				instanceIds: selectedInstanceIds,
			});

			if (response.success) {
				setDeploymentSuccess(true);
				// Notify parent component of success
				onDeploySuccess?.();
				// Close after showing success message for 2 seconds
				setTimeout(() => {
					onClose();
				}, 2000);
			} else {
				setDeploymentError(
					`${response.result.failedInstances} of ${response.result.totalInstances} deployments failed`,
				);
			}
		} catch (error) {
			setDeploymentError(
				error instanceof Error
					? error.message
					: "Failed to execute bulk deployment",
			);
		} finally {
			setIsDeploying(false);
		}
	};

	const selectedCount = instancePreviews.filter((inst) => inst.selected).length;
	const previewsLoaded = instancePreviews.some((inst) => inst.preview);
	const allPreviewsLoaded =
		selectedCount > 0 &&
		instancePreviews.filter((inst) => inst.selected).every((inst) => inst.preview);

	const totalChanges = instancePreviews
		.filter((inst) => inst.selected && inst.preview)
		.reduce((sum, inst) => sum + (inst.preview?.totalItems || 0), 0);

	const canDeploy =
		allPreviewsLoaded &&
		instancePreviews
			.filter((inst) => inst.selected && inst.preview)
			.every((inst) => inst.preview?.canDeploy);

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
				{/* Instance Selection */}
				<div className="rounded-lg border border-border bg-bg-subtle p-4">
					<div className="flex items-center justify-between mb-3">
						<h3 className="text-sm font-medium text-fg">
							Select Instances ({selectedCount} / {instancePreviews.length})
						</h3>
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

					<div className="space-y-2 max-h-48 overflow-y-auto">
						{instancePreviews.map((inst) => (
							<label
								key={inst.instanceId}
								className={cn(
									"flex items-center gap-3 p-3 rounded-lg border transition cursor-pointer",
									inst.selected
										? "border-primary/30 bg-primary/5"
										: "border-border bg-bg hover:bg-bg-subtle",
								)}
							>
								<input
									type="checkbox"
									checked={inst.selected}
									onChange={() => toggleInstance(inst.instanceId)}
									className="w-4 h-4 rounded border-border"
								/>
								<Server className="h-4 w-4 text-fg-muted shrink-0" />
								<span className="text-sm font-medium text-fg flex-1">
									{inst.instanceLabel}
								</span>

								{inst.loading && (
									<div className="h-4 w-4 animate-spin rounded-full border-2 border-primary border-t-transparent" />
								)}

								{inst.preview && (
									<div className="flex items-center gap-2 text-xs">
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
									<span className="text-xs text-red-600 dark:text-red-400">Error</span>
								)}
							</label>
						))}
					</div>

					{selectedCount > 0 && !previewsLoaded && (
						<button
							type="button"
							onClick={loadPreviews}
							disabled={isLoadingPreviews}
							className="mt-3 w-full flex items-center justify-center gap-2 rounded bg-primary/20 px-4 py-2 text-sm font-medium text-primary transition hover:bg-primary/30 disabled:opacity-50"
						>
							{isLoadingPreviews ? (
								<>
									<div className="h-4 w-4 animate-spin rounded-full border-2 border-primary border-t-transparent" />
									Loading Previews...
								</>
							) : (
								<>
									<RefreshCw className="h-4 w-4" />
									Load Deployment Previews
								</>
							)}
						</button>
					)}
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

						{!canDeploy && (
							<div className="mt-3 pt-3 border-t border-border">
								<div className="flex items-center gap-2 text-sm text-amber-700 dark:text-amber-300">
									<AlertTriangle className="h-4 w-4" />
									<span>Some instances have conflicts or are unreachable</span>
								</div>
							</div>
						)}
					</div>
				)}

				{/* Instance Details */}
				{allPreviewsLoaded && (
					<div className="space-y-2">
						<h3 className="text-sm font-medium text-fg">Instance Details</h3>
						<div className="space-y-2 max-h-64 overflow-y-auto">
							{instancePreviews
								.filter((inst) => inst.selected && inst.preview)
								.map((inst) => (
									<div
										key={inst.instanceId}
										className={cn(
											"rounded-lg border p-3",
											inst.preview?.canDeploy
												? "border-green-500/30 bg-green-500/5"
												: "border-red-500/30 bg-red-500/5",
										)}
									>
										<div className="flex items-center justify-between">
											<div className="flex items-center gap-2">
												<Server className="h-4 w-4 text-fg-muted" />
												<span className="text-sm font-medium text-fg">
													{inst.instanceLabel}
												</span>
											</div>
											<div className="flex items-center gap-3 text-xs">
												<span className="text-fg-muted">
													{inst.preview?.totalItems} changes
												</span>
												{inst.preview?.reachable ? (
													<CheckCircle2 className="h-4 w-4 text-green-600 dark:text-green-400" />
												) : (
													<AlertCircle className="h-4 w-4 text-red-600 dark:text-red-400" />
												)}
											</div>
										</div>
										{inst.preview?.conflicts && inst.preview.conflicts > 0 && (
											<p className="text-xs text-amber-700 dark:text-amber-300 mt-2">
												{inst.preview.conflicts} conflict
												{inst.preview.conflicts !== 1 ? "s" : ""} detected
											</p>
										)}
									</div>
								))}
						</div>
					</div>
				)}
			</DialogContent>

			<DialogFooter>
				{deploymentError && (
					<div className="flex items-start gap-2 rounded-lg border border-red-500/30 bg-red-500/10 p-3 mr-auto">
						<AlertCircle className="h-5 w-5 text-red-600 dark:text-red-400 mt-0.5 shrink-0" />
						<div>
							<p className="text-sm font-medium text-fg">Deployment Failed</p>
							<p className="text-sm text-fg-muted mt-1">{deploymentError}</p>
						</div>
					</div>
				)}
				{deploymentSuccess && (
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
					disabled={isDeploying}
					className="px-4 py-2 text-sm font-medium text-fg-muted hover:text-fg transition-colors disabled:opacity-50"
				>
					Cancel
				</button>
				<button
					type="button"
					onClick={handleDeploy}
					disabled={!canDeploy || selectedCount === 0 || isDeploying || deploymentSuccess}
					className="px-4 py-2 text-sm font-medium bg-primary text-white hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed rounded-lg transition-colors flex items-center gap-2"
				>
					{isDeploying ? (
						<>
							<div className="h-4 w-4 animate-spin rounded-full border-2 border-white border-t-transparent" />
							Deploying to {selectedCount} Instance{selectedCount !== 1 ? "s" : ""}...
						</>
					) : (
						<>
							<Rocket className="h-4 w-4" />
							Deploy to {selectedCount} Instance{selectedCount !== 1 ? "s" : ""}
						</>
					)}
				</button>
			</DialogFooter>
		</Dialog>
	);
};
