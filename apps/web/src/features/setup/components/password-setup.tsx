"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Lock, Loader2 } from "lucide-react";
import { apiRequest } from "../../../lib/api-client/base";
import type { CurrentUser } from "@arr/shared";
import { Button } from "../../../components/ui/button";
import { Input } from "../../../components/ui/input";
import { PasswordInput } from "../../../components/ui/password-input";
import { Alert, AlertDescription } from "../../../components/ui";
import { useThemeGradient } from "../../../hooks/useThemeGradient";
import type { PasswordPolicy } from "../../../lib/api-client/auth";

interface RegisterResponse {
	user: CurrentUser;
}

interface PasswordSetupProps {
	passwordPolicy?: PasswordPolicy;
}

/**
 * Validates password based on configured policy
 */
const validatePassword = (
	password: string,
	policy: PasswordPolicy = "strict",
): { valid: boolean; message?: string } => {
	if (password.length < 8) {
		return { valid: false, message: "Password must be at least 8 characters" };
	}

	// Relaxed policy only requires minimum length
	if (policy === "relaxed") {
		return { valid: true };
	}

	// Strict policy requires complexity
	if (!/[a-z]/.test(password)) {
		return { valid: false, message: "Password must contain at least one lowercase letter" };
	}
	if (!/[A-Z]/.test(password)) {
		return { valid: false, message: "Password must contain at least one uppercase letter" };
	}
	if (!/[0-9]/.test(password)) {
		return { valid: false, message: "Password must contain at least one number" };
	}
	if (!/[^a-zA-Z0-9]/.test(password)) {
		return { valid: false, message: "Password must contain at least one special character" };
	}
	return { valid: true };
};

export const PasswordSetup = ({ passwordPolicy = "strict" }: PasswordSetupProps) => {
	const { gradient: themeGradient } = useThemeGradient();

	const router = useRouter();
	const [formState, setFormState] = useState({
		username: "",
		password: "",
		confirmPassword: "",
	});
	const [error, setError] = useState<string | null>(null);
	const [isSubmitting, setIsSubmitting] = useState(false);

	const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
		event.preventDefault();
		setError(null);

		// Validation
		if (!formState.username || !formState.password) {
			setError("All fields are required");
			return;
		}

		const passwordValidation = validatePassword(formState.password, passwordPolicy);
		if (!passwordValidation.valid) {
			setError(passwordValidation.message ?? "Password validation failed");
			return;
		}

		if (formState.password !== formState.confirmPassword) {
			setError("Passwords do not match");
			return;
		}

		setIsSubmitting(true);

		try {
			await apiRequest<RegisterResponse>("/auth/register", {
				method: "POST",
				json: {
					username: formState.username.trim(),
					password: formState.password,
				},
			});

			// Registration successful, redirect to dashboard
			router.push("/dashboard");
		} catch (err: any) {
			setError(err.message ?? "Failed to create admin account");
			setIsSubmitting(false);
		}
	};

	const passwordHint =
		passwordPolicy === "relaxed"
			? "At least 8 characters"
			: "Must include uppercase, lowercase, number, and special character";

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
					className="rounded-xl"
				/>
			</div>
			<div className="space-y-2">
				<label className="text-xs uppercase text-muted-foreground font-medium">Password</label>
				<PasswordInput
					value={formState.password}
					onChange={(e) => setFormState((prev) => ({ ...prev, password: e.target.value }))}
					placeholder="At least 8 characters"
					required
					minLength={8}
					className="rounded-xl"
				/>
				<p className="text-xs text-muted-foreground">{passwordHint}</p>
			</div>
			<div className="space-y-2">
				<label className="text-xs uppercase text-muted-foreground font-medium">Confirm Password</label>
				<PasswordInput
					value={formState.confirmPassword}
					onChange={(e) =>
						setFormState((prev) => ({
							...prev,
							confirmPassword: e.target.value,
						}))
					}
					placeholder="Re-enter password"
					required
					className="rounded-xl"
				/>
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
						<Lock className="h-4 w-4" />
						Create Admin Account
					</>
				)}
			</Button>
		</form>
	);
};
