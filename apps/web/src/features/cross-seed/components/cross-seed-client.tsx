"use client";

import { ArrowRight, Loader2, Network, RefreshCw, Settings as SettingsIcon } from "lucide-react";
import Link from "next/link";
import { useMemo } from "react";
import {
	GlassmorphicCard,
	PremiumEmptyState,
	PremiumPageHeader,
	PremiumPageLoading,
} from "../../../components/layout";
import { Alert, AlertDescription, Button } from "../../../components/ui";
import { useCrossSeedAvailability, useCrossSeedDiscovery } from "../../../hooks/api/useQui";
import { getErrorMessage } from "../../../lib/error-utils";
import { CrossSeedItemCard } from "./cross-seed-item-card";

const SCAN_BATCH_SIZE = 100;

/**
 * Cross-Seed Discovery (Phase 3.1).
 *
 * Surfaces the qui cross-seed sibling graph across the user's library.
 * Read-only: management actions stay in qui. Empty states are explicit
 * about *why* the page can't show data — operators always know what
 * to do next.
 */
export const CrossSeedClient = () => {
	const availability = useCrossSeedAvailability();

	const isAvailable = availability.data?.available === true ? availability.data : null;

	const discovery = useCrossSeedDiscovery(Boolean(isAvailable), SCAN_BATCH_SIZE);

	const aggregate = useMemo(() => {
		if (!discovery.data) return { items: [], scanned: 0, found: 0 };
		const items = discovery.data.pages.flatMap((p) => p.items);
		const scanned = discovery.data.pages.reduce((sum, p) => sum + p.scannedThisBatch, 0);
		const found = discovery.data.pages.reduce((sum, p) => sum + p.foundThisBatch, 0);
		return { items, scanned, found };
	}, [discovery.data]);

	const quiInstanceLabel =
		discovery.data?.pages[0]?.quiInstanceLabel ?? isAvailable?.quiInstanceLabel ?? "";

	const allScanned = !discovery.hasNextPage && !discovery.isFetching;

	if (availability.isLoading) {
		return <PremiumPageLoading showHeader cardCount={3} />;
	}

	if (availability.isError) {
		return (
			<Alert variant="danger">
				<AlertDescription>
					Failed to load cross-seed availability: {getErrorMessage(availability.error)}
				</AlertDescription>
			</Alert>
		);
	}

	// Empty state: qui not configured at all.
	if (availability.data?.available === false && availability.data.reason === "no_qui_instance") {
		return (
			<>
				<Header />
				<PremiumEmptyState
					icon={Network}
					title="No qui instance configured"
					description="Cross-Seed Discovery needs a qui instance to query for sibling torrents. Add one from Settings → Services."
					action={
						<Link href="/settings">
							<Button variant="primary">
								<SettingsIcon className="mr-2 h-4 w-4" aria-hidden /> Go to Settings
							</Button>
						</Link>
					}
				/>
			</>
		);
	}

	// Empty state: no library items have a backfilled infoHash yet.
	if (
		availability.data?.available === false &&
		availability.data.reason === "no_correlated_items"
	) {
		return (
			<>
				<Header />
				<PremiumEmptyState
					icon={Network}
					title="No correlated library items yet"
					description="The infoHash backfill is still running, or your *arr instances don't have download history for any items. Once items pick up an infoHash they'll be eligible for cross-seed scanning."
					action={
						<Link href="/library">
							<Button variant="secondary">
								Open Library <ArrowRight className="ml-2 h-4 w-4" aria-hidden />
							</Button>
						</Link>
					}
				/>
			</>
		);
	}

	// Available, but no items found yet (and scan still going).
	const noResultsYet =
		isAvailable !== null &&
		aggregate.items.length === 0 &&
		(discovery.isFetching || discovery.hasNextPage);

	return (
		<>
			<Header
				quiInstanceLabel={quiInstanceLabel}
				scanCandidates={isAvailable?.scanCandidates}
				onRefresh={() => discovery.refetch()}
				isRefreshing={discovery.isFetching}
			/>

			<GlassmorphicCard padding="md" className="mb-6">
				<div className="flex items-center justify-between gap-4 flex-wrap">
					<div className="flex items-center gap-6 text-sm">
						<div>
							<div className="text-muted-foreground text-xs uppercase tracking-wide">Scanned</div>
							<div className="text-xl font-semibold">
								{aggregate.scanned.toLocaleString()}
								{isAvailable?.scanCandidates ? (
									<span className="text-muted-foreground/70 text-base font-normal">
										{" "}
										/ {isAvailable.scanCandidates.toLocaleString()}
									</span>
								) : null}
							</div>
						</div>
						<div>
							<div className="text-muted-foreground text-xs uppercase tracking-wide">
								With siblings
							</div>
							<div className="text-xl font-semibold">{aggregate.found.toLocaleString()}</div>
						</div>
					</div>
					{!allScanned ? (
						<Button
							variant="secondary"
							onClick={() => void discovery.fetchNextPage()}
							disabled={discovery.isFetching}
						>
							{discovery.isFetching ? (
								<>
									<Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden />
									Scanning…
								</>
							) : (
								<>
									Scan next {SCAN_BATCH_SIZE} <ArrowRight className="ml-2 h-4 w-4" aria-hidden />
								</>
							)}
						</Button>
					) : (
						<span className="text-xs text-muted-foreground">Scan complete</span>
					)}
				</div>
			</GlassmorphicCard>

			{discovery.isError ? (
				<Alert variant="danger">
					<AlertDescription>Failed to scan: {getErrorMessage(discovery.error)}</AlertDescription>
				</Alert>
			) : null}

			{noResultsYet ? (
				<PremiumEmptyState
					icon={Network}
					title="No cross-seed siblings yet"
					description="Keep scanning — siblings appear as we find them. qui only reports library items whose torrent is part of an active cross-seed match."
				/>
			) : aggregate.items.length === 0 && allScanned ? (
				<PremiumEmptyState
					icon={Network}
					title="No cross-seed siblings found"
					description={`Scanned ${aggregate.scanned.toLocaleString()} items with a backfilled infoHash. None of them currently have a cross-seed sibling in qui. This is fine — it just means qui hasn't found alternative trackers for your active torrents.`}
				/>
			) : (
				<div className="space-y-3">
					{aggregate.items.map((item, idx) => (
						<CrossSeedItemCard
							key={item.libraryCacheId}
							item={item}
							quiInstanceLabel={quiInstanceLabel}
							animationDelay={Math.min(idx, 12) * 30}
						/>
					))}
				</div>
			)}
		</>
	);
};

interface HeaderProps {
	quiInstanceLabel?: string;
	scanCandidates?: number;
	onRefresh?: () => void;
	isRefreshing?: boolean;
}

const Header = ({ quiInstanceLabel, scanCandidates, onRefresh, isRefreshing }: HeaderProps) => {
	const description = quiInstanceLabel
		? `Scanning ${scanCandidates?.toLocaleString() ?? "?"} correlated library items via ${quiInstanceLabel} for cross-seed siblings.`
		: "Surface qui's cross-seed sibling graph across your library.";

	return (
		<PremiumPageHeader
			label="qui Integration"
			labelIcon={Network}
			title="Cross-Seed Discovery"
			gradientTitle
			description={description}
			actions={
				onRefresh ? (
					<Button variant="secondary" onClick={onRefresh} disabled={isRefreshing}>
						<RefreshCw
							className={`mr-2 h-4 w-4 ${isRefreshing ? "animate-spin" : ""}`}
							aria-hidden
						/>
						Rescan
					</Button>
				) : undefined
			}
		/>
	);
};
