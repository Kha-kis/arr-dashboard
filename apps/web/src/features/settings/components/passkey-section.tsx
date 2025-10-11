"use client";

import { useEffect, useState } from "react";
import { startRegistration } from "@simplewebauthn/browser";
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
	getPasskeyCredentials,
	getPasskeyRegistrationOptions,
	verifyPasskeyRegistration,
	deletePasskeyCredential,
	renamePasskeyCredential,
	type PasskeyCredential,
} from "../../../lib/api-client/auth";

/**
 * Passkey management section for account settings
 */
export const PasskeySection = () => {
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
			setError(err instanceof Error ? err.message : "Failed to load passkeys");
		} finally {
			setLoading(false);
		}
	};

	useEffect(() => {
		loadCredentials();
	}, []);

	const handleRegisterPasskey = async () => {
		setError(null);
		setSuccess(null);
		setRegisteringPasskey(true);

		try {
			// Get registration options from server
			const options = await getPasskeyRegistrationOptions(passkeyName || undefined);

			// Start WebAuthn registration
			const registrationResponse = await startRegistration(options);

			// Verify registration with server
			await verifyPasskeyRegistration(registrationResponse, passkeyName || undefined);

			setSuccess("Passkey registered successfully!");
			setPasskeyName("");
			await loadCredentials();
		} catch (err) {
			setError(
				err instanceof Error
					? err.message
					: "Failed to register passkey. Make sure your device supports passkeys.",
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
			setError(err instanceof Error ? err.message : "Failed to delete passkey");
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
			setError(err instanceof Error ? err.message : "Failed to rename passkey");
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
			<Card>
				<CardHeader>
					<CardTitle>Passkeys</CardTitle>
					<CardDescription>Loading passkey credentials...</CardDescription>
				</CardHeader>
			</Card>
		);
	}

	return (
		<Card>
			<CardHeader>
				<CardTitle>Passkeys</CardTitle>
				<CardDescription>
					Manage your passkey credentials for passwordless authentication. Passkeys use your
					device's biometrics or PIN.
				</CardDescription>
			</CardHeader>
			<CardContent className="space-y-6">
				{/* Register New Passkey */}
				<div className="space-y-4">
					<h3 className="text-sm font-semibold text-white">Register New Passkey</h3>
					<div className="flex gap-2">
						<Input
							value={passkeyName}
							onChange={(e) => setPasskeyName(e.target.value)}
							placeholder="Passkey name (e.g., iPhone, YubiKey)"
							disabled={registeringPasskey}
							className="flex-1"
						/>
						<Button onClick={handleRegisterPasskey} disabled={registeringPasskey}>
							{registeringPasskey ? "Registering..." : "Add Passkey"}
						</Button>
					</div>
					<p className="text-xs text-white/50">
						You'll be prompted to use your device's biometric authentication or security key.
					</p>
				</div>

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

				{/* Existing Passkeys */}
				{credentials.length > 0 ? (
					<div className="space-y-4">
						<h3 className="text-sm font-semibold text-white">Your Passkeys</h3>
						<div className="space-y-3">
							{credentials.map((credential) => (
								<div
									key={credential.id}
									className="flex items-center justify-between rounded-lg border border-white/10 bg-white/5 p-4"
								>
									<div className="flex-1">
										{editingId === credential.id ? (
											<div className="flex gap-2">
												<Input
													value={editName}
													onChange={(e) => setEditName(e.target.value)}
													placeholder="Passkey name"
													className="max-w-xs"
												/>
												<Button size="sm" onClick={() => saveEdit(credential.id)}>
													Save
												</Button>
												<Button size="sm" variant="outline" onClick={cancelEdit}>
													Cancel
												</Button>
											</div>
										) : (
											<>
												<div className="flex items-center gap-2">
													<svg
														className="h-4 w-4 text-white/60"
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
													<p className="text-sm font-medium text-white">
														{credential.friendlyName || "Unnamed Passkey"}
													</p>
													{credential.backedUp && (
														<span className="rounded bg-green-500/20 px-2 py-0.5 text-xs text-green-300">
															Backed Up
														</span>
													)}
												</div>
												<p className="mt-1 text-xs text-white/50">
													Created: {formatDate(credential.createdAt)} • Last used:{" "}
													{formatDate(credential.lastUsedAt)}
												</p>
											</>
										)}
									</div>
									{editingId !== credential.id && (
										<div className="flex gap-2">
											<Button
												size="sm"
												variant="outline"
												onClick={() => startEdit(credential)}
												className="text-white/70 hover:text-white"
											>
												Rename
											</Button>
											<Button
												size="sm"
												variant="outline"
												onClick={() => handleDeletePasskey(credential.id)}
												className="text-red-400 hover:text-red-300"
											>
												Delete
											</Button>
										</div>
									)}
								</div>
							))}
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
						<p className="mt-4 text-sm text-white/60">No passkeys registered yet</p>
						<p className="mt-1 text-xs text-white/40">
							Add a passkey above to enable passwordless sign-in
						</p>
					</div>
				)}
			</CardContent>
		</Card>
	);
};
