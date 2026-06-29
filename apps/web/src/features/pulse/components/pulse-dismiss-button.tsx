"use client";

/**
 * PulseDismissButton
 *
 * Icon-only "dismiss until recovery" affordance for Pulse rows. Renders a
 * muted X that tombstones the signal; the success toast carries an Undo.
 *
 * Severity gate: the CALLER must not render this for `critical` items —
 * critical signals are never dismissable (the operator console's trust
 * thesis: you can acknowledge noise, not silence emergencies). The backend
 * re-enforces the same rule at read time, so even a stale render or a
 * hand-crafted request can't actually suppress a critical signal.
 */

import { Loader2, X } from "lucide-react";
import { usePulseDismissMutation } from "../../../hooks/api/usePulse";

export interface PulseDismissButtonProps {
	signalId: string;
	/** Optional extra class for the caller to position the button in its row. */
	className?: string;
}

export function PulseDismissButton({ signalId, className }: PulseDismissButtonProps) {
	const mutation = usePulseDismissMutation();
	const isPending = mutation.isPending;

	return (
		<button
			type="button"
			onClick={() => mutation.mutate({ signalId })}
			disabled={isPending}
			aria-busy={isPending}
			aria-label="Dismiss signal until it recovers"
			title="Dismiss until this signal recovers"
			className={[
				"inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md",
				"text-muted-foreground/60 transition-colors hover:bg-accent hover:text-foreground",
				"disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:bg-transparent",
				className ?? "",
			].join(" ")}
		>
			{isPending ? (
				<Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
			) : (
				<X className="h-3.5 w-3.5" aria-hidden="true" />
			)}
		</button>
	);
}
