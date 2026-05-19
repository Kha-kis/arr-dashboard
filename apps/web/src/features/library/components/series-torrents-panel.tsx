"use client";

import {
	AlertTriangle,
	ArrowUp,
	CheckCircle2,
	ChevronDown,
	ChevronRight,
	Film,
	HelpCircle,
	Info,
	Loader2,
	Search,
	Sparkles,
} from "lucide-react";
import { useState } from "react";
import { GlassmorphicCard } from "../../../components/layout/premium-containers";
import { Button } from "../../../components/ui/button";
import {
	Tooltip,
	TooltipContent,
	TooltipProvider,
	TooltipTrigger,
} from "../../../components/ui/tooltip";
import {
	useMovieTorrents,
	useSeriesTorrents,
	useTrackerIcons,
	useTriggerQuiCrossSeedSearch,
} from "../../../hooks/api/useQui";
import type {
	SeriesActionItem,
	SeriesSeasonGroup,
	SeriesTorrentCluster,
	SeriesTorrentCopy,
} from "../../../lib/api-client/qui";
import { getLinuxSavePath, useIncognitoMode } from "../../../lib/incognito";
import { resolveCopyTrackerBrand, resolveHostnameBrand } from "../../../lib/tracker-brand";
import { TorrentDetailDrawer } from "./torrent-detail-drawer";

interface Props {
	arrInstanceId: string;
	arrItemId: number;
	/** Display title for the panel header (series or movie). */
	seriesTitle: string;
	/**
	 * Which kind of library item we're showing. `series` queries the
	 * per-episode endpoint and renders season-grouped clusters. `movie`
	 * queries the per-movie endpoint and renders the single cluster flat
	 * (its response has `seasonGroups: []`). Default is `series` for
	 * backward compat with existing call sites.
	 */
	itemType?: "series" | "movie";
}

const formatBytes = (raw: string | number | bigint): string => {
	const n = typeof raw === "bigint" ? Number(raw) : Number(raw);
	if (!Number.isFinite(n) || n <= 0) return "0";
	const units = ["B", "KB", "MB", "GB", "TB"];
	let value = n;
	let unit = 0;
	while (value >= 1024 && unit < units.length - 1) {
		value /= 1024;
		unit++;
	}
	return `${value.toFixed(value >= 100 ? 0 : value >= 10 ? 1 : 2)} ${units[unit]}`;
};

const friendlyState = (state: string | null): string | null => {
	if (!state) return null;
	const s = state.toLowerCase();
	if (s.includes("uploading") || s === "seeding" || s === "stalledup") return "Seeding";
	if (s.includes("downloading") || s === "stalleddl") return "Downloading";
	if (s.startsWith("paused")) return "Paused";
	if (s.startsWith("stopped")) return "Stopped";
	if (s.startsWith("checking")) return "Checking";
	if (s.includes("error")) return "Error";
	return state;
};

const stateTone = (state: string | null): string => {
	const f = (state ?? "").toLowerCase();
	if (f.includes("seeding") || f.includes("uploading") || f === "stalledup")
		return "bg-green-500/20 text-green-200";
	if (f.includes("downloading") || f === "stalleddl") return "bg-blue-500/20 text-blue-200";
	if (f.startsWith("paused") || f.startsWith("stopped")) return "bg-gray-500/20 text-gray-200";
	if (f.startsWith("checking")) return "bg-amber-500/20 text-amber-200";
	if (f.includes("error")) return "bg-red-500/20 text-red-200";
	return "bg-card text-foreground";
};

/**
 * Per-copy health dot — visual at-a-glance signal for cluster health.
 * Green = actively seeding, amber = stalled-up / paused, red = error,
 * gray = unknown / unreachable.
 */
const healthDot = (copy: SeriesTorrentCopy): string => {
	if (copy.quiUnreachable) return "bg-gray-500";
	const f = (copy.state ?? "").toLowerCase();
	if (f.includes("error")) return "bg-red-500";
	if (f.includes("uploading") || f === "seeding") return "bg-green-500";
	if (f === "stalledup" || f === "stalleddl") return "bg-amber-500";
	if (f.startsWith("paused") || f.startsWith("stopped")) return "bg-gray-400";
	if (f.startsWith("checking")) return "bg-blue-400";
	if (f.includes("downloading")) return "bg-blue-500";
	return "bg-gray-500";
};

/**
 * Series torrent panel — season-grouped content clusters with per-copy
 * health dots, tracker brand pills, and subset cross-references.
 *
 * Ship 1 of the qui-parity redesign:
 *   - Backend clusters by per-torrent coverage (not per-episode hash
 *     union), so REPACKs / per-episode releases shadowed by season packs
 *     are visible-but-deduped via `coveredBy` cross-references.
 *   - Frontend renders seasons as the top-level navigation. Each season
 *     header summarizes correlated/stuck counts; clusters live inside.
 *   - Health-dot strip on every cluster card replaces buried metadata
 *     with a one-glance copy-by-copy health read.
 */
export const SeriesTorrentsPanel: React.FC<Props> = ({
	arrInstanceId,
	arrItemId,
	seriesTitle,
	itemType = "series",
}) => {
	const [isIncognito] = useIncognitoMode();
	// Pick the right data source. Both hooks return the same wire shape;
	// the movie response just has `seasonGroups: []` to signal flat rendering.
	// We call both unconditionally with `enabled` flags to satisfy React's
	// rules-of-hooks (no conditional hook calls) — the disabled one never
	// fetches.
	const seriesQuery = useSeriesTorrents({
		arrInstanceId,
		arrItemId,
		enabled: itemType === "series",
	});
	const movieQuery = useMovieTorrents({
		arrInstanceId,
		arrItemId,
		enabled: itemType === "movie",
	});
	const dataQuery = itemType === "series" ? seriesQuery : movieQuery;
	// qui-curated tracker logo registry. Cached for 1h; empty record on
	// failure. Passed into `resolveCopyTrackerBrand` everywhere the brand
	// pill is rendered, so when qui has an icon for a hostname we show
	// the logo instead of the text abbreviation.
	const iconsQuery = useTrackerIcons();
	const trackerIcons = iconsQuery.data?.trackers;
	const mutation = useTriggerQuiCrossSeedSearch();
	const [searchOutcome, setSearchOutcome] = useState<
		{ kind: "success"; runId: number; scanRoot: string } | { kind: "error"; message: string } | null
	>(null);
	// Single drawer instance for the whole panel. `selectedItem` carries
	// the torrent plus an *arr-side context (series title + cluster
	// coverage label) so the drawer can anchor its header to "where did
	// the user launch this from?" — Cold Read v2 surfaced that the drawer
	// alone (qBit's name field) gave users no clue what content they were
	// looking at. null = drawer closed.
	const [selectedItem, setSelectedItem] = useState<{
		copy: SeriesTorrentCopy;
		arrContext: { seriesTitle: string; coverageLabel: string };
	} | null>(null);
	const [expandedClusters, setExpandedClusters] = useState<Set<string>>(new Set());
	const [expandedSeasons, setExpandedSeasons] = useState<Set<number>>(new Set());

	const handleSearchClick = async () => {
		setSearchOutcome(null);
		try {
			const result = await mutation.mutateAsync({
				arrInstanceId,
				arrItemId,
				itemType,
			});
			setSearchOutcome({
				kind: "success",
				runId: result.runId,
				scanRoot: result.scanRoot,
			});
			setTimeout(() => dataQuery.refetch(), 5000);
		} catch (err) {
			setSearchOutcome({
				kind: "error",
				message: err instanceof Error ? err.message : "qui cross-seed search failed",
			});
		}
	};

	const toggleCluster = (key: string) => {
		setExpandedClusters((prev) => {
			const next = new Set(prev);
			if (next.has(key)) next.delete(key);
			else next.add(key);
			return next;
		});
	};

	const toggleSeason = (n: number) => {
		setExpandedSeasons((prev) => {
			const next = new Set(prev);
			if (next.has(n)) next.delete(n);
			else next.add(n);
			return next;
		});
	};

	const data = dataQuery.data;
	const total = data?.totalEpisodes ?? 0;
	const correlated = data?.correlatedEpisodes ?? 0;
	const viaInode = data?.viaInodeEpisodes ?? 0;
	const stuck = data?.stuckEpisodes ?? 0;
	const correlationPct = total > 0 ? Math.round((correlated / total) * 100) : 0;

	if (dataQuery.isLoading) {
		return (
			<GlassmorphicCard className="space-y-3 p-4">
				<div className="flex items-center gap-2 text-sm text-muted-foreground">
					<Loader2 className="h-4 w-4 animate-spin" />
					Loading series torrent info…
				</div>
			</GlassmorphicCard>
		);
	}

	if (dataQuery.isError) {
		return (
			<GlassmorphicCard className="space-y-2 p-4">
				<div className="flex items-center gap-2 text-sm">
					<HelpCircle className="h-4 w-4 text-amber-500" />
					Couldn&apos;t load torrent info.
				</div>
				<p className="text-xs text-muted-foreground">
					{dataQuery.error instanceof Error ? dataQuery.error.message : ""}
				</p>
			</GlassmorphicCard>
		);
	}

	if (!data || total === 0) {
		return (
			<GlassmorphicCard className="space-y-3 p-4">
				<div className="flex items-center gap-2 text-sm">
					<Film className="h-4 w-4 text-muted-foreground" />
					<span>No episode-file data for this series yet.</span>
				</div>
				<p className="text-xs text-muted-foreground">
					This series hasn&apos;t been picked up by the episode-file sync scheduler yet. Trigger a
					full backfill from the /qui page, or wait for the next scheduler tick (~6h).
				</p>
			</GlassmorphicCard>
		);
	}

	// Season-collapse threshold: panels with ≥5 seasons render seasons
	// collapsed by default to keep scroll manageable. ≤4 stays expanded.
	const collapsibleSeasons = data.seasonGroups.length >= 5;

	// Quick cluster lookup for season-group → cluster resolution.
	const clusterByKey = new Map<string, SeriesTorrentCluster>(data.clusters.map((c) => [c.key, c]));

	return (
		// TooltipProvider with short delay so hovering brand pills surfaces
		// the tracker display name within ~200ms — discoverable without
		// being intrusive. delayDuration=200 (default 700) feels snappier
		// for icon-only pills where hover is the primary way to identify
		// the tracker.
		<TooltipProvider delayDuration={200}>
			<GlassmorphicCard className="space-y-4 p-4">
				{/* Header: title + cross-seed search button + summary stats.
				 * Labels are itemType-aware: series counts episodes (potentially
				 * dozens), movies count files (always 1) — so the latter shows
				 * just a status pill instead of "Files 1 / Correlated 1 (100%)"
				 * which is repetitive noise. */}
				<div className="space-y-2">
					<div className="flex items-center justify-between gap-3">
						<h3 className="flex items-center gap-2 text-sm font-semibold text-foreground">
							<Film className="h-4 w-4" />
							{itemType === "movie" ? "Movie torrent overview" : "Series torrent overview"}
						</h3>
						<Button
							type="button"
							variant="secondary"
							size="sm"
							onClick={handleSearchClick}
							disabled={mutation.isPending}
						>
							{mutation.isPending ? (
								<>
									<Loader2 className="h-3.5 w-3.5 animate-spin" />
									<span className="ml-1.5">Searching</span>
								</>
							) : (
								<>
									<Search className="h-3.5 w-3.5" />
									<span className="ml-1.5">Cross-seed search</span>
								</>
							)}
						</Button>
					</div>
					{itemType === "movie" ? (
						<div className="grid grid-cols-2 gap-3 text-xs">
							<Stat
								label="Status"
								value={
									stuck > 0
										? "Stuck — no torrent"
										: viaInode > 0
											? "Correlated via inode"
											: "Correlated"
								}
								tone={stuck === 0 ? "success" : "warning"}
							/>
							<Stat
								label="Size"
								value={
									data?.clusters[0]?.totalSizeBytes
										? formatBytes(data.clusters[0].totalSizeBytes)
										: "—"
								}
							/>
						</div>
					) : (
						<div className="grid grid-cols-4 gap-3 text-xs">
							<Stat label="Episodes" value={total.toString()} />
							<Stat
								label="Correlated"
								value={`${correlated} (${correlationPct}%)`}
								tone={correlated === total ? "success" : correlated > 0 ? "info" : "warning"}
							/>
							<Stat
								label="Via inode"
								value={viaInode.toString()}
								tone={viaInode > 0 ? "success" : "muted"}
							/>
							<Stat
								label="Stuck"
								value={stuck.toString()}
								tone={stuck === 0 ? "success" : "warning"}
							/>
						</div>
					)}
				</div>

				{/* Cross-seed search outcome banner */}
				{searchOutcome?.kind === "success" && (
					<div className="flex items-start gap-2 rounded-md border border-green-500/30 bg-green-500/10 px-3 py-2 text-xs">
						<CheckCircle2 className="mt-0.5 h-3.5 w-3.5 flex-shrink-0 text-green-500" />
						<div className="space-y-0.5">
							<p className="text-green-200">
								Scan queued in qui (run #{searchOutcome.runId}). New matches will inject
								automatically.
							</p>
							<p className="text-[10px] text-muted-foreground">
								Scan root:{" "}
								{isIncognito ? getLinuxSavePath(searchOutcome.scanRoot) : searchOutcome.scanRoot}
							</p>
						</div>
					</div>
				)}
				{searchOutcome?.kind === "error" && (
					<div className="flex items-start gap-2 rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs">
						<HelpCircle className="mt-0.5 h-3.5 w-3.5 flex-shrink-0 text-red-500" />
						<p className="text-red-200">{searchOutcome.message}</p>
					</div>
				)}

				{/* Action items — what the user should DO */}
				{data.actionItems.length > 0 && <ActionItemList items={data.actionItems} />}

				{/* Content rendering — three branches:
				 *   1. seasonGroups populated → series mode, group by season.
				 *   2. seasonGroups empty AND clusters populated → movie mode,
				 *      render clusters flat under one heading.
				 *   3. seasonGroups empty AND clusters empty → genuine empty
				 *      state (no torrent and no file yet).
				 */}
				{data.seasonGroups.length > 0 ? (
					<div className="space-y-2">
						<h4 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
							{seriesTitle}
						</h4>
						<div className="space-y-2">
							{data.seasonGroups.map((group) => (
								<SeasonGroupCard
									key={group.seasonNumber}
									group={group}
									clusterByKey={clusterByKey}
									expandedClusters={expandedClusters}
									expandedSeasons={expandedSeasons}
									onToggleCluster={toggleCluster}
									onToggleSeason={toggleSeason}
									collapsible={collapsibleSeasons}
									incognito={isIncognito}
									trackerIcons={trackerIcons}
									onCrossSeedSearch={handleSearchClick}
									searchPending={mutation.isPending}
									onOpenDrawer={(copy, coverageLabel) =>
										setSelectedItem({ copy, arrContext: { seriesTitle, coverageLabel } })
									}
									seriesTitle={seriesTitle}
								/>
							))}
						</div>
					</div>
				) : data.clusters.length > 0 ? (
					<div className="space-y-2">
						<h4 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
							Content
						</h4>
						<div className="space-y-1.5">
							{data.clusters.map((cluster) => (
								<ClusterCard
									key={cluster.key}
									cluster={cluster}
									expanded={expandedClusters.has(cluster.key)}
									onToggle={() => toggleCluster(cluster.key)}
									incognito={isIncognito}
									trackerIcons={trackerIcons}
									onOpenDrawer={(copy, coverageLabel) =>
										setSelectedItem({ copy, arrContext: { seriesTitle, coverageLabel } })
									}
									seriesTitle={seriesTitle}
								/>
							))}
						</div>
					</div>
				) : (
					<div className="rounded border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs">
						<p className="text-amber-200">
							{itemType === "movie"
								? "No torrent correlated yet. Use cross-seed search above or trigger a re-grab from Radarr."
								: "No episodes found for this series."}
						</p>
					</div>
				)}
			</GlassmorphicCard>
			<TorrentDetailDrawer
				copy={selectedItem?.copy ?? null}
				arrContext={selectedItem?.arrContext ?? null}
				onClose={() => setSelectedItem(null)}
			/>
		</TooltipProvider>
	);
};

const Stat: React.FC<{
	label: string;
	value: string;
	tone?: "success" | "warning" | "info" | "muted";
}> = ({ label, value, tone }) => {
	const toneClass =
		tone === "success"
			? "text-green-200"
			: tone === "warning"
				? "text-amber-200"
				: tone === "info"
					? "text-blue-200"
					: "text-foreground";
	return (
		<div className="space-y-0.5">
			<p className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</p>
			<p className={`text-sm font-semibold ${toneClass}`}>{value}</p>
		</div>
	);
};

const ActionItemList: React.FC<{ items: SeriesActionItem[] }> = ({ items }) => (
	<div className="space-y-1.5">
		<h4 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
			Action items
		</h4>
		<div className="space-y-1">
			{items.map((item) => (
				<ActionItemRow key={item.kind} item={item} />
			))}
		</div>
	</div>
);

const ActionItemRow: React.FC<{ item: SeriesActionItem }> = ({ item }) => {
	const isWarn = item.severity === "warning";
	const Icon =
		item.kind === "stale_cache_healed"
			? Sparkles
			: item.kind === "fs_unavailable"
				? Info
				: isWarn
					? AlertTriangle
					: Info;
	return (
		<div
			className={`flex items-start gap-2 rounded-md border px-3 py-2 text-xs ${
				isWarn ? "border-amber-500/30 bg-amber-500/10" : "border-blue-500/30 bg-blue-500/10"
			}`}
		>
			<Icon
				className={`mt-0.5 h-3.5 w-3.5 flex-shrink-0 ${isWarn ? "text-amber-400" : "text-blue-400"}`}
			/>
			<div className="space-y-0.5">
				<p className={isWarn ? "font-medium text-amber-200" : "font-medium text-blue-200"}>
					{item.title}
				</p>
				<p className="text-[11px] text-muted-foreground">{item.detail}</p>
			</div>
		</div>
	);
};

/**
 * One season's worth of content — header strip + cluster list. Season is
 * fully stuck (zero correlated) renders the "Cross-seed search" + (future)
 * "Re-grab via Sonarr" CTA strip in the header.
 */
const SeasonGroupCard: React.FC<{
	group: SeriesSeasonGroup;
	clusterByKey: Map<string, SeriesTorrentCluster>;
	expandedClusters: Set<string>;
	expandedSeasons: Set<number>;
	onToggleCluster: (key: string) => void;
	onToggleSeason: (n: number) => void;
	collapsible: boolean;
	incognito: boolean;
	trackerIcons: Record<string, { iconUrl?: string; name?: string }> | undefined;
	onCrossSeedSearch: () => void;
	searchPending: boolean;
	onOpenDrawer: (copy: SeriesTorrentCopy, coverageLabel: string) => void;
	seriesTitle: string;
}> = ({
	group,
	clusterByKey,
	expandedClusters,
	expandedSeasons,
	onToggleCluster,
	onToggleSeason,
	collapsible,
	incognito,
	trackerIcons,
	onCrossSeedSearch,
	searchPending,
	onOpenDrawer,
	seriesTitle,
}) => {
	const isFullyStuck = group.correlatedEpisodes === 0 && group.totalEpisodes > 0;
	const isFullyCovered =
		group.correlatedEpisodes === group.totalEpisodes && group.totalEpisodes > 0;
	const pct =
		group.totalEpisodes > 0
			? Math.round((group.correlatedEpisodes / group.totalEpisodes) * 100)
			: 0;
	const isOpen = !collapsible || expandedSeasons.has(group.seasonNumber);

	// De-duplicate clusters (multi-season packs can appear in multiple groups).
	// Resolve cluster keys to actual cluster objects now so we can sort + render.
	const clusters = group.clusterKeys
		.map((k) => clusterByKey.get(k))
		.filter((c): c is SeriesTorrentCluster => c !== undefined);

	return (
		<div className="overflow-hidden rounded-lg border border-border/40 bg-card/20">
			{/* Season header strip */}
			<div className="flex flex-col gap-2 border-b border-border/40 bg-card/40 px-3 py-2.5">
				<div className="flex items-center gap-2">
					{collapsible && (
						<button
							type="button"
							onClick={() => onToggleSeason(group.seasonNumber)}
							className="flex-shrink-0"
						>
							{isOpen ? (
								<ChevronDown className="h-4 w-4 text-muted-foreground" />
							) : (
								<ChevronRight className="h-4 w-4 text-muted-foreground" />
							)}
						</button>
					)}
					<h5 className="text-sm font-semibold text-foreground">
						Season {String(group.seasonNumber).padStart(2, "0")}
					</h5>
					<span
						className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${
							isFullyCovered
								? "bg-green-500/20 text-green-200"
								: isFullyStuck
									? "bg-red-500/20 text-red-200"
									: "bg-amber-500/20 text-amber-200"
						}`}
					>
						{group.correlatedEpisodes}/{group.totalEpisodes} ({pct}%)
					</span>
					{group.stuckEpisodes > 0 && (
						<span className="text-[11px] text-muted-foreground">{group.stuckEpisodes} stuck</span>
					)}
					{clusters.length > 0 && (
						<span className="ml-auto text-[11px] text-muted-foreground">
							{clusters.length} {clusters.length === 1 ? "release" : "releases"} ·{" "}
							{clusters.reduce((sum, c) => sum + c.copies.length, 0)} trackers
						</span>
					)}
				</div>
				{/* Stuck-season CTAs */}
				{isFullyStuck && isOpen && (
					<div className="flex flex-wrap items-center gap-2">
						<Button
							type="button"
							variant="secondary"
							size="sm"
							onClick={onCrossSeedSearch}
							disabled={searchPending}
						>
							<Search className="h-3 w-3" />
							<span className="ml-1.5">Cross-seed search</span>
						</Button>
						<span className="text-[10px] text-muted-foreground">
							Or trigger a re-grab from Sonarr to find a fresh release.
						</span>
					</div>
				)}
			</div>

			{/* Cluster list (when expanded) */}
			{isOpen && (
				<div className="space-y-1.5 p-2">
					{clusters.length === 0 && group.stuckEpisodes > 0 && (
						<StuckEpisodeList files={group.stuckEpisodeFiles} incognito={incognito} />
					)}
					{clusters.map((cluster) => (
						<ClusterCard
							key={cluster.key}
							cluster={cluster}
							expanded={expandedClusters.has(cluster.key)}
							onToggle={() => onToggleCluster(cluster.key)}
							incognito={incognito}
							trackerIcons={trackerIcons}
							onOpenDrawer={onOpenDrawer}
							seriesTitle={seriesTitle}
						/>
					))}
				</div>
			)}
		</div>
	);
};

/**
 * Compact list of stuck episode files inline in a season header. Used
 * when a season has stuck episodes the user might want to identify
 * before triggering search/re-grab.
 */
const StuckEpisodeList: React.FC<{
	files: Array<{ arrEpisodeFileId: number; relativePath: string }>;
	incognito: boolean;
}> = ({ files, incognito }) => (
	<div className="rounded border border-amber-500/20 bg-amber-500/5 px-2 py-1.5 text-[11px]">
		<p className="mb-1 text-amber-200/80">
			{files.length} stuck file{files.length === 1 ? "" : "s"} — no live torrent:
		</p>
		<div className="space-y-0.5 font-mono text-[10px] text-muted-foreground">
			{files.slice(0, 8).map((f) => {
				const fname = f.relativePath.split("/").pop() ?? f.relativePath;
				return (
					<div key={f.arrEpisodeFileId} className="truncate" title={fname}>
						{incognito ? getLinuxSavePath(fname) : fname}
					</div>
				);
			})}
			{files.length > 8 && <div className="text-muted-foreground/70">+{files.length - 8} more</div>}
		</div>
	</div>
);

/**
 * One content cluster — a release covering N episodes via M tracker copies.
 * Collapsed header shows coverage label, tracker pills, per-copy health
 * dot strip, and size/quality. Expanded shows per-copy detail rows.
 */
const ClusterCard: React.FC<{
	cluster: SeriesTorrentCluster;
	expanded: boolean;
	onToggle: () => void;
	incognito: boolean;
	trackerIcons: Record<string, { iconUrl?: string; name?: string }> | undefined;
	onOpenDrawer: (copy: SeriesTorrentCopy, coverageLabel: string) => void;
	seriesTitle: string;
}> = ({
	cluster,
	expanded,
	onToggle,
	incognito,
	trackerIcons,
	onOpenDrawer,
	seriesTitle: _seriesTitle,
}) => {
	const stateLabel = friendlyState(cluster.primaryState);

	return (
		<div className="overflow-hidden rounded border border-border/40 bg-card/30 text-xs">
			<button
				type="button"
				onClick={onToggle}
				className="flex w-full items-start gap-2 px-3 py-2 text-left hover:bg-card/50"
			>
				<div className="flex-shrink-0 pt-0.5">
					{expanded ? (
						<ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
					) : (
						<ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
					)}
				</div>
				<div className="min-w-0 flex-1 space-y-1">
					{/* Top row: coverage + state + size + health dots */}
					<div className="flex flex-wrap items-center gap-2">
						<span className="font-semibold text-foreground">{cluster.coverageLabel}</span>
						{stateLabel && (
							<span
								className={`rounded px-1.5 py-0.5 text-[10px] ${stateTone(cluster.primaryState)}`}
							>
								{stateLabel}
							</span>
						)}
						{cluster.isDormant && (
							<span className="rounded bg-amber-500/20 px-1.5 py-0.5 text-[10px] text-amber-200">
								dormant
							</span>
						)}
						{cluster.inodeVerified && (
							<span className="rounded bg-green-500/20 px-1.5 py-0.5 text-[10px] text-green-200">
								inode-verified
							</span>
						)}
						<span className="ml-auto flex items-center gap-1">
							{cluster.copies.map((copy) => {
								const brand = resolveCopyTrackerBrand({
									tracker: copy.tracker,
									trackerHostnames: copy.trackerHostnames,
									icons: trackerIcons,
								});
								return (
									<span
										key={copy.infoHash}
										className={`inline-block h-2 w-2 rounded-full ${healthDot(copy)}`}
										title={`${brand.name} — ${friendlyState(copy.state) ?? "unknown"}`}
									/>
								);
							})}
						</span>
					</div>
					{/* Sub-row: size + quality + release + tracker pills */}
					<div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted-foreground">
						<span>{formatBytes(cluster.totalSizeBytes)}</span>
						{cluster.qualityName && <span>· {cluster.qualityName}</span>}
						{cluster.releaseGroup && <span>· {cluster.releaseGroup}</span>}
						<span className="text-foreground/40">·</span>
						{/* Dedupe brand pills by tracker identity — when multiple
						 * .torrent variants share a tracker (REPACK / corrected
						 * name / cross-seed), collapse into one pill. The per-
						 * tracker variant count lives in the tooltip ONLY:
						 * surfacing it inline as `×N` confused Cold Read users
						 * (read as "2 of cluster-total" rather than "2 of this
						 * tracker"). The dot strip above already shows
						 * per-copy count.
						 *
						 * Map iteration order preserves insertion order so
						 * library-role copies still render before cross-seeds.
						 */}
						{(() => {
							// Dedupe key: prefer iconUrl when available (so two
							// different display-name variants for the same tracker
							// merge), else abbr. iconUrl is the most stable identity
							// signal qui can give us.
							const byBrand = new Map<
								string,
								{
									brand: { abbr: string; name: string; iconUrl?: string };
									count: number;
								}
							>();
							for (const copy of cluster.copies) {
								const brand = resolveCopyTrackerBrand({
									tracker: copy.tracker,
									trackerHostnames: copy.trackerHostnames,
									icons: trackerIcons,
								});
								const key = brand.iconUrl ?? brand.abbr;
								const existing = byBrand.get(key);
								if (existing) {
									existing.count++;
								} else {
									byBrand.set(key, { brand, count: 1 });
								}
							}
							return Array.from(byBrand.entries()).map(([key, { brand, count }]) => (
								<Tooltip key={key}>
									<TooltipTrigger asChild>
										<span className="inline-flex items-center gap-1 rounded bg-card/70 px-1.5 py-0.5 font-mono text-[10px] text-foreground/80">
											{brand.iconUrl ? (
												<img
													src={brand.iconUrl}
													alt={brand.name}
													className="h-3 w-3 rounded-sm object-contain"
												/>
											) : (
												<span>{brand.abbr}</span>
											)}
										</span>
									</TooltipTrigger>
									<TooltipContent>
										{count > 1 ? `${brand.name} · ${count} torrents at this tracker` : brand.name}
									</TooltipContent>
								</Tooltip>
							));
						})()}
					</div>
					{/* Cross-reference: "↳ also covered by S04 pack — 4 trackers" */}
					{cluster.coveredBy && (
						<div className="flex items-center gap-1.5 pl-1 text-[10px] text-blue-300/80">
							<ArrowUp className="h-3 w-3" />
							<span>
								Also covered by{" "}
								<span className="font-semibold text-blue-300">
									{cluster.coveredBy.coverageLabel}
								</span>{" "}
								— {cluster.coveredBy.copyCount} tracker
								{cluster.coveredBy.copyCount === 1 ? "" : "s"}
							</span>
						</div>
					)}
				</div>
			</button>

			{/* Expanded copy detail rows */}
			{expanded && (
				<div className="space-y-1 border-t border-border/40 px-3 py-2">
					{cluster.copies.map((copy) => (
						<CopyRow
							key={copy.infoHash}
							copy={copy}
							incognito={incognito}
							trackerIcons={trackerIcons}
							// Inject the cluster's coverageLabel so the drawer knows
							// which release the user launched it from ("S03E01 · 1
							// episode"). The panel root then combines this with
							// seriesTitle for the drawer's arrContext header.
							onOpenDrawer={(c) => onOpenDrawer(c, cluster.coverageLabel)}
						/>
					))}
				</div>
			)}
		</div>
	);
};

/**
 * One torrent copy inside an expanded cluster. Compact line with role +
 * tracker badge + state + ratio + peers, then path + timing as secondary
 * info. Clicking the row (or its chevron) opens the full detail drawer
 * — the kebab-menu fast lane was retired after Cold Read showed the
 * kebab's mutations were rarely used and the drawer carries every
 * action plus the qui power-tools the menu couldn't.
 */
const CopyRow: React.FC<{
	copy: SeriesTorrentCopy;
	incognito: boolean;
	trackerIcons: Record<string, { iconUrl?: string; name?: string }> | undefined;
	onOpenDrawer: (copy: SeriesTorrentCopy) => void;
}> = ({ copy, incognito, trackerIcons, onOpenDrawer }) => {
	const stateLabel = friendlyState(copy.state);
	const progressPct = typeof copy.progress === "number" ? Math.round(copy.progress * 100) : null;
	const brand = resolveCopyTrackerBrand({
		tracker: copy.tracker,
		trackerHostnames: copy.trackerHostnames,
		icons: trackerIcons,
	});
	return (
		<div className="space-y-1 rounded bg-card/40 px-2 py-1.5 text-[11px]">
			<div className="flex flex-wrap items-center gap-1.5">
				{/* Per-copy health dot — colored by state (seeding=green, stalled=
				 * amber, etc.). Radix tooltip surfaces the textual state on
				 * hover so the color isn't relying on memorization. Cold Read
				 * confirmed the native `title=` attribute was invisible. */}
				<Tooltip>
					<TooltipTrigger asChild>
						<span
							className={`inline-block h-2 w-2 flex-shrink-0 rounded-full ${healthDot(copy)}`}
						/>
					</TooltipTrigger>
					<TooltipContent>Health: {friendlyState(copy.state) ?? "unknown"}</TooltipContent>
				</Tooltip>
				<Tooltip>
					<TooltipTrigger asChild>
						<span className="inline-flex items-center gap-1 rounded bg-card/60 px-1.5 py-0.5 font-mono text-[10px] text-foreground/90">
							{brand.iconUrl ? (
								<img
									src={brand.iconUrl}
									alt={brand.name}
									className="h-3.5 w-3.5 rounded-sm object-contain"
								/>
							) : (
								brand.abbr
							)}
						</span>
					</TooltipTrigger>
					<TooltipContent>{brand.name}</TooltipContent>
				</Tooltip>
				<span
					className={`rounded px-1.5 py-0.5 text-[10px] ${
						copy.role === "library"
							? "bg-blue-500/20 text-blue-200"
							: "bg-purple-500/20 text-purple-200"
					}`}
				>
					{copy.role === "library" ? "Library" : "Cross-seed"}
				</span>
				{stateLabel && (
					<span className={`rounded px-1.5 py-0.5 text-[10px] ${stateTone(copy.state)}`}>
						{stateLabel}
					</span>
				)}
				{copy.trackerHealth && (
					<span className="rounded bg-red-500/20 px-1.5 py-0.5 text-[10px] text-red-200">
						{copy.trackerHealth.replace("_", " ")}
					</span>
				)}
				{progressPct !== null && progressPct < 100 && (
					<span className="rounded bg-amber-500/20 px-1.5 py-0.5 text-[10px] text-amber-200">
						{progressPct}%
					</span>
				)}
				{typeof copy.ratio === "number" && (
					<span className="text-[10px] text-muted-foreground">ratio {copy.ratio.toFixed(2)}×</span>
				)}
				{/* Inline 8-char hash retired — the drawer's header surfaces the
				 * full hash + "Copy infohash" affordance. Cold Read showed the
				 * inline prefix forced users to guess what the string was. */}
				{copy.quiUnreachable && (
					<span className="rounded bg-amber-500/20 px-1.5 py-0.5 text-[10px] text-amber-200">
						not in qui
					</span>
				)}
				<Tooltip>
					<TooltipTrigger asChild>
						<button
							type="button"
							aria-label="Open torrent details"
							onClick={() => onOpenDrawer(copy)}
							className="ml-auto inline-flex h-5 w-5 items-center justify-center rounded text-muted-foreground hover:bg-card/70 hover:text-foreground focus:outline-none focus:ring-1 focus:ring-foreground/40"
						>
							<ChevronRight className="h-3.5 w-3.5" />
						</button>
					</TooltipTrigger>
					<TooltipContent>Open details</TooltipContent>
				</Tooltip>
			</div>
			{copy.name && (
				<div className="break-all font-mono text-[10px] text-muted-foreground" title={copy.name}>
					{incognito ? getLinuxSavePath(copy.name) : copy.name}
				</div>
			)}
			<div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[10px] text-muted-foreground">
				{copy.savePath && (
					<span className="font-mono" title={copy.savePath}>
						{incognito ? getLinuxSavePath(copy.savePath) : copy.savePath}
					</span>
				)}
				{/* Live speeds — only render when actively transferring (>0).
				 * Avoids visual noise on idle seeders. */}
				{(copy.dlSpeedBps ?? 0) > 0 && (
					<span className="text-blue-300">↓ {formatRate(copy.dlSpeedBps!)}</span>
				)}
				{(copy.upSpeedBps ?? 0) > 0 && (
					<span className="text-green-300">↑ {formatRate(copy.upSpeedBps!)}</span>
				)}
				{copy.addedOn !== null && <span>added {formatRelative(copy.addedOn)}</span>}
				{copy.seedingTime !== null && <span>seeding {formatDuration(copy.seedingTime)}</span>}
				{copy.instanceName && <span>· {copy.instanceName}</span>}
			</div>
			{/* Per-tracker peer counts — the authoritative breakdown of where
			 * the torrent has peers. Header label spells out "peers" so the
			 * number after each tracker icon reads unambiguously (Cold Read
			 * showed `0p` was opaque without context). */}
			{(copy.trackers?.length ?? 0) > 0 && (
				<div className="flex flex-wrap items-center gap-1 text-[10px]">
					<span className="text-muted-foreground">Trackers (peers):</span>
					{(copy.trackers ?? []).map((t) => {
						// Resolve identity via qui's meta map; falls back to
						// auto-derived display name / abbreviation when qui has
						// no entry for the hostname. Same resolver the cluster
						// header pills use — guaranteed consistency.
						const brand = resolveHostnameBrand(t.hostname, trackerIcons);
						const isHealthy = t.health === "working" || t.health === "updating";
						const isFailed = t.health === "not_working";
						return (
							<Tooltip key={t.hostname}>
								<TooltipTrigger asChild>
									<span
										className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 font-mono ${
											isFailed
												? "bg-red-500/20 text-red-200"
												: isHealthy
													? "bg-card/70 text-foreground/80"
													: "bg-card/50 text-muted-foreground"
										}`}
									>
										{brand.iconUrl ? (
											<img
												src={brand.iconUrl}
												alt={brand.name}
												className="h-3 w-3 rounded-sm object-contain"
											/>
										) : (
											<span>{brand.abbr}</span>
										)}
										<span>{t.numPeers}</span>
									</span>
								</TooltipTrigger>
								<TooltipContent>
									{brand.name} · {t.numPeers} peer{t.numPeers === 1 ? "" : "s"} · {t.health}
								</TooltipContent>
							</Tooltip>
						);
					})}
					{/* Pseudo-tracker badges — DHT/PeX/LSD as discovery channels
					 * separate from real trackers. Notable on private-tracker
					 * torrents where these should typically be off. */}
					{copy.peerSources?.dht && (
						<span
							className="rounded bg-card/40 px-1.5 py-0.5 font-mono text-muted-foreground"
							title="Distributed Hash Table — public peer discovery"
						>
							DHT
						</span>
					)}
					{copy.peerSources?.pex && (
						<span
							className="rounded bg-card/40 px-1.5 py-0.5 font-mono text-muted-foreground"
							title="Peer Exchange — peer-to-peer discovery"
						>
							PeX
						</span>
					)}
					{copy.peerSources?.lsd && (
						<span
							className="rounded bg-card/40 px-1.5 py-0.5 font-mono text-muted-foreground"
							title="Local Service Discovery — LAN peers"
						>
							LSD
						</span>
					)}
				</div>
			)}
			{copy.tags.length > 0 && (
				<div className="flex flex-wrap items-center gap-1">
					{copy.tags.map((tag) => (
						<span
							key={tag}
							className="rounded bg-card/60 px-1.5 py-0.5 text-[10px] text-muted-foreground"
						>
							{tag}
						</span>
					))}
				</div>
			)}
		</div>
	);
};

/**
 * Render a bytes-per-second rate as a compact human string ("1.2 MB/s",
 * "850 KB/s", "120 B/s"). Used for the per-copy live transfer indicators.
 */
function formatRate(bytesPerSec: number): string {
	if (!Number.isFinite(bytesPerSec) || bytesPerSec <= 0) return "0 B/s";
	const units = ["B/s", "KB/s", "MB/s", "GB/s"];
	let value = bytesPerSec;
	let unit = 0;
	while (value >= 1024 && unit < units.length - 1) {
		value /= 1024;
		unit++;
	}
	return `${value.toFixed(value >= 100 ? 0 : 1)} ${units[unit]}`;
}

function formatRelative(unixSeconds: number): string {
	if (!unixSeconds || unixSeconds <= 0) return "—";
	const diff = Date.now() / 1000 - unixSeconds;
	if (diff < 0) return "in the future";
	const intervals: Array<[number, string]> = [
		[60 * 60 * 24 * 365, "year"],
		[60 * 60 * 24 * 30, "month"],
		[60 * 60 * 24 * 7, "week"],
		[60 * 60 * 24, "day"],
		[60 * 60, "hour"],
		[60, "minute"],
	];
	for (const [secs, label] of intervals) {
		const n = Math.floor(diff / secs);
		if (n >= 1) return `${n} ${label}${n === 1 ? "" : "s"} ago`;
	}
	return "just now";
}

function formatDuration(seconds: number): string {
	if (!seconds || seconds <= 0) return "—";
	const d = Math.floor(seconds / 86400);
	const h = Math.floor((seconds % 86400) / 3600);
	const m = Math.floor((seconds % 3600) / 60);
	if (d > 0) return `${d}d ${h}h`;
	if (h > 0) return `${h}h ${m}m`;
	if (m > 0) return `${m}m`;
	return `${Math.floor(seconds)}s`;
}
