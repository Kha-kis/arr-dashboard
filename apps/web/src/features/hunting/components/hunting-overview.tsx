"use client";

import { useState } from "react";
import { StatCard, EmptyState, Badge, toast, Button } from "../../../components/ui";
import { Section } from "../../../components/layout";
import { Play, Search, ArrowUpCircle, Clock, CheckCircle2, AlertCircle, Gauge, Loader2, ChevronDown } from "lucide-react";
import type { HuntingStatus, InstanceHuntStatus } from "../lib/hunting-types";
import { API_USAGE_WARNING_THRESHOLD, API_USAGE_DANGER_THRESHOLD } from "../lib/constants";
import { useManualHunt } from "../hooks/useManualHunt";

interface HuntingOverviewProps {
	status: HuntingStatus | null;
	onRefresh: () => void;
}

export const HuntingOverview = ({ status, onRefresh }: HuntingOverviewProps) => {
	if (!status || status.instances.length === 0) {
		return (
			<EmptyState
				icon={Search}
				title="No instances configured for hunting"
				description="Configure hunting for your Sonarr and Radarr instances in the Configuration tab."
			/>
		);
	}

	const activeInstances = status.instances.filter(i => i.huntMissingEnabled || i.huntUpgradesEnabled);
	const totalSearchesToday = status.instances.reduce((sum, i) => sum + i.searchesToday, 0);
	const totalItemsFound = status.instances.reduce((sum, i) => sum + i.itemsFoundToday, 0);

	return (
		<div className="flex flex-col gap-10">
			{/* Global Stats */}
			<div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
				<StatCard
					label="Active Instances"
					value={activeInstances.length}
					description={`of ${status.instances.length} configured`}
				/>
				<StatCard
					label="Searches Today"
					value={totalSearchesToday}
					description="Across all instances"
				/>
				<StatCard
					label="Items Found"
					value={totalItemsFound}
					description="Content grabbed today"
				/>
				<StatCard
					label="Scheduler Status"
					value={status.schedulerRunning ? "Running" : "Stopped"}
					description={status.schedulerRunning ? "Auto-hunting active" : "Hunting paused"}
				/>
			</div>

			{/* Instance Status Cards */}
			<Section title="Instance Status" description="Current hunting status for each configured instance">
				<div className="grid gap-4 md:grid-cols-2">
					{status.instances.map((instance) => (
						<InstanceStatusCard key={instance.instanceId} instance={instance} onRefresh={onRefresh} />
					))}
				</div>
			</Section>
		</div>
	);
};

interface HuntDropdownProps {
	instance: InstanceHuntStatus;
	isTriggering: boolean;
	onTrigger: (type: "missing" | "upgrade") => void;
}

const HuntDropdown = ({ instance, isTriggering, onTrigger }: HuntDropdownProps) => {
	const [isOpen, setIsOpen] = useState(false);

	const handleSelect = (type: "missing" | "upgrade") => {
		setIsOpen(false);
		onTrigger(type);
	};

	return (
		<div className="relative">
			<Button
				variant="secondary"
				size="sm"
				onClick={() => setIsOpen(!isOpen)}
				disabled={isTriggering}
			>
				{isTriggering ? (
					<Loader2 className="h-4 w-4 animate-spin" />
				) : (
					<>
						<Play className="h-4 w-4" />
						Hunt
						<ChevronDown className="h-3 w-3 ml-1" />
					</>
				)}
			</Button>
			{isOpen && (
				<>
					<div
						className="fixed inset-0 z-40"
						onClick={() => setIsOpen(false)}
					/>
					<div className="absolute right-0 mt-1 min-w-[160px] py-1 rounded-lg border border-border bg-bg shadow-lg z-50">
						{instance.huntMissingEnabled && (
							<button
								type="button"
								className="w-full flex items-center gap-2 px-3 py-2 text-sm text-left text-fg-muted hover:text-fg hover:bg-bg-muted/50 transition-colors"
								onClick={() => handleSelect("missing")}
							>
								<Search className="h-4 w-4" />
								Hunt Missing
							</button>
						)}
						{instance.huntUpgradesEnabled && (
							<button
								type="button"
								className="w-full flex items-center gap-2 px-3 py-2 text-sm text-left text-fg-muted hover:text-fg hover:bg-bg-muted/50 transition-colors"
								onClick={() => handleSelect("upgrade")}
							>
								<ArrowUpCircle className="h-4 w-4" />
								Hunt Upgrades
							</button>
						)}
					</div>
				</>
			)}
		</div>
	);
};

interface InstanceStatusCardProps {
	instance: InstanceHuntStatus;
	onRefresh: () => void;
}

const InstanceStatusCard = ({ instance, onRefresh }: InstanceStatusCardProps) => {
	const isActive = instance.huntMissingEnabled || instance.huntUpgradesEnabled;
	const { triggerHunt, isTriggering, isCooldownError } = useManualHunt();
	const [triggeringType, setTriggeringType] = useState<"missing" | "upgrade" | null>(null);

	const handleTriggerHunt = async (type: "missing" | "upgrade") => {
		setTriggeringType(type);
		try {
			const result = await triggerHunt(instance.instanceId, type);
			toast.success(result.message);
			onRefresh();
		} catch (error) {
			if (isCooldownError(error)) {
				toast.warning(error.message);
			} else {
				toast.error(error instanceof Error ? error.message : "Failed to trigger hunt");
			}
		} finally {
			setTriggeringType(null);
		}
	};

	const isCurrentlyTriggering = isTriggering && triggeringType !== null;

	return (
		<div className="rounded-xl border border-border bg-bg-subtle/50 p-4">
			<div className="flex items-start justify-between mb-4">
				<div>
					<div className="flex items-center gap-2 mb-1">
						<h3 className="font-medium text-fg">{instance.instanceName}</h3>
						<Badge variant={instance.service === "sonarr" ? "info" : "warning"}>
							{instance.service}
						</Badge>
					</div>
					<div className="flex items-center gap-2 text-sm text-fg-muted">
						{isActive ? (
							<>
								<CheckCircle2 className="h-4 w-4 text-green-500" />
								<span>Active</span>
							</>
						) : (
							<>
								<AlertCircle className="h-4 w-4 text-fg-muted" />
								<span>Disabled</span>
							</>
						)}
					</div>
				</div>

				{/* Manual Hunt Dropdown */}
				{isActive && (
					<HuntDropdown
						instance={instance}
						isTriggering={isCurrentlyTriggering}
						onTrigger={handleTriggerHunt}
					/>
				)}
			</div>

			<div className="grid grid-cols-2 gap-4 text-sm">
				<div className="space-y-2">
					<div className="flex items-center gap-2">
						<Search className="h-4 w-4 text-fg-muted" />
						<span className="text-fg-muted">Missing:</span>
						<Badge variant={instance.huntMissingEnabled ? "success" : "default"}>
							{instance.huntMissingEnabled ? "On" : "Off"}
						</Badge>
					</div>
					{instance.huntMissingEnabled && instance.lastMissingHunt && (
						<div className="flex items-center gap-2 text-xs text-fg-muted pl-6">
							<Clock className="h-3 w-3" />
							Last: {formatRelativeTime(instance.lastMissingHunt)}
						</div>
					)}
				</div>

				<div className="space-y-2">
					<div className="flex items-center gap-2">
						<ArrowUpCircle className="h-4 w-4 text-fg-muted" />
						<span className="text-fg-muted">Upgrades:</span>
						<Badge variant={instance.huntUpgradesEnabled ? "success" : "default"}>
							{instance.huntUpgradesEnabled ? "On" : "Off"}
						</Badge>
					</div>
					{instance.huntUpgradesEnabled && instance.lastUpgradeHunt && (
						<div className="flex items-center gap-2 text-xs text-fg-muted pl-6">
							<Clock className="h-3 w-3" />
							Last: {formatRelativeTime(instance.lastUpgradeHunt)}
						</div>
					)}
				</div>
			</div>

			<div className="mt-4 pt-4 border-t border-border flex justify-between text-sm">
				<div className="text-fg-muted">
					<span className="font-medium text-fg">{instance.searchesToday}</span> searches today
				</div>
				<div className="text-fg-muted">
					<span className="font-medium text-fg">{instance.itemsFoundToday}</span> items found
				</div>
			</div>

			{/* API Usage Indicator */}
			<ApiUsageIndicator
				current={instance.apiCallsThisHour}
				max={instance.hourlyApiCap}
			/>
		</div>
	);
};

interface ApiUsageIndicatorProps {
	current: number;
	max: number;
}

const ApiUsageIndicator = ({ current, max }: ApiUsageIndicatorProps) => {
	const percentage = max > 0 ? Math.min((current / max) * 100, 100) : 0;

	// Determine color based on usage thresholds
	const getColorClass = () => {
		if (percentage >= API_USAGE_DANGER_THRESHOLD) return "bg-red-500";
		if (percentage >= API_USAGE_WARNING_THRESHOLD) return "bg-yellow-500";
		return "bg-green-500";
	};

	const getStatusText = () => {
		if (percentage >= API_USAGE_DANGER_THRESHOLD) return "Near limit";
		if (percentage >= API_USAGE_WARNING_THRESHOLD) return "Moderate";
		return "Healthy";
	};

	const getBadgeVariant = () => {
		if (percentage >= API_USAGE_DANGER_THRESHOLD) return "danger" as const;
		if (percentage >= API_USAGE_WARNING_THRESHOLD) return "warning" as const;
		return "success" as const;
	};

	return (
		<div className="mt-3 pt-3 border-t border-border">
			<div className="flex items-center justify-between text-xs mb-1.5">
				<div className="flex items-center gap-1.5 text-fg-muted">
					<Gauge className="h-3.5 w-3.5" />
					<span>API Usage (hourly)</span>
				</div>
				<div className="flex items-center gap-2">
					<span className="text-fg-muted">
						<span className="font-medium text-fg">{current}</span>/{max}
					</span>
					<Badge
						variant={getBadgeVariant()}
						className="text-[10px] px-1.5 py-0"
					>
						{getStatusText()}
					</Badge>
				</div>
			</div>
			<div className="h-1.5 bg-bg-subtle rounded-full overflow-hidden">
				<div
					className={`h-full transition-all duration-300 rounded-full ${getColorClass()}`}
					style={{ width: `${percentage}%` }}
				/>
			</div>
		</div>
	);
};

/**
 * Formats an ISO- or parseable-date string into a compact, human-friendly relative time.
 *
 * @param dateString - A date string recognized by the JavaScript Date constructor.
 * @returns `"Just now"` if less than 1 minute; `"<m>m ago"` if less than 60 minutes; `"<h>h ago"` if less than 24 hours; otherwise `"<d>d ago"`
 */
function formatRelativeTime(dateString: string): string {
	const date = new Date(dateString);
	const now = new Date();
	const diffMs = now.getTime() - date.getTime();
	const diffMins = Math.floor(diffMs / 60000);

	if (diffMins < 1) return "Just now";
	if (diffMins < 60) return `${diffMins}m ago`;

	const diffHours = Math.floor(diffMins / 60);
	if (diffHours < 24) return `${diffHours}h ago`;

	const diffDays = Math.floor(diffHours / 24);
	return `${diffDays}d ago`;
}