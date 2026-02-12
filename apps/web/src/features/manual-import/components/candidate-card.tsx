import { Button } from "../../../components/ui/button";
import { useThemeGradient } from "../../../hooks/useThemeGradient";
import type { ManualImportCandidateUnion } from "../types";
import {
	candidateDisplayPath,
	candidateKey,
	describeCandidate,
	describeRejections,
	describeQuality,
	describeLanguages,
	extractDownloadId,
	formatFileSize,
	isSonarrCandidate,
	isRadarrCandidate,
	isLidarrCandidate,
	isReadarrCandidate,
	describeEpisode,
} from "../helpers";
import { cn } from "../../../lib/utils";

interface CandidateCardProps {
	candidate: ManualImportCandidateUnion;
	selected: boolean;
	episodeIds: number[];
	downloadId?: string;
	onToggle: () => void;
	onToggleEpisode: (episodeId: number) => void;
	onSelectAllEpisodes: () => void;
	onClearEpisodes: () => void;
	disabled?: boolean;
}

const statusToneClasses: Record<"ready" | "warning" | "error", string> = {
	ready: "text-emerald-300",
	warning: "text-amber-300",
	error: "text-red-300",
};

export const CandidateCard = ({
	candidate,
	selected,
	episodeIds,
	downloadId,
	onToggle,
	onToggleEpisode,
	onSelectAllEpisodes,
	onClearEpisodes,
	disabled = false,
}: CandidateCardProps) => {
	const { gradient: themeGradient } = useThemeGradient();
	const key = candidateKey(candidate);
	const rejection = describeRejections(candidate);
	const downloadAvailable = Boolean(extractDownloadId(candidate) ?? downloadId);
	const qualityLabel = describeQuality(candidate.quality);
	const languageLabel = describeLanguages(candidate.languages);
	const sizeLabel =
		typeof candidate.size === "number" && candidate.size > 0 ? formatFileSize(candidate.size) : "";
	const releaseGroup = candidate.releaseGroup;

	const mappingSummary = isSonarrCandidate(candidate)
		? (candidate.series?.title ?? "Unmapped series")
		: isRadarrCandidate(candidate)
			? (candidate.movie?.title ?? "Unmapped movie")
			: isLidarrCandidate(candidate)
				? (candidate.artist?.artistName ?? "Unmapped artist")
				: isReadarrCandidate(candidate)
					? (candidate.author?.authorName ?? "Unmapped author")
					: "Unknown";

	let statusTone: "ready" | "warning" | "error" = "ready";
	let statusText = "Ready to import";

	if (!downloadAvailable) {
		statusTone = "error";
		statusText = "Download identifier not available.";
	} else if (rejection) {
		statusTone = "warning";
		statusText = rejection;
	} else if (selected && isSonarrCandidate(candidate) && episodeIds.length === 0) {
		statusTone = "warning";
		statusText = "Select at least one episode before importing.";
	} else if (selected && isRadarrCandidate(candidate) && candidate.movie?.id === undefined) {
		statusTone = "warning";
		statusText = "Movie mapping is missing.";
	} else if (selected && isLidarrCandidate(candidate) && (candidate.artist?.id === undefined || candidate.album?.id === undefined)) {
		statusTone = "warning";
		statusText = candidate.artist?.id === undefined ? "Artist mapping is missing." : "Album mapping is missing.";
	} else if (selected && isReadarrCandidate(candidate) && (candidate.author?.id === undefined || candidate.book?.id === undefined)) {
		statusTone = "warning";
		statusText = candidate.author?.id === undefined ? "Author mapping is missing." : "Book mapping is missing.";
	}

	const chips = [qualityLabel, sizeLabel, languageLabel, releaseGroup].filter(
		(value): value is string => Boolean(value),
	);

	const episodes = isSonarrCandidate(candidate) && candidate.episodes ? candidate.episodes : [];

	return (
		<div
			key={key}
			className={cn(
				"rounded-xl border border-border bg-card p-4 transition",
				selected && "border-primary/40",
				rejection && "border-amber-500/40",
				!downloadAvailable && "border-red-500/40",
			)}
		>
			<div className="grid gap-4 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_10rem] lg:items-start">
				<div className="flex items-start gap-3">
					<input
						type="checkbox"
						className="mt-1 h-4 w-4"
						checked={selected}
						onChange={onToggle}
						disabled={!downloadAvailable || disabled}
					/>
					<div className="min-w-0 space-y-2">
						<div className="space-y-1">
							<p className="font-medium text-foreground">{describeCandidate(candidate)}</p>
							<p className="wrap-break-word text-xs text-muted-foreground">{candidateDisplayPath(candidate)}</p>
						</div>
						{chips.length > 0 && (
							<div className="flex flex-wrap gap-2 text-xs text-muted-foreground">
								{chips.map((chip, index) => (
									<span
										key={`${key}:chip:${index}`}
										className="rounded-full border border-border px-2 py-0.5"
									>
										{chip}
									</span>
								))}
							</div>
						)}
					</div>
				</div>
				<div className="space-y-2 text-sm text-muted-foreground">
					<div>
						<p className="text-xs uppercase text-muted-foreground">Mapping</p>
						<p>{mappingSummary}</p>
						{isLidarrCandidate(candidate) && candidate.album?.title && (
							<p className="text-xs text-muted-foreground/70">{candidate.album.title}</p>
						)}
						{isReadarrCandidate(candidate) && candidate.book?.title && (
							<p className="text-xs text-muted-foreground/70">{candidate.book.title}</p>
						)}
					</div>
					{isSonarrCandidate(candidate) && episodes.length > 0 && (
						<div className="space-y-2 rounded-md border border-border bg-muted p-3 text-xs text-muted-foreground">
							<div className="flex flex-wrap items-center justify-between gap-2">
								<span>Episodes ({episodes.length})</span>
								{selected && (
									<div className="flex gap-2">
										<button
											type="button"
											className="hover:underline disabled:opacity-50"
											style={{ color: themeGradient.from }}
											onClick={onSelectAllEpisodes}
											disabled={disabled}
										>
											Select all
										</button>
										<button
											type="button"
											className="hover:underline disabled:opacity-50"
											style={{ color: themeGradient.from }}
											onClick={onClearEpisodes}
											disabled={disabled}
										>
											Clear
										</button>
									</div>
								)}
							</div>
							<div className="grid gap-1 sm:grid-cols-2">
								{episodes.map((episode) => {
									const episodeId = typeof episode?.id === "number" ? episode.id : undefined;
									if (episodeId === undefined) {
										return null;
									}
									const checked = selected && episodeIds.includes(episodeId);
									return (
										<label
											key={`${key}:episode:${episodeId}`}
											className={cn(
												"flex items-center gap-2 rounded-md border border-border bg-card px-2 py-1 text-muted-foreground",
												!selected && "opacity-60",
											)}
										>
											<input
												type="checkbox"
												className="h-3.5 w-3.5"
												checked={checked}
												onChange={() => onToggleEpisode(episodeId)}
												disabled={disabled || !selected}
											/>
											<span className="truncate text-xs">
												{describeEpisode(episode as Parameters<typeof describeEpisode>[0])}
											</span>
										</label>
									);
								})}
							</div>
							{!selected && (
								<p className="text-xs text-muted-foreground/70 italic">Select file to enable episode selection</p>
							)}
						</div>
					)}
				</div>
				<div className="flex flex-col items-end gap-3 text-xs text-muted-foreground">
					<span className={statusToneClasses[statusTone]}>{statusText}</span>
					<Button
						variant={selected ? "secondary" : "ghost"}
						className="px-3 py-2 text-xs"
						onClick={onToggle}
						disabled={!downloadAvailable || disabled}
					>
						{selected ? "Selected" : "Select"}
					</Button>
				</div>
			</div>
		</div>
	);
};
