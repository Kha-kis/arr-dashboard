"use client";

import { Check, Pencil, Trash2, X } from "lucide-react";
import { useState } from "react";
import { Button } from "../../../../components/ui/button";
import { toast } from "../../../../components/ui/toast";
import {
	useQuiAddTrackers,
	useQuiEditTracker,
	useQuiRemoveTrackers,
} from "../../../../hooks/api/useQui";
import type { SeriesTorrentCopy } from "../../../../lib/api-client/qui";

// ── Trackers ──────────────────────────────────────────────────────────

/**
 * Hostname of a full announce URL the operator just typed. The browser
 * holds the whole URL here (the operator supplied it), so extracting the
 * hostname locally is safe — and storing only the hostname keeps the
 * optimistic row consistent with `copy.trackerHostnames` (which is
 * passkey-stripped server-side). Falls back to the raw input when it
 * isn't a parseable URL, so the row still shows something recognizable.
 */
const hostnameOf = (url: string): string => {
	try {
		return new URL(url).hostname;
	} catch {
		return url;
	}
};

export const TrackersSection: React.FC<{ copy: SeriesTorrentCopy; canAct: boolean }> = ({
	copy,
	canAct,
}) => {
	// Optimistic local mirror of the torrent's tracker hostnames. The drawer
	// receives `copy` as a frozen snapshot (see TorrentDetailDrawer), so a
	// query refetch can't update an open drawer — every mutating drawer
	// section keeps its own edit state (cf. TagsCategorySection).
	const [tracks, setTracks] = useState<string[]>(copy.trackerHostnames ?? []);
	const [addUrl, setAddUrl] = useState("");
	const [editing, setEditing] = useState<string | null>(null);
	const [editUrl, setEditUrl] = useState("");
	const addMutation = useQuiAddTrackers();
	const removeMutation = useQuiRemoveTrackers();
	const editMutation = useQuiEditTracker();
	const busy = addMutation.isPending || removeMutation.isPending || editMutation.isPending;

	const handleAdd = () => {
		const url = addUrl.trim();
		if (!canAct || !url) return;
		addMutation.mutate(
			{
				quiInstanceId: copy.quiInstanceId!,
				qbitInstanceId: copy.qbitInstanceId!,
				hash: copy.infoHash,
				urls: [url],
			},
			{
				onSuccess: () => {
					toast.success("Tracker added");
					const host = hostnameOf(url);
					setTracks((prev) => (prev.includes(host) ? prev : [...prev, host]));
					setAddUrl("");
				},
				onError: (err) => toast.error(err instanceof Error ? err.message : "Failed to add tracker"),
			},
		);
	};

	const handleRemove = (host: string) => {
		if (!canAct) return;
		removeMutation.mutate(
			{
				quiInstanceId: copy.quiInstanceId!,
				qbitInstanceId: copy.qbitInstanceId!,
				hash: copy.infoHash,
				hostnames: [host],
			},
			{
				onSuccess: () => {
					toast.success("Tracker removed");
					setTracks((prev) => prev.filter((h) => h !== host));
				},
				onError: (err) =>
					toast.error(err instanceof Error ? err.message : "Failed to remove tracker"),
			},
		);
	};

	const startEdit = (host: string) => {
		setEditing(host);
		setEditUrl("");
	};

	const cancelEdit = () => {
		setEditing(null);
		setEditUrl("");
	};

	const handleEditSave = (oldHost: string) => {
		const url = editUrl.trim();
		if (!canAct || !url) return;
		editMutation.mutate(
			{
				quiInstanceId: copy.quiInstanceId!,
				qbitInstanceId: copy.qbitInstanceId!,
				hash: copy.infoHash,
				oldHostname: oldHost,
				newURL: url,
			},
			{
				onSuccess: () => {
					toast.success("Tracker updated");
					const host = hostnameOf(url);
					setTracks((prev) => prev.map((h) => (h === oldHost ? host : h)));
					cancelEdit();
				},
				onError: (err) =>
					toast.error(err instanceof Error ? err.message : "Failed to update tracker"),
			},
		);
	};

	return (
		<div className="space-y-2 text-[11px]">
			{tracks.length === 0 && <div className="text-muted-foreground italic">No trackers</div>}
			{tracks.map((host) =>
				editing === host ? (
					<div key={host} className="space-y-1">
						<div className="text-[10px] text-muted-foreground">
							Replacing <span className="font-mono text-foreground">{host}</span>
						</div>
						<div className="flex items-center gap-1.5">
							<input
								type="text"
								value={editUrl}
								onChange={(e) => setEditUrl(e.target.value)}
								placeholder="New full announce URL"
								className="flex-1 rounded border border-border/60 bg-card/50 px-2 py-1 text-[11px] focus:outline-none focus:ring-1 focus:ring-foreground/40"
							/>
							<button
								type="button"
								aria-label="Save tracker"
								disabled={!canAct || !editUrl.trim() || busy}
								onClick={() => handleEditSave(host)}
								className="text-muted-foreground hover:text-green-400 disabled:opacity-50"
							>
								<Check className="h-3.5 w-3.5" />
							</button>
							<button
								type="button"
								aria-label="Cancel edit"
								onClick={cancelEdit}
								className="text-muted-foreground hover:text-foreground"
							>
								<X className="h-3.5 w-3.5" />
							</button>
						</div>
					</div>
				) : (
					<div key={host} className="flex items-center justify-between gap-2">
						<span className="break-all font-mono text-foreground">{host}</span>
						<div className="flex shrink-0 items-center gap-1.5">
							<button
								type="button"
								aria-label={`Edit tracker ${host}`}
								disabled={!canAct || busy}
								onClick={() => startEdit(host)}
								className="text-muted-foreground hover:text-foreground disabled:opacity-50"
							>
								<Pencil className="h-3 w-3" />
							</button>
							<button
								type="button"
								aria-label={`Remove tracker ${host}`}
								disabled={!canAct || busy}
								onClick={() => handleRemove(host)}
								className="text-muted-foreground hover:text-red-400 disabled:opacity-50"
							>
								<Trash2 className="h-3 w-3" />
							</button>
						</div>
					</div>
				),
			)}
			<div className="flex gap-1.5 pt-1">
				<input
					type="text"
					value={addUrl}
					onChange={(e) => setAddUrl(e.target.value)}
					placeholder="https://tracker.example/announce"
					className="flex-1 rounded border border-border/60 bg-card/50 px-2 py-1 text-[11px] focus:outline-none focus:ring-1 focus:ring-foreground/40"
				/>
				<Button
					size="sm"
					variant="secondary"
					disabled={!canAct || !addUrl.trim() || busy}
					onClick={handleAdd}
				>
					Add
				</Button>
			</div>
		</div>
	);
};
