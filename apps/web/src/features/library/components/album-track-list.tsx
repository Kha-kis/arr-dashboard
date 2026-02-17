"use client";

import { AlertTriangle, Loader2, Music2 } from "lucide-react";
import { SEMANTIC_COLORS } from "../../../lib/theme-gradients";
import { useTracksQuery } from "../../../hooks/api/useLibrary";
import { LibraryBadge } from "./library-badge";
import { getErrorMessage } from "../../../lib/error-utils";

/**
 * Props for the AlbumTrackList component
 */
interface AlbumTrackListProps {
	/** The Lidarr instance ID */
	instanceId: string;
	/** The album ID to display tracks for */
	albumId: number;
}

/**
 * Formats a duration in milliseconds to a mm:ss string
 */
const formatDuration = (ms: number | undefined): string | null => {
	if (!ms || ms <= 0) return null;
	const totalSeconds = Math.round(ms / 1000);
	const minutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds % 60;
	return `${minutes}:${seconds.toString().padStart(2, "0")}`;
};

/**
 * AlbumTrackList displays the individual tracks for a specific album,
 * showing track number, title, duration, file status, and audio quality.
 *
 * This is the Lidarr equivalent of SeasonEpisodeList — a self-contained
 * component that manages its own data fetching via useTracksQuery.
 */
export const AlbumTrackList = ({
	instanceId,
	albumId,
}: AlbumTrackListProps) => {
	const { data, isLoading, isError, error } = useTracksQuery({
		instanceId,
		albumId,
	});

	if (isLoading) {
		return (
			<div className="flex items-center justify-center py-4 text-sm text-muted-foreground">
				<Loader2 className="h-4 w-4 animate-spin mr-2" />
				Loading tracks...
			</div>
		);
	}

	if (isError) {
		return (
			<div
				className="p-3 rounded-xl flex items-start gap-3"
				style={{
					backgroundColor: SEMANTIC_COLORS.error.bg,
					border: `1px solid ${SEMANTIC_COLORS.error.border}`,
				}}
			>
				<AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" style={{ color: SEMANTIC_COLORS.error.from }} />
				<p className="text-xs" style={{ color: SEMANTIC_COLORS.error.text }}>
					Failed to load tracks{error ? `: ${getErrorMessage(error)}` : ""}
				</p>
			</div>
		);
	}

	if (!data?.tracks || data.tracks.length === 0) {
		return <div className="py-4 text-center text-sm text-muted-foreground">No tracks found</div>;
	}

	return (
		<div className="space-y-2">
			{data.tracks.map((track) => {
				const duration = formatDuration(track.duration);

				return (
					<div
						key={track.id}
						className="flex items-center gap-3 rounded-lg border border-border/50 bg-background/10 px-3 py-2 text-sm"
					>
						{/* Track number + title */}
						<div className="flex-1 min-w-0">
							<div className="flex items-center gap-2">
								<span className="font-mono text-xs text-muted-foreground tabular-nums w-6 text-right shrink-0">
									{track.trackNumber ?? track.absoluteTrackNumber ?? "–"}
								</span>
								<Music2 className="h-3 w-3 text-muted-foreground shrink-0" />
								<span className="text-foreground truncate">{track.title || "Untitled"}</span>
								{track.explicit && (
									<span className="rounded border border-red-400/40 bg-red-500/10 px-1 py-px text-[10px] font-bold text-red-300 shrink-0">
										E
									</span>
								)}
							</div>
							<div className="flex items-center gap-3 mt-0.5 ml-8">
								{duration && (
									<span className="text-xs text-muted-foreground">{duration}</span>
								)}
								{track.trackFile?.quality && (
									<span className="text-xs text-muted-foreground">{track.trackFile.quality}</span>
								)}
								{track.trackFile?.audioCodec && (
									<span className="text-xs text-muted-foreground">{track.trackFile.audioCodec}</span>
								)}
								{track.trackFile?.audioBitRate && (
									<span className="text-xs text-muted-foreground">{track.trackFile.audioBitRate}</span>
								)}
							</div>
						</div>

						{/* Status badges */}
						<div className="flex items-center gap-2 shrink-0">
							<LibraryBadge tone={track.hasFile ? "green" : "blue"}>
								{track.hasFile ? "Downloaded" : "Missing"}
							</LibraryBadge>
						</div>
					</div>
				);
			})}
		</div>
	);
};
