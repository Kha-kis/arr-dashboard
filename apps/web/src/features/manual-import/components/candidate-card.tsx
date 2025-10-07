import { Button } from "../../../components/ui/button";
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
	}

	const chips = [qualityLabel, sizeLabel, languageLabel, releaseGroup].filter(
		(value): value is string => Boolean(value),
	);

	const episodes = isSonarrCandidate(candidate) && candidate.episodes ? candidate.episodes : [];

	return (
		<div
			key={key}
			className={cn(
				"rounded-xl border border-white/10 bg-white/5 p-4 transition",
				selected && "border-white/40",
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
							<p className="font-medium text-white">{describeCandidate(candidate)}</p>
							<p className="break-words text-xs text-white/60">{candidateDisplayPath(candidate)}</p>
						</div>
						{chips.length > 0 && (
							<div className="flex flex-wrap gap-2 text-xs text-white/60">
								{chips.map((chip, index) => (
									<span
										key={`${key}:chip:${index}`}
										className="rounded-full border border-white/15 px-2 py-0.5"
									>
										{chip}
									</span>
								))}
							</div>
						)}
					</div>
				</div>
				<div className="space-y-2 text-sm text-white/80">
					<div>
						<p className="text-xs uppercase text-white/50">Mapping</p>
						<p>{mappingSummary}</p>
					</div>
					{selected && isSonarrCandidate(candidate) && episodes.length > 0 && (
						<div className="space-y-2 rounded-md border border-white/10 bg-slate-900/50 p-3 text-xs text-white/70">
							<div className="flex flex-wrap items-center justify-between gap-2">
								<span>Episodes</span>
								<div className="flex gap-2">
									<button
										type="button"
										className="text-sky-300 hover:underline disabled:opacity-50"
										onClick={onSelectAllEpisodes}
										disabled={disabled}
									>
										Select all
									</button>
									<button
										type="button"
										className="text-sky-300 hover:underline disabled:opacity-50"
										onClick={onClearEpisodes}
										disabled={disabled}
									>
										Clear
									</button>
								</div>
							</div>
							<div className="grid gap-1 sm:grid-cols-2">
								{episodes.map((episode) => {
									const episodeId = typeof episode?.id === "number" ? episode.id : undefined;
									if (episodeId === undefined) {
										return null;
									}
									const checked = episodeIds.includes(episodeId);
									return (
										<label
											key={`${key}:episode:${episodeId}`}
											className="flex items-center gap-2 rounded-md border border-white/10 bg-white/5 px-2 py-1 text-white/80"
										>
											<input
												type="checkbox"
												className="h-3.5 w-3.5"
												checked={checked}
												onChange={() => onToggleEpisode(episodeId)}
												disabled={disabled}
											/>
											<span className="truncate text-xs">
												{describeEpisode(episode as Parameters<typeof describeEpisode>[0])}
											</span>
										</label>
									);
								})}
							</div>
						</div>
					)}
				</div>
				<div className="flex flex-col items-end gap-3 text-xs text-white/60">
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
