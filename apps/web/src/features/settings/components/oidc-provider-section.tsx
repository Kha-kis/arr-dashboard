"use client";

import { useState } from "react";
import type { OIDCProviderType } from "@arr/shared";
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
	useOIDCProviders,
	useCreateOIDCProvider,
	useUpdateOIDCProvider,
	useDeleteOIDCProvider,
} from "../../../hooks/api/useOIDCProviders";

const PROVIDER_DISPLAY_NAMES: Record<OIDCProviderType, string> = {
	authelia: "Authelia",
	authentik: "Authentik",
	generic: "Generic OIDC",
};

/**
 * OIDC Provider management section for admin settings
 */
export const OIDCProviderSection = () => {
	const { data: providers, isLoading } = useOIDCProviders();
	const createMutation = useCreateOIDCProvider();
	const updateMutation = useUpdateOIDCProvider();
	const deleteMutation = useDeleteOIDCProvider();

	const [error, setError] = useState<string | null>(null);
	const [success, setSuccess] = useState<string | null>(null);

	// Form state for creating new provider
	const [showCreateForm, setShowCreateForm] = useState(false);
	const [formData, setFormData] = useState({
		type: "generic" as OIDCProviderType,
		displayName: "",
		clientId: "",
		clientSecret: "",
		issuer: "",
		redirectUri: "",
		scopes: "openid,email,profile",
		enabled: true,
	});

	// Editing state
	const [editingId, setEditingId] = useState<string | null>(null);
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
			await createMutation.mutateAsync(formData);
			setSuccess("OIDC provider created successfully!");
			setShowCreateForm(false);
			// Reset form
			setFormData({
				type: "generic",
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

	const handleUpdate = async (id: string) => {
		setError(null);
		setSuccess(null);

		try {
			// Only send fields that were provided
			const updatePayload: any = {};
			if (editData.displayName) updatePayload.displayName = editData.displayName;
			if (editData.clientId) updatePayload.clientId = editData.clientId;
			if (editData.clientSecret) updatePayload.clientSecret = editData.clientSecret;
			if (editData.issuer) updatePayload.issuer = editData.issuer;
			if (editData.redirectUri) updatePayload.redirectUri = editData.redirectUri;
			if (editData.scopes) updatePayload.scopes = editData.scopes;
			updatePayload.enabled = editData.enabled;

			await updateMutation.mutateAsync({ id, data: updatePayload });
			setSuccess("OIDC provider updated successfully!");
			setEditingId(null);
		} catch (err) {
			setError(err instanceof Error ? err.message : "Failed to update OIDC provider");
		}
	};

	const handleDelete = async (id: string) => {
		if (!confirm("Are you sure you want to delete this OIDC provider?")) {
			return;
		}

		setError(null);
		setSuccess(null);

		try {
			await deleteMutation.mutateAsync(id);
			setSuccess("OIDC provider deleted successfully!");
		} catch (err) {
			setError(err instanceof Error ? err.message : "Failed to delete OIDC provider");
		}
	};

	const startEdit = (provider: any) => {
		setEditingId(provider.id);
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
					<CardTitle>OIDC Providers</CardTitle>
					<CardDescription>Loading OIDC providers...</CardDescription>
				</CardHeader>
			</Card>
		);
	}

	return (
		<Card>
			<CardHeader>
				<CardTitle>OIDC Providers</CardTitle>
				<CardDescription>
					Configure external authentication providers for single sign-on. Users can authenticate
					using Authelia, Authentik, or any OpenID Connect-compliant provider.
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

				{/* Create New Provider Button */}
				{!showCreateForm && (
					<Button onClick={() => setShowCreateForm(true)}>Add OIDC Provider</Button>
				)}

				{/* Create Form */}
				{showCreateForm && (
					<div className="space-y-4 rounded-lg border border-border bg-bg-subtle p-4">
						<h3 className="text-sm font-semibold text-fg">New OIDC Provider</h3>

						<div className="space-y-3">
							<div>
								<label className="text-xs text-fg-muted">Provider Type</label>
								<select
									value={formData.type}
									onChange={(e) =>
										setFormData({ ...formData, type: e.target.value as OIDCProviderType })
									}
									className="w-full rounded-xl border border-border bg-bg-subtle px-4 py-3 text-sm text-fg transition-all duration-200 hover:border-border/80 hover:bg-bg-subtle/80 focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20 focus:bg-bg-subtle/80"
								>
									<option value="authelia">Authelia</option>
									<option value="authentik">Authentik</option>
									<option value="generic">Generic OIDC</option>
								</select>
							</div>

							<div>
								<label className="text-xs text-fg-muted">Display Name</label>
								<Input
									value={formData.displayName}
									onChange={(e) => setFormData({ ...formData, displayName: e.target.value })}
									placeholder="e.g., My Auth Server"
								/>
							</div>

							<div>
								<label className="text-xs text-fg-muted">Client ID</label>
								<Input
									value={formData.clientId}
									onChange={(e) => setFormData({ ...formData, clientId: e.target.value })}
									placeholder="OAuth client ID"
								/>
							</div>

							<div>
								<label className="text-xs text-fg-muted">Client Secret</label>
								<Input
									type="password"
									value={formData.clientSecret}
									onChange={(e) => setFormData({ ...formData, clientSecret: e.target.value })}
									placeholder="OAuth client secret"
								/>
							</div>

							<div>
								<label className="text-xs text-fg-muted">Issuer URL</label>
								<Input
									value={formData.issuer}
									onChange={(e) => setFormData({ ...formData, issuer: e.target.value })}
									placeholder="https://auth.example.com"
								/>
							</div>

							<div>
								<label className="text-xs text-fg-muted">Redirect URI</label>
								<Input
									value={formData.redirectUri}
									onChange={(e) => setFormData({ ...formData, redirectUri: e.target.value })}
									placeholder="https://your-dashboard.com/auth/oidc/callback"
								/>
							</div>

							<div>
								<label className="text-xs text-fg-muted">Scopes (comma-separated)</label>
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
									className="h-4 w-4 rounded border-border bg-bg-subtle"
								/>
								<label className="text-sm text-fg-muted">Enable provider</label>
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
				)}

				{/* Existing Providers */}
				{providers && providers.length > 0 ? (
					<div className="space-y-4">
						<h3 className="text-sm font-semibold text-fg">Configured Providers</h3>
						<div className="space-y-3">
							{providers.map((provider) => (
								<div
									key={provider.id}
									className="rounded-lg border border-border bg-bg-subtle p-4"
								>
									{editingId === provider.id ? (
										<div className="space-y-3">
											<div>
												<label className="text-xs text-fg-muted">Display Name</label>
												<Input
													value={editData.displayName}
													onChange={(e) => setEditData({ ...editData, displayName: e.target.value })}
												/>
											</div>

											<div>
												<label className="text-xs text-fg-muted">Client ID</label>
												<Input
													value={editData.clientId}
													onChange={(e) => setEditData({ ...editData, clientId: e.target.value })}
												/>
											</div>

											<div>
												<label className="text-xs text-fg-muted">
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
												<label className="text-xs text-fg-muted">Issuer URL</label>
												<Input
													value={editData.issuer}
													onChange={(e) => setEditData({ ...editData, issuer: e.target.value })}
												/>
											</div>

											<div>
												<label className="text-xs text-fg-muted">Redirect URI</label>
												<Input
													value={editData.redirectUri}
													onChange={(e) => setEditData({ ...editData, redirectUri: e.target.value })}
												/>
											</div>

											<div>
												<label className="text-xs text-fg-muted">Scopes</label>
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
													className="h-4 w-4 rounded border-border bg-bg-subtle"
												/>
												<label className="text-sm text-fg-muted">Enable provider</label>
											</div>

											<div className="flex gap-2">
												<Button
													size="sm"
													onClick={() => handleUpdate(provider.id)}
													disabled={updateMutation.isPending}
												>
													{updateMutation.isPending ? "Saving..." : "Save"}
												</Button>
												<Button size="sm" variant="secondary" onClick={() => setEditingId(null)}>
													Cancel
												</Button>
											</div>
										</div>
									) : (
										<>
											<div className="flex items-start justify-between">
												<div className="flex-1">
													<div className="flex items-center gap-2">
														<p className="text-sm font-medium text-fg">{provider.displayName}</p>
														<span className="rounded bg-blue-500/20 px-2 py-0.5 text-xs text-blue-300">
															{PROVIDER_DISPLAY_NAMES[provider.type as OIDCProviderType]}
														</span>
														{!provider.enabled && (
															<span className="rounded bg-red-500/20 px-2 py-0.5 text-xs text-red-300">
																Disabled
															</span>
														)}
													</div>
													<p className="mt-1 text-xs text-fg-muted">Issuer: {provider.issuer}</p>
													<p className="text-xs text-fg-muted">Client ID: {provider.clientId}</p>
												</div>
												<div className="flex gap-2">
													<Button
														size="sm"
														variant="secondary"
														onClick={() => startEdit(provider)}
														className="text-fg-muted hover:text-fg"
													>
														Edit
													</Button>
													<Button
														size="sm"
														variant="secondary"
														onClick={() => handleDelete(provider.id)}
														disabled={deleteMutation.isPending}
														className="text-red-400 hover:text-red-300"
													>
														Delete
													</Button>
												</div>
											</div>
										</>
									)}
								</div>
							))}
						</div>
					</div>
				) : (
					!showCreateForm && (
						<div className="rounded-lg border border-border bg-bg-subtle p-6 text-center">
							<svg
								className="mx-auto h-12 w-12 text-fg-muted"
								fill="none"
								stroke="currentColor"
								viewBox="0 0 24 24"
							>
								<path
									strokeLinecap="round"
									strokeLinejoin="round"
									strokeWidth={2}
									d="M13 10V3L4 14h7v7l9-11h-7z"
								/>
							</svg>
							<p className="mt-4 text-sm text-fg-muted">No OIDC providers configured</p>
							<p className="mt-1 text-xs text-fg-muted">
								Add an OIDC provider to enable external authentication
							</p>
						</div>
					)
				)}
			</CardContent>
		</Card>
	);
};
