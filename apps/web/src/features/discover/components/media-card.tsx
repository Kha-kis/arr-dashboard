"use client";

import type { DiscoverSearchResult, DiscoverSearchType, ServiceInstanceSummary } from "@arr/shared";
import { PlusCircle } from "lucide-react";
import { Button, Card, CardContent } from "../../../components/ui";
import { formatRuntime } from "../lib/discover-utils";
import { InstanceBadge } from "./instance-badge";

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
}

/**
 * Card component displaying detailed information about a movie or series from search results.
 * Shows poster, title, metadata, overview, genres, instance states, and an add button.
 *
 * @component
 * @example
 * <MediaCard
 *   result={searchResult}
 *   searchType="movie"
 *   relevantInstances={radarrInstances}
 *   onAddClick={handleAdd}
 * />
 */
export const MediaCard: React.FC<MediaCardProps> = ({
	result,
	searchType,
	relevantInstances,
	onAddClick,
}) => {
	const availableTargets = relevantInstances.filter((instance) => {
		const state = result.instanceStates.find((entry) => entry.instanceId === instance.id);
		return !state?.exists;
	});
	const canAdd = availableTargets.length > 0;
	const runtimeLabel = formatRuntime(result.runtime);
	const genres = result.genres?.slice(0, 4) ?? [];
	const ratingValue = result.ratings?.value;

	return (
		<Card className="border-white/10 bg-white/5 p-5">
			<CardContent className="space-y-4">
				<div className="flex gap-4">
					<div className="relative h-36 w-24 overflow-hidden rounded-lg border border-white/10 bg-gradient-to-br from-slate-700 to-slate-900">
						{result.images?.poster ? (
							/* eslint-disable-next-line @next/next/no-img-element -- External TMDB image with dynamic URL */
							<img
								src={result.images.poster}
								alt={result.title ?? "Poster"}
								className="h-full w-full object-cover"
							/>
						) : (
							<div className="flex h-full w-full items-center justify-center text-sm text-white/40">
								{searchType === "movie" ? "Poster" : "Key art"}
							</div>
						)}
					</div>
					<div className="flex-1 space-y-3">
						<div className="flex flex-wrap items-start justify-between gap-2">
							<div>
								<h3 className="text-lg font-semibold text-white">{result.title}</h3>
								<p className="text-sm text-white/50">
									{result.year ? String(result.year) + " - " : ""}
									{result.status ?? "Unknown status"}
									{runtimeLabel ? " - " + runtimeLabel : ""}
								</p>
							</div>
							{typeof ratingValue === "number" && (
								<span className="inline-flex items-center gap-1 rounded-full border border-yellow-500/30 bg-yellow-500/10 px-3 py-1 text-xs text-yellow-200">
									Rating {ratingValue.toFixed(1)}
								</span>
							)}
						</div>
						{result.overview && (
							<p className="line-clamp-3 text-sm text-white/70">{result.overview}</p>
						)}
						{genres.length > 0 && (
							<div className="flex flex-wrap gap-2">
								{genres.map((genre) => (
									<span
										key={genre}
										className="rounded-full bg-white/10 px-2 py-0.5 text-xs text-white/60"
									>
										{genre}
									</span>
								))}
							</div>
						)}
					</div>
				</div>

				<div className="flex flex-wrap items-center gap-2">
					{relevantInstances.map((instance) => (
						<InstanceBadge key={instance.id} instance={instance} result={result} />
					))}
				</div>

				<div className="flex flex-wrap items-center justify-between gap-3 border-t border-white/10 pt-4">
					<div className="flex flex-wrap items-center gap-2 text-xs text-white/50">
						{result.remoteIds?.tmdbId && <span>TMDB #{result.remoteIds.tmdbId}</span>}
						{result.remoteIds?.tvdbId && <span>TVDB #{result.remoteIds.tvdbId}</span>}
						{result.remoteIds?.imdbId && <span>IMDB {result.remoteIds.imdbId}</span>}
					</div>
					<Button
						type="button"
						className="flex items-center gap-2"
						variant={canAdd ? "primary" : "secondary"}
						disabled={!canAdd}
						onClick={() => onAddClick(result)}
					>
						<PlusCircle className="h-4 w-4" />
						{canAdd ? "Add to library" : "Already added"}
					</Button>
				</div>
			</CardContent>
		</Card>
	);
};
