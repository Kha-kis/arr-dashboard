"use client";

import { useState } from "react";
import {
	Trash2,
	Play,
	Eye,
	CheckCircle2,
	Loader2,
	Zap,
	ShieldAlert,
	SkipForward,
} from "lucide-react";
import { Button, toast } from "../../../components/ui";
import {
	StatCard,
	PremiumEmptyState,
	PremiumSection,
	ServiceBadge,
	StatusBadge,
	GlassmorphicCard,
} from "../../../components/layout";
import { getServiceGradient, SEMANTIC_COLORS } from "../../../lib/theme-gradients";
import type { QueueCleanerStatus, InstanceCleanerStatus } from "../lib/queue-cleaner-types";
import { useManualClean } from "../hooks/useManualClean";
import { useEnhancedPreview } from "../hooks/useDryRun";
import { EnhancedDryRunPreview } from "./dry-run-preview";

interface OverviewProps {
	status: QueueCleanerStatus | null;
	onRefresh: () => void;
}

export const QueueCleanerOverview = ({ status, onRefresh }: OverviewProps) => {

	if (!status || status.instances.length === 0) {
		return (
			<PremiumEmptyState
				icon={Trash2}
				title="No instances available"
				description="Add Sonarr or Radarr instances in Settings to get started with queue cleaning."
			/>
		);
	}

	const activeInstances = status.instances.filter((i) => i.enabled);
	const totalCleanedToday = status.instances.reduce((sum, i) => sum + i.cleanedToday, 0);
	const totalSkippedToday = status.instances.reduce((sum, i) => sum + i.skippedToday, 0);

	return (
		<div className="flex flex-col gap-10">
			{/* Stats Grid */}
			<div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
				<StatCard
					icon={Trash2}
					value={activeInstances.length}
					label="Active Instances"
					description={`of ${status.instances.length} configured`}
					animationDelay={0}
				/>
				<StatCard
					icon={CheckCircle2}
					value={totalCleanedToday}
					label="Cleaned Today"
					description="Items removed from queues"
					animationDelay={50}
				/>
				<StatCard
					icon={SkipForward}
					value={totalSkippedToday}
					label="Skipped Today"
					description="Items evaluated but kept"
					animationDelay={100}
				/>
				<StatCard
					icon={Zap}
					value={status.schedulerRunning ? "Running" : "Stopped"}
					label="Scheduler Status"
					description={status.schedulerRunning ? "Auto-cleaning active" : "Cleaning paused"}
					gradient={status.schedulerRunning ? SEMANTIC_COLORS.success : undefined}
					animationDelay={150}
				/>
			</div>

			{/* Instance Cards */}
			<PremiumSection
				title="Instance Status"
				description="Current queue cleaner status for each instance"
				icon={Trash2}
				animationDelay={200}
			>
				<div className="grid gap-4 md:grid-cols-2">
					{status.instances.map((instance, index) => (
						<InstanceStatusCard
							key={instance.instanceId}
							instance={instance}
							onRefresh={onRefresh}
							animationDelay={250 + index * 50}
						/>
					))}
				</div>
			</PremiumSection>
		</div>
	);
};

interface InstanceStatusCardProps {
	instance: InstanceCleanerStatus;
	onRefresh: () => void;
	animationDelay: number;
}

const InstanceStatusCard = ({
	instance,
	onRefresh,
	animationDelay,
}: InstanceStatusCardProps) => {
	const serviceGradient = getServiceGradient(instance.service);
	const { triggerClean, isTriggering, isCooldownError } = useManualClean();
	const {
		runPreview,
		runClean,
		previewResult,
		isLoadingPreview,
		isRunningClean,
		resetPreview,
	} = useEnhancedPreview();
	const [showPreview, setShowPreview] = useState(false);

	const handleManualClean = async () => {
		try {
			const result = await triggerClean(instance.instanceId);
			toast.success(result.message);
			setTimeout(() => void onRefresh(), 2000);
		} catch (error) {
			if (isCooldownError(error)) {
				toast.warning((error as Error).message);
			} else {
				toast.error(error instanceof Error ? error.message : "Failed to trigger clean");
			}
		}
	};

	const handlePreview = async () => {
		try {
			await runPreview(instance.instanceId);
			setShowPreview(true);
		} catch (error) {
			toast.error(error instanceof Error ? error.message : "Preview failed");
		}
	};

	const handleRunClean = async () => {
		await runClean(instance.instanceId);
		setTimeout(() => void onRefresh(), 2000);
	};

	const lastRunDate = instance.lastRunAt ? new Date(instance.lastRunAt) : null;
	const lastRunAgo = lastRunDate
		? getTimeAgo(lastRunDate)
		: "Never";

	return (
		<>
			<div
				className="animate-in fade-in slide-in-from-bottom-2 duration-300"
				style={{ animationDelay: `${animationDelay}ms`, animationFillMode: "backwards" }}
			>
				<GlassmorphicCard>
					{/* Service accent line */}
					<div
						className="absolute top-0 left-0 right-0 h-0.5 rounded-t-xl"
						style={{
							background: `linear-gradient(90deg, ${serviceGradient.from}, ${serviceGradient.to})`,
						}}
					/>

					<div className="p-5">
						{/* Header */}
						<div className="flex items-start justify-between mb-4">
							<div className="flex items-center gap-3">
								<div
									className="flex h-9 w-9 items-center justify-center rounded-lg"
									style={{
										background: `linear-gradient(135deg, ${serviceGradient.from}20, ${serviceGradient.to}10)`,
										border: `1px solid ${serviceGradient.from}30`,
									}}
								>
									<Trash2
										className="h-4 w-4"
										style={{ color: serviceGradient.from }}
									/>
								</div>
								<div>
									<h4 className="font-medium text-foreground">
										{instance.instanceName}
									</h4>
									<div className="flex items-center gap-2 mt-0.5">
										<ServiceBadge service={instance.service} />
										{instance.dryRunMode && instance.hasConfig && (
											<span className="inline-flex items-center gap-1 rounded-full bg-amber-500/10 px-2 py-0.5 text-[10px] font-medium text-amber-400 border border-amber-500/20">
												<ShieldAlert className="h-3 w-3" />
												Dry Run
											</span>
										)}
									</div>
								</div>
							</div>
							<StatusBadge status={instance.enabled ? "success" : "info"}>
								{instance.enabled ? "Active" : "Inactive"}
							</StatusBadge>
						</div>

						{/* Stats row */}
						<div className="grid grid-cols-3 gap-3 mb-4">
							<div className="rounded-lg bg-card/50 p-2.5 text-center">
								<div className="text-xs text-muted-foreground">Cleaned</div>
								<div className="text-lg font-semibold text-foreground">
									{instance.cleanedToday}
								</div>
							</div>
							<div className="rounded-lg bg-card/50 p-2.5 text-center">
								<div className="text-xs text-muted-foreground">Skipped</div>
								<div className="text-lg font-semibold text-foreground">
									{instance.skippedToday}
								</div>
							</div>
							<div className="rounded-lg bg-card/50 p-2.5 text-center">
								<div className="text-xs text-muted-foreground">Last Run</div>
								<div className="text-xs font-medium text-foreground mt-1">
									{lastRunAgo}
								</div>
							</div>
						</div>

						{/* Actions */}
						{instance.hasConfig && (
							<div className="flex gap-2">
								<Button
									variant="secondary"
									size="sm"
									className="flex-1 gap-1.5 text-xs"
									onClick={() => void handleManualClean()}
									disabled={isTriggering || !instance.enabled}
								>
									{isTriggering ? (
										<Loader2 className="h-3 w-3 animate-spin" />
									) : (
										<Play className="h-3 w-3" />
									)}
									Run Now
								</Button>
								<Button
									variant="secondary"
									size="sm"
									className="flex-1 gap-1.5 text-xs"
									onClick={() => void handlePreview()}
									disabled={isLoadingPreview}
								>
									{isLoadingPreview ? (
										<Loader2 className="h-3 w-3 animate-spin" />
									) : (
										<Eye className="h-3 w-3" />
									)}
									Preview
								</Button>
							</div>
						)}

						{!instance.hasConfig && (
							<p className="text-xs text-muted-foreground text-center py-2">
								Configure in the Configuration tab to get started
							</p>
						)}
					</div>
				</GlassmorphicCard>
			</div>

			{/* Enhanced Preview Modal */}
			{showPreview && previewResult && (
				<EnhancedDryRunPreview
					result={previewResult}
					onClose={() => {
						setShowPreview(false);
						resetPreview();
					}}
					onRunClean={handleRunClean}
					isRunningClean={isRunningClean}
				/>
			)}
		</>
	);
};

function getTimeAgo(date: Date): string {
	const now = new Date();
	const diffMs = now.getTime() - date.getTime();
	const diffMins = Math.floor(diffMs / (60 * 1000));

	if (diffMins < 1) return "Just now";
	if (diffMins < 60) return `${diffMins}m ago`;
	const diffHours = Math.floor(diffMins / 60);
	if (diffHours < 24) return `${diffHours}h ago`;
	const diffDays = Math.floor(diffHours / 24);
	return `${diffDays}d ago`;
}
