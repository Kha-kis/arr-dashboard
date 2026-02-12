"use client";

import { useState } from "react";
import {
	Download,
	Upload,
	Trash2,
	FileText,
	Archive,
	Loader2,
	AlertCircle,
} from "lucide-react";
import { Button, toast } from "../../../components/ui";
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
import {
	useBackups,
	useDeleteBackup,
	useRestoreBackupFromFile,
	useDownloadBackup,
} from "../../../hooks/api/useBackup";
import type { BackupFileInfo } from "@arr/shared";
import { formatBytes } from "../../../lib/format-utils";
import { getErrorMessage } from "../../../lib/error-utils";

interface BackupListSectionProps {
	onRestoreComplete: (willRestart: boolean) => void;
}

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

export const BackupListSection = ({ onRestoreComplete }: BackupListSectionProps) => {
	const [selectedBackupForRestore, setSelectedBackupForRestore] = useState<BackupFileInfo | null>(null);
	const [showBackupRestoreModal, setShowBackupRestoreModal] = useState(false);

	const { data: backupsData, isLoading: backupsLoading, error: backupsError } = useBackups();
	const deleteBackupMutation = useDeleteBackup();
	const restoreBackupFromFileMutation = useRestoreBackupFromFile();
	const downloadBackupMutation = useDownloadBackup();

	const backups = backupsData?.backups || [];

	const handleDownloadBackup = async (backup: BackupFileInfo) => {
		try {
			await downloadBackupMutation.mutateAsync({ id: backup.id, filename: backup.filename });
		} catch (error) {
			const errorMessage = getErrorMessage(error, "Unknown error");
			toast.error("Failed to download backup", { description: errorMessage });
		}
	};

	const handleDeleteBackup = async (backup: BackupFileInfo) => {
		if (!confirm(`Are you sure you want to delete this backup?\n\n${backup.filename}\n\nThis action cannot be undone.`)) {
			return;
		}
		try {
			await deleteBackupMutation.mutateAsync(backup.id);
		} catch (error: unknown) {
			const message = getErrorMessage(error, "Unknown error");
			toast.error(`Failed to delete backup: ${message}`);
		}
	};

	const handleRestoreBackupClick = (backup: BackupFileInfo) => {
		setSelectedBackupForRestore(backup);
		setShowBackupRestoreModal(true);
	};

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
				onRestoreComplete(true);
			} else {
				toast.success(`Backup restored from ${new Date(response.metadata.timestamp).toLocaleString()}`);
				onRestoreComplete(false);
			}
		} catch (error: unknown) {
			const errorMessage = getErrorMessage(error, "Unknown error");
			toast.error(`Failed to restore backup: ${errorMessage}`);
		}
	};

	return (
		<>
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
					className="fixed inset-0 z-modal flex items-center justify-center bg-black/80 backdrop-blur-xs"
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
		</>
	);
};
