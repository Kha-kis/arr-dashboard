"use client";

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
	const run = (action: "pause" | "resume" | "recheck" | "reannounce", verb: string) => {
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
	);
};
