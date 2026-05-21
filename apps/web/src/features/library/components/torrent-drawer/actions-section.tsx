"use client";

import type { QuiAction } from "@arr/shared";
import { ExternalLink } from "lucide-react";
import { Button } from "../../../../components/ui/button";
import { toast } from "../../../../components/ui/toast";
import { useQuiTorrentAction } from "../../../../hooks/api/useQui";
import { useServicesQuery } from "../../../../hooks/api/useServicesQuery";
import type { SeriesTorrentCopy } from "../../../../lib/api-client/qui";

// ── Actions (always open) ─────────────────────────────────────────────

export const ActionsSection: React.FC<{ copy: SeriesTorrentCopy; canAct: boolean }> = ({
	copy,
	canAct,
}) => {
	const actionMutation = useQuiTorrentAction();
	const { data: services } = useServicesQuery();
	const quiOpenUrl = (() => {
		if (!copy.quiInstanceId) return null;
		const inst = services?.find((s) => s.id === copy.quiInstanceId);
		return inst?.externalUrl ?? inst?.baseUrl ?? null;
	})();
	// Download-queue priority only means anything while a torrent is still
	// downloading — once it's complete/seeding, queue order is moot. Gate
	// the priority controls on incompleteness so they never clutter the
	// drawer for a seeding torrent (an all-seeding library never sees them).
	const isDownloading = typeof copy.progress === "number" && copy.progress < 1;
	const run = (action: QuiAction, verb: string) => {
		if (!canAct) return;
		actionMutation.mutate(
			{
				quiInstanceId: copy.quiInstanceId!,
				qbitInstanceId: copy.qbitInstanceId!,
				hash: copy.infoHash,
				action,
				payload: {},
			},
			{
				onSuccess: () =>
					toast.success(`${verb}: ${copy.name ?? copy.infoHash.slice(0, 12)}`, {
						action:
							action === "pause"
								? { label: "Undo", onClick: () => run("resume", "Resumed") }
								: undefined,
					}),
				onError: (err) =>
					toast.error(
						`${verb} failed: ${err instanceof Error ? err.message : "qui rejected the action"}`,
					),
			},
		);
	};
	return (
		<div className="space-y-2">
			<div className="flex flex-wrap gap-1.5">
				<Button
					size="sm"
					variant="secondary"
					disabled={!canAct}
					onClick={() => run("pause", "Paused")}
				>
					Pause
				</Button>
				<Button
					size="sm"
					variant="secondary"
					disabled={!canAct}
					onClick={() => run("resume", "Resumed")}
				>
					Resume
				</Button>
				<Button
					size="sm"
					variant="secondary"
					disabled={!canAct}
					onClick={() => run("recheck", "Rechecked")}
				>
					Recheck
				</Button>
				<Button
					size="sm"
					variant="secondary"
					disabled={!canAct}
					onClick={() => run("reannounce", "Reannounced")}
				>
					Reannounce
				</Button>
				{quiOpenUrl && (
					<Button
						size="sm"
						variant="ghost"
						onClick={() => window.open(quiOpenUrl, "_blank", "noopener,noreferrer")}
					>
						<ExternalLink className="mr-1 h-3 w-3" />
						Open in qui
					</Button>
				)}
			</div>
			{/* Download-queue controls — only while the torrent is incomplete.
			 * For a seeding library these never render. */}
			{isDownloading && (
				<div className="space-y-1.5 border-t border-border/30 pt-2">
					<div className="text-[10px] uppercase tracking-wider text-muted-foreground/80">
						Download queue
					</div>
					<div className="flex flex-wrap gap-1.5">
						<Button
							size="sm"
							variant="secondary"
							disabled={!canAct}
							onClick={() => run("topPriority", "Moved to top of queue")}
						>
							Top
						</Button>
						<Button
							size="sm"
							variant="secondary"
							disabled={!canAct}
							onClick={() => run("increasePriority", "Priority raised")}
						>
							Move up
						</Button>
						<Button
							size="sm"
							variant="secondary"
							disabled={!canAct}
							onClick={() => run("decreasePriority", "Priority lowered")}
						>
							Move down
						</Button>
						<Button
							size="sm"
							variant="secondary"
							disabled={!canAct}
							onClick={() => run("bottomPriority", "Moved to bottom of queue")}
						>
							Bottom
						</Button>
						<Button
							size="sm"
							variant="secondary"
							disabled={!canAct}
							onClick={() => run("toggleSequentialDownload", "Toggled sequential download")}
						>
							Sequential
						</Button>
					</div>
				</div>
			)}
		</div>
	);
};
