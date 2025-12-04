"use client";

import { useState } from "react";
import { Button } from "../../../components/ui/button";
import { Input } from "../../../components/ui/input";
import {
	Card,
	CardContent,
	CardHeader,
	CardTitle,
	CardDescription,
} from "../../../components/ui/card";
import { Alert, AlertDescription } from "../../../components/ui";
import { useUpdateAccountMutation, useRemovePasswordMutation } from "../../../hooks/api/useAuth";
import { useOIDCProviders } from "../../../hooks/api/useOIDCProviders";
import { useQuery } from "@tanstack/react-query";
import { getPasskeyCredentials } from "../../../lib/api-client/auth";
import { validatePassword } from "../lib/settings-utils";
import type { CurrentUser } from "@arr/shared";

interface PasswordSectionProps {
	currentUser?: CurrentUser | null;
}

export const PasswordSection = ({ currentUser }: PasswordSectionProps) => {
	// Password change/add state
	const [currentPassword, setCurrentPassword] = useState("");
	const [newPassword, setNewPassword] = useState("");
	const [confirmPassword, setConfirmPassword] = useState("");
	const [updateResult, setUpdateResult] = useState<{ success: boolean; message: string } | null>(
		null,
	);

	// Password removal state
	const [removePasswordValue, setRemovePasswordValue] = useState("");
	const [removePasswordError, setRemovePasswordError] = useState<string | null>(null);
	const [removePasswordSuccess, setRemovePasswordSuccess] = useState<string | null>(null);
	const [showRemovePassword, setShowRemovePassword] = useState(false);

	const updateAccountMutation = useUpdateAccountMutation();
	const removePasswordMutation = useRemovePasswordMutation();
	const { data: oidcProviders = [] } = useOIDCProviders();
	const { data: passkeys = [] } = useQuery({
		queryKey: ["passkey-credentials"],
		queryFn: getPasskeyCredentials,
	});

	const hasOIDC = oidcProviders.length > 0;
	const hasPasskeys = passkeys.length > 0;
	const hasAlternativeAuth = hasOIDC || hasPasskeys;

	const handlePasswordUpdate = async (e: React.FormEvent) => {
		e.preventDefault();
		setUpdateResult(null);

		// Validate password fields
		if (newPassword || confirmPassword || currentPassword) {
			// Only require currentPassword if user already has a password
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

			const passwordValidation = validatePassword(newPassword);
			if (!passwordValidation.valid) {
				setUpdateResult({
					success: false,
					message: passwordValidation.message ?? "Password validation failed",
				});
				return;
			}
		}

		// Build update payload
		const payload: Record<string, unknown> = {};
		if (newPassword) {
			payload.newPassword = newPassword;
			// Only include currentPassword if user has a password
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
			// Clear password fields on success
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
				error instanceof Error ? error.message : "Failed to remove password",
			);
		}
	};

	return (
		<Card>
			<CardHeader>
				<CardTitle>Password Authentication</CardTitle>
				<CardDescription>
					{currentUser?.hasPassword
						? "Manage your password or remove it if you have alternative authentication methods."
						: "Add a password for an additional login option."}
				</CardDescription>
			</CardHeader>
			<CardContent className="space-y-6">
				{/* Add/Change Password Section */}
				<form onSubmit={handlePasswordUpdate} className="space-y-4">
					<div className="space-y-4">
						<h3 className="text-sm font-semibold text-fg">
							{currentUser?.hasPassword ? "Change Password" : "Add Password"}
						</h3>
						{!currentUser?.hasPassword && (
							<p className="text-xs text-fg-muted">
								Your account uses passwordless authentication. You can optionally add a password
								for additional login options.
							</p>
						)}
						{currentUser?.hasPassword && (
							<div className="space-y-2">
								<label className="text-xs uppercase text-fg-muted">Current Password</label>
								<Input
									type="password"
									value={currentPassword}
									onChange={(e) => setCurrentPassword(e.target.value)}
									placeholder="Enter current password"
								/>
							</div>
						)}
						<div className="space-y-2">
							<label className="text-xs uppercase text-fg-muted">
								{currentUser?.hasPassword ? "New Password" : "Password"}
							</label>
							<Input
								type="password"
								value={newPassword}
								onChange={(e) => setNewPassword(e.target.value)}
								placeholder="At least 8 characters"
							/>
							<p className="text-xs text-fg-muted">
								Must include uppercase, lowercase, number, and special character
							</p>
						</div>
						<div className="space-y-2">
							<label className="text-xs uppercase text-fg-muted">
								{currentUser?.hasPassword ? "Confirm New Password" : "Confirm Password"}
							</label>
							<Input
								type="password"
								value={confirmPassword}
								onChange={(e) => setConfirmPassword(e.target.value)}
								placeholder={currentUser?.hasPassword ? "Re-enter new password" : "Re-enter password"}
							/>
						</div>
					</div>
					<div className="flex gap-2">
						<Button type="submit" disabled={updateAccountMutation.isPending}>
							{updateAccountMutation.isPending ? "Saving..." : currentUser?.hasPassword ? "Change Password" : "Add Password"}
						</Button>
					</div>
					{updateResult && (
						<Alert variant={updateResult.success ? "success" : "danger"}>
							<AlertDescription>{updateResult.message}</AlertDescription>
						</Alert>
					)}
				</form>

				{/* Remove Password Section */}
				{currentUser?.hasPassword && (
					<div className="border-t border-border pt-6">
						<h3 className="text-sm font-semibold text-fg mb-4">Remove Password</h3>
						{hasAlternativeAuth ? (
							<>
								<p className="text-xs text-fg-muted mb-4">
									You can remove your password and use only OIDC or passkeys to sign in.
									<br />
									Alternative authentication methods available:
									{hasOIDC && <span className="ml-2">✓ OIDC providers</span>}
									{hasPasskeys && <span className="ml-2">✓ Passkeys</span>}
								</p>
								{!showRemovePassword ? (
									<Button
										type="button"
										variant="secondary"
										onClick={() => setShowRemovePassword(true)}
										className="border-red-500/50 text-red-400 hover:bg-red-500/10"
									>
										Remove Password
									</Button>
								) : (
									<div className="space-y-4">
										<div className="space-y-2">
											<label className="text-xs uppercase text-fg-muted">
												Confirm Current Password
											</label>
											<Input
												type="password"
												value={removePasswordValue}
												onChange={(e) => setRemovePasswordValue(e.target.value)}
												placeholder="Enter your current password"
												autoComplete="current-password"
											/>
											<p className="text-xs text-red-400">
												⚠️ This action cannot be undone. You will only be able to sign in using
												OIDC or passkeys.
											</p>
										</div>
										<div className="flex gap-2">
											<Button
												type="button"
												variant="secondary"
												disabled={removePasswordMutation.isPending}
												className="border-red-500/50 text-red-400 hover:bg-red-500/10"
												onClick={(e) => handleRemovePassword(e)}
											>
												{removePasswordMutation.isPending ? "Removing..." : "Confirm Removal"}
											</Button>
											<Button
												type="button"
												variant="secondary"
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
											<Alert variant="danger">
												<AlertDescription>{removePasswordError}</AlertDescription>
											</Alert>
										)}
										{removePasswordSuccess && (
											<Alert variant="success">
												<AlertDescription>{removePasswordSuccess}</AlertDescription>
											</Alert>
										)}
									</div>
								)}
							</>
						) : (
							<Alert variant="danger">
								<AlertDescription>
									Cannot remove password without alternative authentication method. Please add an
									OIDC provider or passkey first.
								</AlertDescription>
							</Alert>
						)}
					</div>
				)}
			</CardContent>
		</Card>
	);
};
