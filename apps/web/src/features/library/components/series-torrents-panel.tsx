"use client";

import { CheckCircle2, Film, HelpCircle, Loader2, Search } from "lucide-react";
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
 * Series-level torrent + correlation summary. Replaces the movies-only
 * TorrentHealthPanel for series rows in the library detail modal.
 *
 * Shows:
 *   - Aggregate episode correlation counts (total, correlated, via inode, stuck)
 *   - Distinct torrents covering the series' episode files, grouped by
 *     infoHash. For each torrent: episode count, season range, quality,
 *     release group, verified-via-inode badge.
 *   - Cross-seed search button (whole series; qui's dir-scan walks
 *     recursively from the series folder, so it finds matches across
 *     every season pack and individual-episode torrent).
 *
 * Why not "live torrent state" per torrent: would require N additional
 * qui calls per render (one per distinct hash). Deferred until we have
 * a batch endpoint that returns state for a list of hashes.
 */
export const SeriesTorrentsPanel: React.FC<Props> = ({ arrInstanceId, arrItemId, seriesTitle }) => {
	const [isIncognito] = useIncognitoMode();
	const seriesQuery = useSeriesTorrents({ arrInstanceId, arrItemId });
	const mutation = useTriggerQuiCrossSeedSearch();
	const [searchOutcome, setSearchOutcome] = useState<
		{ kind: "success"; runId: number; scanRoot: string } | { kind: "error"; message: string } | null
	>(null);

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
			// Refetch after a short delay — qui's scan + injection + our
			// backfill correlation takes seconds-to-minutes. The user can
			// also reload to force an immediate refetch.
			setTimeout(() => seriesQuery.refetch(), 5000);
		} catch (err) {
			setSearchOutcome({
				kind: "error",
				message: err instanceof Error ? err.message : "qui cross-seed search failed",
			});
		}
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

			{/* Cross-seed search outcome */}
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

			{/* Distinct torrents */}
			{data.torrents.length > 0 ? (
				<div className="space-y-2">
					<h4 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
						Distinct torrents covering {seriesTitle}
					</h4>
					<div className="space-y-1.5">
						{data.torrents.map((t) => (
							<div
								key={t.infoHash}
								className="flex items-start justify-between gap-3 rounded border border-border/40 bg-card/30 px-3 py-2 text-xs"
							>
								<div className="space-y-0.5">
									<div className="flex items-center gap-2 font-mono text-foreground">
										{t.infoHash.slice(0, 16)}
										{t.inodeVerified && (
											<span className="rounded bg-green-500/20 px-1.5 py-0.5 text-[10px] text-green-200">
												inode-verified
											</span>
										)}
									</div>
									<div className="text-muted-foreground">
										{formatSeasons(t.seasons)} · {t.episodeCount}{" "}
										{t.episodeCount === 1 ? "episode" : "episodes"} ·{" "}
										{formatBytes(t.totalSizeBytes)}
										{t.qualityName && <> · {t.qualityName}</>}
										{t.releaseGroup && <> · {t.releaseGroup}</>}
									</div>
								</div>
							</div>
						))}
					</div>
				</div>
			) : (
				<div className="rounded border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs">
					<p className="text-amber-200">
						No torrents currently correlated to any episode. Click{" "}
						<strong>Cross-seed search</strong> above to ask qui to look for matches on configured
						trackers.
					</p>
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
