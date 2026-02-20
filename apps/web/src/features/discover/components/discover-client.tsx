"use client";

import { Suspense, lazy, useCallback, useMemo, useState } from "react";
import { Compass, Film, Tv, TrendingUp, Clock, Tag, EyeOff, Eye } from "lucide-react";
import { SEERR_MEDIA_STATUS, type SeerrDiscoverResult } from "@arr/shared";
import { useThemeGradient } from "../../../hooks/useThemeGradient";
import { useSeerrInstances } from "../../seerr/hooks/use-seerr-instances";
import { InstanceSelector } from "../../seerr/components/instance-selector";
import {
	useSeerrDiscoverMovies,
	useSeerrDiscoverTv,
	useSeerrDiscoverTrending,
	useSeerrDiscoverMoviesUpcoming,
	useSeerrDiscoverTvUpcoming,
	useSeerrSearch,
	useSeerrDiscoverByGenre,
} from "../../../hooks/api/useSeerr";
import { useDiscoverState } from "../hooks/use-discover-state";
import { DiscoverSearchBar } from "./discover-search-bar";
import { DiscoverMediaToggle } from "./discover-media-toggle";
import { DiscoverCarousel } from "./discover-carousel";
import { DiscoverSearchResults } from "./discover-search-results";
import { DiscoverEmptyState } from "./discover-empty-state";
import { DiscoverGenreFilter } from "./discover-genre-filter";

const DiscoverDetailModal = lazy(() =>
	import("./discover-detail-modal").then((m) => ({ default: m.DiscoverDetailModal })),
);
const DiscoverRequestDialog = lazy(() =>
	import("./discover-request-dialog").then((m) => ({ default: m.DiscoverRequestDialog })),
);

export const DiscoverClient = () => {
	const { gradient: themeGradient } = useThemeGradient();
	const { seerrInstances, defaultInstance, isLoading: isLoadingInstances } = useSeerrInstances();
	const [selectedInstanceId, setSelectedInstanceId] = useState<string | null>(null);
	const instanceId = selectedInstanceId ?? defaultInstance?.id ?? "";

	const {
		mediaType,
		searchInput,
		debouncedQuery,
		selectedItem,
		requestItem,
		selectedGenreId,
		hideAvailable,
		setSearchInput,
		setMediaType,
		setSelectedGenreId,
		setHideAvailable,
		clearSearch,
		selectItem,
		closeDetail,
		openRequest,
		closeRequest,
	} = useDiscoverState();

	const isSearching = debouncedQuery.length > 0;
	const isBrowsingGenre = selectedGenreId !== null && !isSearching;

	// Discover queries (only active when not searching and no genre selected)
	const enableCarousels = !isSearching && !isBrowsingGenre;
	const trendingQuery = useSeerrDiscoverTrending(enableCarousels ? instanceId : "");
	const moviesQuery = useSeerrDiscoverMovies(
		enableCarousels && mediaType === "movie" ? instanceId : "",
	);
	const tvQuery = useSeerrDiscoverTv(enableCarousels && mediaType === "tv" ? instanceId : "");
	const moviesUpcomingQuery = useSeerrDiscoverMoviesUpcoming(
		enableCarousels && mediaType === "movie" ? instanceId : "",
	);
	const tvUpcomingQuery = useSeerrDiscoverTvUpcoming(
		enableCarousels && mediaType === "tv" ? instanceId : "",
	);

	// Genre query (only active when genre is selected)
	const genreQuery = useSeerrDiscoverByGenre(
		isBrowsingGenre ? instanceId : "",
		mediaType,
		selectedGenreId ?? 0,
	);

	// Search query
	const searchQuery = useSeerrSearch(instanceId, debouncedQuery);

	// Filter helper: remove available media from browse views (not search)
	const filterAvailable = useCallback(
		(items: SeerrDiscoverResult[]) =>
			hideAvailable
				? items.filter((i) => i.mediaInfo?.status !== SEERR_MEDIA_STATUS.AVAILABLE)
				: items,
		[hideAvailable],
	);

	// Flatten infinite query pages (filter trending by selected media type)
	const trendingItems = useMemo(
		() =>
			filterAvailable(
				(trendingQuery.data?.pages.flatMap((p) => p.results) ?? []).filter(
					(i) => i.mediaType === mediaType,
				),
			),
		[trendingQuery.data, mediaType, filterAvailable],
	);
	const popularItems = useMemo(
		() =>
			filterAvailable(
				mediaType === "movie"
					? (moviesQuery.data?.pages.flatMap((p) => p.results) ?? [])
					: (tvQuery.data?.pages.flatMap((p) => p.results) ?? []),
			),
		[mediaType, moviesQuery.data, tvQuery.data, filterAvailable],
	);
	const upcomingItems = useMemo(
		() =>
			filterAvailable(
				mediaType === "movie"
					? (moviesUpcomingQuery.data?.pages.flatMap((p) => p.results) ?? [])
					: (tvUpcomingQuery.data?.pages.flatMap((p) => p.results) ?? []),
			),
		[mediaType, moviesUpcomingQuery.data, tvUpcomingQuery.data, filterAvailable],
	);
	const genreItems = useMemo(
		() => filterAvailable(genreQuery.data?.pages.flatMap((p) => p.results) ?? []),
		[genreQuery.data, filterAvailable],
	);

	// No instance configured
	if (!isLoadingInstances && seerrInstances.length === 0) {
		return (
			<div className="space-y-8">
				<PageHeader themeGradient={themeGradient} />
				<DiscoverEmptyState />
			</div>
		);
	}

	const popularQuery = mediaType === "movie" ? moviesQuery : tvQuery;
	const upcomingQuery = mediaType === "movie" ? moviesUpcomingQuery : tvUpcomingQuery;

	return (
		<div className="space-y-8 overflow-x-hidden">
			{/* Page header */}
			<PageHeader themeGradient={themeGradient} />

			{/* Search bar + controls */}
			<div className="space-y-4 animate-in fade-in slide-in-from-bottom-4 duration-500" style={{ animationDelay: "100ms", animationFillMode: "backwards" }}>
				<div className="flex flex-col sm:flex-row sm:items-center gap-4">
					<div className="flex-1">
						<DiscoverSearchBar
							value={searchInput}
							onChange={setSearchInput}
							onClear={clearSearch}
						/>
					</div>
					<div className="flex items-center gap-3">
						{seerrInstances.length > 1 && (
							<InstanceSelector
								instances={seerrInstances}
								selectedId={instanceId}
								onSelect={setSelectedInstanceId}
							/>
						)}
						<DiscoverMediaToggle value={mediaType} onChange={setMediaType} />
						<button
							type="button"
							onClick={() => setHideAvailable(!hideAvailable)}
							className={`flex items-center gap-2 rounded-xl border px-3 py-2 text-sm font-medium transition-all duration-200 ${!hideAvailable ? "border-border/50 bg-card/40 backdrop-blur-sm" : ""}`}
							style={
								hideAvailable
									? {
											background: `linear-gradient(135deg, ${themeGradient.from}20, ${themeGradient.to}20)`,
											borderColor: `${themeGradient.from}30`,
											color: themeGradient.from,
										}
									: {
											color: "var(--muted-foreground)",
										}
							}
							title={hideAvailable ? "Showing only unavailable media" : "Hide available media from browse"}
						>
							{hideAvailable ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
							<span className="hidden sm:inline">{hideAvailable ? "Hidden" : "Hide Available"}</span>
						</button>
					</div>
				</div>

				{/* Genre filter pills */}
				{!isSearching && (
					<DiscoverGenreFilter
						instanceId={instanceId}
						mediaType={mediaType}
						selectedGenreId={selectedGenreId}
						onSelectGenre={setSelectedGenreId}
					/>
				)}
			</div>

			{/* Search mode */}
			{isSearching ? (
				<DiscoverSearchResults
					data={searchQuery.data}
					isLoading={searchQuery.isLoading}
					onSelectItem={selectItem}
					query={debouncedQuery}
				/>
			) : isBrowsingGenre ? (
				/* Genre browsing mode */
				<DiscoverCarousel
					title={`${mediaType === "movie" ? "Movies" : "TV Shows"}`}
					icon={Tag}
					items={genreItems}
					onSelectItem={selectItem}
					isLoading={genreQuery.isLoading}
					isError={genreQuery.isError}
					isFetchingNextPage={genreQuery.isFetchingNextPage}
					hasNextPage={genreQuery.hasNextPage}
					onLoadMore={() => genreQuery.fetchNextPage()}
					animationDelay={0}
				/>
			) : (
				<>
					{/* Standard carousels */}
					<div className="space-y-8">
						<DiscoverCarousel
							title={mediaType === "movie" ? "Trending Movies" : "Trending TV Shows"}
							description={`Trending ${mediaType === "movie" ? "movies" : "TV shows"} this week`}
							icon={TrendingUp}
							items={trendingItems}
							onSelectItem={selectItem}
							isLoading={trendingQuery.isLoading}
							isError={trendingQuery.isError}
							isFetchingNextPage={trendingQuery.isFetchingNextPage}
							hasNextPage={trendingQuery.hasNextPage}
							onLoadMore={() => trendingQuery.fetchNextPage()}
							animationDelay={0}
						/>

						<DiscoverCarousel
							title={mediaType === "movie" ? "Popular Movies" : "Popular TV Shows"}
							description={`Most popular ${mediaType === "movie" ? "movies" : "TV shows"} right now`}
							icon={mediaType === "movie" ? Film : Tv}
							items={popularItems}
							onSelectItem={selectItem}
							isLoading={popularQuery.isLoading}
							isError={popularQuery.isError}
							isFetchingNextPage={popularQuery.isFetchingNextPage}
							hasNextPage={popularQuery.hasNextPage}
							onLoadMore={() => popularQuery.fetchNextPage()}
							animationDelay={100}
						/>

						<DiscoverCarousel
							title={mediaType === "movie" ? "Coming Soon" : "Upcoming TV"}
							description={
								mediaType === "movie"
									? "Upcoming movies to watch out for"
									: "TV shows coming soon"
							}
							icon={Clock}
							items={upcomingItems}
							onSelectItem={selectItem}
							isLoading={upcomingQuery.isLoading}
							isError={upcomingQuery.isError}
							isFetchingNextPage={upcomingQuery.isFetchingNextPage}
							hasNextPage={upcomingQuery.hasNextPage}
							onLoadMore={() => upcomingQuery.fetchNextPage()}
							animationDelay={200}
						/>
					</div>
				</>
			)}

			{/* Detail modal (lazy) */}
			{selectedItem && (
				<Suspense>
					<DiscoverDetailModal
						item={selectedItem}
						instanceId={instanceId}
						onClose={closeDetail}
						onRequest={openRequest}
						onSelectItem={selectItem}
					/>
				</Suspense>
			)}

			{/* Request dialog (lazy) */}
			{requestItem && (
				<Suspense>
					<DiscoverRequestDialog
						item={requestItem}
						instanceId={instanceId}
						onClose={closeRequest}
					/>
				</Suspense>
			)}
		</div>
	);
};

// ============================================================================
// Page Header
// ============================================================================

interface PageHeaderProps {
	themeGradient: { from: string; to: string };
}

const PageHeader: React.FC<PageHeaderProps> = ({ themeGradient }) => (
	<header className="space-y-3 animate-in fade-in slide-in-from-bottom-4 duration-500">
		<div className="flex items-center gap-3">
			<div
				className="flex h-12 w-12 items-center justify-center rounded-2xl shrink-0"
				style={{
					background: `linear-gradient(135deg, ${themeGradient.from}20, ${themeGradient.to}20)`,
					border: `1px solid ${themeGradient.from}30`,
				}}
			>
				<Compass className="h-6 w-6" style={{ color: themeGradient.from }} />
			</div>
			<div>
				<p className="text-xs uppercase tracking-[0.3em] text-muted-foreground font-medium">
					Discover
				</p>
				<h1
					className="text-2xl font-bold"
					style={{
						background: `linear-gradient(135deg, ${themeGradient.from}, ${themeGradient.to})`,
						WebkitBackgroundClip: "text",
						WebkitTextFillColor: "transparent",
					}}
				>
					Find New Content
				</h1>
			</div>
		</div>
		<p className="text-sm text-muted-foreground max-w-2xl">
			Browse trending movies and TV shows, see what&apos;s available in your library, and submit
			requests through Seerr.
		</p>
	</header>
);
