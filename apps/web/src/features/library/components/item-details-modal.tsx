"use client";

import type { LibraryItem } from "@arr/shared";
import {
	ExternalLink,
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
import { formatBytes, formatRuntime } from "../lib/library-utils";
import { safeOpenUrl } from "../../../lib/utils/url-validation";
import { BRAND_COLORS, SERVICE_GRADIENTS } from "../../../lib/theme-gradients";
import { useThemeGradient } from "../../../hooks/useThemeGradient";
import { useFocusTrap } from "../../../hooks/useFocusTrap";

export interface ItemDetailsModalProps {
	item: LibraryItem;
	onClose: () => void;
}

// Use centralized service colors
const SERVICE_COLORS: Record<"sonarr" | "radarr" | "lidarr" | "readarr", string> = {
	sonarr: SERVICE_GRADIENTS.sonarr.from,
	radarr: SERVICE_GRADIENTS.radarr.from,
	lidarr: SERVICE_GRADIENTS.lidarr.from,
	readarr: SERVICE_GRADIENTS.readarr.from,
};

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
	const movieFileName =
		item.type === "movie"
			? (item.movieFile?.relativePath ?? item.path)?.split(/[\\/]/g).pop()
			: undefined;

	const metadata: Array<{ label: string; value: React.ReactNode; icon?: React.ComponentType<{ className?: string }> }> = [
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
			metadata.push({ label: "On disk", value: sizeLabel, icon: HardDrive });
		}
		if (runtimeLabel) {
			metadata.push({ label: "Runtime", value: runtimeLabel, icon: Clock });
		}
	} else {
		const seasonCount =
			item.seasons?.filter((s) => s.seasonNumber !== 0).length ||
			item.statistics?.seasonCount ||
			undefined;
		if (seasonCount) {
			metadata.push({ label: "Seasons", value: seasonCount, icon: Layers });
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
			metadata.push({ label: "Episode length", value: runtimeLabel, icon: Clock });
		}
		if (sizeLabel) {
			metadata.push({ label: "On disk", value: sizeLabel, icon: HardDrive });
		}
	}

	const locationEntries: Array<{ label: string; value: string; icon: React.ComponentType<{ className?: string }> }> = [];
	if (item.path) {
		locationEntries.push({ label: "Location", value: item.path, icon: FolderOpen });
	}
	if (movieFileName) {
		locationEntries.push({ label: "File", value: movieFileName, icon: FileVideo });
	}
	if (item.rootFolderPath && item.rootFolderPath !== item.path) {
		locationEntries.push({ label: "Root", value: item.rootFolderPath, icon: FolderOpen });
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
								{/* eslint-disable-next-line @next/next/no-img-element -- External poster from arr instance */}
								<img src={item.poster} alt={item.title} className="h-full w-full object-cover" />
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
					{(item.remoteIds?.tmdbId || item.remoteIds?.imdbId || item.remoteIds?.tvdbId) && (
						<div>
							<h3 className="text-xs uppercase tracking-wider font-medium text-muted-foreground mb-3">
								External Links
							</h3>
							<div className="flex flex-wrap gap-2">
								{item.remoteIds?.tmdbId && (
									<button
										type="button"
										className="inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm font-medium transition-colors hover:opacity-80"
										style={{
											backgroundColor: `${themeGradient.from}15`,
											border: `1px solid ${themeGradient.from}30`,
											color: themeGradient.from,
										}}
										onClick={() => safeOpenUrl(`https://www.themoviedb.org/${item.type === "movie" ? "movie" : "tv"}/${item.remoteIds?.tmdbId}`)}
									>
										<ExternalLink className="h-3.5 w-3.5" />
										TMDB
									</button>
								)}
								{item.remoteIds?.imdbId && (
									<button
										type="button"
										className="inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm font-medium transition-colors hover:opacity-80"
										style={{
											backgroundColor: BRAND_COLORS.imdb.bg,
											border: `1px solid ${BRAND_COLORS.imdb.border}`,
											color: BRAND_COLORS.imdb.text,
										}}
										onClick={() => safeOpenUrl(`https://www.imdb.com/title/${item.remoteIds?.imdbId}`)}
									>
										<ExternalLink className="h-3.5 w-3.5" />
										IMDB
									</button>
								)}
								{item.remoteIds?.tvdbId && (
									<button
										type="button"
										className="inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm font-medium transition-colors hover:opacity-80"
										style={{
											backgroundColor: BRAND_COLORS.rottenTomatoes.bg,
											border: `1px solid ${BRAND_COLORS.rottenTomatoes.border}`,
											color: BRAND_COLORS.rottenTomatoes.text,
										}}
										onClick={() => safeOpenUrl(`https://www.thetvdb.com/dereferrer/series/${item.remoteIds?.tvdbId}`)}
									>
										<ExternalLink className="h-3.5 w-3.5" />
										TVDB
									</button>
								)}
							</div>
						</div>
					)}

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

					{/* Metadata Grid */}
					<div>
						<h3 className="text-xs uppercase tracking-wider font-medium text-muted-foreground mb-3">
							Metadata
						</h3>
						<div className="grid grid-cols-2 md:grid-cols-3 gap-4 rounded-xl border border-border/50 bg-card/30 backdrop-blur-xs p-4">
							{metadata.map((entry) => (
								<MetadataItem
									key={entry.label}
									label={entry.label}
									value={entry.value}
									icon={entry.icon}
								/>
							))}
						</div>
					</div>

					{/* File Information */}
					{locationEntries.length > 0 && (
						<div>
							<h3 className="text-xs uppercase tracking-wider font-medium text-muted-foreground mb-3">
								File Information
							</h3>
							<div className="space-y-3 rounded-xl border border-border/50 bg-card/30 backdrop-blur-xs p-4">
								{locationEntries.map((entry) => (
									<div key={entry.label} className="space-y-1">
										<div className="flex items-center gap-1.5">
											<entry.icon className="h-3 w-3 text-muted-foreground" />
											<p className="text-xs uppercase tracking-wider text-muted-foreground">{entry.label}</p>
										</div>
										<p className="break-all font-mono text-xs text-foreground/80">{entry.value}</p>
									</div>
								))}
							</div>
						</div>
					)}
				</div>
			</div>
		</div>
	);
};
