"use client";

import { useState, useEffect } from "react";
import { Download, Upload, Trash2, FileText, Clock } from "lucide-react";
import { Button } from "../../../components/ui/button";
import { Input } from "../../../components/ui/input";
import { Select, SelectOption } from "../../../components/ui/select";
import {
	Card,
	CardContent,
	CardHeader,
	CardTitle,
	CardDescription,
} from "../../../components/ui/card";
import { Alert, AlertDescription, toast } from "../../../components/ui";
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
} from "../../../hooks/api/useBackup";
import type { BackupFileInfo, BackupIntervalType } from "@arr/shared";

export const BackupTab = () => {
	// Create backup state
	const [createSuccess, setCreateSuccess] = useState(false);

	// Restore backup state
	const [restoreFile, setRestoreFile] = useState<File | null>(null);
	const [restoreSuccess, setRestoreSuccess] = useState(false);
	const [showRestoreWarning, setShowRestoreWarning] = useState(false);

	// Backups list state
	const [selectedBackupForRestore, setSelectedBackupForRestore] = useState<BackupFileInfo | null>(null);
	const [showBackupRestoreModal, setShowBackupRestoreModal] = useState(false);

	// Backup settings state
	const [intervalType, setIntervalType] = useState<BackupIntervalType>("DISABLED");
	const [intervalValue, setIntervalValue] = useState<number>(24);
	const [retentionCount, setRetentionCount] = useState<number>(7);
	const [settingsSuccess, setSettingsSuccess] = useState(false);

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

	// Initialize settings state when data loads
	useEffect(() => {
		if (settings && !settingsLoading) {
			setIntervalType(settings.intervalType);
			setIntervalValue(settings.intervalValue);
			setRetentionCount(settings.retentionCount);
		}
	}, [settings, settingsLoading]);

	// Handle create backup
	const handleCreateBackup = async () => {
		setCreateSuccess(false);

		try {
			await createBackupMutation.mutateAsync({});

			setCreateSuccess(true);

			// Reset success message after 5 seconds
			setTimeout(() => {
				setCreateSuccess(false);
			}, 5000);
		} catch (error: any) {
			alert(`Failed to create backup: ${error.message || "Unknown error"}`);
		}
	};

	// Handle restore backup
	const handleRestoreBackup = async (e: React.FormEvent) => {
		e.preventDefault();

		if (!restoreFile) {
			alert("Please select a backup file");
			return;
		}

		try {
			// Read the backup file
			const backupData = await readBackupFileMutation.mutateAsync(restoreFile);

			// Restore the backup
			const response = await restoreBackupMutation.mutateAsync({
				backupData,
			});

			setRestoreSuccess(true);
			setRestoreFile(null);
			setShowRestoreWarning(false);

			// Check if auto-restart will occur
			const willAutoRestart = response.message.includes("restart automatically");

			// Show success message
			alert(
				`Backup restored successfully!\n\nBackup from: ${new Date(response.metadata.timestamp).toLocaleString()}\n\n${response.message}${willAutoRestart ? "\n\nThe page will reload automatically once the server restarts." : ""}`,
			);

			// Only poll for restart if auto-restart is enabled
			if (willAutoRestart) {
				// Poll for server to come back up and reload page
				const checkServerInterval = setInterval(async () => {
					try {
						const healthResponse = await fetch("/api/health");
						if (healthResponse.ok) {
							clearInterval(checkServerInterval);
							window.location.href = "/login"; // Redirect to login after restart
						}
					} catch {
						// Server not ready yet, keep polling
					}
				}, 1000);

				// Stop polling after 30 seconds
				setTimeout(() => {
					clearInterval(checkServerInterval);
				}, 30000);
			}
		} catch (error: any) {
			alert(`Failed to restore backup: ${error.message || "Unknown error"}`);
		}
	};

	// Handle download backup from list
	const handleDownloadBackup = async (backup: BackupFileInfo) => {
		try {
			await downloadBackupMutation.mutateAsync({ id: backup.id, filename: backup.filename });
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : "Unknown error";
			console.error("Failed to download backup:", error);
			toast.error("Failed to download backup", {
				description: errorMessage,
			});
		}
	};

	// Handle delete backup from list
	const handleDeleteBackup = async (backup: BackupFileInfo) => {
		if (
			!confirm(
				`Are you sure you want to delete this backup?\n\n${backup.filename}\n\nThis action cannot be undone.`,
			)
		) {
			return;
		}

		try {
			await deleteBackupMutation.mutateAsync(backup.id);
		} catch (error: any) {
			alert(`Failed to delete backup: ${error.message || "Unknown error"}`);
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
			});

			setSettingsSuccess(true);

			// Reset success message after 3 seconds
			setTimeout(() => {
				setSettingsSuccess(false);
			}, 3000);
		} catch (error: any) {
			alert(`Failed to save settings: ${error.message || "Unknown error"}`);
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

			// Check if auto-restart will occur
			const willAutoRestart = response.message.includes("restart automatically");

			// Show success message
			alert(
				`Backup restored successfully!\n\nBackup from: ${new Date(response.metadata.timestamp).toLocaleString()}\n\n${response.message}${willAutoRestart ? "\n\nThe page will reload automatically once the server restarts." : ""}`,
			);

			// Close modal
			setShowBackupRestoreModal(false);
			setSelectedBackupForRestore(null);

			// Only poll for restart if auto-restart is enabled
			if (willAutoRestart) {
				// Poll for server to come back up and reload page
				const checkServerInterval = setInterval(async () => {
					try {
						const healthResponse = await fetch("/api/health");
						if (healthResponse.ok) {
							clearInterval(checkServerInterval);
							window.location.href = "/login"; // Redirect to login after restart
						}
					} catch {
						// Server not ready yet, keep polling
					}
				}, 1000);

				// Stop polling after 30 seconds
				setTimeout(() => {
					clearInterval(checkServerInterval);
				}, 30000);
			}
		} catch (error: any) {
			alert(`Failed to restore backup: ${error.message || "Unknown error"}`);
		}
	};

	// Utility functions for backups list
	const formatBytes = (bytes: number) => {
		if (bytes === 0) return "0 Bytes";
		const k = 1024;
		const sizes = ["Bytes", "KB", "MB", "GB"];
		const i = Math.floor(Math.log(bytes) / Math.log(k));
		return `${Math.round((bytes / Math.pow(k, i)) * 100) / 100} ${sizes[i]}`;
	};

	const formatDate = (dateString: string) => {
		return new Date(dateString).toLocaleString();
	};

	const getTypeColor = (type: string) => {
		switch (type) {
			case "manual":
				return "text-sky-400";
			case "scheduled":
				return "text-emerald-400";
			case "update":
				return "text-purple-400";
			default:
				return "text-fg-muted";
		}
	};

	const getTypeLabel = (type: string) => {
		return type.charAt(0).toUpperCase() + type.slice(1);
	};

	const backups = backupsData?.backups || [];

	return (
		<div className="space-y-6">
			{/* Scheduled Backups Settings Section */}
			<Card>
				<CardHeader>
					<div className="flex items-center gap-2">
						<Clock className="h-5 w-5 text-sky-400" />
						<CardTitle>Scheduled Backups</CardTitle>
					</div>
					<CardDescription>
						Configure automatic backups on a schedule. Scheduled backups will be saved to the backups/scheduled folder.
					</CardDescription>
				</CardHeader>
				<CardContent>
					<div className="space-y-4">
						<div className="space-y-2">
							<label className="text-xs uppercase text-fg-muted">Backup Interval</label>
							<Select
								value={intervalType}
								onChange={(e) => setIntervalType(e.target.value as BackupIntervalType)}
								disabled={settingsLoading || updateSettingsMutation.isPending}
							>
								<SelectOption value="DISABLED">Disabled (Manual Only)</SelectOption>
								<SelectOption value="HOURLY">Every X Hours</SelectOption>
								<SelectOption value="DAILY">Every X Days</SelectOption>
								<SelectOption value="WEEKLY">Weekly</SelectOption>
							</Select>
						</div>

						{intervalType === "HOURLY" && (
							<div className="space-y-2">
								<label className="text-xs uppercase text-fg-muted">Hours Between Backups</label>
								<Input
									type="number"
									min={1}
									max={168}
									value={intervalValue}
									onChange={(e) => setIntervalValue(Number.parseInt(e.target.value))}
									disabled={settingsLoading || updateSettingsMutation.isPending}
								/>
								<p className="text-xs text-fg-muted">Run a backup every {intervalValue} hour{intervalValue !== 1 ? "s" : ""}</p>
							</div>
						)}

						{intervalType === "DAILY" && (
							<div className="space-y-2">
								<label className="text-xs uppercase text-fg-muted">Days Between Backups</label>
								<Input
									type="number"
									min={1}
									max={7}
									value={intervalValue}
									onChange={(e) => setIntervalValue(Number.parseInt(e.target.value))}
									disabled={settingsLoading || updateSettingsMutation.isPending}
								/>
								<p className="text-xs text-fg-muted">Run a backup every {intervalValue} day{intervalValue !== 1 ? "s" : ""}</p>
							</div>
						)}

						{intervalType !== "DISABLED" && (
							<div className="space-y-2">
								<label className="text-xs uppercase text-fg-muted">Retention Count</label>
								<Input
									type="number"
									min={1}
									max={100}
									value={retentionCount}
									onChange={(e) => setRetentionCount(Number.parseInt(e.target.value))}
									disabled={settingsLoading || updateSettingsMutation.isPending}
								/>
								<p className="text-xs text-fg-muted">Keep the {retentionCount} most recent scheduled backup{retentionCount !== 1 ? "s" : ""}</p>
							</div>
						)}

						<div className="flex gap-2">
							<Button
								onClick={handleSaveSettings}
								disabled={settingsLoading || updateSettingsMutation.isPending}
							>
								{updateSettingsMutation.isPending ? "Saving..." : "Save Settings"}
							</Button>
						</div>

						{settingsSuccess && (
							<Alert variant="success">
								<AlertDescription>Settings saved successfully!</AlertDescription>
							</Alert>
						)}

						{updateSettingsMutation.isError && (
							<Alert variant="danger">
								<AlertDescription>
									{updateSettingsMutation.error?.message || "Failed to save settings"}
								</AlertDescription>
							</Alert>
						)}

						{settings?.nextRunAt && intervalType !== "DISABLED" && (
							<Alert>
								<AlertDescription>
									Next scheduled backup: {new Date(settings.nextRunAt).toLocaleString()}
								</AlertDescription>
							</Alert>
						)}
					</div>
				</CardContent>
			</Card>

			{/* Create Backup Section */}
			<Card>
				<CardHeader>
					<div className="flex items-center gap-2">
						<Download className="h-5 w-5 text-sky-400" />
						<CardTitle>Create Backup</CardTitle>
					</div>
					<CardDescription>
						Create a backup of your database and configuration. The backup will be saved to the backups folder and appear in the list below.
					</CardDescription>
				</CardHeader>
				<CardContent>
					<div className="space-y-4">
						<Button
							onClick={handleCreateBackup}
							disabled={createBackupMutation.isPending}
						>
							{createBackupMutation.isPending ? "Creating Backup..." : "Create Backup"}
						</Button>

						{createSuccess && (
							<Alert variant="success">
								<AlertDescription>Backup created successfully! You can download it from the list below.</AlertDescription>
							</Alert>
						)}

						{createBackupMutation.isError && (
							<Alert variant="danger">
								<AlertDescription>
									{createBackupMutation.error?.message || "Failed to create backup"}
								</AlertDescription>
							</Alert>
						)}

						<Alert variant="warning">
							<AlertDescription>
								<strong>Important:</strong> Store your backup file securely. The backup contains all your service API keys and configuration in unencrypted JSON format. Protect access to the backup file through filesystem permissions.
							</AlertDescription>
						</Alert>
					</div>
				</CardContent>
			</Card>

			{/* Restore Backup Section */}
			<Card>
				<CardHeader>
					<div className="flex items-center gap-2">
						<Upload className="h-5 w-5 text-sky-400" />
						<CardTitle>Restore Backup</CardTitle>
					</div>
					<CardDescription>
						Restore your database and configuration from a backup file. This will replace all current data.
					</CardDescription>
				</CardHeader>
				<CardContent>
					{!showRestoreWarning ? (
						<Button
							variant="secondary"
							onClick={() => setShowRestoreWarning(true)}
						>
							Restore from Backup
						</Button>
					) : (
						<>
							<Alert variant="danger" className="mb-4">
								<AlertDescription>
									<p className="font-medium mb-2">Warning: Destructive Operation</p>
									<p className="mb-2">
										Restoring a backup will <strong>permanently delete</strong> all current data,
										including:
									</p>
									<ul className="list-inside list-disc space-y-1 text-xs mb-2">
										<li>All service instances and their settings</li>
										<li>Tags and organization</li>
										<li>User accounts and authentication methods</li>
										<li>All encrypted API keys and secrets</li>
									</ul>
									<p>
										This action <strong>cannot be undone</strong>. Make sure you have a current backup
										before proceeding.
									</p>
								</AlertDescription>
							</Alert>

							<form onSubmit={handleRestoreBackup} className="space-y-4">
								<div className="space-y-2">
									<label className="text-xs uppercase text-fg-muted">Backup File</label>
									<Input
										type="file"
										accept=".json"
										onChange={(e) => setRestoreFile(e.target.files?.[0] || null)}
										disabled={restoreBackupMutation.isPending}
									/>
									{restoreFile && (
										<p className="text-xs text-fg-muted">Selected: {restoreFile.name}</p>
									)}
								</div>

								<div className="flex gap-2">
									<Button
										type="submit"
										variant="danger"
										disabled={!restoreFile || restoreBackupMutation.isPending}
									>
										{restoreBackupMutation.isPending ? "Restoring..." : "Restore Backup"}
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

								{restoreBackupMutation.isError && (
									<Alert variant="danger">
										<AlertDescription>
											{restoreBackupMutation.error?.message || "Failed to restore backup"}
										</AlertDescription>
									</Alert>
								)}
							</form>
						</>
					)}
				</CardContent>
			</Card>

			{/* Available Backups List Section */}
			<Card>
				<CardHeader>
					<div className="flex items-center gap-2">
						<FileText className="h-5 w-5 text-sky-400" />
						<CardTitle>Available Backups</CardTitle>
					</div>
					<CardDescription>
						{backups.length} backup{backups.length !== 1 ? "s" : ""} stored on the system
					</CardDescription>
				</CardHeader>
				<CardContent>
					{backupsLoading ? (
						<div className="flex items-center justify-center py-12">
							<p className="text-fg-muted">Loading backups...</p>
						</div>
					) : backupsError ? (
						<Alert variant="danger">
							<AlertDescription>Failed to load backups: {backupsError.message}</AlertDescription>
						</Alert>
					) : backups.length === 0 ? (
						<div className="flex flex-col items-center justify-center py-12 text-center">
							<FileText className="h-16 w-16 text-fg-muted/40 mb-4" />
							<p className="text-fg-muted mb-2">No backups found</p>
							<p className="text-sm text-fg-muted">
								Create a backup above to get started
							</p>
						</div>
					) : (
						<div className="overflow-x-auto">
							<table className="w-full">
								<thead>
									<tr className="border-b border-border">
										<th className="text-left py-3 px-4 text-xs font-medium uppercase text-fg-muted">
											Type
										</th>
										<th className="text-left py-3 px-4 text-xs font-medium uppercase text-fg-muted">
											Filename
										</th>
										<th className="text-left py-3 px-4 text-xs font-medium uppercase text-fg-muted">
											Date
										</th>
										<th className="text-left py-3 px-4 text-xs font-medium uppercase text-fg-muted">
											Size
										</th>
										<th className="text-right py-3 px-4 text-xs font-medium uppercase text-fg-muted">
											Actions
										</th>
									</tr>
								</thead>
								<tbody>
									{backups.map((backup) => (
										<tr
											key={backup.id}
											className="border-b border-border/50 hover:bg-bg-subtle transition-colors"
										>
											<td className="py-3 px-4">
												<span className={`text-sm font-medium ${getTypeColor(backup.type)}`}>
													{getTypeLabel(backup.type)}
												</span>
											</td>
											<td className="py-3 px-4">
												<span className="text-sm text-fg-muted">{backup.filename}</span>
											</td>
											<td className="py-3 px-4">
												<span className="text-sm text-fg-muted">
													{formatDate(backup.timestamp)}
												</span>
											</td>
											<td className="py-3 px-4">
												<span className="text-sm text-fg-muted">{formatBytes(backup.size)}</span>
											</td>
											<td className="py-3 px-4">
												<div className="flex items-center justify-end gap-2">
													<Button
														variant="secondary"
														size="sm"
														onClick={() => handleDownloadBackup(backup)}
													>
														<Download className="h-4 w-4 mr-1" />
														Download
													</Button>
													<Button
														variant="secondary"
														size="sm"
														onClick={() => handleRestoreBackupClick(backup)}
													>
														<Upload className="h-4 w-4 mr-1" />
														Restore
													</Button>
													<Button
														variant="secondary"
														size="sm"
														onClick={() => handleDeleteBackup(backup)}
														disabled={deleteBackupMutation.isPending}
													>
														<Trash2 className="h-4 w-4 mr-1" />
														Delete
													</Button>
												</div>
											</td>
										</tr>
									))}
								</tbody>
							</table>
						</div>
					)}
				</CardContent>
			</Card>

			{/* Restore Backup from List Modal */}
			{showBackupRestoreModal && selectedBackupForRestore && (
				<div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80">
					<Card className="w-full max-w-md">
						<CardHeader>
							<CardTitle>Restore Backup</CardTitle>
							<CardDescription>Confirm restore operation</CardDescription>
						</CardHeader>
						<CardContent>
							<Alert variant="danger" className="mb-4">
								<AlertDescription>
									<p className="font-medium mb-2">Warning: Destructive Operation</p>
									<p className="text-sm">
										Restoring this backup will <strong>permanently delete</strong> all current
										data. This action cannot be undone.
									</p>
								</AlertDescription>
							</Alert>

							<div className="space-y-4">
								<div className="space-y-2">
									<label className="text-sm font-medium text-fg-muted">Backup File</label>
									<p className="text-sm text-fg-muted">{selectedBackupForRestore.filename}</p>
									<p className="text-xs text-fg-muted">
										Created: {formatDate(selectedBackupForRestore.timestamp)}
									</p>
								</div>

								<div className="flex gap-2">
									<Button
										onClick={handleRestoreBackupSubmit}
										variant="danger"
										disabled={restoreBackupFromFileMutation.isPending}
										className="flex-1"
									>
										{restoreBackupFromFileMutation.isPending ? "Restoring..." : "Restore Backup"}
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

								{restoreBackupFromFileMutation.isError && (
									<Alert variant="danger">
										<AlertDescription>
											{restoreBackupFromFileMutation.error?.message || "Failed to restore backup"}
										</AlertDescription>
									</Alert>
								)}
							</div>
						</CardContent>
					</Card>
				</div>
			)}
		</div>
	);
};
