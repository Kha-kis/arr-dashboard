import type { LibraryItem } from "@arr/shared";
import { ExternalLink } from "lucide-react";
import { Button } from "../../../components/ui";
import { formatBytes, formatRuntime } from "../lib/library-utils";
import { safeOpenUrl } from "../../../lib/utils/url-validation";

export interface ItemDetailsModalProps {
	item: LibraryItem;
	onClose: () => void;
}

/**
 * Modal displaying full details for a library item (movie or series)
 * Shows metadata, genres, tags, and file information
 */
export const ItemDetailsModal = ({ item, onClose }: ItemDetailsModalProps) => {
	const sizeLabel = formatBytes(item.sizeOnDisk);
	const runtimeLabel = formatRuntime(item.runtime);
	const serviceLabel = item.service === "sonarr" ? "Sonarr" : "Radarr";
	const movieFileName =
		item.type === "movie"
			? (item.movieFile?.relativePath ?? item.path)?.split(/[\\/]/g).pop()
			: undefined;

	const metadata: Array<{ label: string; value: React.ReactNode }> = [
		{ label: "Instance", value: item.instanceName },
		{ label: "Service", value: serviceLabel },
	];

	if (item.qualityProfileName) {
		metadata.push({ label: "Quality profile", value: item.qualityProfileName });
	}

	if (item.type === "movie") {
		const movieQuality = item.movieFile?.quality ?? item.qualityProfileName;
		if (movieQuality) {
			metadata.push({ label: "Current quality", value: movieQuality });
		}
		if (sizeLabel) {
			metadata.push({ label: "On disk", value: sizeLabel });
		}
		if (runtimeLabel) {
			metadata.push({ label: "Runtime", value: runtimeLabel });
		}
	} else {
		const seasonCount =
			item.seasons?.filter((s) => s.seasonNumber !== 0).length ||
			item.statistics?.seasonCount ||
			undefined;
		if (seasonCount) {
			metadata.push({ label: "Seasons", value: seasonCount });
		}
		const episodeFileCount = item.statistics?.episodeFileCount ?? 0;
		const totalEpisodes = item.statistics?.episodeCount ?? item.statistics?.totalEpisodeCount ?? 0;
		if (totalEpisodes > 0) {
			metadata.push({
				label: "Episodes",
				value: `${episodeFileCount}/${totalEpisodes}`,
			});
		}
		if (runtimeLabel) {
			metadata.push({ label: "Episode length", value: runtimeLabel });
		}
		if (sizeLabel) {
			metadata.push({ label: "On disk", value: sizeLabel });
		}
	}

	const locationEntries: Array<{ label: string; value: string }> = [];
	if (item.path) {
		locationEntries.push({ label: "Location", value: item.path });
	}
	if (movieFileName) {
		locationEntries.push({ label: "File", value: movieFileName });
	}
	if (item.rootFolderPath && item.rootFolderPath !== item.path) {
		locationEntries.push({ label: "Root", value: item.rootFolderPath });
	}

	const tagEntries = (item.tags ?? []).filter(Boolean);
	const genreEntries = (item.genres ?? []).filter(Boolean);

	return (
		<div
			className="fixed inset-0 z-modal-backdrop flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm"
			onClick={onClose}
		>
			<div
				className="w-full max-w-3xl max-h-[90vh] overflow-y-auto rounded-2xl border border-border bg-bg-subtle/98 backdrop-blur-xl p-6 shadow-2xl"
				onClick={(event) => event.stopPropagation()}
			>
				<div className="flex items-start justify-between gap-4 mb-6">
					<div className="flex gap-4">
						{item.poster && (
							<div className="h-48 w-32 overflow-hidden rounded-lg border border-border bg-bg-muted shadow-md flex-shrink-0">
								{/* eslint-disable-next-line @next/next/no-img-element -- External poster from arr instance */}
								<img src={item.poster} alt={item.title} className="h-full w-full object-cover" />
							</div>
						)}
						<div>
							<h2 className="text-2xl font-semibold text-fg mb-1">{item.title}</h2>
							{item.year && item.type === "movie" && (
								<p className="text-sm text-fg-muted mb-2">{item.year}</p>
							)}
							<p className="text-sm text-fg-muted">{item.instanceName}</p>
						</div>
					</div>
					<Button type="button" variant="ghost" onClick={onClose}>
						Close
					</Button>
				</div>

				{item.overview && (
					<div className="mb-6">
						<h3 className="text-sm font-medium text-fg uppercase tracking-wider mb-2">Overview</h3>
						<p className="text-sm leading-relaxed text-fg-muted">{item.overview}</p>
					</div>
				)}

				{genreEntries.length > 0 && (
					<div className="mb-6">
						<h3 className="text-sm font-medium text-fg uppercase tracking-wider mb-2">Genres</h3>
						<div className="flex flex-wrap gap-2">
							{genreEntries.map((genre, index) => (
								<span
									key={`${index}-${genre}`}
									className="rounded-full border border-border bg-bg-muted/50 px-3 py-1 text-sm text-fg-muted"
								>
									{genre}
								</span>
							))}
						</div>
					</div>
				)}

				{(item.remoteIds?.tmdbId || item.remoteIds?.imdbId || item.remoteIds?.tvdbId) && (
					<div className="mb-6">
						<h3 className="text-sm font-medium text-fg uppercase tracking-wider mb-2">External Links</h3>
						<div className="flex flex-wrap gap-2">
							{item.remoteIds?.tmdbId && (
								<Button
									type="button"
									variant="secondary"
									size="sm"
									className="flex items-center gap-1.5"
									onClick={() => safeOpenUrl(`https://www.themoviedb.org/${item.type === "movie" ? "movie" : "tv"}/${item.remoteIds?.tmdbId}`)}
								>
									<ExternalLink className="h-3.5 w-3.5" />
									<span>TMDB</span>
								</Button>
							)}
							{item.remoteIds?.imdbId && (
								<Button
									type="button"
									variant="secondary"
									size="sm"
									className="flex items-center gap-1.5"
									onClick={() => safeOpenUrl(`https://www.imdb.com/title/${item.remoteIds?.imdbId}`)}
								>
									<ExternalLink className="h-3.5 w-3.5" />
									<span>IMDB</span>
								</Button>
							)}
							{item.remoteIds?.tvdbId && (
								<Button
									type="button"
									variant="secondary"
									size="sm"
									className="flex items-center gap-1.5"
									onClick={() => safeOpenUrl(`https://www.thetvdb.com/dereferrer/series/${item.remoteIds?.tvdbId}`)}
								>
									<ExternalLink className="h-3.5 w-3.5" />
									<span>TVDB</span>
								</Button>
							)}
						</div>
					</div>
				)}

				{tagEntries.length > 0 && (
					<div className="mb-6">
						<h3 className="text-sm font-medium text-fg uppercase tracking-wider mb-2">Tags</h3>
						<div className="flex flex-wrap gap-2">
							{tagEntries.map((tag, index) => (
								<span
									key={`${index}-${tag}`}
									className="rounded-full border border-accent/40 bg-accent/10 px-3 py-1 text-sm text-fg"
								>
									{tag}
								</span>
							))}
						</div>
					</div>
				)}

				<div className="mb-6">
					<h3 className="text-sm font-medium text-fg uppercase tracking-wider mb-3">Metadata</h3>
					<div className="grid grid-cols-2 gap-4">
						{metadata.map((entry) => (
							<div key={entry.label} className="space-y-1">
								<p className="text-xs uppercase tracking-wider text-fg-subtle">{entry.label}</p>
								<p className="text-sm text-fg">{entry.value}</p>
							</div>
						))}
					</div>
				</div>

				{locationEntries.length > 0 && (
					<div>
						<h3 className="text-sm font-medium text-fg uppercase tracking-wider mb-3">
							File Information
						</h3>
						<div className="space-y-3 rounded-lg border border-border bg-bg-muted/30 p-4">
							{locationEntries.map((entry) => (
								<div key={entry.label} className="space-y-1">
									<p className="text-xs uppercase tracking-wider text-fg-subtle">{entry.label}</p>
									<p className="break-all font-mono text-xs text-fg-muted">{entry.value}</p>
								</div>
							))}
						</div>
					</div>
				)}
			</div>
		</div>
	);
};
