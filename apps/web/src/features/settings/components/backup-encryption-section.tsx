"use client";

import { useState } from "react";
import {
	Key,
	CheckCircle2,
	AlertTriangle,
	Loader2,
	Shield,
	AlertCircle,
} from "lucide-react";
import { Button, Input, toast } from "../../../components/ui";
import { PremiumSection, GlassmorphicCard } from "../../../components/layout";
import { SEMANTIC_COLORS } from "../../../lib/theme-gradients";
import { useThemeGradient } from "../../../hooks/useThemeGradient";
import {
	useBackupPasswordStatus,
	useSetBackupPassword,
	useRemoveBackupPassword,
} from "../../../hooks/api/useBackup";

export const BackupEncryptionSection = () => {
	const { gradient: themeGradient } = useThemeGradient();

	const [showPasswordForm, setShowPasswordForm] = useState(false);
	const [newPassword, setNewPassword] = useState("");
	const [confirmPassword, setConfirmPassword] = useState("");

	const { data: passwordStatus, isLoading: passwordStatusLoading } = useBackupPasswordStatus();
	const setPasswordMutation = useSetBackupPassword();
	const removePasswordMutation = useRemoveBackupPassword();

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
			setNewPassword("");
			setConfirmPassword("");
			setShowPasswordForm(false);
			toast.success("Backup password updated successfully");
		} catch (error: unknown) {
			const errorMessage = error instanceof Error ? error.message : "Unknown error";
			toast.error(`Failed to set password: ${errorMessage}`);
		}
	};

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

	return (
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
	);
};
