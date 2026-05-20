"use client";

import { useState } from "react";
import { Button } from "../../../../components/ui/button";
import { toast } from "../../../../components/ui/toast";
import { useQuiRenameTorrent, useQuiTorrentAction } from "../../../../hooks/api/useQui";
import type { SeriesTorrentCopy } from "../../../../lib/api-client/qui";

// ── Advanced ──────────────────────────────────────────────────────────

export const AdvancedSection: React.FC<{ copy: SeriesTorrentCopy; canAct: boolean }> = ({
	copy,
	canAct,
}) => {
	const renameMutation = useQuiRenameTorrent();
	const actionMutation = useQuiTorrentAction();
	const [renameValue, setRenameValue] = useState(copy.name ?? "");
	const [locationValue, setLocationValue] = useState(copy.savePath ?? "");
	const handleRename = () => {
		if (!canAct || !renameValue.trim()) return;
		renameMutation.mutate(
			{
				quiInstanceId: copy.quiInstanceId!,
				qbitInstanceId: copy.qbitInstanceId!,
				hash: copy.infoHash,
				name: renameValue.trim(),
			},
			{
				onSuccess: () => toast.success("Renamed"),
				onError: (err) => toast.error(err instanceof Error ? err.message : "Rename failed"),
			},
		);
	};
	const handleSetLocation = () => {
		if (!canAct || !locationValue.trim()) return;
		actionMutation.mutate(
			{
				quiInstanceId: copy.quiInstanceId!,
				qbitInstanceId: copy.qbitInstanceId!,
				hash: copy.infoHash,
				action: "setLocation",
				payload: { location: locationValue.trim() },
			},
			{
				onSuccess: () => toast.success("Location updated — data is being moved by qBit"),
				onError: (err) => toast.error(err instanceof Error ? err.message : "Set location failed"),
			},
		);
	};
	return (
		<div className="space-y-3 text-[11px]">
			<div className="space-y-1">
				<label className="text-muted-foreground">Rename torrent</label>
				<div className="flex gap-1.5">
					<input
						type="text"
						value={renameValue}
						onChange={(e) => setRenameValue(e.target.value)}
						className="flex-1 rounded border border-border/60 bg-card/50 px-2 py-1 font-mono text-[11px] focus:outline-none focus:ring-1 focus:ring-foreground/40"
					/>
					<Button size="sm" variant="secondary" disabled={!canAct} onClick={handleRename}>
						Rename
					</Button>
				</div>
			</div>
			<div className="space-y-1">
				<label className="text-muted-foreground">Set location (moves data on disk)</label>
				<div className="flex gap-1.5">
					<input
						type="text"
						value={locationValue}
						onChange={(e) => setLocationValue(e.target.value)}
						className="flex-1 rounded border border-border/60 bg-card/50 px-2 py-1 font-mono text-[11px] focus:outline-none focus:ring-1 focus:ring-foreground/40"
					/>
					<Button size="sm" variant="secondary" disabled={!canAct} onClick={handleSetLocation}>
						Move
					</Button>
				</div>
			</div>
		</div>
	);
};
