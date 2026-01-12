"use client";

import { useState, useEffect } from "react";
import {
	Download,
	Upload,
	Trash2,
	FileText,
	Clock,
	Key,
	CheckCircle2,
	AlertTriangle,
	Archive,
	Loader2,
	Shield,
	AlertCircle,
} from "lucide-react";
import { Button, Input, NativeSelect, SelectOption, toast } from "../../../components/ui";
import {
	PremiumSection,
	PremiumEmptyState,
	GlassmorphicCard,
	PremiumTable,
	PremiumTableHeader,
	PremiumTableRow,
	StatusBadge,
} from "../../../components/layout";
import { SEMANTIC_COLORS } from "../../../lib/theme-gradients";
import { useThemeGradient } from "../../../hooks/useThemeGradient";
import {
	useCreateBackup,
	useRestoreBackup,
	useBackups,
	useDeleteBackup,
	useRestoreBackupFromFile,
	useBackupSettings,
	useUpdateBackupSettings,
	useReadBackupFile,
	useDownloadBackup,
	useBackupPasswordStatus,
	useSetBackupPassword,
	useRemoveBackupPassword,
} from "../../../hooks/api/useBackup";
import type { BackupFileInfo, BackupIntervalType } from "@arr/shared";

/**
 * Premium Backup Tab
 *
 * Comprehensive backup management with:
 * - Password encryption configuration
 * - Scheduled backup settings
 * - Manual backup creation
 * - Backup restore from file or list
 * - Premium glassmorphic styling
 */
export const BackupTab = () => {
	const { gradient: themeGradient } = useThemeGradient();

	// Create backup state
	const [createSuccess, setCreateSuccess] = useState(false);

	// Restore backup state
	const [restoreFile, setRestoreFile] = useState<File | null>(null);
	const [restoreSuccess, setRestoreSuccess] = useState(false);
	const [showRestoreWarning, setShowRestoreWarning] = useState(false);
	const [isRestarting, setIsRestarting] = useState(false);

	// Backups list state
	const [selectedBackupForRestore, setSelectedBackupForRestore] = useState<BackupFileInfo | null>(null);
	const [showBackupRestoreModal, setShowBackupRestoreModal] = useState(false);

	// Backup settings state
	const [intervalType, setIntervalType] = useState<BackupIntervalType>("DISABLED");
	const [intervalValue, setIntervalValue] = useState<number>(24);
	const [retentionCount, setRetentionCount] = useState<number>(7);
	const [includeTrashBackups, setIncludeTrashBackups] = useState<boolean>(false);
	const [settingsSuccess, setSettingsSuccess] = useState(false);

	// Password configuration state
	const [showPasswordForm, setShowPasswordForm] = useState(false);
	const [newPassword, setNewPassword] = useState("");
	const [confirmPassword, setConfirmPassword] = useState("");
	const [passwordSuccess, setPasswordSuccess] = useState(false);

	// Queries and mutations
	const { data: backupsData, isLoading: backupsLoading, error: backupsError } = useBackups();
	const { data: settings, isLoading: settingsLoading } = useBackupSettings();
	const createBackupMutation = useCreateBackup();
	const restoreBackupMutation = useRestoreBackup();
	const deleteBackupMutation = useDeleteBackup();
	const restoreBackupFromFileMutation = useRestoreBackupFromFile();
	const updateSettingsMutation = useUpdateBackupSettings();
	const readBackupFileMutation = useReadBackupFile();
	const downloadBackupMutation = useDownloadBackup();
	const { data: passwordStatus, isLoading: passwordStatusLoading } = useBackupPasswordStatus();
	const setPasswordMutation = useSetBackupPassword();
	const removePasswordMutation = useRemoveBackupPassword();

	// Initialize settings state when data loads
	useEffect(() => {
		if (settings && !settingsLoading) {
			setIntervalType(settings.intervalType);
			setIntervalValue(settings.intervalValue);
			setRetentionCount(settings.retentionCount);
			setIncludeTrashBackups(settings.includeTrashBackups);
		}
	}, [settings, settingsLoading]);

	// Handle create backup
	const handleCreateBackup = async () => {
		setCreateSuccess(false);
		try {
			await createBackupMutation.mutateAsync({});
			setCreateSuccess(true);
			setTimeout(() => setCreateSuccess(false), 5000);
		} catch (error: unknown) {
			const message = error instanceof Error ? error.message : "Unknown error";
			toast.error(`Failed to create backup: ${message}`);
		}
	};

	// Handle restore backup
	const handleRestoreBackup = async (e: React.FormEvent) => {
		e.preventDefault();
		if (!restoreFile) {
			toast.error("Please select a backup file");
			return;
		}
		try {
			const backupData = await readBackupFileMutation.mutateAsync(restoreFile);
			const response = await restoreBackupMutation.mutateAsync({ backupData });
			setRestoreSuccess(true);
			setRestoreFile(null);
			setShowRestoreWarning(false);

			const willAutoRestart = response.message.includes("restart automatically");
			if (willAutoRestart) {
				setIsRestarting(true);
				pollForServerRestart();
			} else {
				toast.success(`Backup restored from ${new Date(response.metadata.timestamp).toLocaleString()}`);
			}
		} catch (error: unknown) {
			const errorMessage = error instanceof Error ? error.message : "Unknown error";
			toast.error(`Failed to restore backup: ${errorMessage}`);
		}
	};

	// Poll for server restart
	const pollForServerRestart = () => {
		const maxAttempts = 30;
		let attempts = 0;

		const checkServer = async (): Promise<void> => {
			attempts++;
			try {
				const healthResponse = await fetch("/auth/setup-required");
				if (healthResponse.ok) {
					window.location.href = "/login";
					return;
				}
			} catch {
				// Server not ready yet
			}
			if (attempts < maxAttempts) {
				setTimeout(checkServer, 1000);
			} else {
				window.location.href = "/login";
			}
		};

		setTimeout(checkServer, 2000);
	};

	// Handle download backup from list
	const handleDownloadBackup = async (backup: BackupFileInfo) => {
		try {
			await downloadBackupMutation.mutateAsync({ id: backup.id, filename: backup.filename });
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : "Unknown error";
			toast.error("Failed to download backup", { description: errorMessage });
		}
	};

	// Handle delete backup from list
	const handleDeleteBackup = async (backup: BackupFileInfo) => {
		if (!confirm(`Are you sure you want to delete this backup?\n\n${backup.filename}\n\nThis action cannot be undone.`)) {
			return;
		}
		try {
			await deleteBackupMutation.mutateAsync(backup.id);
		} catch (error: unknown) {
			const message = error instanceof Error ? error.message : "Unknown error";
			toast.error(`Failed to delete backup: ${message}`);
		}
	};

	// Handle save settings
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

	// Handle restore click from list
	const handleRestoreBackupClick = (backup: BackupFileInfo) => {
		setSelectedBackupForRestore(backup);
		setShowBackupRestoreModal(true);
	};

	// Handle restore submit from list
	const handleRestoreBackupSubmit = async () => {
		if (!selectedBackupForRestore) return;
		try {
			const response = await restoreBackupFromFileMutation.mutateAsync({
				id: selectedBackupForRestore.id,
			});

			const willAutoRestart = response.message.includes("restart automatically");
			setShowBackupRestoreModal(false);
			setSelectedBackupForRestore(null);

			if (willAutoRestart) {
				setIsRestarting(true);
				pollForServerRestart();
			} else {
				toast.success(`Backup restored from ${new Date(response.metadata.timestamp).toLocaleString()}`);
			}
		} catch (error: unknown) {
			const errorMessage = error instanceof Error ? error.message : "Unknown error";
			toast.error(`Failed to restore backup: ${errorMessage}`);
		}
	};

	// Handle set password
	const handleSetPassword = async (e: React.FormEvent) => {
		e.preventDefault();
		if (newPassword.length < 8) {
			toast.error("Password must be at least 8 characters");
			return;
		}
		if (newPassword !== confirmPassword) {
			toast.error("Passwords do not match");
			return;
		}
		try {
			await setPasswordMutation.mutateAsync({ password: newPassword });
			setPasswordSuccess(true);
			setNewPassword("");
			setConfirmPassword("");
			setShowPasswordForm(false);
			toast.success("Backup password updated successfully");
			setTimeout(() => setPasswordSuccess(false), 3000);
		} catch (error: unknown) {
			const errorMessage = error instanceof Error ? error.message : "Unknown error";
			toast.error(`Failed to set password: ${errorMessage}`);
		}
	};

	// Handle remove password
	const handleRemovePassword = async () => {
		if (!confirm("Are you sure you want to remove the backup password from the database?\n\nIf you have the BACKUP_PASSWORD environment variable set, backups will use that instead.")) {
			return;
		}
		try {
			await removePasswordMutation.mutateAsync();
			toast.success("Backup password removed from database");
		} catch (error: unknown) {
			const errorMessage = error instanceof Error ? error.message : "Unknown error";
			toast.error(`Failed to remove password: ${errorMessage}`);
		}
	};

	// Utility functions
	const formatBytes = (bytes: number) => {
		if (bytes === 0) return "0 B";
		const k = 1024;
		const sizes = ["B", "KB", "MB", "GB"];
		const i = Math.floor(Math.log(bytes) / Math.log(k));
		return `${Math.round((bytes / Math.pow(k, i)) * 100) / 100} ${sizes[i]}`;
	};

	const formatDate = (dateString: string) => {
		return new Date(dateString).toLocaleString();
	};

	const getTypeStatus = (type: string): "success" | "info" | "warning" | "default" => {
		switch (type) {
			case "manual": return "info";
			case "scheduled": return "success";
			case "update": return "warning";
			default: return "default";
		}
	};

	const backups = backupsData?.backups || [];

	return (
		<div className="space-y-8">
			{/* Backup Encryption Password Section */}
			<PremiumSection
				title="Backup Encryption"
				description="Configure the password used to encrypt and decrypt backups"
				icon={Key}
			>
				<div className="space-y-4">
					{/* Password Status */}
					{passwordStatusLoading ? (
						<div className="flex items-center gap-2 text-muted-foreground">
							<Loader2 className="h-4 w-4 animate-spin" />
							<span>Checking password configuration...</span>
						</div>
					) : passwordStatus?.configured ? (
						<div
							className="flex items-center gap-3 p-4 rounded-xl"
							style={{
								backgroundColor: SEMANTIC_COLORS.success.bg,
								border: `1px solid ${SEMANTIC_COLORS.success.border}`,
							}}
						>
							<CheckCircle2 className="h-5 w-5 shrink-0" style={{ color: SEMANTIC_COLORS.success.text }} />
							<div className="flex-1">
								<p className="text-sm font-medium" style={{ color: SEMANTIC_COLORS.success.text }}>
									Password Configured
								</p>
								<p className="text-xs text-muted-foreground">
									{passwordStatus.source === "database"
										? "Password is stored securely in the database."
										: "Password is set via BACKUP_PASSWORD environment variable."}
								</p>
							</div>
							{passwordStatus.source === "database" && (
								<Button
									variant="secondary"
									size="sm"
									onClick={handleRemovePassword}
									disabled={removePasswordMutation.isPending}
									className="border-border/50 bg-card/50"
								>
									{removePasswordMutation.isPending ? "Removing..." : "Remove"}
								</Button>
							)}
						</div>
					) : (
						<div
							className="flex items-center gap-3 p-4 rounded-xl"
							style={{
								backgroundColor: SEMANTIC_COLORS.warning.bg,
								border: `1px solid ${SEMANTIC_COLORS.warning.border}`,
							}}
						>
							<AlertTriangle className="h-5 w-5 shrink-0" style={{ color: SEMANTIC_COLORS.warning.text }} />
							<div className="flex-1">
								<p className="text-sm font-medium" style={{ color: SEMANTIC_COLORS.warning.text }}>
									No Password Configured
								</p>
								<p className="text-xs text-muted-foreground">
									Set a backup password to enable encrypted backups.
								</p>
							</div>
						</div>
					)}

					{/* Password Form */}
					{!showPasswordForm ? (
						<Button
							variant="secondary"
							onClick={() => setShowPasswordForm(true)}
							className="gap-2 border-border/50 bg-card/50"
						>
							<Shield className="h-4 w-4" />
							{passwordStatus?.configured ? "Change Password" : "Set Password"}
						</Button>
					) : (
						<GlassmorphicCard padding="md">
							<form onSubmit={handleSetPassword} className="space-y-4">
								<div className="space-y-2">
									<label className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
										New Password
									</label>
									<Input
										type="password"
										value={newPassword}
										onChange={(e) => setNewPassword(e.target.value)}
										placeholder="Enter new password (min 8 characters)"
										disabled={setPasswordMutation.isPending}
										minLength={8}
										className="bg-card/30 border-border/50"
									/>
								</div>

								<div className="space-y-2">
									<label className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
										Confirm Password
									</label>
									<Input
										type="password"
										value={confirmPassword}
										onChange={(e) => setConfirmPassword(e.target.value)}
										placeholder="Confirm new password"
										disabled={setPasswordMutation.isPending}
										className="bg-card/30 border-border/50"
									/>
								</div>

								<div className="flex gap-2">
									<Button
										type="submit"
										disabled={setPasswordMutation.isPending || newPassword.length < 8 || newPassword !== confirmPassword}
										className="gap-2"
										style={{
											background: `linear-gradient(135deg, ${themeGradient.from}, ${themeGradient.to})`,
										}}
									>
										{setPasswordMutation.isPending ? (
											<>
												<Loader2 className="h-4 w-4 animate-spin" />
												Saving...
											</>
										) : (
											"Save Password"
										)}
									</Button>
									<Button
										type="button"
										variant="secondary"
										onClick={() => {
											setShowPasswordForm(false);
											setNewPassword("");
											setConfirmPassword("");
										}}
										disabled={setPasswordMutation.isPending}
									>
										Cancel
									</Button>
								</div>
							</form>
						</GlassmorphicCard>
					)}

					{/* Important notice */}
					<div
						className="flex items-start gap-2 p-3 rounded-lg text-sm"
						style={{
							backgroundColor: SEMANTIC_COLORS.info.bg,
							border: `1px solid ${SEMANTIC_COLORS.info.border}`,
							color: SEMANTIC_COLORS.info.text,
						}}
					>
						<AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
						<p>
							<strong>Important:</strong> Remember this password! You will need it to restore backups.
						</p>
					</div>
				</div>
			</PremiumSection>

			{/* Scheduled Backups Settings */}
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

			{/* Create & Restore Backup Grid */}
			<div className="grid gap-6 lg:grid-cols-2">
				{/* Create Backup */}
				<GlassmorphicCard padding="lg">
					<div className="space-y-4">
						<div className="flex items-center gap-2">
							<div
								className="flex h-10 w-10 items-center justify-center rounded-xl"
								style={{
									background: `linear-gradient(135deg, ${themeGradient.from}20, ${themeGradient.to}20)`,
									border: `1px solid ${themeGradient.from}30`,
								}}
							>
								<Download className="h-5 w-5" style={{ color: themeGradient.from }} />
							</div>
							<div>
								<h3 className="font-semibold text-foreground">Create Backup</h3>
								<p className="text-xs text-muted-foreground">Create a manual backup now</p>
							</div>
						</div>

						<Button
							onClick={handleCreateBackup}
							disabled={createBackupMutation.isPending}
							className="w-full gap-2"
							style={{
								background: `linear-gradient(135deg, ${themeGradient.from}, ${themeGradient.to})`,
							}}
						>
							{createBackupMutation.isPending ? (
								<>
									<Loader2 className="h-4 w-4 animate-spin" />
									Creating...
								</>
							) : (
								<>
									<Download className="h-4 w-4" />
									Create Backup
								</>
							)}
						</Button>

						{createSuccess && (
							<div
								className="flex items-center gap-2 p-3 rounded-lg text-sm"
								style={{
									backgroundColor: SEMANTIC_COLORS.success.bg,
									border: `1px solid ${SEMANTIC_COLORS.success.border}`,
									color: SEMANTIC_COLORS.success.text,
								}}
							>
								<CheckCircle2 className="h-4 w-4" />
								Backup created successfully!
							</div>
						)}
					</div>
				</GlassmorphicCard>

				{/* Restore Backup */}
				<GlassmorphicCard padding="lg">
					<div className="space-y-4">
						<div className="flex items-center gap-2">
							<div
								className="flex h-10 w-10 items-center justify-center rounded-xl"
								style={{
									background: `linear-gradient(135deg, ${SEMANTIC_COLORS.warning.from}20, ${SEMANTIC_COLORS.warning.to}20)`,
									border: `1px solid ${SEMANTIC_COLORS.warning.border}`,
								}}
							>
								<Upload className="h-5 w-5" style={{ color: SEMANTIC_COLORS.warning.text }} />
							</div>
							<div>
								<h3 className="font-semibold text-foreground">Restore from File</h3>
								<p className="text-xs text-muted-foreground">Upload a backup file to restore</p>
							</div>
						</div>

						{!showRestoreWarning ? (
							<Button
								variant="secondary"
								onClick={() => setShowRestoreWarning(true)}
								className="w-full gap-2 border-border/50 bg-card/50"
							>
								<Upload className="h-4 w-4" />
								Restore from Backup
							</Button>
						) : (
							<form onSubmit={handleRestoreBackup} className="space-y-4">
								<div
									className="p-3 rounded-lg text-sm"
									style={{
										backgroundColor: SEMANTIC_COLORS.error.bg,
										border: `1px solid ${SEMANTIC_COLORS.error.border}`,
										color: SEMANTIC_COLORS.error.text,
									}}
								>
									<p className="font-medium mb-1">Warning: Destructive Operation</p>
									<p className="text-xs">This will replace all current data with the backup contents.</p>
								</div>

								<div className="space-y-2">
									<Input
										type="file"
										accept=".json"
										onChange={(e) => setRestoreFile(e.target.files?.[0] || null)}
										disabled={restoreBackupMutation.isPending}
										className="bg-card/30 border-border/50"
									/>
									{restoreFile && (
										<p className="text-xs text-muted-foreground">Selected: {restoreFile.name}</p>
									)}
								</div>

								<div className="flex gap-2">
									<Button
										type="submit"
										variant="danger"
										disabled={!restoreFile || restoreBackupMutation.isPending}
										className="flex-1 gap-2"
									>
										{restoreBackupMutation.isPending ? (
											<>
												<Loader2 className="h-4 w-4 animate-spin" />
												Restoring...
											</>
										) : (
											"Restore"
										)}
									</Button>
									<Button
										type="button"
										variant="secondary"
										onClick={() => {
											setShowRestoreWarning(false);
											setRestoreFile(null);
										}}
										disabled={restoreBackupMutation.isPending}
									>
										Cancel
									</Button>
								</div>
							</form>
						)}
					</div>
				</GlassmorphicCard>
			</div>

			{/* Available Backups List */}
			<PremiumSection
				title="Available Backups"
				description={`${backups.length} backup${backups.length !== 1 ? "s" : ""} stored on the system`}
				icon={Archive}
			>
				{backupsLoading ? (
					<div className="flex items-center justify-center py-12">
						<Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
					</div>
				) : backupsError ? (
					<div
						className="flex items-center gap-2 p-3 rounded-lg text-sm"
						style={{
							backgroundColor: SEMANTIC_COLORS.error.bg,
							border: `1px solid ${SEMANTIC_COLORS.error.border}`,
							color: SEMANTIC_COLORS.error.text,
						}}
					>
						<AlertCircle className="h-4 w-4" />
						Failed to load backups: {backupsError.message}
					</div>
				) : backups.length === 0 ? (
					<PremiumEmptyState
						icon={FileText}
						title="No backups found"
						description="Create a backup above to get started"
					/>
				) : (
					<PremiumTable>
						<PremiumTableHeader>
							<tr>
								<th className="py-3 px-4 text-left text-xs font-medium uppercase tracking-wider text-muted-foreground">Type</th>
								<th className="py-3 px-4 text-left text-xs font-medium uppercase tracking-wider text-muted-foreground">Filename</th>
								<th className="py-3 px-4 text-left text-xs font-medium uppercase tracking-wider text-muted-foreground">Date</th>
								<th className="py-3 px-4 text-left text-xs font-medium uppercase tracking-wider text-muted-foreground">Size</th>
								<th className="py-3 px-4 text-right text-xs font-medium uppercase tracking-wider text-muted-foreground">Actions</th>
							</tr>
						</PremiumTableHeader>
						<tbody>
							{backups.map((backup) => (
								<PremiumTableRow key={backup.id}>
									<td className="py-3 px-4">
										<StatusBadge status={getTypeStatus(backup.type)}>
											{backup.type.charAt(0).toUpperCase() + backup.type.slice(1)}
										</StatusBadge>
									</td>
									<td className="py-3 px-4">
										<span className="text-sm text-muted-foreground">{backup.filename}</span>
									</td>
									<td className="py-3 px-4">
										<span className="text-sm text-muted-foreground">{formatDate(backup.timestamp)}</span>
									</td>
									<td className="py-3 px-4">
										<span className="text-sm text-muted-foreground">{formatBytes(backup.size)}</span>
									</td>
									<td className="py-3 px-4">
										<div className="flex items-center justify-end gap-2">
											<Button
												variant="secondary"
												size="sm"
												onClick={() => handleDownloadBackup(backup)}
												className="gap-1 border-border/50 bg-card/50"
											>
												<Download className="h-3.5 w-3.5" />
												<span className="hidden sm:inline">Download</span>
											</Button>
											<Button
												variant="secondary"
												size="sm"
												onClick={() => handleRestoreBackupClick(backup)}
												className="gap-1 border-border/50 bg-card/50"
											>
												<Upload className="h-3.5 w-3.5" />
												<span className="hidden sm:inline">Restore</span>
											</Button>
											<Button
												variant="danger"
												size="sm"
												onClick={() => handleDeleteBackup(backup)}
												disabled={deleteBackupMutation.isPending}
												className="gap-1"
											>
												<Trash2 className="h-3.5 w-3.5" />
												<span className="hidden sm:inline">Delete</span>
											</Button>
										</div>
									</td>
								</PremiumTableRow>
							))}
						</tbody>
					</PremiumTable>
				)}
			</PremiumSection>

			{/* Restore Backup Modal */}
			{showBackupRestoreModal && selectedBackupForRestore && (
				<div
					className="fixed inset-0 z-modal flex items-center justify-center bg-black/80 backdrop-blur-sm"
					role="dialog"
					aria-modal="true"
					aria-labelledby="restore-backup-title"
				>
					<GlassmorphicCard padding="lg" className="w-full max-w-md m-4">
						<div className="space-y-4">
							<h3 id="restore-backup-title" className="text-lg font-semibold text-foreground">Restore Backup</h3>

							<div
								className="p-3 rounded-lg text-sm"
								style={{
									backgroundColor: SEMANTIC_COLORS.error.bg,
									border: `1px solid ${SEMANTIC_COLORS.error.border}`,
									color: SEMANTIC_COLORS.error.text,
								}}
							>
								<p className="font-medium mb-1">Warning: Destructive Operation</p>
								<p className="text-xs">
									Restoring this backup will replace all current data. Any changes made after this backup was created will be lost.
								</p>
							</div>

							<div className="space-y-2">
								<p className="text-sm text-muted-foreground">{selectedBackupForRestore.filename}</p>
								<p className="text-xs text-muted-foreground">
									Created: {formatDate(selectedBackupForRestore.timestamp)}
								</p>
							</div>

							<div className="flex gap-2">
								<Button
									onClick={handleRestoreBackupSubmit}
									variant="danger"
									disabled={restoreBackupFromFileMutation.isPending}
									className="flex-1 gap-2"
								>
									{restoreBackupFromFileMutation.isPending ? (
										<>
											<Loader2 className="h-4 w-4 animate-spin" />
											Restoring...
										</>
									) : (
										"Restore Backup"
									)}
								</Button>
								<Button
									type="button"
									variant="secondary"
									onClick={() => {
										setShowBackupRestoreModal(false);
										setSelectedBackupForRestore(null);
									}}
									disabled={restoreBackupFromFileMutation.isPending}
								>
									Cancel
								</Button>
							</div>
						</div>
					</GlassmorphicCard>
				</div>
			)}

			{/* Server Restarting Modal */}
			{isRestarting && (
				<div
					className="fixed inset-0 z-modal flex items-center justify-center bg-black/80 backdrop-blur-sm"
					role="dialog"
					aria-modal="true"
					aria-labelledby="server-restarting-title"
				>
					<GlassmorphicCard padding="lg" className="w-full max-w-md m-4">
						<div className="flex flex-col items-center text-center space-y-4 py-4">
							<div
								className="animate-spin rounded-full h-12 w-12 border-b-2"
								style={{ borderColor: themeGradient.from }}
							/>
							<div>
								<h3 id="server-restarting-title" className="text-lg font-semibold mb-2 text-foreground">Server Restarting</h3>
								<p className="text-sm text-muted-foreground">
									Backup restored successfully. The server is restarting...
								</p>
								<p className="text-sm text-muted-foreground mt-2">
									You will be redirected to login automatically.
								</p>
							</div>
						</div>
					</GlassmorphicCard>
				</div>
			)}
		</div>
	);
};
