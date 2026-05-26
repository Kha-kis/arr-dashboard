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
}

const MATCH_TYPE_COPY: Record<QuiCrossSeedMatch["matchType"], { label: string; tone: string }> = {
	release: { label: "release-name match", tone: "text-emerald-300" },
	content_path: { label: "content-path match", tone: "text-sky-300" },
	name: { label: "torrent-name match", tone: "text-amber-300" },
};

export const CrossSeedItemCard = ({
	item,
	animationDelay,
	isSelected = false,
	onToggleSelect,
	selectDisabled = false,
}: CrossSeedItemCardProps) => {
	const [incognito] = useIncognitoMode();

	const displayTitle = incognito ? getLinuxIsoName(item.title) : item.title;
	const displayInstance = incognito
		? getLinuxInstanceName(item.arrInstanceLabel)
		: item.arrInstanceLabel;
	const displayQbit = incognito
		? getLinuxInstanceName(item.primary?.qbitInstanceName ?? "")
		: item.primary?.qbitInstanceName;

	return (
		<GlassmorphicCard padding="md" animationDelay={animationDelay}>
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
								const matchCopy = MATCH_TYPE_COPY[sibling.matchType];
								const trackerLabel = incognito
									? getLinuxIndexer(sibling.tracker)
									: sibling.tracker || "unknown tracker";
								const siblingInstance = incognito
									? getLinuxInstanceName(sibling.instanceName)
									: sibling.instanceName;
								return (
									<li
										key={`${sibling.instanceId}-${sibling.hash}`}
										className={cn(
											"flex items-center gap-2 text-xs rounded-lg",
											"border border-border/30 bg-card/20 px-2.5 py-1.5",
										)}
									>
										<span className="font-medium text-foreground/90">{trackerLabel}</span>
										<span className="text-muted-foreground/70">·</span>
										<span className="text-muted-foreground">{siblingInstance}</span>
										<span className="text-muted-foreground/70">·</span>
										<span className={cn("font-medium", matchCopy.tone)}>{matchCopy.label}</span>
										{sibling.trackerHealth ? (
											<>
												<span className="text-muted-foreground/70">·</span>
												<span className="text-red-300/90">{sibling.trackerHealth}</span>
											</>
										) : null}
									</li>
								);
							})}
						</ul>
					</div>
				</div>
				{/*
				 * Deep-link to qui omitted in v1 — qui doesn't expose a stable
				 * per-torrent URL we can construct without knowing the
				 * operator's qui webroot. Add the affordance when we resolve a
				 * canonical deep-link shape (currently tracked in arc doc as
				 * Phase 6 polish).
				 */}
			</div>
		</GlassmorphicCard>
	);
};
