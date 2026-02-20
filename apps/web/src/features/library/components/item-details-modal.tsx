"use client";

import type { LibraryItem } from "@arr/shared";
import {
	X,
	Film,
	Tv,
	Calendar,
	HardDrive,
	Clock,
	FolderOpen,
	FileVideo,
	Tag,
	Layers,
} from "lucide-react";
import { formatBytes, formatRuntime, SERVICE_COLORS } from "../lib/library-utils";
import { PosterImage } from "./poster-image";
import { useThemeGradient } from "../../../hooks/useThemeGradient";
import { useFocusTrap } from "../../../hooks/useFocusTrap";
import { useMovieFileQuery } from "../../../hooks/api/useLibrary";
import { ExternalLinksSection } from "../../discover/components/media-detail-sections";

export interface ItemDetailsModalProps {
	item: LibraryItem;
	onClose: () => void;
}

/**
 * Premium Metadata Item Component
 */
const MetadataItem = ({
	label,
	value,
	icon: Icon,
}: {
	label: string;
	value: React.ReactNode;
	icon?: React.ComponentType<{ className?: string; style?: React.CSSProperties }>;
}) => {
	return (
		<div className="space-y-1">
			<div className="flex items-center gap-1.5">
				{Icon && <Icon className="h-3 w-3 text-muted-foreground" />}
				<p className="text-xs uppercase tracking-wider text-muted-foreground">{label}</p>
			</div>
			<p className="text-sm font-medium text-foreground">{value}</p>
		</div>
	);
};

/**
 * Premium Item Details Modal
 *
 * Modal displaying full details for a library item with:
 * - Glassmorphic backdrop and container
 * - Theme-aware styling
 * - Poster display with gradient overlay
 * - Structured metadata sections
 * - External link buttons
 */
export const ItemDetailsModal = ({ item, onClose }: ItemDetailsModalProps) => {
	const { gradient: themeGradient } = useThemeGradient();
	const focusTrapRef = useFocusTrap<HTMLDivElement>(true, onClose);

	const isMovie = item.type === "movie";

	// Fetch live movie file details from Radarr (includes codecs, custom formats, etc.)
	const movieFileQuery = useMovieFileQuery({
		instanceId: item.instanceId,
		movieId: item.id,
		enabled: isMovie && item.hasFile === true,
	});
	const liveMovieFile = movieFileQuery.data?.movieFile ?? null;
	const liveQualityProfileName = movieFileQuery.data?.qualityProfileName;

	const sizeLabel = formatBytes(item.sizeOnDisk);
	const runtimeLabel = formatRuntime(item.runtime);
	const serviceLabels: Record<"sonarr" | "radarr" | "lidarr" | "readarr", string> = {
		sonarr: "Sonarr",
		radarr: "Radarr",
		lidarr: "Lidarr",
		readarr: "Readarr",
	};
	const serviceLabel = serviceLabels[item.service];
	const serviceColor = SERVICE_COLORS[item.service];
	const resolvedQualityProfileName = liveQualityProfileName ?? item.qualityProfileName;

	const isMovieFileFetchError = isMovie && item.hasFile === true && movieFileQuery.isError;

	// For movies: metadata is merged into a combined section with file details.
	// For series/other: build a metadata grid.
	const mf = isMovie ? (liveMovieFile ?? item.movieFile) : null;

	const seriesMetadata: Array<{ label: string; value: React.ReactNode; icon?: React.ComponentType<{ className?: string }> }> = [];
	if (!isMovie) {
		seriesMetadata.push({ label: "Instance", value: item.instanceName });
		seriesMetadata.push({ label: "Service", value: serviceLabel });
		if (resolvedQualityProfileName) {
			seriesMetadata.push({ label: "Quality profile", value: resolvedQualityProfileName });
		}
		const seasonCount =
			item.seasons?.filter((s) => s.seasonNumber !== 0).length ||
			item.statistics?.seasonCount ||
			undefined;
		if (seasonCount) {
			seriesMetadata.push({ label: "Seasons", value: seasonCount, icon: Layers });
		}
		const episodeFileCount = item.statistics?.episodeFileCount ?? 0;
		const totalEpisodes = item.statistics?.episodeCount ?? item.statistics?.totalEpisodeCount ?? 0;
		if (totalEpisodes > 0) {
			seriesMetadata.push({ label: "Episodes", value: `${episodeFileCount}/${totalEpisodes}` });
		}
		if (runtimeLabel) {
			seriesMetadata.push({ label: "Episode length", value: runtimeLabel, icon: Clock });
		}
		if (sizeLabel) {
			seriesMetadata.push({ label: "On disk", value: sizeLabel, icon: HardDrive });
		}
		if (item.path) {
			seriesMetadata.push({ label: "Location", value: item.path, icon: FolderOpen });
		}
		if (item.rootFolderPath && item.rootFolderPath !== item.path) {
			seriesMetadata.push({ label: "Root", value: item.rootFolderPath, icon: FolderOpen });
		}
	}

	const tagEntries = (item.tags ?? []).filter(Boolean);
	const genreEntries = (item.genres ?? []).filter(Boolean);

	return (
		<div
			className="fixed inset-0 z-modal-backdrop flex items-center justify-center p-4 animate-in fade-in duration-200"
			onClick={onClose}
			role="dialog"
			aria-modal="true"
			aria-labelledby="item-details-title"
		>
			{/* Backdrop */}
			<div className="absolute inset-0 bg-black/70 backdrop-blur-xs" />

			{/* Modal */}
			<div
				ref={focusTrapRef}
				className="relative w-full max-w-3xl max-h-[90vh] overflow-y-auto rounded-2xl border border-border/50 bg-card/95 backdrop-blur-xl shadow-2xl animate-in zoom-in-95 slide-in-from-bottom-4 duration-300"
				style={{
					boxShadow: `0 25px 50px -12px rgba(0, 0, 0, 0.5), 0 0 0 1px ${serviceColor}15`,
				}}
				onClick={(event) => event.stopPropagation()}
			>
				{/* Close Button */}
				<button
					type="button"
					onClick={onClose}
					aria-label="Close modal"
					className="absolute right-4 top-4 z-10 flex h-8 w-8 items-center justify-center rounded-lg bg-black/50 text-white/70 transition-colors hover:bg-black/70 hover:text-white"
				>
					<X className="h-4 w-4" />
				</button>

				{/* Header with Poster */}
				<div
					className="p-6 border-b border-border/30"
					style={{
						background: `linear-gradient(135deg, ${serviceColor}08, transparent)`,
					}}
				>
					<div className="flex gap-5">
						{item.poster && (
							<div className="h-48 w-32 overflow-hidden rounded-xl border border-border/50 shadow-lg shrink-0">
								<PosterImage
									arrPosterUrl={item.poster}
									size="w342"
									alt={item.title}
								/>
							</div>
						)}
						<div className="flex-1 min-w-0">
							<div className="flex items-center gap-2 mb-2">
								<div
									className="flex h-8 w-8 items-center justify-center rounded-lg shrink-0"
									style={{
										background: `${serviceColor}20`,
										border: `1px solid ${serviceColor}30`,
									}}
								>
									{item.type === "movie" ? (
										<Film className="h-4 w-4" style={{ color: serviceColor }} />
									) : (
										<Tv className="h-4 w-4" style={{ color: serviceColor }} />
									)}
								</div>
								<span
									className="text-xs uppercase tracking-wider font-medium"
									style={{ color: serviceColor }}
								>
									{item.type}
								</span>
							</div>

							<h2 id="item-details-title" className="text-2xl font-bold text-foreground mb-1">{item.title}</h2>

							<div className="flex items-center gap-3 text-sm text-muted-foreground">
								{item.year && item.type === "movie" && (
									<span className="flex items-center gap-1">
										<Calendar className="h-3.5 w-3.5" />
										{item.year}
									</span>
								)}
								<span>{item.instanceName}</span>
							</div>
						</div>
					</div>
				</div>

				{/* Content */}
				<div className="p-6 space-y-6">
					{/* Overview */}
					{item.overview && (
						<div>
							<h3 className="text-xs uppercase tracking-wider font-medium text-muted-foreground mb-2">
								Overview
							</h3>
							<p className="text-sm leading-relaxed text-muted-foreground">{item.overview}</p>
						</div>
					)}

					{/* Genres */}
					{genreEntries.length > 0 && (
						<div>
							<h3 className="text-xs uppercase tracking-wider font-medium text-muted-foreground mb-3">
								Genres
							</h3>
							<div className="flex flex-wrap gap-2">
								{genreEntries.map((genre, index) => (
									<span
										key={`${index}-${genre}`}
										className="rounded-full px-3 py-1 text-sm font-medium"
										style={{
											backgroundColor: `${themeGradient.from}10`,
											border: `1px solid ${themeGradient.from}25`,
											color: themeGradient.from,
										}}
									>
										{genre}
									</span>
								))}
							</div>
						</div>
					)}

					{/* External Links */}
					<ExternalLinksSection
						tmdbId={item.remoteIds?.tmdbId}
						imdbId={item.remoteIds?.imdbId}
						tvdbId={item.remoteIds?.tvdbId}
						mediaType={item.type === "movie" ? "movie" : "tv"}
					/>

					{/* Tags */}
					{tagEntries.length > 0 && (
						<div>
							<h3 className="flex items-center gap-1.5 text-xs uppercase tracking-wider font-medium text-muted-foreground mb-3">
								<Tag className="h-3 w-3" />
								Tags
							</h3>
							<div className="flex flex-wrap gap-2">
								{tagEntries.map((tag, index) => (
									<span
										key={`${index}-${tag}`}
										className="rounded-full border border-border/50 bg-card/50 px-3 py-1 text-sm text-foreground"
									>
										{tag}
									</span>
								))}
							</div>
						</div>
					)}

					{/* Movie: Single combined details section (metadata + file info) */}
					{isMovie && (
						<div>
							<h3 className="text-xs uppercase tracking-wider font-medium text-muted-foreground mb-3">
								Media Details
							</h3>
							{isMovieFileFetchError && (
								<p className="text-xs text-amber-400/70 italic mb-2">
									Live file details unavailable — showing cached data
								</p>
							)}
							<div className="rounded-xl border border-border/50 bg-card/30 backdrop-blur-xs p-4 space-y-3">
								{/* Key metadata row: instance + quality profile + runtime */}
								<div className="grid grid-cols-2 sm:grid-cols-3 gap-x-4 gap-y-2 text-sm">
									<div>
										<p className="text-xs text-muted-foreground">Instance</p>
										<p className="font-medium text-foreground">{item.instanceName}</p>
									</div>
									{resolvedQualityProfileName && (
										<div>
											<p className="text-xs text-muted-foreground">Quality Profile</p>
											<p className="font-medium text-foreground">{resolvedQualityProfileName}</p>
										</div>
									)}
									{runtimeLabel && (
										<div>
											<p className="text-xs text-muted-foreground">Runtime</p>
											<p className="font-medium text-foreground">{runtimeLabel}</p>
										</div>
									)}
								</div>

								{mf && (
									<>
										{/* Quality + release group + resolution + codecs */}
										<div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-sm pt-2 border-t border-border/20">
											{mf.quality && (
												<span className="inline-flex items-center gap-1.5">
													<Film className="h-3.5 w-3.5 text-cyan-400/70" />
													<span className="font-medium text-foreground">{mf.quality}</span>
													{mf.releaseGroup && (
														<span className="text-muted-foreground/70">— {mf.releaseGroup}</span>
													)}
												</span>
											)}
											{mf.resolution && (
												<span className="text-foreground/80">
													{mf.resolution}
													{mf.videoDynamicRange && mf.videoDynamicRange !== "SDR" && (
														<span className="ml-1 text-amber-400/80 font-semibold">
															{mf.videoDynamicRange}
														</span>
													)}
												</span>
											)}
											{(mf.videoCodec || mf.audioCodec) && (
												<span className="text-muted-foreground/70">
													{[mf.videoCodec, mf.audioCodec].filter(Boolean).join(" / ")}
												</span>
											)}
										</div>

										{/* Languages + size + score */}
										<div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-sm text-muted-foreground">
											{mf.languages && mf.languages.length > 0 && (
												<span>{mf.languages.join(", ")}</span>
											)}
											{mf.size != null && mf.size > 0 && (
												<span className="inline-flex items-center gap-1.5">
													<HardDrive className="h-3.5 w-3.5 text-muted-foreground/50" />
													{formatBytes(mf.size)}
												</span>
											)}
											{mf.customFormatScore != null && (
												<span className="font-medium text-foreground/70">
													Score: {mf.customFormatScore}
												</span>
											)}
										</div>

										{/* Custom format badges */}
										{mf.customFormats && mf.customFormats.length > 0 && (
											<div className="flex flex-wrap items-center gap-1.5">
												{mf.customFormats.map((cf) => (
													<span
														key={cf}
														className="rounded-full border border-purple-400/30 bg-purple-500/10 px-2 py-0.5 text-xs text-purple-300"
													>
														{cf}
													</span>
												))}
											</div>
										)}

										{/* File path + folder location */}
										{(mf.relativePath || item.path) && (
											<div className="space-y-1 pt-1 border-t border-border/20">
												{mf.relativePath && (
													<p className="break-all font-mono text-xs text-muted-foreground/60">
														<span className="inline-flex items-center gap-1">
															<FileVideo className="h-3 w-3 shrink-0" />
															{mf.relativePath}
														</span>
													</p>
												)}
												{item.path && (
													<p className="break-all font-mono text-xs text-muted-foreground/40">
														<span className="inline-flex items-center gap-1">
															<FolderOpen className="h-3 w-3 shrink-0" />
															{item.path}
														</span>
													</p>
												)}
											</div>
										)}
									</>
								)}

								{/* Fallback if no file yet: just show size if available */}
								{!mf && sizeLabel && (
									<div className="flex items-center gap-1.5 text-sm text-muted-foreground pt-2 border-t border-border/20">
										<HardDrive className="h-3.5 w-3.5 text-muted-foreground/50" />
										{sizeLabel}
									</div>
								)}
							</div>
						</div>
					)}

					{/* Series/Other: Metadata grid */}
					{!isMovie && seriesMetadata.length > 0 && (
						<div>
							<h3 className="text-xs uppercase tracking-wider font-medium text-muted-foreground mb-3">
								Media Details
							</h3>
							<div className="grid grid-cols-2 md:grid-cols-3 gap-4 rounded-xl border border-border/50 bg-card/30 backdrop-blur-xs p-4">
								{seriesMetadata.map((entry) => (
									<MetadataItem
										key={entry.label}
										label={entry.label}
										value={entry.value}
										icon={entry.icon}
									/>
								))}
							</div>
						</div>
					)}

				</div>
			</div>
		</div>
	);
};
