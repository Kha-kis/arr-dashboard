"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { startRegistration } from "@simplewebauthn/browser";
import { apiRequest } from "../../../lib/api-client/base";
import type { CurrentUser } from "@arr/shared";
import { Button } from "../../../components/ui/button";
import { Input } from "../../../components/ui/input";
import { Alert, AlertDescription } from "../../../components/ui";

interface RegisterResponse {
	user: CurrentUser;
}

export const PasskeySetup = () => {
	const router = useRouter();
	const [formState, setFormState] = useState({
		username: "",
		passkeyName: "",
	});
	const [error, setError] = useState<string | null>(null);
	const [isSubmitting, setIsSubmitting] = useState(false);

	const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
		event.preventDefault();
		setError(null);

		// Validation
		if (!formState.username) {
			setError("Username is required");
			return;
		}

		setIsSubmitting(true);

		let userCreated = false;

		try {
			// Step 1: Create user account without password
			const registerResponse = await apiRequest<RegisterResponse>("/auth/register", {
				method: "POST",
				json: {
					username: formState.username.trim(),
					// No password - passkey-only account
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
				<label className="text-xs uppercase text-white/60">Username</label>
				<Input
					type="text"
					value={formState.username}
					onChange={(e) => setFormState((prev) => ({ ...prev, username: e.target.value }))}
					placeholder="admin"
					required
					minLength={3}
					maxLength={50}
					autoFocus
				/>
			</div>
			<div className="space-y-2">
				<label className="text-xs uppercase text-white/60">Passkey Name (Optional)</label>
				<Input
					value={formState.passkeyName}
					onChange={(e) => setFormState((prev) => ({ ...prev, passkeyName: e.target.value }))}
					placeholder="e.g., My Laptop"
					maxLength={100}
				/>
				<p className="text-xs text-white/50">
					Give this passkey a friendly name to identify it later
				</p>
			</div>
			{error && (
				<Alert variant="danger">
					<AlertDescription>{error}</AlertDescription>
				</Alert>
			)}
			<Button type="submit" disabled={isSubmitting} className="w-full">
				{isSubmitting ? "Creating account..." : "Create Admin Account with Passkey"}
			</Button>
			<p className="text-xs text-white/50 text-center">
				You&apos;ll be prompted to register a passkey using your device&apos;s biometrics or security key.
				This account will not have a password.
			</p>
		</form>
	);
};
