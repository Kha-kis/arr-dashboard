"use client";

import { useState } from "react";
import { toast } from "sonner";
import {
	Settings,
	Save,
	RotateCcw,
	Play,
	Pause,
	Power,
	Zap,
	Search,
	ArrowUpCircle,
	Gauge,
	Trash2,
	Package,
} from "lucide-react";
import { Button, Input, Switch, Alert, AlertDescription } from "../../../components/ui";
import {
	PremiumSection,
	PremiumEmptyState,
	PremiumCard,
	ServiceBadge,
	StatusBadge,
	GlassmorphicCard,
	GradientButton,
	PremiumSkeleton,
} from "../../../components/layout";
import { getServiceGradient, SEMANTIC_COLORS } from "../../../lib/theme-gradients";
import { useThemeGradient } from "../../../hooks/useThemeGradient";
import {
	useHuntingConfigs,
	useUpdateHuntConfig,
	useToggleScheduler,
	useClearSearchHistory,
} from "../hooks/useHuntingConfig";
import { useHuntingStatus } from "../hooks/useHuntingStatus";
import { useManualHunt } from "../hooks/useManualHunt";
import { HuntingFilters } from "./hunting-filters";
import type { HuntConfigWithInstance, HuntConfigUpdate } from "../lib/hunting-types";
import {
	MIN_MISSING_INTERVAL_MINS,
	MIN_UPGRADE_INTERVAL_MINS,
	MAX_INTERVAL_MINS,
	MIN_BATCH_SIZE,
	MAX_BATCH_SIZE,
	MIN_HOURLY_API_CAP,
	MAX_HOURLY_API_CAP,
	MAX_QUEUE_THRESHOLD,
	MAX_RESEARCH_AFTER_DAYS,
	DEFAULT_RESEARCH_AFTER_DAYS,
} from "../lib/constants";

/**
 * Premium Hunting Configuration
 *
 * Configuration panel with:
 * - Global automation controls
 * - Per-instance configuration cards
 * - Rate limiting settings
 * - Filter controls
 */
export const HuntingConfig = () => {
	const { gradient: themeGradient } = useThemeGradient();

	const { configs, instances, isLoading, error, refetch } = useHuntingConfigs();
	const { status, refetch: refetchStatus } = useHuntingStatus();
	const { toggleScheduler, isToggling } = useToggleScheduler();

	const handleToggleScheduler = async () => {
		try {
			const result = await toggleScheduler();
			await refetchStatus();
			if (result.running) {
				toast.success("Automation started", {
					description: "Hunting will run automatically based on each instance's schedule",
				});
			} else {
				toast.info("Automation stopped", {
					description: "Use 'Run Now' on each instance for manual hunts",
				});
			}
		} catch (err) {
			const message = err instanceof Error ? err.message : "An unexpected error occurred";
			toast.error("Failed to toggle automation", { description: message });
		}
	};

	const schedulerRunning = status?.schedulerRunning ?? false;

	// Loading state
	if (isLoading) {
		return (
			<PremiumSection
				title="Hunting Configuration"
				description="Configure automated hunting for each instance"
				icon={Settings}
			>
				<div className="space-y-4">
					{Array.from({ length: 3 }).map((_, i) => (
						<PremiumSkeleton
							key={i}
							variant="card"
							className="h-48"
							style={{ animationDelay: `${i * 50}ms` } as React.CSSProperties}
						/>
					))}
				</div>
			</PremiumSection>
		);
	}

	// Error state
	if (error) {
		return (
			<PremiumEmptyState
				icon={Settings}
				title="Failed to load configuration"
				description="Could not fetch hunting configuration. Please try again."
			/>
		);
	}

	const configuredInstances = configs.filter((c) => c !== null);
	const unconfiguredInstances = instances.filter(
		(inst) => !configs.some((c) => c?.instanceId === inst.id)
	);

	return (
		<div className="flex flex-col gap-8">
			{/* Global Automation Control */}
			<GlassmorphicCard
				padding="none"
				className={schedulerRunning ? "border-green-500/30" : ""}
			>
				{/* Status accent line */}
				<div
					className="h-1 rounded-t-2xl"
					style={{
						background: schedulerRunning
							? `linear-gradient(90deg, ${SEMANTIC_COLORS.success.from}, ${SEMANTIC_COLORS.success.to})`
							: `linear-gradient(90deg, ${themeGradient.from}30, ${themeGradient.to}30)`,
					}}
				/>

				<div className="p-6">
					<div className="flex items-center justify-between">
						<div className="flex items-center gap-4">
							<div
								className="flex h-12 w-12 items-center justify-center rounded-xl"
								style={{
									background: schedulerRunning
										? `linear-gradient(135deg, ${SEMANTIC_COLORS.success.from}20, ${SEMANTIC_COLORS.success.to}20)`
										: `linear-gradient(135deg, ${themeGradient.from}20, ${themeGradient.to}20)`,
									border: schedulerRunning
										? `1px solid ${SEMANTIC_COLORS.success.from}30`
										: `1px solid ${themeGradient.from}30`,
								}}
							>
								<Power
									className="h-6 w-6"
									style={{
										color: schedulerRunning
											? SEMANTIC_COLORS.success.from
											: themeGradient.from,
									}}
								/>
							</div>
							<div>
								<div className="flex items-center gap-2">
									<h3 className="font-semibold text-lg">Automation</h3>
									<StatusBadge status={schedulerRunning ? "success" : "default"}>
										{schedulerRunning ? "Running" : "Stopped"}
									</StatusBadge>
								</div>
								<p className="text-sm text-muted-foreground">
									{schedulerRunning
										? "Hunting runs automatically based on each instance's schedule"
										: "Automatic hunting is paused - use 'Run Now' for manual hunts"}
								</p>
							</div>
						</div>

						<Button
							variant={schedulerRunning ? "danger" : "primary"}
							onClick={() => void handleToggleScheduler()}
							disabled={isToggling}
							className="gap-2"
						>
							{isToggling ? (
								<RotateCcw className="h-4 w-4 animate-spin" />
							) : schedulerRunning ? (
								<Pause className="h-4 w-4" />
							) : (
								<Play className="h-4 w-4" />
							)}
							{schedulerRunning ? "Stop Automation" : "Start Automation"}
						</Button>
					</div>
				</div>
			</GlassmorphicCard>

			{/* Configured Instances */}
			{configuredInstances.length > 0 && (
				<PremiumSection
					title="Configured Instances"
					icon={Settings}
					animationDelay={100}
				>
					<div className="space-y-4">
						{configuredInstances.map(
							(config, index) =>
								config && (
									<InstanceConfigCard
										key={config.instanceId}
										config={config}
										onSaved={refetch}
										animationDelay={150 + index * 50}
									/>
								)
						)}
					</div>
				</PremiumSection>
			)}

			{/* Unconfigured Instances */}
			{unconfiguredInstances.length > 0 && (
				<PremiumSection
					title="Available Instances"
					description="Click to enable hunting on these instances"
					animationDelay={200}
				>
					<div className="grid gap-4 md:grid-cols-2">
						{unconfiguredInstances.map((instance, index) => (
							<UnconfiguredInstanceCard
								key={instance.id}
								instanceId={instance.id}
								instanceName={instance.label}
								service={instance.service}
								onConfigure={refetch}
								animationDelay={250 + index * 50}
							/>
						))}
					</div>
				</PremiumSection>
			)}

			{/* Empty State */}
			{configuredInstances.length === 0 && unconfiguredInstances.length === 0 && (
				<PremiumEmptyState
					icon={Settings}
					title="No instances available"
					description="Add Sonarr, Radarr, Lidarr, or Readarr instances in Settings first."
				/>
			)}
		</div>
	);
};

/* =============================================================================
   INSTANCE CONFIG CARD
   Premium configuration card for each instance
   ============================================================================= */

interface InstanceConfigCardProps {
	config: HuntConfigWithInstance;
	onSaved: () => void;
	animationDelay?: number;
}

const InstanceConfigCard = ({ config, onSaved, animationDelay = 0 }: InstanceConfigCardProps) => {
	const { gradient: themeGradient } = useThemeGradient();

	const [formState, setFormState] = useState<HuntConfigUpdate>({
		huntMissingEnabled: config.huntMissingEnabled,
		huntUpgradesEnabled: config.huntUpgradesEnabled,
		missingBatchSize: config.missingBatchSize,
		missingIntervalMins: config.missingIntervalMins,
		upgradeBatchSize: config.upgradeBatchSize,
		upgradeIntervalMins: config.upgradeIntervalMins,
		hourlyApiCap: config.hourlyApiCap,
		queueThreshold: config.queueThreshold,
		researchAfterDays: config.researchAfterDays,
		filterLogic: config.filterLogic,
		monitoredOnly: config.monitoredOnly,
		includeTags: config.includeTags,
		excludeTags: config.excludeTags,
		includeQualityProfiles: config.includeQualityProfiles,
		excludeQualityProfiles: config.excludeQualityProfiles,
		includeStatuses: config.includeStatuses,
		yearMin: config.yearMin,
		yearMax: config.yearMax,
		ageThresholdDays: config.ageThresholdDays,
		preferSeasonPacks: config.preferSeasonPacks,
	});

	const { updateConfig, isUpdating, error } = useUpdateHuntConfig();
	const { triggerHunt, isTriggering, isCooldownError } = useManualHunt();
	const { clearHistory, isClearing } = useClearSearchHistory();

	const handleSave = async () => {
		try {
			await updateConfig(config.instanceId, formState);
			toast.success("Settings saved");
			onSaved();
		} catch (err) {
			const message = err instanceof Error ? err.message : "An unexpected error occurred";
			toast.error("Failed to save settings", { description: message });
		}
	};

	const handleRunNow = async (type: "missing" | "upgrade") => {
		try {
			const result = await triggerHunt(config.instanceId, type);
			toast.success(result.message);
		} catch (err) {
			if (isCooldownError(err)) {
				toast.warning(err.message, {
					description: "Please wait before running another hunt",
				});
			} else {
				const message = err instanceof Error ? err.message : "An unexpected error occurred";
				toast.error(`Failed to trigger ${type} hunt`, { description: message });
			}
		}
	};

	const handleResetHistory = async () => {
		try {
			const result = await clearHistory(config.instanceId);
			toast.success("Search history cleared", {
				description: `${result.deleted} records removed. Next hunt will start from page 1.`,
			});
			onSaved();
		} catch (err) {
			const message = err instanceof Error ? err.message : "An unexpected error occurred";
			toast.error("Failed to clear search history", { description: message });
		}
	};

	const hasChanges =
		JSON.stringify(formState) !==
		JSON.stringify({
			huntMissingEnabled: config.huntMissingEnabled,
			huntUpgradesEnabled: config.huntUpgradesEnabled,
			missingBatchSize: config.missingBatchSize,
			missingIntervalMins: config.missingIntervalMins,
			upgradeBatchSize: config.upgradeBatchSize,
			upgradeIntervalMins: config.upgradeIntervalMins,
			hourlyApiCap: config.hourlyApiCap,
			queueThreshold: config.queueThreshold,
			filterLogic: config.filterLogic,
			monitoredOnly: config.monitoredOnly,
			includeTags: config.includeTags,
			excludeTags: config.excludeTags,
			includeQualityProfiles: config.includeQualityProfiles,
			excludeQualityProfiles: config.excludeQualityProfiles,
			includeStatuses: config.includeStatuses,
			yearMin: config.yearMin,
			yearMax: config.yearMax,
			ageThresholdDays: config.ageThresholdDays,
			preferSeasonPacks: config.preferSeasonPacks,
			researchAfterDays: config.researchAfterDays,
		});

	// Get service gradient
	const serviceGradient = getServiceGradient(config.service);

	return (
		<PremiumCard
			title={config.instanceName}
			description="Configure hunting settings for this instance"
			animationDelay={animationDelay}
			showHeader={false}
		>
			{/* Header */}
			<div className="flex items-center justify-between mb-6 pb-4 border-b border-border/30">
				<div className="flex items-center gap-3">
					<div
						className="flex h-10 w-10 items-center justify-center rounded-xl"
						style={{
							background: `linear-gradient(135deg, ${serviceGradient.from}, ${serviceGradient.to})`,
							boxShadow: `0 4px 12px -4px ${serviceGradient.glow}`,
						}}
					>
						<Settings className="h-5 w-5 text-white" />
					</div>
					<div>
						<div className="flex items-center gap-2">
							<h3 className="font-semibold">{config.instanceName}</h3>
							<ServiceBadge service={config.service} />
						</div>
						<p className="text-sm text-muted-foreground">
							Configure hunting settings for this instance
						</p>
					</div>
				</div>
			</div>

			{/* Error Alert */}
			{error && (
				<Alert variant="danger" className="mb-6">
					<AlertDescription>{error.message}</AlertDescription>
				</Alert>
			)}

			<div className="space-y-6">
				{/* Missing Content Settings */}
				<ConfigSection
					icon={Search}
					title="Hunt Missing Content"
					description="Search for undownloaded episodes/movies"
					enabled={formState.huntMissingEnabled ?? false}
					onToggle={(checked) =>
						setFormState((prev) => ({ ...prev, huntMissingEnabled: checked }))
					}
				>
					<div className="grid grid-cols-2 gap-4">
						<ConfigInput
							label="Items Per Hunt"
							description="Max items to search each run"
							type="number"
							min={MIN_BATCH_SIZE}
							max={MAX_BATCH_SIZE}
							value={formState.missingBatchSize ?? 5}
							onChange={(value) =>
								setFormState((prev) => ({ ...prev, missingBatchSize: value }))
							}
						/>
						<ConfigInput
							label={`Hunt Every (min ${MIN_MISSING_INTERVAL_MINS})`}
							description="Minutes between hunts"
							type="number"
							min={MIN_MISSING_INTERVAL_MINS}
							max={MAX_INTERVAL_MINS}
							value={formState.missingIntervalMins ?? 60}
							onChange={(value) =>
								setFormState((prev) => ({ ...prev, missingIntervalMins: value }))
							}
							suffix="minutes"
						/>
					</div>
				</ConfigSection>

				{/* Upgrade Settings */}
				<ConfigSection
					icon={ArrowUpCircle}
					title="Hunt Quality Upgrades"
					description="Search for better quality versions"
					enabled={formState.huntUpgradesEnabled ?? false}
					onToggle={(checked) =>
						setFormState((prev) => ({ ...prev, huntUpgradesEnabled: checked }))
					}
				>
					<div className="grid grid-cols-2 gap-4">
						<ConfigInput
							label="Items Per Hunt"
							description="Max items to search each run"
							type="number"
							min={MIN_BATCH_SIZE}
							max={MAX_BATCH_SIZE}
							value={formState.upgradeBatchSize ?? 3}
							onChange={(value) =>
								setFormState((prev) => ({ ...prev, upgradeBatchSize: value }))
							}
						/>
						<ConfigInput
							label={`Hunt Every (min ${MIN_UPGRADE_INTERVAL_MINS})`}
							description="Minutes between hunts"
							type="number"
							min={MIN_UPGRADE_INTERVAL_MINS}
							max={MAX_INTERVAL_MINS}
							value={formState.upgradeIntervalMins ?? 120}
							onChange={(value) =>
								setFormState((prev) => ({ ...prev, upgradeIntervalMins: value }))
							}
							suffix="minutes"
						/>
					</div>
				</ConfigSection>

				{/* Season Pack Preference - Sonarr Only */}
				{config.service === "sonarr" && (
					<div className="rounded-lg border border-border/50 bg-card/30 p-4">
						<div className="flex items-center justify-between">
							<div className="flex items-center gap-3">
								<Package className="h-5 w-5 text-muted-foreground" />
								<div>
									<p className="font-medium">Prefer Season Packs</p>
									<p className="text-sm text-muted-foreground">
										Always search for full seasons to catch season pack releases, even when only 1-2
										episodes are missing
									</p>
								</div>
							</div>
							<Switch
								checked={formState.preferSeasonPacks ?? false}
								onCheckedChange={(checked) =>
									setFormState((prev) => ({ ...prev, preferSeasonPacks: checked }))
								}
							/>
						</div>
					</div>
				)}

				{/* Rate Limiting */}
				<div className="pt-4 border-t border-border/30">
					<div className="flex items-center gap-2 mb-4">
						<Gauge className="h-5 w-5" style={{ color: themeGradient.from }} />
						<h4 className="font-semibold">Rate Limiting</h4>
					</div>
					<div className="grid grid-cols-2 gap-4">
						<ConfigInput
							label="Hourly API Cap"
							description="Max API calls per hour"
							type="number"
							min={MIN_HOURLY_API_CAP}
							max={MAX_HOURLY_API_CAP}
							value={formState.hourlyApiCap ?? 100}
							onChange={(value) =>
								setFormState((prev) => ({ ...prev, hourlyApiCap: value }))
							}
						/>
						<ConfigInput
							label="Queue Threshold"
							description="Pause hunting when queue exceeds"
							type="number"
							min={0}
							max={MAX_QUEUE_THRESHOLD}
							value={formState.queueThreshold ?? 25}
							onChange={(value) =>
								setFormState((prev) => ({ ...prev, queueThreshold: value }))
							}
						/>
					</div>
					<div className="grid grid-cols-2 gap-4 mt-4">
						<ConfigInput
							label="Re-search After (days)"
							description="Skip items searched within this period (0 = never)"
							type="number"
							min={0}
							max={MAX_RESEARCH_AFTER_DAYS}
							value={formState.researchAfterDays ?? DEFAULT_RESEARCH_AFTER_DAYS}
							onChange={(value) =>
								setFormState((prev) => ({ ...prev, researchAfterDays: value }))
							}
						/>
					</div>
				</div>

				{/* Filters */}
				<HuntingFilters
					config={config}
					formState={formState}
					onChange={(updates) => setFormState((prev) => ({ ...prev, ...updates }))}
				/>

				{/* Actions */}
				<div className="flex justify-between items-center gap-2 pt-4 border-t border-border/30">
					<div className="flex gap-2 flex-wrap">
						{formState.huntMissingEnabled && (
							<Button
								variant="secondary"
								size="sm"
								onClick={() => void handleRunNow("missing")}
								disabled={isTriggering}
								className="gap-2 border-border/50 bg-card/50 backdrop-blur-xs"
							>
								{isTriggering ? (
									<RotateCcw className="h-4 w-4 animate-spin" />
								) : (
									<Zap className="h-4 w-4" />
								)}
								Run Missing Hunt
							</Button>
						)}
						{formState.huntUpgradesEnabled && (
							<Button
								variant="secondary"
								size="sm"
								onClick={() => void handleRunNow("upgrade")}
								disabled={isTriggering}
								className="gap-2 border-border/50 bg-card/50 backdrop-blur-xs"
							>
								{isTriggering ? (
									<RotateCcw className="h-4 w-4 animate-spin" />
								) : (
									<Zap className="h-4 w-4" />
								)}
								Run Upgrade Hunt
							</Button>
						)}
						<Button
							variant="ghost"
							size="sm"
							onClick={() => void handleResetHistory()}
							disabled={isClearing}
							className="gap-2 text-muted-foreground hover:text-foreground"
							title="Reset search history to start from page 1"
						>
							{isClearing ? (
								<RotateCcw className="h-4 w-4 animate-spin" />
							) : (
								<Trash2 className="h-4 w-4" />
							)}
							Reset History
						</Button>
					</div>
					<GradientButton
						onClick={() => void handleSave()}
						disabled={isUpdating || !hasChanges}
						icon={isUpdating ? RotateCcw : Save}
					>
						{isUpdating ? "Saving..." : "Save Changes"}
					</GradientButton>
				</div>
			</div>
		</PremiumCard>
	);
};

/* =============================================================================
   CONFIG SECTION
   Collapsible config section with toggle
   ============================================================================= */

interface ConfigSectionProps {
	icon: React.ElementType;
	title: string;
	description: string;
	enabled: boolean;
	onToggle: (enabled: boolean) => void;
	children: React.ReactNode;
}

const ConfigSection = ({
	icon: Icon,
	title,
	description,
	enabled,
	onToggle,
	children,
}: ConfigSectionProps) => {
	const { gradient: themeGradient } = useThemeGradient();

	return (
		<div className="space-y-4">
			<div className="flex items-center justify-between">
				<div className="flex items-center gap-3">
					<div
						className="flex h-8 w-8 items-center justify-center rounded-lg"
						style={{
							background: enabled
								? `linear-gradient(135deg, ${themeGradient.from}20, ${themeGradient.to}20)`
								: "rgba(100, 116, 139, 0.1)",
							border: enabled
								? `1px solid ${themeGradient.from}30`
								: "1px solid rgba(100, 116, 139, 0.2)",
						}}
					>
						<Icon
							className="h-4 w-4"
							style={{ color: enabled ? themeGradient.from : "rgb(148, 163, 184)" }}
						/>
					</div>
					<div>
						<h4 className="font-medium">{title}</h4>
						<p className="text-sm text-muted-foreground">{description}</p>
					</div>
				</div>
				<Switch checked={enabled} onCheckedChange={onToggle} />
			</div>

			{enabled && (
				<div
					className="pl-4 border-l-2 transition-colors"
					style={{ borderColor: `${themeGradient.from}50` }}
				>
					{children}
				</div>
			)}
		</div>
	);
};

/* =============================================================================
   CONFIG INPUT
   Styled input for config values
   ============================================================================= */

interface ConfigInputProps {
	label: string;
	description?: string;
	type?: "text" | "number";
	min?: number;
	max?: number;
	value: number | string;
	onChange: (value: number) => void;
	suffix?: string;
}

const ConfigInput = ({
	label,
	description,
	type = "number",
	min,
	max,
	value,
	onChange,
	suffix,
}: ConfigInputProps) => {
	return (
		<div className="space-y-1">
			<label className="text-xs font-medium text-muted-foreground">{label}</label>
			<div className="flex items-center gap-2">
				<Input
					type={type}
					min={min}
					max={max}
					value={value}
					onChange={(e) => onChange(Number.parseInt(e.target.value) || 0)}
					className="bg-background/50 border-border/50"
				/>
				{suffix && (
					<span className="text-sm text-muted-foreground whitespace-nowrap">{suffix}</span>
				)}
			</div>
			{description && <p className="text-xs text-muted-foreground">{description}</p>}
		</div>
	);
};

/* =============================================================================
   UNCONFIGURED INSTANCE CARD
   Card for instances that haven't been configured yet
   ============================================================================= */

interface UnconfiguredInstanceCardProps {
	instanceId: string;
	instanceName: string;
	service: string;
	onConfigure: () => void;
	animationDelay?: number;
}

const UnconfiguredInstanceCard = ({
	instanceId,
	instanceName,
	service,
	onConfigure,
	animationDelay = 0,
}: UnconfiguredInstanceCardProps) => {
	const { gradient: themeGradient } = useThemeGradient();
	const { createConfig, isCreating } = useUpdateHuntConfig();

	const handleConfigure = async () => {
		try {
			await createConfig(instanceId);
			onConfigure();
		} catch (err) {
			const message = err instanceof Error ? err.message : "An unexpected error occurred";
			toast.error("Failed to enable hunting", { description: message });
		}
	};

	return (
		<div
			className="group rounded-2xl border-2 border-dashed border-border/50 bg-card/20 p-6
				flex items-center justify-between hover:border-border hover:bg-card/30 transition-all
				animate-in fade-in slide-in-from-bottom-4 duration-500"
			style={{
				animationDelay: `${animationDelay}ms`,
				animationFillMode: "backwards",
			}}
		>
			<div className="flex items-center gap-3">
				<div
					className="flex h-10 w-10 items-center justify-center rounded-xl"
					style={{
						background: `linear-gradient(135deg, ${themeGradient.from}20, ${themeGradient.to}20)`,
						border: `1px solid ${themeGradient.from}30`,
					}}
				>
					<Settings className="h-5 w-5" style={{ color: themeGradient.from }} />
				</div>
				<div>
					<div className="flex items-center gap-2">
						<span className="font-semibold">{instanceName}</span>
						<ServiceBadge service={service} />
					</div>
					<p className="text-sm text-muted-foreground">Click to enable hunting</p>
				</div>
			</div>
			<Button
				variant="secondary"
				size="sm"
				onClick={() => void handleConfigure()}
				disabled={isCreating}
				className="gap-2 border-border/50 bg-card/50 backdrop-blur-xs"
			>
				{isCreating ? (
					<RotateCcw className="h-4 w-4 animate-spin" />
				) : (
					<Settings className="h-4 w-4" />
				)}
				Configure
			</Button>
		</div>
	);
};
