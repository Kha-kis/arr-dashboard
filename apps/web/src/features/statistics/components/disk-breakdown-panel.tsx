"use client";

/**
 * Per-disk breakdown for the dashboard's combined-storage rollup (issue #495).
 *
 * The headline storage card answers "how much media space do I have?". This
 * panel answers "how was that number computed?" — every disk every connected
 * *arr reported, with a per-row tag explaining whether it was counted in the
 * rollup, deduplicated by another instance, or excluded as non-media.
 *
 * Privacy: raw filesystem paths are sensitive (they leak the operator's
 * storage layout). When incognito mode is on, paths render as `Disk N`
 * placeholders. The wire still carries unredacted paths so the UI can be
 * useful when the user has incognito off; the gating is purely render-side.
 */

import type { DiskBreakdownEntry } from "@arr/shared";
import { CheckCircle2, XCircle } from "lucide-react";

import { useIncognitoMode } from "@/contexts/IncognitoContext";
import { cn } from "@/lib/utils";

import { formatBytes } from "../lib/formatters";

interface DiskBreakdownPanelProps {
	disks: DiskBreakdownEntry[];
}

const REASON_LABEL: Record<DiskBreakdownEntry["reason"], string> = {
	media: "Media",
	"no-matching-root-folder": "No *arr root folder on this disk",
	deduplicated: "Already counted via another instance",
};

const REASON_TONE: Record<DiskBreakdownEntry["reason"], string> = {
	media: "text-emerald-500 dark:text-emerald-400",
	"no-matching-root-folder": "text-muted-foreground",
	deduplicated: "text-muted-foreground",
};

export const DiskBreakdownPanel = ({ disks }: DiskBreakdownPanelProps) => {
	const [incognitoMode] = useIncognitoMode();

	if (disks.length === 0) {
		return (
			<div className="rounded-xl border border-border/50 bg-card/30 p-6 text-center text-sm text-muted-foreground backdrop-blur-sm">
				No disks reported by any connected instance.
			</div>
		);
	}

	return (
		<div className="rounded-xl border border-border/50 bg-card/30 backdrop-blur-sm">
			<div className="border-b border-border/50 px-4 py-3">
				<h3 className="text-sm font-medium text-foreground">Storage Breakdown</h3>
				<p className="mt-0.5 text-xs text-muted-foreground">
					Disks included in the rollup hold at least one configured *arr root folder. Disks marked
					excluded carry config, container OS, or system data that isn't media.
				</p>
			</div>
			<ul className="divide-y divide-border/50">
				{disks.map((disk, idx) => {
					const Icon = disk.includedInRollup ? CheckCircle2 : XCircle;
					const displayPath = incognitoMode ? `Disk ${idx + 1}` : (disk.path ?? `Disk ${idx + 1}`);
					const usedSpace = Math.max(0, disk.totalSpace - disk.freeSpace);
					const usagePercent =
						disk.totalSpace > 0 ? Math.min(100, (usedSpace / disk.totalSpace) * 100) : 0;
					const displayInstance = incognitoMode ? "Instance" : (disk.instanceName ?? undefined);

					return (
						<li key={`${disk.path ?? "no-path"}-${idx}`} className="px-4 py-3">
							<div className="flex items-start gap-3">
								<Icon
									className={cn(
										"mt-0.5 h-4 w-4 shrink-0",
										disk.includedInRollup
											? "text-emerald-500 dark:text-emerald-400"
											: "text-muted-foreground/60",
									)}
								/>
								<div className="min-w-0 flex-1">
									<div className="flex items-baseline justify-between gap-3">
										<code className="truncate font-mono text-sm font-medium text-foreground">
											{displayPath}
										</code>
										<span className="shrink-0 text-xs text-muted-foreground">
											{formatBytes(disk.freeSpace)} free of {formatBytes(disk.totalSpace)}
										</span>
									</div>
									<div className="mt-1.5 h-1 overflow-hidden rounded-full bg-muted/40">
										<div
											className={cn(
												"h-full rounded-full transition-all",
												disk.includedInRollup
													? "bg-emerald-500/70 dark:bg-emerald-400/70"
													: "bg-muted-foreground/30",
											)}
											style={{ width: `${usagePercent}%` }}
										/>
									</div>
									<div className="mt-1.5 flex items-center justify-between gap-3 text-xs">
										<span className={cn("font-medium", REASON_TONE[disk.reason])}>
											{REASON_LABEL[disk.reason]}
										</span>
										{displayInstance ? (
											<span className="text-muted-foreground">{displayInstance}</span>
										) : null}
									</div>
								</div>
							</div>
						</li>
					);
				})}
			</ul>
		</div>
	);
};
