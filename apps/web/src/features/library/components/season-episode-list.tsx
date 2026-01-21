"use client";

import { useState } from "react";
import { Loader2, PauseCircle, PlayCircle, Search } from "lucide-react";
import { Button } from "../../../components/ui";
import { toast } from "../../../components/ui";
import {
	useEpisodesQuery,
	useLibraryEpisodeMonitorMutation,
	useLibraryEpisodeSearchMutation,
} from "../../../hooks/api/useLibrary";
import { LibraryBadge } from "./library-badge";

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
 * Users can perform quick actions like searching for an episode or toggling monitoring.
 */
export const SeasonEpisodeList = ({
	instanceId,
	seriesId,
	seasonNumber,
}: SeasonEpisodeListProps) => {
	const { data, isLoading } = useEpisodesQuery({
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
			const message = error instanceof Error ? error.message : "Unknown error";
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
			const message = error instanceof Error ? error.message : "Unknown error";
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

	if (!data?.episodes || data.episodes.length === 0) {
		return <div className="py-4 text-center text-sm text-muted-foreground">No episodes found</div>;
	}

	return (
		<div className="space-y-2">
			{data.episodes.map((episode) => (
				<div
					key={episode.id}
					className="flex items-center gap-3 rounded-lg border border-border/50 bg-background/10 px-3 py-2 text-sm"
				>
					<div className="flex-1 min-w-0">
						<div className="flex items-center gap-2">
							<span className="font-medium text-foreground">E{episode.episodeNumber}</span>
							<span className="text-muted-foreground truncate">{episode.title || "TBA"}</span>
						</div>
						{episode.airDate && (
							<div className="text-xs text-muted-foreground mt-0.5">
								{new Date(episode.airDate).toLocaleDateString()}
							</div>
						)}
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
			))}
		</div>
	);
};
