"use client";

import { useState } from "react";
import { Download, Upload, AlertTriangle, CheckCircle, Loader2 } from "lucide-react";
import { useCreateBackup, useRestoreBackup } from "../../../hooks/api/useBackup";
import { backupApi } from "../../../lib/api-client/backup";

export const BackupTab = () => {
	// Create backup state
	const [createPassword, setCreatePassword] = useState("");
	const [createPasswordConfirm, setCreatePasswordConfirm] = useState("");
	const [createSuccess, setCreateSuccess] = useState(false);

	// Restore backup state
	const [restoreFile, setRestoreFile] = useState<File | null>(null);
	const [restorePassword, setRestorePassword] = useState("");
	const [restoreSuccess, setRestoreSuccess] = useState(false);
	const [showRestoreWarning, setShowRestoreWarning] = useState(false);

	// Mutations
	const createBackupMutation = useCreateBackup();
	const restoreBackupMutation = useRestoreBackup();

	// Handle create backup
	const handleCreateBackup = async (e: React.FormEvent) => {
		e.preventDefault();
		setCreateSuccess(false);

		if (createPassword !== createPasswordConfirm) {
			alert("Passwords do not match");
			return;
		}

		if (createPassword.length < 8) {
			alert("Password must be at least 8 characters");
			return;
		}

		try {
			const response = await createBackupMutation.mutateAsync({
				password: createPassword,
			});

			// Download the backup file
			backupApi.downloadBackupFile(response.encryptedBackup, response.filename);

			setCreateSuccess(true);
			setCreatePassword("");
			setCreatePasswordConfirm("");

			// Reset success message after 5 seconds
			setTimeout(() => setCreateSuccess(false), 5000);
		} catch (error: any) {
			alert(`Failed to create backup: ${error.message || "Unknown error"}`);
		}
	};

	// Handle restore backup
	const handleRestoreBackup = async (e: React.FormEvent) => {
		e.preventDefault();

		if (!restoreFile) {
			alert("Please select a backup file");
			return;
		}

		if (!restorePassword) {
			alert("Please enter the backup password");
			return;
		}

		try {
			// Read the backup file
			const encryptedBackup = await backupApi.readBackupFile(restoreFile);

			// Restore the backup
			const response = await restoreBackupMutation.mutateAsync({
				encryptedBackup,
				password: restorePassword,
			});

			setRestoreSuccess(true);
			setRestoreFile(null);
			setRestorePassword("");
			setShowRestoreWarning(false);

			// Check if auto-restart will occur
			const willAutoRestart = response.message.includes("restart automatically");

			// Show success message
			alert(
				`Backup restored successfully!\n\nBackup from: ${new Date(response.metadata.timestamp).toLocaleString()}\n\n${response.message}${willAutoRestart ? "\n\nThe page will reload automatically once the server restarts." : ""}`,
			);

			// Only poll for restart if auto-restart is enabled
			if (willAutoRestart) {
				// Poll for server to come back up and reload page
				const checkServerInterval = setInterval(async () => {
					try {
						const healthResponse = await fetch("/api/health");
						if (healthResponse.ok) {
							clearInterval(checkServerInterval);
							window.location.href = "/login"; // Redirect to login after restart
						}
					} catch {
						// Server not ready yet, keep polling
					}
				}, 1000);

				// Stop polling after 30 seconds
				setTimeout(() => {
					clearInterval(checkServerInterval);
				}, 30000);
			}
		} catch (error: any) {
			alert(`Failed to restore backup: ${error.message || "Unknown error"}`);
		}
	};

	const passwordsMatch = createPassword === createPasswordConfirm;
	const createFormValid = createPassword.length >= 8 && passwordsMatch;

	return (
		<div className="space-y-8">
			{/* Create Backup Section */}
			<div className="rounded-lg border border-white/10 bg-slate-900/40 p-6">
				<div className="mb-4 flex items-center gap-2">
					<Download className="h-5 w-5 text-sky-400" />
					<h3 className="text-lg font-medium text-white">Create Backup</h3>
				</div>

				<p className="mb-6 text-sm text-white/60">
					Create an encrypted backup of your database and configuration. You'll need the backup
					password to restore it later.
				</p>

				<form onSubmit={handleCreateBackup} className="space-y-4">
					<div>
						<label htmlFor="create-password" className="mb-1.5 block text-sm text-white/80">
							Backup Password
						</label>
						<input
							id="create-password"
							type="password"
							value={createPassword}
							onChange={(e) => setCreatePassword(e.target.value)}
							placeholder="Enter a strong password (min. 8 characters)"
							className="w-full rounded-lg border border-white/15 bg-slate-950/80 px-3 py-2 text-sm text-white placeholder:text-white/40 focus:border-sky-500 focus:outline-none focus:ring-2 focus:ring-sky-400 focus:ring-offset-2 focus:ring-offset-slate-950"
							disabled={createBackupMutation.isPending}
						/>
					</div>

					<div>
						<label htmlFor="create-password-confirm" className="mb-1.5 block text-sm text-white/80">
							Confirm Password
						</label>
						<input
							id="create-password-confirm"
							type="password"
							value={createPasswordConfirm}
							onChange={(e) => setCreatePasswordConfirm(e.target.value)}
							placeholder="Re-enter password"
							className="w-full rounded-lg border border-white/15 bg-slate-950/80 px-3 py-2 text-sm text-white placeholder:text-white/40 focus:border-sky-500 focus:outline-none focus:ring-2 focus:ring-sky-400 focus:ring-offset-2 focus:ring-offset-slate-950"
							disabled={createBackupMutation.isPending}
						/>
						{createPasswordConfirm && !passwordsMatch && (
							<p className="mt-1 text-xs text-red-400">Passwords do not match</p>
						)}
					</div>

					<button
						type="submit"
						disabled={!createFormValid || createBackupMutation.isPending}
						className="flex items-center gap-2 rounded-lg bg-sky-500 px-4 py-2 text-sm font-medium text-white transition hover:bg-sky-600 disabled:cursor-not-allowed disabled:opacity-50"
					>
						{createBackupMutation.isPending ? (
							<>
								<Loader2 className="h-4 w-4 animate-spin" />
								Creating Backup...
							</>
						) : (
							<>
								<Download className="h-4 w-4" />
								Create & Download Backup
							</>
						)}
					</button>

					{createSuccess && (
						<div className="flex items-center gap-2 rounded-lg border border-green-500/20 bg-green-500/10 px-4 py-2 text-sm text-green-400">
							<CheckCircle className="h-4 w-4" />
							Backup created and downloaded successfully!
						</div>
					)}

					{createBackupMutation.isError && (
						<div className="flex items-center gap-2 rounded-lg border border-red-500/20 bg-red-500/10 px-4 py-2 text-sm text-red-400">
							<AlertTriangle className="h-4 w-4" />
							{createBackupMutation.error?.message || "Failed to create backup"}
						</div>
					)}
				</form>

				<div className="mt-4 rounded-lg border border-amber-500/20 bg-amber-500/10 p-3">
					<p className="text-xs text-amber-400">
						<strong>Important:</strong> Store your backup file and password securely. The backup
						contains all your service API keys and configuration. You cannot recover the backup
						without the password.
					</p>
				</div>
			</div>

			{/* Restore Backup Section */}
			<div className="rounded-lg border border-white/10 bg-slate-900/40 p-6">
				<div className="mb-4 flex items-center gap-2">
					<Upload className="h-5 w-5 text-sky-400" />
					<h3 className="text-lg font-medium text-white">Restore Backup</h3>
				</div>

				<p className="mb-6 text-sm text-white/60">
					Restore your database and configuration from an encrypted backup file. This will replace
					all current data.
				</p>

				{!showRestoreWarning ? (
					<button
						type="button"
						onClick={() => setShowRestoreWarning(true)}
						className="flex items-center gap-2 rounded-lg border border-white/15 bg-slate-950/80 px-4 py-2 text-sm font-medium text-white transition hover:border-sky-500/60"
					>
						<Upload className="h-4 w-4" />
						Restore from Backup
					</button>
				) : (
					<>
						<div className="mb-4 rounded-lg border border-red-500/20 bg-red-500/10 p-4">
							<div className="flex items-start gap-2">
								<AlertTriangle className="mt-0.5 h-5 w-5 flex-shrink-0 text-red-400" />
								<div>
									<p className="text-sm font-medium text-red-400">Warning: Destructive Operation</p>
									<p className="mt-1 text-xs text-red-400/80">
										Restoring a backup will <strong>permanently delete</strong> all current data,
										including:
									</p>
									<ul className="mt-2 list-inside list-disc space-y-1 text-xs text-red-400/80">
										<li>All service instances and their settings</li>
										<li>Tags and organization</li>
										<li>User accounts and authentication methods</li>
										<li>All encrypted API keys and secrets</li>
									</ul>
									<p className="mt-2 text-xs text-red-400/80">
										This action <strong>cannot be undone</strong>. Make sure you have a current backup
										before proceeding.
									</p>
								</div>
							</div>
						</div>

						<form onSubmit={handleRestoreBackup} className="space-y-4">
							<div>
								<label htmlFor="restore-file" className="mb-1.5 block text-sm text-white/80">
									Backup File
								</label>
								<input
									id="restore-file"
									type="file"
									accept=".enc"
									onChange={(e) => setRestoreFile(e.target.files?.[0] || null)}
									className="w-full rounded-lg border border-white/15 bg-slate-950/80 px-3 py-2 text-sm text-white file:mr-4 file:rounded file:border-0 file:bg-sky-500 file:px-3 file:py-1 file:text-xs file:font-medium file:text-white hover:file:bg-sky-600"
									disabled={restoreBackupMutation.isPending}
								/>
								{restoreFile && (
									<p className="mt-1 text-xs text-white/60">Selected: {restoreFile.name}</p>
								)}
							</div>

							<div>
								<label htmlFor="restore-password" className="mb-1.5 block text-sm text-white/80">
									Backup Password
								</label>
								<input
									id="restore-password"
									type="password"
									value={restorePassword}
									onChange={(e) => setRestorePassword(e.target.value)}
									placeholder="Enter backup password"
									className="w-full rounded-lg border border-white/15 bg-slate-950/80 px-3 py-2 text-sm text-white placeholder:text-white/40 focus:border-sky-500 focus:outline-none focus:ring-2 focus:ring-sky-400 focus:ring-offset-2 focus:ring-offset-slate-950"
									disabled={restoreBackupMutation.isPending}
								/>
							</div>

							<div className="flex gap-3">
								<button
									type="submit"
									disabled={!restoreFile || !restorePassword || restoreBackupMutation.isPending}
									className="flex items-center gap-2 rounded-lg bg-red-500 px-4 py-2 text-sm font-medium text-white transition hover:bg-red-600 disabled:cursor-not-allowed disabled:opacity-50"
								>
									{restoreBackupMutation.isPending ? (
										<>
											<Loader2 className="h-4 w-4 animate-spin" />
											Restoring...
										</>
									) : (
										<>
											<Upload className="h-4 w-4" />
											Restore Backup
										</>
									)}
								</button>

								<button
									type="button"
									onClick={() => {
										setShowRestoreWarning(false);
										setRestoreFile(null);
										setRestorePassword("");
									}}
									className="rounded-lg border border-white/15 bg-slate-950/80 px-4 py-2 text-sm font-medium text-white transition hover:border-white/30"
									disabled={restoreBackupMutation.isPending}
								>
									Cancel
								</button>
							</div>

							{restoreBackupMutation.isError && (
								<div className="flex items-center gap-2 rounded-lg border border-red-500/20 bg-red-500/10 px-4 py-2 text-sm text-red-400">
									<AlertTriangle className="h-4 w-4" />
									{restoreBackupMutation.error?.message || "Failed to restore backup"}
								</div>
							)}
						</form>
					</>
				)}
			</div>
		</div>
	);
};
