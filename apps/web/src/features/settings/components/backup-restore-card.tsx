"use client";

import { useState } from "react";
import { Upload, Loader2 } from "lucide-react";
import { Button, Input, toast } from "../../../components/ui";
import { GlassmorphicCard } from "../../../components/layout";
import { SEMANTIC_COLORS } from "../../../lib/theme-gradients";
import { useRestoreBackup, useReadBackupFile } from "../../../hooks/api/useBackup";
import { getErrorMessage } from "../../../lib/error-utils";

interface BackupRestoreCardProps {
	onRestoreComplete: (willRestart: boolean) => void;
}

export const BackupRestoreCard = ({ onRestoreComplete }: BackupRestoreCardProps) => {
	const [restoreFile, setRestoreFile] = useState<File | null>(null);
	const [showRestoreWarning, setShowRestoreWarning] = useState(false);

	const restoreBackupMutation = useRestoreBackup();
	const readBackupFileMutation = useReadBackupFile();

	const handleRestoreBackup = async (e: React.FormEvent) => {
		e.preventDefault();
		if (!restoreFile) {
			toast.error("Please select a backup file");
			return;
		}
		try {
			const backupData = await readBackupFileMutation.mutateAsync(restoreFile);
			const response = await restoreBackupMutation.mutateAsync({ backupData });
			setRestoreFile(null);
			setShowRestoreWarning(false);

			const willAutoRestart = response.message.includes("restart automatically");
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
	);
};
