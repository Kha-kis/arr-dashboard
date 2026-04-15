"use client";

/**
 * PulseActionButton
 *
 * Thin button rendered inside a Pulse row when `item.action` is present.
 * Single-tap, non-destructive only — PR 2 of Actionability V1 ships only
 * `scheduler.enable`, which is idempotent and low-risk (worst case: 409
 * "already running"). Destructive variants + two-tap confirm are out of
 * scope until a destructive action lands.
 *
 * The button shows a spinner while the mutation is in flight and is
 * disabled during that window so a double-click can't queue two requests
 * against the same signal.
 */

import type { PulseAction } from "@arr/shared";
import { Loader2 } from "lucide-react";
import { usePulseActionMutation } from "../../../hooks/api/usePulse";

export interface PulseActionButtonProps {
	signalId: string;
	action: PulseAction;
	/** Optional extra class for the caller to position the button in its row. */
	className?: string;
}

export function PulseActionButton({ signalId, action, className }: PulseActionButtonProps) {
	const mutation = usePulseActionMutation();
	const isPending = mutation.isPending;

	return (
		<button
			type="button"
			onClick={() => mutation.mutate({ signalId, action })}
			disabled={isPending}
			aria-busy={isPending}
			className={[
				"inline-flex shrink-0 items-center gap-1 rounded-md px-2.5 py-1.5 text-xs font-medium",
				"border border-border/50 bg-card/40 text-foreground",
				"transition-colors hover:bg-accent hover:text-foreground",
				"disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:bg-card/40",
				className ?? "",
			].join(" ")}
		>
			{isPending ? <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" /> : null}
			{action.label}
		</button>
	);
}
