"use client";

import { useState, useCallback } from "react";
import {
	Settings,
	Power,
	ShieldAlert,
	Pause,
	XCircle,
	Snail,
	AlertTriangle,
	Trash2,
	Plus,
	Save,
	RotateCcw,
	Loader2,
	Target,
	Timer,
	ShieldCheck,
	X,
	Clock,
	TrendingUp,
	Sparkles,
} from "lucide-react";
import { Button, toast } from "../../../components/ui";
import {
	PremiumSection,
	PremiumEmptyState,
	ServiceBadge,
	GlassmorphicCard,
} from "../../../components/layout";
import { getServiceGradient, SEMANTIC_COLORS } from "../../../lib/theme-gradients";
import { useThemeGradient } from "../../../hooks/useThemeGradient";
import {
	useQueueCleanerConfigs,
	useUpdateQueueCleanerConfig,
	useToggleCleanerScheduler,
} from "../hooks/useQueueCleanerConfig";
import type {
	QueueCleanerConfigWithInstance,
	QueueCleanerConfigUpdate,
	InstanceSummary,
	WhitelistPattern,
} from "../lib/queue-cleaner-types";
import {
	MIN_INTERVAL_MINS,
	MAX_INTERVAL_MINS,
	MIN_STALLED_THRESHOLD_MINS,
	MAX_STALLED_THRESHOLD_MINS,
	MIN_SLOW_SPEED_THRESHOLD,
	MAX_SLOW_SPEED_THRESHOLD,
	MIN_SLOW_GRACE_PERIOD_MINS,
	MAX_SLOW_GRACE_PERIOD_MINS,
	MIN_MAX_REMOVALS,
	MAX_MAX_REMOVALS,
	MIN_QUEUE_AGE_MINS,
	MAX_QUEUE_AGE_MINS,
	MIN_MAX_STRIKES,
	MAX_MAX_STRIKES,
	MIN_STRIKE_DECAY_HOURS,
	MAX_STRIKE_DECAY_HOURS,
	MIN_SEEDING_TIMEOUT_HOURS,
	MAX_SEEDING_TIMEOUT_HOURS,
	MIN_ESTIMATED_MULTIPLIER,
	MAX_ESTIMATED_MULTIPLIER,
	MIN_IMPORT_PENDING_MINS,
	MAX_IMPORT_PENDING_MINS,
	MIN_AUTO_IMPORT_ATTEMPTS,
	MAX_AUTO_IMPORT_ATTEMPTS,
	MIN_AUTO_IMPORT_COOLDOWN_MINS,
	MAX_AUTO_IMPORT_COOLDOWN_MINS,
	WHITELIST_TYPES,
} from "../lib/constants";

export const QueueCleanerConfig = () => {
	const { gradient: themeGradient } = useThemeGradient();
	const { configs, instances } = useQueueCleanerConfigs();
	const { toggleScheduler, isToggling } = useToggleCleanerScheduler();
	const { createConfig, isCreating } = useUpdateQueueCleanerConfig();

	const handleToggleScheduler = async () => {
		try {
			const result = await toggleScheduler();
			toast.success(
				result.running ? "Scheduler started" : "Scheduler stopped",
			);
		} catch {
			toast.error("Failed to toggle scheduler");
		}
	};

	const handleCreateConfig = async (instanceId: string) => {
		try {
			await createConfig(instanceId);
			toast.success("Queue cleaner config created");
		} catch (error) {
			toast.error(
				error instanceof Error ? error.message : "Failed to create config",
			);
		}
	};

	// Instances without config
	const unconfiguredInstances = instances.filter(
		(inst) => !configs.some((c) => c?.instanceId === inst.id),
	);

	return (
		<div className="flex flex-col gap-6">
			{/* Scheduler toggle */}
			<GlassmorphicCard>
				<div className="p-5 flex items-center justify-between">
					<div className="flex items-center gap-3">
						<div
							className="flex h-9 w-9 items-center justify-center rounded-lg"
							style={{
								background: `linear-gradient(135deg, ${themeGradient.from}20, ${themeGradient.to}10)`,
								border: `1px solid ${themeGradient.from}30`,
							}}
						>
							<Power className="h-4 w-4" style={{ color: themeGradient.from }} />
						</div>
						<div>
							<h3 className="font-medium text-foreground">Queue Cleaner Scheduler</h3>
							<p className="text-xs text-muted-foreground">
								Automatically runs the queue cleaner at configured intervals
							</p>
						</div>
					</div>
					<Button
						variant="secondary"
						size="sm"
						className="gap-2"
						onClick={() => void handleToggleScheduler()}
						disabled={isToggling}
					>
						{isToggling ? (
							<Loader2 className="h-4 w-4 animate-spin" />
						) : (
							<Power className="h-4 w-4" />
						)}
						Toggle
					</Button>
				</div>
			</GlassmorphicCard>

			{/* Add config for unconfigured instances */}
			{unconfiguredInstances.length > 0 && (
				<PremiumSection
					title="Add Instances"
					description="Set up queue cleaning for these instances"
					icon={Plus}
					animationDelay={0}
				>
					<div className="grid gap-3 md:grid-cols-2">
						{unconfiguredInstances.map((inst) => (
							<UnconfiguredInstanceCard
								key={inst.id}
								instance={inst}
								onAdd={() => void handleCreateConfig(inst.id)}
								isCreating={isCreating}
							/>
						))}
					</div>
				</PremiumSection>
			)}

			{/* Configured instance cards */}
			<PremiumSection
				title="Instance Configurations"
				description="Manage queue cleaner rules for each instance"
				icon={Settings}
				animationDelay={100}
			>
				{configs.filter(Boolean).length === 0 && (
					<PremiumEmptyState
						icon={Settings}
						title="No instances configured"
						description="Add instances above to start configuring the queue cleaner."
					/>
				)}

				<div className="space-y-4">
					{configs
						.filter((c): c is QueueCleanerConfigWithInstance => c !== null)
						.map((config, index) => (
							<InstanceConfigCard
								// Include updatedAt in key to force remount when config changes
								// This ensures form state syncs with latest server data
								key={`${config.instanceId}-${config.updatedAt}`}
								config={config}
								animationDelay={150 + index * 50}
							/>
						))}
				</div>
			</PremiumSection>
		</div>
	);
};

// === Unconfigured Instance Card ===

const UnconfiguredInstanceCard = ({
	instance,
	onAdd,
	isCreating,
}: {
	instance: InstanceSummary;
	onAdd: () => void;
	isCreating: boolean;
}) => {
	const serviceGradient = getServiceGradient(instance.service);

	return (
		<GlassmorphicCard>
			<div className="p-4 flex items-center justify-between">
				<div className="flex items-center gap-3">
					<div
						className="flex h-8 w-8 items-center justify-center rounded-lg"
						style={{
							background: `linear-gradient(135deg, ${serviceGradient.from}20, ${serviceGradient.to}10)`,
							border: `1px solid ${serviceGradient.from}30`,
						}}
					>
						<Trash2 className="h-4 w-4" style={{ color: serviceGradient.from }} />
					</div>
					<div>
						<span className="text-sm font-medium text-foreground">{instance.label}</span>
						<div className="mt-0.5">
							<ServiceBadge service={instance.service} />
						</div>
					</div>
				</div>
				<Button
					variant="secondary"
					size="sm"
					className="gap-1.5"
					onClick={onAdd}
					disabled={isCreating}
				>
					{isCreating ? (
						<Loader2 className="h-3.5 w-3.5 animate-spin" />
					) : (
						<Plus className="h-3.5 w-3.5" />
					)}
					Configure
				</Button>
			</div>
		</GlassmorphicCard>
	);
};

// === Instance Config Card ===

const InstanceConfigCard = ({
	config,
	animationDelay,
}: {
	config: QueueCleanerConfigWithInstance;
	animationDelay: number;
}) => {
	const { gradient: themeGradient } = useThemeGradient();
	const serviceGradient = getServiceGradient(config.service);
	const { updateConfig, isUpdating } = useUpdateQueueCleanerConfig();

	// Local form state
	const [formData, setFormData] = useState<QueueCleanerConfigUpdate>({
		enabled: config.enabled,
		intervalMins: config.intervalMins,
		stalledEnabled: config.stalledEnabled,
		stalledThresholdMins: config.stalledThresholdMins,
		failedEnabled: config.failedEnabled,
		slowEnabled: config.slowEnabled,
		slowSpeedThreshold: config.slowSpeedThreshold,
		slowGracePeriodMins: config.slowGracePeriodMins,
		errorPatternsEnabled: config.errorPatternsEnabled,
		errorPatterns: config.errorPatterns,
		// Strike system
		strikeSystemEnabled: config.strikeSystemEnabled,
		maxStrikes: config.maxStrikes,
		strikeDecayHours: config.strikeDecayHours,
		// Seeding timeout
		seedingTimeoutEnabled: config.seedingTimeoutEnabled,
		seedingTimeoutHours: config.seedingTimeoutHours,
		// Estimated completion
		estimatedCompletionEnabled: config.estimatedCompletionEnabled,
		estimatedCompletionMultiplier: config.estimatedCompletionMultiplier,
		// Import pending/blocked cleanup
		importPendingEnabled: config.importPendingEnabled,
		importPendingThresholdMins: config.importPendingThresholdMins,
		// Import block cleanup level
		importBlockCleanupLevel: config.importBlockCleanupLevel ?? "safe",
		// Import block pattern mode and custom patterns
		importBlockPatternMode: config.importBlockPatternMode ?? "defaults",
		importBlockPatterns: config.importBlockPatterns,
		// Auto-import settings
		autoImportEnabled: config.autoImportEnabled,
		autoImportMaxAttempts: config.autoImportMaxAttempts,
		autoImportCooldownMins: config.autoImportCooldownMins,
		autoImportSafeOnly: config.autoImportSafeOnly,
		// Whitelist
		whitelistEnabled: config.whitelistEnabled,
		whitelistPatterns: config.whitelistPatterns,
		// Removal options
		removeFromClient: config.removeFromClient,
		addToBlocklist: config.addToBlocklist,
		searchAfterRemoval: config.searchAfterRemoval,
		// Change category (torrent-only)
		changeCategoryEnabled: config.changeCategoryEnabled,
		// Safety settings
		dryRunMode: config.dryRunMode,
		maxRemovalsPerRun: config.maxRemovalsPerRun,
		minQueueAgeMins: config.minQueueAgeMins,
	});

	const [isDirty, setIsDirty] = useState(false);

	const updateField = useCallback(
		<K extends keyof QueueCleanerConfigUpdate>(
			field: K,
			value: QueueCleanerConfigUpdate[K],
		) => {
			setFormData((prev) => ({ ...prev, [field]: value }));
			setIsDirty(true);
		},
		[],
	);

	const handleSave = async () => {
		try {
			await updateConfig(config.instanceId, formData);
			setIsDirty(false);
			toast.success(`Config updated for ${config.instanceName}`);
		} catch (error) {
			toast.error(
				error instanceof Error ? error.message : "Failed to update config",
			);
		}
	};

	const handleReset = () => {
		setFormData({
			enabled: config.enabled,
			intervalMins: config.intervalMins,
			stalledEnabled: config.stalledEnabled,
			stalledThresholdMins: config.stalledThresholdMins,
			failedEnabled: config.failedEnabled,
			slowEnabled: config.slowEnabled,
			slowSpeedThreshold: config.slowSpeedThreshold,
			slowGracePeriodMins: config.slowGracePeriodMins,
			errorPatternsEnabled: config.errorPatternsEnabled,
			errorPatterns: config.errorPatterns,
			// Strike system
			strikeSystemEnabled: config.strikeSystemEnabled,
			maxStrikes: config.maxStrikes,
			strikeDecayHours: config.strikeDecayHours,
			// Seeding timeout
			seedingTimeoutEnabled: config.seedingTimeoutEnabled,
			seedingTimeoutHours: config.seedingTimeoutHours,
			// Estimated completion
			estimatedCompletionEnabled: config.estimatedCompletionEnabled,
			estimatedCompletionMultiplier: config.estimatedCompletionMultiplier,
			// Import pending/blocked cleanup
			importPendingEnabled: config.importPendingEnabled,
			importPendingThresholdMins: config.importPendingThresholdMins,
			// Import block cleanup level
			importBlockCleanupLevel: config.importBlockCleanupLevel ?? "safe",
			// Import block pattern mode and custom patterns
			importBlockPatternMode: config.importBlockPatternMode ?? "defaults",
			importBlockPatterns: config.importBlockPatterns,
			// Auto-import settings
			autoImportEnabled: config.autoImportEnabled,
			autoImportMaxAttempts: config.autoImportMaxAttempts,
			autoImportCooldownMins: config.autoImportCooldownMins,
			autoImportSafeOnly: config.autoImportSafeOnly,
			// Whitelist
			whitelistEnabled: config.whitelistEnabled,
			whitelistPatterns: config.whitelistPatterns,
			// Removal options
			removeFromClient: config.removeFromClient,
			addToBlocklist: config.addToBlocklist,
			searchAfterRemoval: config.searchAfterRemoval,
			// Change category (torrent-only)
			changeCategoryEnabled: config.changeCategoryEnabled,
			// Safety settings
			dryRunMode: config.dryRunMode,
			maxRemovalsPerRun: config.maxRemovalsPerRun,
			minQueueAgeMins: config.minQueueAgeMins,
		});
		setIsDirty(false);
	};

	return (
		<div
			className="animate-in fade-in slide-in-from-bottom-2 duration-300"
			style={{ animationDelay: `${animationDelay}ms`, animationFillMode: "backwards" }}
		>
			<GlassmorphicCard>
				{/* Accent line */}
				<div
					className="absolute top-0 left-0 right-0 h-0.5 rounded-t-xl"
					style={{
						background: `linear-gradient(90deg, ${serviceGradient.from}, ${serviceGradient.to})`,
					}}
				/>

				<div className="p-5 space-y-6">
					{/* Header */}
					<div className="flex items-start justify-between">
						<div className="flex items-center gap-3">
							<div
								className="flex h-9 w-9 items-center justify-center rounded-lg"
								style={{
									background: `linear-gradient(135deg, ${serviceGradient.from}20, ${serviceGradient.to}10)`,
									border: `1px solid ${serviceGradient.from}30`,
								}}
							>
								<Trash2 className="h-4 w-4" style={{ color: serviceGradient.from }} />
							</div>
							<div>
								<h4 className="font-medium text-foreground">{config.instanceName}</h4>
								<ServiceBadge service={config.service} />
							</div>
						</div>
						<ToggleSwitch
							checked={formData.enabled ?? false}
							onChange={(v) => updateField("enabled", v)}
							label="Enabled"
						/>
					</div>

					{/* Dry Run Mode — prominently displayed */}
					<div
						className="flex items-center justify-between rounded-lg p-3"
						style={{
							backgroundColor: formData.dryRunMode ? SEMANTIC_COLORS.warning.bg : SEMANTIC_COLORS.error.bg,
							border: `1px solid ${formData.dryRunMode ? SEMANTIC_COLORS.warning.border : SEMANTIC_COLORS.error.border}`,
						}}
					>
						<div className="flex items-center gap-2">
							<ShieldAlert
								className="h-4 w-4"
								style={{ color: formData.dryRunMode ? SEMANTIC_COLORS.warning.text : SEMANTIC_COLORS.error.text }}
							/>
							<div>
								<span className="text-sm font-medium text-foreground">
									{formData.dryRunMode ? "Dry Run Mode (Safe)" : "Live Mode (Removing!)"}
								</span>
								<p className="text-xs text-muted-foreground">
									{formData.dryRunMode
										? "Preview what would be removed without actually removing"
										: "Items matching rules will be removed from the queue"}
								</p>
							</div>
						</div>
						<ToggleSwitch
							checked={formData.dryRunMode ?? true}
							onChange={(v) => updateField("dryRunMode", v)}
						/>
					</div>

					{/* Check frequency */}
					<ConfigInput
						label="Check Interval"
						description="How often to check the queue"
						value={formData.intervalMins ?? 30}
						onChange={(v) => updateField("intervalMins", v)}
						min={MIN_INTERVAL_MINS}
						max={MAX_INTERVAL_MINS}
						suffix="minutes"
					/>

					{/* Rule: Whitelist */}
					<RuleSection
						icon={ShieldCheck}
						title="Whitelist / Ignore Patterns"
						description="Exclude items matching these patterns from removal"
						enabled={formData.whitelistEnabled ?? false}
						onToggle={(v) => updateField("whitelistEnabled", v)}
					>
						<WhitelistEditor
							patterns={formData.whitelistPatterns}
							onChange={(v) => updateField("whitelistPatterns", v)}
						/>
					</RuleSection>

					{/* Rule: Stalled */}
					<RuleSection
						icon={Pause}
						title="Stalled Downloads"
						description="Remove downloads with no progress"
						enabled={formData.stalledEnabled ?? true}
						onToggle={(v) => updateField("stalledEnabled", v)}
					>
						<ConfigInput
							label="Stalled Threshold"
							description="Consider stalled after this many minutes"
							value={formData.stalledThresholdMins ?? 60}
							onChange={(v) => updateField("stalledThresholdMins", v)}
							min={MIN_STALLED_THRESHOLD_MINS}
							max={MAX_STALLED_THRESHOLD_MINS}
							suffix="minutes"
						/>
					</RuleSection>

					{/* Rule: Failed */}
					<RuleSection
						icon={XCircle}
						title="Failed Downloads"
						description="Remove downloads that have failed or errored"
						enabled={formData.failedEnabled ?? true}
						onToggle={(v) => updateField("failedEnabled", v)}
					/>

					{/* Rule: Strike System */}
					<RuleSection
						icon={Target}
						title="Strike System"
						description="Track warnings before removal (gradual approach)"
						enabled={formData.strikeSystemEnabled ?? false}
						onToggle={(v) => updateField("strikeSystemEnabled", v)}
					>
						<ConfigInput
							label="Max Strikes"
							description="Remove after this many consecutive strikes"
							value={formData.maxStrikes ?? 3}
							onChange={(v) => updateField("maxStrikes", v)}
							min={MIN_MAX_STRIKES}
							max={MAX_MAX_STRIKES}
							suffix="strikes"
						/>
						<ConfigInput
							label="Strike Decay"
							description="Strikes reset after this period of inactivity"
							value={formData.strikeDecayHours ?? 24}
							onChange={(v) => updateField("strikeDecayHours", v)}
							min={MIN_STRIKE_DECAY_HOURS}
							max={MAX_STRIKE_DECAY_HOURS}
							suffix="hours"
						/>
						<div className="text-xs text-muted-foreground p-2 rounded-md bg-card/30 border border-border/30">
							Items receive strikes instead of immediate removal. After reaching max strikes, they are removed. Strikes decay after the specified period of no new issues.
						</div>
					</RuleSection>

					{/* Rule: Slow */}
					<RuleSection
						icon={Snail}
						title="Slow Downloads"
						description="Remove downloads below a speed threshold"
						enabled={formData.slowEnabled ?? false}
						onToggle={(v) => updateField("slowEnabled", v)}
					>
						<ConfigInput
							label="Speed Threshold"
							description="Remove if average speed is below this"
							value={formData.slowSpeedThreshold ?? 100}
							onChange={(v) => updateField("slowSpeedThreshold", v)}
							min={MIN_SLOW_SPEED_THRESHOLD}
							max={MAX_SLOW_SPEED_THRESHOLD}
							suffix="KB/s"
						/>
						<ConfigInput
							label="Grace Period"
							description="Wait this long before checking speed"
							value={formData.slowGracePeriodMins ?? 30}
							onChange={(v) => updateField("slowGracePeriodMins", v)}
							min={MIN_SLOW_GRACE_PERIOD_MINS}
							max={MAX_SLOW_GRACE_PERIOD_MINS}
							suffix="minutes"
						/>
					</RuleSection>

					{/* Rule: Error Patterns */}
					<RuleSection
						icon={AlertTriangle}
						title="Error Patterns"
						description="Remove downloads matching custom error patterns"
						enabled={formData.errorPatternsEnabled ?? false}
						onToggle={(v) => updateField("errorPatternsEnabled", v)}
					>
						<div>
							<label htmlFor="error-patterns-textarea" className="text-xs font-medium text-foreground block mb-1.5">
								Patterns (one per line)
							</label>
							<textarea
								id="error-patterns-textarea"
								className="w-full rounded-lg border border-border/50 bg-card/50 px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 min-h-[80px] resize-y"
								style={{ focusRingColor: themeGradient.from } as React.CSSProperties}
								placeholder="disk space&#10;permission denied&#10;custom pattern"
								value={(() => {
									try {
										return formData.errorPatterns
											? JSON.parse(formData.errorPatterns).join("\n")
											: "";
									} catch {
										return formData.errorPatterns ?? "";
									}
								})()}
								onChange={(e) => {
									const lines = e.target.value
										.split("\n")
										.filter((l) => l.trim());
									updateField(
										"errorPatterns",
										lines.length > 0 ? JSON.stringify(lines) : null,
									);
								}}
							/>
							<p className="text-[10px] text-muted-foreground mt-1">
								Case-insensitive substring matching against error messages
							</p>
						</div>
					</RuleSection>

					{/* Rule: Seeding Timeout */}
					<RuleSection
						icon={Timer}
						title="Seeding Timeout"
						description="Remove completed downloads that have been seeding too long"
						enabled={formData.seedingTimeoutEnabled ?? false}
						onToggle={(v) => updateField("seedingTimeoutEnabled", v)}
					>
						<ConfigInput
							label="Timeout"
							description="Remove after seeding for this long"
							value={formData.seedingTimeoutHours ?? 72}
							onChange={(v) => updateField("seedingTimeoutHours", v)}
							min={MIN_SEEDING_TIMEOUT_HOURS}
							max={MAX_SEEDING_TIMEOUT_HOURS}
							suffix="hours"
						/>
						<div className="text-xs text-muted-foreground p-2 rounded-md bg-card/30 border border-border/30">
							Completed downloads that have been seeding longer than the timeout will be removed. Useful for cleaning up finished torrents.
						</div>
					</RuleSection>

					{/* Rule: Estimated Completion */}
					<RuleSection
						icon={TrendingUp}
						title="Estimated Completion Exceeded"
						description="Flag downloads that take much longer than originally estimated"
						enabled={formData.estimatedCompletionEnabled ?? false}
						onToggle={(v) => updateField("estimatedCompletionEnabled", v)}
					>
						<ConfigInput
							label="Multiplier"
							description="Flag when actual time exceeds estimated time by this factor"
							value={formData.estimatedCompletionMultiplier ?? 2.0}
							onChange={(v) => updateField("estimatedCompletionMultiplier", v)}
							min={MIN_ESTIMATED_MULTIPLIER}
							max={MAX_ESTIMATED_MULTIPLIER}
							suffix="x"
						/>
						<div className="text-xs text-muted-foreground p-2 rounded-md bg-card/30 border border-border/30">
							Uses the ETA from your download client. If a download was estimated to complete in 1 hour
							but is still downloading after 2 hours (2x multiplier), it will be flagged as stalled.
						</div>
					</RuleSection>

					{/* Rule: Import Pending Timeout */}
					<RuleSection
						icon={Clock}
						title="Import Pending / Blocked"
						description="Handle downloads stuck in import pending or blocked state"
						enabled={formData.importPendingEnabled ?? true}
						onToggle={(v) => updateField("importPendingEnabled", v)}
					>
						<ConfigInput
							label="Timeout Threshold"
							description="Flag after pending for this long without status info"
							value={formData.importPendingThresholdMins ?? 60}
							onChange={(v) => updateField("importPendingThresholdMins", v)}
							min={MIN_IMPORT_PENDING_MINS}
							max={MAX_IMPORT_PENDING_MINS}
							suffix="mins"
						/>
						<div className="space-y-2">
							<label htmlFor="cleanup-aggressiveness-select" className="text-xs font-medium text-foreground">Cleanup Aggressiveness</label>
							<select
								id="cleanup-aggressiveness-select"
								value={formData.importBlockCleanupLevel ?? "safe"}
								onChange={(e) =>
									updateField(
										"importBlockCleanupLevel",
										e.target.value as "safe" | "moderate" | "aggressive",
									)
								}
								className="w-full h-9 rounded-md border border-border/50 bg-card/50 px-3 text-sm text-foreground focus:border-primary/50 focus:outline-none focus:ring-1 focus:ring-primary/30"
							>
								<option value="safe">Safe - Redundant & quality mismatches only</option>
								<option value="moderate">Moderate - Also items needing manual review</option>
								<option value="aggressive">Aggressive - Include technical issues</option>
							</select>
							<div className="text-xs text-muted-foreground space-y-1 p-2 rounded-md bg-card/30 border border-border/30">
								<p><strong>Safe:</strong> Already exists, duplicate, quality not wanted, cutoff met, sample files, no video files</p>
								<p><strong>Moderate:</strong> + Manual import required, missing expected files</p>
								<p><strong>Aggressive:</strong> + Password protected, unpack required, RAR issues</p>
							</div>
						</div>

						{/* Pattern Matching Mode */}
						<div className="space-y-2 pt-3 border-t border-border/30">
							<label htmlFor="pattern-matching-mode-select" className="text-xs font-medium text-foreground">Pattern Matching Mode</label>
							<select
								id="pattern-matching-mode-select"
								value={formData.importBlockPatternMode ?? "defaults"}
								onChange={(e) =>
									updateField(
										"importBlockPatternMode",
										e.target.value as "defaults" | "include" | "exclude",
									)
								}
								className="w-full h-9 rounded-md border border-border/50 bg-card/50 px-3 text-sm text-foreground focus:border-primary/50 focus:outline-none focus:ring-1 focus:ring-primary/30"
							>
								<option value="defaults">Use Categorized Defaults</option>
								<option value="include">Include Only (custom patterns)</option>
								<option value="exclude">Exclude Patterns (protect items)</option>
							</select>
							<div className="text-xs text-muted-foreground space-y-1 p-2 rounded-md bg-card/30 border border-border/30">
								<p><strong>Defaults:</strong> Use built-in keyword categories based on cleanup level</p>
								<p><strong>Include Only:</strong> Only clean items matching YOUR custom patterns</p>
								<p><strong>Exclude:</strong> Use defaults BUT skip items matching your patterns</p>
							</div>
						</div>

						{/* Custom Patterns - shown when mode is include or exclude */}
						{(formData.importBlockPatternMode === "include" ||
							formData.importBlockPatternMode === "exclude") && (
							<div className="space-y-2">
								<label htmlFor="import-block-patterns-textarea" className="text-xs font-medium text-foreground">
									{formData.importBlockPatternMode === "include"
										? "Clean Items Matching These Patterns"
										: "Protect Items Matching These Patterns"}
								</label>
								<textarea
									id="import-block-patterns-textarea"
									value={(() => {
										try {
											const patterns = formData.importBlockPatterns
												? JSON.parse(formData.importBlockPatterns)
												: [];
											return Array.isArray(patterns) ? patterns.join("\n") : "";
										} catch {
											return "";
										}
									})()}
									onChange={(e) => {
										const lines = e.target.value.split("\n").filter((l) => l.trim());
										updateField(
											"importBlockPatterns",
											lines.length > 0 ? JSON.stringify(lines) : null,
										);
									}}
									placeholder={
										formData.importBlockPatternMode === "include"
											? "quality not wanted\nalready exists\nduplicate"
											: "unpacking\nextracting"
									}
									rows={4}
									className="w-full rounded-md border border-border/50 bg-card/50 px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground/50 focus:border-primary/50 focus:outline-none focus:ring-1 focus:ring-primary/30 resize-none font-mono"
								/>
								<p className="text-xs text-muted-foreground">
									One pattern per line. Matches are case-insensitive and checked against status messages.
								</p>
							</div>
						)}

						{/* Auto-Import Sub-Feature */}
						<div className="space-y-3 pt-3 border-t border-border/30">
							<div className="flex items-center gap-2">
								<Sparkles className="h-4 w-4 text-amber-500" />
								<h6 className="text-xs font-semibold text-foreground">Auto-Import (Experimental)</h6>
							</div>
							<ToggleRow
								label="Try auto-import before removal"
								description="Attempt to import completed downloads before falling back to removal"
								checked={formData.autoImportEnabled ?? false}
								onChange={(v) => updateField("autoImportEnabled", v)}
							/>
							{formData.autoImportEnabled && (
								<>
									<ToggleRow
										label="Safe patterns only"
										description="Only import items with known-safe status messages (e.g., 'waiting for import')"
										checked={formData.autoImportSafeOnly ?? true}
										onChange={(v) => updateField("autoImportSafeOnly", v)}
									/>
									<ConfigInput
										label="Max Import Attempts"
										description="Stop trying after this many failed attempts"
										value={formData.autoImportMaxAttempts ?? 2}
										onChange={(v) => updateField("autoImportMaxAttempts", v)}
										min={MIN_AUTO_IMPORT_ATTEMPTS}
										max={MAX_AUTO_IMPORT_ATTEMPTS}
										suffix="attempts"
									/>
									<ConfigInput
										label="Retry Cooldown"
										description="Wait this long between import attempts on the same item"
										value={formData.autoImportCooldownMins ?? 30}
										onChange={(v) => updateField("autoImportCooldownMins", v)}
										min={MIN_AUTO_IMPORT_COOLDOWN_MINS}
										max={MAX_AUTO_IMPORT_COOLDOWN_MINS}
										suffix="mins"
									/>
									<div className="text-xs text-muted-foreground p-2 rounded-md bg-card/30 border border-border/30 space-y-1">
										<p className="font-medium">How it works:</p>
										<ol className="list-decimal list-inside space-y-0.5 ml-1">
											<li>Detect import pending/blocked items</li>
											<li>Check eligibility (cooldown, max attempts, patterns)</li>
											<li>Trigger import via ARR API</li>
											<li>If import fails, fall back to normal removal</li>
										</ol>
									</div>
								</>
							)}
						</div>
					</RuleSection>

					{/* Removal Options */}
					<div className="space-y-3 pt-2 border-t border-border/30">
						<h5 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
							Removal Options
						</h5>
						<ToggleRow
							label="Remove from download client"
							description="Also remove the download from qBittorrent/SABnzbd etc."
							checked={formData.removeFromClient ?? true}
							onChange={(v) => updateField("removeFromClient", v)}
						/>
						<ToggleRow
							label="Add to blocklist"
							description="Prevent re-downloading the same release"
							checked={formData.addToBlocklist ?? true}
							onChange={(v) => updateField("addToBlocklist", v)}
						/>
						<ToggleRow
							label="Search for replacement"
							description="Trigger a new search after removal"
							checked={formData.searchAfterRemoval ?? false}
							onChange={(v) => updateField("searchAfterRemoval", v)}
						/>

						{/* Change Category - Torrent only */}
						<div className="pt-2 border-t border-border/20">
							<ToggleRow
								label="Change category instead of delete"
								description="Move torrents to Post-Import Category (set in Sonarr/Radarr download client settings)"
								checked={formData.changeCategoryEnabled ?? false}
								onChange={(v) => updateField("changeCategoryEnabled", v)}
							/>
						</div>
					</div>

					{/* Safety Settings */}
					<div className="space-y-3 pt-2 border-t border-border/30">
						<h5 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
							Safety Limits
						</h5>
						<ConfigInput
							label="Max Removals Per Run"
							description="Cap the number of items removed in a single run"
							value={formData.maxRemovalsPerRun ?? 10}
							onChange={(v) => updateField("maxRemovalsPerRun", v)}
							min={MIN_MAX_REMOVALS}
							max={MAX_MAX_REMOVALS}
							suffix="items"
						/>
						<ConfigInput
							label="Min Queue Age"
							description="Only consider items older than this"
							value={formData.minQueueAgeMins ?? 5}
							onChange={(v) => updateField("minQueueAgeMins", v)}
							min={MIN_QUEUE_AGE_MINS}
							max={MAX_QUEUE_AGE_MINS}
							suffix="minutes"
						/>
					</div>

					{/* Save/Reset buttons */}
					<div className="flex justify-end gap-2 pt-2 border-t border-border/30">
						<Button
							variant="secondary"
							size="sm"
							className="gap-1.5"
							onClick={handleReset}
							disabled={!isDirty}
						>
							<RotateCcw className="h-3.5 w-3.5" />
							Reset
						</Button>
						<Button
							variant="secondary"
							size="sm"
							className="gap-1.5"
							onClick={() => void handleSave()}
							disabled={!isDirty || isUpdating}
							style={{
								borderColor: isDirty ? `${themeGradient.from}40` : undefined,
								color: isDirty ? themeGradient.from : undefined,
							}}
						>
							{isUpdating ? (
								<Loader2 className="h-3.5 w-3.5 animate-spin" />
							) : (
								<Save className="h-3.5 w-3.5" />
							)}
							Save
						</Button>
					</div>
				</div>
			</GlassmorphicCard>
		</div>
	);
};

// === Shared UI Components ===

const ToggleSwitch = ({
	checked,
	onChange,
	label,
}: {
	checked: boolean;
	onChange: (value: boolean) => void;
	label?: string;
}) => (
	<button
		type="button"
		role="switch"
		aria-checked={checked}
		aria-label={label}
		className="relative inline-flex h-5 w-9 items-center rounded-full transition-colors"
		style={{
			backgroundColor: checked ? SEMANTIC_COLORS.success.text : "rgba(128, 128, 128, 0.3)",
		}}
		onClick={() => onChange(!checked)}
	>
		<span
			className="inline-block h-3.5 w-3.5 rounded-full bg-white transition-transform"
			style={{ transform: checked ? "translateX(18px)" : "translateX(3px)" }}
		/>
	</button>
);

const ToggleRow = ({
	label,
	description,
	checked,
	onChange,
}: {
	label: string;
	description: string;
	checked: boolean;
	onChange: (value: boolean) => void;
}) => (
	<div className="flex items-center justify-between">
		<div>
			<span className="text-sm text-foreground">{label}</span>
			<p className="text-xs text-muted-foreground">{description}</p>
		</div>
		<ToggleSwitch checked={checked} onChange={onChange} label={label} />
	</div>
);

const RuleSection = ({
	icon: Icon,
	title,
	description,
	enabled,
	onToggle,
	children,
}: {
	icon: React.ComponentType<{ className?: string; style?: React.CSSProperties }>;
	title: string;
	description: string;
	enabled: boolean;
	onToggle: (value: boolean) => void;
	children?: React.ReactNode;
}) => (
	<div className="space-y-3">
		<div className="flex items-center justify-between">
			<div className="flex items-center gap-2.5">
				<Icon className="h-4 w-4 text-muted-foreground" />
				<div>
					<h5 className="text-sm font-medium text-foreground">{title}</h5>
					<p className="text-xs text-muted-foreground">{description}</p>
				</div>
			</div>
			<ToggleSwitch checked={enabled} onChange={onToggle} label={title} />
		</div>
		{enabled && children && (
			<div className="pl-7 space-y-3 border-l-2 border-border/30 ml-2">
				{children}
			</div>
		)}
	</div>
);

const ConfigInput = ({
	label,
	description,
	value,
	onChange,
	min,
	max,
	suffix,
	id,
}: {
	label: string;
	description: string;
	value: number;
	onChange: (value: number) => void;
	min: number;
	max: number;
	suffix: string;
	id?: string;
}) => {
	// Generate stable ID for label-input association (accessibility)
	const generatedId = `config-input-${label.toLowerCase().replace(/\s+/g, "-")}`;
	const inputId = id ?? generatedId;

	return (
		<div>
			<label htmlFor={inputId} className="text-xs font-medium text-foreground block mb-1">
				{label}
			</label>
			<div className="flex items-center gap-2">
				<input
					id={inputId}
					type="number"
					className="w-24 rounded-lg border border-border/50 bg-card/50 px-3 py-1.5 text-sm text-foreground focus:outline-none focus:ring-1"
					value={value}
					onChange={(e) => {
						const parsed = Number.parseInt(e.target.value, 10);
						if (!Number.isNaN(parsed)) {
							onChange(Math.max(min, Math.min(max, parsed)));
						}
					}}
					min={min}
					max={max}
				/>
				<span className="text-xs text-muted-foreground">{suffix}</span>
			</div>
			<p className="text-[10px] text-muted-foreground mt-0.5">{description}</p>
		</div>
	);
};

const WhitelistEditor = ({
	patterns,
	onChange,
}: {
	patterns: string | null | undefined;
	onChange: (value: string | null) => void;
}) => {
	// Parse patterns from JSON string
	const parsedPatterns: WhitelistPattern[] = (() => {
		if (!patterns) return [];
		try {
			return JSON.parse(patterns) as WhitelistPattern[];
		} catch {
			return [];
		}
	})();

	const addPattern = () => {
		// Generate unique ID for stable React key (prevents reconciliation issues)
		const id = `wp-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
		const newPatterns = [
			...parsedPatterns,
			{ type: "tracker" as const, pattern: "", id },
		];
		onChange(JSON.stringify(newPatterns));
	};

	const removePattern = (index: number) => {
		const newPatterns = parsedPatterns.filter((_, i) => i !== index);
		onChange(newPatterns.length > 0 ? JSON.stringify(newPatterns) : null);
	};

	const updatePattern = (index: number, field: keyof WhitelistPattern, value: string) => {
		const newPatterns = [...parsedPatterns];
		const currentPattern = newPatterns[index];
		if (currentPattern) {
			if (field === "type") {
				currentPattern.type = value as WhitelistPattern["type"];
			} else {
				currentPattern.pattern = value;
			}
		}
		onChange(JSON.stringify(newPatterns));
	};

	return (
		<div className="space-y-2">
			{parsedPatterns.map((p, index) => (
				// Use pattern's id if available, fallback to content-based key
				<div key={p.id ?? `${p.type}-${p.pattern}-${index}`} className="flex items-center gap-2">
					<select
						className="rounded-lg border border-border/50 bg-card/50 px-2 py-1.5 text-sm text-foreground focus:outline-none focus:ring-1"
						value={p.type}
						onChange={(e) => updatePattern(index, "type", e.target.value)}
					>
						{WHITELIST_TYPES.map((t) => (
							<option key={t.value} value={t.value}>
								{t.label}
							</option>
						))}
					</select>
					<input
						type="text"
						className="flex-1 rounded-lg border border-border/50 bg-card/50 px-2 py-1.5 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1"
						placeholder="Enter pattern..."
						value={p.pattern}
						onChange={(e) => updatePattern(index, "pattern", e.target.value)}
					/>
					<button
						type="button"
						className="p-1.5 rounded-md text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors"
						onClick={() => removePattern(index)}
						aria-label="Remove pattern"
					>
						<X className="h-4 w-4" />
					</button>
				</div>
			))}
			<Button
				type="button"
				variant="secondary"
				size="sm"
				className="gap-1.5"
				onClick={addPattern}
			>
				<Plus className="h-3.5 w-3.5" />
				Add Pattern
			</Button>
			<p className="text-[10px] text-muted-foreground">
				Items matching any pattern will be excluded from queue cleaning. Patterns are case-insensitive substring matches.
			</p>
		</div>
	);
};
