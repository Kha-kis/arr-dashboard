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

		try {
			// Step 1: Create user account without password
			const registerResponse = await apiRequest<RegisterResponse>("/auth/register", {
				method: "POST",
				json: {
					username: formState.username.trim(),
					// No password - passkey-only account
				},
			});

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
			setError(err.message ?? "Failed to create admin account with passkey");
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
