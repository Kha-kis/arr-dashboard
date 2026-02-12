"use client";

import { useState } from "react";
import type { UpdateOIDCProvider } from "@arr/shared";
import {
	ShieldCheck,
	Plus,
	Settings,
	Link,
	Key,
	Globe,
	Pencil,
	Trash2,
	Check,
	X,
	Loader2,
	AlertCircle,
} from "lucide-react";
import { Button } from "../../../components/ui/button";
import { Input } from "../../../components/ui/input";
import { PremiumSection, GlassmorphicCard, PremiumEmptyState, PremiumSkeleton } from "../../../components/layout";
import { SEMANTIC_COLORS } from "../../../lib/theme-gradients";
import { useThemeGradient } from "../../../hooks/useThemeGradient";
import {
	useOIDCProvider,
	useCreateOIDCProvider,
	useUpdateOIDCProvider,
	useDeleteOIDCProvider,
} from "../../../hooks/api/useOIDCProviders";
import { getErrorMessage } from "../../../lib/error-utils";

/**
 * Premium OIDC Provider Section
 *
 * OIDC configuration with:
 * - Glassmorphic form containers
 * - Theme-aware styling
 * - Premium status feedback
 * - Staggered animations
 */
export const OIDCProviderSection = () => {
	const { gradient: themeGradient } = useThemeGradient();

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
			const { redirectUri, ...rest } = formData;
			const payload = {
				...rest,
				...(redirectUri.trim() ? { redirectUri: redirectUri.trim() } : {}),
			};

			await createMutation.mutateAsync(payload);
			setSuccess("OIDC provider created successfully!");
			setShowCreateForm(false);
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
			setError(getErrorMessage(err, "Failed to create OIDC provider"));
		}
	};

	const handleUpdate = async () => {
		if (!provider) return;

		setError(null);
		setSuccess(null);

		try {
			const updatePayload: UpdateOIDCProvider = {};
			if (editData.displayName) updatePayload.displayName = editData.displayName;
			if (editData.clientId) updatePayload.clientId = editData.clientId;
			if (editData.clientSecret) updatePayload.clientSecret = editData.clientSecret;
			if (editData.issuer) updatePayload.issuer = editData.issuer;
			if (editData.redirectUri?.trim()) updatePayload.redirectUri = editData.redirectUri.trim();
			if (editData.scopes) updatePayload.scopes = editData.scopes;
			updatePayload.enabled = editData.enabled;

			await updateMutation.mutateAsync(updatePayload);
			setSuccess("OIDC provider updated successfully!");
			setIsEditing(false);
		} catch (err) {
			setError(getErrorMessage(err, "Failed to update OIDC provider"));
		}
	};

	const handleDelete = async () => {
		if (!provider) return;

		if (!confirm("Are you sure you want to delete this OIDC provider?")) {
			return;
		}

		setError(null);
		setSuccess(null);

		try {
			await deleteMutation.mutateAsync();
			setSuccess("OIDC provider deleted successfully!");
		} catch (err) {
			setError(getErrorMessage(err, "Failed to delete OIDC provider"));
		}
	};

	const startEdit = () => {
		if (!provider) return;

		setIsEditing(true);
		setEditData({
			displayName: provider.displayName,
			clientId: provider.clientId,
			clientSecret: "",
			issuer: provider.issuer,
			redirectUri: provider.redirectUri,
			scopes: provider.scopes,
			enabled: provider.enabled,
		});
	};

	if (isLoading) {
		return (
			<PremiumSection
				title="OIDC Provider"
				description="Loading OIDC configuration..."
				icon={ShieldCheck}
			>
				<div className="space-y-4">
					<PremiumSkeleton className="h-32" />
				</div>
			</PremiumSection>
		);
	}

	return (
		<PremiumSection
			title="OIDC Provider"
			description="Configure OpenID Connect authentication for single sign-on with any OIDC-compliant provider (Authelia, Authentik, Keycloak, etc.)."
			icon={ShieldCheck}
		>
			<div className="space-y-6">
				{/* Status Messages */}
				{error && (
					<div
						className="flex items-center gap-2 rounded-xl px-4 py-3 text-sm animate-in fade-in slide-in-from-bottom-2"
						style={{
							backgroundColor: SEMANTIC_COLORS.error.bg,
							border: `1px solid ${SEMANTIC_COLORS.error.border}`,
							color: SEMANTIC_COLORS.error.text,
						}}
					>
						<X className="h-4 w-4 shrink-0" />
						<span>{error}</span>
					</div>
				)}

				{success && (
					<div
						className="flex items-center gap-2 rounded-xl px-4 py-3 text-sm animate-in fade-in slide-in-from-bottom-2"
						style={{
							backgroundColor: SEMANTIC_COLORS.success.bg,
							border: `1px solid ${SEMANTIC_COLORS.success.border}`,
							color: SEMANTIC_COLORS.success.text,
						}}
					>
						<Check className="h-4 w-4 shrink-0" />
						<span>{success}</span>
					</div>
				)}

				{/* No Provider - Show Create Form or Empty State */}
				{!provider && (
					<GlassmorphicCard padding="lg">
						{showCreateForm ? (
							<div className="space-y-6">
								<div className="flex items-center gap-3">
									<div
										className="flex h-10 w-10 items-center justify-center rounded-xl shrink-0"
										style={{
											background: `linear-gradient(135deg, ${themeGradient.from}20, ${themeGradient.to}20)`,
											border: `1px solid ${themeGradient.from}30`,
										}}
									>
										<Settings className="h-5 w-5" style={{ color: themeGradient.from }} />
									</div>
									<div>
										<h3 className="font-semibold text-foreground">Configure OIDC Provider</h3>
										<p className="text-xs text-muted-foreground">
											Enter your OIDC provider details below
										</p>
									</div>
								</div>

								<div className="grid gap-4 sm:grid-cols-2">
									<div className="space-y-2 sm:col-span-2">
										<label className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
											Display Name
										</label>
										<Input
											value={formData.displayName}
											onChange={(e) => setFormData({ ...formData, displayName: e.target.value })}
											placeholder="e.g., Authentik SSO"
											className="bg-card/30 border-border/50"
										/>
										<p className="text-xs text-muted-foreground">Friendly name shown on login page</p>
									</div>

									<div className="space-y-2 sm:col-span-2">
										<label className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
											Issuer URL
										</label>
										<Input
											value={formData.issuer}
											onChange={(e) => setFormData({ ...formData, issuer: e.target.value })}
											placeholder="https://auth.example.com"
											className="bg-card/30 border-border/50"
										/>
										<p className="text-xs text-muted-foreground">Your OIDC provider&apos;s base URL</p>
									</div>

									<div className="space-y-2">
										<label className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
											Client ID
										</label>
										<Input
											value={formData.clientId}
											onChange={(e) => setFormData({ ...formData, clientId: e.target.value })}
											placeholder="OAuth client ID"
											className="bg-card/30 border-border/50"
										/>
									</div>

									<div className="space-y-2">
										<label className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
											Client Secret
										</label>
										<Input
											type="password"
											value={formData.clientSecret}
											onChange={(e) => setFormData({ ...formData, clientSecret: e.target.value })}
											placeholder="OAuth client secret"
											className="bg-card/30 border-border/50"
										/>
									</div>

									<div className="space-y-2 sm:col-span-2">
										<label className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
											Redirect URI
										</label>
										<Input
											value={formData.redirectUri}
											onChange={(e) => setFormData({ ...formData, redirectUri: e.target.value })}
											placeholder={
												typeof window !== "undefined"
													? `${window.location.origin}/auth/oidc/callback`
													: "/auth/oidc/callback"
											}
											className="bg-card/30 border-border/50"
										/>
										<p className="text-xs text-muted-foreground">Leave empty to auto-detect</p>
									</div>

									<div className="space-y-2 sm:col-span-2">
										<label className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
											Scopes (comma-separated)
										</label>
										<Input
											value={formData.scopes}
											onChange={(e) => setFormData({ ...formData, scopes: e.target.value })}
											placeholder="openid,email,profile"
											className="bg-card/30 border-border/50"
										/>
									</div>

									<div className="sm:col-span-2">
										<label className="flex items-center gap-2 cursor-pointer">
											<input
												type="checkbox"
												checked={formData.enabled}
												onChange={(e) => setFormData({ ...formData, enabled: e.target.checked })}
												className="h-4 w-4 rounded border-border bg-card/30"
											/>
											<span className="text-sm text-foreground">Enable provider</span>
										</label>
									</div>
								</div>

								<div className="flex gap-3">
									<Button
										onClick={handleCreate}
										disabled={createMutation.isPending}
										className="gap-2"
										style={{
											background: `linear-gradient(135deg, ${themeGradient.from}, ${themeGradient.to})`,
											boxShadow: `0 4px 12px -4px ${themeGradient.glow}`,
										}}
									>
										{createMutation.isPending ? (
											<>
												<Loader2 className="h-4 w-4 animate-spin" />
												Creating...
											</>
										) : (
											<>
												<Plus className="h-4 w-4" />
												Create Provider
											</>
										)}
									</Button>
									<Button
										variant="outline"
										onClick={() => setShowCreateForm(false)}
									>
										Cancel
									</Button>
								</div>
							</div>
						) : (
							<PremiumEmptyState
								icon={ShieldCheck}
								title="No OIDC provider configured"
								description="Configure OpenID Connect to enable single sign-on"
								action={
									<Button
										onClick={() => setShowCreateForm(true)}
										className="gap-2 mt-4"
										style={{
											background: `linear-gradient(135deg, ${themeGradient.from}, ${themeGradient.to})`,
											boxShadow: `0 4px 12px -4px ${themeGradient.glow}`,
										}}
									>
										<Settings className="h-4 w-4" />
										Configure OIDC
									</Button>
								}
							/>
						)}
					</GlassmorphicCard>
				)}

				{/* Provider Exists - Show Details or Edit Form */}
				{provider && (
					<GlassmorphicCard padding="lg">
						{isEditing ? (
							<div className="space-y-6">
								<div className="flex items-center gap-3">
									<div
										className="flex h-10 w-10 items-center justify-center rounded-xl shrink-0"
										style={{
											background: `linear-gradient(135deg, ${themeGradient.from}20, ${themeGradient.to}20)`,
											border: `1px solid ${themeGradient.from}30`,
										}}
									>
										<Pencil className="h-5 w-5" style={{ color: themeGradient.from }} />
									</div>
									<div>
										<h3 className="font-semibold text-foreground">Edit OIDC Provider</h3>
										<p className="text-xs text-muted-foreground">Update your OIDC configuration</p>
									</div>
								</div>

								<div className="grid gap-4 sm:grid-cols-2">
									<div className="space-y-2 sm:col-span-2">
										<label className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
											Display Name
										</label>
										<Input
											value={editData.displayName}
											onChange={(e) => setEditData({ ...editData, displayName: e.target.value })}
											className="bg-card/30 border-border/50"
										/>
									</div>

									<div className="space-y-2 sm:col-span-2">
										<label className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
											Issuer URL
										</label>
										<Input
											value={editData.issuer}
											onChange={(e) => setEditData({ ...editData, issuer: e.target.value })}
											className="bg-card/30 border-border/50"
										/>
									</div>

									<div className="space-y-2">
										<label className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
											Client ID
										</label>
										<Input
											value={editData.clientId}
											onChange={(e) => setEditData({ ...editData, clientId: e.target.value })}
											className="bg-card/30 border-border/50"
										/>
									</div>

									<div className="space-y-2">
										<label className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
											Client Secret
										</label>
										<Input
											type="password"
											value={editData.clientSecret}
											onChange={(e) => setEditData({ ...editData, clientSecret: e.target.value })}
											placeholder="Enter new secret to update"
											className="bg-card/30 border-border/50"
										/>
										<p className="text-xs text-muted-foreground">Leave empty to keep current</p>
									</div>

									<div className="space-y-2 sm:col-span-2">
										<label className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
											Redirect URI
										</label>
										<Input
											value={editData.redirectUri}
											onChange={(e) => setEditData({ ...editData, redirectUri: e.target.value })}
											className="bg-card/30 border-border/50"
										/>
									</div>

									<div className="space-y-2 sm:col-span-2">
										<label className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
											Scopes
										</label>
										<Input
											value={editData.scopes}
											onChange={(e) => setEditData({ ...editData, scopes: e.target.value })}
											className="bg-card/30 border-border/50"
										/>
									</div>

									<div className="sm:col-span-2">
										<label className="flex items-center gap-2 cursor-pointer">
											<input
												type="checkbox"
												checked={editData.enabled}
												onChange={(e) => setEditData({ ...editData, enabled: e.target.checked })}
												className="h-4 w-4 rounded border-border bg-card/30"
											/>
											<span className="text-sm text-foreground">Enable provider</span>
										</label>
									</div>
								</div>

								<div className="flex gap-3">
									<Button
										onClick={handleUpdate}
										disabled={updateMutation.isPending}
										className="gap-2"
										style={{
											background: `linear-gradient(135deg, ${themeGradient.from}, ${themeGradient.to})`,
											boxShadow: `0 4px 12px -4px ${themeGradient.glow}`,
										}}
									>
										{updateMutation.isPending ? (
											<>
												<Loader2 className="h-4 w-4 animate-spin" />
												Saving...
											</>
										) : (
											<>
												<Check className="h-4 w-4" />
												Save Changes
											</>
										)}
									</Button>
									<Button
										variant="outline"
										onClick={() => setIsEditing(false)}
									>
										Cancel
									</Button>
								</div>
							</div>
						) : (
							<div className="space-y-4">
								<div className="flex items-start justify-between">
									<div className="flex items-center gap-3">
										<div
											className="flex h-10 w-10 items-center justify-center rounded-xl shrink-0"
											style={{
												background: provider.enabled
													? `linear-gradient(135deg, ${SEMANTIC_COLORS.success.from}20, ${SEMANTIC_COLORS.success.to}20)`
													: `linear-gradient(135deg, ${SEMANTIC_COLORS.error.from}20, ${SEMANTIC_COLORS.error.to}20)`,
												border: `1px solid ${provider.enabled ? SEMANTIC_COLORS.success.from : SEMANTIC_COLORS.error.from}30`,
											}}
										>
											<ShieldCheck
												className="h-5 w-5"
												style={{ color: provider.enabled ? SEMANTIC_COLORS.success.from : SEMANTIC_COLORS.error.from }}
											/>
										</div>
										<div>
											<div className="flex items-center gap-2">
												<h3 className="font-semibold text-foreground">{provider.displayName}</h3>
												{!provider.enabled && (
													<span
														className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium"
														style={{
															backgroundColor: SEMANTIC_COLORS.error.bg,
															color: SEMANTIC_COLORS.error.text,
															border: `1px solid ${SEMANTIC_COLORS.error.border}`,
														}}
													>
														<AlertCircle className="h-3 w-3" />
														Disabled
													</span>
												)}
											</div>
											<p className="text-xs text-muted-foreground">OpenID Connect provider</p>
										</div>
									</div>
									<div className="flex gap-2">
										<Button
											size="sm"
											variant="ghost"
											onClick={startEdit}
											className="gap-1.5 text-muted-foreground hover:text-foreground"
										>
											<Pencil className="h-3.5 w-3.5" />
											Edit
										</Button>
										<Button
											size="sm"
											variant="ghost"
											onClick={handleDelete}
											disabled={deleteMutation.isPending}
											className="gap-1.5"
											style={{ color: SEMANTIC_COLORS.error.text }}
										>
											{deleteMutation.isPending ? (
												<Loader2 className="h-3.5 w-3.5 animate-spin" />
											) : (
												<Trash2 className="h-3.5 w-3.5" />
											)}
											Delete
										</Button>
									</div>
								</div>

								<div className="grid gap-3 sm:grid-cols-2 text-sm">
									<div className="flex items-center gap-2 rounded-lg border border-border/50 bg-card/30 p-3">
										<Globe className="h-4 w-4 text-muted-foreground shrink-0" />
										<div className="min-w-0">
											<p className="text-xs text-muted-foreground">Issuer</p>
											<p className="text-foreground truncate">{provider.issuer}</p>
										</div>
									</div>
									<div className="flex items-center gap-2 rounded-lg border border-border/50 bg-card/30 p-3">
										<Key className="h-4 w-4 text-muted-foreground shrink-0" />
										<div className="min-w-0">
											<p className="text-xs text-muted-foreground">Client ID</p>
											<p className="text-foreground truncate">{provider.clientId}</p>
										</div>
									</div>
									<div className="flex items-center gap-2 rounded-lg border border-border/50 bg-card/30 p-3 sm:col-span-2">
										<Link className="h-4 w-4 text-muted-foreground shrink-0" />
										<div className="min-w-0">
											<p className="text-xs text-muted-foreground">Redirect URI</p>
											<p className="text-foreground truncate">{provider.redirectUri}</p>
										</div>
									</div>
									<div className="flex items-center gap-2 rounded-lg border border-border/50 bg-card/30 p-3 sm:col-span-2">
										<Settings className="h-4 w-4 text-muted-foreground shrink-0" />
										<div className="min-w-0">
											<p className="text-xs text-muted-foreground">Scopes</p>
											<p className="text-foreground">{provider.scopes}</p>
										</div>
									</div>
								</div>
							</div>
						)}
					</GlassmorphicCard>
				)}
			</div>
		</PremiumSection>
	);
};
