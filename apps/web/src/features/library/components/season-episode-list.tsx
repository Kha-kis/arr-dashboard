"use client";

import { useState } from "react";
import {
	Film,
	HardDrive,
	Loader2,
	PauseCircle,
	PlayCircle,
	Search,
} from "lucide-react";
import { Button } from "../../../components/ui";
import { toast } from "../../../components/ui";
import {
	useEpisodesQuery,
	useLibraryEpisodeMonitorMutation,
	useLibraryEpisodeSearchMutation,
} from "../../../hooks/api/useLibrary";
import { LibraryBadge } from "./library-badge";
import { getErrorMessage } from "../../../lib/error-utils";
import { formatBytes } from "../lib/library-utils";

/**
 * Props for the SeasonEpisodeList component
 */
interface SeasonEpisodeListProps {
	/** The instance ID containing the series */
	instanceId: string;
	/** The series ID */
	seriesId: number | string;
	/** The season number to display episodes for */
	seasonNumber: number;
}

/**
 * SeasonEpisodeList displays a list of episodes for a specific season,
 * allowing users to search for individual episodes and toggle their monitoring status.
 *
 * Each episode shows its episode number, title, air date, file status, and monitoring state.
 * For episodes with downloaded files, a secondary row displays quality, release group,
 * resolution, codecs, size, HDR status, languages, and custom formats.
 */
export const SeasonEpisodeList = ({
	instanceId,
	seriesId,
	seasonNumber,
}: SeasonEpisodeListProps) => {
	const { data, isLoading, isError } = useEpisodesQuery({
		instanceId,
		seriesId,
		seasonNumber,
	});

	const episodeSearchMutation = useLibraryEpisodeSearchMutation();
	const episodeMonitorMutation = useLibraryEpisodeMonitorMutation();
	const [pendingEpisodeSearch, setPendingEpisodeSearch] = useState<number | null>(null);
	const [pendingEpisodeMonitor, setPendingEpisodeMonitor] = useState<number | null>(null);

	const handleSearchEpisode = async (episodeId: number) => {
		setPendingEpisodeSearch(episodeId);
		try {
			await episodeSearchMutation.mutateAsync({
				instanceId,
				episodeIds: [episodeId],
			});
			toast.success(`Episode search queued`);
		} catch (error) {
			const message = getErrorMessage(error, "Unknown error");
			toast.error(`Failed to queue episode search: ${message}`);
		} finally {
			setPendingEpisodeSearch(null);
		}
	};

	const handleToggleMonitor = async (episodeId: number, currentlyMonitored: boolean) => {
		setPendingEpisodeMonitor(episodeId);
		try {
			await episodeMonitorMutation.mutateAsync({
				instanceId,
				seriesId,
				episodeIds: [episodeId],
				monitored: !currentlyMonitored,
			});
			toast.success(
				`Episode ${!currentlyMonitored ? "monitoring enabled" : "monitoring disabled"}`,
			);
		} catch (error) {
			const message = getErrorMessage(error, "Unknown error");
			toast.error(`Failed to toggle monitoring: ${message}`);
		} finally {
			setPendingEpisodeMonitor(null);
		}
	};

	if (isLoading) {
		return (
			<div className="flex items-center justify-center py-4 text-sm text-muted-foreground">
				<Loader2 className="h-4 w-4 animate-spin mr-2" />
				Loading episodes...
			</div>
		);
	}

	if (isError) {
		return (
			<div className="py-4 text-center text-sm text-red-400">
				Failed to load episodes. The Sonarr instance may be unreachable.
			</div>
		);
	}

	if (!data?.episodes || data.episodes.length === 0) {
		return <div className="py-4 text-center text-sm text-muted-foreground">No episodes found</div>;
	}

	return (
		<div className="space-y-2">
			{data.episodes.map((episode) => {
				const ef = episode.episodeFile;
				const fileSize = formatBytes(ef?.size);
				const hasFileDetails = episode.hasFile && ef;

				return (
					<div
						key={episode.id}
						className="rounded-lg border border-border/50 bg-background/10 text-sm"
					>
						{/* Primary row: episode info + badges + actions */}
						<div className="flex items-center gap-3 px-3 py-2">
							<div className="flex-1 min-w-0">
								<div className="flex items-center gap-2">
									<span className="font-medium text-foreground">E{episode.episodeNumber}</span>
									<span className="text-muted-foreground truncate">{episode.title || "TBA"}</span>
									{episode.finaleType && (
										<span className="text-[10px] uppercase tracking-wider text-amber-400/70 font-medium">
											{episode.finaleType}
										</span>
									)}
								</div>
								<div className="flex items-center gap-2 mt-0.5">
									{episode.airDate && (
										<span className="text-xs text-muted-foreground">
											{new Date(episode.airDate).toLocaleDateString()}
										</span>
									)}
									{episode.runtime != null && episode.runtime > 0 && (
										<span className="text-xs text-muted-foreground">
											{episode.runtime}m
										</span>
									)}
								</div>
							</div>
							<div className="flex items-center gap-2 shrink-0">
								<LibraryBadge tone={episode.hasFile ? "green" : "blue"}>
									{episode.hasFile ? "Downloaded" : "Missing"}
								</LibraryBadge>
								{episode.monitored !== undefined && (
									<LibraryBadge tone={episode.monitored ? "green" : "yellow"}>
										{episode.monitored ? "Monitored" : "Unmonitored"}
									</LibraryBadge>
								)}
							</div>
							<div className="flex items-center gap-1.5 shrink-0">
								<Button
									type="button"
									variant="secondary"
									size="sm"
									onClick={() => handleToggleMonitor(episode.id, episode.monitored ?? false)}
									disabled={pendingEpisodeMonitor === episode.id}
									title={episode.monitored ? "Unmonitor episode" : "Monitor episode"}
								>
									{pendingEpisodeMonitor === episode.id ? (
										<Loader2 className="h-3 w-3 animate-spin" />
									) : episode.monitored ? (
										<PauseCircle className="h-3 w-3" />
									) : (
										<PlayCircle className="h-3 w-3" />
									)}
								</Button>
								<Button
									type="button"
									variant="secondary"
									size="sm"
									onClick={() => handleSearchEpisode(episode.id)}
									disabled={pendingEpisodeSearch === episode.id}
									title="Search for episode"
								>
									{pendingEpisodeSearch === episode.id ? (
										<Loader2 className="h-3 w-3 animate-spin" />
									) : (
										<Search className="h-3 w-3" />
									)}
								</Button>
							</div>
						</div>

						{/* File detail row: quality, release group, codecs, size, etc. */}
						{hasFileDetails && (
							<div className="border-t border-border/30 px-3 py-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
								{/* Quality + release group */}
								{ef.quality && (
									<span className="inline-flex items-center gap-1">
										<Film className="h-3 w-3 text-cyan-400/70" />
										<span className="text-foreground/80">{ef.quality}</span>
										{ef.releaseGroup && (
											<span className="text-muted-foreground/70">
												— {ef.releaseGroup}
											</span>
										)}
									</span>
								)}

								{/* Resolution + HDR */}
								{ef.resolution && (
									<span className="text-foreground/70">
										{ef.resolution}
										{ef.videoDynamicRange && ef.videoDynamicRange !== "SDR" && (
											<span className="ml-1 text-amber-400/80 font-medium">
												{ef.videoDynamicRange}
											</span>
										)}
									</span>
								)}

								{/* Video / Audio codecs */}
								{(ef.videoCodec || ef.audioCodec) && (
									<span className="text-muted-foreground/70">
										{[ef.videoCodec, ef.audioCodec].filter(Boolean).join(" / ")}
									</span>
								)}

								{/* Languages */}
								{ef.languages && ef.languages.length > 0 && (
									<span className="text-muted-foreground/70">
										{ef.languages.join(", ")}
									</span>
								)}

								{/* File size */}
								{fileSize && (
									<span className="inline-flex items-center gap-1">
										<HardDrive className="h-3 w-3 text-muted-foreground/50" />
										{fileSize}
									</span>
								)}

								{/* Custom format score */}
								{ef.customFormatScore != null && (
									<span className="inline-flex items-center gap-1 font-medium text-foreground/70">
										Score: {ef.customFormatScore}
									</span>
								)}

								{/* Custom formats */}
								{ef.customFormats && ef.customFormats.length > 0 && (
									<span className="flex items-center gap-1 flex-wrap">
										{ef.customFormats.map((cf) => (
											<span
												key={cf}
												className="rounded-full border border-purple-400/30 bg-purple-500/10 px-1.5 py-px text-[10px] text-purple-300"
											>
												{cf}
											</span>
										))}
									</span>
								)}

								{/* File path */}
								{ef.relativePath && (
									<span className="basis-full text-muted-foreground/50 break-all">
										{ef.relativePath}
									</span>
								)}
							</div>
						)}
					</div>
				);
			})}
		</div>
	);
};
