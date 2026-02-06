"use client";

import { useState } from "react";
import type { TrashTemplate } from "@arr/shared";
import {
	Badge,
	LegacyDropdownMenu,
	LegacyDropdownMenuItem,
	LegacyDropdownMenuDivider,
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
import { useThemeGradient } from "../../../hooks/useThemeGradient";
import { useTemplateStats } from "../../../hooks/api/useTemplates";
import { useUpdateSyncStrategy } from "../../../hooks/api/useDeploymentPreview";

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

// Helper to get sync strategy display info - color is now handled dynamically
const getSyncStrategyInfo = (strategy: "auto" | "manual" | "notify") => {
	switch (strategy) {
		case "auto":
			return { label: "Auto", icon: RefreshCw, variant: "success" as const, colorClass: "text-green-500" };
		case "notify":
			return { label: "Notify", icon: Bell, variant: "info" as const, colorClass: null }; // Theme color
		case "manual":
			return { label: "Manual", icon: Hand, variant: "warning" as const, colorClass: "text-amber-500" };
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
	const { gradient: themeGradient } = useThemeGradient();
	const [expanded, setExpanded] = useState(false);
	const [updatingStrategyInstanceId, setUpdatingStrategyInstanceId] = useState<string | null>(null);

	const updateSyncStrategyMutation = useUpdateSyncStrategy();

	// Fetch stats when card is expanded (lazy loading)
	const { data: statsData, isLoading: statsLoading } = useTemplateStats(expanded ? template.id : null);

	const handleSyncStrategyChange = (instanceId: string, newStrategy: "auto" | "manual" | "notify") => {
		setUpdatingStrategyInstanceId(instanceId);
		updateSyncStrategyMutation.mutate(
			{ templateId: template.id, instanceId, syncStrategy: newStrategy },
			{
				onSettled: () => setUpdatingStrategyInstanceId(null),
			}
		);
	};

	const formatCount = template.config.customFormats.length;
	const groupCount = template.config.customFormatGroups.length;
	const stats = statsData?.stats;
	const instanceCount = stats?.instances.length ?? 0;
	const isAutoSync = stats?.isActive ?? false;

	return (
		<article className="group relative rounded-xl border border-border bg-card transition-all hover:border-primary/50 hover:shadow-lg hover:shadow-black/5">
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

					<LegacyDropdownMenu
						trigger={<MoreVertical className="h-4 w-4" />}
						align="right"
					>
						<LegacyDropdownMenuItem icon={<Edit className="h-4 w-4" />} onClick={onEdit}>
							Edit Template
						</LegacyDropdownMenuItem>
						<LegacyDropdownMenuItem icon={<Copy className="h-4 w-4" />} onClick={onDuplicate}>
							Duplicate
						</LegacyDropdownMenuItem>
						<LegacyDropdownMenuItem icon={<Download className="h-4 w-4" />} onClick={onExport}>
							Export JSON
						</LegacyDropdownMenuItem>
						{onViewHistory && (
							<LegacyDropdownMenuItem icon={<History className="h-4 w-4" />} onClick={onViewHistory}>
								View History
							</LegacyDropdownMenuItem>
						)}
						<LegacyDropdownMenuDivider />
						<LegacyDropdownMenuItem
							icon={<Trash2 className="h-4 w-4" />}
							variant="danger"
							onClick={onDelete}
						>
							Delete
						</LegacyDropdownMenuItem>
					</LegacyDropdownMenu>
				</div>

				{/* Title + Description */}
				<div className="mb-4">
					<h3 className="font-semibold text-foreground text-base leading-tight mb-1">
						{template.name}
					</h3>
					{template.description && (
						<p className="text-sm text-muted-foreground line-clamp-1">
							{template.description}
						</p>
					)}
				</div>

				{/* Inline Metrics */}
				<div className="flex items-center gap-4 text-xs text-muted-foreground mb-4">
					<div className="flex items-center gap-1.5">
						<Layers className="h-3.5 w-3.5" />
						<span>{formatCount} formats</span>
					</div>
					{groupCount > 0 && (
						<>
							<span className="text-muted-foreground/50">|</span>
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
					className="flex items-center justify-between w-full rounded-lg border border-border bg-background px-3 py-2 mb-4 text-left transition-colors hover:bg-muted/50"
				>
					<div className="flex items-center gap-2">
						<Server className="h-4 w-4 text-muted-foreground" />
						<span className="text-sm font-medium text-foreground">
							{statsLoading && expanded ? "Loading..." : `${instanceCount} instance${instanceCount !== 1 ? "s" : ""}`}
						</span>
					</div>
					{expanded ? (
						<ChevronUp className="h-4 w-4 text-muted-foreground" />
					) : (
						<ChevronDown className="h-4 w-4 text-muted-foreground" />
					)}
				</button>

				{/* Primary CTA */}
				<button
					type="button"
					onClick={onDeploy}
					className="w-full flex items-center justify-center gap-2 rounded-lg bg-primary px-4 py-2.5 text-sm font-medium text-primary-fg transition-colors hover:bg-primary/90"
				>
					<Rocket className="h-4 w-4" />
					Deploy
				</button>
			</div>

			{/* Expanded Instances Section */}
			{expanded && (
				<div className="border-t border-border px-5 py-4 bg-background/50">
					{statsLoading ? (
						<div className="flex items-center justify-center py-4 text-sm text-muted-foreground">
							<RefreshCw className="h-4 w-4 animate-spin mr-2" />
							Loading instances...
						</div>
					) : stats && stats.instances.length > 0 ? (
						<div className="space-y-2">
							{stats.instances.map((instance) => {
								const strategyInfo = getSyncStrategyInfo(instance.syncStrategy);
								const StrategyIcon = strategyInfo.icon;
								const isUpdating = updatingStrategyInstanceId === instance.instanceId;

								return (
									<div
										key={instance.instanceId}
										className="flex items-center justify-between rounded-lg border border-border bg-background p-3"
									>
										<div className="flex items-center gap-3 min-w-0">
											<div className="min-w-0">
												<div className="flex items-center gap-2">
													<span className="text-sm font-medium text-foreground truncate">
														{instance.instanceName}
													</span>
													<Badge variant={strategyInfo.variant} className="text-[10px] px-1.5 py-0 flex items-center gap-1">
														<StrategyIcon className={cn("h-2.5 w-2.5", isUpdating && "animate-spin")} />
														{strategyInfo.label}
													</Badge>
												</div>
												{instance.lastAppliedAt && (
													<div className="flex items-center gap-1 text-xs text-muted-foreground mt-0.5">
														<Calendar className="h-3 w-3" />
														<span>Last: {new Date(instance.lastAppliedAt).toLocaleDateString()}</span>
													</div>
												)}
											</div>
										</div>
										<div className="flex items-center gap-2">
											{/* Instance Settings Dropdown */}
											<LegacyDropdownMenu
												trigger={
													<Settings className={cn(
														"h-4 w-4 text-muted-foreground hover:text-foreground transition-colors",
														isUpdating && "animate-spin"
													)} />
												}
												align="right"
											>
												{/* Edit Overrides Option */}
												{onManageInstance && (
													<>
														<LegacyDropdownMenuItem
															icon={<SlidersHorizontal className="h-4 w-4" />}
															onClick={() => onManageInstance(instance.instanceId, instance.instanceName)}
														>
															Edit Overrides
														</LegacyDropdownMenuItem>
														<LegacyDropdownMenuDivider />
													</>
												)}
												{/* Sync Strategy Options - only enabled for mapped instances */}
												<LegacyDropdownMenuItem
													icon={<RefreshCw className="h-4 w-4 text-green-500" />}
													onClick={() => handleSyncStrategyChange(instance.instanceId, "auto")}
													disabled={isUpdating || instance.syncStrategy === "auto" || !instance.hasMapping}
												>
													Auto-sync{!instance.hasMapping && " (re-deploy required)"}
												</LegacyDropdownMenuItem>
												<LegacyDropdownMenuItem
													icon={<Bell className="h-4 w-4" style={{ color: themeGradient.from }} />}
													onClick={() => handleSyncStrategyChange(instance.instanceId, "notify")}
													disabled={isUpdating || instance.syncStrategy === "notify" || !instance.hasMapping}
												>
													Notify Only{!instance.hasMapping && " (re-deploy required)"}
												</LegacyDropdownMenuItem>
												<LegacyDropdownMenuItem
													icon={<Hand className="h-4 w-4 text-amber-500" />}
													onClick={() => handleSyncStrategyChange(instance.instanceId, "manual")}
													disabled={isUpdating || instance.syncStrategy === "manual" || !instance.hasMapping}
												>
													Manual{!instance.hasMapping && " (re-deploy required)"}
												</LegacyDropdownMenuItem>
												{onUnlinkInstance && (
													<>
														<LegacyDropdownMenuDivider />
														<LegacyDropdownMenuItem
															icon={<Unlink2 className="h-4 w-4" />}
															variant="danger"
															onClick={() => onUnlinkInstance(instance.instanceId, instance.instanceName)}
														>
															Remove from Instance
														</LegacyDropdownMenuItem>
													</>
												)}
											</LegacyDropdownMenu>
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
							<p className="text-sm text-muted-foreground">No instances deployed yet.</p>
							<p className="text-xs text-muted-foreground/70 mt-1">
								Click Deploy to add this template to an instance.
							</p>
						</div>
					)}
				</div>
			)}
		</article>
	);
};
