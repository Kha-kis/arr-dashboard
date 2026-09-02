"use client";

import type { BackupFileInfo } from "@arr/shared";
import { AlertCircle, Archive, Download, FileText, Loader2, Trash2 } from "lucide-react";
import {
	PremiumEmptyState,
	PremiumSection,
	PremiumTable,
	PremiumTableHeader,
	PremiumTableRow,
	StatusBadge,
} from "../../../components/layout";
import { Button, toast } from "../../../components/ui";
import { useBackups, useDeleteBackup, useDownloadBackup } from "../../../hooks/api/useBackup";
import { getErrorMessage } from "../../../lib/error-utils";
import { formatBytes } from "../../../lib/format-utils";
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

export const BackupListSection = () => {
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
			description={`${backups.length} backup${backups.length !== 1 ? "s" : ""} stored on the system; restore is temporarily unavailable`}
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
							<th className="py-3 px-4 text-left text-xs font-medium uppercase tracking-wider text-muted-foreground">
								Type
							</th>
							<th className="py-3 px-4 text-left text-xs font-medium uppercase tracking-wider text-muted-foreground">
								Filename
							</th>
							<th className="py-3 px-4 text-left text-xs font-medium uppercase tracking-wider text-muted-foreground">
								Date
							</th>
							<th className="py-3 px-4 text-left text-xs font-medium uppercase tracking-wider text-muted-foreground">
								Size
							</th>
							<th className="py-3 px-4 text-right text-xs font-medium uppercase tracking-wider text-muted-foreground">
								Actions
							</th>
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
									<span className="text-sm text-muted-foreground">
										{formatDate(backup.timestamp)}
									</span>
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
	);
};
