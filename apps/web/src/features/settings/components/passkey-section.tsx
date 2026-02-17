"use client";

import { useEffect, useState } from "react";
import { startRegistration } from "@simplewebauthn/browser";
import { Key, Fingerprint, Plus, Trash2, Pencil, Check, X, Loader2, ShieldCheck, Calendar } from "lucide-react";
import { Button } from "../../../components/ui/button";
import { Input } from "../../../components/ui/input";
import { PremiumSection, GlassmorphicCard, PremiumEmptyState, PremiumSkeleton } from "../../../components/layout";
import { SEMANTIC_COLORS } from "../../../lib/theme-gradients";
import { useThemeGradient } from "../../../hooks/useThemeGradient";
import {
	getPasskeyCredentials,
	getPasskeyRegistrationOptions,
	verifyPasskeyRegistration,
	deletePasskeyCredential,
	renamePasskeyCredential,
	type PasskeyCredential,
} from "../../../lib/api-client/auth";
import { getErrorMessage } from "../../../lib/error-utils";

/**
 * Premium Passkey Section
 *
 * Passkey management with:
 * - Glassmorphic credential cards
 * - Theme-aware styling
 * - Staggered entrance animations
 * - Premium status feedback
 */
export const PasskeySection = () => {
	const { gradient: themeGradient } = useThemeGradient();

	const [credentials, setCredentials] = useState<PasskeyCredential[]>([]);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const [success, setSuccess] = useState<string | null>(null);
	const [registeringPasskey, setRegisteringPasskey] = useState(false);
	const [passkeyName, setPasskeyName] = useState("");

	// Editing state
	const [editingId, setEditingId] = useState<string | null>(null);
	const [editName, setEditName] = useState("");

	const loadCredentials = async () => {
		try {
			setError(null);
			const creds = await getPasskeyCredentials();
			setCredentials(creds);
		} catch (err) {
			setError(getErrorMessage(err, "Failed to load passkeys"));
		} finally {
			setLoading(false);
		}
	};

	useEffect(() => {
		loadCredentials().catch((err) => {
			console.error("Failed to load passkey credentials:", err);
			setError("Failed to load passkeys. Please refresh the page.");
		});
	}, []);

	const handleRegisterPasskey = async () => {
		setError(null);
		setSuccess(null);
		setRegisteringPasskey(true);

		try {
			const options = await getPasskeyRegistrationOptions(passkeyName || undefined);
			const registrationResponse = await startRegistration({ optionsJSON: options });
			await verifyPasskeyRegistration(registrationResponse, passkeyName || undefined);

			setSuccess("Passkey registered successfully!");
			setPasskeyName("");
			await loadCredentials();
		} catch (err) {
			setError(
				getErrorMessage(err, "Failed to register passkey. Make sure your device supports passkeys.")
			);
		} finally {
			setRegisteringPasskey(false);
		}
	};

	const handleDeletePasskey = async (credentialId: string) => {
		if (!confirm("Are you sure you want to delete this passkey?")) {
			return;
		}

		setError(null);
		setSuccess(null);

		try {
			await deletePasskeyCredential(credentialId);
			setSuccess("Passkey deleted successfully!");
			await loadCredentials();
		} catch (err) {
			setError(getErrorMessage(err, "Failed to delete passkey"));
		}
	};

	const startEdit = (credential: PasskeyCredential) => {
		setEditingId(credential.id);
		setEditName(credential.friendlyName || "");
	};

	const cancelEdit = () => {
		setEditingId(null);
		setEditName("");
	};

	const saveEdit = async (credentialId: string) => {
		if (!editName.trim()) {
			setError("Passkey name cannot be empty");
			return;
		}

		setError(null);
		setSuccess(null);

		try {
			await renamePasskeyCredential(credentialId, editName.trim());
			setSuccess("Passkey renamed successfully!");
			setEditingId(null);
			setEditName("");
			await loadCredentials();
		} catch (err) {
			setError(getErrorMessage(err, "Failed to rename passkey"));
		}
	};

	const formatDate = (dateString: string) => {
		const date = new Date(dateString);
		return date.toLocaleDateString(undefined, {
			year: "numeric",
			month: "short",
			day: "numeric",
		});
	};

	if (loading) {
		return (
			<PremiumSection
				title="Passkeys"
				description="Loading passkey credentials..."
				icon={Fingerprint}
			>
				<div className="space-y-4">
					<PremiumSkeleton className="h-24" />
					<PremiumSkeleton className="h-20" />
				</div>
			</PremiumSection>
		);
	}

	return (
		<PremiumSection
			title="Passkeys"
			description="Manage your passkey credentials for passwordless authentication. Passkeys use your device's biometrics or PIN."
			icon={Fingerprint}
		>
			<div className="space-y-6">
				{/* Register New Passkey */}
				<GlassmorphicCard padding="lg">
					<div className="space-y-4">
						<div className="flex items-center gap-3">
							<div
								className="flex h-10 w-10 items-center justify-center rounded-xl shrink-0"
								style={{
									background: `linear-gradient(135deg, ${themeGradient.from}20, ${themeGradient.to}20)`,
									border: `1px solid ${themeGradient.from}30`,
								}}
							>
								<Plus className="h-5 w-5" style={{ color: themeGradient.from }} />
							</div>
							<div>
								<h3 className="font-semibold text-foreground">Register New Passkey</h3>
								<p className="text-xs text-muted-foreground">
									You&apos;ll be prompted to use your device&apos;s biometric authentication or security key.
								</p>
							</div>
						</div>

						<div className="flex gap-3">
							<Input
								value={passkeyName}
								onChange={(e) => setPasskeyName(e.target.value)}
								placeholder="Passkey name (e.g., iPhone, YubiKey)"
								disabled={registeringPasskey}
								className="flex-1 bg-card/30 border-border/50"
							/>
							<Button
								onClick={handleRegisterPasskey}
								disabled={registeringPasskey}
								className="gap-2 shrink-0"
								style={{
									background: `linear-gradient(135deg, ${themeGradient.from}, ${themeGradient.to})`,
									boxShadow: `0 4px 12px -4px ${themeGradient.glow}`,
								}}
							>
								{registeringPasskey ? (
									<>
										<Loader2 className="h-4 w-4 animate-spin" />
										Registering...
									</>
								) : (
									<>
										<Fingerprint className="h-4 w-4" />
										Add Passkey
									</>
								)}
							</Button>
						</div>
					</div>
				</GlassmorphicCard>

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

				{/* Existing Passkeys */}
				<GlassmorphicCard padding="lg">
					<div className="space-y-4">
						<div className="flex items-center gap-3">
							<div
								className="flex h-10 w-10 items-center justify-center rounded-xl shrink-0"
								style={{
									background: `linear-gradient(135deg, ${themeGradient.from}20, ${themeGradient.to}20)`,
									border: `1px solid ${themeGradient.from}30`,
								}}
							>
								<Key className="h-5 w-5" style={{ color: themeGradient.from }} />
							</div>
							<div>
								<h3 className="font-semibold text-foreground">Your Passkeys</h3>
								<p className="text-xs text-muted-foreground">
									{credentials.length} passkey{credentials.length !== 1 ? "s" : ""} registered
								</p>
							</div>
						</div>

						{credentials.length > 0 ? (
							<div className="space-y-3">
								{credentials.map((credential, index) => (
									<div
										key={credential.id}
										className="flex items-center justify-between rounded-xl border border-border/50 bg-card/30 backdrop-blur-xs p-4 transition-all duration-300 hover:border-border/80 animate-in fade-in slide-in-from-bottom-2"
										style={{
											animationDelay: `${index * 50}ms`,
											animationFillMode: "backwards",
										}}
									>
										<div className="flex-1 min-w-0">
											{editingId === credential.id ? (
												<div className="flex gap-2">
													<Input
														value={editName}
														onChange={(e) => setEditName(e.target.value)}
														placeholder="Passkey name"
														className="max-w-xs bg-card/30 border-border/50"
													/>
													<Button
														size="sm"
														onClick={() => saveEdit(credential.id)}
														className="gap-1.5"
														style={{
															background: `linear-gradient(135deg, ${themeGradient.from}, ${themeGradient.to})`,
														}}
													>
														<Check className="h-3.5 w-3.5" />
														Save
													</Button>
													<Button
														size="sm"
														variant="outline"
														onClick={cancelEdit}
													>
														Cancel
													</Button>
												</div>
											) : (
												<>
													<div className="flex items-center gap-2">
														<div
															className="flex h-8 w-8 items-center justify-center rounded-lg shrink-0"
															style={{
																background: `linear-gradient(135deg, ${themeGradient.from}15, ${themeGradient.to}15)`,
																border: `1px solid ${themeGradient.from}20`,
															}}
														>
															<Key className="h-4 w-4" style={{ color: themeGradient.from }} />
														</div>
														<p className="text-sm font-medium text-foreground truncate">
															{credential.friendlyName || "Unnamed Passkey"}
														</p>
														{credential.backedUp && (
															<span
																className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium shrink-0"
																style={{
																	backgroundColor: SEMANTIC_COLORS.success.bg,
																	color: SEMANTIC_COLORS.success.text,
																	border: `1px solid ${SEMANTIC_COLORS.success.border}`,
																}}
															>
																<ShieldCheck className="h-3 w-3" />
																Backed Up
															</span>
														)}
													</div>
													<p className="mt-1.5 text-xs text-muted-foreground flex items-center gap-3">
														<span className="flex items-center gap-1">
															<Calendar className="h-3 w-3" />
															Created: {formatDate(credential.createdAt)}
														</span>
														<span>
															Last used: {formatDate(credential.lastUsedAt)}
														</span>
													</p>
												</>
											)}
										</div>

										{editingId !== credential.id && (
											<div className="flex gap-2 shrink-0 ml-4">
												<Button
													size="sm"
													variant="ghost"
													onClick={() => startEdit(credential)}
													className="gap-1.5 text-muted-foreground hover:text-foreground"
												>
													<Pencil className="h-3.5 w-3.5" />
													Rename
												</Button>
												<Button
													size="sm"
													variant="ghost"
													onClick={() => handleDeletePasskey(credential.id)}
													className="gap-1.5"
													style={{ color: SEMANTIC_COLORS.error.text }}
												>
													<Trash2 className="h-3.5 w-3.5" />
													Delete
												</Button>
											</div>
										)}
									</div>
								))}
							</div>
						) : (
							<PremiumEmptyState
								icon={Fingerprint}
								title="No passkeys registered yet"
								description="Add a passkey above to enable passwordless sign-in"
							/>
						)}
					</div>
				</GlassmorphicCard>
			</div>
		</PremiumSection>
	);
};
