"use client";

import type { LibraryService } from "@arr/shared";
import { useMutation } from "@tanstack/react-query";
import { Check, RefreshCw, Tag } from "lucide-react";
import { useState } from "react";
import {
	type RunLabelSyncForItemResponse,
	runLabelSyncForItem,
} from "../../../lib/api-client/label-sync";

interface Props {
	instanceId: string;
	arrItemId: number;
	itemType: "movie" | "series";
	service: LibraryService;
}

/**
 * Per-item "Sync labels now" button (Phase D — issue #384 follow-up).
 *
 * Fires every enabled Label Sync rule whose source matches this *arr
 * instance, scoped to this single item. Idempotent — already-applied
 * labels no-op at the writer layer. Surfaces inline status feedback so
 * the user sees rules-fired / labels-applied without opening another
 * panel.
 */
export const SyncLabelsNowButton = ({ instanceId, arrItemId, itemType, service }: Props) => {
	const [feedback, setFeedback] = useState<{
		kind: "ok" | "warn" | "err";
		message: string;
	} | null>(null);

	const mutation = useMutation<RunLabelSyncForItemResponse, Error>({
		mutationFn: () => runLabelSyncForItem({ instanceId, arrItemId, itemType }),
		onSuccess: (result) => {
			if (result.rulesFired === 0) {
				setFeedback({
					kind: "warn",
					message: "No matching Label Sync rules configured.",
				});
				return;
			}
			if (result.failures > 0 && result.labelsApplied === 0) {
				setFeedback({
					kind: "err",
					message: `Fired ${result.rulesFired} rule${result.rulesFired === 1 ? "" : "s"}, all failed.`,
				});
				return;
			}
			if (result.failures > 0) {
				setFeedback({
					kind: "warn",
					message: `Applied ${result.labelsApplied} label${result.labelsApplied === 1 ? "" : "s"}, ${result.failures} failure${result.failures === 1 ? "" : "s"}.`,
				});
				return;
			}
			setFeedback({
				kind: "ok",
				message:
					result.labelsApplied > 0
						? `Synced ${result.labelsApplied} label${result.labelsApplied === 1 ? "" : "s"}.`
						: `Fired ${result.rulesFired} rule${result.rulesFired === 1 ? "" : "s"} — nothing to apply.`,
			});
		},
		onError: (err) => {
			setFeedback({ kind: "err", message: err.message || "Request failed" });
		},
	});

	const supported = service === "sonarr" || service === "radarr";
	if (!supported) return null;

	const isPending = mutation.isPending;

	return (
		<div className="flex items-center gap-3">
			<button
				type="button"
				onClick={() => {
					setFeedback(null);
					mutation.mutate();
				}}
				disabled={isPending}
				className="inline-flex items-center gap-2 rounded-md border border-border/50 bg-card/30 px-3 py-1.5 text-xs font-medium text-foreground/80 backdrop-blur-sm transition hover:bg-card/60 hover:text-foreground disabled:opacity-50"
				aria-label="Sync labels for this item now"
			>
				{isPending ? (
					<RefreshCw className="h-3.5 w-3.5 animate-spin" />
				) : feedback?.kind === "ok" ? (
					<Check className="h-3.5 w-3.5" />
				) : (
					<Tag className="h-3.5 w-3.5" />
				)}
				<span>{isPending ? "Syncing labels…" : "Sync labels now"}</span>
			</button>
			{feedback && (
				<span
					className={`text-xs ${
						feedback.kind === "ok"
							? "text-emerald-400"
							: feedback.kind === "warn"
								? "text-amber-400"
								: "text-rose-400"
					}`}
					role="status"
					aria-live="polite"
				>
					{feedback.message}
				</span>
			)}
		</div>
	);
};
