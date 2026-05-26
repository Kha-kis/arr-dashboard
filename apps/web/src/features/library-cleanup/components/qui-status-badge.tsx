"use client";

import type { CleanupQuiStatus } from "@arr/shared";
import { AlertOctagon, CheckCheck, Pause, Upload } from "lucide-react";
import { cn } from "../../../lib/utils";

interface QuiStatusBadgeProps {
	status: CleanupQuiStatus;
	className?: string;
}

const COPY: Record<
	Exclude<CleanupQuiStatus, "no_signal">,
	{ label: string; tone: string; icon: typeof Upload; tooltip: string }
> = {
	not_in_qui: {
		label: "qui: safe",
		tone: "text-emerald-300 border-emerald-500/30 bg-emerald-500/5",
		icon: CheckCheck,
		tooltip:
			"qui has no torrent for this item's infoHash — the file isn't seeding anywhere arr-dashboard can see. Highest-trust safe-to-delete signal.",
	},
	seeding: {
		label: "qui: seeding",
		tone: "text-amber-300 border-amber-500/30 bg-amber-500/5",
		icon: Upload,
		tooltip:
			"qui reports this torrent is actively seeding. Deleting will break the seed — consider letting it finish first.",
	},
	paused_or_error: {
		label: "qui: paused",
		tone: "text-sky-300 border-sky-500/30 bg-sky-500/5",
		icon: Pause,
		tooltip:
			"qui reports this torrent is paused or errored. The upload is already stopped, so deletion has less impact than for a seeding torrent.",
	},
};

/**
 * qui-derived deletion-safety badge for cleanup preview items (Phase 3.3).
 *
 * Renders nothing when `status === "no_signal"` so items without qui data
 * don't get visual chrome. The badge is informational — it doesn't change
 * cleanup behavior (Phase 2.2's `respectQuiSeeding` gate handles the
 * enforcement side).
 */
export const QuiStatusBadge = ({ status, className }: QuiStatusBadgeProps) => {
	if (status === "no_signal") return null;
	const entry = COPY[status];
	if (!entry) return null;
	const { label, tone, icon: Icon, tooltip } = entry;

	return (
		<span
			className={cn(
				"inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] font-medium border",
				tone,
				className,
			)}
			title={tooltip}
			aria-label={`${label} — ${tooltip}`}
		>
			<Icon className="h-3 w-3" aria-hidden />
			{label}
		</span>
	);
};

// Suppress unused-import warning for `AlertOctagon` — reserved for a
// future "qui: tracker unregistered" state when we add tracker-health
// surfacing to LibraryCache.
void AlertOctagon;
