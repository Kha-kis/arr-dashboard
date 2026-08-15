"use client";

import { format } from "date-fns";
import { AlertTriangle, Loader2, ShieldCheck } from "lucide-react";
import { useState } from "react";
import { Button } from "../../../components/ui";
import { useAcknowledgeSyncReview, useSyncsNeedingReview } from "../../../hooks/api/useSync";
import { getErrorMessage } from "../../../lib/error-utils";
import { getLinuxInstanceName, getLinuxIsoName, useIncognitoMode } from "../../../lib/incognito";
import { SEMANTIC_COLORS } from "../../../lib/theme-gradients";

function identityToken(value: string): string {
	const normalized = value.replace(/[^a-zA-Z0-9]/g, "");
	return (normalized.slice(-8) || value.slice(-8)).toUpperCase();
}

function reviewReference(syncId: string, instanceId: string): string {
	return `Review ${identityToken(syncId)} · Endpoint ${identityToken(instanceId)}`;
}

export function SyncReviewNeededPanel() {
	const [incognitoMode] = useIncognitoMode();
	const [confirmingSyncId, setConfirmingSyncId] = useState<string | null>(null);
	const { data, error: reviewLoadError } = useSyncsNeedingReview();
	const acknowledgeMutation = useAcknowledgeSyncReview();
	const syncs = data?.syncs ?? [];

	if (reviewLoadError) {
		return (
			<section
				className="rounded-2xl border p-5"
				style={{
					backgroundColor: SEMANTIC_COLORS.error.bg,
					borderColor: SEMANTIC_COLORS.error.border,
				}}
			>
				<p className="font-semibold text-foreground">Unable to load recovery reviews</p>
				<p className="mt-1 text-sm text-muted-foreground">
					{getErrorMessage(reviewLoadError, "Refresh this page before making another ARR change.")}
				</p>
			</section>
		);
	}

	if (syncs.length === 0) return null;

	function acknowledge(syncId: string) {
		acknowledgeMutation.mutate(syncId, {
			onSuccess: () => setConfirmingSyncId(null),
		});
	}

	function beginConfirmation(syncId: string) {
		if (acknowledgeMutation.isPending) return;
		acknowledgeMutation.reset();
		setConfirmingSyncId(syncId);
	}

	function cancelConfirmation() {
		if (acknowledgeMutation.isPending) return;
		acknowledgeMutation.reset();
		setConfirmingSyncId(null);
	}

	return (
		<section
			className="rounded-2xl border p-5 space-y-4"
			style={{
				backgroundColor: SEMANTIC_COLORS.warning.bg,
				borderColor: SEMANTIC_COLORS.warning.border,
			}}
		>
			<div className="flex items-start gap-3">
				<AlertTriangle
					className="h-5 w-5 shrink-0"
					style={{ color: SEMANTIC_COLORS.warning.from }}
				/>
				<div className="space-y-1">
					<h2 className="font-semibold text-foreground">Manual review required</h2>
					<p className="text-sm text-muted-foreground">
						These syncs stopped without a rollback ledger. Inspect the current ARR state before
						acknowledging one. Acknowledgement does not roll back or change anything in your ARR
						instance; it accepts the current state and releases the local gate.
					</p>
				</div>
			</div>

			<div className="space-y-3">
				{syncs.map((sync) => {
					const isConfirming = confirmingSyncId === sync.id;
					const ownsMutationState = acknowledgeMutation.variables === sync.id;
					const isAcknowledging = acknowledgeMutation.isPending && ownsMutationState;
					const displayTemplate = incognitoMode
						? getLinuxIsoName(sync.templateName)
						: sync.templateName;
					const displayInstance = incognitoMode
						? getLinuxInstanceName(sync.instanceName)
						: sync.instanceName;
					const stableReference = reviewReference(sync.id, sync.instanceId);

					return (
						<div
							key={sync.id}
							className="rounded-xl border border-border/40 bg-card/50 p-4 space-y-3"
						>
							<div className="flex flex-wrap items-start justify-between gap-3">
								<div>
									<p className="font-medium text-foreground">{displayTemplate}</p>
									<p className="text-sm text-muted-foreground">
										{displayInstance} · {format(new Date(sync.startedAt), "MMM d, yyyy h:mm a")}
									</p>
									<p className="mt-1 font-mono text-xs text-muted-foreground">{stableReference}</p>
								</div>
								{!isConfirming && (
									<Button
										type="button"
										variant="outline"
										size="sm"
										onClick={() => beginConfirmation(sync.id)}
										disabled={acknowledgeMutation.isPending}
									>
										Acknowledge review
									</Button>
								)}
							</div>

							{isConfirming && (
								<div className="rounded-lg border border-border/50 bg-muted/30 p-3 space-y-3">
									<p className="text-sm font-medium text-foreground">Confirm manual review</p>
									<p className="text-xs text-muted-foreground">
										I have inspected the current ARR state and accept it. This only releases the
										local recovery gate.
									</p>
									<p className="font-mono text-xs text-foreground">{stableReference}</p>
									<div className="flex flex-wrap gap-2">
										<Button
											type="button"
											size="sm"
											onClick={() => acknowledge(sync.id)}
											disabled={isAcknowledging}
										>
											{isAcknowledging ? (
												<>
													<Loader2 className="animate-spin" />
													Acknowledging...
												</>
											) : (
												"Confirm review"
											)}
										</Button>
										<Button
											type="button"
											variant="ghost"
											size="sm"
											onClick={cancelConfirmation}
											disabled={isAcknowledging}
										>
											Cancel
										</Button>
									</div>
									{acknowledgeMutation.isError && ownsMutationState && (
										<p className="text-sm" style={{ color: SEMANTIC_COLORS.error.text }}>
											{getErrorMessage(
												acknowledgeMutation.error,
												"Unable to acknowledge this review. Refresh and try again.",
											)}
										</p>
									)}
								</div>
							)}
						</div>
					);
				})}
			</div>

			<div className="flex items-center gap-2 text-xs text-muted-foreground">
				<ShieldCheck className="h-3.5 w-3.5" />
				Acknowledgement records your review; it never performs an automatic rollback.
			</div>
		</section>
	);
}
