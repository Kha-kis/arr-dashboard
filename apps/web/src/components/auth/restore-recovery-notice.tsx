"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import {
	clearRestoreHandoff,
	type RestoreHandoff,
	useRestoreStatus,
} from "../../hooks/api/useBackup";
import {
	acknowledgeProtectedUnauthorized,
	getPendingUnauthorizedRevision,
} from "../../lib/auth-session-signal";
import { Button } from "../ui/button";

interface RestoreRecoveryNoticeProps {
	handoff: RestoreHandoff;
	pending: boolean;
	onClear?: () => void;
}

/** Secret-free handoff survives hiding protected account content. */
export function RestoreRecoveryNotice({ handoff, pending, onClear }: RestoreRecoveryNoticeProps) {
	const panel = useRef<HTMLElement>(null);
	const status = useRestoreStatus(false);
	const [message, setMessage] = useState<string | null>(null);
	const [recovered, setRecovered] = useState(false);
	useEffect(() => {
		if (!pending) panel.current?.focus();
	}, [pending]);
	const checkRecoveredStatus = async () => {
		setRecovered(false);
		setMessage(null);
		const pendingUnauthorized = getPendingUnauthorizedRevision();
		const observation = await status.refetch();
		if (observation.isError || !observation.data) {
			setMessage(
				"Recovered status could not be verified. Complete runtime recovery and sign in again; do not repeat the restore.",
			);
			return;
		}
		// This explicit authenticated observation resolves the earlier quarantine,
		// not a newer protected-request failure that arrived while it was pending.
		acknowledgeProtectedUnauthorized(pendingUnauthorized);
		setRecovered(true);
		const attemptId = handoff.kind === "published" ? handoff.result.restoreId : null;
		setMessage(
			attemptId && observation.data.latestCommitted?.restoreId === attemptId
				? "Matching committed restore confirmed by the recovered runtime."
				: "No matching commit confirmation is available for this attempt. This does not establish rollback.",
		);
	};
	return (
		<section
			ref={panel}
			tabIndex={-1}
			aria-label="Restore recovery"
			className="mx-auto mt-4 min-w-0 max-w-3xl space-y-3 rounded-lg border border-border bg-background p-6 text-sm focus-visible:outline focus-visible:outline-ring"
		>
			{handoff.kind === "published" ? (
				<>
					{handoff.result.outcome === "committed" ? (
						<p>Restore committed. Restart is still required.</p>
					) : handoff.result.outcome === "not-committed" ? (
						<p>
							Restore was not committed because protected state changed. Existing data was retained.
						</p>
					) : (
						<p>
							Restore outcome is unavailable. The database may already have committed the restore.
						</p>
					)}
					<p className="break-all">
						Attempt ID: <code>{handoff.result.restoreId}</code>
					</p>
					{handoff.result.restart === "automatic-requested" ? (
						<p>Automatic restart was requested; readiness has not been verified.</p>
					) : null}
				</>
			) : handoff.kind === "unconfirmed" ? (
				<p>
					Restore outcome could not be confirmed. It may have committed. Do not repeat the request.
				</p>
			) : (
				<p>
					Restore was rejected before publication. Recover the runtime and sign in again before
					another attempt.
				</p>
			)}
			<p>
				Completely stop and start Arr Dashboard if manual recovery is required, then sign in again.
				Do not repeat an unconfirmed restore.
			</p>
			<p>
				The recovery notice is retained only in this tab&apos;s memory. Reloading cannot replay the
				request and may lose its attempt ID.
			</p>
			{pending ? (
				<p role="status">Finishing the Restore response. Do not repeat the request.</p>
			) : null}
			<Link
				href="/login?redirectTo=%2Fsettings"
				prefetch={false}
				className="block text-primary underline"
			>
				Sign in after recovery
			</Link>
			<Button
				type="button"
				variant="secondary"
				className="max-w-full"
				disabled={status.isFetching || pending}
				onClick={() => void checkRecoveredStatus()}
			>
				Check recovered status
			</Button>
			{message ? <p role="status">{message}</p> : null}
			{recovered ? (
				<Button
					type="button"
					variant="secondary"
					className="max-w-full"
					disabled={pending}
					onClick={() => {
						// A document reset must not discard a failure arriving after the
						// last successful observation. Keep recovery until it is rechecked.
						if (getPendingUnauthorizedRevision() !== 0) {
							setRecovered(false);
							setMessage(
								"A newer protected request failed. Check recovered status again before returning to the app.",
							);
							return;
						}
						clearRestoreHandoff();
						onClear?.();
					}}
				>
					Clear recovery notice
				</Button>
			) : null}
		</section>
	);
}
