"use client";

import { useState } from "react";
import { Download, CheckCircle2, Loader2 } from "lucide-react";
import { Button, toast } from "../../../components/ui";
import { GlassmorphicCard } from "../../../components/layout";
import { SEMANTIC_COLORS } from "../../../lib/theme-gradients";
import { useThemeGradient } from "../../../hooks/useThemeGradient";
import { useCreateBackup } from "../../../hooks/api/useBackup";
import { getErrorMessage } from "../../../lib/error-utils";

export const BackupCreateCard = () => {
	const { gradient: themeGradient } = useThemeGradient();

	const [createSuccess, setCreateSuccess] = useState(false);
	const createBackupMutation = useCreateBackup();

	const handleCreateBackup = async () => {
		setCreateSuccess(false);
		try {
			await createBackupMutation.mutateAsync({});
			setCreateSuccess(true);
			setTimeout(() => setCreateSuccess(false), 5000);
		} catch (error: unknown) {
			const message = getErrorMessage(error, "Unknown error");
			toast.error(`Failed to create backup: ${message}`);
		}
	};

	return (
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
	);
};
