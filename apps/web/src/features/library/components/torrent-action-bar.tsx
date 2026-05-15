"use client";

import type { QuiAction } from "@arr/shared";
import {
	AlertCircle,
	Loader2,
	Pause,
	Play,
	RefreshCcw,
	RefreshCw,
	Tag as TagIcon,
} from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "../../../components/ui";
import { useQuiTorrentAction } from "../../../hooks/api/useQui";
import { getErrorMessage } from "../../../lib/error-utils";
import { cn } from "../../../lib/utils";

interface Props {
	/** qui ServiceInstance id from the backend. */
	quiInstanceId: string;
	/** qui's qBittorrent instance id (numeric). */
	qbitInstanceId: number;
	/** Info hash of the target torrent. */
	hash: string;
	/** Short label for the torrent shown in the confirmation modal (incognito-aware). */
	displayName: string;
	/** Optional disabled state — used while the parent is loading. */
	disabled?: boolean;
}

interface ActionDef {
	id: QuiAction;
	label: string;
	icon: typeof Pause;
	confirm: string;
	tone: "neutral" | "warn";
	/** Whether to prompt for tags input. Only true for `setTags`. */
	requiresTags: boolean;
}

const ACTIONS: ActionDef[] = [
	{
		id: "pause",
		label: "Pause",
		icon: Pause,
		confirm: "Pause this torrent in qui? Active uploads will be suspended.",
		tone: "neutral",
		requiresTags: false,
	},
	{
		id: "resume",
		label: "Resume",
		icon: Play,
		confirm: "Resume this torrent in qui?",
		tone: "neutral",
		requiresTags: false,
	},
	{
		id: "recheck",
		label: "Recheck",
		icon: RefreshCcw,
		confirm:
			"Recheck this torrent? qBittorrent will re-hash every piece on disk; this can take several minutes on large torrents.",
		tone: "warn",
		requiresTags: false,
	},
	{
		id: "reannounce",
		label: "Reannounce",
		icon: RefreshCw,
		confirm: "Reannounce to trackers? Useful when seed counts seem stuck.",
		tone: "neutral",
		requiresTags: false,
	},
	{
		id: "setTags",
		label: "Set tags",
		icon: TagIcon,
		confirm: "Replace this torrent's tags with the value below (comma-separated)?",
		tone: "neutral",
		requiresTags: true,
	},
];

/**
 * Phase 4.1 — single-torrent action bar rendered on the TorrentHealthPanel.
 *
 * Every action goes through a confirmation modal so a misclick can't pause
 * a torrent without the operator noticing. `setTags` additionally collects
 * a comma-separated tag string — replacing existing tags is destructive
 * enough that a confirm-with-input is justified.
 *
 * On success: invalidates the per-item torrent-state cache so the badge
 * updates on next poll, plus the action log for the My Actions tab.
 */
export const TorrentActionBar = ({
	quiInstanceId,
	qbitInstanceId,
	hash,
	displayName,
	disabled,
}: Props) => {
	const [pendingAction, setPendingAction] = useState<ActionDef | null>(null);
	const [tagsInput, setTagsInput] = useState("");
	const mutation = useQuiTorrentAction();

	const submit = async () => {
		if (!pendingAction) return;
		try {
			await mutation.mutateAsync({
				quiInstanceId,
				qbitInstanceId,
				hash,
				action: pendingAction.id,
				tags: pendingAction.requiresTags ? tagsInput.trim() : undefined,
			});
			toast.success(`${pendingAction.label} sent to qui`);
			setPendingAction(null);
			setTagsInput("");
		} catch (err) {
			toast.error(`${pendingAction.label} failed: ${getErrorMessage(err)}`);
		}
	};

	const cancel = () => {
		if (mutation.isPending) return;
		setPendingAction(null);
		setTagsInput("");
	};

	return (
		<>
			<div className="flex flex-wrap items-center gap-1.5">
				{ACTIONS.map((action) => (
					<Button
						key={action.id}
						variant="secondary"
						size="sm"
						disabled={disabled || mutation.isPending}
						onClick={() => setPendingAction(action)}
						className="h-7 text-xs"
						aria-label={`${action.label} this torrent`}
					>
						<action.icon className="mr-1 h-3 w-3" aria-hidden />
						{action.label}
					</Button>
				))}
			</div>

			{pendingAction ? (
				<ConfirmModal
					action={pendingAction}
					displayName={displayName}
					tagsInput={tagsInput}
					setTagsInput={setTagsInput}
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
	displayName: string;
	tagsInput: string;
	setTagsInput: (v: string) => void;
	isSubmitting: boolean;
	onConfirm: () => void;
	onCancel: () => void;
}

const ConfirmModal = ({
	action,
	displayName,
	tagsInput,
	setTagsInput,
	isSubmitting,
	onConfirm,
	onCancel,
}: ConfirmProps) => {
	return (
		<div
			className="fixed inset-0 z-modal flex items-center justify-center bg-background/80 backdrop-blur-sm"
			role="dialog"
			aria-modal="true"
			aria-labelledby="torrent-action-confirm-title"
		>
			<div className="relative w-full max-w-md rounded-xl border border-border/50 bg-card p-6 shadow-2xl">
				<div className="flex items-start gap-3">
					{action.tone === "warn" ? (
						<AlertCircle className="h-5 w-5 mt-0.5 text-amber-400" aria-hidden />
					) : (
						<action.icon className="h-5 w-5 mt-0.5 text-foreground" aria-hidden />
					)}
					<div className="flex-1 min-w-0">
						<h2
							id="torrent-action-confirm-title"
							className="text-base font-semibold text-foreground"
						>
							{action.label} torrent
						</h2>
						<p className="mt-1 text-sm text-muted-foreground">{action.confirm}</p>
						<p
							className="mt-2 text-xs font-mono text-muted-foreground truncate"
							title={displayName}
						>
							{displayName}
						</p>

						{action.requiresTags ? (
							<input
								type="text"
								className={cn(
									"mt-3 w-full rounded-md border border-border/60 bg-input/40 px-3 py-2 text-sm text-foreground",
									"placeholder:text-muted-foreground",
								)}
								placeholder="verified, seedonly, …"
								value={tagsInput}
								onChange={(e) => setTagsInput(e.target.value)}
								autoFocus
								disabled={isSubmitting}
								aria-label="Tags (comma separated)"
							/>
						) : null}
					</div>
				</div>

				<div className="mt-5 flex justify-end gap-2">
					<Button variant="secondary" onClick={onCancel} disabled={isSubmitting}>
						Cancel
					</Button>
					<Button
						variant={action.tone === "warn" ? "destructive" : "default"}
						onClick={onConfirm}
						disabled={isSubmitting || (action.requiresTags && tagsInput.trim().length === 0)}
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
