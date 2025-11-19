"use client";

import { useState } from "react";
import { apiRequest } from "../../../lib/api-client/base";
import { Button } from "../../../components/ui/button";
import { Input } from "../../../components/ui/input";
import { Alert, AlertDescription } from "../../../components/ui";

export const OIDCSetup = () => {
	const [formState, setFormState] = useState({
		displayName: "",
		clientId: "",
		clientSecret: "",
		issuer: "",
		redirectUri: "",
		scopes: "openid,email,profile",
	});
	const [error, setError] = useState<string | null>(null);
	const [isSubmitting, setIsSubmitting] = useState(false);

	const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
		event.preventDefault();
		setError(null);

		// Validation
		if (
			!formState.displayName ||
			!formState.clientId ||
			!formState.clientSecret ||
			!formState.issuer
		) {
			setError("All fields are required");
			return;
		}

		setIsSubmitting(true);

		try {
			// Configure OIDC provider
			const { redirectUri, ...rest } = formState;
			const payload = {
				...rest,
				...(redirectUri.trim() ? { redirectUri: redirectUri.trim() } : {}),
			};

			await apiRequest("/auth/oidc/setup", {
				method: "POST",
				json: payload,
			});

			// Initiate OIDC login
			const response = await apiRequest<{ authorizationUrl: string }>("/auth/oidc/login", {
				method: "POST",
			});

			// Redirect to OIDC provider
			window.location.href = response.authorizationUrl;
		} catch (err: any) {
			setError(err.message ?? "Failed to configure OIDC provider");
			setIsSubmitting(false);
		}
	};

	return (
		<form className="space-y-4" onSubmit={handleSubmit}>
			<div className="space-y-2">
				<label className="text-xs uppercase text-white/60">Display Name</label>
				<Input
					value={formState.displayName}
					onChange={(e) => setFormState({ ...formState, displayName: e.target.value })}
					placeholder="e.g., My Auth Server"
					required
					autoFocus
				/>
			</div>
			<div className="space-y-2">
				<label className="text-xs uppercase text-white/60">Client ID</label>
				<Input
					value={formState.clientId}
					onChange={(e) => setFormState({ ...formState, clientId: e.target.value })}
					placeholder="OAuth client ID"
					required
				/>
			</div>
			<div className="space-y-2">
				<label className="text-xs uppercase text-white/60">Client Secret</label>
				<Input
					type="password"
					value={formState.clientSecret}
					onChange={(e) => setFormState({ ...formState, clientSecret: e.target.value })}
					placeholder="OAuth client secret"
					required
				/>
			</div>
			<div className="space-y-2">
				<label className="text-xs uppercase text-white/60">Issuer URL</label>
				<Input
					value={formState.issuer}
					onChange={(e) => setFormState({ ...formState, issuer: e.target.value })}
					placeholder="https://auth.example.com"
					required
				/>
				<p className="text-xs text-white/50">
					The base URL of your OIDC provider (issuer URL from provider config)
				</p>
			</div>
			<div className="space-y-2">
				<label className="text-xs uppercase text-white/60">Redirect URI</label>
				<Input
					value={formState.redirectUri}
					onChange={(e) => setFormState({ ...formState, redirectUri: e.target.value })}
					placeholder={
						typeof window !== "undefined"
							? `${window.location.origin}/auth/oidc/callback`
							: "/auth/oidc/callback"
					}
				/>
				<p className="text-xs text-white/50">
					Leave empty to auto-detect. Must match the redirect URI configured in your OIDC provider.
				</p>
			</div>
			<div className="space-y-2">
				<label className="text-xs uppercase text-white/60">Scopes (comma-separated)</label>
				<Input
					value={formState.scopes}
					onChange={(e) => setFormState({ ...formState, scopes: e.target.value })}
					placeholder="openid,email,profile"
				/>
			</div>
			{error && (
				<Alert variant="danger">
					<AlertDescription>{error}</AlertDescription>
				</Alert>
			)}
			<Button type="submit" disabled={isSubmitting} className="w-full">
				{isSubmitting ? "Configuring..." : "Continue with OIDC"}
			</Button>
			<p className="text-xs text-white/50 text-center">
				You&apos;ll be redirected to your OIDC provider to complete authentication. The first user
				will become an admin.
			</p>
		</form>
	);
};
