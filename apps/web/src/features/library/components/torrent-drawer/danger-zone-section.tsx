"use client";

import { useState } from "react";
import { Button } from "../../../../components/ui/button";
import { toast } from "../../../../components/ui/toast";
import { useQuiTorrentAction } from "../../../../hooks/api/useQui";
import type { SeriesTorrentCopy } from "../../../../lib/api-client/qui";

// ── Danger zone ───────────────────────────────────────────────────────

export const DangerZoneSection: React.FC<{ copy: SeriesTorrentCopy; canAct: boolean }> = ({
	copy,
	canAct,
}) => {
	const actionMutation = useQuiTorrentAction();
	const [confirm, setConfirm] = useState<"keep" | "files" | null>(null);
	const handleDelete = (deleteFiles: boolean) => {
		if (!canAct) return;
		actionMutation.mutate(
			{
				quiInstanceId: copy.quiInstanceId!,
				qbitInstanceId: copy.qbitInstanceId!,
				hash: copy.infoHash,
				action: "delete",
				payload: { deleteFiles },
			},
			{
				onSuccess: () => {
					toast.success(deleteFiles ? "Torrent and files deleted" : "Torrent removed (files kept)");
					setConfirm(null);
				},
				onError: (err) => toast.error(err instanceof Error ? err.message : "Delete failed"),
			},
		);
	};
	return (
		<div className="space-y-2 text-[11px]">
			{confirm === null && (
				<div className="flex flex-wrap gap-1.5">
					<Button
						size="sm"
						variant="secondary"
						disabled={!canAct}
						onClick={() => setConfirm("keep")}
					>
						Delete (keep files)
					</Button>
					<Button
						size="sm"
						variant="destructive"
						disabled={!canAct}
						onClick={() => setConfirm("files")}
					>
						Delete with files
					</Button>
				</div>
			)}
			{confirm !== null && (
				<div className="space-y-2 rounded bg-red-500/10 p-2">
					<div className="text-red-200">
						{confirm === "files"
							? "This will delete the torrent AND all files on disk. Cannot be undone."
							: "This will remove the torrent from qBit. Files on disk are kept."}
					</div>
					<div className="flex gap-1.5">
						<Button
							size="sm"
							variant="destructive"
							disabled={!canAct}
							onClick={() => handleDelete(confirm === "files")}
						>
							Yes, delete{confirm === "files" ? " everything" : ""}
						</Button>
						<Button size="sm" variant="ghost" onClick={() => setConfirm(null)}>
							Cancel
						</Button>
					</div>
				</div>
			)}
		</div>
	);
};
