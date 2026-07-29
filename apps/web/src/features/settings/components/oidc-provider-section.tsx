"use client";

import { deleteOidcProviderSchema, type UpdateOIDCProvider } from "@arr/shared";
import {
	AlertCircle,
	Check,
	Globe,
	Key,
	Link,
	Loader2,
	Pencil,
	Plus,
	Settings,
	ShieldCheck,
	Trash2,
	X,
} from "lucide-react";
import { useState } from "react";
import { PremiumEmptyState, PremiumSection, PremiumSkeleton } from "../../../components/layout";
import { ToggleSwitch } from "../../../components/layout/config-primitives";
import { Button } from "../../../components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "../../../components/ui/dialog";
import { Input } from "../../../components/ui/input";
import {
	useCreateOIDCProvider,
	useDeleteOIDCProvider,
	useOIDCProvider,
	useUpdateOIDCProvider,
} from "../../../hooks/api/useOIDCProviders";
import { useThemeGradient } from "../../../hooks/useThemeGradient";
import { initiateOIDCLogin } from "../../../lib/api-client/auth";
import { getErrorMessage } from "../../../lib/error-utils";
import { SEMANTIC_COLORS } from "../../../lib/theme-gradients";

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
	const isLinked = providerData?.linked ?? false;

	const [error, setError] = useState<string | null>(null);
	const [success, setSuccess] = useState<string | null>(null);
	const [accountAction, setAccountAction] = useState<"link" | "test" | null>(null);
	const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
	const [replacementPassword, setReplacementPassword] = useState("");
	const [confirmReplacementPassword, setConfirmReplacementPassword] = useState("");
	const [deleteError, setDeleteError] = useState<string | null>(null);
	const isLinking = accountAction !== null;

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

			if (payload.enabled) {
				setSuccess("OIDC provider created. Redirecting you to link the admin account...");
				setAccountAction("link");
				try {
					const authorizationUrl = await initiateOIDCLogin("link");
					window.location.href = authorizationUrl;
				} catch (linkError) {
					setAccountAction(null);
					setError(
						getErrorMessage(
							linkError,
							"Provider was created, but the admin account could not be linked. Use the link button below to try again.",
						),
					);
				}
			} else {
				setSuccess("OIDC provider created successfully!");
			}
		} catch (err) {
			setError(getErrorMessage(err, "Failed to create OIDC provider"));
		}
	};

	const handleAccountAction = async (intent: "link" | "test") => {
		setError(null);
		setSuccess(null);
		setAccountAction(intent);

		try {
			const authorizationUrl = await initiateOIDCLogin(intent);
			window.location.href = authorizationUrl;
		} catch (err) {
			setError(
				getErrorMessage(
					err,
					intent === "link"
						? "Failed to start OIDC account linking"
						: "Failed to start OIDC account test",
				),
			);
			setAccountAction(null);
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

		const validation = deleteOidcProviderSchema.safeParse({ replacementPassword });
		if (!validation.success) {
			setDeleteError(validation.error.issues[0]?.message ?? "Enter a valid fallback password.");
			return;
		}
		if (replacementPassword !== confirmReplacementPassword) {
			setDeleteError("Fallback passwords do not match.");
			return;
		}

		setDeleteError(null);
		try {
			await deleteMutation.mutateAsync(validation.data);
			window.location.href = "/login";
		} catch (err) {
			setDeleteError(getErrorMessage(err, "Failed to delete OIDC provider"));
		}
	};

	const handleDeleteDialogChange = (open: boolean) => {
		if (deleteMutation.isPending) return;
		setDeleteDialogOpen(open);
		if (!open) {
			setReplacementPassword("");
			setConfirmReplacementPassword("");
			setDeleteError(null);
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
					<div className="rounded-xl border border-border/30 bg-muted/10 p-6">
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
										<p className="text-xs text-muted-foreground">
											Friendly name shown on login page
										</p>
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
										<p className="text-xs text-muted-foreground">
											Your OIDC provider&apos;s base URL
										</p>
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
										<ToggleSwitch
											label="Enable provider"
											checked={formData.enabled}
											onChange={(v) => setFormData({ ...formData, enabled: v })}
										/>
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
												{formData.enabled ? "Create & Link Account" : "Create Provider"}
											</>
										)}
									</Button>
									<Button variant="outline" onClick={() => setShowCreateForm(false)}>
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
					</div>
				)}

				{/* Provider Exists - Show Details or Edit Form */}
				{provider && (
					<div className="rounded-xl border border-border/30 bg-muted/10 p-6">
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
										<ToggleSwitch
											label="Enable provider"
											checked={editData.enabled}
											onChange={(v) => setEditData({ ...editData, enabled: v })}
										/>
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
									<Button variant="outline" onClick={() => setIsEditing(false)}>
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
												style={{
													color: provider.enabled
														? SEMANTIC_COLORS.success.from
														: SEMANTIC_COLORS.error.from,
												}}
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
											onClick={() => setDeleteDialogOpen(true)}
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

								<div className="flex flex-col gap-3 rounded-lg border border-border/50 bg-card/30 p-4 sm:flex-row sm:items-center sm:justify-between">
									<div>
										<p className="flex items-center gap-2 text-sm font-medium text-foreground">
											Admin account
											<span
												className="rounded-full px-2 py-0.5 text-xs"
												style={{
													backgroundColor: isLinked
														? SEMANTIC_COLORS.success.bg
														: SEMANTIC_COLORS.warning.bg,
													color: isLinked
														? SEMANTIC_COLORS.success.text
														: SEMANTIC_COLORS.warning.text,
												}}
											>
												{isLinked ? "Linked" : "Not linked"}
											</span>
										</p>
										<p className="text-xs text-muted-foreground">
											{isLinked
												? "An OIDC identity is linked. Test it before relying on this sign-in method. Relinking replaces the current identity and signs out other sessions."
												: "Link this OIDC identity before signing out so it can access the dashboard."}
										</p>
									</div>
									<div className="flex flex-col gap-2 sm:shrink-0 sm:flex-row">
										{isLinked && (
											<Button
												variant="outline"
												onClick={() => handleAccountAction("link")}
												disabled={!provider.enabled || isLinking}
												className="gap-2"
											>
												{accountAction === "link" ? (
													<>
														<Loader2 className="h-4 w-4 animate-spin" />
														Redirecting...
													</>
												) : (
													<>
														<Link className="h-4 w-4" />
														Relink Account
													</>
												)}
											</Button>
										)}
										<Button
											onClick={() => handleAccountAction(isLinked ? "test" : "link")}
											disabled={!provider.enabled || isLinking}
											className="gap-2"
										>
											{accountAction === (isLinked ? "test" : "link") ? (
												<>
													<Loader2 className="h-4 w-4 animate-spin" />
													Redirecting...
												</>
											) : (
												<>
													<Link className="h-4 w-4" />
													{isLinked ? "Test Account" : "Link Account"}
												</>
											)}
										</Button>
									</div>
								</div>
							</div>
						)}
					</div>
				)}
				<Dialog open={deleteDialogOpen} onOpenChange={handleDeleteDialogChange}>
					<DialogContent className="max-w-md">
						<DialogHeader>
							<DialogTitle>Delete OIDC provider?</DialogTitle>
							<DialogDescription>
								Enter a strong fallback password before removing OIDC. Existing passwords are
								preserved, and OIDC-only accounts receive this password. You will be signed out
								afterward.
							</DialogDescription>
						</DialogHeader>
						<div className="space-y-2">
							<label
								htmlFor="oidc-replacement-password"
								className="text-xs font-medium uppercase tracking-wide text-muted-foreground"
							>
								Fallback password
							</label>
							<Input
								id="oidc-replacement-password"
								type="password"
								autoComplete="new-password"
								value={replacementPassword}
								onChange={(event) => setReplacementPassword(event.target.value)}
								disabled={deleteMutation.isPending}
							/>
							<label
								htmlFor="oidc-confirm-replacement-password"
								className="block pt-2 text-xs font-medium uppercase tracking-wide text-muted-foreground"
							>
								Confirm fallback password
							</label>
							<Input
								id="oidc-confirm-replacement-password"
								type="password"
								autoComplete="new-password"
								value={confirmReplacementPassword}
								onChange={(event) => setConfirmReplacementPassword(event.target.value)}
								disabled={deleteMutation.isPending}
							/>
							{deleteError && (
								<p className="text-sm" style={{ color: SEMANTIC_COLORS.error.text }}>
									{deleteError}
								</p>
							)}
						</div>
						<DialogFooter>
							<Button
								variant="outline"
								onClick={() => handleDeleteDialogChange(false)}
								disabled={deleteMutation.isPending}
							>
								Cancel
							</Button>
							<Button
								variant="destructive"
								onClick={handleDelete}
								disabled={
									!replacementPassword || !confirmReplacementPassword || deleteMutation.isPending
								}
							>
								{deleteMutation.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
								Delete and sign out
							</Button>
						</DialogFooter>
					</DialogContent>
				</Dialog>
			</div>
		</PremiumSection>
	);
};
