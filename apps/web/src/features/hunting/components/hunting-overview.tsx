"use client";

import { useState } from "react";
import {
	Play,
	Search,
	ArrowUpCircle,
	Clock,
	CheckCircle2,
	AlertCircle,
	Gauge,
	Loader2,
	ChevronDown,
	Target,
	Download,
	Zap,
} from "lucide-react";
import { Button, toast } from "../../../components/ui";
import {
	StatCard,
	PremiumEmptyState,
	PremiumSection,
	InstanceCard,
	ServiceBadge,
	StatusBadge,
	PremiumProgress,
	GlassmorphicCard,
} from "../../../components/layout";
import { SERVICE_GRADIENTS, SEMANTIC_COLORS } from "../../../lib/theme-gradients";
import { useThemeGradient } from "../../../hooks/useThemeGradient";
import type { HuntingStatus, InstanceHuntStatus } from "../lib/hunting-types";
import { API_USAGE_WARNING_THRESHOLD, API_USAGE_DANGER_THRESHOLD } from "../lib/constants";
import { useManualHunt } from "../hooks/useManualHunt";

interface HuntingOverviewProps {
	status: HuntingStatus | null;
	onRefresh: () => void;
}

/**
 * Premium Hunting Overview
 *
 * Displays global hunting stats and per-instance status cards with:
 * - Premium stat cards with gradient styling
 * - Glassmorphic instance cards with service accent
 * - Theme-aware progress bars for API usage
 */
export const HuntingOverview = ({ status, onRefresh }: HuntingOverviewProps) => {
	const { gradient: themeGradient } = useThemeGradient();

	if (!status || status.instances.length === 0) {
		return (
			<PremiumEmptyState
				icon={Search}
				title="No instances configured for hunting"
				description="Configure hunting for your Sonarr and Radarr instances in the Configuration tab."
			/>
		);
	}

	const activeInstances = status.instances.filter(
		(i) => i.huntMissingEnabled || i.huntUpgradesEnabled
	);
	const totalSearchesToday = status.instances.reduce((sum, i) => sum + i.searchesToday, 0);
	const totalItemsFound = status.instances.reduce((sum, i) => sum + i.itemsFoundToday, 0);

	return (
		<div className="flex flex-col gap-10">
			{/* Global Stats Grid */}
			<div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
				<StatCard
					icon={Target}
					value={activeInstances.length}
					label="Active Instances"
					description={`of ${status.instances.length} configured`}
					animationDelay={0}
				/>
				<StatCard
					icon={Search}
					value={totalSearchesToday}
					label="Searches Today"
					description="Across all instances"
					animationDelay={50}
				/>
				<StatCard
					icon={Download}
					value={totalItemsFound}
					label="Items Found"
					description="Content grabbed today"
					animationDelay={100}
				/>
				<StatCard
					icon={Zap}
					value={status.schedulerRunning ? "Running" : "Stopped"}
					label="Scheduler Status"
					description={status.schedulerRunning ? "Auto-hunting active" : "Hunting paused"}
					gradient={status.schedulerRunning ? SEMANTIC_COLORS.success : undefined}
					animationDelay={150}
				/>
			</div>

			{/* Instance Status Cards */}
			<PremiumSection
				title="Instance Status"
				description="Current hunting status for each configured instance"
				icon={Target}
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

/* =============================================================================
   HUNT DROPDOWN
   Dropdown menu for manual hunt triggers
   ============================================================================= */

interface HuntDropdownProps {
	instance: InstanceHuntStatus;
	isTriggering: boolean;
	onTrigger: (type: "missing" | "upgrade") => void;
}

const HuntDropdown = ({ instance, isTriggering, onTrigger }: HuntDropdownProps) => {
	const { gradient: themeGradient } = useThemeGradient();
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
				className="gap-2 border-border/50 bg-card/50 backdrop-blur-xs hover:bg-card/80"
			>
				{isTriggering ? (
					<Loader2 className="h-4 w-4 animate-spin" />
				) : (
					<>
						<Play className="h-4 w-4" />
						Hunt
						<ChevronDown className="h-3 w-3" />
					</>
				)}
			</Button>

			{isOpen && (
				<>
					{/* Backdrop */}
					<div className="fixed inset-0 z-modal-backdrop" onClick={() => setIsOpen(false)} />

					{/* Dropdown menu */}
					<div className="absolute right-0 mt-2 min-w-[180px] rounded-xl border border-border/50 bg-card/95 backdrop-blur-xl shadow-2xl z-modal overflow-hidden">
						{instance.huntMissingEnabled && (
							<button
								type="button"
								className="w-full flex items-center gap-3 px-4 py-3 text-sm text-left text-muted-foreground hover:text-foreground hover:bg-muted/30 transition-colors"
								onClick={() => handleSelect("missing")}
							>
								<div
									className="flex h-8 w-8 items-center justify-center rounded-lg"
									style={{
										background: `linear-gradient(135deg, ${themeGradient.from}20, ${themeGradient.to}20)`,
										border: `1px solid ${themeGradient.from}30`,
									}}
								>
									<Search className="h-4 w-4" style={{ color: themeGradient.from }} />
								</div>
								<div>
									<div className="font-medium text-foreground">Hunt Missing</div>
									<div className="text-xs text-muted-foreground">Search for undownloaded content</div>
								</div>
							</button>
						)}
						{instance.huntUpgradesEnabled && (
							<button
								type="button"
								className="w-full flex items-center gap-3 px-4 py-3 text-sm text-left text-muted-foreground hover:text-foreground hover:bg-muted/30 transition-colors"
								onClick={() => handleSelect("upgrade")}
							>
								<div
									className="flex h-8 w-8 items-center justify-center rounded-lg"
									style={{
										background: `linear-gradient(135deg, ${themeGradient.from}20, ${themeGradient.to}20)`,
										border: `1px solid ${themeGradient.from}30`,
									}}
								>
									<ArrowUpCircle className="h-4 w-4" style={{ color: themeGradient.from }} />
								</div>
								<div>
									<div className="font-medium text-foreground">Hunt Upgrades</div>
									<div className="text-xs text-muted-foreground">Search for better quality</div>
								</div>
							</button>
						)}
					</div>
				</>
			)}
		</div>
	);
};

/* =============================================================================
   INSTANCE STATUS CARD
   Premium instance card with service gradient and hover effects
   ============================================================================= */

interface InstanceStatusCardProps {
	instance: InstanceHuntStatus;
	onRefresh: () => void;
	animationDelay?: number;
}

const InstanceStatusCard = ({ instance, onRefresh, animationDelay = 0 }: InstanceStatusCardProps) => {
	const { gradient: themeGradient } = useThemeGradient();

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
		<InstanceCard
			instanceName={instance.instanceName}
			service={instance.service}
			animationDelay={animationDelay}
			status={
				<div className="flex items-center gap-2 text-sm">
					{isActive ? (
						<StatusBadge status="success" icon={CheckCircle2}>
							Active
						</StatusBadge>
					) : (
						<StatusBadge status="default" icon={AlertCircle}>
							Disabled
						</StatusBadge>
					)}
				</div>
			}
			actions={
				isActive && (
					<HuntDropdown
						instance={instance}
						isTriggering={isCurrentlyTriggering}
						onTrigger={handleTriggerHunt}
					/>
				)
			}
			stats={
				<div className="grid grid-cols-2 gap-4 text-sm">
					{/* Missing Hunt Status */}
					<div className="space-y-2">
						<div className="flex items-center gap-2">
							<Search className="h-4 w-4 text-muted-foreground" />
							<span className="text-muted-foreground">Missing:</span>
							<StatusBadge status={instance.huntMissingEnabled ? "success" : "default"}>
								{instance.huntMissingEnabled ? "On" : "Off"}
							</StatusBadge>
						</div>
						{instance.huntMissingEnabled && instance.lastMissingHunt && (
							<div className="flex items-center gap-2 text-xs text-muted-foreground pl-6">
								<Clock className="h-3 w-3" />
								Last: {formatRelativeTime(instance.lastMissingHunt)}
							</div>
						)}
					</div>

					{/* Upgrade Hunt Status */}
					<div className="space-y-2">
						<div className="flex items-center gap-2">
							<ArrowUpCircle className="h-4 w-4 text-muted-foreground" />
							<span className="text-muted-foreground">Upgrades:</span>
							<StatusBadge status={instance.huntUpgradesEnabled ? "success" : "default"}>
								{instance.huntUpgradesEnabled ? "On" : "Off"}
							</StatusBadge>
						</div>
						{instance.huntUpgradesEnabled && instance.lastUpgradeHunt && (
							<div className="flex items-center gap-2 text-xs text-muted-foreground pl-6">
								<Clock className="h-3 w-3" />
								Last: {formatRelativeTime(instance.lastUpgradeHunt)}
							</div>
						)}
					</div>
				</div>
			}
		>
			{/* Today's Stats */}
			<div className="flex justify-between text-sm pt-3 border-t border-border/30">
				<div className="text-muted-foreground">
					<span className="font-semibold text-foreground">{instance.searchesToday}</span>{" "}
					searches today
				</div>
				<div className="text-muted-foreground">
					<span className="font-semibold text-foreground">{instance.itemsFoundToday}</span>{" "}
					items found
				</div>
			</div>

			{/* API Usage Indicator */}
			<ApiUsageIndicator
				current={instance.apiCallsThisHour}
				max={instance.hourlyApiCap}
			/>
		</InstanceCard>
	);
};

/* =============================================================================
   API USAGE INDICATOR
   Theme-aware progress bar for API usage
   ============================================================================= */

interface ApiUsageIndicatorProps {
	current: number;
	max: number;
}

const ApiUsageIndicator = ({ current, max }: ApiUsageIndicatorProps) => {
	const percentage = max > 0 ? Math.min((current / max) * 100, 100) : 0;

	// Determine variant based on usage thresholds
	const getVariant = (): "default" | "success" | "warning" | "danger" => {
		if (percentage >= API_USAGE_DANGER_THRESHOLD) return "danger";
		if (percentage >= API_USAGE_WARNING_THRESHOLD) return "warning";
		return "success";
	};

	const getStatusText = () => {
		if (percentage >= API_USAGE_DANGER_THRESHOLD) return "Near limit";
		if (percentage >= API_USAGE_WARNING_THRESHOLD) return "Moderate";
		return "Healthy";
	};

	const variant = getVariant();

	return (
		<div className="mt-4 pt-4 border-t border-border/30">
			<div className="flex items-center justify-between text-xs mb-2">
				<div className="flex items-center gap-1.5 text-muted-foreground">
					<Gauge className="h-3.5 w-3.5" />
					<span>API Usage (hourly)</span>
				</div>
				<div className="flex items-center gap-2">
					<span className="text-muted-foreground">
						<span className="font-medium text-foreground">{current}</span>/{max}
					</span>
					<StatusBadge status={variant === "danger" ? "error" : variant}>
						{getStatusText()}
					</StatusBadge>
				</div>
			</div>
			<PremiumProgress value={current} max={max} variant={variant} size="sm" />
		</div>
	);
};

/* =============================================================================
   UTILITY FUNCTIONS
   ============================================================================= */

/**
 * Format a date string into a compact, human-friendly relative time
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
