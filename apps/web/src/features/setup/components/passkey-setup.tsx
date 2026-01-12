"use client";

import { useState } from "react";
import { startRegistration } from "@simplewebauthn/browser";
import { useRouter } from "next/navigation";
import { KeyRound, Loader2 } from "lucide-react";
import { apiRequest } from "../../../lib/api-client/base";
import type { CurrentUser } from "@arr/shared";
import { Button } from "../../../components/ui/button";
import { Input } from "../../../components/ui/input";
import { Alert, AlertDescription } from "../../../components/ui";
import { useThemeGradient } from "../../../hooks/useThemeGradient";

interface RegisterResponse {
	user: CurrentUser;
}

export const PasskeySetup = () => {
	const { gradient: themeGradient } = useThemeGradient();

	const router = useRouter();
	const [formState, setFormState] = useState({
		username: "",
		password: "",
		confirmPassword: "",
		passkeyName: "",
	});
	const [error, setError] = useState<string | null>(null);
	const [isSubmitting, setIsSubmitting] = useState(false);

	const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
		event.preventDefault();
		setError(null);

		// Validation
		if (!formState.username || !formState.password) {
			setError("Username and password are required");
			return;
		}
		if (formState.password.length < 8) {
			setError("Password must be at least 8 characters");
			return;
		}
		if (!/[a-z]/.test(formState.password)) {
			setError("Password must contain at least one lowercase letter");
			return;
		}
		if (!/[A-Z]/.test(formState.password)) {
			setError("Password must contain at least one uppercase letter");
			return;
		}
		if (!/[0-9]/.test(formState.password)) {
			setError("Password must contain at least one number");
			return;
		}
		if (!/[^a-zA-Z0-9]/.test(formState.password)) {
			setError("Password must contain at least one special character");
			return;
		}
		if (formState.password !== formState.confirmPassword) {
			setError("Passwords do not match");
			return;
		}

		setIsSubmitting(true);

		let userCreated = false;

		try {
			// Step 1: Create user account with password (required for initial setup)
			const registerResponse = await apiRequest<RegisterResponse>("/auth/register", {
				method: "POST",
				json: {
					username: formState.username.trim(),
					password: formState.password,
				},
			});
			userCreated = true;

			// Step 2: Get passkey registration options
			const options = await apiRequest<any>("/auth/passkey/register/options", {
				method: "POST",
				json: {
					friendlyName: formState.passkeyName.trim() || `${formState.username}'s passkey`,
				},
			});

			// Step 3: Trigger WebAuthn registration
			const registrationResponse = await startRegistration(options);

			// Step 4: Verify passkey registration
			await apiRequest("/auth/passkey/register/verify", {
				method: "POST",
				json: {
					response: registrationResponse,
					friendlyName: formState.passkeyName.trim() || `${formState.username}'s passkey`,
				},
			});

			// Registration successful, redirect to dashboard
			router.push("/dashboard");
		} catch (err: any) {
			// If user was created but passkey registration failed, delete the incomplete account
			if (userCreated) {
				try {
					await apiRequest("/auth/account", { method: "DELETE" });
					setError(
						"Passkey registration failed. The incomplete account has been deleted. Please try again. Make sure your browser supports passkeys and you approve the biometric prompt.",
					);
				} catch (cleanupErr) {
					// If cleanup fails, just log out to clear the session
					try {
						await apiRequest("/auth/logout", { method: "POST" });
					} catch {}
					setError(
						"Passkey registration failed. Please refresh the page and try again. If the problem persists, contact support to delete the incomplete account.",
					);
				}
			} else {
				setError(err.message ?? "Failed to create admin account with passkey");
			}
			setIsSubmitting(false);
		}
	};

	return (
		<form className="space-y-4" onSubmit={handleSubmit}>
			<div className="space-y-2">
				<label className="text-xs uppercase text-muted-foreground font-medium">Username</label>
				<Input
					type="text"
					value={formState.username}
					onChange={(e) => setFormState((prev) => ({ ...prev, username: e.target.value }))}
					placeholder="admin"
					required
					minLength={3}
					maxLength={50}
					autoFocus
					className="rounded-xl"
				/>
			</div>
			<div className="space-y-2">
				<label className="text-xs uppercase text-muted-foreground font-medium">Password (Fallback)</label>
				<Input
					type="password"
					value={formState.password}
					onChange={(e) => setFormState((prev) => ({ ...prev, password: e.target.value }))}
					placeholder="At least 8 characters"
					required
					minLength={8}
					className="rounded-xl"
				/>
				<p className="text-xs text-muted-foreground">
					Required as a backup login method. Must include uppercase, lowercase, number, and special character.
				</p>
			</div>
			<div className="space-y-2">
				<label className="text-xs uppercase text-muted-foreground font-medium">Confirm Password</label>
				<Input
					type="password"
					value={formState.confirmPassword}
					onChange={(e) => setFormState((prev) => ({ ...prev, confirmPassword: e.target.value }))}
					placeholder="Re-enter password"
					required
					className="rounded-xl"
				/>
			</div>
			<div className="space-y-2">
				<label className="text-xs uppercase text-muted-foreground font-medium">Passkey Name (Optional)</label>
				<Input
					value={formState.passkeyName}
					onChange={(e) => setFormState((prev) => ({ ...prev, passkeyName: e.target.value }))}
					placeholder="e.g., My Laptop"
					maxLength={100}
					className="rounded-xl"
				/>
				<p className="text-xs text-muted-foreground">
					Give this passkey a friendly name to identify it later
				</p>
			</div>
			{error && (
				<Alert variant="danger">
					<AlertDescription>{error}</AlertDescription>
				</Alert>
			)}
			<Button
				type="submit"
				disabled={isSubmitting}
				className="w-full gap-2 rounded-xl font-medium"
				style={{
					background: `linear-gradient(135deg, ${themeGradient.from}, ${themeGradient.to})`,
					boxShadow: `0 4px 12px -4px ${themeGradient.glow}`,
				}}
			>
				{isSubmitting ? (
					<>
						<Loader2 className="h-4 w-4 animate-spin" />
						Creating account...
					</>
				) : (
					<>
						<KeyRound className="h-4 w-4" />
						Create Admin Account
					</>
				)}
			</Button>
			<p className="text-xs text-muted-foreground text-center">
				You&apos;ll be prompted to register a passkey using your device&apos;s biometrics or security key.
				The password serves as a backup login method if passkey authentication fails.
			</p>
		</form>
	);
};
