"use client";

import {
	CheckCircle2,
	ChevronDown,
	ChevronRight,
	Film,
	HelpCircle,
	Loader2,
	Search,
} from "lucide-react";
import { useState } from "react";
import { GlassmorphicCard } from "../../../components/layout/premium-containers";
import { Button } from "../../../components/ui/button";
import { useSeriesTorrents, useTriggerQuiCrossSeedSearch } from "../../../hooks/api/useQui";
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

const formatSeasons = (seasons: number[]): string => {
	if (seasons.length === 0) return "—";
	if (seasons.length === 1) return `S${String(seasons[0]).padStart(2, "0")}`;
	// Compact runs of consecutive seasons: [1,2,3,5,6] → "S01-S03, S05-S06"
	const runs: Array<[number, number]> = [];
	let start = seasons[0]!;
	let prev = seasons[0]!;
	for (let i = 1; i < seasons.length; i++) {
		const s = seasons[i]!;
		if (s === prev + 1) {
			prev = s;
			continue;
		}
		runs.push([start, prev]);
		start = s;
		prev = s;
	}
	runs.push([start, prev]);
	return runs
		.map(([a, b]) =>
			a === b
				? `S${String(a).padStart(2, "0")}`
				: `S${String(a).padStart(2, "0")}-S${String(b).padStart(2, "0")}`,
		)
		.join(", ");
};

/**
 * Normalize qui's wire state vocabulary to a tighter set of UI labels.
 * qui returns native qBit states (`uploading`, `stalledUP`, `stalledDL`,
 * `pausedUP`, `error`, `checkingUP`, etc) — we collapse them for clarity.
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
 * Series-level torrent + correlation summary. Replaces the movies-only
 * TorrentHealthPanel for series rows in the library detail modal.
 *
 * Shows:
 *   - Aggregate episode correlation counts.
 *   - Distinct torrents covering the series' episode files, grouped by
 *     infoHash, enriched with live qui state (category → primary vs
 *     cross-seed badge, state → seeding/stalled/etc, tracker name).
 *   - Per-season expansion showing each episode's hash + correlation
 *     status.
 *   - Series-level cross-seed search button — qui walks the series
 *     folder recursively, finding matches across season packs and
 *     individual-episode torrents.
 */
export const SeriesTorrentsPanel: React.FC<Props> = ({ arrInstanceId, arrItemId, seriesTitle }) => {
	const [isIncognito] = useIncognitoMode();
	const seriesQuery = useSeriesTorrents({ arrInstanceId, arrItemId });
	const mutation = useTriggerQuiCrossSeedSearch();
	const [searchOutcome, setSearchOutcome] = useState<
		{ kind: "success"; runId: number; scanRoot: string } | { kind: "error"; message: string } | null
	>(null);
	const [expandedSeasons, setExpandedSeasons] = useState<Set<number>>(new Set());

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
			{/* Header + summary */}
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

			{searchOutcome?.kind === "success" && (
				<div className="flex items-start gap-2 rounded-md border border-green-500/30 bg-green-500/10 px-3 py-2 text-xs">
					<CheckCircle2 className="mt-0.5 h-3.5 w-3.5 flex-shrink-0 text-green-500" />
					<div className="space-y-0.5">
						<p className="text-green-200">
							Scan queued in qui (run #{searchOutcome.runId}). qui will walk every season folder and
							search trackers for matching season packs / per-episode torrents. New matches will
							inject automatically.
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

			{/* Distinct torrents (enriched with qui state) */}
			{data.torrents.length > 0 ? (
				<div className="space-y-2">
					<h4 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
						Distinct torrents covering {seriesTitle}
					</h4>
					<div className="space-y-1.5">
						{data.torrents.map((t) => {
							const stateLabel = friendlyState(t.state);
							const progressPct =
								typeof t.progress === "number" ? Math.round(t.progress * 100) : null;
							return (
								<div
									key={t.infoHash}
									className="space-y-1.5 rounded border border-border/40 bg-card/30 px-3 py-2 text-xs"
								>
									{/* Badge strip */}
									<div className="flex flex-wrap items-center gap-1.5">
										<span className="font-mono text-foreground">{t.infoHash.slice(0, 16)}</span>
										{!t.quiUnreachable && (
											<span
												className={`rounded px-1.5 py-0.5 text-[10px] ${
													t.isPrimary
														? "bg-blue-500/20 text-blue-200"
														: "bg-purple-500/20 text-purple-200"
												}`}
											>
												{t.isPrimary ? "Primary" : "Cross-seed"}
											</span>
										)}
										{stateLabel && (
											<span className={`rounded px-1.5 py-0.5 text-[10px] ${stateTone(t.state)}`}>
												{stateLabel}
											</span>
										)}
										{t.inodeVerified && (
											<span className="rounded bg-green-500/20 px-1.5 py-0.5 text-[10px] text-green-200">
												inode-verified
											</span>
										)}
										{t.tracker && (
											<span className="rounded bg-card/60 px-1.5 py-0.5 text-[10px] text-muted-foreground">
												{t.tracker}
											</span>
										)}
										{progressPct !== null && progressPct < 100 && (
											<span className="rounded bg-amber-500/20 px-1.5 py-0.5 text-[10px] text-amber-200">
												{progressPct}% complete
											</span>
										)}
										{typeof t.ratio === "number" && (
											<span className="text-[10px] text-muted-foreground">
												ratio {t.ratio.toFixed(2)}×
											</span>
										)}
										{t.quiUnreachable && (
											<span className="rounded bg-amber-500/20 px-1.5 py-0.5 text-[10px] text-amber-200">
												not in qui
											</span>
										)}
									</div>

									{/* Torrent name (full, monospace) */}
									{t.name && (
										<div className="break-all font-mono text-[11px] text-foreground" title={t.name}>
											{isIncognito ? getLinuxSavePath(t.name) : t.name}
										</div>
									)}

									{/* Definition grid: path / category / size / quality / etc */}
									<dl className="grid grid-cols-1 gap-x-4 gap-y-0.5 text-[11px] md:grid-cols-2">
										{t.savePath && (
											<KV
												label="Path"
												value={isIncognito ? getLinuxSavePath(t.savePath) : t.savePath}
												mono
											/>
										)}
										{t.category && <KV label="Category" value={t.category} mono />}
										<KV
											label="Covers"
											value={`${formatSeasons(t.seasons)} · ${t.episodeCount} ${
												t.episodeCount === 1 ? "episode" : "episodes"
											}`}
										/>
										<KV label="Size" value={formatBytes(t.totalSizeBytes)} />
										{t.torrentSizeBytes && t.torrentSizeBytes !== t.totalSizeBytes && (
											<KV
												label="Size (qBit)"
												value={formatBytes(t.torrentSizeBytes)}
												hint="qBit reports a different size than our episode cache — usually fine; can indicate stale cache"
											/>
										)}
										{t.qualityName && <KV label="Quality" value={t.qualityName} />}
										{t.releaseGroup && <KV label="Release" value={t.releaseGroup} />}
										{(t.numSeeds !== null || t.numLeechs !== null) && (
											<KV
												label="Peers"
												value={`${t.numSeeds ?? 0} seeders · ${t.numLeechs ?? 0} leech`}
											/>
										)}
										{t.addedOn !== null && <KV label="Added" value={formatRelative(t.addedOn)} />}
										{t.seedingTime !== null && (
											<KV label="Seeding" value={formatDuration(t.seedingTime)} />
										)}
										{t.instanceName && <KV label="qBit instance" value={t.instanceName} />}
									</dl>

									{/* Tags row */}
									{t.tags.length > 0 && (
										<div className="flex flex-wrap items-center gap-1 pt-1">
											<span className="text-[10px] uppercase tracking-wider text-muted-foreground">
												Tags:
											</span>
											{t.tags.map((tag) => (
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
						})}
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

			{/* Per-season expansion */}
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
 * Key-value row used by the torrent details grid. Compact two-column
 * layout: muted label on the left, value on the right. `mono` switches
 * the value to a monospace font (paths, categories, hashes).
 */
const KV: React.FC<{
	label: string;
	value: string;
	mono?: boolean;
	hint?: string;
}> = ({ label, value, mono, hint }) => (
	<div className="flex items-baseline gap-2" title={hint}>
		<dt className="flex-shrink-0 text-[10px] uppercase tracking-wider text-muted-foreground">
			{label}
		</dt>
		<dd className={`min-w-0 truncate text-foreground ${mono ? "font-mono" : ""}`} title={value}>
			{value}
		</dd>
	</div>
);

/**
 * Render a unix-seconds timestamp as a relative phrase ("3 days ago",
 * "5 months ago"). Falls back to "—" when the timestamp is missing or
 * unreadable. Used for qui's `addedOn` and `completedOn` fields.
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
 * Render a duration in seconds as a compact human phrase ("423d 14h",
 * "3h 12m", "45s"). Used for qui's `seedingTime`.
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
