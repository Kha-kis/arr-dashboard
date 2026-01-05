"use client";

import type { DiscoverSearchResult, DiscoverSearchType, ServiceInstanceSummary } from "@arr/shared";
import { ExternalLink, PlusCircle, Star, Clock, CheckCircle2 } from "lucide-react";
import { Button } from "../../../components/ui/button";
import { formatRuntime } from "../lib/discover-utils";
import { InstanceBadge } from "./instance-badge";
import { THEME_GRADIENTS, SEMANTIC_COLORS } from "../../../lib/theme-gradients";
import { useColorTheme } from "../../../providers/color-theme-provider";

/**
 * Props for the MediaCard component
 */
interface MediaCardProps {
	/** The search result to display */
	result: DiscoverSearchResult;
	/** The type of media (movie or series) */
	searchType: DiscoverSearchType;
	/** Available service instances */
	relevantInstances: ServiceInstanceSummary[];
	/** Callback when the add button is clicked */
	onAddClick: (result: DiscoverSearchResult) => void;
	/** Animation delay in ms */
	animationDelay?: number;
}

/**
 * Premium Media Card
 *
 * Card component displaying detailed information about a movie or series with:
 * - Glassmorphic styling
 * - Theme-aware accent colors
 * - Premium poster display with rating overlay
 * - Instance status badges
 * - External links with hover effects
 */
export const MediaCard: React.FC<MediaCardProps> = ({
	result,
	searchType,
	relevantInstances,
	onAddClick,
	animationDelay = 0,
}) => {
	const { colorTheme } = useColorTheme();
	const themeGradient = THEME_GRADIENTS[colorTheme];

	const availableTargets = relevantInstances.filter((instance) => {
		const state = result.instanceStates.find((entry) => entry.instanceId === instance.id);
		return !state?.exists;
	});
	const canAdd = availableTargets.length > 0;
	const runtimeLabel = formatRuntime(result.runtime);
	const genres = result.genres?.slice(0, 4) ?? [];
	const ratingValue = result.ratings?.value;

	return (
		<div
			className="group rounded-2xl border border-border/50 bg-card/30 backdrop-blur-sm p-5 transition-all duration-300 hover:border-border/80 hover:bg-card/50 animate-in fade-in slide-in-from-bottom-4"
			style={{
				animationDelay: `${animationDelay}ms`,
				animationFillMode: "backwards",
			}}
		>
			<div className="space-y-4">
				{/* Main Content */}
				<div className="flex gap-4">
					{/* Poster */}
					<div className="relative h-40 w-28 overflow-hidden rounded-xl border border-border/30 bg-gradient-to-br from-slate-800 to-slate-900 shrink-0">
						{result.images?.poster ? (
							/* eslint-disable-next-line @next/next/no-img-element -- External TMDB image with dynamic URL */
							<img
								src={result.images.poster}
								alt={result.title ?? "Poster"}
								className="h-full w-full object-cover transition-transform duration-500 group-hover:scale-105"
							/>
						) : (
							<div className="flex h-full w-full items-center justify-center text-xs text-muted-foreground">
								{searchType === "movie" ? "Poster" : "Key art"}
							</div>
						)}

						{/* Rating Overlay */}
						{typeof ratingValue === "number" && (
							<div
								className="absolute right-1.5 top-1.5 flex items-center gap-1 rounded-lg px-1.5 py-0.5 text-xs font-medium backdrop-blur-md"
								style={{
									backgroundColor: "rgba(234, 179, 8, 0.2)",
									border: "1px solid rgba(234, 179, 8, 0.4)",
									color: "#fbbf24",
								}}
							>
								<Star className="h-3 w-3 fill-yellow-400" />
								{ratingValue.toFixed(1)}
							</div>
						)}
					</div>

					{/* Info Section */}
					<div className="flex-1 space-y-3 min-w-0">
						{/* Title and Status */}
						<div className="flex flex-wrap items-start justify-between gap-2">
							<div className="min-w-0 flex-1">
								<h3 className="text-lg font-semibold text-foreground leading-tight truncate">
									{result.title}
								</h3>
								<div className="flex flex-wrap items-center gap-2 mt-1 text-sm text-muted-foreground">
									{result.year && (
										<span className="font-medium">{result.year}</span>
									)}
									{result.status && (
										<>
											<span className="text-border">•</span>
											<span>{result.status}</span>
										</>
									)}
									{runtimeLabel && (
										<>
											<span className="text-border">•</span>
											<span className="flex items-center gap-1">
												<Clock className="h-3 w-3" />
												{runtimeLabel}
											</span>
										</>
									)}
								</div>
							</div>
						</div>

						{/* Overview */}
						{result.overview && (
							<p className="line-clamp-2 text-sm text-muted-foreground leading-relaxed">
								{result.overview}
							</p>
						)}

						{/* Genres */}
						{genres.length > 0 && (
							<div className="flex flex-wrap gap-1.5">
								{genres.map((genre) => (
									<span
										key={genre}
										className="rounded-lg px-2 py-0.5 text-xs font-medium"
										style={{
											backgroundColor: `${themeGradient.from}15`,
											border: `1px solid ${themeGradient.from}25`,
											color: themeGradient.from,
										}}
									>
										{genre}
									</span>
								))}
							</div>
						)}
					</div>
				</div>

				{/* Instance Badges */}
				<div className="flex flex-wrap items-center gap-2">
					{relevantInstances.map((instance) => (
						<InstanceBadge key={instance.id} instance={instance} result={result} />
					))}
				</div>

				{/* Footer with Links and Action */}
				<div className="flex flex-wrap items-center justify-between gap-3 pt-3 border-t border-border/30">
					{/* External Links */}
					<div className="flex flex-wrap items-center gap-3 text-xs">
						{result.remoteIds?.tmdbId && (
							<a
								href={`https://www.themoviedb.org/${searchType === "movie" ? "movie" : "tv"}/${result.remoteIds.tmdbId}`}
								target="_blank"
								rel="noopener noreferrer"
								className="inline-flex items-center gap-1.5 text-muted-foreground transition-colors hover:text-foreground"
							>
								<span className="font-medium">TMDB</span>
								<ExternalLink className="h-3 w-3" />
							</a>
						)}
						{result.remoteIds?.tvdbId && (
							<a
								href={`https://www.thetvdb.com/dereferrer/series/${result.remoteIds.tvdbId}`}
								target="_blank"
								rel="noopener noreferrer"
								className="inline-flex items-center gap-1.5 text-muted-foreground transition-colors hover:text-foreground"
							>
								<span className="font-medium">TVDB</span>
								<ExternalLink className="h-3 w-3" />
							</a>
						)}
						{result.remoteIds?.imdbId && (
							<a
								href={`https://www.imdb.com/title/${result.remoteIds.imdbId}`}
								target="_blank"
								rel="noopener noreferrer"
								className="inline-flex items-center gap-1.5 text-muted-foreground transition-colors hover:text-foreground"
							>
								<span className="font-medium">IMDB</span>
								<ExternalLink className="h-3 w-3" />
							</a>
						)}
					</div>

					{/* Add Button */}
					<Button
						type="button"
						disabled={!canAdd}
						onClick={() => onAddClick(result)}
						className="gap-2 rounded-xl font-medium transition-all duration-200"
						style={
							canAdd
								? {
										background: `linear-gradient(135deg, ${themeGradient.from}, ${themeGradient.to})`,
										boxShadow: `0 4px 12px -4px ${themeGradient.glow}`,
									}
								: {
										backgroundColor: SEMANTIC_COLORS.success.bg,
										border: `1px solid ${SEMANTIC_COLORS.success.border}`,
										color: SEMANTIC_COLORS.success.text,
									}
						}
					>
						{canAdd ? (
							<>
								<PlusCircle className="h-4 w-4" />
								Add to library
							</>
						) : (
							<>
								<CheckCircle2 className="h-4 w-4" />
								Already added
							</>
						)}
					</Button>
				</div>
			</div>
		</div>
	);
};
