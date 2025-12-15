"use client";

import { useState } from "react";
import { toast } from "sonner";
import {
	Button,
	Card,
	CardHeader,
	CardTitle,
	CardDescription,
	CardContent,
	Input,
	Switch,
	Badge,
	Alert,
	AlertDescription,
	EmptyState,
} from "../../../components/ui";
import { Section } from "../../../components/layout";
import { Settings, Save, RotateCcw, Play, Pause, Power, Zap } from "lucide-react";
import { useHuntingConfigs, useUpdateHuntConfig, useToggleScheduler } from "../hooks/useHuntingConfig";
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

export const HuntingConfig = () => {
	const { configs, instances, isLoading, error, refetch } = useHuntingConfigs();
	const { status, refetch: refetchStatus } = useHuntingStatus();
	const { toggleScheduler, isToggling } = useToggleScheduler();

	const handleToggleScheduler = async () => {
		try {
			const result = await toggleScheduler();
			// Refetch status to update UI immediately
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
		} catch (error) {
			toast.error("Failed to toggle automation");
		}
	};

	const schedulerRunning = status?.schedulerRunning ?? false;

	if (isLoading) {
		return (
			<Section title="Hunting Configuration">
				<div className="space-y-4">
					{Array.from({ length: 3 }).map((_, i) => (
						<div key={i} className="h-48 bg-bg-subtle animate-pulse rounded-xl" />
					))}
				</div>
			</Section>
		);
	}

	if (error) {
		return (
			<EmptyState
				icon={Settings}
				title="Failed to load configuration"
				description="Could not fetch hunting configuration. Please try again."
			/>
		);
	}

	const configuredInstances = configs.filter(c => c !== null);
	const unconfiguredInstances = instances.filter(
		inst => !configs.some(c => c?.instanceId === inst.id)
	);

	return (
		<Section
			title="Hunting Configuration"
			description="Configure automated hunting for each Sonarr and Radarr instance"
		>
			{/* Global Controls */}
			<div className={`mb-6 p-4 rounded-xl border ${schedulerRunning ? 'border-green-500/50 bg-green-500/5' : 'border-border bg-bg-subtle/50'}`}>
				<div className="flex items-center justify-between">
					<div className="flex items-center gap-3">
						<div className={`p-2 rounded-lg ${schedulerRunning ? 'bg-green-500/20' : 'bg-bg-subtle'}`}>
							<Power className={`h-5 w-5 ${schedulerRunning ? 'text-green-500' : 'text-fg-muted'}`} />
						</div>
						<div>
							<div className="flex items-center gap-2">
								<h3 className="font-medium text-fg">Automation</h3>
								<Badge variant={schedulerRunning ? "success" : "default"}>
									{schedulerRunning ? "Running" : "Stopped"}
								</Badge>
							</div>
							<p className="text-sm text-fg-muted">
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
					>
						{isToggling ? (
							<RotateCcw className="h-4 w-4 mr-2 animate-spin" />
						) : schedulerRunning ? (
							<Pause className="h-4 w-4 mr-2" />
						) : (
							<Play className="h-4 w-4 mr-2" />
						)}
						{schedulerRunning ? "Stop Automation" : "Start Automation"}
					</Button>
				</div>
			</div>

			{/* Configured Instances */}
			{configuredInstances.length > 0 && (
				<div className="space-y-4 mb-8">
					<h3 className="text-sm font-medium text-fg-muted uppercase tracking-wider">
						Configured Instances
					</h3>
					{configuredInstances.map((config) => (
						config && <InstanceConfigCard key={config.instanceId} config={config} onSaved={refetch} />
					))}
				</div>
			)}

			{/* Unconfigured Instances */}
			{unconfiguredInstances.length > 0 && (
				<div className="space-y-4">
					<h3 className="text-sm font-medium text-fg-muted uppercase tracking-wider">
						Available Instances
					</h3>
					<div className="grid gap-4 md:grid-cols-2">
						{unconfiguredInstances.map((instance) => (
							<UnconfiguredInstanceCard
								key={instance.id}
								instanceId={instance.id}
								instanceName={instance.label}
								service={instance.service}
								onConfigure={refetch}
							/>
						))}
					</div>
				</div>
			)}

			{configuredInstances.length === 0 && unconfiguredInstances.length === 0 && (
				<EmptyState
					icon={Settings}
					title="No instances available"
					description="Add Sonarr or Radarr instances in Settings first."
				/>
			)}
		</Section>
	);
};

interface InstanceConfigCardProps {
	config: HuntConfigWithInstance;
	onSaved: () => void;
}

const InstanceConfigCard = ({ config, onSaved }: InstanceConfigCardProps) => {
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
		// Filter fields
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
	});

	const { updateConfig, isUpdating, error } = useUpdateHuntConfig();
	const { triggerHunt, isTriggering, isCooldownError } = useManualHunt();

	const handleSave = async () => {
		try {
			await updateConfig(config.instanceId, formState);
			toast.success("Settings saved");
			onSaved();
		} catch (err) {
			toast.error("Failed to save settings");
		}
	};

	const handleRunNow = async (type: "missing" | "upgrade") => {
		try {
			const result = await triggerHunt(config.instanceId, type);
			toast.success(result.message);
		} catch (err) {
			// Check if it's a cooldown error (429)
			if (isCooldownError(err)) {
				toast.warning(err.message, {
					description: "Please wait before running another hunt",
				});
			} else {
				toast.error(`Failed to trigger ${type} hunt`);
			}
		}
	};

	const hasChanges = JSON.stringify(formState) !== JSON.stringify({
		huntMissingEnabled: config.huntMissingEnabled,
		huntUpgradesEnabled: config.huntUpgradesEnabled,
		missingBatchSize: config.missingBatchSize,
		missingIntervalMins: config.missingIntervalMins,
		upgradeBatchSize: config.upgradeBatchSize,
		upgradeIntervalMins: config.upgradeIntervalMins,
		hourlyApiCap: config.hourlyApiCap,
		queueThreshold: config.queueThreshold,
		// Filter fields
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
	});

	return (
		<Card>
			<CardHeader>
				<div className="flex items-center justify-between">
					<div className="flex items-center gap-2">
						<CardTitle>{config.instanceName}</CardTitle>
						<Badge variant={config.service === "sonarr" ? "info" : "warning"}>
							{config.service}
						</Badge>
					</div>
				</div>
				<CardDescription>
					Configure hunting settings for this instance
				</CardDescription>
			</CardHeader>
			<CardContent className="space-y-6">
				{error && (
					<Alert variant="danger">
						<AlertDescription>{error.message}</AlertDescription>
					</Alert>
				)}

				{/* Missing Content Settings */}
				<div className="space-y-4">
					<div className="flex items-center justify-between">
						<div>
							<h4 className="font-medium text-fg">Hunt Missing Content</h4>
							<p className="text-sm text-fg-muted">Search for undownloaded episodes/movies</p>
						</div>
						<Switch
							checked={formState.huntMissingEnabled ?? false}
							onCheckedChange={(checked) => setFormState(prev => ({ ...prev, huntMissingEnabled: checked }))}
						/>
					</div>

					{formState.huntMissingEnabled && (
						<div className="grid grid-cols-2 gap-4 pl-4 border-l-2 border-border">
							<div className="space-y-1">
								<label className="text-xs text-fg-muted">Items Per Hunt</label>
								<Input
									type="number"
									min={MIN_BATCH_SIZE}
									max={MAX_BATCH_SIZE}
									value={formState.missingBatchSize}
									onChange={(e) => setFormState(prev => ({ ...prev, missingBatchSize: Number.parseInt(e.target.value) || 5 }))}
								/>
								<p className="text-xs text-fg-muted">Max items to search each run</p>
							</div>
							<div className="space-y-1">
								<label className="text-xs text-fg-muted">Hunt Every (min {MIN_MISSING_INTERVAL_MINS})</label>
								<div className="flex items-center gap-2">
									<Input
										type="number"
										min={MIN_MISSING_INTERVAL_MINS}
										max={MAX_INTERVAL_MINS}
										value={formState.missingIntervalMins}
										onChange={(e) => setFormState(prev => ({ ...prev, missingIntervalMins: Number.parseInt(e.target.value) || 60 }))}
									/>
									<span className="text-sm text-fg-muted whitespace-nowrap">minutes</span>
								</div>
							</div>
						</div>
					)}
				</div>

				{/* Upgrade Settings */}
				<div className="space-y-4">
					<div className="flex items-center justify-between">
						<div>
							<h4 className="font-medium text-fg">Hunt Quality Upgrades</h4>
							<p className="text-sm text-fg-muted">Search for better quality versions</p>
						</div>
						<Switch
							checked={formState.huntUpgradesEnabled ?? false}
							onCheckedChange={(checked) => setFormState(prev => ({ ...prev, huntUpgradesEnabled: checked }))}
						/>
					</div>

					{formState.huntUpgradesEnabled && (
						<div className="grid grid-cols-2 gap-4 pl-4 border-l-2 border-border">
							<div className="space-y-1">
								<label className="text-xs text-fg-muted">Items Per Hunt</label>
								<Input
									type="number"
									min={MIN_BATCH_SIZE}
									max={MAX_BATCH_SIZE}
									value={formState.upgradeBatchSize}
									onChange={(e) => setFormState(prev => ({ ...prev, upgradeBatchSize: Number.parseInt(e.target.value) || 3 }))}
								/>
								<p className="text-xs text-fg-muted">Max items to search each run</p>
							</div>
							<div className="space-y-1">
								<label className="text-xs text-fg-muted">Hunt Every (min {MIN_UPGRADE_INTERVAL_MINS})</label>
								<div className="flex items-center gap-2">
									<Input
										type="number"
										min={MIN_UPGRADE_INTERVAL_MINS}
										max={MAX_INTERVAL_MINS}
										value={formState.upgradeIntervalMins}
										onChange={(e) => setFormState(prev => ({ ...prev, upgradeIntervalMins: Number.parseInt(e.target.value) || 120 }))}
									/>
									<span className="text-sm text-fg-muted whitespace-nowrap">minutes</span>
								</div>
							</div>
						</div>
					)}
				</div>

				{/* Rate Limiting */}
				<div className="space-y-4 pt-4 border-t border-border">
					<h4 className="font-medium text-fg">Rate Limiting</h4>
					<div className="grid grid-cols-2 gap-4">
						<div className="space-y-1">
							<label className="text-xs text-fg-muted">Hourly API Cap</label>
							<Input
								type="number"
								min={MIN_HOURLY_API_CAP}
								max={MAX_HOURLY_API_CAP}
								value={formState.hourlyApiCap}
								onChange={(e) => setFormState(prev => ({ ...prev, hourlyApiCap: Number.parseInt(e.target.value) || 100 }))}
							/>
							<p className="text-xs text-fg-muted">Max API calls per hour</p>
						</div>
						<div className="space-y-1">
							<label className="text-xs text-fg-muted">Queue Threshold</label>
							<Input
								type="number"
								min={0}
								max={MAX_QUEUE_THRESHOLD}
								value={formState.queueThreshold}
								onChange={(e) => setFormState(prev => ({ ...prev, queueThreshold: Number.parseInt(e.target.value) || 25 }))}
							/>
							<p className="text-xs text-fg-muted">Pause hunting when queue exceeds</p>
						</div>
					</div>
					<div className="grid grid-cols-2 gap-4">
						<div className="space-y-1">
							<label className="text-xs text-fg-muted">Re-search After (days)</label>
							<Input
								type="number"
								min={0}
								max={MAX_RESEARCH_AFTER_DAYS}
								value={formState.researchAfterDays ?? DEFAULT_RESEARCH_AFTER_DAYS}
								onChange={(e) => setFormState(prev => ({ ...prev, researchAfterDays: Number.parseInt(e.target.value) || DEFAULT_RESEARCH_AFTER_DAYS }))}
							/>
							<p className="text-xs text-fg-muted">Skip items searched within this period (0 = never re-search)</p>
						</div>
					</div>
				</div>

				{/* Filters */}
				<HuntingFilters
					config={config}
					formState={formState}
					onChange={(updates) => setFormState(prev => ({ ...prev, ...updates }))}
				/>

				{/* Actions */}
				<div className="flex justify-between items-center gap-2 pt-4">
					<div className="flex gap-2">
						{formState.huntMissingEnabled && (
							<Button
								variant="secondary"
								size="sm"
								onClick={() => void handleRunNow("missing")}
								disabled={isTriggering}
							>
								{isTriggering ? (
									<RotateCcw className="h-4 w-4 mr-2 animate-spin" />
								) : (
									<Zap className="h-4 w-4 mr-2" />
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
							>
								{isTriggering ? (
									<RotateCcw className="h-4 w-4 mr-2 animate-spin" />
								) : (
									<Zap className="h-4 w-4 mr-2" />
								)}
								Run Upgrade Hunt
							</Button>
						)}
					</div>
					<Button
						variant="primary"
						onClick={() => void handleSave()}
						disabled={isUpdating || !hasChanges}
					>
						{isUpdating ? (
							<RotateCcw className="h-4 w-4 mr-2 animate-spin" />
						) : (
							<Save className="h-4 w-4 mr-2" />
						)}
						Save Changes
					</Button>
				</div>
			</CardContent>
		</Card>
	);
};

interface UnconfiguredInstanceCardProps {
	instanceId: string;
	instanceName: string;
	service: string;
	onConfigure: () => void;
}

const UnconfiguredInstanceCard = ({ instanceId, instanceName, service, onConfigure }: UnconfiguredInstanceCardProps) => {
	const { createConfig, isCreating } = useUpdateHuntConfig();

	const handleConfigure = async () => {
		await createConfig(instanceId);
		onConfigure();
	};

	return (
		<div className="rounded-xl border border-dashed border-border p-4 flex items-center justify-between">
			<div className="flex items-center gap-2">
				<span className="font-medium text-fg">{instanceName}</span>
				<Badge variant={service === "sonarr" ? "info" : "warning"}>
					{service}
				</Badge>
			</div>
			<Button
				variant="secondary"
				size="sm"
				onClick={() => void handleConfigure()}
				disabled={isCreating}
			>
				{isCreating ? (
					<RotateCcw className="h-4 w-4 mr-2 animate-spin" />
				) : (
					<Settings className="h-4 w-4 mr-2" />
				)}
				Configure
			</Button>
		</div>
	);
};
