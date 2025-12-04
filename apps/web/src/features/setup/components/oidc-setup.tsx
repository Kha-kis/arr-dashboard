"use client";

import { useState } from "react";
import type { OIDCProviderType } from "@arr/shared";
import { Button } from "../../../components/ui/button";
import { Input } from "../../../components/ui/input";
import { Alert, AlertDescription } from "../../../components/ui";
import { useOIDCSetup } from "../../../hooks/api/useAuth";

export const OIDCSetup = () => {
	const [formState, setFormState] = useState({
		type: "generic" as OIDCProviderType,
		displayName: "",
		clientId: "",
		clientSecret: "",
		issuer: "",
		scopes: "openid,email,profile",
	});
	const oidcSetupMutation = useOIDCSetup();

	const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
		event.preventDefault();

		// Validation
		if (
			!formState.displayName ||
			!formState.clientId ||
			!formState.clientSecret ||
			!formState.issuer
		) {
			return;
		}

		try {
			const result = await oidcSetupMutation.mutateAsync(formState);
			// Redirect to OIDC provider
			window.location.href = result.authorizationUrl;
		} catch (err) {
			// Error handling is done by the mutation hook
		}
	};

	return (
		<form className="space-y-4" onSubmit={handleSubmit}>
			<div className="space-y-2">
				<label className="text-xs uppercase text-fg-muted">Provider Type</label>
				<select
					value={formState.type}
					onChange={(e) =>
						setFormState({ ...formState, type: e.target.value as OIDCProviderType })
					}
					className="w-full rounded-xl border border-border bg-bg-subtle px-4 py-3 text-sm text-fg transition-all duration-200 hover:border-border/80 hover:bg-bg-subtle/80 focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20 focus:bg-bg-subtle/80"
				>
					<option value="authelia">Authelia</option>
					<option value="authentik">Authentik</option>
					<option value="generic">Generic OIDC</option>
				</select>
			</div>
			<div className="space-y-2">
				<label className="text-xs uppercase text-fg-muted">Display Name</label>
				<Input
					value={formState.displayName}
					onChange={(e) => setFormState({ ...formState, displayName: e.target.value })}
					placeholder="e.g., My Auth Server"
					required
					autoFocus
				/>
			</div>
			<div className="space-y-2">
				<label className="text-xs uppercase text-fg-muted">Client ID</label>
				<Input
					value={formState.clientId}
					onChange={(e) => setFormState({ ...formState, clientId: e.target.value })}
					placeholder="OAuth client ID"
					required
				/>
			</div>
			<div className="space-y-2">
				<label className="text-xs uppercase text-fg-muted">Client Secret</label>
				<Input
					type="password"
					value={formState.clientSecret}
					onChange={(e) => setFormState({ ...formState, clientSecret: e.target.value })}
					placeholder="OAuth client secret"
					required
				/>
			</div>
			<div className="space-y-2">
				<label className="text-xs uppercase text-fg-muted">Issuer URL</label>
				<Input
					value={formState.issuer}
					onChange={(e) => setFormState({ ...formState, issuer: e.target.value })}
					placeholder="https://auth.example.com"
					required
				/>
				<p className="text-xs text-fg-muted">
					The base URL of your OIDC provider (without .well-known path)
				</p>
			</div>
			<div className="space-y-2">
				<label className="text-xs uppercase text-fg-muted">Scopes (comma-separated)</label>
				<Input
					value={formState.scopes}
					onChange={(e) => setFormState({ ...formState, scopes: e.target.value })}
					placeholder="openid,email,profile"
				/>
			</div>
			{oidcSetupMutation.isError && (
				<Alert variant="danger">
					<AlertDescription>
						{oidcSetupMutation.error?.message ?? "Failed to configure OIDC provider"}
					</AlertDescription>
				</Alert>
			)}
			<Button type="submit" disabled={oidcSetupMutation.isPending} className="w-full">
				{oidcSetupMutation.isPending ? "Configuring..." : "Continue with OIDC"}
			</Button>
			<p className="text-xs text-fg-muted text-center">
				You&apos;ll be redirected to your OIDC provider to complete authentication. The first user
				will become an admin.
			</p>
		</form>
	);
};
