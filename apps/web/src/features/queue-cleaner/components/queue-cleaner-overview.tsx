"use client";

import {
	CheckCircle2,
	Eye,
	Loader2,
	Play,
	ShieldAlert,
	SkipForward,
	Sparkles,
	Trash2,
	Zap,
} from "lucide-react";
import { useState } from "react";
import {
	PremiumEmptyState,
	PremiumSection,
	ServiceBadge,
	StatCard,
	StatusBadge,
} from "../../../components/layout";
import { Button, toast } from "../../../components/ui";
import { getErrorMessage } from "../../../lib/error-utils";
import { getLinuxInstanceName, useIncognitoMode } from "../../../lib/incognito";
import { POST_CLEAN_REFRESH_DELAY_MS } from "../lib/constants";
import { getServiceGradient, SEMANTIC_COLORS } from "../../../lib/theme-gradients";
import { useEnhancedPreview } from "../hooks/useDryRun";
import { useManualClean } from "../hooks/useManualClean";
import type { InstanceCleanerStatus, QueueCleanerStatus } from "../lib/queue-cleaner-types";
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

const InstanceStatusCard = ({ instance, onRefresh, animationDelay }: InstanceStatusCardProps) => {
	const serviceGradient = getServiceGradient(instance.service);
	const [incognitoMode] = useIncognitoMode();
	const { triggerClean, isTriggering, isCooldownError } = useManualClean();
	const { runPreview, runClean, previewResult, isLoadingPreview, isRunningClean, resetPreview } =
		useEnhancedPreview();
	const [showPreview, setShowPreview] = useState(false);

	const handleManualClean = async () => {
		try {
			const result = await triggerClean(instance.instanceId);
			toast.success(result.message);
			setTimeout(() => void onRefresh(), POST_CLEAN_REFRESH_DELAY_MS);
		} catch (error) {
			if (isCooldownError(error)) {
				toast.warning((error as Error).message);
			} else {
				toast.error(getErrorMessage(error, "Failed to trigger clean"));
			}
		}
	};

	const handlePreview = async () => {
		try {
			await runPreview(instance.instanceId);
			setShowPreview(true);
		} catch (error) {
			toast.error(getErrorMessage(error, "Preview failed"));
		}
	};

	const handleRunClean = async () => {
		await runClean(instance.instanceId);
		setTimeout(() => void onRefresh(), POST_CLEAN_REFRESH_DELAY_MS);
	};

	const lastRunDate = instance.lastRunAt ? new Date(instance.lastRunAt) : null;
	const lastRunAgo = lastRunDate ? getTimeAgo(lastRunDate) : "Never";

	const accent = instance.enabled
		? { from: serviceGradient.from, to: serviceGradient.to }
		: { from: "#6b7280", to: "#9ca3af" };

	return (
		<>
			<div
				className="group relative rounded-xl overflow-hidden transition-all duration-200 hover:-translate-y-[1px] hover:shadow-lg hover:shadow-black/10 animate-in fade-in slide-in-from-bottom-1 duration-300"
				style={{
					border: `1px solid ${accent.from}10`,
					animationDelay: `${animationDelay}ms`,
					animationFillMode: "backwards",
				}}
			>
				{/* Background gradient */}
				<div
					className="absolute inset-0 pointer-events-none"
					style={{
						background: `linear-gradient(135deg, ${accent.from}04, transparent 60%)`,
					}}
				/>

				{/* Hover glow */}
				<div
					className="absolute inset-0 pointer-events-none opacity-0 group-hover:opacity-100 transition-opacity duration-200"
					style={{
						background: `radial-gradient(ellipse at top left, ${accent.from}06, transparent 50%)`,
					}}
				/>

				{/* Service accent bar */}
				<div
					className="absolute left-0 top-0 bottom-0 w-[3px]"
					style={{
						background: `linear-gradient(180deg, ${accent.from}, ${accent.to}70)`,
					}}
				/>

				<div className="relative p-5">
					{/* Header */}
					<div className="flex items-start justify-between mb-4">
						<div className="flex items-center gap-2">
							<span
								className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider shrink-0"
								style={{
									backgroundColor: `${serviceGradient.from}12`,
									color: serviceGradient.from,
								}}
							>
								<Sparkles className="h-2.5 w-2.5" />
								Cleaner
							</span>
							<div>
								<div className="flex items-center gap-2">
									<h4 className="font-semibold text-[14px] text-foreground leading-snug">
										{incognitoMode ? getLinuxInstanceName(instance.instanceName) : instance.instanceName}
									</h4>
									<ServiceBadge service={instance.service} />
									{instance.dryRunMode && instance.hasConfig && (
										<span className="inline-flex items-center gap-1 rounded-md bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-semibold text-amber-400 border border-amber-500/15">
											<ShieldAlert className="h-2.5 w-2.5" />
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
						<div
							className="rounded-lg p-2.5 text-center"
							style={{
								backgroundColor: `${serviceGradient.from}06`,
								border: `1px solid ${serviceGradient.from}10`,
							}}
						>
							<div className="text-[10px] text-muted-foreground/50">Cleaned</div>
							<div className="text-lg font-semibold text-foreground">
								{instance.cleanedToday}
							</div>
						</div>
						<div
							className="rounded-lg p-2.5 text-center"
							style={{
								backgroundColor: `${serviceGradient.from}06`,
								border: `1px solid ${serviceGradient.from}10`,
							}}
						>
							<div className="text-[10px] text-muted-foreground/50">Skipped</div>
							<div className="text-lg font-semibold text-foreground">
								{instance.skippedToday}
							</div>
						</div>
						<div
							className="rounded-lg p-2.5 text-center"
							style={{
								backgroundColor: `${serviceGradient.from}06`,
								border: `1px solid ${serviceGradient.from}10`,
							}}
						>
							<div className="text-[10px] text-muted-foreground/50">Last Run</div>
							<div className="text-xs font-medium text-foreground mt-1">{lastRunAgo}</div>
						</div>
					</div>

					{/* Actions */}
					{instance.hasConfig && (
						<div className="flex gap-2">
							<Button
								variant="secondary"
								size="sm"
								className="flex-1 gap-1.5 text-xs border-border/50 bg-card/50"
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
								className="flex-1 gap-1.5 text-xs border-border/50 bg-card/50"
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
						<p className="text-[11px] text-muted-foreground/40 text-center py-2">
							Configure in the Configuration tab to get started
						</p>
					)}
				</div>
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
