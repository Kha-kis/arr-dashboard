"use client";

import { useState } from "react";
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
import { Settings, Save, RotateCcw, Play, Pause } from "lucide-react";
import { useHuntingConfigs, useUpdateHuntConfig, useToggleScheduler } from "../hooks/useHuntingConfig";
import type { HuntConfigWithInstance } from "../lib/hunting-types";

export const HuntingConfig = () => {
	const { configs, instances, isLoading, error, refetch } = useHuntingConfigs();
	const { toggleScheduler, isToggling } = useToggleScheduler();

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
			<div className="mb-6 p-4 rounded-xl border border-border bg-bg-subtle/50">
				<div className="flex items-center justify-between">
					<div>
						<h3 className="font-medium text-fg">Global Scheduler</h3>
						<p className="text-sm text-fg-muted">
							Enable or disable automated hunting across all instances
						</p>
					</div>
					<Button
						variant="secondary"
						onClick={() => void toggleScheduler()}
						disabled={isToggling}
					>
						{isToggling ? (
							<RotateCcw className="h-4 w-4 mr-2 animate-spin" />
						) : (
							<Play className="h-4 w-4 mr-2" />
						)}
						Toggle Scheduler
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
	const [formState, setFormState] = useState({
		huntMissingEnabled: config.huntMissingEnabled,
		huntUpgradesEnabled: config.huntUpgradesEnabled,
		missingBatchSize: config.missingBatchSize,
		missingIntervalMins: config.missingIntervalMins,
		upgradeBatchSize: config.upgradeBatchSize,
		upgradeIntervalMins: config.upgradeIntervalMins,
		hourlyApiCap: config.hourlyApiCap,
		queueThreshold: config.queueThreshold,
	});

	const { updateConfig, isUpdating, error } = useUpdateHuntConfig();

	const handleSave = async () => {
		await updateConfig(config.instanceId, formState);
		onSaved();
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
							checked={formState.huntMissingEnabled}
							onCheckedChange={(checked) => setFormState(prev => ({ ...prev, huntMissingEnabled: checked }))}
						/>
					</div>

					{formState.huntMissingEnabled && (
						<div className="grid grid-cols-2 gap-4 pl-4 border-l-2 border-border">
							<div className="space-y-1">
								<label className="text-xs text-fg-muted">Batch Size</label>
								<Input
									type="number"
									min={1}
									max={50}
									value={formState.missingBatchSize}
									onChange={(e) => setFormState(prev => ({ ...prev, missingBatchSize: Number.parseInt(e.target.value) || 5 }))}
								/>
							</div>
							<div className="space-y-1">
								<label className="text-xs text-fg-muted">Interval (minutes)</label>
								<Input
									type="number"
									min={15}
									max={1440}
									value={formState.missingIntervalMins}
									onChange={(e) => setFormState(prev => ({ ...prev, missingIntervalMins: Number.parseInt(e.target.value) || 60 }))}
								/>
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
							checked={formState.huntUpgradesEnabled}
							onCheckedChange={(checked) => setFormState(prev => ({ ...prev, huntUpgradesEnabled: checked }))}
						/>
					</div>

					{formState.huntUpgradesEnabled && (
						<div className="grid grid-cols-2 gap-4 pl-4 border-l-2 border-border">
							<div className="space-y-1">
								<label className="text-xs text-fg-muted">Batch Size</label>
								<Input
									type="number"
									min={1}
									max={50}
									value={formState.upgradeBatchSize}
									onChange={(e) => setFormState(prev => ({ ...prev, upgradeBatchSize: Number.parseInt(e.target.value) || 3 }))}
								/>
							</div>
							<div className="space-y-1">
								<label className="text-xs text-fg-muted">Interval (minutes)</label>
								<Input
									type="number"
									min={15}
									max={1440}
									value={formState.upgradeIntervalMins}
									onChange={(e) => setFormState(prev => ({ ...prev, upgradeIntervalMins: Number.parseInt(e.target.value) || 120 }))}
								/>
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
								min={10}
								max={500}
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
								max={100}
								value={formState.queueThreshold}
								onChange={(e) => setFormState(prev => ({ ...prev, queueThreshold: Number.parseInt(e.target.value) || 25 }))}
							/>
							<p className="text-xs text-fg-muted">Pause hunting when queue exceeds</p>
						</div>
					</div>
				</div>

				{/* Actions */}
				<div className="flex justify-end gap-2 pt-4">
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
