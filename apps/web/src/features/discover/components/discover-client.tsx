"use client";

import { useMemo } from "react";
import type { ServiceInstanceSummary } from "@arr/shared";
import { Compass, Film, Tv, AlertCircle, Key, ExternalLink, X } from "lucide-react";
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
import { GlassmorphicCard } from "../../../components/layout";
import { SEMANTIC_COLORS } from "../../../lib/theme-gradients";
import { useThemeGradient } from "../../../hooks/useThemeGradient";

/**
 * Premium Discover Client
 *
 * Main discover page with:
 * - Glassmorphic search container
 * - Theme-aware styling throughout
 * - Premium carousel components
 * - Staggered animations
 */
export const DiscoverClient = () => {
	const { gradient: themeGradient } = useThemeGradient();

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
		<div className="space-y-10 overflow-x-hidden">
			{/* Premium Header */}
			<header className="space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-500">
				<div className="space-y-3">
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
						Search across your configured {searchType === "movie" ? "Radarr" : "Sonarr"} instances
						and add titles with smart defaults. Browse trending content powered by TMDB.
					</p>
				</div>

				{/* Feedback Alert */}
				{feedback && (
					<div
						className="flex items-center gap-3 rounded-xl px-4 py-3 text-sm animate-in fade-in slide-in-from-bottom-2"
						style={{
							backgroundColor: feedback.type === "success" ? SEMANTIC_COLORS.success.bg : SEMANTIC_COLORS.error.bg,
							border: `1px solid ${feedback.type === "success" ? SEMANTIC_COLORS.success.border : SEMANTIC_COLORS.error.border}`,
							color: feedback.type === "success" ? SEMANTIC_COLORS.success.text : SEMANTIC_COLORS.error.text,
						}}
					>
						{feedback.type === "success" ? (
							<div
								className="flex h-6 w-6 items-center justify-center rounded-full shrink-0"
								style={{ background: SEMANTIC_COLORS.success.from }}
							>
								<svg className="h-3.5 w-3.5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
									<path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
								</svg>
							</div>
						) : (
							<X className="h-5 w-5 shrink-0" />
						)}
						<span className="font-medium">{feedback.message}</span>
					</div>
				)}

				{/* Premium Search Container */}
				<GlassmorphicCard padding="lg" animationDelay={100}>
					<div className="space-y-6">
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
				</GlassmorphicCard>
			</header>

			{/* TMDB API Key Required Alert */}
			{!hasQuery && !hasTmdbApiKey && (
				<GlassmorphicCard
					padding="lg"
					className="animate-in fade-in slide-in-from-bottom-4 duration-500"
					style={{
						animationDelay: "200ms",
						background: `linear-gradient(135deg, ${SEMANTIC_COLORS.info.from}08, ${SEMANTIC_COLORS.info.to}08)`,
						border: `1px solid ${SEMANTIC_COLORS.info.border}`,
					}}
				>
					<div className="flex items-start gap-4">
						<div
							className="flex h-12 w-12 items-center justify-center rounded-xl shrink-0"
							style={{
								background: `linear-gradient(135deg, ${SEMANTIC_COLORS.info.from}20, ${SEMANTIC_COLORS.info.to}20)`,
								border: `1px solid ${SEMANTIC_COLORS.info.from}30`,
							}}
						>
							<Key className="h-6 w-6" style={{ color: SEMANTIC_COLORS.info.from }} />
						</div>
						<div className="space-y-2 flex-1">
							<h3 className="font-semibold text-foreground">TMDB API Read Access Token Required</h3>
							<p className="text-sm text-muted-foreground leading-relaxed">
								To browse trending, popular, and upcoming content, please add your TMDB API Read Access Token in{" "}
								<a
									href="/settings"
									className="font-medium underline underline-offset-2 hover:text-foreground transition-colors"
									style={{ color: SEMANTIC_COLORS.info.from }}
								>
									Settings → Account
								</a>
								. Get the <strong>API Read Access Token</strong> (not API Key) from{" "}
								<a
									href="https://www.themoviedb.org/settings/api"
									target="_blank"
									rel="noopener noreferrer"
									className="inline-flex items-center gap-1 font-medium underline underline-offset-2 hover:text-foreground transition-colors"
									style={{ color: SEMANTIC_COLORS.info.from }}
								>
									themoviedb.org/settings/api
									<ExternalLink className="h-3 w-3" />
								</a>
								. The token starts with &quot;eyJ...&quot;.
							</p>
						</div>
					</div>
				</GlassmorphicCard>
			)}

			{/* Recommendations Error Alert */}
			{!hasQuery && hasTmdbApiKey && recommendations.hasError && (
				<GlassmorphicCard
					padding="lg"
					className="animate-in fade-in slide-in-from-bottom-4 duration-500"
					style={{
						animationDelay: "200ms",
						background: `linear-gradient(135deg, ${SEMANTIC_COLORS.error.from}08, ${SEMANTIC_COLORS.error.to}08)`,
						border: `1px solid ${SEMANTIC_COLORS.error.border}`,
					}}
				>
					<div className="flex items-start gap-4">
						<div
							className="flex h-12 w-12 items-center justify-center rounded-xl shrink-0"
							style={{
								background: `linear-gradient(135deg, ${SEMANTIC_COLORS.error.from}20, ${SEMANTIC_COLORS.error.to}20)`,
								border: `1px solid ${SEMANTIC_COLORS.error.from}30`,
							}}
						>
							<AlertCircle className="h-6 w-6" style={{ color: SEMANTIC_COLORS.error.from }} />
						</div>
						<div className="space-y-2 flex-1">
							<h3 className="font-semibold text-foreground">Failed to load recommendations</h3>
							<p className="text-sm text-muted-foreground leading-relaxed">
								{recommendations.errorMessage ?? "Unable to fetch content from TMDB."}
								{" "}Make sure you&apos;re using the <strong>API Read Access Token</strong> (starts with &quot;eyJ...&quot;), not the shorter API Key.
								You can update it in{" "}
								<a
									href="/settings"
									className="font-medium underline underline-offset-2 hover:text-foreground transition-colors"
									style={{ color: SEMANTIC_COLORS.error.from }}
								>
									Settings → Account
								</a>.
							</p>
						</div>
					</div>
				</GlassmorphicCard>
			)}

			{/* TMDB Carousels */}
			{!hasQuery && hasTmdbApiKey && !recommendations.hasError && (
				<div className="space-y-8">
					<TMDBCarousel
						title="Trending Now"
						description={`Popular ${searchType === "movie" ? "movies" : "series"} trending this week`}
						icon={searchType === "movie" ? Film : Tv}
						items={recommendations.trending.items}
						mediaType={searchType}
						onSelectItem={handleSelectItem}
						isLoading={recommendations.trending.query.isLoading || recommendations.libraryIsLoading}
						isFetchingNextPage={recommendations.trending.query.isFetchingNextPage}
						hasNextPage={recommendations.trending.query.hasNextPage}
						onLoadMore={() => recommendations.trending.query.fetchNextPage()}
						animationDelay={0}
					/>

					<TMDBCarousel
						title="Popular Releases"
						description={`Most popular ${searchType === "movie" ? "movies" : "series"} right now`}
						icon={searchType === "movie" ? Film : Tv}
						items={recommendations.popular.items}
						mediaType={searchType}
						onSelectItem={handleSelectItem}
						isLoading={recommendations.popular.query.isLoading || recommendations.libraryIsLoading}
						isFetchingNextPage={recommendations.popular.query.isFetchingNextPage}
						hasNextPage={recommendations.popular.query.hasNextPage}
						onLoadMore={() => recommendations.popular.query.fetchNextPage()}
						animationDelay={100}
					/>

					<TMDBCarousel
						title="Top Rated"
						description={`Highest rated ${searchType === "movie" ? "movies" : "series"} of all time`}
						icon={searchType === "movie" ? Film : Tv}
						items={recommendations.topRated.items}
						mediaType={searchType}
						onSelectItem={handleSelectItem}
						isLoading={recommendations.topRated.query.isLoading || recommendations.libraryIsLoading}
						isFetchingNextPage={recommendations.topRated.query.isFetchingNextPage}
						hasNextPage={recommendations.topRated.query.hasNextPage}
						onLoadMore={() => recommendations.topRated.query.fetchNextPage()}
						animationDelay={200}
					/>

					<TMDBCarousel
						title={searchType === "movie" ? "Coming Soon" : "Airing Today"}
						description={
							searchType === "movie" ? "Upcoming movies to watch out for" : "TV shows airing today"
						}
						icon={searchType === "movie" ? Film : Tv}
						items={recommendations.upcoming.items}
						mediaType={searchType}
						onSelectItem={handleSelectItem}
						isLoading={recommendations.upcoming.query.isLoading || recommendations.libraryIsLoading}
						isFetchingNextPage={recommendations.upcoming.query.isFetchingNextPage}
						hasNextPage={recommendations.upcoming.query.hasNextPage}
						onLoadMore={() => recommendations.upcoming.query.fetchNextPage()}
						animationDelay={300}
					/>
				</div>
			)}

			{/* Search Results */}
			{hasQuery && (
				<SearchResults
					results={searchResults}
					searchType={searchType}
					relevantInstances={relevantInstances}
					isLoading={isLoading}
					onAddClick={handleSelectResult}
				/>
			)}

			{/* Add to Library Dialog */}
			<AddToLibraryDialog
				open={Boolean(selectedResult)}
				result={selectedResult}
				type={searchType}
				instances={relevantInstances}
				submitting={isSubmitting}
				onClose={handleCloseDialog}
				onSubmit={handleAdd}
			/>

			{/* Search Error Alert */}
			{isError && (
				<GlassmorphicCard
					padding="lg"
					className="animate-in fade-in slide-in-from-bottom-4 duration-500"
					style={{
						background: `linear-gradient(135deg, ${SEMANTIC_COLORS.error.from}08, ${SEMANTIC_COLORS.error.to}08)`,
						border: `1px solid ${SEMANTIC_COLORS.error.border}`,
					}}
				>
					<div className="flex items-start gap-4">
						<div
							className="flex h-12 w-12 items-center justify-center rounded-xl shrink-0"
							style={{
								background: `linear-gradient(135deg, ${SEMANTIC_COLORS.error.from}20, ${SEMANTIC_COLORS.error.to}20)`,
								border: `1px solid ${SEMANTIC_COLORS.error.from}30`,
							}}
						>
							<AlertCircle className="h-6 w-6" style={{ color: SEMANTIC_COLORS.error.from }} />
						</div>
						<div className="space-y-2 flex-1">
							<h3 className="font-semibold text-foreground">Search failed</h3>
							<p className="text-sm text-muted-foreground">
								{error?.message ?? "An error occurred while searching."}
							</p>
						</div>
					</div>
				</GlassmorphicCard>
			)}
		</div>
	);
};
