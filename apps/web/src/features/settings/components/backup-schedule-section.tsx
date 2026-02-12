"use client";

import { useState, useEffect } from "react";
import { Clock, CheckCircle2, Loader2 } from "lucide-react";
import { Button, Input, NativeSelect, SelectOption, toast } from "../../../components/ui";
import { PremiumSection } from "../../../components/layout";
import { SEMANTIC_COLORS } from "../../../lib/theme-gradients";
import { useThemeGradient } from "../../../hooks/useThemeGradient";
import { useBackupSettings, useUpdateBackupSettings } from "../../../hooks/api/useBackup";
import type { BackupIntervalType } from "@arr/shared";

export const BackupScheduleSection = () => {
	const { gradient: themeGradient } = useThemeGradient();

	const [intervalType, setIntervalType] = useState<BackupIntervalType>("DISABLED");
	const [intervalValue, setIntervalValue] = useState<number>(24);
	const [retentionCount, setRetentionCount] = useState<number>(7);
	const [includeTrashBackups, setIncludeTrashBackups] = useState<boolean>(false);
	const [settingsSuccess, setSettingsSuccess] = useState(false);

	const { data: settings, isLoading: settingsLoading } = useBackupSettings();
	const updateSettingsMutation = useUpdateBackupSettings();

	useEffect(() => {
		if (settings && !settingsLoading) {
			setIntervalType(settings.intervalType);
			setIntervalValue(settings.intervalValue);
			setRetentionCount(settings.retentionCount);
			setIncludeTrashBackups(settings.includeTrashBackups);
		}
	}, [settings, settingsLoading]);

	const handleSaveSettings = async () => {
		setSettingsSuccess(false);
		try {
			await updateSettingsMutation.mutateAsync({
				enabled: intervalType !== "DISABLED",
				intervalType,
				intervalValue,
				retentionCount,
				includeTrashBackups,
			});
			setSettingsSuccess(true);
			setTimeout(() => setSettingsSuccess(false), 3000);
		} catch (error: unknown) {
			const message = error instanceof Error ? error.message : "Unknown error";
			toast.error(`Failed to save settings: ${message}`);
		}
	};

	return (
		<PremiumSection
			title="Scheduled Backups"
			description="Configure automatic backups on a schedule"
			icon={Clock}
		>
			<div className="space-y-4">
				<div className="space-y-2">
					<label className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
						Backup Interval
					</label>
					<NativeSelect
						value={intervalType}
						onChange={(e) => setIntervalType(e.target.value as BackupIntervalType)}
						disabled={settingsLoading || updateSettingsMutation.isPending}
						className="bg-card/30 border-border/50"
					>
						<SelectOption value="DISABLED">Disabled (Manual Only)</SelectOption>
						<SelectOption value="HOURLY">Every X Hours</SelectOption>
						<SelectOption value="DAILY">Every X Days</SelectOption>
						<SelectOption value="WEEKLY">Weekly</SelectOption>
					</NativeSelect>
				</div>

				{intervalType === "HOURLY" && (
					<div className="space-y-2">
						<label className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
							Hours Between Backups
						</label>
						<Input
							type="number"
							min={1}
							max={168}
							value={intervalValue}
							onChange={(e) => setIntervalValue(Number.parseInt(e.target.value))}
							disabled={settingsLoading || updateSettingsMutation.isPending}
							className="bg-card/30 border-border/50"
						/>
						<p className="text-xs text-muted-foreground">
							Run a backup every {intervalValue} hour{intervalValue !== 1 ? "s" : ""}
						</p>
					</div>
				)}

				{intervalType === "DAILY" && (
					<div className="space-y-2">
						<label className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
							Days Between Backups
						</label>
						<Input
							type="number"
							min={1}
							max={7}
							value={intervalValue}
							onChange={(e) => setIntervalValue(Number.parseInt(e.target.value))}
							disabled={settingsLoading || updateSettingsMutation.isPending}
							className="bg-card/30 border-border/50"
						/>
						<p className="text-xs text-muted-foreground">
							Run a backup every {intervalValue} day{intervalValue !== 1 ? "s" : ""}
						</p>
					</div>
				)}

				{intervalType !== "DISABLED" && (
					<div className="space-y-2">
						<label className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
							Retention Count
						</label>
						<Input
							type="number"
							min={1}
							max={100}
							value={retentionCount}
							onChange={(e) => setRetentionCount(Number.parseInt(e.target.value))}
							disabled={settingsLoading || updateSettingsMutation.isPending}
							className="bg-card/30 border-border/50"
						/>
						<p className="text-xs text-muted-foreground">
							Keep the {retentionCount} most recent scheduled backup{retentionCount !== 1 ? "s" : ""}
						</p>
					</div>
				)}

				{/* Include TRaSH Backups checkbox */}
				<div className="flex items-start gap-3 p-4 rounded-xl border border-border/50 bg-card/20">
					<input
						type="checkbox"
						id="includeTrashBackups"
						checked={includeTrashBackups}
						onChange={(e) => setIncludeTrashBackups(e.target.checked)}
						disabled={settingsLoading || updateSettingsMutation.isPending}
						className="h-4 w-4 rounded mt-0.5"
						style={{ accentColor: themeGradient.from }}
					/>
					<div>
						<label htmlFor="includeTrashBackups" className="text-sm font-medium text-foreground cursor-pointer">
							Include TRaSH Guides instance backups
						</label>
						<p className="text-xs text-muted-foreground mt-1">
							When enabled, backups will include ARR config snapshots from the last 7 days.
						</p>
					</div>
				</div>

				<div className="flex gap-2">
					<Button
						onClick={handleSaveSettings}
						disabled={settingsLoading || updateSettingsMutation.isPending}
						className="gap-2"
						style={{
							background: `linear-gradient(135deg, ${themeGradient.from}, ${themeGradient.to})`,
						}}
					>
						{updateSettingsMutation.isPending ? (
							<>
								<Loader2 className="h-4 w-4 animate-spin" />
								Saving...
							</>
						) : (
							"Save Settings"
						)}
					</Button>
				</div>

				{settingsSuccess && (
					<div
						className="flex items-center gap-2 p-3 rounded-lg text-sm"
						style={{
							backgroundColor: SEMANTIC_COLORS.success.bg,
							border: `1px solid ${SEMANTIC_COLORS.success.border}`,
							color: SEMANTIC_COLORS.success.text,
						}}
					>
						<CheckCircle2 className="h-4 w-4" />
						Settings saved successfully!
					</div>
				)}

				{settings?.nextRunAt && intervalType !== "DISABLED" && (
					<div
						className="flex items-center gap-2 p-3 rounded-lg text-sm"
						style={{
							backgroundColor: themeGradient.fromLight,
							border: `1px solid ${themeGradient.fromMuted}`,
							color: themeGradient.from,
						}}
					>
						<Clock className="h-4 w-4" />
						Next scheduled backup: {new Date(settings.nextRunAt).toLocaleString()}
					</div>
				)}
			</div>
		</PremiumSection>
	);
};
