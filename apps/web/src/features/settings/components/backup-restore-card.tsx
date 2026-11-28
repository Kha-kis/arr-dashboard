"use client";

import { MAX_BACKUP_UPLOAD_SIZE, MAX_RESTORE_PASSWORD_LENGTH } from "@arr/shared";
import { Loader2, ShieldAlert } from "lucide-react";
import { type FormEvent, useEffect, useId, useRef, useState } from "react";
import { Button } from "../../../components/ui/button";
import { Input } from "../../../components/ui/input";
import { useRestoreBackup } from "../../../hooks/api/useBackup";
import { RestoreRecoveryNotice } from "../../../components/auth/restore-recovery-notice";
import { RestoreRequestRejectedError } from "../../../lib/api-client/backup";
import { SEMANTIC_COLORS } from "../../../lib/theme-gradients";

interface RestoreCardProps {
	selectedBackupId?: string | null;
	onSelectionClear?: () => void;
	onRecoveryStateChange?: (locked: boolean) => void;
	requestError?: string | null;
	onRequestErrorChange?: (error: string | null) => void;
}

function readEncodedFile(file: File): Promise<string> {
	return new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onerror = reader.onabort = () => reject(new Error("Backup file could not be read."));
		reader.onload = () => {
			const result = reader.result;
			const marker = typeof result === "string" ? result.indexOf(";base64,") : -1;
			if (marker < 0) reject(new Error("Backup file could not be read."));
			else resolve((result as string).slice(marker + 8));
		};
		reader.readAsDataURL(file);
	});
}

export const BackupRestoreCard = ({
	selectedBackupId,
	onSelectionClear,
	onRecoveryStateChange,
	requestError,
	onRequestErrorChange,
}: RestoreCardProps) => {
	const id = useId();
	const fileInput = useRef<HTMLInputElement>(null);
	const submitting = useRef(false);
	const [file, setFile] = useState<File | null>(null),
		[password, setPassword] = useState("");
	const [confirmed, setConfirmed] = useState(false),
		[busy, setBusy] = useState(false);
	const [localError, setLocalError] = useState<string | null>(null);
	const error = onRequestErrorChange ? (requestError ?? null) : localError;
	const setError = onRequestErrorChange ?? setLocalError;
	const mutation = useRestoreBackup();
	const handoff = mutation.handoff;
	const inProgress = busy || mutation.isPending;
	const locked = inProgress || mutation.isBlocked;
	useEffect(() => {
		onRecoveryStateChange?.(locked);
	}, [locked, onRecoveryStateChange]);

	const clearInput = () => {
		setFile(null);
		setPassword("");
		setConfirmed(false);
		if (fileInput.current) fileInput.current.value = "";
		onSelectionClear?.();
	};
	const submit = async (event: FormEvent) => {
		event.preventDefault();
		if (submitting.current || locked || !confirmed || (!selectedBackupId && !file)) return;
		submitting.current = true;
		setBusy(true);
		setError(null);
		let sent = false;
		try {
			if (password.length > MAX_RESTORE_PASSWORD_LENGTH) {
				setError("Backup password exceeds the supported length. Nothing was submitted.");
				return;
			}
			if (!selectedBackupId && file && 4 * Math.ceil(file.size / 3) > MAX_BACKUP_UPLOAD_SIZE) {
				setError(
					"This file exceeds the 50 MiB encoded upload limit. Select a supported upload or an existing stored backup. Nothing was submitted.",
				);
				return;
			}
			const override = password.length ? { password } : {};
			const selection = selectedBackupId
				? { kind: "stored" as const, request: { id: selectedBackupId, ...override } }
				: {
						kind: "upload" as const,
						request: { backupData: await readEncodedFile(file!), ...override },
					};
			sent = true;
			await mutation.mutateAsync(selection);
		} catch (failure) {
			if (!sent) setError("Backup file could not be read. Nothing was submitted.");
			else if (
				failure instanceof RestoreRequestRejectedError &&
				([400, 409].includes(failure.status) ||
					(failure.status === 429 && failure.category === "restore-rate-limited"))
			) {
				setError(
					failure.category === "restore-rate-limited"
						? `Restore request was rate limited before publication. Wait up to ${failure.retryAfterSeconds} seconds, then select the backup and confirm again.`
						: failure.category === "invalid-backup"
							? "Backup or password was rejected before publication. Select the backup and enter its password again."
							: "Restore was rejected before publication because another operation is active. Wait for it to finish before a new confirmed request.",
				);
			}
		} finally {
			clearInput();
			setBusy(false);
			submitting.current = false;
		}
	};

	return (
		<section
			className="min-w-0 max-w-full rounded-xl border border-border/30 bg-muted/10 p-6"
			aria-label="Restore backup"
		>
			<div className="mb-4 flex items-center gap-2">
				<ShieldAlert className="h-5 w-5 shrink-0" style={{ color: SEMANTIC_COLORS.warning.text }} />
				<h3 className="font-semibold">Restore backup</h3>
			</div>
			<div
				className="mb-4 rounded-lg p-3 text-sm"
				style={{
					backgroundColor: SEMANTIC_COLORS.warning.bg,
					border: `1px solid ${SEMANTIC_COLORS.warning.border}`,
					color: SEMANTIC_COLORS.warning.text,
				}}
			>
				<p>Accounts and settings will be replaced. Existing sessions will end.</p>
				<p>
					Sign in with restored accounts after restart. Preserve a current encrypted backup and its
					password before proceeding.
				</p>
			</div>
			<form onSubmit={submit} className="space-y-4">
				{selectedBackupId ? (
					<div className="space-y-2">
						<p className="text-sm">Stored backup selected</p>
						<Button type="button" variant="secondary" disabled={locked} onClick={onSelectionClear}>
							Use an uploaded file
						</Button>
					</div>
				) : (
					<div className="space-y-2">
						<label className="text-sm font-medium" htmlFor={`${id}-file`}>
							Encrypted backup file
						</label>
						<Input
							id={`${id}-file`}
							ref={fileInput}
							type="file"
							accept=".json,application/json"
							className="min-w-0 max-w-full"
							disabled={locked}
							onChange={(event) => {
								setFile(event.currentTarget.files?.[0] ?? null);
								setConfirmed(false);
								setError(null);
							}}
						/>
						<p className="text-xs text-muted-foreground">
							Uploads support up to 50 MiB encoded. Larger supported backups can be selected from
							Available Backups.
						</p>
					</div>
				)}
				<div className="space-y-2">
					<label className="text-sm font-medium" htmlFor={`${id}-password`}>
						Backup password (optional)
					</label>
					<Input
						id={`${id}-password`}
						type="password"
						autoComplete="off"
						maxLength={MAX_RESTORE_PASSWORD_LENGTH}
						value={password}
						disabled={locked}
						onChange={(event) => setPassword(event.target.value)}
					/>
					<p className="text-xs text-muted-foreground">
						Leave empty to use the existing configured backup password. This does not change that
						password.
					</p>
				</div>
				<label className="flex items-start gap-2 text-sm" htmlFor={`${id}-confirm`}>
					<input
						id={`${id}-confirm`}
						type="checkbox"
						className="mt-1 shrink-0"
						checked={confirmed}
						disabled={locked}
						onChange={(event) => setConfirmed(event.target.checked)}
					/>
					<span>Replace accounts, settings, and end all sessions</span>
				</label>
				{error ? (
					<p role="alert" className="text-sm text-destructive">
						{error}
					</p>
				) : null}
				<Button
					type="submit"
					variant="danger"
					className="max-w-full"
					disabled={locked || !confirmed || (!selectedBackupId && !file)}
				>
					{inProgress ? (
						<>
							<Loader2 className="animate-spin" />
							Restoring…
						</>
					) : (
						"Restore backup"
					)}
				</Button>
			</form>
			{inProgress ? (
				<div role="status" className="mt-4 text-sm">
					<p>Restore request in progress.</p>
					<p>Closing this window does not cancel the server operation.</p>
				</div>
			) : null}
			{handoff && !inProgress ? (
				<RestoreRecoveryNotice handoff={handoff} pending={inProgress} onClear={clearInput} />
			) : null}
		</section>
	);
};
