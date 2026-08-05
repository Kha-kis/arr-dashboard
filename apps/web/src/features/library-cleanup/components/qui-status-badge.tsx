"use client";

import type { CleanupQuiStatus } from "@arr/shared";
import { CircleOff, Pause, Upload } from "lucide-react";
import { cn } from "../../../lib/utils";

interface QuiStatusBadgeProps {
	status: CleanupQuiStatus;
	observedAt?: string | null;
	className?: string;
}

const COPY: Record<
	Exclude<CleanupQuiStatus, "no_signal">,
	{ label: string; tone: string; icon: typeof Upload; tooltip: string }
> = {
	not_in_qui: {
		label: "qUI cache: no match",
		tone: "text-slate-300 border-slate-500/30 bg-slate-500/5",
		icon: CircleOff,
		tooltip:
			"No current qUI match is recorded for this infoHash. This cache status is informational only; protected deletion checks every enabled qUI again immediately before deleting files.",
	},
	seeding: {
		label: "qUI cache: active",
		tone: "text-amber-300 border-amber-500/30 bg-amber-500/5",
		icon: Upload,
		tooltip:
			"The last qUI cache sync found an active torrent. This snapshot is informational only; protected deletion checks every enabled qUI again immediately before deleting files.",
	},
	paused_or_error: {
		label: "qUI cache: inactive",
		tone: "text-sky-300 border-sky-500/30 bg-sky-500/5",
		icon: Pause,
		tooltip:
			"The last qUI cache sync found a paused or errored torrent. This snapshot is informational only; protected deletion checks every enabled qUI again immediately before deleting files.",
	},
};

/**
 * Cached qUI observation badge for cleanup preview items (Phase 3.3).
 *
 * Renders nothing when `status === "no_signal"` so items without qui data
 * don't get visual chrome. The badge is informational — it doesn't change
 * cleanup behavior (Phase 2.2's `respectQuiSeeding` gate handles the
 * enforcement side).
 */
export const QuiStatusBadge = ({ status, observedAt, className }: QuiStatusBadgeProps) => {
	if (status === "no_signal") return null;
	const entry = COPY[status];
	if (!entry) return null;
	const { label, tone, icon: Icon, tooltip } = entry;
	const observedAtSuffix = observedAt ? ` Cached at ${new Date(observedAt).toLocaleString()}.` : "";
	const accessibleDescription = `${tooltip}${observedAtSuffix}`;

	return (
		<span
			className={cn(
				"inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] font-medium border",
				tone,
				className,
			)}
			title={accessibleDescription}
			aria-label={`${label} — ${accessibleDescription}`}
		>
			<Icon className="h-3 w-3" aria-hidden />
			{label}
		</span>
	);
};
