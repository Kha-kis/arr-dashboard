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
	ChevronDown,
	ChevronUp,
	CheckCircle2,
	Ban,
	FileText,
	HelpCircle,
	ArrowRight,
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
	AUTO_IMPORT_SAFE_PATTERNS,
	AUTO_IMPORT_NEVER_PATTERNS,
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
						title="Download Errors"
						description="Remove downloads that FAILED during transfer"
						enabled={formData.errorPatternsEnabled ?? false}
						onToggle={(v) => updateField("errorPatternsEnabled", v)}
					>
						<div className="text-xs p-2.5 rounded-lg bg-red-500/10 border border-red-500/20 mb-3">
							<p className="text-muted-foreground">
								<span className="font-medium text-red-400">For broken downloads</span> — matches error messages like &quot;disk space&quot;, &quot;permission denied&quot;, &quot;connection failed&quot;.
								<span className="text-muted-foreground/70"> (Different from Import Blocked which handles completed downloads that ARR won&apos;t import)</span>
							</p>
						</div>
						<div>
							<label htmlFor="error-patterns-textarea" className="text-xs font-medium text-foreground block mb-1.5">
								Custom error patterns (one per line)
							</label>
							<textarea
								id="error-patterns-textarea"
								className="w-full rounded-lg border border-border/50 bg-card/50 px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 min-h-[80px] resize-y"
								style={{ focusRingColor: themeGradient.from } as React.CSSProperties}
								placeholder="disk space&#10;permission denied&#10;tracker error"
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
								Case-insensitive matching against download client error messages
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
						description="Handle completed downloads that ARR won't import"
						enabled={formData.importPendingEnabled ?? true}
						onToggle={(v) => updateField("importPendingEnabled", v)}
					>
						{/* Explanation */}
						<div className="text-xs p-3 rounded-lg bg-gradient-to-r from-blue-500/10 to-purple-500/10 border border-blue-500/20 space-y-2">
							<div className="flex items-center gap-2 text-foreground font-medium">
								<FileText className="h-3.5 w-3.5 text-blue-400" />
								What this handles:
							</div>
							<p className="text-muted-foreground">
								Downloads that <span className="text-emerald-400 font-medium">finished successfully</span> but are stuck because ARR won&apos;t import them — duplicates, wrong quality, sample files, etc.
								<span className="text-muted-foreground/70"> (Different from Download Errors which handles broken/failed transfers)</span>
							</p>
							<div className="flex items-center gap-1.5 text-muted-foreground flex-wrap pt-1">
								<span className="px-2 py-0.5 rounded bg-emerald-500/20 border border-emerald-500/30 text-emerald-400">Download complete</span>
								<ArrowRight className="h-3 w-3 text-muted-foreground/50" />
								<span className="px-2 py-0.5 rounded bg-amber-500/20 border border-amber-500/30 text-amber-400">ARR blocks import</span>
								<ArrowRight className="h-3 w-3 text-muted-foreground/50" />
								<span className="px-2 py-0.5 rounded bg-card/50 border border-border/30">Wait timeout</span>
								<ArrowRight className="h-3 w-3 text-muted-foreground/50" />
								<span className="px-2 py-0.5 rounded bg-blue-500/20 border border-blue-500/30 text-blue-400">Try import?</span>
								<ArrowRight className="h-3 w-3 text-muted-foreground/50" />
								<span className="px-2 py-0.5 rounded bg-red-500/20 border border-red-500/30 text-red-400">Remove</span>
							</div>
						</div>

						{/* Step 1: Timeout */}
						<div className="space-y-2 pt-2">
							<div className="flex items-center gap-2">
								<span className="flex items-center justify-center h-5 w-5 rounded-full bg-blue-500/20 text-blue-400 text-[10px] font-bold">1</span>
								<span className="text-xs font-medium text-foreground">Wait Period</span>
								<Tooltip text="How long to wait before taking action. Gives time for temporary issues to resolve (e.g., files still being extracted)." />
							</div>
							<ConfigInput
								label=""
								description="Only act on items stuck for at least this long"
								value={formData.importPendingThresholdMins ?? 60}
								onChange={(v) => updateField("importPendingThresholdMins", v)}
								min={MIN_IMPORT_PENDING_MINS}
								max={MAX_IMPORT_PENDING_MINS}
								suffix="mins"
							/>
						</div>

						{/* Step 2: Pattern Matching */}
						<div className="space-y-3 pt-3 border-t border-border/30">
							<div className="flex items-center gap-2">
								<span className="flex items-center justify-center h-5 w-5 rounded-full bg-blue-500/20 text-blue-400 text-[10px] font-bold">2</span>
								<span className="text-xs font-medium text-foreground">Decide What to Clean</span>
								<Tooltip text="Controls which blocked items get removed. Items not matching the criteria are left alone." />
							</div>

							<div className="space-y-2">
								<label htmlFor="cleanup-aggressiveness-select" className="text-xs text-muted-foreground">Cleanup Level</label>
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
									<option value="safe">Safe - Only obvious failures</option>
									<option value="moderate">Moderate - Include items needing manual action</option>
									<option value="aggressive">Aggressive - Clean anything stuck</option>
								</select>
								<details className="text-xs text-muted-foreground">
									<summary className="cursor-pointer hover:text-foreground transition-colors py-1">
										What does each level clean? (click to expand)
									</summary>
									<div className="mt-2 p-2.5 rounded-md bg-card/30 border border-border/30 space-y-1.5">
										<p>
											<span className="inline-block w-20 font-medium text-emerald-400">Safe:</span>
											Duplicates, already exists, quality rejected, sample files, no video files
										</p>
										<p>
											<span className="inline-block w-20 font-medium text-amber-400">Moderate:</span>
											+ manual import required, missing expected files
										</p>
										<p>
											<span className="inline-block w-20 font-medium text-red-400">Aggressive:</span>
											+ password protected, unpack/RAR issues
										</p>
									</div>
								</details>
							</div>

							{/* Advanced: Pattern Mode */}
							<details className="text-xs">
								<summary className="cursor-pointer text-muted-foreground hover:text-foreground transition-colors py-1 flex items-center gap-1">
									<Settings className="h-3 w-3" />
									Advanced: Custom pattern rules
								</summary>
								<div className="mt-2 space-y-2 p-2.5 rounded-md bg-card/30 border border-border/30">
									<select
										id="pattern-matching-mode-select"
										value={formData.importBlockPatternMode ?? "defaults"}
										onChange={(e) =>
											updateField(
												"importBlockPatternMode",
												e.target.value as "defaults" | "include" | "exclude",
											)
										}
										className="w-full h-8 rounded-md border border-border/50 bg-card/50 px-2 text-xs text-foreground focus:border-primary/50 focus:outline-none focus:ring-1 focus:ring-primary/30"
									>
										<option value="defaults">Use cleanup level defaults</option>
										<option value="include">Custom: Only clean items matching my patterns</option>
										<option value="exclude">Custom: Protect items matching my patterns</option>
									</select>

									{(formData.importBlockPatternMode === "include" ||
										formData.importBlockPatternMode === "exclude") && (
										<div className="space-y-1.5 pt-2">
											<label htmlFor="import-block-patterns-textarea" className="text-muted-foreground">
												{formData.importBlockPatternMode === "include"
													? "Only clean items with these status messages:"
													: "Never clean items with these status messages:"}
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
												rows={3}
												className="w-full rounded-md border border-border/50 bg-card/50 px-2 py-1.5 text-xs text-foreground placeholder:text-muted-foreground/50 focus:border-primary/50 focus:outline-none focus:ring-1 focus:ring-primary/30 resize-none font-mono"
											/>
											<p className="text-[10px] text-muted-foreground/70">
												One pattern per line, case-insensitive.
											</p>
										</div>
									)}
								</div>
							</details>
						</div>

						{/* Step 3: Auto-Import (Optional) */}
						<div className="space-y-2 pt-3 border-t border-border/30">
							<div className="flex items-center gap-2">
								<span className="flex items-center justify-center h-5 w-5 rounded-full bg-amber-500/20 text-amber-400 text-[10px] font-bold">3</span>
								<span className="text-xs font-medium text-foreground">Before Removing: Try Import?</span>
								<span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-400 border border-amber-500/30">Optional</span>
							</div>
							<p className="text-[11px] text-muted-foreground pl-7">
								When enabled, attempts to import stuck downloads via ARR&apos;s API before removing them.
								If import succeeds, the item is saved. If it fails, removal continues as normal.
							</p>
						</div>

						{/* Auto-Import Sub-Feature */}
						<AutoImportSection
							formData={formData}
							updateField={updateField}
						/>
					</RuleSection>

					{/* Removal Options */}
					<div className="space-y-3 pt-2 border-t border-border/30">
						<h5 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
							Removal Options
						</h5>
						<ToggleRow
							label="Remove from download client"
							description="Also remove the download from qBittorrent/SABnzbd etc."
							checked={formData.removeFromClient ?? false}
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

// === Auto-Import Section Component ===

/**
 * Enhanced auto-import configuration section with pattern visibility.
 * Shows safe patterns (built-in + custom) and never-import patterns (read-only).
 */
const AutoImportSection = ({
	formData,
	updateField,
}: {
	formData: QueueCleanerConfigUpdate;
	updateField: <K extends keyof QueueCleanerConfigUpdate>(key: K, value: QueueCleanerConfigUpdate[K]) => void;
}) => {
	const [showSafePatterns, setShowSafePatterns] = useState(false);
	const [showNeverPatterns, setShowNeverPatterns] = useState(false);

	// Parse custom safe patterns from JSON
	const customSafePatterns: string[] = (() => {
		const json = formData.autoImportCustomPatterns;
		if (!json) return [];
		try {
			const parsed = JSON.parse(json);
			return Array.isArray(parsed) ? parsed : [];
		} catch {
			return [];
		}
	})();

	// Parse custom never patterns from JSON
	const customNeverPatterns: string[] = (() => {
		const json = formData.autoImportNeverPatterns;
		if (!json) return [];
		try {
			const parsed = JSON.parse(json);
			return Array.isArray(parsed) ? parsed : [];
		} catch {
			return [];
		}
	})();

	const updateCustomSafePatterns = (patterns: string[]) => {
		updateField("autoImportCustomPatterns", patterns.length > 0 ? JSON.stringify(patterns) : null);
	};

	const updateCustomNeverPatterns = (patterns: string[]) => {
		updateField("autoImportNeverPatterns", patterns.length > 0 ? JSON.stringify(patterns) : null);
	};

	const addCustomSafePattern = (pattern: string) => {
		const trimmed = pattern.trim().toLowerCase();
		if (trimmed && !customSafePatterns.includes(trimmed) && !AUTO_IMPORT_SAFE_PATTERNS.includes(trimmed as typeof AUTO_IMPORT_SAFE_PATTERNS[number])) {
			updateCustomSafePatterns([...customSafePatterns, trimmed]);
		}
	};

	const removeCustomSafePattern = (index: number) => {
		updateCustomSafePatterns(customSafePatterns.filter((_, i) => i !== index));
	};

	const addCustomNeverPattern = (pattern: string) => {
		const trimmed = pattern.trim().toLowerCase();
		if (trimmed && !customNeverPatterns.includes(trimmed) && !AUTO_IMPORT_NEVER_PATTERNS.includes(trimmed as typeof AUTO_IMPORT_NEVER_PATTERNS[number])) {
			updateCustomNeverPatterns([...customNeverPatterns, trimmed]);
		}
	};

	const removeCustomNeverPattern = (index: number) => {
		updateCustomNeverPatterns(customNeverPatterns.filter((_, i) => i !== index));
	};

	return (
		<div className="space-y-3 pt-3 border-t border-border/30">
			{/* Header */}
			<div className="flex items-center gap-2">
				<Sparkles className="h-4 w-4 text-amber-500" />
				<h6 className="text-xs font-semibold text-foreground">Auto-Import (Experimental)</h6>
			</div>

			{/* Main toggle */}
			<ToggleRow
				label="Try auto-import before removal"
				description="Attempt to import completed downloads via ARR API before falling back to removal"
				checked={formData.autoImportEnabled ?? false}
				onChange={(v) => updateField("autoImportEnabled", v)}
			/>

			{formData.autoImportEnabled && (
				<div className="space-y-4 pl-1">
					{/* Safe patterns mode toggle with enhanced description */}
					<div className="space-y-2">
						<ToggleRow
							label="Safe patterns only"
							description={
								formData.autoImportSafeOnly ?? true
									? "ON: Only imports items matching safe patterns below (recommended)"
									: "OFF: Attempts import on ANY pending/blocked item (use with caution)"
							}
							checked={formData.autoImportSafeOnly ?? true}
							onChange={(v) => updateField("autoImportSafeOnly", v)}
						/>
					</div>

					{/* Safe Patterns Section (Collapsible) */}
					<div className="border border-border/30 rounded-lg overflow-hidden">
						<button
							type="button"
							className="w-full flex items-center justify-between p-2.5 bg-card/30 hover:bg-card/50 transition-colors"
							onClick={() => setShowSafePatterns(!showSafePatterns)}
						>
							<div className="flex items-center gap-2">
								<CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" />
								<span className="text-xs font-medium text-foreground">
									Safe Patterns ({AUTO_IMPORT_SAFE_PATTERNS.length + customSafePatterns.length})
								</span>
							</div>
							{showSafePatterns ? (
								<ChevronUp className="h-4 w-4 text-muted-foreground" />
							) : (
								<ChevronDown className="h-4 w-4 text-muted-foreground" />
							)}
						</button>

						{showSafePatterns && (
							<div className="p-2.5 space-y-3 border-t border-border/20 bg-card/20">
								<p className="text-[10px] text-muted-foreground">
									Items matching these patterns CAN be auto-imported. Built-in patterns are based on common ARR status messages.
								</p>

								{/* Built-in patterns */}
								<div className="space-y-1">
									<span className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">Built-in</span>
									<div className="flex flex-wrap gap-1">
										{AUTO_IMPORT_SAFE_PATTERNS.map((pattern) => (
											<span
												key={pattern}
												className="inline-flex items-center px-2 py-0.5 rounded text-[10px] bg-emerald-500/10 text-emerald-400 border border-emerald-500/20"
											>
												{pattern}
											</span>
										))}
									</div>
								</div>

								{/* Custom patterns */}
								<div className="space-y-1.5">
									<span className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">Custom</span>
									{customSafePatterns.length > 0 ? (
										<div className="flex flex-wrap gap-1">
											{customSafePatterns.map((pattern, index) => (
												<span
													key={pattern}
													className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] bg-blue-500/10 text-blue-400 border border-blue-500/20"
												>
													{pattern}
													<button
														type="button"
														onClick={() => removeCustomSafePattern(index)}
														className="hover:text-red-400 transition-colors"
													>
														<X className="h-2.5 w-2.5" />
													</button>
												</span>
											))}
										</div>
									) : (
										<p className="text-[10px] text-muted-foreground/50 italic">No custom patterns added</p>
									)}

									{/* Add custom pattern input */}
									<div className="flex gap-1.5 mt-2">
										<input
											type="text"
											placeholder="Add custom pattern..."
											className="flex-1 rounded-md border border-border/50 bg-card/50 px-2 py-1 text-[11px] text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:ring-1 focus:ring-primary/30"
											onKeyDown={(e) => {
												if (e.key === "Enter") {
													e.preventDefault();
													const input = e.currentTarget;
													addCustomSafePattern(input.value);
													input.value = "";
												}
											}}
										/>
										<Button
											variant="secondary"
											size="sm"
											className="h-6 px-2 text-[10px]"
											onClick={(e) => {
												const input = e.currentTarget.previousElementSibling as HTMLInputElement;
												if (input?.value) {
													addCustomSafePattern(input.value);
													input.value = "";
												}
											}}
										>
											<Plus className="h-3 w-3" />
										</Button>
									</div>
								</div>
							</div>
						)}
					</div>

					{/* Never-Import Patterns Section (Collapsible) */}
					<div className="border border-border/30 rounded-lg overflow-hidden">
						<button
							type="button"
							className="w-full flex items-center justify-between p-2.5 bg-card/30 hover:bg-card/50 transition-colors"
							onClick={() => setShowNeverPatterns(!showNeverPatterns)}
						>
							<div className="flex items-center gap-2">
								<Ban className="h-3.5 w-3.5 text-red-500" />
								<span className="text-xs font-medium text-foreground">
									Never Import ({AUTO_IMPORT_NEVER_PATTERNS.length + customNeverPatterns.length})
								</span>
							</div>
							{showNeverPatterns ? (
								<ChevronUp className="h-4 w-4 text-muted-foreground" />
							) : (
								<ChevronDown className="h-4 w-4 text-muted-foreground" />
							)}
						</button>

						{showNeverPatterns && (
							<div className="p-2.5 space-y-3 border-t border-border/20 bg-card/20">
								<p className="text-[10px] text-muted-foreground">
									Items matching these patterns are BLOCKED from auto-import. These will never be attempted.
								</p>

								{/* Built-in never patterns */}
								<div className="space-y-1">
									<span className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">Built-in</span>
									<div className="flex flex-wrap gap-1">
										{AUTO_IMPORT_NEVER_PATTERNS.map((pattern) => (
											<span
												key={pattern}
												className="inline-flex items-center px-2 py-0.5 rounded text-[10px] bg-red-500/10 text-red-400 border border-red-500/20"
											>
												{pattern}
											</span>
										))}
									</div>
								</div>

								{/* Custom never patterns */}
								<div className="space-y-1.5">
									<span className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">Custom</span>
									{customNeverPatterns.length > 0 ? (
										<div className="flex flex-wrap gap-1">
											{customNeverPatterns.map((pattern, index) => (
												<span
													key={pattern}
													className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] bg-orange-500/10 text-orange-400 border border-orange-500/20"
												>
													{pattern}
													<button
														type="button"
														onClick={() => removeCustomNeverPattern(index)}
														className="hover:text-red-400 transition-colors"
													>
														<X className="h-2.5 w-2.5" />
													</button>
												</span>
											))}
										</div>
									) : (
										<p className="text-[10px] text-muted-foreground/50 italic">No custom patterns added</p>
									)}

									{/* Add custom never pattern input */}
									<div className="flex gap-1.5 mt-2">
										<input
											type="text"
											placeholder="Add pattern to block..."
											className="flex-1 rounded-md border border-border/50 bg-card/50 px-2 py-1 text-[11px] text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:ring-1 focus:ring-primary/30"
											onKeyDown={(e) => {
												if (e.key === "Enter") {
													e.preventDefault();
													const input = e.currentTarget;
													addCustomNeverPattern(input.value);
													input.value = "";
												}
											}}
										/>
										<Button
											variant="secondary"
											size="sm"
											className="h-6 px-2 text-[10px]"
											onClick={(e) => {
												const input = e.currentTarget.previousElementSibling as HTMLInputElement;
												if (input?.value) {
													addCustomNeverPattern(input.value);
													input.value = "";
												}
											}}
										>
											<Plus className="h-3 w-3" />
										</Button>
									</div>
								</div>
							</div>
						)}
					</div>

					{/* Settings */}
					<div className="space-y-3 pt-2">
						<ConfigInput
							label="Max Import Attempts"
							description="Stop trying after this many failed attempts per item"
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
					</div>

					{/* How it works info box */}
					<div className="text-xs text-muted-foreground p-2.5 rounded-lg bg-card/30 border border-border/30 space-y-1.5">
						<div className="flex items-center gap-1.5">
							<FileText className="h-3.5 w-3.5" />
							<span className="font-medium">How auto-import works:</span>
						</div>
						<ol className="list-decimal list-inside space-y-0.5 ml-1 text-[11px]">
							<li>Detects items stuck in import pending/blocked state</li>
							<li>Checks eligibility (safe patterns, cooldown, max attempts)</li>
							<li>Triggers import via ARR&apos;s manual import API</li>
							<li>If import fails, falls back to normal removal behavior</li>
						</ol>
					</div>
				</div>
			)}
		</div>
	);
};

// === Shared UI Components ===

const Tooltip = ({ text }: { text: string }) => (
	<div className="group relative inline-flex">
		<HelpCircle className="h-3.5 w-3.5 text-muted-foreground/50 hover:text-muted-foreground cursor-help" />
		<div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 px-3 py-2 text-xs text-foreground bg-popover border border-border rounded-lg shadow-lg opacity-0 invisible group-hover:opacity-100 group-hover:visible transition-all duration-200 w-64 z-50 pointer-events-none">
			{text}
			<div className="absolute top-full left-1/2 -translate-x-1/2 -mt-1 border-4 border-transparent border-t-border" />
		</div>
	</div>
);

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
