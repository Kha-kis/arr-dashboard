"use client";

import type { CrossSeedDiscoveryItem, QuiCrossSeedMatch } from "@arr/shared";
import { ExternalLink, Network } from "lucide-react";
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
	quiInstanceLabel: string;
	animationDelay: number;
}

const MATCH_TYPE_COPY: Record<QuiCrossSeedMatch["matchType"], { label: string; tone: string }> = {
	release: { label: "release-name match", tone: "text-emerald-300" },
	content_path: { label: "content-path match", tone: "text-sky-300" },
	name: { label: "torrent-name match", tone: "text-amber-300" },
};

export const CrossSeedItemCard = ({
	item,
	quiInstanceLabel: _quiInstanceLabel,
	animationDelay,
}: CrossSeedItemCardProps) => {
	const incognito = useIncognitoMode();

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
				<div className="flex-shrink-0 mt-1">
					<Network className="h-5 w-5 text-muted-foreground" aria-hidden />
				</div>
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
				{item.primary ? (
					<a
						href="#"
						onClick={(e) => e.preventDefault()}
						className="flex-shrink-0 inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
						aria-label="Open torrent in qui"
						title="Open in qui (deep-link will be wired in a follow-up)"
					>
						<ExternalLink className="h-3.5 w-3.5" aria-hidden />
					</a>
				) : null}
			</div>
		</GlassmorphicCard>
	);
};
