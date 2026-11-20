"use client";

import type { CurrentUser } from "@arr/shared";
import {
	type PublicKeyCredentialCreationOptionsJSON,
	startRegistration,
} from "@simplewebauthn/browser";
import { KeyRound, Loader2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Alert, AlertDescription } from "../../../components/ui";
import { Button } from "../../../components/ui/button";
import { Input } from "../../../components/ui/input";
import { useThemeGradient } from "../../../hooks/useThemeGradient";
import { apiRequest } from "../../../lib/api-client/base";
import { getErrorMessage } from "../../../lib/error-utils";

interface RegisterResponse {
	user: CurrentUser;
}

interface PasskeySetupProps {
	onMethodLockChange?: (locked: boolean) => void;
}

const INITIAL_FORM_STATE = {
	username: "",
	password: "",
	confirmPassword: "",
	passkeyName: "",
};

export const PasskeySetup = ({ onMethodLockChange }: PasskeySetupProps) => {
	const { gradient: themeGradient } = useThemeGradient();

	const router = useRouter();
	const [formState, setFormState] = useState(INITIAL_FORM_STATE);
	const [error, setError] = useState<string | null>(null);
	const [isSubmitting, setIsSubmitting] = useState(false);
	const [passkeyUnconfirmed, setPasskeyUnconfirmed] = useState(false);

	const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
		event.preventDefault();
		if (isSubmitting || passkeyUnconfirmed) return;
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
		onMethodLockChange?.(true);

		try {
			await apiRequest<RegisterResponse>("/auth/register", {
				method: "POST",
				json: {
					username: formState.username.trim(),
					password: formState.password,
				},
			});
		} catch (err: unknown) {
			setError(getErrorMessage(err, "Failed to create admin account with passkey"));
			setIsSubmitting(false);
			onMethodLockChange?.(false);
			return;
		}

		const friendlyName = formState.passkeyName.trim() || `${formState.username}'s passkey`;
		try {
			const options = await apiRequest<PublicKeyCredentialCreationOptionsJSON>(
				"/auth/passkey/register/options",
				{ method: "POST", json: { friendlyName } },
			);
			const registrationResponse = await startRegistration({ optionsJSON: options });
			await apiRequest("/auth/passkey/register/verify", {
				method: "POST",
				json: { response: registrationResponse, friendlyName },
			});
		} catch {
			setFormState(INITIAL_FORM_STATE);
			setPasskeyUnconfirmed(true);
			setIsSubmitting(false);
			return;
		}

		router.push("/dashboard");
	};

	if (passkeyUnconfirmed) {
		return (
			<div className="space-y-4">
				<Alert variant="warning">
					<AlertDescription>
						Your admin account was created, but we could not confirm passkey enrollment. If
						prompted, sign in with the password you just set. You can review or add passkeys under
						Settings → Auth → Passkeys.
					</AlertDescription>
				</Alert>
				<Button
					type="button"
					className="w-full rounded-xl font-medium"
					onClick={() => router.push("/dashboard")}
				>
					Continue to Dashboard
				</Button>
			</div>
		);
	}

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
				<label className="text-xs uppercase text-muted-foreground font-medium">
					Password (Fallback)
				</label>
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
					Required as a backup login method. Must include uppercase, lowercase, number, and special
					character.
				</p>
			</div>
			<div className="space-y-2">
				<label className="text-xs uppercase text-muted-foreground font-medium">
					Confirm Password
				</label>
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
				<label className="text-xs uppercase text-muted-foreground font-medium">
					Passkey Name (Optional)
				</label>
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
				You&apos;ll be prompted to register a passkey using your device&apos;s biometrics or
				security key. The password serves as a backup login method if passkey authentication fails.
			</p>
		</form>
	);
};
