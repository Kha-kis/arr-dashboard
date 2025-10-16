"use client";

import { useState, useEffect } from "react";
import { Card, CardHeader, CardTitle, CardContent, Button, Badge, Input } from "../../../components/ui";

interface InstanceSyncSettingsProps {
	instanceId: string;
	instanceLabel: string;
	instanceService: string;
	trashFormatCount: number;
	currentSettings: {
		enabled: boolean;
		intervalType: "DISABLED" | "HOURLY" | "DAILY" | "WEEKLY";
		intervalValue: number;
		syncFormats: boolean;
		syncCFGroups: boolean;
		syncQualityProfiles: boolean;
		lastRunAt: string | null;
		lastRunStatus: "SUCCESS" | "FAILED" | "PARTIAL" | null;
		lastErrorMessage: string | null;
		formatsSynced: number;
		formatsFailed: number;
		cfGroupsSynced: number;
		qualityProfilesSynced: number;
		nextRunAt: string | null;
	};
	onSave: (
		enabled: boolean,
		intervalType: "DISABLED" | "HOURLY" | "DAILY" | "WEEKLY",
		intervalValue: number,
		syncFormats: boolean,
		syncCFGroups: boolean,
		syncQualityProfiles: boolean
	) => Promise<void>;
	isSaving: boolean;
}

export const InstanceSyncSettings = ({
	instanceId,
	instanceLabel,
	instanceService,
	trashFormatCount,
	currentSettings,
	onSave,
	isSaving,
}: InstanceSyncSettingsProps) => {
	const [enabled, setEnabled] = useState(currentSettings.enabled);
	const [intervalType, setIntervalType] = useState<"DISABLED" | "HOURLY" | "DAILY" | "WEEKLY">(
		currentSettings.intervalType
	);
	const [intervalValue, setIntervalValue] = useState(currentSettings.intervalValue);
	const [syncFormats, setSyncFormats] = useState(currentSettings.syncFormats);
	const [syncCFGroups, setSyncCFGroups] = useState(currentSettings.syncCFGroups);
	const [syncQualityProfiles, setSyncQualityProfiles] = useState(currentSettings.syncQualityProfiles);
	const [hasChanges, setHasChanges] = useState(false);

	// Update local state when currentSettings change
	useEffect(() => {
		setEnabled(currentSettings.enabled);
		setIntervalType(currentSettings.intervalType);
		setIntervalValue(currentSettings.intervalValue);
		setSyncFormats(currentSettings.syncFormats);
		setSyncCFGroups(currentSettings.syncCFGroups);
		setSyncQualityProfiles(currentSettings.syncQualityProfiles);
		setHasChanges(false);
	}, [currentSettings]);

	// Track changes
	useEffect(() => {
		const changed =
			enabled !== currentSettings.enabled ||
			intervalType !== currentSettings.intervalType ||
			intervalValue !== currentSettings.intervalValue ||
			syncFormats !== currentSettings.syncFormats ||
			syncCFGroups !== currentSettings.syncCFGroups ||
			syncQualityProfiles !== currentSettings.syncQualityProfiles;
		setHasChanges(changed);
	}, [enabled, intervalType, intervalValue, syncFormats, syncCFGroups, syncQualityProfiles, currentSettings]);

	const handleSave = async () => {
		await onSave(enabled, enabled ? intervalType : "DISABLED", intervalValue, syncFormats, syncCFGroups, syncQualityProfiles);
		setHasChanges(false);
	};

	const maxInterval = intervalType === "HOURLY" ? 24 : intervalType === "DAILY" ? 7 : 4;

	return (
		<Card>
			<CardHeader>
				<div className="flex items-center justify-between">
					<div className="flex items-center gap-3">
						<CardTitle className="text-base">{instanceLabel}</CardTitle>
						<Badge variant="secondary" className="text-xs">
							{instanceService}
						</Badge>
						{trashFormatCount > 0 && (
							<Badge variant="success" className="text-xs">
								{trashFormatCount} TRaSH
							</Badge>
						)}
					</div>
					{enabled && intervalType !== "DISABLED" && (
						<Badge variant="info" className="text-xs">
							Auto-Sync Enabled
						</Badge>
					)}
				</div>
			</CardHeader>
			<CardContent className="space-y-4">
				{/* Enable toggle */}
				<div className="flex items-center justify-between p-3 rounded-lg border border-border bg-bg-subtle/30">
					<div className="flex-1">
						<div className="font-medium text-sm text-fg">Enable Auto-Sync</div>
						<div className="text-xs text-fg-muted mt-1">
							Automatically sync TRaSH custom formats on a schedule
						</div>
					</div>
					<label className="relative inline-flex items-center cursor-pointer">
						<input
							type="checkbox"
							className="sr-only peer"
							checked={enabled}
							onChange={(e) => setEnabled(e.target.checked)}
							disabled={isSaving}
						/>
						<div className="w-11 h-6 bg-bg-muted rounded-full peer peer-checked:after:translate-x-full after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-success"></div>
					</label>
				</div>

				{/* Interval configuration */}
				{enabled && (
					<div className="space-y-3">
						<div>
							<label className="block text-sm font-medium text-fg mb-2">Sync Interval</label>
							<div className="grid grid-cols-2 gap-3">
								<select
									value={intervalType}
									onChange={(e) =>
										setIntervalType(e.target.value as "HOURLY" | "DAILY" | "WEEKLY")
									}
									disabled={isSaving}
									className="rounded-lg border border-border bg-bg px-3 py-2 text-sm text-fg focus:ring-2 focus:ring-primary focus:ring-offset-2"
								>
									<option value="HOURLY">Hourly</option>
									<option value="DAILY">Daily</option>
									<option value="WEEKLY">Weekly</option>
								</select>
								<Input
									type="number"
									min={1}
									max={maxInterval}
									value={intervalValue}
									onChange={(e) => setIntervalValue(Number(e.target.value))}
									disabled={isSaving}
									placeholder={
										intervalType === "HOURLY"
											? "Hours"
											: intervalType === "DAILY"
												? "Days"
												: "Weeks"
									}
								/>
							</div>
							<p className="text-xs text-fg-muted mt-1">
								{intervalType === "HOURLY" && `Sync every ${intervalValue} hour(s)`}
								{intervalType === "DAILY" && `Sync every ${intervalValue} day(s)`}
								{intervalType === "WEEKLY" && `Sync every ${intervalValue} week(s)`}
							</p>
						</div>

						{/* Sync Options */}
						<div>
							<label className="block text-sm font-medium text-fg mb-2">What to Sync</label>
							<div className="space-y-2">
								<label className="flex items-center gap-3 p-2 rounded-lg border border-border bg-bg-subtle/30 cursor-pointer hover:border-primary/50 transition-colors">
									<input
										type="checkbox"
										checked={syncFormats}
										onChange={(e) => setSyncFormats(e.target.checked)}
										disabled={isSaving}
										className="w-4 h-4 rounded border-border text-primary focus:ring-2 focus:ring-primary"
									/>
									<div className="flex-1">
										<div className="text-sm font-medium text-fg">Individual Custom Formats</div>
										<div className="text-xs text-fg-muted">Sync TRaSH-tracked custom formats</div>
									</div>
								</label>

								<label className="flex items-center gap-3 p-2 rounded-lg border border-border bg-bg-subtle/30 cursor-pointer hover:border-primary/50 transition-colors">
									<input
										type="checkbox"
										checked={syncCFGroups}
										onChange={(e) => setSyncCFGroups(e.target.checked)}
										disabled={isSaving}
										className="w-4 h-4 rounded border-border text-primary focus:ring-2 focus:ring-primary"
									/>
									<div className="flex-1">
										<div className="text-sm font-medium text-fg">CF Groups</div>
										<div className="text-xs text-fg-muted">Re-import all formats from tracked CF groups</div>
									</div>
								</label>

								<label className="flex items-center gap-3 p-2 rounded-lg border border-border bg-bg-subtle/30 cursor-pointer hover:border-primary/50 transition-colors">
									<input
										type="checkbox"
										checked={syncQualityProfiles}
										onChange={(e) => setSyncQualityProfiles(e.target.checked)}
										disabled={isSaving}
										className="w-4 h-4 rounded border-border text-primary focus:ring-2 focus:ring-primary"
									/>
									<div className="flex-1">
										<div className="text-sm font-medium text-fg">Quality Profiles</div>
										<div className="text-xs text-fg-muted">Update tracked quality profiles with latest config</div>
									</div>
								</label>
							</div>
						</div>

						{/* Status information */}
						{(currentSettings.lastRunAt || currentSettings.nextRunAt) && (
							<div className="p-3 rounded-lg border border-border bg-bg-subtle/30 space-y-3">
								<div className="flex items-center justify-between">
									<div className="text-xs font-medium text-fg">Sync Status</div>
									{currentSettings.lastRunStatus && (
										<Badge
											variant={
												currentSettings.lastRunStatus === "SUCCESS"
													? "success"
													: currentSettings.lastRunStatus === "FAILED"
													  ? "danger"
													  : "warning"
											}
											className="text-xs"
										>
											{currentSettings.lastRunStatus}
										</Badge>
									)}
								</div>

								<div className="grid grid-cols-2 gap-3 text-xs">
									<div>
										<span className="text-fg-muted">Last Run:</span>
										<div className="text-fg mt-0.5">
											{currentSettings.lastRunAt
												? new Date(currentSettings.lastRunAt).toLocaleString()
												: "Never"}
										</div>
									</div>
									<div>
										<span className="text-fg-muted">Next Run:</span>
										<div className="text-fg mt-0.5">
											{currentSettings.nextRunAt
												? new Date(currentSettings.nextRunAt).toLocaleString()
												: "Not scheduled"}
										</div>
									</div>
								</div>

								{/* Statistics */}
								{currentSettings.lastRunAt && (
									<div className="border-t border-border pt-2 space-y-1">
										<div className="text-xs font-medium text-fg mb-1">Last Run Statistics</div>
										<div className="grid grid-cols-2 gap-2 text-xs">
											<div className="flex justify-between">
												<span className="text-fg-muted">Formats Synced:</span>
												<span className="text-fg font-medium">{currentSettings.formatsSynced}</span>
											</div>
											<div className="flex justify-between">
												<span className="text-fg-muted">Formats Failed:</span>
												<span className={currentSettings.formatsFailed > 0 ? "text-danger font-medium" : "text-fg font-medium"}>
													{currentSettings.formatsFailed}
												</span>
											</div>
											<div className="flex justify-between">
												<span className="text-fg-muted">CF Groups:</span>
												<span className="text-fg font-medium">{currentSettings.cfGroupsSynced}</span>
											</div>
											<div className="flex justify-between">
												<span className="text-fg-muted">Quality Profiles:</span>
												<span className="text-fg font-medium">{currentSettings.qualityProfilesSynced}</span>
											</div>
										</div>
									</div>
								)}

								{/* Error message */}
								{currentSettings.lastErrorMessage && (
									<div className="border-t border-border pt-2">
										<div className="text-xs font-medium text-danger mb-1">Error</div>
										<div className="text-xs text-fg-muted bg-danger/10 p-2 rounded border border-danger/30">
											{currentSettings.lastErrorMessage}
										</div>
									</div>
								)}
							</div>
						)}
					</div>
				)}

				{/* Save button - only show if there are changes */}
				{hasChanges && (
					<div className="flex justify-end pt-2 border-t border-border">
						<Button onClick={handleSave} disabled={isSaving} size="sm">
							{isSaving ? "Saving..." : "Save Settings"}
						</Button>
					</div>
				)}

				{/* Message if no TRaSH formats */}
				{trashFormatCount === 0 && (
					<div className="p-3 rounded-lg border border-border bg-bg-subtle/30 text-center">
						<p className="text-sm text-fg-muted">
							No TRaSH-managed custom formats. Import formats from TRaSH Guides first.
						</p>
					</div>
				)}
			</CardContent>
		</Card>
	);
};
