"use client";

import { useState } from "react";
import type { UpdateOIDCProvider } from "@arr/shared";
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
import {
	useOIDCProvider,
	useCreateOIDCProvider,
	useUpdateOIDCProvider,
	useDeleteOIDCProvider,
} from "../../../hooks/api/useOIDCProviders";

/**
 * OIDC Provider management section for admin settings
 */
export const OIDCProviderSection = () => {
	const { data: providerData, isLoading } = useOIDCProvider();
	const createMutation = useCreateOIDCProvider();
	const updateMutation = useUpdateOIDCProvider();
	const deleteMutation = useDeleteOIDCProvider();

	const provider = providerData?.provider;

	const [error, setError] = useState<string | null>(null);
	const [success, setSuccess] = useState<string | null>(null);

	// Form state for creating new provider
	const [showCreateForm, setShowCreateForm] = useState(false);
	const [formData, setFormData] = useState({
		displayName: "",
		clientId: "",
		clientSecret: "",
		issuer: "",
		redirectUri: "",
		scopes: "openid,email,profile",
		enabled: true,
	});

	// Editing state
	const [isEditing, setIsEditing] = useState(false);
	const [editData, setEditData] = useState({
		displayName: "",
		clientId: "",
		clientSecret: "",
		issuer: "",
		redirectUri: "",
		scopes: "",
		enabled: true,
	});

	const handleCreate = async () => {
		setError(null);
		setSuccess(null);

		try {
			// Only include redirectUri if non-empty
			const { redirectUri, ...rest } = formData;
			const payload = {
				...rest,
				...(redirectUri.trim() ? { redirectUri: redirectUri.trim() } : {}),
			};

			await createMutation.mutateAsync(payload);
			setSuccess("OIDC provider created successfully!");
			setShowCreateForm(false);
			// Reset form
			setFormData({
				displayName: "",
				clientId: "",
				clientSecret: "",
				issuer: "",
				redirectUri: "",
				scopes: "openid,email,profile",
				enabled: true,
			});
		} catch (err) {
			setError(err instanceof Error ? err.message : "Failed to create OIDC provider");
		}
	};

	const handleUpdate = async () => {
		if (!provider?.id) return;

		setError(null);
		setSuccess(null);

		try {
			// Only send fields that were provided - use shared UpdateOIDCProvider type for safety
			const updatePayload: UpdateOIDCProvider = {};
			if (editData.displayName) updatePayload.displayName = editData.displayName;
			if (editData.clientId) updatePayload.clientId = editData.clientId;
			if (editData.clientSecret) updatePayload.clientSecret = editData.clientSecret;
			if (editData.issuer) updatePayload.issuer = editData.issuer;
			if (editData.redirectUri?.trim()) updatePayload.redirectUri = editData.redirectUri.trim();
			if (editData.scopes) updatePayload.scopes = editData.scopes;
			updatePayload.enabled = editData.enabled;

			await updateMutation.mutateAsync({ id: provider.id, data: updatePayload });
			setSuccess("OIDC provider updated successfully!");
			setIsEditing(false);
		} catch (err) {
			setError(err instanceof Error ? err.message : "Failed to update OIDC provider");
		}
	};

	const handleDelete = async () => {
		if (!provider?.id) return;

		if (!confirm("Are you sure you want to delete this OIDC provider?")) {
			return;
		}

		setError(null);
		setSuccess(null);

		try {
			await deleteMutation.mutateAsync(provider.id);
			setSuccess("OIDC provider deleted successfully!");
		} catch (err) {
			setError(err instanceof Error ? err.message : "Failed to delete OIDC provider");
		}
	};

	const startEdit = () => {
		if (!provider) return;

		setIsEditing(true);
		setEditData({
			displayName: provider.displayName,
			clientId: provider.clientId,
			clientSecret: "", // Don't pre-fill secret for security
			issuer: provider.issuer,
			redirectUri: provider.redirectUri,
			scopes: provider.scopes,
			enabled: provider.enabled,
		});
	};

	if (isLoading) {
		return (
			<Card>
				<CardHeader>
					<CardTitle>OIDC Provider</CardTitle>
					<CardDescription>Loading OIDC provider...</CardDescription>
				</CardHeader>
			</Card>
		);
	}

	return (
		<Card>
			<CardHeader>
				<CardTitle>OIDC Provider</CardTitle>
				<CardDescription>
					Configure OpenID Connect authentication for single sign-on with any OIDC-compliant provider
					(Authelia, Authentik, Keycloak, etc.).
				</CardDescription>
			</CardHeader>
			<CardContent className="space-y-6">
				{/* Status Messages */}
				{error && (
					<Alert variant="danger">
						<AlertDescription>{error}</AlertDescription>
					</Alert>
				)}
				{success && (
					<Alert variant="success">
						<AlertDescription>{success}</AlertDescription>
					</Alert>
				)}

				{/* No Provider - Show Create Form or Empty State */}
				{!provider && (
					<>
						{showCreateForm ? (
							<div className="space-y-4 rounded-lg border border-white/10 bg-white/5 p-4">
								<h3 className="text-sm font-semibold text-white">Configure OIDC Provider</h3>

								<div className="space-y-3">
									<div>
										<label className="text-xs text-white/60">Display Name</label>
										<Input
											value={formData.displayName}
											onChange={(e) => setFormData({ ...formData, displayName: e.target.value })}
											placeholder="e.g., Authentik SSO"
										/>
										<p className="mt-1 text-xs text-white/40">Friendly name shown on login page</p>
									</div>

									<div>
										<label className="text-xs text-white/60">Issuer URL</label>
										<Input
											value={formData.issuer}
											onChange={(e) => setFormData({ ...formData, issuer: e.target.value })}
											placeholder="https://auth.example.com"
										/>
										<p className="mt-1 text-xs text-white/40">Your OIDC provider&apos;s base URL</p>
									</div>

									<div>
										<label className="text-xs text-white/60">Client ID</label>
										<Input
											value={formData.clientId}
											onChange={(e) => setFormData({ ...formData, clientId: e.target.value })}
											placeholder="OAuth client ID"
										/>
									</div>

									<div>
										<label className="text-xs text-white/60">Client Secret</label>
										<Input
											type="password"
											value={formData.clientSecret}
											onChange={(e) => setFormData({ ...formData, clientSecret: e.target.value })}
											placeholder="OAuth client secret"
										/>
									</div>

									<div>
										<label className="text-xs text-white/60">Redirect URI</label>
										<Input
											value={formData.redirectUri}
											onChange={(e) => setFormData({ ...formData, redirectUri: e.target.value })}
											placeholder={
												typeof window !== "undefined"
													? `${window.location.origin}/auth/oidc/callback`
													: "/auth/oidc/callback"
											}
										/>
										<p className="mt-1 text-xs text-white/40">Leave empty to auto-detect</p>
									</div>

									<div>
										<label className="text-xs text-white/60">Scopes (comma-separated)</label>
										<Input
											value={formData.scopes}
											onChange={(e) => setFormData({ ...formData, scopes: e.target.value })}
											placeholder="openid,email,profile"
										/>
									</div>

									<div className="flex items-center gap-2">
										<input
											type="checkbox"
											checked={formData.enabled}
											onChange={(e) => setFormData({ ...formData, enabled: e.target.checked })}
											className="h-4 w-4 rounded border-white/20 bg-white/5"
										/>
										<label className="text-sm text-white/70">Enable provider</label>
									</div>
								</div>

								<div className="flex gap-2">
									<Button onClick={handleCreate} disabled={createMutation.isPending}>
										{createMutation.isPending ? "Creating..." : "Create Provider"}
									</Button>
									<Button variant="secondary" onClick={() => setShowCreateForm(false)}>
										Cancel
									</Button>
								</div>
							</div>
						) : (
							<div className="rounded-lg border border-white/10 bg-white/5 p-6 text-center">
								<svg
									className="mx-auto h-12 w-12 text-white/20"
									fill="none"
									stroke="currentColor"
									viewBox="0 0 24 24"
								>
									<path
										strokeLinecap="round"
										strokeLinejoin="round"
										strokeWidth={2}
										d="M15 7a2 2 0 012 2m4 0a6 6 0 01-7.743 5.743L11 17H9v2H7v2H4a1 1 0 01-1-1v-2.586a1 1 0 01.293-.707l5.964-5.964A6 6 0 1121 9z"
									/>
								</svg>
								<p className="mt-4 text-sm text-white/60">No OIDC provider configured</p>
								<p className="mt-1 text-xs text-white/40">
									Configure OpenID Connect to enable single sign-on
								</p>
								<Button className="mt-4" onClick={() => setShowCreateForm(true)}>
									Configure OIDC
								</Button>
							</div>
						)}
					</>
				)}

				{/* Provider Exists - Show Details or Edit Form */}
				{provider && (
					<div className="rounded-lg border border-white/10 bg-white/5 p-4">
						{isEditing ? (
							<div className="space-y-3">
								<h3 className="text-sm font-semibold text-white">Edit OIDC Provider</h3>

								<div>
									<label className="text-xs text-white/60">Display Name</label>
									<Input
										value={editData.displayName}
										onChange={(e) => setEditData({ ...editData, displayName: e.target.value })}
									/>
								</div>

								<div>
									<label className="text-xs text-white/60">Issuer URL</label>
									<Input
										value={editData.issuer}
										onChange={(e) => setEditData({ ...editData, issuer: e.target.value })}
									/>
								</div>

								<div>
									<label className="text-xs text-white/60">Client ID</label>
									<Input
										value={editData.clientId}
										onChange={(e) => setEditData({ ...editData, clientId: e.target.value })}
									/>
								</div>

								<div>
									<label className="text-xs text-white/60">
										Client Secret (leave empty to keep current)
									</label>
									<Input
										type="password"
										value={editData.clientSecret}
										onChange={(e) => setEditData({ ...editData, clientSecret: e.target.value })}
										placeholder="Enter new secret to update"
									/>
								</div>

								<div>
									<label className="text-xs text-white/60">Redirect URI</label>
									<Input
										value={editData.redirectUri}
										onChange={(e) => setEditData({ ...editData, redirectUri: e.target.value })}
									/>
								</div>

								<div>
									<label className="text-xs text-white/60">Scopes</label>
									<Input
										value={editData.scopes}
										onChange={(e) => setEditData({ ...editData, scopes: e.target.value })}
									/>
								</div>

								<div className="flex items-center gap-2">
									<input
										type="checkbox"
										checked={editData.enabled}
										onChange={(e) => setEditData({ ...editData, enabled: e.target.checked })}
										className="h-4 w-4 rounded border-white/20 bg-white/5"
									/>
									<label className="text-sm text-white/70">Enable provider</label>
								</div>

								<div className="flex gap-2">
									<Button
										size="sm"
										onClick={handleUpdate}
										disabled={updateMutation.isPending}
									>
										{updateMutation.isPending ? "Saving..." : "Save Changes"}
									</Button>
									<Button size="sm" variant="secondary" onClick={() => setIsEditing(false)}>
										Cancel
									</Button>
								</div>
							</div>
						) : (
							<>
								<div className="flex items-start justify-between">
									<div className="flex-1">
										<div className="flex items-center gap-2">
											<p className="text-sm font-medium text-white">{provider.displayName}</p>
											{!provider.enabled && (
												<span className="rounded bg-red-500/20 px-2 py-0.5 text-xs text-red-300">
													Disabled
												</span>
											)}
										</div>
										<p className="mt-2 text-xs text-white/50">
											<span className="font-medium">Issuer:</span> {provider.issuer}
										</p>
										<p className="mt-1 text-xs text-white/50">
											<span className="font-medium">Client ID:</span> {provider.clientId}
										</p>
										<p className="mt-1 text-xs text-white/50">
											<span className="font-medium">Redirect URI:</span> {provider.redirectUri}
										</p>
										<p className="mt-1 text-xs text-white/50">
											<span className="font-medium">Scopes:</span> {provider.scopes}
										</p>
									</div>
									<div className="flex gap-2">
										<Button
											size="sm"
											variant="secondary"
											onClick={startEdit}
											className="text-white/70 hover:text-white"
										>
											Edit
										</Button>
										<Button
											size="sm"
											variant="secondary"
											onClick={handleDelete}
											disabled={deleteMutation.isPending}
											className="text-red-400 hover:text-red-300"
										>
											{deleteMutation.isPending ? "Deleting..." : "Delete"}
										</Button>
									</div>
								</div>
							</>
						)}
					</div>
				)}
			</CardContent>
		</Card>
	);
};
