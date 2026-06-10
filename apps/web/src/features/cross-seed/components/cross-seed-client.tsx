"use client";

import type { CrossSeedDiscoveryAvailability } from "@arr/shared";
import { getLinuxInstanceName, useIncognitoMode } from "../../../lib/incognito";
import {
	ArrowRight,
	CheckCircle2,
	CheckSquare,
	ExternalLink,
	Loader2,
	Network,
	RefreshCw,
	Settings as SettingsIcon,
	ShieldAlert,
	Square,
} from "lucide-react";
import Link from "next/link";
import { useMemo, useState } from "react";
import {
	GlassmorphicCard,
	PremiumEmptyState,
	PremiumPageHeader,
	PremiumPageLoading,
} from "../../../components/layout";
import { Alert, AlertDescription, Button } from "../../../components/ui";
import {
	useCrossSeedAvailability,
	useCrossSeedDiscovery,
	useTrackerIcons,
} from "../../../hooks/api/useQui";
import { useServicesQuery } from "../../../hooks/api/useServicesQuery";
import { getErrorMessage } from "../../../lib/error-utils";
import { CrossSeedBulkToolbar } from "./cross-seed-bulk-toolbar";
import { CrossSeedItemCard } from "./cross-seed-item-card";

/**
 * Narrowed shape of the `available: true` branch of the discovery union.
 * Pulled out via `Extract<>` so the narrowing site below carries an explicit
 * annotation instead of relying on TypeScript's control-flow analysis of the
 * Zod-inferred discriminated-union type.
 *
 * Why this matters: Zod minor bumps occasionally change how `z.discriminatedUnion`
 * surfaces its TypeScript shape, and patterns like
 *   `data?.available === true ? data : null`
 * can silently lose narrowing when the inferred type's discriminator gets
 * re-wrapped. Stating the result type explicitly removes that exposure.
 * Observed concretely when dependabot's bump bundle included zod 4.3 → 4.4
 * (see dependabot PR ignoring zod for that group).
 */
type AvailableDiscovery = Extract<CrossSeedDiscoveryAvailability, { available: true }>;

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
	const [selectionMode, setSelectionMode] = useState(false);
	const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

	// Explicit annotation (rather than relying on TS narrowing the Zod-inferred
	// union) keeps the call sites below working across Zod minor bumps that
	// change discriminator inference. See AvailableDiscovery comment above.
	const isAvailable: AvailableDiscovery | null =
		availability.data?.available === true ? availability.data : null;

	const discovery = useCrossSeedDiscovery(Boolean(isAvailable), SCAN_BATCH_SIZE);

	// Same tracker-identity registry the library grid uses. Soft-fails to
	// undefined (the card then renders the bare hostname per sibling).
	const trackerIcons = useTrackerIcons().data?.trackers;

	const aggregate = useMemo(() => {
		if (!discovery.data)
			return { items: [], scanned: 0, found: 0, siblingFetchErrors: 0, itemsNeedingAttention: 0 };
		const items = discovery.data.pages.flatMap((p) => p.items);
		const scanned = discovery.data.pages.reduce((sum, p) => sum + p.scannedThisBatch, 0);
		const found = discovery.data.pages.reduce((sum, p) => sum + p.foundThisBatch, 0);
		// Aggregate the per-batch sibling-fetch error counter so the page can
		// render "partial results" copy when qui rejected some lookups during
		// the scan. Optional in the response for back-compat; coalesce to 0.
		const siblingFetchErrors = discovery.data.pages.reduce(
			(sum, p) => sum + (p.siblingFetchErrors ?? 0),
			0,
		);
		// The page's primary signal: items with ≥1 sibling whose tracker reports
		// a problem (unregistered / tracker_down). This is what the Library
		// tracker strip can't show — the integrity of the cross-seed layer.
		const itemsNeedingAttention = items.filter((it) =>
			it.siblings.some((s) => s.trackerHealth),
		).length;
		return { items, scanned, found, siblingFetchErrors, itemsNeedingAttention };
	}, [discovery.data]);

	// Lead with problems: when any item needs attention, the operator can filter
	// to just those. Default to "all" (predictable — no items vanish on load);
	// the prominent stat nudges them to the attention filter when it matters.
	const [healthFilter, setHealthFilter] = useState<"all" | "attention">("all");
	const visibleItems = useMemo(
		() =>
			healthFilter === "attention"
				? aggregate.items.filter((it) => it.siblings.some((s) => s.trackerHealth))
				: aggregate.items,
		[aggregate.items, healthFilter],
	);

	// Bridge to qui for remediation (siblings are read-only here per D7). qui has
	// no stable per-torrent URL, so this lands on the qui web UI — same pattern
	// as the library torrent drawer's "Open in qui".
	const { data: services } = useServicesQuery();
	const quiOpenUrl = (() => {
		if (!isAvailable) return null;
		const inst = services?.find((s) => s.id === isAvailable.quiInstanceId);
		return inst?.externalUrl ?? inst?.baseUrl ?? null;
	})();

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
				onRefresh={() => discovery.refetch()}
				isRefreshing={discovery.isFetching}
				quiOpenUrl={quiOpenUrl}
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
						{/* Primary signal — items with an unhealthy cross-seed sibling.
						    Clickable: jumps straight to the attention filter. */}
						{aggregate.itemsNeedingAttention > 0 ? (
							<button
								type="button"
								onClick={() => setHealthFilter("attention")}
								className="text-left"
								title="Show only items with an unregistered or down tracker"
							>
								<div className="flex items-center gap-1 text-amber-400 text-xs uppercase tracking-wide">
									<ShieldAlert className="h-3 w-3" aria-hidden />
									Needs attention
								</div>
								<div className="text-xl font-semibold text-amber-400">
									{aggregate.itemsNeedingAttention.toLocaleString()}
								</div>
							</button>
						) : aggregate.found > 0 ? (
							<div>
								<div className="flex items-center gap-1 text-emerald-400/90 text-xs uppercase tracking-wide">
									<CheckCircle2 className="h-3 w-3" aria-hidden />
									Healthy
								</div>
								<div className="text-xl font-semibold text-emerald-400/90">All</div>
							</div>
						) : null}
						{aggregate.siblingFetchErrors > 0 ? (
							<div>
								<div className="text-muted-foreground text-xs uppercase tracking-wide">
									Unreachable
								</div>
								{/*
								 * Items the scan tried to check but qui errored on. Without
								 * this counter, "found: N" would look like the answer was
								 * complete when in reality some items couldn't be evaluated.
								 * Operators can re-scan to retry.
								 */}
								<div
									className="text-xl font-semibold text-amber-400"
									title="qui returned an error for these items' sibling lookups. Re-scan to retry."
								>
									{aggregate.siblingFetchErrors.toLocaleString()}
								</div>
							</div>
						) : null}
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
				<>
					{/* Health filter — lead with problems. "Needs attention" disabled
					    when nothing is unhealthy so the control never lies about
					    having results behind it. */}
					<div className="mb-3 flex items-center gap-1.5">
						<Button
							variant={healthFilter === "all" ? "primary" : "ghost"}
							size="sm"
							onClick={() => setHealthFilter("all")}
							className="h-8 text-xs"
						>
							All ({aggregate.items.length})
						</Button>
						<Button
							variant={healthFilter === "attention" ? "primary" : "ghost"}
							size="sm"
							onClick={() => setHealthFilter("attention")}
							disabled={aggregate.itemsNeedingAttention === 0}
							className="h-8 text-xs"
						>
							Needs attention ({aggregate.itemsNeedingAttention})
						</Button>
					</div>

					{/* Selection-mode toggle. Selection mode shows checkboxes on each
					    card AND surfaces a sticky bulk-action toolbar at the bottom.
					    The toggle button label flips to reflect mode + count so the
					    operator can see at a glance whether they're in selection
					    mode without scrolling. */}
					<div className="mb-3 flex items-center justify-end gap-2">
						<Button
							variant={selectionMode ? "primary" : "secondary"}
							size="sm"
							onClick={() => {
								setSelectionMode((m) => !m);
								if (selectionMode) setSelectedIds(new Set());
							}}
							className="h-8 text-xs"
						>
							{selectionMode ? (
								<CheckSquare className="mr-1.5 h-3.5 w-3.5" aria-hidden />
							) : (
								<Square className="mr-1.5 h-3.5 w-3.5" aria-hidden />
							)}
							{selectionMode ? `Selection mode (${selectedIds.size})` : "Select torrents"}
						</Button>
						{selectionMode ? (
							<Button
								variant="ghost"
								size="sm"
								onClick={() => {
									// "Select all currently-rendered items that have a primary
									// torrent" — siblings are excluded because they can't be
									// targeted by bulk actions (see CrossSeedBulkToolbar
									// comments). Cap matches what's already on screen, not
									// the full universe, so the user is never surprised by
									// off-screen selections.
									const next = new Set<string>();
									for (const item of visibleItems) {
										if (item.primary) next.add(item.libraryCacheId);
									}
									setSelectedIds(next);
								}}
								className="h-8 text-xs"
								aria-label="Select all loaded items"
							>
								Select all loaded
							</Button>
						) : null}
					</div>

					<div className="space-y-3">
						{visibleItems.map((item, idx) => (
							<CrossSeedItemCard
								key={item.libraryCacheId}
								item={item}
								trackerIcons={trackerIcons}
								animationDelay={Math.min(idx, 12) * 30}
								isSelected={selectedIds.has(item.libraryCacheId)}
								onToggleSelect={
									selectionMode
										? () => {
												setSelectedIds((prev) => {
													const next = new Set(prev);
													if (next.has(item.libraryCacheId)) {
														next.delete(item.libraryCacheId);
													} else if (item.primary) {
														next.add(item.libraryCacheId);
													}
													return next;
												});
											}
										: undefined
								}
								selectDisabled={!item.primary}
							/>
						))}
					</div>

					{selectionMode && selectedIds.size > 0 && isAvailable ? (
						<CrossSeedBulkToolbar
							quiInstanceId={isAvailable.quiInstanceId}
							selectedItems={aggregate.items.filter((i) => selectedIds.has(i.libraryCacheId))}
							onClear={() => setSelectedIds(new Set())}
						/>
					) : null}
				</>
			)}
		</>
	);
};

interface HeaderProps {
	quiInstanceLabel?: string;
	onRefresh?: () => void;
	isRefreshing?: boolean;
	/** qui web-UI URL for the "Open in qui" bridge; null when not resolvable. */
	quiOpenUrl?: string | null;
}

const Header = ({ quiInstanceLabel, onRefresh, isRefreshing, quiOpenUrl }: HeaderProps) => {
	const [incognitoMode] = useIncognitoMode();
	const displayLabel =
		quiInstanceLabel && incognitoMode ? getLinuxInstanceName(quiInstanceLabel) : quiInstanceLabel;
	const description = displayLabel
		? `Cross-seed siblings across your library via ${displayLabel}, with tracker-health problems surfaced first. Remediate in qui — siblings are read-only here.`
		: "Surface qui's cross-seed sibling graph across your library and flag tracker-health problems.";

	return (
		<PremiumPageHeader
			label="qui Integration"
			labelIcon={Network}
			title="Cross-Seed Health"
			gradientTitle
			description={description}
			actions={
				onRefresh || quiOpenUrl ? (
					<div className="flex items-center gap-2">
						{quiOpenUrl ? (
							<Button
								variant="ghost"
								onClick={() => window.open(quiOpenUrl, "_blank", "noopener,noreferrer")}
							>
								<ExternalLink className="mr-2 h-4 w-4" aria-hidden />
								Open in qui
							</Button>
						) : null}
						{onRefresh ? (
							<Button variant="secondary" onClick={onRefresh} disabled={isRefreshing}>
								<RefreshCw
									className={`mr-2 h-4 w-4 ${isRefreshing ? "animate-spin" : ""}`}
									aria-hidden
								/>
								Rescan
							</Button>
						) : null}
					</div>
				) : undefined
			}
		/>
	);
};
