"use client";

import { Button, StatCard, EmptyState, Badge } from "../../../components/ui";
import { Section } from "../../../components/layout";
import { Play, Pause, Search, ArrowUpCircle, Clock, CheckCircle2, AlertCircle } from "lucide-react";
import type { HuntingStatus, InstanceHuntStatus } from "../lib/hunting-types";

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
						<InstanceStatusCard key={instance.instanceId} instance={instance} />
					))}
				</div>
			</Section>
		</div>
	);
};

interface InstanceStatusCardProps {
	instance: InstanceHuntStatus;
}

const InstanceStatusCard = ({ instance }: InstanceStatusCardProps) => {
	const isActive = instance.huntMissingEnabled || instance.huntUpgradesEnabled;

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
		</div>
	);
};

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
