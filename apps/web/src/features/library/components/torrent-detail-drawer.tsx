"use client";

import { AlertTriangle, ChevronDown, ChevronRight } from "lucide-react";
import { useState } from "react";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "../../../components/ui/sheet";
import { useIncognitoMode } from "../../../contexts/IncognitoContext";
import { useQuiCapabilities } from "../../../hooks/api/useQui";
import type { SeriesTorrentCopy } from "../../../lib/api-client/qui";
import { getLinuxSavePath } from "../../../lib/incognito";
import { ActionsSection } from "./torrent-drawer/actions-section";
import { AdvancedSection } from "./torrent-drawer/advanced-section";
import { BehaviorSection } from "./torrent-drawer/behavior-section";
import { DangerZoneSection } from "./torrent-drawer/danger-zone-section";
import { FilesSection } from "./torrent-drawer/files-section";
import { LimitsSection } from "./torrent-drawer/limits-section";
import { StatusSection } from "./torrent-drawer/status-section";
import { TagsCategorySection } from "./torrent-drawer/tags-category-section";
import { TrackersSection } from "./torrent-drawer/trackers-section";

interface TorrentDetailDrawerProps {
	copy: SeriesTorrentCopy | null;
	/**
	 * *arr-side context the drawer was launched from. Surfaces in the
	 * header so the user knows what content this torrent belongs to —
	 * qBit's name field is often unrelated to the *arr item (e.g. a
	 * generic folder name like "distributions"). Cold Read v2 finding.
	 */
	arrContext?: { seriesTitle: string; coverageLabel: string } | null;
	onClose: () => void;
}

/**
 * Per-torrent detail drawer — full control surface for one torrent.
 * Opens as a right-side sheet (480px wide); the user picks a section
 * to expand and the heavy data (properties, files) lazy-loads on demand.
 *
 * Sections are deliberately frequency-ordered: Status + Actions are
 * always open at the top, Danger Zone always last and collapsed. Each
 * intermediate section's collapse default reflects expected usage
 * frequency from the Cold Read survey (2026-05-18): Trackers + Tags
 * default open, Limits/Behavior/Files default closed.
 */
export const TorrentDetailDrawer: React.FC<TorrentDetailDrawerProps> = ({
	copy,
	arrContext,
	onClose,
}) => {
	const open = copy !== null;
	return (
		<Sheet open={open} onOpenChange={(o) => !o && onClose()}>
			<SheetContent side="right" className="w-[480px] sm:max-w-[480px] overflow-y-auto">
				{copy && <DrawerBody copy={copy} arrContext={arrContext ?? null} />}
			</SheetContent>
		</Sheet>
	);
};

const DrawerBody: React.FC<{
	copy: SeriesTorrentCopy;
	arrContext: { seriesTitle: string; coverageLabel: string } | null;
}> = ({ copy, arrContext }) => {
	const [incognito] = useIncognitoMode();
	const canAct =
		!copy.quiUnreachable &&
		typeof copy.qbitInstanceId === "number" &&
		typeof copy.quiInstanceId === "string";

	// Capability gating — qui reports what the connected qBittorrent's
	// WebAPI version actually supports. While the query is in flight we
	// optimistically assume support (`?? true`) so controls don't flash
	// disabled every time the drawer opens.
	const capabilitiesQuery = useQuiCapabilities({
		quiInstanceId: copy.quiInstanceId ?? null,
		qbitInstanceId: copy.qbitInstanceId ?? null,
		enabled: !copy.quiUnreachable,
	});
	const caps = capabilitiesQuery.data?.capabilities;
	const trackerEditingOk = caps?.supportsTrackerEditing ?? true;
	const shareLimitsOk = caps?.supportsShareLimitsAction ?? true;
	const unsupported: string[] = [];
	if (caps) {
		if (!trackerEditingOk) unsupported.push("tracker editing");
		if (!shareLimitsOk) unsupported.push("share / seeding limits");
	}

	return (
		<div className="space-y-4 text-[12px]">
			<SheetHeader className="space-y-1">
				{/* *arr-side anchor — surfaces ABOVE the qBit name so the user
				 * recognizes which content this torrent belongs to (Euphoria
				 * S03E01) before reading the often-cryptic qBit name. Cold
				 * Read v2 caught this gap. */}
				{arrContext && (
					<div className="text-[10px] uppercase tracking-wider text-muted-foreground/80">
						From {arrContext.seriesTitle} · {arrContext.coverageLabel}
					</div>
				)}
				<SheetTitle className="break-all font-mono text-[13px] leading-snug">
					{/* `copy.name` is qBit's display name. For library copies
					 * with a folder-style name it can read like a path —
					 * surface the leaf segment so the title isn't dominated
					 * by parent directories. Incognito mask still applies. */}
					{(() => {
						if (!copy.name) return copy.infoHash.slice(0, 12);
						const display = incognito ? getLinuxSavePath(copy.name) : copy.name;
						const leaf = display.includes("/") ? (display.split("/").pop() ?? display) : display;
						return leaf;
					})()}
				</SheetTitle>
				{/* Incognito visibility — when paths/names are masked, surface
				 * a pill so the user can't mistake masked stubs for real
				 * data. Cold Read v2 spent 20 minutes confused about
				 * /media/nas/linux before we realized incognito was on. */}
				{incognito && (
					<div className="text-[10px] italic text-amber-300/80">
						Incognito mode on — names + paths are masked
					</div>
				)}
				<div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[10px] text-muted-foreground">
					<span
						className={`rounded px-1.5 py-0.5 ${
							copy.role === "library"
								? "bg-blue-500/20 text-blue-200"
								: "bg-purple-500/20 text-purple-200"
						}`}
					>
						{copy.role === "library" ? "Library" : "Cross-seed"}
					</span>
					<span className="font-mono">{copy.infoHash.slice(0, 12)}…</span>
					{typeof copy.ratio === "number" && <span>ratio {copy.ratio.toFixed(2)}×</span>}
				</div>
			</SheetHeader>

			{unsupported.length > 0 && (
				<div className="rounded border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-[11px] text-amber-200">
					Your qBittorrent{caps?.webAPIVersion ? ` (WebAPI ${caps.webAPIVersion})` : ""} doesn't
					support {unsupported.join(" or ")} — those controls are disabled below.
				</div>
			)}

			<StatusSection copy={copy} />
			<ActionsSection copy={copy} canAct={canAct} />

			<DrawerSection title="Trackers" defaultOpen={true}>
				<TrackersSection copy={copy} canAct={canAct && trackerEditingOk} />
			</DrawerSection>

			<DrawerSection title="Tags & Category" defaultOpen={true}>
				<TagsCategorySection copy={copy} canAct={canAct} />
			</DrawerSection>

			<DrawerSection title="Limits & seeding rules" defaultOpen={false}>
				<LimitsSection copy={copy} canAct={canAct && shareLimitsOk} />
			</DrawerSection>

			<DrawerSection title="Behavior" defaultOpen={false}>
				<BehaviorSection copy={copy} canAct={canAct} />
			</DrawerSection>

			<DrawerSection title="Files" defaultOpen={false}>
				<FilesSection copy={copy} />
			</DrawerSection>

			<DrawerSection title="Advanced" defaultOpen={false}>
				<AdvancedSection copy={copy} canAct={canAct} />
			</DrawerSection>

			<DrawerSection title="Danger zone" defaultOpen={false} tone="danger">
				<DangerZoneSection copy={copy} canAct={canAct} />
			</DrawerSection>
		</div>
	);
};

// ── Reusable collapsible section ──────────────────────────────────────

const DrawerSection: React.FC<{
	title: string;
	defaultOpen?: boolean;
	tone?: "default" | "danger";
	children: React.ReactNode;
}> = ({ title, defaultOpen = false, tone = "default", children }) => {
	const [open, setOpen] = useState(defaultOpen);
	return (
		<div
			className={`rounded border ${
				tone === "danger" ? "border-red-500/30 bg-red-500/5" : "border-border/40 bg-card/30"
			}`}
		>
			<button
				type="button"
				onClick={() => setOpen((o) => !o)}
				className={`flex w-full items-center justify-between px-3 py-2 text-left text-[11px] font-medium ${
					tone === "danger" ? "text-red-200" : "text-foreground"
				}`}
			>
				<span className="flex items-center gap-1.5">
					{tone === "danger" && <AlertTriangle className="h-3.5 w-3.5" />}
					{title}
				</span>
				{open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
			</button>
			{open && <div className="border-t border-border/30 px-3 py-2">{children}</div>}
		</div>
	);
};
