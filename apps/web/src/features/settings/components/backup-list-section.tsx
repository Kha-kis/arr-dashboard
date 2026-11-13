"use client";

import type { BackupFileInfo } from "@arr/shared";
import { AlertCircle, Archive, Download, FileText, Loader2, RotateCcw, Trash2 } from "lucide-react";
import { PremiumEmptyState, PremiumSection, StatusBadge } from "../../../components/layout";
import { Button, toast } from "../../../components/ui";
import { useBackups, useDeleteBackup, useDownloadBackup } from "../../../hooks/api/useBackup";
import { getErrorMessage } from "../../../lib/error-utils";
import { formatBytes } from "../../../lib/format-utils";
import { useIncognitoMode } from "../../../lib/incognito";
import { SEMANTIC_COLORS } from "../../../lib/theme-gradients";

const formatDate = (dateString: string) => {
	return new Date(dateString).toLocaleString();
};

const getTypeStatus = (type: string): "success" | "info" | "warning" | "default" => {
	switch (type) {
		case "manual":
			return "info";
		case "scheduled":
			return "success";
		case "update":
			return "warning";
		default:
			return "default";
	}
};

export const BackupListSection = ({
	onRestore,
	disabled = false,
}: {
	onRestore?: (id: string) => void;
	disabled?: boolean;
}) => {
	const [incognito] = useIncognitoMode();
	const { data: backupsData, isLoading: backupsLoading, error: backupsError } = useBackups();
	const deleteBackupMutation = useDeleteBackup();
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
		if (
			!confirm(
				`Are you sure you want to delete this backup?\n\n${backup.filename}\n\nThis action cannot be undone.`,
			)
		) {
			return;
		}
		try {
			await deleteBackupMutation.mutateAsync(backup.id);
		} catch (error: unknown) {
			const message = getErrorMessage(error, "Unknown error");
			toast.error(`Failed to delete backup: ${message}`);
		}
	};

	return (
		<PremiumSection
			title="Available Backups"
			description={`${backups.length} backup${backups.length !== 1 ? "s" : ""} stored on the system. Select a backup below, then confirm in Restore backup.`}
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
					Failed to load backups. Check availability before selecting a stored backup.
				</div>
			) : backups.length === 0 ? (
				<PremiumEmptyState
					icon={FileText}
					title="No backups found"
					description="Create a backup above to get started"
				/>
			) : (
				<ul className="grid min-w-0 gap-3 xl:grid-cols-2" aria-label="Available backups">
					{backups.map((backup) => (
						<li
							key={backup.id}
							className="min-w-0 space-y-3 rounded-xl border border-border/50 bg-card/30 p-4"
						>
							<div className="flex flex-wrap items-center gap-2">
								<StatusBadge status={getTypeStatus(backup.type)}>
									{backup.type.charAt(0).toUpperCase() + backup.type.slice(1)}
								</StatusBadge>
							</div>
							<p className="break-all text-sm text-muted-foreground">
								{incognito ? "Encrypted backup" : backup.filename}
							</p>
							<div className="flex flex-wrap gap-3">
								<span className="text-sm text-muted-foreground">
									{formatDate(backup.timestamp)}
								</span>
								<span className="text-sm text-muted-foreground">{formatBytes(backup.size)}</span>
							</div>
							<div className="flex flex-wrap items-center gap-2">
								{onRestore ? (
									<Button
										type="button"
										variant="secondary"
										size="sm"
										disabled={disabled}
										aria-label="Select backup for restore"
										onClick={() => onRestore(backup.id)}
									>
										<RotateCcw className="h-3.5 w-3.5" />
										Select for restore
									</Button>
								) : null}
								<Button
									type="button"
									aria-label="Download backup"
									disabled={disabled || downloadBackupMutation.isPending}
									variant="secondary"
									size="sm"
									onClick={() => handleDownloadBackup(backup)}
									className="gap-1 border-border/50 bg-card/50"
								>
									<Download className="h-3.5 w-3.5" />
									<span>Download</span>
								</Button>
								<Button
									type="button"
									aria-label="Delete backup"
									variant="danger"
									size="sm"
									onClick={() => handleDeleteBackup(backup)}
									disabled={disabled || deleteBackupMutation.isPending}
									className="gap-1"
								>
									<Trash2 className="h-3.5 w-3.5" />
									<span>Delete</span>
								</Button>
							</div>
						</li>
					))}
				</ul>
			)}
		</PremiumSection>
	);
};
