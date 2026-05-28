"use client";

import type { CrossSeedDiscoveryItem, QuiCrossSeedMatch } from "@arr/shared";
import { Network } from "lucide-react";
import { GlassmorphicCard, ServiceBadge } from "../../../components/layout";
import {
	getLinuxIndexer,
	getLinuxInstanceName,
	getLinuxIsoName,
	useIncognitoMode,
} from "../../../lib/incognito";
import { cn } from "../../../lib/utils";

interface CrossSeedItemCardProps {
	item: CrossSeedDiscoveryItem;
	animationDelay: number;
	/** Phase 4.2 — selection state for the bulk-action toolbar. */
	isSelected?: boolean;
	/** Phase 4.2 — toggle handler; only rendered when defined (selection mode on). */
	onToggleSelect?: () => void;
	/**
	 * Phase 4.2 — disables the checkbox for items without a `primary` torrent
	 * (qui doesn't know the hash, so we can't target it). The card stays
	 * visible but is not selectable.
	 */
	selectDisabled?: boolean;
	/**
	 * qui's tracker-meta map (hostname → {iconUrl, name}) — the same registry
	 * the library grid uses as the single source of truth for tracker
	 * identity. Resolves each sibling's hostname to a brand icon + friendly
	 * name. Undefined until the icons query resolves; falls back to the bare
	 * hostname per-entry.
	 */
	trackerIcons?: Record<string, { iconUrl?: string; name?: string }>;
}

// Match type is *how* qui correlated the sibling — useful provenance, but low
// signal day-to-day (most matches are `name`). Demoted to a quiet chip; the
// tone-coded labels were misreading as warnings (amber `name` looked alarming
// when it's the normal case). Kept with an explanatory tooltip instead.
const MATCH_TYPE_LABEL: Record<QuiCrossSeedMatch["matchType"], string> = {
	release: "release match",
	content_path: "content-path match",
	name: "name match",
};

const MATCH_TYPE_HINT: Record<QuiCrossSeedMatch["matchType"], string> = {
	release: "qui matched these by release name — highest confidence.",
	content_path: "qui matched these by on-disk content path — the copies share a location.",
	name: "qui matched these by torrent name. Common when cross-seeds live at different paths.",
};

// Tracker health is the page's primary signal — surfaced as a prominent badge.
// `unregistered` is actionable (dead cross-seed); `tracker_down` is usually
// transient. Remediation happens in qui (siblings are read-only here per D7).
const HEALTH_COPY: Record<
	NonNullable<QuiCrossSeedMatch["trackerHealth"]>,
	{ label: string; className: string; hint: string }
> = {
	unregistered: {
		label: "Unregistered",
		className: "bg-red-500/15 text-red-300 border-red-500/30",
		hint: "The tracker no longer recognizes this torrent — likely a dead cross-seed. Remove it from qui to reclaim the entry (your library files stay; they belong to the primary torrent).",
	},
	tracker_down: {
		label: "Tracker down",
		className: "bg-amber-500/15 text-amber-300 border-amber-500/30",
		hint: "The tracker is currently unreachable. Usually transient — no action needed unless it persists.",
	},
};

export const CrossSeedItemCard = ({
	item,
	animationDelay,
	isSelected = false,
	onToggleSelect,
	selectDisabled = false,
	trackerIcons,
}: CrossSeedItemCardProps) => {
	const [incognito] = useIncognitoMode();

	const displayTitle = incognito ? getLinuxIsoName(item.title) : item.title;
	const displayInstance = incognito
		? getLinuxInstanceName(item.arrInstanceLabel)
		: item.arrInstanceLabel;
	const displayQbit = incognito
		? getLinuxInstanceName(item.primary?.qbitInstanceName ?? "")
		: item.primary?.qbitInstanceName;

	const attentionCount = item.siblings.filter((s) => s.trackerHealth).length;
	const needsAttention = attentionCount > 0;

	return (
		<GlassmorphicCard
			padding="md"
			animationDelay={animationDelay}
			className={cn(needsAttention && "ring-1 ring-amber-500/40")}
		>
			<div className="flex items-start gap-3">
				{onToggleSelect ? (
					// Selection mode (Phase 4.2). The checkbox sits in the icon
					// slot so the layout doesn't shift when selection mode toggles.
					// Items without a `primary` torrent can't be targeted by
					// mutations (no hash for qui), so the box is disabled with
					// a tooltip explaining why.
					<label
						className="flex-shrink-0 mt-1 cursor-pointer"
						title={
							selectDisabled ? "qui does not know this torrent — cannot select" : "Toggle selection"
						}
					>
						<input
							type="checkbox"
							checked={isSelected}
							onChange={onToggleSelect}
							disabled={selectDisabled}
							className="h-4 w-4 rounded border-border accent-primary"
							aria-label={`Select ${displayTitle}`}
						/>
					</label>
				) : (
					<div className="flex-shrink-0 mt-1">
						<Network className="h-5 w-5 text-muted-foreground" aria-hidden />
					</div>
				)}
				<div className="flex-1 min-w-0">
					<div className="flex items-center gap-2 flex-wrap">
						<h3 className="text-base font-semibold truncate" title={displayTitle}>
							{displayTitle}
							{item.year ? (
								<span className="text-muted-foreground/70 font-normal"> ({item.year})</span>
							) : null}
						</h3>
						<ServiceBadge service={item.arrService} />
						<span className="text-xs text-muted-foreground">{displayInstance}</span>
						{needsAttention ? (
							<span
								className="rounded-full border border-amber-500/30 bg-amber-500/15 px-2 py-0.5 text-[10px] font-semibold text-amber-300"
								title={`${attentionCount} cross-seed sibling${attentionCount === 1 ? "" : "s"} need attention`}
							>
								Needs attention
							</span>
						) : null}
					</div>

					{item.primary ? (
						<div className="mt-2 flex items-center gap-3 text-xs text-muted-foreground">
							<span>
								Primary on <span className="text-foreground/90">{displayQbit}</span>
							</span>
							<span aria-hidden>·</span>
							<span>state: {item.primary.state}</span>
							<span aria-hidden>·</span>
							<span>ratio: {item.primary.ratio.toFixed(2)}×</span>
						</div>
					) : null}

					<div className="mt-3 space-y-1.5">
						<div className="text-xs text-muted-foreground uppercase tracking-wide">
							Cross-seed siblings ({item.siblings.length})
						</div>
						<ul className="space-y-1.5">
							{item.siblings.map((sibling) => {
								// Resolve tracker identity through qui's registry (icon +
								// friendly name), the same way the library grid does. In
								// incognito we deliberately skip the registry so neither the
								// brand name nor its icon leaks — `getLinuxIndexer` masks it.
								const trackerMeta = incognito ? undefined : trackerIcons?.[sibling.tracker];
								const trackerLabel = incognito
									? getLinuxIndexer(sibling.tracker)
									: (trackerMeta?.name ?? sibling.tracker) || "unknown tracker";
								const siblingInstance = incognito
									? getLinuxInstanceName(sibling.instanceName)
									: sibling.instanceName;
								const health = sibling.trackerHealth ? HEALTH_COPY[sibling.trackerHealth] : null;
								return (
									<li
										key={`${sibling.instanceId}-${sibling.hash}`}
										className={cn(
											"flex items-center gap-2 text-xs rounded-lg px-2.5 py-1.5 border",
											health ? "border-amber-500/30 bg-amber-500/5" : "border-border/30 bg-card/20",
										)}
									>
										<span className="flex items-center gap-1.5 font-medium text-foreground/90">
											{trackerMeta?.iconUrl ? (
												<img
													src={trackerMeta.iconUrl}
													alt=""
													aria-hidden
													className="h-3.5 w-3.5 rounded-sm object-contain"
												/>
											) : null}
											{trackerLabel}
										</span>
										<span className="text-muted-foreground/70">·</span>
										<span className="text-muted-foreground">{siblingInstance}</span>
										{health ? (
											<span
												className={cn(
													"rounded border px-1.5 py-0.5 text-[10px] font-semibold",
													health.className,
												)}
												title={health.hint}
											>
												{health.label}
											</span>
										) : null}
										{/* Match type is provenance, not a signal — demoted to a
										    quiet chip pushed to the row's end, tooltip on hover. */}
										<span
											className="ml-auto rounded bg-card/40 px-1.5 py-0.5 text-[10px] text-muted-foreground/60"
											title={MATCH_TYPE_HINT[sibling.matchType]}
										>
											{MATCH_TYPE_LABEL[sibling.matchType]}
										</span>
									</li>
								);
							})}
						</ul>
					</div>
				</div>
				{/*
				 * No per-row "Open in qui": qui exposes no stable per-torrent URL,
				 * so every link would resolve to the same qui home page. The bridge
				 * to qui lives once in the page header (CrossSeedClient) instead —
				 * honest about the grain we actually have.
				 */}
			</div>
		</GlassmorphicCard>
	);
};
