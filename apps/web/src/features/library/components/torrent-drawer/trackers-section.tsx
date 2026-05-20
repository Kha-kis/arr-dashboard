"use client";

import { Trash2 } from "lucide-react";
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

export const TrackersSection: React.FC<{ copy: SeriesTorrentCopy; canAct: boolean }> = ({
	copy,
	canAct,
}) => {
	const [addUrl, setAddUrl] = useState("");
	const addMutation = useQuiAddTrackers();
	const removeMutation = useQuiRemoveTrackers();
	const _editMutation = useQuiEditTracker();
	void _editMutation;
	const tracks = copy.trackerHostnames ?? [];
	const handleAdd = () => {
		if (!canAct || !addUrl.trim()) return;
		addMutation.mutate(
			{
				quiInstanceId: copy.quiInstanceId!,
				qbitInstanceId: copy.qbitInstanceId!,
				hash: copy.infoHash,
				urls: [addUrl.trim()],
			},
			{
				onSuccess: () => {
					toast.success("Tracker added");
					setAddUrl("");
				},
				onError: (err) => toast.error(err instanceof Error ? err.message : "Failed to add tracker"),
			},
		);
	};
	const handleRemove = (url: string) => {
		if (!canAct) return;
		removeMutation.mutate(
			{
				quiInstanceId: copy.quiInstanceId!,
				qbitInstanceId: copy.qbitInstanceId!,
				hash: copy.infoHash,
				urls: [url],
			},
			{
				onSuccess: () => toast.success("Tracker removed"),
				onError: (err) =>
					toast.error(err instanceof Error ? err.message : "Failed to remove tracker"),
			},
		);
	};
	return (
		<div className="space-y-2 text-[11px]">
			{tracks.length === 0 && <div className="text-muted-foreground italic">No trackers</div>}
			{tracks.map((host) => (
				<div key={host} className="flex items-center justify-between gap-2">
					<span className="break-all font-mono text-foreground">{host}</span>
					<button
						type="button"
						aria-label={`Remove tracker ${host}`}
						disabled={!canAct}
						onClick={() => handleRemove(host)}
						className="text-muted-foreground hover:text-red-400 disabled:opacity-50"
					>
						<Trash2 className="h-3 w-3" />
					</button>
				</div>
			))}
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
					disabled={!canAct || !addUrl.trim()}
					onClick={handleAdd}
				>
					Add
				</Button>
			</div>
		</div>
	);
};
