"use client";

import { useState, lazy, Suspense } from "react";
import { useTemplateStats, useTemplate } from "../../../hooks/api/useTemplates";
import { ChevronDown, ChevronUp, Calendar, Package, Activity, Rocket, Layers, History, SlidersHorizontal, Unlink2, RefreshCw, Bell, Hand, Sliders } from "lucide-react";
import { DeploymentHistoryTable } from "./deployment-history-table";
import { InstanceOverrideEditor } from "./instance-override-editor";

// Lazy-loaded modals — only fetched when the user opens them
const BulkDeploymentModal = lazy(() => import("./bulk-deployment-modal").then(m => ({ default: m.BulkDeploymentModal })));
const InstanceQualityOverrideModal = lazy(() => import("./instance-quality-override-modal").then(m => ({ default: m.InstanceQualityOverrideModal })));
import { getEffectiveQualityConfig } from "../lib/quality-config-utils";
import { LegacyDropdownMenu, LegacyDropdownMenuItem, Badge, Button } from "../../../components/ui";
import {
	LegacyDialog,
	LegacyDialogHeader,
	LegacyDialogTitle,
	LegacyDialogDescription,
	LegacyDialogContent,
	LegacyDialogFooter,
} from "../../../components/ui";
import { useUpdateSyncStrategy, useBulkUpdateSyncStrategy } from "../../../hooks/api/useDeploymentPreview";
import { cn } from "../../../lib/utils";
import { useThemeGradient } from "../../../hooks/useThemeGradient";
import { toast } from "sonner";
import { getErrorMessage } from "../../../lib/error-utils";

// Helper to get sync strategy display info - color is handled dynamically for notify
const getSyncStrategyInfo = (strategy: "auto" | "manual" | "notify") => {
	switch (strategy) {
		case "auto":
			return { label: "Auto-sync", icon: RefreshCw, variant: "success" as const, colorClass: "text-green-500" };
		case "notify":
			return { label: "Notify", icon: Bell, variant: "info" as const, colorClass: null }; // Theme color
		case "manual":
			return { label: "Manual", icon: Hand, variant: "warning" as const, colorClass: "text-amber-500" };
	}
};

interface TemplateStatsProps {
	templateId: string;
	templateName: string;
	onDeploy?: (instanceId: string, instanceName: string) => void;
	onUnlinkInstance?: (instanceId: string, instanceName: string) => void;
}

export const TemplateStats = ({ templateId, templateName, onDeploy, onUnlinkInstance }: TemplateStatsProps) => {
	const { gradient: themeGradient } = useThemeGradient();
	const [expanded, setExpanded] = useState(false);
	const [showBulkDeployment, setShowBulkDeployment] = useState(false);
	const [showHistory, setShowHistory] = useState(false);
	const [overrideModal, setOverrideModal] = useState<{
		instanceId: string;
		instanceName: string;
	} | null>(null);
	const [qualityOverrideModal, setQualityOverrideModal] = useState<{
		instanceId: string;
		instanceName: string;
	} | null>(null);
	const [updatingStrategyInstanceId, setUpdatingStrategyInstanceId] = useState<string | null>(null);

	const updateSyncStrategyMutation = useUpdateSyncStrategy();
	const bulkUpdateSyncStrategyMutation = useBulkUpdateSyncStrategy();

	const handleBulkSyncStrategyChange = (newStrategy: "auto" | "manual" | "notify") => {
		const strategyLabel = getSyncStrategyInfo(newStrategy).label;
		bulkUpdateSyncStrategyMutation.mutate(
			{
				templateId,
				syncStrategy: newStrategy,
			},
			{
				onSuccess: () => {
					toast.success(`All instances set to ${strategyLabel}`);
				},
				onError: (error) => {
					toast.error(`Failed to update sync strategy: ${getErrorMessage(error, "Unknown error")}`);
				},
			}
		);
	};

	const handleSyncStrategyChange = (instanceId: string, newStrategy: "auto" | "manual" | "notify") => {
		const strategyLabel = getSyncStrategyInfo(newStrategy).label;
		setUpdatingStrategyInstanceId(instanceId);
		updateSyncStrategyMutation.mutate(
			{ templateId, instanceId, syncStrategy: newStrategy },
			{
				onSuccess: () => {
					toast.success(`Sync strategy updated to ${strategyLabel}`);
				},
				onError: (error) => {
					toast.error(`Failed to update sync strategy: ${getErrorMessage(error, "Unknown error")}`);
				},
				onSettled: () => setUpdatingStrategyInstanceId(null),
			}
		);
	};

	// Fetch template data when expanded or modal is open (to show quality override button and modal content)
	const { data: templateData, isLoading: templateLoading } = useTemplate(
		expanded || overrideModal || qualityOverrideModal ? templateId : null
	);

	const { data, isLoading } = useTemplateStats(templateId);

	if (isLoading && expanded) {
		return (
			<div className="rounded-lg border border-border bg-card p-4">
				<div className="flex items-center gap-2 text-sm text-muted-foreground">
					<Activity className="h-4 w-4 animate-spin" />
					<span>Loading stats...</span>
				</div>
			</div>
		);
	}

	const stats = data?.stats;

	return (
		<div className="space-y-2">
			{/* Stats Summary */}
			<button
				type="button"
				onClick={() => setExpanded(!expanded)}
				aria-expanded={expanded}
				className="flex w-full items-center justify-between rounded-lg border border-border bg-card p-3 text-left transition hover:bg-card/80"
			>
				<div className="flex items-center gap-3">
					<Activity className="h-4 w-4 text-primary" />
					<span className="text-sm font-medium text-foreground">Template Stats</span>
					{stats && stats.instances.length > 0 && (
						<span className="text-xs text-muted-foreground">
							{stats.instances.length} instance{stats.instances.length !== 1 ? "s" : ""}
						</span>
					)}
				</div>
				{expanded ? (
					<ChevronUp className="h-4 w-4 text-muted-foreground" />
				) : (
					<ChevronDown className="h-4 w-4 text-muted-foreground" />
				)}
			</button>

			{/* Expanded Stats Details */}
			{expanded && stats && (
				<div className="rounded-lg border border-border bg-card p-4 space-y-4">
					{/* Action Buttons */}
					<div className="flex items-center gap-2 justify-center">
						<button
							type="button"
							onClick={() => setShowHistory(true)}
							className="flex items-center gap-2 rounded-lg border border-border bg-card px-3 py-2 text-sm font-medium text-foreground transition hover:bg-card/80"
						>
							<History className="h-4 w-4" />
							View Deployment History
						</button>
					</div>

					{/* Metrics Grid */}
					<div className="grid grid-cols-3 gap-4">
						<div className="space-y-1 text-center">
							<div className="flex items-center gap-2 text-xs text-muted-foreground justify-center">
								<Package className="h-3 w-3" />
								<span>Formats</span>
							</div>
							<p className="text-lg font-semibold text-foreground">{stats.formatCount}</p>
						</div>

						<div className="space-y-1 text-center">
							<div className="flex items-center gap-2 text-xs text-muted-foreground justify-center">
								<Package className="h-3 w-3" />
								<span>Groups</span>
							</div>
							<p className="text-lg font-semibold text-foreground">{stats.groupCount}</p>
						</div>

						<div className="space-y-1 text-center">
							<div className="flex items-center gap-2 text-xs text-muted-foreground justify-center">
								<Calendar className="h-3 w-3" />
								<span>Last Deployed</span>
							</div>
							<p className="text-xs font-medium text-foreground">
								{stats.lastUsedAt ? new Date(stats.lastUsedAt).toLocaleDateString() : "Never"}
							</p>
						</div>
					</div>

					{/* Instances List */}
					{stats.instances.length > 0 && (
						<div className="space-y-2">
							<div className="flex flex-col items-center gap-2">
								<h4 className="text-sm font-medium text-muted-foreground">Instances Using This Template</h4>
								{stats.instances.length > 1 && (
									<div className="flex items-center gap-2">
										<button
											type="button"
											onClick={(e) => {
												e.stopPropagation();
												setShowBulkDeployment(true);
											}}
											className="flex items-center gap-1 rounded bg-primary/20 px-2 py-1 text-xs font-medium text-primary transition hover:bg-primary/30"
											title="Deploy to multiple instances at once"
										>
											<Layers className="h-3 w-3" />
											Bulk Deploy
										</button>
										{/* Bulk Sync Strategy Dropdown */}
										<LegacyDropdownMenu
											trigger={
												<div
													className={cn(
														"flex items-center gap-1 rounded border border-border bg-card px-2 py-1 text-xs font-medium text-muted-foreground transition hover:bg-card/80 cursor-pointer",
														bulkUpdateSyncStrategyMutation.isPending && "opacity-50 pointer-events-none"
													)}
													title="Set sync strategy for all instances"
												>
													{bulkUpdateSyncStrategyMutation.isPending ? (
														<RefreshCw className="h-3 w-3 animate-spin" />
													) : (
														<SlidersHorizontal className="h-3 w-3" />
													)}
													Set All Strategy
												</div>
											}
											align="right"
										>
											<LegacyDropdownMenuItem
												icon={<RefreshCw className="h-4 w-4 text-green-500" />}
												onClick={() => handleBulkSyncStrategyChange("auto")}
												disabled={bulkUpdateSyncStrategyMutation.isPending}
											>
												All Auto-sync
											</LegacyDropdownMenuItem>
											<LegacyDropdownMenuItem
												icon={<Bell className="h-4 w-4" style={{ color: themeGradient.from }} />}
												onClick={() => handleBulkSyncStrategyChange("notify")}
												disabled={bulkUpdateSyncStrategyMutation.isPending}
											>
												All Notify Only
											</LegacyDropdownMenuItem>
											<LegacyDropdownMenuItem
												icon={<Hand className="h-4 w-4 text-amber-500" />}
												onClick={() => handleBulkSyncStrategyChange("manual")}
												disabled={bulkUpdateSyncStrategyMutation.isPending}
											>
												All Manual
											</LegacyDropdownMenuItem>
										</LegacyDropdownMenu>
									</div>
								)}
							</div>
							<div className="space-y-2">
								{stats.instances.map((instance) => {
									const strategyInfo = getSyncStrategyInfo(instance.syncStrategy);
									const StrategyIcon = strategyInfo.icon;
									const isUpdating = updatingStrategyInstanceId === instance.instanceId;

									return (
									<div
										key={instance.instanceId}
										className="flex flex-col gap-2 rounded border border-border bg-card p-2"
									>
										{/* Top: Instance name + strategy badge */}
										<div className="flex items-center justify-center gap-2">
											<span className="text-sm font-medium text-foreground">{instance.instanceName}</span>
											<Badge variant={strategyInfo.variant} className="text-[10px] px-1.5 py-0 flex items-center gap-1">
												<StrategyIcon className={cn("h-2.5 w-2.5", isUpdating && "animate-spin")} />
												{strategyInfo.label}
											</Badge>
										</div>

										{/* Bottom: Actions */}
										<div className="flex items-center justify-center gap-1">
											{onDeploy && (
												<button
													type="button"
													onClick={(e) => {
														e.stopPropagation();
														onDeploy(instance.instanceId, instance.instanceName);
													}}
													className="flex items-center justify-center rounded bg-green-500/20 p-1.5 text-green-400 transition hover:bg-green-500/30"
													title="Deploy template to this instance"
												>
													<Rocket className="h-3.5 w-3.5" />
												</button>
											)}
											{/* Sync Strategy Dropdown - only enabled for mapped instances */}
											{instance.hasMapping ? (
												<LegacyDropdownMenu
													trigger={
														<div className="flex items-center justify-center rounded border border-border bg-card p-1.5 text-muted-foreground transition hover:bg-card/80 cursor-pointer" title="Change sync strategy">
															<StrategyIcon className={cn("h-3.5 w-3.5", strategyInfo.colorClass, isUpdating && "animate-spin")} />
														</div>
													}
													align="right"
												>
													<LegacyDropdownMenuItem
														icon={<RefreshCw className="h-4 w-4 text-green-500" />}
														onClick={() => handleSyncStrategyChange(instance.instanceId, "auto")}
														disabled={isUpdating || instance.syncStrategy === "auto"}
													>
														Auto-sync
													</LegacyDropdownMenuItem>
													<LegacyDropdownMenuItem
														icon={<Bell className="h-4 w-4" style={{ color: themeGradient.from }} />}
														onClick={() => handleSyncStrategyChange(instance.instanceId, "notify")}
														disabled={isUpdating || instance.syncStrategy === "notify"}
													>
														Notify Only
													</LegacyDropdownMenuItem>
													<LegacyDropdownMenuItem
														icon={<Hand className="h-4 w-4 text-amber-500" />}
														onClick={() => handleSyncStrategyChange(instance.instanceId, "manual")}
														disabled={isUpdating || instance.syncStrategy === "manual"}
													>
														Manual
													</LegacyDropdownMenuItem>
												</LegacyDropdownMenu>
											) : (
												<div
													className="flex items-center justify-center rounded border border-border bg-card p-1.5 text-muted-foreground/50 cursor-not-allowed"
													title="Re-deploy template to change sync strategy"
												>
													<StrategyIcon className="h-3.5 w-3.5 text-muted-foreground/50" />
												</div>
											)}
											<button
												type="button"
												onClick={(e) => {
													e.stopPropagation();
													setOverrideModal({
														instanceId: instance.instanceId,
														instanceName: instance.instanceName,
													});
												}}
												className="flex items-center justify-center rounded border border-border bg-card p-1.5 text-muted-foreground transition hover:bg-card/80"
												title="Manage instance score overrides"
											>
												<SlidersHorizontal className="h-3.5 w-3.5" />
											</button>
											{/* Quality Override Button - configure instance-specific quality settings */}
											<button
												type="button"
												onClick={(e) => {
													e.stopPropagation();
													setQualityOverrideModal({
														instanceId: instance.instanceId,
														instanceName: instance.instanceName,
													});
												}}
												className="flex items-center justify-center rounded border border-purple-500/30 bg-purple-500/10 p-1.5 text-purple-500 transition hover:bg-purple-500/20"
												title="Configure quality settings for this instance"
											>
												<Sliders className="h-3.5 w-3.5" />
											</button>
											{onUnlinkInstance && (
												<button
													type="button"
													onClick={(e) => {
														e.stopPropagation();
														onUnlinkInstance(instance.instanceId, instance.instanceName);
													}}
													className="flex items-center justify-center rounded bg-red-500/20 p-1.5 text-red-400 transition hover:bg-red-500/30"
													title="Remove template from this instance"
												>
													<Unlink2 className="h-3.5 w-3.5" />
												</button>
											)}
										</div>
									</div>
								);
							})}
							</div>
						</div>
					)}

					{stats.instances.length === 0 && (
						<div className="rounded border border-border bg-card p-4 text-center">
							<p className="text-sm text-muted-foreground">No instances have used this template yet.</p>
						</div>
					)}
				</div>
			)}

			{/* Bulk Deployment Modal (lazy-loaded) */}
			{showBulkDeployment && stats && (
				<Suspense>
					<BulkDeploymentModal
						open={showBulkDeployment}
						onClose={() => setShowBulkDeployment(false)}
						templateId={templateId}
						templateName={templateName}
						serviceType={templateData?.template?.serviceType}
						templateDefaultQualityConfig={getEffectiveQualityConfig(templateData?.template?.config)}
						instanceOverrides={templateData?.template?.instanceOverrides}
						instances={stats.instances.map((inst) => ({
							instanceId: inst.instanceId,
							instanceLabel: inst.instanceName,
							instanceType: inst.instanceType,
						}))}
						onDeploySuccess={() => {
							setShowBulkDeployment(false);
						}}
					/>
				</Suspense>
			)}

			{/* Deployment History Modal */}
			<LegacyDialog open={showHistory} onOpenChange={setShowHistory} size="xl">
				<LegacyDialogHeader>
					<LegacyDialogTitle>
						<div className="flex items-center gap-2">
							<History className="h-5 w-5" />
							Deployment History
						</div>
					</LegacyDialogTitle>
					<LegacyDialogDescription>
						{templateName}
					</LegacyDialogDescription>
				</LegacyDialogHeader>

				<LegacyDialogContent>
					<DeploymentHistoryTable templateId={templateId} limit={10} />
				</LegacyDialogContent>

				<LegacyDialogFooter>
					<Button variant="ghost" onClick={() => setShowHistory(false)}>
						Close
					</Button>
				</LegacyDialogFooter>
			</LegacyDialog>

			{/* Instance Override Editor Modal */}
			{overrideModal && templateLoading && (
				<div
					className="fixed inset-0 bg-black/50 flex items-center justify-center z-modal"
					role="dialog"
					aria-modal="true"
					aria-label="Loading template data"
				>
					<div className="bg-background rounded-lg shadow-lg p-8 text-center">
						<Activity className="h-8 w-8 animate-spin mx-auto mb-4 text-primary" />
						<p className="text-sm text-muted-foreground">Loading template data...</p>
					</div>
				</div>
			)}
			{overrideModal && !templateLoading && templateData && (
				<InstanceOverrideEditor
					open={!!overrideModal}
					onClose={() => setOverrideModal(null)}
					templateId={templateId}
					templateName={templateName}
					instanceId={overrideModal.instanceId}
					instanceLabel={overrideModal.instanceName}
					customFormats={
						templateData.template?.config?.customFormats?.map((cf) => {
							// Resolve score using the same logic as deployment executor
							const scoreSet = templateData.template?.config?.qualityProfile?.trash_score_set;
							let defaultScore = 0;

							// Cast originalConfig to access trash_scores (actual TRaSH API data has this)
							const originalConfig = cf.originalConfig as { trash_scores?: Record<string, number>; score?: number } | undefined;

							// Priority 1: User's score override
							if (cf.scoreOverride !== undefined && cf.scoreOverride !== null) {
								defaultScore = cf.scoreOverride;
							}
							// Priority 2: TRaSH score from profile's score set
							else if (scoreSet && originalConfig?.trash_scores?.[scoreSet] !== undefined) {
								defaultScore = originalConfig.trash_scores[scoreSet];
							}
							// Priority 3: TRaSH default score
							else if (originalConfig?.trash_scores?.default !== undefined) {
								defaultScore = originalConfig.trash_scores.default;
							}
							// Priority 4: Legacy score field from originalConfig
							else if (originalConfig?.score !== undefined) {
								defaultScore = originalConfig.score;
							}
							// Priority 5: Score from template custom format
							else if (cf.score !== undefined) {
								defaultScore = cf.score;
							}

							return {
								trashId: cf.trashId,
								name: cf.name,
								defaultScore,
							};
						}) ?? []
					}
				/>
			)}

			{/* Instance Quality Override Modal (lazy-loaded) */}
			{qualityOverrideModal && (
				<Suspense>
					<InstanceQualityOverrideModal
						open={!!qualityOverrideModal}
						onClose={() => setQualityOverrideModal(null)}
						templateId={templateId}
						templateName={templateName}
						instanceId={qualityOverrideModal.instanceId}
						instanceLabel={qualityOverrideModal.instanceName}
						serviceType={(templateData?.template?.serviceType ?? stats?.instances.find(i => i.instanceId === qualityOverrideModal.instanceId)?.instanceType ?? "RADARR") as "RADARR" | "SONARR"}
						templateDefaultConfig={getEffectiveQualityConfig(templateData?.template?.config)}
						onSaved={() => {
							// Optionally refresh data
						}}
					/>
				</Suspense>
			)}
		</div>
	);
};
