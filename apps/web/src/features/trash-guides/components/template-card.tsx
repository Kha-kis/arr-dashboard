"use client";

import { useState } from "react";
import type { TrashTemplate } from "@arr/shared";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
	Badge,
	DropdownMenu,
	DropdownMenuItem,
	DropdownMenuDivider,
	toast,
} from "../../../components/ui";
import {
	MoreVertical,
	Edit,
	Copy,
	Download,
	Trash2,
	Rocket,
	AlertCircle,
	Layers,
	Server,
	ChevronDown,
	ChevronUp,
	RefreshCw,
	Calendar,
	History,
	Settings,
	Bell,
	Hand,
	SlidersHorizontal,
	Unlink2,
} from "lucide-react";
import { cn } from "../../../lib/utils";
import { fetchTemplateStats, type TemplateStatsResponse, type TemplateInstanceInfo } from "../../../lib/api-client/templates";
import { updateSyncStrategy } from "../../../lib/api-client/trash-guides";

interface TemplateCardProps {
	template: TrashTemplate;
	hasUpdate?: boolean;
	onDeploy: () => void;
	onEdit: () => void;
	onDuplicate: () => void;
	onExport: () => void;
	onDelete: () => void;
	onViewUpdate?: () => void;
	onDeployToInstance?: (instanceId: string, instanceLabel: string) => void;
	onManageInstance?: (instanceId: string, instanceLabel: string) => void;
	onUnlinkInstance?: (instanceId: string, instanceLabel: string) => void;
	onViewHistory?: () => void;
}

// Helper to get sync strategy display info
const getSyncStrategyInfo = (strategy: "auto" | "manual" | "notify") => {
	switch (strategy) {
		case "auto":
			return { label: "Auto", icon: RefreshCw, variant: "success" as const, color: "text-green-500" };
		case "notify":
			return { label: "Notify", icon: Bell, variant: "info" as const, color: "text-blue-500" };
		case "manual":
			return { label: "Manual", icon: Hand, variant: "warning" as const, color: "text-amber-500" };
	}
};

export const TemplateCard = ({
	template,
	hasUpdate = false,
	onDeploy,
	onEdit,
	onDuplicate,
	onExport,
	onDelete,
	onViewUpdate,
	onDeployToInstance,
	onManageInstance,
	onUnlinkInstance,
	onViewHistory,
}: TemplateCardProps) => {
	const [expanded, setExpanded] = useState(false);
	const [updatingStrategy, setUpdatingStrategy] = useState<string | null>(null);
	const queryClient = useQueryClient();

	// Fetch stats when card is expanded (lazy loading)
	const { data: statsData, isLoading: statsLoading } = useQuery<TemplateStatsResponse>({
		queryKey: ["template-stats", template.id],
		queryFn: () => fetchTemplateStats(template.id),
		enabled: expanded, // Only fetch when expanded
		staleTime: 30000, // Cache for 30 seconds
	});

	const handleSyncStrategyChange = async (
		instanceId: string,
		newStrategy: "auto" | "manual" | "notify"
	) => {
		setUpdatingStrategy(instanceId);
		try {
			await updateSyncStrategy({
				templateId: template.id,
				instanceId,
				syncStrategy: newStrategy,
			});
			// Invalidate and refetch stats
			queryClient.invalidateQueries({ queryKey: ["template-stats", template.id] });
		} catch (error) {
			console.error("Failed to update sync strategy:", error);
			toast.error("Failed to update sync strategy. Please try again.");
		} finally {
			setUpdatingStrategy(null);
		}
	};

	const formatCount = template.config.customFormats.length;
	const groupCount = template.config.customFormatGroups.length;
	const stats = statsData?.stats;
	const instanceCount = stats?.instances.length ?? 0;
	const isAutoSync = stats?.isActive ?? false;

	return (
		<article className="group relative rounded-xl border border-border bg-bg-subtle transition-all hover:border-border-hover hover:shadow-lg hover:shadow-black/5">
			{/* Main Card Content */}
			<div className="p-5">
				{/* Header Row: Service Badge + Status Badges + Overflow Menu */}
				<div className="flex items-start justify-between mb-3">
					<div className="flex items-center gap-2 flex-wrap">
						<Badge
							variant={template.serviceType === "RADARR" ? "warning" : "info"}
							className="text-xs font-medium"
						>
							{template.serviceType}
						</Badge>
						{isAutoSync && (
							<Badge variant="success" className="text-xs font-medium">
								Auto-sync
							</Badge>
						)}
					</div>

					<DropdownMenu
						trigger={<MoreVertical className="h-4 w-4" />}
						align="right"
					>
						<DropdownMenuItem icon={<Edit className="h-4 w-4" />} onClick={onEdit}>
							Edit Template
						</DropdownMenuItem>
						<DropdownMenuItem icon={<Copy className="h-4 w-4" />} onClick={onDuplicate}>
							Duplicate
						</DropdownMenuItem>
						<DropdownMenuItem icon={<Download className="h-4 w-4" />} onClick={onExport}>
							Export JSON
						</DropdownMenuItem>
						{onViewHistory && (
							<DropdownMenuItem icon={<History className="h-4 w-4" />} onClick={onViewHistory}>
								View History
							</DropdownMenuItem>
						)}
						<DropdownMenuDivider />
						<DropdownMenuItem
							icon={<Trash2 className="h-4 w-4" />}
							variant="danger"
							onClick={onDelete}
						>
							Delete
						</DropdownMenuItem>
					</DropdownMenu>
				</div>

				{/* Title + Description */}
				<div className="mb-4">
					<h3 className="font-semibold text-fg text-base leading-tight mb-1">
						{template.name}
					</h3>
					{template.description && (
						<p className="text-sm text-fg-muted line-clamp-1">
							{template.description}
						</p>
					)}
				</div>

				{/* Inline Metrics */}
				<div className="flex items-center gap-4 text-xs text-fg-muted mb-4">
					<div className="flex items-center gap-1.5">
						<Layers className="h-3.5 w-3.5" />
						<span>{formatCount} formats</span>
					</div>
					{groupCount > 0 && (
						<>
							<span className="text-fg-muted/50">|</span>
							<span>{groupCount} groups</span>
						</>
					)}
				</div>

				{/* Status Badges - Only shown when relevant */}
				{hasUpdate && onViewUpdate && (
					<button
						type="button"
						onClick={onViewUpdate}
						className="flex items-center gap-2 w-full rounded-lg bg-amber-500/10 border border-amber-500/20 px-3 py-2 mb-4 text-left transition-colors hover:bg-amber-500/15"
					>
						<AlertCircle className="h-4 w-4 text-amber-500 shrink-0" />
						<span className="text-xs font-medium text-amber-400">
							Update available from TRaSH Guides
						</span>
					</button>
				)}

				{/* Instances Section - Expandable */}
				<button
					type="button"
					onClick={() => setExpanded(!expanded)}
					className="flex items-center justify-between w-full rounded-lg border border-border bg-bg px-3 py-2 mb-4 text-left transition-colors hover:bg-bg-muted/50"
				>
					<div className="flex items-center gap-2">
						<Server className="h-4 w-4 text-fg-muted" />
						<span className="text-sm font-medium text-fg">
							{statsLoading && expanded ? "Loading..." : `${instanceCount} instance${instanceCount !== 1 ? "s" : ""}`}
						</span>
					</div>
					{expanded ? (
						<ChevronUp className="h-4 w-4 text-fg-muted" />
					) : (
						<ChevronDown className="h-4 w-4 text-fg-muted" />
					)}
				</button>

				{/* Primary CTA */}
				<button
					type="button"
					onClick={onDeploy}
					className="w-full flex items-center justify-center gap-2 rounded-lg bg-primary px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-primary/90"
				>
					<Rocket className="h-4 w-4" />
					Deploy
				</button>
			</div>

			{/* Expanded Instances Section */}
			{expanded && (
				<div className="border-t border-border px-5 py-4 bg-bg/50">
					{statsLoading ? (
						<div className="flex items-center justify-center py-4 text-sm text-fg-muted">
							<RefreshCw className="h-4 w-4 animate-spin mr-2" />
							Loading instances...
						</div>
					) : stats && stats.instances.length > 0 ? (
						<div className="space-y-2">
							{stats.instances.map((instance) => {
								const strategyInfo = getSyncStrategyInfo(instance.syncStrategy);
								const StrategyIcon = strategyInfo.icon;
								const isUpdating = updatingStrategy === instance.instanceId;

								return (
									<div
										key={instance.instanceId}
										className="flex items-center justify-between rounded-lg border border-border bg-bg p-3"
									>
										<div className="flex items-center gap-3 min-w-0">
											<div className="min-w-0">
												<div className="flex items-center gap-2">
													<span className="text-sm font-medium text-fg truncate">
														{instance.instanceName}
													</span>
													<Badge variant={strategyInfo.variant} className="text-[10px] px-1.5 py-0 flex items-center gap-1">
														<StrategyIcon className={cn("h-2.5 w-2.5", isUpdating && "animate-spin")} />
														{strategyInfo.label}
													</Badge>
												</div>
												{instance.lastAppliedAt && (
													<div className="flex items-center gap-1 text-xs text-fg-muted mt-0.5">
														<Calendar className="h-3 w-3" />
														<span>Last: {new Date(instance.lastAppliedAt).toLocaleDateString()}</span>
													</div>
												)}
											</div>
										</div>
										<div className="flex items-center gap-2">
											{/* Instance Settings Dropdown */}
											<DropdownMenu
												trigger={
													<Settings className={cn(
														"h-4 w-4 text-fg-muted hover:text-fg transition-colors",
														isUpdating && "animate-spin"
													)} />
												}
												align="right"
											>
												{/* Edit Overrides Option */}
												{onManageInstance && (
													<>
														<DropdownMenuItem
															icon={<SlidersHorizontal className="h-4 w-4" />}
															onClick={() => onManageInstance(instance.instanceId, instance.instanceName)}
														>
															Edit Overrides
														</DropdownMenuItem>
														<DropdownMenuDivider />
													</>
												)}
												{/* Sync Strategy Options */}
												<DropdownMenuItem
													icon={<RefreshCw className="h-4 w-4 text-green-500" />}
													onClick={() => handleSyncStrategyChange(instance.instanceId, "auto")}
													disabled={isUpdating || instance.syncStrategy === "auto"}
												>
													Auto-sync
												</DropdownMenuItem>
												<DropdownMenuItem
													icon={<Bell className="h-4 w-4 text-blue-500" />}
													onClick={() => handleSyncStrategyChange(instance.instanceId, "notify")}
													disabled={isUpdating || instance.syncStrategy === "notify"}
												>
													Notify Only
												</DropdownMenuItem>
												<DropdownMenuItem
													icon={<Hand className="h-4 w-4 text-amber-500" />}
													onClick={() => handleSyncStrategyChange(instance.instanceId, "manual")}
													disabled={isUpdating || instance.syncStrategy === "manual"}
												>
													Manual
												</DropdownMenuItem>
												{onUnlinkInstance && (
													<>
														<DropdownMenuDivider />
														<DropdownMenuItem
															icon={<Unlink2 className="h-4 w-4" />}
															variant="danger"
															onClick={() => onUnlinkInstance(instance.instanceId, instance.instanceName)}
														>
															Remove from Instance
														</DropdownMenuItem>
													</>
												)}
											</DropdownMenu>
											{/* Deploy Button */}
											{onDeployToInstance && (
												<button
													type="button"
													onClick={() => onDeployToInstance(instance.instanceId, instance.instanceName)}
													className="flex items-center gap-1.5 rounded-lg bg-primary/10 px-3 py-1.5 text-xs font-medium text-primary transition-colors hover:bg-primary/20"
												>
													<Rocket className="h-3 w-3" />
													Deploy
												</button>
											)}
										</div>
									</div>
								);
							})}
						</div>
					) : (
						<div className="text-center py-4">
							<p className="text-sm text-fg-muted">No instances deployed yet.</p>
							<p className="text-xs text-fg-muted/70 mt-1">
								Click Deploy to add this template to an instance.
							</p>
						</div>
					)}
				</div>
			)}
		</article>
	);
};
