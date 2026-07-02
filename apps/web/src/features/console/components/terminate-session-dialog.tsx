"use client";

/**
 * Confirm-and-kill dialog for a live Tracearr session (Tracearr-3).
 *
 * Kill-session interrupts a real person's playback, so this is a deliberate
 * two-step: the operator sees exactly WHICH session (title · user · server)
 * before confirming, and may attach an optional reason that Tracearr forwards
 * to the terminated player. Mirrors the destructive-action modal pattern used
 * for backup restore (z-modal overlay, error-colored warning, danger button).
 *
 * Incognito note: the caller passes already-masked `title`/`user` strings for
 * display; the real ids used for the action are carried on `session` and are
 * never rendered.
 */

import type { TracearrLiveSession } from "@arr/shared";
import { Loader2 } from "lucide-react";
import { useState } from "react";
import { Button } from "../../../components/ui";
import { useTerminateSession } from "../../../hooks/api/useTracearr";
import { SEMANTIC_COLORS } from "../../../lib/theme-gradients";

interface TerminateSessionDialogProps {
	session: TracearrLiveSession;
	/** Display strings (incognito-masked upstream when incognito is on). */
	title: string;
	user: string;
	/** Masked server name; empty string when the session has none. */
	serverName: string;
	onClose: () => void;
}

export function TerminateSessionDialog({
	session,
	title,
	user,
	serverName,
	onClose,
}: TerminateSessionDialogProps) {
	const [reason, setReason] = useState("");
	const terminate = useTerminateSession();

	const handleConfirm = () => {
		terminate.mutate(
			{
				instanceId: session.instanceId,
				streamId: session.id,
				reason: reason.trim() || undefined,
			},
			{ onSuccess: () => onClose() },
		);
	};

	return (
		<div
			className="fixed inset-0 z-modal flex items-center justify-center bg-black/80 backdrop-blur-xs"
			role="dialog"
			aria-modal="true"
			aria-labelledby="terminate-session-title"
		>
			<div className="m-4 w-full max-w-md rounded-xl border border-border/30 bg-muted/10 p-6">
				<div className="space-y-4">
					<h3 id="terminate-session-title" className="text-lg font-semibold text-foreground">
						Terminate session
					</h3>

					<div
						className="rounded-lg p-3 text-sm"
						style={{
							backgroundColor: SEMANTIC_COLORS.error.bg,
							border: `1px solid ${SEMANTIC_COLORS.error.border}`,
							color: SEMANTIC_COLORS.error.text,
						}}
					>
						<p className="mb-1 font-medium">This stops an active stream</p>
						<p className="text-xs">
							The person watching will have their playback stopped immediately.
						</p>
					</div>

					<div className="space-y-1">
						<p className="truncate text-sm font-medium text-foreground">{title}</p>
						<p className="text-xs text-muted-foreground">
							{user}
							{serverName ? ` · ${serverName}` : ""}
						</p>
					</div>

					<div className="space-y-1">
						<label htmlFor="terminate-reason" className="text-xs text-muted-foreground">
							Reason (optional — shown to the user)
						</label>
						<input
							id="terminate-reason"
							type="text"
							value={reason}
							onChange={(e) => setReason(e.target.value)}
							maxLength={500}
							placeholder="e.g. Too many concurrent streams"
							className="w-full rounded-lg border border-border/50 bg-card/50 px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-hidden focus:ring-2 focus:ring-ring"
						/>
					</div>

					<div className="flex gap-2">
						<Button
							onClick={handleConfirm}
							variant="danger"
							disabled={terminate.isPending}
							className="flex-1 gap-2"
						>
							{terminate.isPending ? (
								<>
									<Loader2 className="h-4 w-4 animate-spin" />
									Terminating…
								</>
							) : (
								"Terminate session"
							)}
						</Button>
						<Button
							type="button"
							variant="secondary"
							onClick={onClose}
							disabled={terminate.isPending}
						>
							Cancel
						</Button>
					</div>
				</div>
			</div>
		</div>
	);
}
