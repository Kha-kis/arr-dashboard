"use client";

import { useState } from "react";
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
	Plus,
	Edit,
	AlertTriangle,
	CheckCircle2,
	Server,
	Package,
	Settings,
	RefreshCw,
	Bell,
	Hand,
} from "lucide-react";
import { useDeploymentPreview } from "../../../hooks/api/useDeploymentPreview";
import { executeDeployment } from "../../../lib/api-client/trash-guides";
import { cn } from "../../../lib/utils";
import type { DeploymentAction } from "../../../lib/api-client/trash-guides";
import { InstanceOverrideEditor } from "./instance-override-editor";

interface DeploymentPreviewModalProps {
	open: boolean;
	onClose: () => void;
	templateId: string | null;
	templateName?: string;
	instanceId: string | null;
	instanceLabel?: string;
	onDeploySuccess?: () => void;
}

export const DeploymentPreviewModal = ({
	open,
	onClose,
	templateId,
	templateName,
	instanceId,
	instanceLabel,
	onDeploySuccess,
}: DeploymentPreviewModalProps) => {
	const { data, isLoading, error } = useDeploymentPreview(templateId, instanceId);
	const [expandedConflicts, setExpandedConflicts] = useState<Set<string>>(
		new Set(),
	);
	const [showOverrideEditor, setShowOverrideEditor] = useState(false);
	const [syncStrategy, setSyncStrategy] = useState<"auto" | "manual" | "notify">("notify");

	const toggleConflict = (trashId: string) => {
		setExpandedConflicts((prev) => {
			const next = new Set(prev);
			if (next.has(trashId)) {
				next.delete(trashId);
			} else {
				next.add(trashId);
			}
			return next;
		});
	};

	const getActionIcon = (action: DeploymentAction) => {
		switch (action) {
			case "create":
				return <Plus className="h-4 w-4 text-green-600 dark:text-green-400" />;
			case "update":
				return <Edit className="h-4 w-4 text-blue-600 dark:text-blue-400" />;
			case "delete":
				return (
					<AlertTriangle className="h-4 w-4 text-red-600 dark:text-red-400" />
				);
			case "skip":
				return (
					<CheckCircle2 className="h-4 w-4 text-gray-600 dark:text-gray-400" />
				);
			default:
				return null;
		}
	};

	const getActionColor = (action: DeploymentAction) => {
		switch (action) {
			case "create":
				return "bg-green-500/10 border-green-500/30 text-green-700 dark:text-green-300";
			case "update":
				return "bg-blue-500/10 border-blue-500/30 text-blue-700 dark:text-blue-300";
			case "delete":
				return "bg-red-500/10 border-red-500/30 text-red-700 dark:text-red-300";
			case "skip":
				return "bg-gray-500/10 border-gray-500/30 text-gray-700 dark:text-gray-300";
			default:
				return "";
		}
	};

	const getActionLabel = (action: DeploymentAction) => {
		switch (action) {
			case "create":
				return "New";
			case "update":
				return "Update";
			case "delete":
				return "Delete";
			case "skip":
				return "Skip";
			default:
				return action;
		}
	};

	const [isDeploying, setIsDeploying] = useState(false);
	const [deploymentError, setDeploymentError] = useState<string | null>(null);

	const handleDeploy = async () => {
		if (!templateId || !instanceId) return;

		setIsDeploying(true);
		setDeploymentError(null);

		try {
			const response = await executeDeployment({
				templateId,
				instanceId,
				syncStrategy,
			});

			if (response.success) {
				// Notify parent component of success
				onDeploySuccess?.();
				onClose();
			} else {
				const errors = response.result?.errors;
				setDeploymentError(
					Array.isArray(errors) && errors.length > 0
						? errors.join(", ")
						: "Deployment failed",
				);
			}
		} catch (error) {
			setDeploymentError(
				error instanceof Error ? error.message : "Failed to execute deployment",
			);
		} finally {
			setIsDeploying(false);
		}
	};

	return (
		<Dialog open={open} onOpenChange={onClose} size="xl">
			<DialogHeader>
				<DialogTitle>
					<div className="flex items-center gap-2">
						<Package className="h-5 w-5" />
						Deployment Preview
					</div>
				</DialogTitle>
				<DialogDescription>
					Review changes before deploying template to instance
					{templateName && ` - "${templateName}"`}
				</DialogDescription>
			</DialogHeader>

			<DialogContent className="space-y-4">
				{isLoading && (
					<div className="space-y-4">
						<Skeleton className="h-24 w-full" />
						<Skeleton className="h-48 w-full" />
					</div>
				)}

				{error && (
					<div className="rounded-lg border border-red-500/30 bg-red-500/10 p-4">
						<div className="flex items-start gap-3">
							<AlertCircle className="h-5 w-5 text-red-600 dark:text-red-400 mt-0.5 shrink-0" />
							<div>
								<p className="text-sm font-medium text-fg">
									Failed to load deployment preview
								</p>
								<p className="text-sm text-fg-muted mt-1">
									{error instanceof Error ? error.message : "Please try again"}
								</p>
							</div>
						</div>
					</div>
				)}

				{data?.data && (
					<>
						{/* Instance Status */}
						<div className="rounded-lg border border-border bg-bg-subtle p-4">
							<div className="flex items-center gap-3 mb-3">
								<Server className="h-5 w-5 text-fg-muted" />
								<div className="flex-1">
									<h3 className="text-sm font-medium text-fg">
										Target Instance
									</h3>
									<p className="text-xs text-fg-muted">
										{data.data.instanceLabel} ({data.data.instanceServiceType})
									</p>
								</div>
								<div className="flex items-center gap-2">
									{data.data.instanceReachable ? (
										<div className="flex items-center gap-2 text-green-600 dark:text-green-400">
											<CheckCircle2 className="h-4 w-4" />
											<span className="text-xs font-medium">Connected</span>
										</div>
									) : (
										<div className="flex items-center gap-2 text-red-600 dark:text-red-400">
											<AlertCircle className="h-4 w-4" />
											<span className="text-xs font-medium">Unreachable</span>
										</div>
									)}
								</div>
							</div>
							<div className="flex items-center justify-between">
								{data.data.instanceVersion && (
									<p className="text-xs text-fg-muted">
										Version: {data.data.instanceVersion}
									</p>
								)}
								<button
									type="button"
									onClick={() => setShowOverrideEditor(true)}
									className="ml-auto flex items-center gap-2 rounded bg-white/10 px-3 py-2 text-xs font-medium text-white transition hover:bg-white/20"
									title="Customize scores and enable/disable CFs for this instance"
								>
									<Settings className="h-3 w-3" />
									Instance Overrides
								</button>
							</div>
						</div>

						{/* Sync Strategy Selector */}
						<div className="rounded-lg border border-border bg-bg-subtle p-4">
							<h3 className="text-sm font-medium text-fg mb-3">
								Update Behavior
							</h3>
							<p className="text-xs text-fg-muted mb-3">
								Choose how this instance should handle future template updates
							</p>
							<div className="grid grid-cols-1 md:grid-cols-3 gap-2">
								<button
									type="button"
									onClick={() => setSyncStrategy("auto")}
									className={cn(
										"flex items-center gap-3 rounded-lg border p-3 text-left transition",
										syncStrategy === "auto"
											? "border-green-500 bg-green-500/10"
											: "border-border hover:border-border/80 hover:bg-bg-subtle/50"
									)}
								>
									<RefreshCw className={cn(
										"h-5 w-5 shrink-0",
										syncStrategy === "auto" ? "text-green-500" : "text-fg-muted"
									)} />
									<div>
										<p className={cn(
											"text-sm font-medium",
											syncStrategy === "auto" ? "text-green-500" : "text-fg"
										)}>
											Auto-sync
										</p>
										<p className="text-xs text-fg-muted">
											Automatically apply updates
										</p>
									</div>
								</button>
								<button
									type="button"
									onClick={() => setSyncStrategy("notify")}
									className={cn(
										"flex items-center gap-3 rounded-lg border p-3 text-left transition",
										syncStrategy === "notify"
											? "border-blue-500 bg-blue-500/10"
											: "border-border hover:border-border/80 hover:bg-bg-subtle/50"
									)}
								>
									<Bell className={cn(
										"h-5 w-5 shrink-0",
										syncStrategy === "notify" ? "text-blue-500" : "text-fg-muted"
									)} />
									<div>
										<p className={cn(
											"text-sm font-medium",
											syncStrategy === "notify" ? "text-blue-500" : "text-fg"
										)}>
											Notify
										</p>
										<p className="text-xs text-fg-muted">
											Alert me before syncing
										</p>
									</div>
								</button>
								<button
									type="button"
									onClick={() => setSyncStrategy("manual")}
									className={cn(
										"flex items-center gap-3 rounded-lg border p-3 text-left transition",
										syncStrategy === "manual"
											? "border-amber-500 bg-amber-500/10"
											: "border-border hover:border-border/80 hover:bg-bg-subtle/50"
									)}
								>
									<Hand className={cn(
										"h-5 w-5 shrink-0",
										syncStrategy === "manual" ? "text-amber-500" : "text-fg-muted"
									)} />
									<div>
										<p className={cn(
											"text-sm font-medium",
											syncStrategy === "manual" ? "text-amber-500" : "text-fg"
										)}>
											Manual
										</p>
										<p className="text-xs text-fg-muted">
											Only sync when I choose
										</p>
									</div>
								</button>
							</div>
						</div>

						{/* Summary Statistics */}
						<div className="rounded-lg border border-border bg-bg-subtle p-4">
							<h3 className="text-sm font-medium text-fg mb-3">
								Deployment Summary
							</h3>
							<div className="grid grid-cols-2 md:grid-cols-4 gap-4">
								<div className="space-y-1">
									<p className="text-xs text-fg-muted">Total Items</p>
									<p className="text-2xl font-semibold text-fg">
										{data.data.summary.totalItems}
									</p>
								</div>
								<div className="space-y-1">
									<p className="text-xs text-green-700 dark:text-green-300">
										New
									</p>
									<p className="text-2xl font-semibold text-green-600 dark:text-green-400">
										{data.data.summary.newCustomFormats}
									</p>
								</div>
								<div className="space-y-1">
									<p className="text-xs text-blue-700 dark:text-blue-300">
										Updates
									</p>
									<p className="text-2xl font-semibold text-blue-600 dark:text-blue-400">
										{data.data.summary.updatedCustomFormats}
									</p>
								</div>
								<div className="space-y-1">
									<p className="text-xs text-amber-700 dark:text-amber-300">
										Conflicts
									</p>
									<p className="text-2xl font-semibold text-amber-600 dark:text-amber-400">
										{data.data.summary.totalConflicts}
									</p>
								</div>
							</div>

							{data.data.requiresConflictResolution && (
								<div className="mt-3 pt-3 border-t border-border">
									<div className="flex items-center gap-2 text-sm">
										<AlertCircle className="h-4 w-4 text-amber-600 dark:text-amber-400" />
										<span className="text-fg-muted">
											{data.data.summary.unresolvedConflicts} unresolved conflict
											{data.data.summary.unresolvedConflicts !== 1 ? "s" : ""}{" "}
											require attention
										</span>
									</div>
								</div>
							)}
						</div>

						{/* Custom Format Deployment Items */}
						{data.data.customFormats.length > 0 && (
							<div className="space-y-3">
								<h3 className="text-sm font-medium text-fg">
									Custom Format Changes ({data.data.customFormats.length})
								</h3>
								<div className="space-y-2 max-h-64 overflow-y-auto">
									{data.data.customFormats.map((item) => (
										<div
											key={item.trashId}
											className={cn(
												"rounded-lg border p-3",
												getActionColor(item.action),
											)}
										>
											<div className="flex items-start justify-between gap-3">
												<div className="flex items-start gap-2 flex-1 min-w-0">
													{getActionIcon(item.action)}
													<div className="flex-1 min-w-0">
														<div className="flex items-center gap-2">
															<p className="text-sm font-medium truncate">
																{item.name}
															</p>
															<span className="px-2 py-0.5 rounded-full text-xs font-medium bg-current/10">
																{getActionLabel(item.action)}
															</span>
														</div>
														{item.hasConflicts && (
															<p className="text-xs mt-1 opacity-80">
																{item.conflicts.length} conflict
																{item.conflicts.length !== 1 ? "s" : ""} detected
															</p>
														)}
													</div>
												</div>
											</div>

											{item.hasConflicts && item.conflicts.length > 0 && (
												<div className="mt-2 pt-2 border-t border-current/20">
													{item.conflicts.map((conflict, idx) => (
														<div
															key={idx}
															className="text-xs mt-1 space-y-1 opacity-90"
														>
															<p className="font-medium">
																{conflict.conflictType.replace(/_/g, " ")}:
															</p>
															<p className="ml-2">
																Suggested:{" "}
																{conflict.suggestedResolution.replace(
																	/_/g,
																	" ",
																)}
															</p>
														</div>
													))}
												</div>
											)}
										</div>
									))}
								</div>
							</div>
						)}

						{/* No Changes Message */}
						{data.data.summary.totalItems === 0 && (
							<div className="rounded-lg border border-border bg-bg-subtle p-8 text-center">
								<CheckCircle2 className="h-12 w-12 text-green-600 dark:text-green-400 mx-auto mb-3" />
								<p className="text-sm font-medium text-fg">
									Instance is up to date
								</p>
								<p className="text-xs text-fg-muted mt-1">
									No changes needed for this deployment
								</p>
							</div>
						)}
					</>
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
					disabled={
						!data?.data ||
						!data.data.canDeploy ||
						data.data.summary.totalItems === 0 ||
						isDeploying
					}
					className="px-4 py-2 text-sm font-medium bg-primary text-white hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed rounded-lg transition-colors flex items-center gap-2"
				>
					{isDeploying ? (
						<>
							<div className="h-4 w-4 animate-spin rounded-full border-2 border-white border-t-transparent" />
							Deploying...
						</>
					) : (
						"Deploy to Instance"
					)}
				</button>
			</DialogFooter>

			{/* Instance Override Editor Modal */}
			{showOverrideEditor && data?.data && (
				<InstanceOverrideEditor
					open={showOverrideEditor}
					onClose={() => setShowOverrideEditor(false)}
					templateId={templateId}
					templateName={templateName}
					instanceId={instanceId}
					instanceLabel={instanceLabel}
					customFormats={data.data.customFormats.map((cf) => ({
						trashId: cf.trashId,
						name: cf.name,
						defaultScore: cf.defaultScore ?? 0,
						instanceOverrideScore: cf.instanceOverrideScore,
					}))}
				/>
			)}
		</Dialog>
	);
};
