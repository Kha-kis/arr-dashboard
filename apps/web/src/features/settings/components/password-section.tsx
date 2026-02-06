"use client";

import { useState } from "react";
import { Key, Lock, Shield, Trash2, AlertTriangle, Check, Loader2, X } from "lucide-react";
import { Button } from "../../../components/ui/button";
import { Input } from "../../../components/ui/input";
import { PasswordInput } from "../../../components/ui/password-input";
import { PremiumSection, GlassmorphicCard } from "../../../components/layout";
import { SEMANTIC_COLORS } from "../../../lib/theme-gradients";
import { useThemeGradient } from "../../../hooks/useThemeGradient";
import { useUpdateAccountMutation, useRemovePasswordMutation, useSetupRequired } from "../../../hooks/api/useAuth";
import { useOIDCProviders } from "../../../hooks/api/useOIDCProviders";
import { useQuery } from "@tanstack/react-query";
import { getPasskeyCredentials } from "../../../lib/api-client/auth";
import { validatePassword } from "../lib/settings-utils";
import type { CurrentUser } from "@arr/shared";

interface PasswordSectionProps {
	currentUser?: CurrentUser | null;
}

/**
 * Premium Password Section
 *
 * Password management with:
 * - Glassmorphic form containers
 * - Theme-aware input styling
 * - Premium status feedback
 * - Staggered animations
 */
export const PasswordSection = ({ currentUser }: PasswordSectionProps) => {
	const { gradient: themeGradient } = useThemeGradient();

	// Password change/add state
	const [currentPassword, setCurrentPassword] = useState("");
	const [newPassword, setNewPassword] = useState("");
	const [confirmPassword, setConfirmPassword] = useState("");
	const [updateResult, setUpdateResult] = useState<{ success: boolean; message: string } | null>(null);

	// Password removal state
	const [removePasswordValue, setRemovePasswordValue] = useState("");
	const [removePasswordError, setRemovePasswordError] = useState<string | null>(null);
	const [removePasswordSuccess, setRemovePasswordSuccess] = useState<string | null>(null);
	const [showRemovePassword, setShowRemovePassword] = useState(false);

	const updateAccountMutation = useUpdateAccountMutation();
	const removePasswordMutation = useRemovePasswordMutation();
	const { data: oidcProviderData } = useOIDCProviders();
	const { data: setupData } = useSetupRequired();
	const passwordPolicy = setupData?.passwordPolicy ?? "strict";
	const { data: passkeys = [] } = useQuery({
		queryKey: ["passkey-credentials"],
		queryFn: getPasskeyCredentials,
	});

	const hasOIDC = oidcProviderData?.provider != null && oidcProviderData.provider.enabled;
	const hasPasskeys = passkeys.length > 0;
	const hasAlternativeAuth = hasOIDC || hasPasskeys;

	const handlePasswordUpdate = async (e: React.FormEvent) => {
		e.preventDefault();
		setUpdateResult(null);

		if (newPassword || confirmPassword || currentPassword) {
			if (currentUser?.hasPassword && !currentPassword) {
				setUpdateResult({
					success: false,
					message: "Current password is required to change password",
				});
				return;
			}
			if (!newPassword) {
				setUpdateResult({
					success: false,
					message: "New password is required",
				});
				return;
			}
			if (newPassword !== confirmPassword) {
				setUpdateResult({
					success: false,
					message: "New passwords do not match",
				});
				return;
			}

			const passwordValidation = validatePassword(newPassword, passwordPolicy);
			if (!passwordValidation.valid) {
				setUpdateResult({
					success: false,
					message: passwordValidation.message ?? "Password validation failed",
				});
				return;
			}
		}

		const payload: Record<string, unknown> = {};
		if (newPassword) {
			payload.newPassword = newPassword;
			if (currentUser?.hasPassword && currentPassword) {
				payload.currentPassword = currentPassword;
			}
		}

		if (Object.keys(payload).length === 0) {
			setUpdateResult({
				success: false,
				message: "No changes to save",
			});
			return;
		}

		try {
			await updateAccountMutation.mutateAsync(payload);
			setUpdateResult({
				success: true,
				message: currentUser?.hasPassword ? "Password changed successfully" : "Password added successfully",
			});
			setCurrentPassword("");
			setNewPassword("");
			setConfirmPassword("");
		} catch (error: unknown) {
			setUpdateResult({
				success: false,
				message: error instanceof Error ? error.message : "Failed to update password",
			});
		}
	};

	const handleRemovePassword = async (e: React.FormEvent) => {
		e.preventDefault();
		setRemovePasswordError(null);
		setRemovePasswordSuccess(null);

		if (!removePasswordValue) {
			setRemovePasswordError("Please enter your current password");
			return;
		}

		try {
			const result = await removePasswordMutation.mutateAsync({
				currentPassword: removePasswordValue,
			});
			setRemovePasswordSuccess(result.message);
			setRemovePasswordValue("");
			setShowRemovePassword(false);
		} catch (error) {
			setRemovePasswordError(
				error instanceof Error ? error.message : "Failed to remove password"
			);
		}
	};

	return (
		<PremiumSection
			title="Password Authentication"
			description={
				currentUser?.hasPassword
					? "Manage your password or remove it if you have alternative authentication methods."
					: "Add a password for an additional login option."
			}
			icon={Lock}
		>
			<div className="space-y-6">
				{/* Add/Change Password Form */}
				<GlassmorphicCard padding="lg">
					<form onSubmit={handlePasswordUpdate} className="space-y-6">
						<div className="flex items-center gap-3">
							<div
								className="flex h-10 w-10 items-center justify-center rounded-xl shrink-0"
								style={{
									background: `linear-gradient(135deg, ${themeGradient.from}20, ${themeGradient.to}20)`,
									border: `1px solid ${themeGradient.from}30`,
								}}
							>
								<Key className="h-5 w-5" style={{ color: themeGradient.from }} />
							</div>
							<div>
								<h3 className="font-semibold text-foreground">
									{currentUser?.hasPassword ? "Change Password" : "Add Password"}
								</h3>
								{!currentUser?.hasPassword && (
									<p className="text-xs text-muted-foreground">
										Your account uses passwordless authentication. Add a password for additional options.
									</p>
								)}
							</div>
						</div>

						<div className="space-y-4">
							{currentUser?.hasPassword && (
								<div className="space-y-2">
									<label className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
										Current Password
									</label>
									<PasswordInput
										value={currentPassword}
										onChange={(e) => setCurrentPassword(e.target.value)}
										placeholder="Enter current password"
										className="bg-card/30 border-border/50"
									/>
								</div>
							)}

							<div className="space-y-2">
								<label className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
									{currentUser?.hasPassword ? "New Password" : "Password"}
								</label>
								<PasswordInput
									value={newPassword}
									onChange={(e) => setNewPassword(e.target.value)}
									placeholder="At least 8 characters"
									className="bg-card/30 border-border/50"
								/>
								<p className="text-xs text-muted-foreground">
									{passwordPolicy === "relaxed"
										? "At least 8 characters"
										: "Must include uppercase, lowercase, number, and special character"}
								</p>
							</div>

							<div className="space-y-2">
								<label className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
									{currentUser?.hasPassword ? "Confirm New Password" : "Confirm Password"}
								</label>
								<PasswordInput
									value={confirmPassword}
									onChange={(e) => setConfirmPassword(e.target.value)}
									placeholder={currentUser?.hasPassword ? "Re-enter new password" : "Re-enter password"}
									className="bg-card/30 border-border/50"
								/>
							</div>
						</div>

						<Button
							type="submit"
							disabled={updateAccountMutation.isPending}
							className="gap-2"
							style={{
								background: `linear-gradient(135deg, ${themeGradient.from}, ${themeGradient.to})`,
								boxShadow: `0 4px 12px -4px ${themeGradient.glow}`,
							}}
						>
							{updateAccountMutation.isPending ? (
								<>
									<Loader2 className="h-4 w-4 animate-spin" />
									Saving...
								</>
							) : (
								<>
									<Shield className="h-4 w-4" />
									{currentUser?.hasPassword ? "Change Password" : "Add Password"}
								</>
							)}
						</Button>

						{updateResult && (
							<div
								className="flex items-center gap-2 rounded-xl px-4 py-3 text-sm animate-in fade-in slide-in-from-bottom-2"
								style={{
									backgroundColor: updateResult.success ? SEMANTIC_COLORS.success.bg : SEMANTIC_COLORS.error.bg,
									border: `1px solid ${updateResult.success ? SEMANTIC_COLORS.success.border : SEMANTIC_COLORS.error.border}`,
									color: updateResult.success ? SEMANTIC_COLORS.success.text : SEMANTIC_COLORS.error.text,
								}}
							>
								{updateResult.success ? (
									<Check className="h-4 w-4 shrink-0" />
								) : (
									<X className="h-4 w-4 shrink-0" />
								)}
								<span>{updateResult.message}</span>
							</div>
						)}
					</form>
				</GlassmorphicCard>

				{/* Remove Password Section */}
				{currentUser?.hasPassword && (
					<GlassmorphicCard padding="lg">
						<div className="space-y-4">
							<div className="flex items-center gap-3">
								<div
									className="flex h-10 w-10 items-center justify-center rounded-xl shrink-0"
									style={{
										background: `linear-gradient(135deg, ${SEMANTIC_COLORS.error.from}20, ${SEMANTIC_COLORS.error.to}20)`,
										border: `1px solid ${SEMANTIC_COLORS.error.from}30`,
									}}
								>
									<Trash2 className="h-5 w-5" style={{ color: SEMANTIC_COLORS.error.from }} />
								</div>
								<div>
									<h3 className="font-semibold text-foreground">Remove Password</h3>
									<p className="text-xs text-muted-foreground">
										Remove your password and use only OIDC or passkeys to sign in.
									</p>
								</div>
							</div>

							{hasAlternativeAuth ? (
								<>
									<div
										className="rounded-xl p-3 text-sm"
										style={{
											backgroundColor: SEMANTIC_COLORS.info.bg,
											border: `1px solid ${SEMANTIC_COLORS.info.border}`,
										}}
									>
										<p className="text-muted-foreground">
											Alternative authentication methods available:
											{hasOIDC && (
												<span className="ml-2 inline-flex items-center gap-1 text-foreground">
													<Check className="h-3 w-3" style={{ color: SEMANTIC_COLORS.success.from }} />
													OIDC provider
												</span>
											)}
											{hasPasskeys && (
												<span className="ml-2 inline-flex items-center gap-1 text-foreground">
													<Check className="h-3 w-3" style={{ color: SEMANTIC_COLORS.success.from }} />
													Passkeys
												</span>
											)}
										</p>
									</div>

									{!showRemovePassword ? (
										<Button
											type="button"
											variant="outline"
											onClick={() => setShowRemovePassword(true)}
											aria-expanded={false}
											className="gap-2"
											style={{
												borderColor: SEMANTIC_COLORS.error.border,
												color: SEMANTIC_COLORS.error.text,
											}}
										>
											<Trash2 className="h-4 w-4" />
											Remove Password
										</Button>
									) : (
										<div className="space-y-4 animate-in fade-in slide-in-from-top-2">
											<div className="space-y-2">
												<label className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
													Confirm Current Password
												</label>
												<Input
													type="password"
													value={removePasswordValue}
													onChange={(e) => setRemovePasswordValue(e.target.value)}
													placeholder="Enter your current password"
													autoComplete="current-password"
													className="bg-card/30 border-border/50"
												/>
												<div
													className="flex items-center gap-2 text-xs rounded-lg p-2"
													style={{
														backgroundColor: SEMANTIC_COLORS.warning.bg,
														border: `1px solid ${SEMANTIC_COLORS.warning.border}`,
														color: SEMANTIC_COLORS.warning.text,
													}}
												>
													<AlertTriangle className="h-3.5 w-3.5 shrink-0" />
													This action cannot be undone. You will only be able to sign in using OIDC or passkeys.
												</div>
											</div>

											<div className="flex gap-2">
												<Button
													type="button"
													disabled={removePasswordMutation.isPending}
													onClick={handleRemovePassword}
													className="gap-2"
													style={{
														background: `linear-gradient(135deg, ${SEMANTIC_COLORS.error.from}, ${SEMANTIC_COLORS.error.to})`,
														boxShadow: `0 4px 12px -4px ${SEMANTIC_COLORS.error.glow}`,
													}}
												>
													{removePasswordMutation.isPending ? (
														<>
															<Loader2 className="h-4 w-4 animate-spin" />
															Removing...
														</>
													) : (
														<>
															<Trash2 className="h-4 w-4" />
															Confirm Removal
														</>
													)}
												</Button>
												<Button
													type="button"
													variant="outline"
													onClick={() => {
														setShowRemovePassword(false);
														setRemovePasswordValue("");
														setRemovePasswordError(null);
													}}
												>
													Cancel
												</Button>
											</div>

											{removePasswordError && (
												<div
													className="flex items-center gap-2 rounded-xl px-4 py-3 text-sm animate-in fade-in"
													style={{
														backgroundColor: SEMANTIC_COLORS.error.bg,
														border: `1px solid ${SEMANTIC_COLORS.error.border}`,
														color: SEMANTIC_COLORS.error.text,
													}}
												>
													<X className="h-4 w-4 shrink-0" />
													<span>{removePasswordError}</span>
												</div>
											)}

											{removePasswordSuccess && (
												<div
													className="flex items-center gap-2 rounded-xl px-4 py-3 text-sm animate-in fade-in"
													style={{
														backgroundColor: SEMANTIC_COLORS.success.bg,
														border: `1px solid ${SEMANTIC_COLORS.success.border}`,
														color: SEMANTIC_COLORS.success.text,
													}}
												>
													<Check className="h-4 w-4 shrink-0" />
													<span>{removePasswordSuccess}</span>
												</div>
											)}
										</div>
									)}
								</>
							) : (
								<div
									className="flex items-center gap-3 rounded-xl px-4 py-3 text-sm"
									style={{
										backgroundColor: SEMANTIC_COLORS.warning.bg,
										border: `1px solid ${SEMANTIC_COLORS.warning.border}`,
									}}
								>
									<AlertTriangle className="h-5 w-5 shrink-0" style={{ color: SEMANTIC_COLORS.warning.from }} />
									<p className="text-muted-foreground">
										Cannot remove password without alternative authentication method. Please add an OIDC provider or passkey first.
									</p>
								</div>
							)}
						</div>
					</GlassmorphicCard>
				)}
			</div>
		</PremiumSection>
	);
};
