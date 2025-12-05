"use client";

import { useMemo } from "react";
import type { ServiceInstanceSummary } from "@arr/shared";
import { Alert, AlertDescription, AlertTitle } from "../../../components/ui";
import { useCurrentUser } from "../../../hooks/api/useAuth";
import { useServicesQuery } from "../../../hooks/api/useServicesQuery";
import { useDiscoverActions } from "../hooks/useDiscoverActions";
import { useDiscoverRecommendations } from "../hooks/useDiscoverRecommendations";
import { useDiscoverSearch } from "../hooks/useDiscoverSearch";
import { AddToLibraryDialog } from "./add-to-library-dialog";
import { MediaTypeToggle } from "./media-type-toggle";
import { SearchForm } from "./search-form";
import { SearchResults } from "./search-results";
import { TMDBCarousel } from "./tmdb-carousel";

/**
 * Main discover client component for searching and adding movies/series.
 * Orchestrates the discover flow including:
 * - Media type selection (movies vs series)
 * - Search functionality
 * - TMDB recommendations (trending, popular, top rated, upcoming)
 * - Adding titles to library instances
 *
 * Refactored to use business logic hooks for better separation of concerns.
 *
 * @component
 */
export const DiscoverClient = () => {
	const { data: currentUser } = useCurrentUser();
	const { data: services = [] } = useServicesQuery();
	const hasTmdbApiKey = currentUser?.hasTmdbApiKey ?? false;

	// Search functionality
	const {
		searchType,
		setSearchType,
		searchInput,
		setSearchInput,
		handleSubmit,
		searchResults,
		isLoading,
		hasQuery,
		isError,
		error,
	} = useDiscoverSearch();

	// Filter relevant service instances
	const relevantInstances = useMemo(
		() =>
			services.filter(
				(service: ServiceInstanceSummary) =>
					service.enabled &&
					(searchType === "movie" ? service.service === "radarr" : service.service === "sonarr"),
			),
		[services, searchType],
	);

	const canSearch = relevantInstances.length > 0;

	// TMDB recommendations (only when not searching and TMDB API key is configured)
	const recommendations = useDiscoverRecommendations(searchType, !hasQuery && canSearch && hasTmdbApiKey);

	// Action handlers (selection, add, feedback)
	const {
		selectedResult,
		feedback,
		isSubmitting,
		handleSelectItem,
		handleSelectResult,
		handleAdd,
		handleCloseDialog,
	} = useDiscoverActions(searchType, relevantInstances);

	return (
		<div className="space-y-12">
			<header className="space-y-8">
				<div className="space-y-2">
					<p className="text-xs uppercase tracking-[0.4em] text-fg-muted">Discover</p>
					<h1 className="text-3xl font-semibold text-fg">
						Find new content for your *arr stack
					</h1>
					<p className="text-sm text-fg-muted">
						Search across your configured {searchType === "movie" ? "Radarr" : "Sonarr"} instances
						and add titles with smart defaults.
					</p>
				</div>

				{feedback && (
					<Alert variant={feedback.type === "success" ? "success" : "danger"}>
						<AlertDescription>{feedback.message}</AlertDescription>
					</Alert>
				)}

				<div className="flex flex-col gap-6 rounded-2xl border border-border bg-bg-subtle p-6 backdrop-blur">
					<MediaTypeToggle
						searchType={searchType}
						onTypeChange={setSearchType}
						instanceCount={relevantInstances.length}
					/>

					<SearchForm
						searchInput={searchInput}
						onSearchInputChange={setSearchInput}
						onSubmit={handleSubmit}
						searchType={searchType}
						isLoading={isLoading}
						canSearch={canSearch}
					/>
				</div>
			</header>

			{!hasQuery && !hasTmdbApiKey && (
				<Alert variant="info">
					<AlertTitle>TMDB API Key Required</AlertTitle>
					<AlertDescription>
						To browse trending, popular, and upcoming content, please add your TMDB API key in{" "}
						<a href="/settings" className="underline hover:text-fg">
							Settings → Account
						</a>
						. You can get a free API key from{" "}
						<a
							href="https://www.themoviedb.org/settings/api"
							target="_blank"
							rel="noopener noreferrer"
							className="underline hover:text-fg"
						>
							themoviedb.org
						</a>
						.
					</AlertDescription>
				</Alert>
			)}

			{!hasQuery && hasTmdbApiKey && (
				<TMDBCarousel
					title="Trending Now"
					description={`Popular ${searchType === "movie" ? "movies" : "series"} trending this week`}
					items={recommendations.trending.items}
					onSelectItem={handleSelectItem}
					isLoading={recommendations.trending.query.isLoading}
					isFetchingNextPage={recommendations.trending.query.isFetchingNextPage}
					hasNextPage={recommendations.trending.query.hasNextPage}
					onLoadMore={() => recommendations.trending.query.fetchNextPage()}
				/>
			)}

			{!hasQuery && hasTmdbApiKey && (
				<TMDBCarousel
					title="Popular Releases"
					description={`Most popular ${searchType === "movie" ? "movies" : "series"} right now`}
					items={recommendations.popular.items}
					onSelectItem={handleSelectItem}
					isLoading={recommendations.popular.query.isLoading}
					isFetchingNextPage={recommendations.popular.query.isFetchingNextPage}
					hasNextPage={recommendations.popular.query.hasNextPage}
					onLoadMore={() => recommendations.popular.query.fetchNextPage()}
				/>
			)}

			{!hasQuery && hasTmdbApiKey && (
				<TMDBCarousel
					title="Top Rated"
					description={`Highest rated ${searchType === "movie" ? "movies" : "series"} of all time`}
					items={recommendations.topRated.items}
					onSelectItem={handleSelectItem}
					isLoading={recommendations.topRated.query.isLoading}
					isFetchingNextPage={recommendations.topRated.query.isFetchingNextPage}
					hasNextPage={recommendations.topRated.query.hasNextPage}
					onLoadMore={() => recommendations.topRated.query.fetchNextPage()}
				/>
			)}

			{!hasQuery && hasTmdbApiKey && (
				<TMDBCarousel
					title={searchType === "movie" ? "Coming Soon" : "Airing Today"}
					description={
						searchType === "movie" ? "Upcoming movies to watch out for" : "TV shows airing today"
					}
					items={recommendations.upcoming.items}
					onSelectItem={handleSelectItem}
					isLoading={recommendations.upcoming.query.isLoading}
					isFetchingNextPage={recommendations.upcoming.query.isFetchingNextPage}
					hasNextPage={recommendations.upcoming.query.hasNextPage}
					onLoadMore={() => recommendations.upcoming.query.fetchNextPage()}
				/>
			)}

			{hasQuery && (
				<SearchResults
					results={searchResults}
					searchType={searchType}
					relevantInstances={relevantInstances}
					isLoading={isLoading}
					onAddClick={handleSelectResult}
				/>
			)}

			<AddToLibraryDialog
				open={Boolean(selectedResult)}
				result={selectedResult}
				type={searchType}
				instances={relevantInstances}
				submitting={isSubmitting}
				onClose={handleCloseDialog}
				onSubmit={handleAdd}
			/>

			{isError && (
				<Alert variant="danger">
					<AlertTitle>Search failed</AlertTitle>
					<AlertDescription>
						{error?.message ?? "An error occurred while searching."}
					</AlertDescription>
				</Alert>
			)}
		</div>
	);
};
