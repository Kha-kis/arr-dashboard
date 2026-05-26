"use client";

import { type CrossSeedDiscoveryItem, QUI_BULK_HASH_CAP, type QuiAction } from "@arr/shared";
import {
	AlertCircle,
	CheckCircle2,
	Loader2,
	Pause,
	Play,
	RefreshCcw,
	RefreshCw,
	XCircle,
} from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "../../../components/ui";
import { useQuiBulkAction } from "../../../hooks/api/useQui";
import { getErrorMessage } from "../../../lib/error-utils";

interface Props {
	quiInstanceId: string;
	/** Selected items — `primary` may be present or null; null items must be filtered before invoking. */
	selectedItems: CrossSeedDiscoveryItem[];
	onClear: () => void;
}

interface ActionDef {
	id: QuiAction;
	label: string;
	icon: typeof Pause;
	tone: "neutral" | "warn";
	confirm: string;
}

const BULK_ACTIONS: ActionDef[] = [
	{
		id: "pause",
		label: "Pause",
		icon: Pause,
		tone: "neutral",
		confirm: "Pause selected torrents in qui?",
	},
	{
		id: "resume",
		label: "Resume",
		icon: Play,
		tone: "neutral",
		confirm: "Resume selected torrents in qui?",
	},
	{
		id: "recheck",
		label: "Recheck",
		icon: RefreshCcw,
		tone: "warn",
		confirm:
			"Recheck selected torrents? qBittorrent will re-hash every piece on disk for each one; this can take many minutes on large torrents.",
	},
	{
		id: "reannounce",
		label: "Reannounce",
		icon: RefreshCw,
		tone: "neutral",
		confirm: "Reannounce selected torrents to trackers?",
	},
];

/**
 * Sticky bulk-action bar for the Cross-Seed Discovery page (Phase 4.2).
 *
 * Selected items can span multiple qBit instances (qui's cross-instance view
 * is the whole point of this page), so each click groups the selection by
 * `primary.qbitInstanceId` and fires one POST per group. Per-group failures
 * are collected and surfaced as a single toast — partial success is honest:
 * "3 succeeded, 1 failed in qbit-secondary".
 *
 * Selection only targets `primary` hashes — cross-seed siblings are
 * deliberately read-only (per the design doc's D7: qui owns the torrent
 * layer; pausing siblings would interfere with cross-seed's own state
 * tracking).
 */
export const CrossSeedBulkToolbar = ({ quiInstanceId, selectedItems, onClear }: Props) => {
	const [pending, setPending] = useState<ActionDef | null>(null);
	const mutation = useQuiBulkAction();

	// Group by qbit instance. Items without `primary` shouldn't reach this
	// component (caller filters), but defensive .filter keeps the math
	// correct if a future refactor relaxes the guard.
	const grouped = new Map<number, { qbitName: string; hashes: string[] }>();
	for (const item of selectedItems) {
		if (!item.primary) continue;
		const key = item.primary.qbitInstanceId;
		const entry = grouped.get(key);
		if (entry) {
			entry.hashes.push(item.primary.hash);
		} else {
			grouped.set(key, { qbitName: item.primary.qbitInstanceName, hashes: [item.primary.hash] });
		}
	}

	const targetCount = Array.from(grouped.values()).reduce(
		(sum, group) => sum + group.hashes.length,
		0,
	);
	const groupCount = grouped.size;
	// Mirror the server-side per-call cap so the operator sees the limit
	// before they click and get a generic 400. Per-instance check — qui
	// applies the cap per bulk call, and we fire one call per qbit instance.
	const maxPerInstance =
		grouped.size === 0 ? 0 : Math.max(...Array.from(grouped.values()).map((g) => g.hashes.length));
	const overCap = maxPerInstance > QUI_BULK_HASH_CAP;

	const submit = async () => {
		if (!pending) return;
		const results: Array<{ qbit: number; qbitName: string; ok: boolean; error?: string }> = [];

		// Fire one bulk-action POST per qbit instance. Run in parallel —
		// the audit log records each group separately, so failures stay
		// scoped to the group that hit them.
		await Promise.all(
			Array.from(grouped.entries()).map(async ([qbitInstanceId, group]) => {
				try {
					await mutation.mutateAsync({
						quiInstanceId,
						qbitInstanceId,
						action: pending.id,
						hashes: group.hashes,
					});
					results.push({ qbit: qbitInstanceId, qbitName: group.qbitName, ok: true });
				} catch (err) {
					results.push({
						qbit: qbitInstanceId,
						qbitName: group.qbitName,
						ok: false,
						error: getErrorMessage(err),
					});
				}
			}),
		);

		const failures = results.filter((r) => !r.ok);
		if (failures.length === 0) {
			toast.success(
				`${pending.label} sent to ${targetCount} torrent${targetCount === 1 ? "" : "s"} in qui`,
			);
			onClear();
		} else if (failures.length === results.length) {
			toast.error(`${pending.label} failed: ${failures[0]?.error ?? "qui returned an error"}`);
		} else {
			const okCount = results.length - failures.length;
			toast.warning(
				`${pending.label}: ${okCount} succeeded, ${failures.length} failed (see My Actions for details)`,
			);
			onClear();
		}
		setPending(null);
	};

	const cancel = () => {
		if (mutation.isPending) return;
		setPending(null);
	};

	return (
		<>
			<div className="sticky bottom-4 z-30 mx-auto mt-6 max-w-3xl">
				<div className="flex flex-wrap items-center gap-3 rounded-xl border border-border/60 bg-card/95 backdrop-blur px-4 py-3 shadow-2xl">
					<div className="flex items-center gap-1.5 text-sm text-foreground">
						<CheckCircle2 className="h-4 w-4 text-primary" aria-hidden />
						<span className="font-medium">
							{targetCount} selected
							{groupCount > 1 ? ` across ${groupCount} qBit instances` : ""}
						</span>
					</div>
					<div className="flex flex-wrap items-center gap-1.5 ml-auto">
						{overCap ? (
							<span className="flex items-center gap-1 text-xs text-amber-400">
								<AlertCircle className="h-3 w-3" aria-hidden />
								Per-instance cap is {QUI_BULK_HASH_CAP}. Reduce selection or split per qBit
								instance.
							</span>
						) : null}
						{BULK_ACTIONS.map((action) => (
							<Button
								key={action.id}
								variant="secondary"
								size="sm"
								onClick={() => setPending(action)}
								disabled={mutation.isPending || targetCount === 0 || overCap}
								className="h-8 text-xs"
								aria-label={`${action.label} ${targetCount} selected torrents`}
							>
								<action.icon className="mr-1 h-3 w-3" aria-hidden />
								{action.label}
							</Button>
						))}
						<Button
							variant="ghost"
							size="sm"
							onClick={onClear}
							disabled={mutation.isPending}
							className="h-8 text-xs"
							aria-label="Clear selection"
						>
							<XCircle className="mr-1 h-3 w-3" aria-hidden />
							Clear
						</Button>
					</div>
				</div>
			</div>

			{pending ? (
				<ConfirmModal
					action={pending}
					targetCount={targetCount}
					groupCount={groupCount}
					isSubmitting={mutation.isPending}
					onConfirm={submit}
					onCancel={cancel}
				/>
			) : null}
		</>
	);
};

interface ConfirmProps {
	action: ActionDef;
	targetCount: number;
	groupCount: number;
	isSubmitting: boolean;
	onConfirm: () => void;
	onCancel: () => void;
}

const ConfirmModal = ({
	action,
	targetCount,
	groupCount,
	isSubmitting,
	onConfirm,
	onCancel,
}: ConfirmProps) => {
	return (
		<div
			className="fixed inset-0 z-modal flex items-center justify-center bg-background/80 backdrop-blur-sm"
			role="dialog"
			aria-modal="true"
			aria-labelledby="bulk-action-confirm-title"
		>
			<div className="relative w-full max-w-md rounded-xl border border-border/50 bg-card p-6 shadow-2xl">
				<h2 id="bulk-action-confirm-title" className="text-base font-semibold text-foreground">
					{action.label} {targetCount} torrent{targetCount === 1 ? "" : "s"}
				</h2>
				<p className="mt-2 text-sm text-muted-foreground">{action.confirm}</p>
				<p className="mt-2 text-xs text-muted-foreground">
					{groupCount > 1
						? `Targets span ${groupCount} qBit instances — each will be sent as a separate qui call. Partial failures are recorded in the My Actions log.`
						: "Recorded in the My Actions log; check there for per-torrent outcomes."}
				</p>

				<div className="mt-5 flex justify-end gap-2">
					<Button variant="secondary" onClick={onCancel} disabled={isSubmitting}>
						Cancel
					</Button>
					<Button
						variant={action.tone === "warn" ? "destructive" : "default"}
						onClick={onConfirm}
						disabled={isSubmitting}
					>
						{isSubmitting ? (
							<>
								<Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden /> Sending…
							</>
						) : (
							`Confirm ${action.label.toLowerCase()}`
						)}
					</Button>
				</div>
			</div>
		</div>
	);
};
