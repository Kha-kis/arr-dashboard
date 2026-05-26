"use client";

import { Button } from "../../../../components/ui/button";
import { toast } from "../../../../components/ui/toast";
import { useQuiTorrentAction } from "../../../../hooks/api/useQui";
import type { SeriesTorrentCopy } from "../../../../lib/api-client/qui";

// ── Behavior ──────────────────────────────────────────────────────────

export const BehaviorSection: React.FC<{ copy: SeriesTorrentCopy; canAct: boolean }> = ({
	copy,
	canAct,
}) => {
	const actionMutation = useQuiTorrentAction();
	const fire = (
		action: "toggleAutoTMM" | "forceStart",
		payload: Record<string, unknown>,
		verb: string,
	) => {
		if (!canAct) return;
		actionMutation.mutate(
			{
				quiInstanceId: copy.quiInstanceId!,
				qbitInstanceId: copy.qbitInstanceId!,
				hash: copy.infoHash,
				action,
				payload,
			},
			{
				onSuccess: () => toast.success(verb),
				onError: (err) => toast.error(err instanceof Error ? err.message : `${verb} failed`),
			},
		);
	};
	return (
		<div className="space-y-2 text-[11px]">
			<div className="flex flex-wrap gap-1.5">
				<Button
					size="sm"
					variant="secondary"
					disabled={!canAct}
					onClick={() => fire("toggleAutoTMM", { enable: true }, "Auto-management enabled")}
				>
					Enable Auto-management
				</Button>
				<Button
					size="sm"
					variant="secondary"
					disabled={!canAct}
					onClick={() => fire("toggleAutoTMM", { enable: false }, "Auto-management disabled")}
				>
					Disable Auto-management
				</Button>
				<Button
					size="sm"
					variant="secondary"
					disabled={!canAct}
					onClick={() => fire("forceStart", {}, "Force-start toggled")}
				>
					Force start
				</Button>
			</div>
			<div className="text-[10px] italic text-muted-foreground">
				Super-seeding: not supported by qui (qBit-only feature)
			</div>
		</div>
	);
};
