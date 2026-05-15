"use client";

import {
	AlertTriangle,
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
import { useSeriesTorrents, useTriggerQuiCrossSeedSearch } from "../../../hooks/api/useQui";
import type {
	SeriesActionItem,
	SeriesTorrentCluster,
	SeriesTorrentCopy,
} from "../../../lib/api-client/qui";
import { getLinuxSavePath, useIncognitoMode } from "../../../lib/incognito";

interface Props {
	arrInstanceId: string;
	arrItemId: number;
	seriesTitle: string;
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

/**
 * Normalize qui's wire state vocabulary to a tighter set of UI labels.
 * qui returns native qBit states (`uploading`, `stalledUP`, `stalledDL`,
 * `pausedUP`, `error`, etc) — we collapse them for clarity.
 */
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
 * Series torrent panel — clusters torrents by content coverage so a
 * 4-tracker season pack renders as 1 cluster row with 4 inline tracker
 * copies, not 4 separate rows with duplicated sibling lists.
 *
 * Top-of-panel "Action items" lead with what the user can DO; the
 * cluster list and per-season drill-down follow as supporting detail.
 */
export const SeriesTorrentsPanel: React.FC<Props> = ({ arrInstanceId, arrItemId, seriesTitle }) => {
	const [isIncognito] = useIncognitoMode();
	const seriesQuery = useSeriesTorrents({ arrInstanceId, arrItemId });
	const mutation = useTriggerQuiCrossSeedSearch();
	const [searchOutcome, setSearchOutcome] = useState<
		{ kind: "success"; runId: number; scanRoot: string } | { kind: "error"; message: string } | null
	>(null);
	const [expandedSeasons, setExpandedSeasons] = useState<Set<number>>(new Set());
	const [expandedClusters, setExpandedClusters] = useState<Set<string>>(new Set());

	const handleSearchClick = async () => {
		setSearchOutcome(null);
		try {
			const result = await mutation.mutateAsync({
				arrInstanceId,
				arrItemId,
				itemType: "series",
			});
			setSearchOutcome({
				kind: "success",
				runId: result.runId,
				scanRoot: result.scanRoot,
			});
			setTimeout(() => seriesQuery.refetch(), 5000);
		} catch (err) {
			setSearchOutcome({
				kind: "error",
				message: err instanceof Error ? err.message : "qui cross-seed search failed",
			});
		}
	};

	const toggleSeason = (n: number) => {
		setExpandedSeasons((prev) => {
			const next = new Set(prev);
			if (next.has(n)) next.delete(n);
			else next.add(n);
			return next;
		});
	};

	const toggleCluster = (key: string) => {
		setExpandedClusters((prev) => {
			const next = new Set(prev);
			if (next.has(key)) next.delete(key);
			else next.add(key);
			return next;
		});
	};

	const data = seriesQuery.data;
	const total = data?.totalEpisodes ?? 0;
	const correlated = data?.correlatedEpisodes ?? 0;
	const viaInode = data?.viaInodeEpisodes ?? 0;
	const stuck = data?.stuckEpisodes ?? 0;
	const correlationPct = total > 0 ? Math.round((correlated / total) * 100) : 0;

	if (seriesQuery.isLoading) {
		return (
			<GlassmorphicCard className="space-y-3 p-4">
				<div className="flex items-center gap-2 text-sm text-muted-foreground">
					<Loader2 className="h-4 w-4 animate-spin" />
					Loading series torrent info…
				</div>
			</GlassmorphicCard>
		);
	}

	if (seriesQuery.isError) {
		return (
			<GlassmorphicCard className="space-y-2 p-4">
				<div className="flex items-center gap-2 text-sm">
					<HelpCircle className="h-4 w-4 text-amber-500" />
					Couldn&apos;t load series torrent info.
				</div>
				<p className="text-xs text-muted-foreground">
					{seriesQuery.error instanceof Error ? seriesQuery.error.message : ""}
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

	return (
		<GlassmorphicCard className="space-y-4 p-4">
			{/* Header: title + cross-seed search button + summary stats */}
			<div className="space-y-2">
				<div className="flex items-center justify-between gap-3">
					<h3 className="flex items-center gap-2 text-sm font-semibold text-foreground">
						<Film className="h-4 w-4" />
						Series torrent overview
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
					<Stat label="Stuck" value={stuck.toString()} tone={stuck === 0 ? "success" : "warning"} />
				</div>
			</div>

			{/* Cross-seed search outcome banner — full-width informational */}
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

			{/* Action items — what the user should DO. Computed server-side
			 * from clusters + episode state. Skipped entirely when there's
			 * nothing actionable. */}
			{data.actionItems.length > 0 && <ActionItemList items={data.actionItems} />}

			{/* Content clusters — one row per coverage signature (set of
			 * episodes covered). Each cluster lists its tracker copies
			 * inline. The redundant "Cross-seed siblings" nested list is
			 * gone because the cluster itself IS the sibling group. */}
			{data.clusters.length > 0 ? (
				<div className="space-y-2">
					<h4 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
						Content covering {seriesTitle}
					</h4>
					<div className="space-y-1.5">
						{data.clusters.map((cluster) => (
							<ClusterRow
								key={cluster.key}
								cluster={cluster}
								expanded={expandedClusters.has(cluster.key)}
								onToggle={() => toggleCluster(cluster.key)}
								incognito={isIncognito}
							/>
						))}
					</div>
				</div>
			) : (
				<div className="rounded border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs">
					<p className="text-amber-200">
						No torrents currently correlated to any episode. Click{" "}
						<strong>Cross-seed search</strong> above to ask qui to look for matches.
					</p>
				</div>
			)}

			{/* Per-season drill-down — collapsed by default, still useful for
			 * inspecting individual episode correlation. */}
			{data.seasons.length > 0 && (
				<div className="space-y-2">
					<h4 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
						Seasons
					</h4>
					<div className="space-y-1">
						{data.seasons.map((season) => {
							const isOpen = expandedSeasons.has(season.seasonNumber);
							const seasonPct =
								season.episodeCount > 0
									? Math.round((season.correlatedCount / season.episodeCount) * 100)
									: 0;
							return (
								<div
									key={season.seasonNumber}
									className="rounded border border-border/40 bg-card/30 text-xs"
								>
									<button
										type="button"
										onClick={() => toggleSeason(season.seasonNumber)}
										className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left hover:bg-card/50"
									>
										<div className="flex items-center gap-2">
											{isOpen ? (
												<ChevronDown className="h-3.5 w-3.5" />
											) : (
												<ChevronRight className="h-3.5 w-3.5" />
											)}
											<span className="font-semibold">
												Season {String(season.seasonNumber).padStart(2, "0")}
											</span>
											<span className="text-muted-foreground">
												{season.correlatedCount}/{season.episodeCount} correlated ({seasonPct}%)
											</span>
										</div>
									</button>
									{isOpen && (
										<div className="space-y-0.5 border-t border-border/40 px-3 py-2 font-mono text-[11px]">
											{season.episodes.map((ep) => {
												const fname = ep.relativePath.split("/").pop() ?? ep.relativePath;
												return (
													<div
														key={ep.arrEpisodeFileId}
														className="flex items-center justify-between gap-3 py-0.5"
													>
														<span className="truncate text-muted-foreground" title={fname}>
															{isIncognito ? getLinuxSavePath(fname) : fname}
														</span>
														<span className="flex-shrink-0 text-foreground">
															{ep.infoHash ? (
																<span
																	className={
																		ep.infoHashSource === "inode"
																			? "text-green-300"
																			: "text-blue-300"
																	}
																>
																	{ep.infoHash.slice(0, 12)}
																	{ep.infoHashSource === "inode"
																		? " (inode)"
																		: ` (${ep.infoHashSource ?? "?"})`}
																</span>
															) : (
																<span className="text-amber-300">stuck</span>
															)}
														</span>
													</div>
												);
											})}
										</div>
									)}
								</div>
							);
						})}
					</div>
				</div>
			)}
		</GlassmorphicCard>
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

/**
 * Action-items list — server-computed signals about what the user should
 * do (stuck episodes, dormant content, FS unavailable, cache healed).
 * Renders as a compact pill list with severity-driven coloring.
 */
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
				className={`mt-0.5 h-3.5 w-3.5 flex-shrink-0 ${
					isWarn ? "text-amber-400" : "text-blue-400"
				}`}
			/>
			<div className="space-y-0.5">
				<p className={isWarn ? "text-amber-200 font-medium" : "text-blue-200 font-medium"}>
					{item.title}
				</p>
				<p className="text-[11px] text-muted-foreground">{item.detail}</p>
			</div>
		</div>
	);
};

/**
 * A single cluster: header showing the coverage label (e.g. "S03E04 · 1
 * episode") with the tracker count, then an expandable list of copies.
 * Collapsed by default to keep the panel scannable; one click reveals
 * full per-copy detail (path, peers, ratio, tags, etc).
 */
const ClusterRow: React.FC<{
	cluster: SeriesTorrentCluster;
	expanded: boolean;
	onToggle: () => void;
	incognito: boolean;
}> = ({ cluster, expanded, onToggle, incognito }) => {
	const stateLabel = friendlyState(cluster.primaryState);
	const libraryCopies = cluster.copies.filter((c) => c.role === "library");
	const mirrorCopies = cluster.copies.filter((c) => c.role === "mirror");
	return (
		<div className="rounded border border-border/40 bg-card/30 text-xs">
			<button
				type="button"
				onClick={onToggle}
				className="flex w-full items-start justify-between gap-3 px-3 py-2 text-left hover:bg-card/50"
			>
				<div className="min-w-0 flex-1 space-y-1">
					<div className="flex flex-wrap items-center gap-1.5">
						{expanded ? (
							<ChevronDown className="h-3.5 w-3.5 flex-shrink-0" />
						) : (
							<ChevronRight className="h-3.5 w-3.5 flex-shrink-0" />
						)}
						<span className="font-semibold text-foreground">{cluster.coverageLabel}</span>
						{stateLabel && (
							<span
								className={`rounded px-1.5 py-0.5 text-[10px] ${stateTone(cluster.primaryState)}`}
							>
								{stateLabel}
							</span>
						)}
						{cluster.inodeVerified && (
							<span className="rounded bg-green-500/20 px-1.5 py-0.5 text-[10px] text-green-200">
								inode-verified
							</span>
						)}
						{cluster.isDormant && (
							<span className="rounded bg-amber-500/20 px-1.5 py-0.5 text-[10px] text-amber-200">
								dormant
							</span>
						)}
					</div>
					<div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 pl-5 text-[11px] text-muted-foreground">
						<span>{formatBytes(cluster.totalSizeBytes)}</span>
						{cluster.qualityName && <span>· {cluster.qualityName}</span>}
						{cluster.releaseGroup && <span>· {cluster.releaseGroup}</span>}
						<span>
							· <span className="text-foreground">{cluster.copies.length}</span>{" "}
							{cluster.copies.length === 1 ? "copy" : "copies"}
						</span>
						{libraryCopies.length > 0 && (
							<span>
								· <span className="text-blue-300">{libraryCopies.length}</span> library
							</span>
						)}
						{mirrorCopies.length > 0 && (
							<span>
								· <span className="text-purple-300">{mirrorCopies.length}</span> mirror
							</span>
						)}
					</div>
				</div>
			</button>
			{expanded && (
				<div className="space-y-1 border-t border-border/40 px-3 py-2">
					{cluster.copies.map((copy) => (
						<CopyRow key={copy.infoHash} copy={copy} incognito={incognito} />
					))}
				</div>
			)}
		</div>
	);
};

/**
 * One torrent copy inside an expanded cluster. Compact one-line summary
 * with badges (role, state, tracker, ratio) plus key metadata (peers,
 * added, seeding, path). Skips fields that have no value.
 */
const CopyRow: React.FC<{ copy: SeriesTorrentCopy; incognito: boolean }> = ({
	copy,
	incognito,
}) => {
	const stateLabel = friendlyState(copy.state);
	const progressPct = typeof copy.progress === "number" ? Math.round(copy.progress * 100) : null;
	return (
		<div className="space-y-1 rounded bg-card/40 px-2 py-1.5 text-[11px]">
			<div className="flex flex-wrap items-center gap-1.5">
				<span className="font-mono text-foreground">{copy.infoHash.slice(0, 12)}</span>
				<span
					className={`rounded px-1.5 py-0.5 text-[10px] ${
						copy.role === "library"
							? "bg-blue-500/20 text-blue-200"
							: "bg-purple-500/20 text-purple-200"
					}`}
				>
					{copy.role === "library" ? "Library" : "Mirror"}
				</span>
				{copy.tracker && (
					<span className="rounded bg-card/60 px-1.5 py-0.5 text-[10px] text-muted-foreground">
						{copy.tracker}
					</span>
				)}
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
				{copy.quiUnreachable && (
					<span className="rounded bg-amber-500/20 px-1.5 py-0.5 text-[10px] text-amber-200">
						not in qui
					</span>
				)}
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
				{(copy.numSeeds !== null || copy.numLeechs !== null) && (
					<span>
						{copy.numSeeds ?? 0}↑ {copy.numLeechs ?? 0}↓
					</span>
				)}
				{copy.addedOn !== null && <span>added {formatRelative(copy.addedOn)}</span>}
				{copy.seedingTime !== null && <span>seeding {formatDuration(copy.seedingTime)}</span>}
				{copy.instanceName && <span>· {copy.instanceName}</span>}
			</div>
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
 * Unix-seconds → relative phrase ("3 days ago"). "—" when missing.
 */
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

/**
 * Seconds → compact duration ("423d 14h", "3h 12m"). Used for seedingTime.
 */
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
