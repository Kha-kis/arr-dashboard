"use client";

import type { LibraryItem, ServiceInstanceSummary } from "@arr/shared";
import { Library as LibraryIcon } from "lucide-react";
import { Pagination } from "../../../components/ui";
import { PremiumEmptyState, PremiumSkeleton } from "../../../components/layout";

/**
 * Props for LibraryCard component (passthrough)
 */
interface LibraryCardProps {
	item: LibraryItem;
	onToggleMonitor: (item: LibraryItem) => void;
	pending: boolean;
	externalLink?: string | null;
	onViewSeasons?: (item: LibraryItem) => void;
	onSearchMovie?: (item: LibraryItem) => void;
	movieSearchPending?: boolean;
	onSearchSeries?: (item: LibraryItem) => void;
	seriesSearchPending?: boolean;
	onViewAlbums?: (item: LibraryItem) => void;
	onSearchArtist?: (item: LibraryItem) => void;
	artistSearchPending?: boolean;
	onViewBooks?: (item: LibraryItem) => void;
	onSearchAuthor?: (item: LibraryItem) => void;
	authorSearchPending?: boolean;
	onExpandDetails?: (item: LibraryItem) => void;
}

/**
 * Props for the LibraryContent component
 */
interface LibraryContentProps {
	/** Loading state */
	isLoading: boolean;
	/** Error state */
	isError: boolean;
	/** Error object */
	error?: Error | null;
	/** Grouped library items (paginated) */
	grouped: {
		movies: LibraryItem[];
		series: LibraryItem[];
		artists: LibraryItem[];
		authors: LibraryItem[];
	};
	/** Total items count */
	totalItems: number;
	/** Current page */
	page: number;
	/** Page size */
	pageSize: number;
	/** Page change handler */
	onPageChange: (page: number) => void;
	/** Page size change handler */
	onPageSizeChange: (size: number) => void;
	/** Handler for toggling monitoring */
	onToggleMonitor: (item: LibraryItem) => void;
	/** Pending key for monitor mutation */
	pendingKey: string | null;
	/** Whether monitor mutation is pending */
	isMonitorPending: boolean;
	/** Service lookup for building external links */
	serviceLookup: Record<string, ServiceInstanceSummary>;
	/** Handler for viewing seasons */
	onViewSeasons: (item: LibraryItem) => void;
	/** Handler for searching a movie */
	onSearchMovie: (item: LibraryItem) => void;
	/** Pending movie search key */
	pendingMovieSearch: string | null;
	/** Handler for searching a series */
	onSearchSeries: (item: LibraryItem) => void;
	/** Pending series search key */
	pendingSeriesSearch: string | null;
	/** Handler for viewing albums */
	onViewAlbums: (item: LibraryItem) => void;
	/** Handler for searching an artist */
	onSearchArtist: (item: LibraryItem) => void;
	/** Pending artist search key */
	pendingArtistSearch: string | null;
	/** Handler for viewing books */
	onViewBooks: (item: LibraryItem) => void;
	/** Handler for searching an author */
	onSearchAuthor: (item: LibraryItem) => void;
	/** Pending author search key */
	pendingAuthorSearch: string | null;
	/** Handler for expanding details */
	onExpandDetails: (item: LibraryItem) => void;
	/** Function to build external link */
	buildLibraryExternalLink: (item: LibraryItem, instance?: ServiceInstanceSummary) => string | null;
	/** LibraryCard component to render */
	LibraryCard: React.ComponentType<LibraryCardProps>;
	/** Whether the library cache is currently syncing */
	isSyncing?: boolean;
}

/**
 * Content area for the library page
 *
 * Displays the library items with appropriate states:
 * - Loading state with premium skeleton components
 * - Empty state when no items match filters
 * - Movies section (if movies exist)
 * - Series section (if series exist)
 * - Error state with premium empty state component
 */
export const LibraryContent: React.FC<LibraryContentProps> = ({
	isLoading,
	isError,
	error,
	grouped,
	totalItems,
	page,
	pageSize,
	onPageChange,
	onPageSizeChange,
	onToggleMonitor,
	pendingKey,
	isMonitorPending,
	serviceLookup,
	onViewSeasons,
	onSearchMovie,
	pendingMovieSearch,
	onSearchSeries,
	pendingSeriesSearch,
	onViewAlbums,
	onSearchArtist,
	pendingArtistSearch,
	onViewBooks,
	onSearchAuthor,
	pendingAuthorSearch,
	onExpandDetails,
	buildLibraryExternalLink,
	LibraryCard,
	isSyncing,
}) => {

	const allItems = [...grouped.movies, ...grouped.series, ...grouped.artists, ...grouped.authors];
	const typesPresent = [grouped.movies, grouped.series, grouped.artists, grouped.authors].filter(g => g.length > 0).length;
	const hasMixedTypes = typesPresent > 1;

	return (
		<>
			{isLoading ? (
				<div className="space-y-4">
					<PremiumSkeleton variant="card" />
					<PremiumSkeleton variant="card" />
					<PremiumSkeleton variant="card" />
				</div>
			) : null}

			{!isLoading && totalItems === 0 ? (
				<PremiumEmptyState
					icon={LibraryIcon}
					title={isSyncing ? "Building your library cache..." : "No items found"}
					description={
						isSyncing
							? "Your library is being synchronized from your *arr instances. This may take a moment for large libraries."
							: "Adjust your filters or add content from the Discover tab to populate your library."
					}
				/>
			) : null}

			{totalItems > 0 && (
				<Pagination
					currentPage={page}
					totalItems={totalItems}
					pageSize={pageSize}
					onPageChange={onPageChange}
					onPageSizeChange={onPageSizeChange}
					pageSizeOptions={[25, 50, 100]}
				/>
			)}

			{hasMixedTypes ? (
				<div className="grid gap-4 lg:grid-cols-2">
					{allItems.map((item) => (
						<LibraryCard
							key={`${item.instanceId}:${item.id}`}
							item={item}
							onToggleMonitor={onToggleMonitor}
							pending={pendingKey === `${item.service}:${item.id}` && isMonitorPending}
							externalLink={buildLibraryExternalLink(item, serviceLookup[item.instanceId])}
							onViewSeasons={item.type === "series" ? onViewSeasons : undefined}
							onSearchMovie={item.type === "movie" ? onSearchMovie : undefined}
							movieSearchPending={item.type === "movie" ? pendingMovieSearch === `${item.instanceId}:${item.id}` : undefined}
							onSearchSeries={item.type === "series" ? onSearchSeries : undefined}
							seriesSearchPending={item.type === "series" ? pendingSeriesSearch === `${item.instanceId}:${item.id}` : undefined}
							onViewAlbums={item.type === "artist" ? onViewAlbums : undefined}
							onSearchArtist={item.service === "lidarr" ? onSearchArtist : undefined}
							artistSearchPending={item.service === "lidarr" ? pendingArtistSearch === `${item.instanceId}:${item.id}` : undefined}
							onViewBooks={item.type === "author" ? onViewBooks : undefined}
							onSearchAuthor={item.service === "readarr" ? onSearchAuthor : undefined}
							authorSearchPending={item.service === "readarr" ? pendingAuthorSearch === `${item.instanceId}:${item.id}` : undefined}
							onExpandDetails={onExpandDetails}
						/>
					))}
				</div>
			) : (
				<>
					{grouped.movies.length > 0 ? (
						<section className="space-y-4">
							<div className="flex items-center justify-between">
								<h2 className="text-xl font-semibold text-foreground">Movies</h2>
							</div>
							<div className="grid gap-4 lg:grid-cols-2">
								{grouped.movies.map((item) => (
									<LibraryCard
										key={`${item.instanceId}:${item.id}`}
										item={item}
										onToggleMonitor={onToggleMonitor}
										pending={pendingKey === `${item.service}:${item.id}` && isMonitorPending}
										externalLink={buildLibraryExternalLink(item, serviceLookup[item.instanceId])}
										onSearchMovie={onSearchMovie}
										movieSearchPending={pendingMovieSearch === `${item.instanceId}:${item.id}`}
										onExpandDetails={onExpandDetails}
									/>
								))}
							</div>
						</section>
					) : null}

					{grouped.series.length > 0 ? (
						<section className="space-y-4">
							<div className="flex items-center justify-between">
								<h2 className="text-xl font-semibold text-foreground">Series</h2>
							</div>
							<div className="grid gap-4 lg:grid-cols-2">
								{grouped.series.map((item) => (
									<LibraryCard
										key={`${item.instanceId}:${item.id}`}
										item={item}
										onToggleMonitor={onToggleMonitor}
										pending={pendingKey === `${item.service}:${item.id}` && isMonitorPending}
										externalLink={buildLibraryExternalLink(item, serviceLookup[item.instanceId])}
										onViewSeasons={onViewSeasons}
										onSearchSeries={onSearchSeries}
										seriesSearchPending={pendingSeriesSearch === `${item.instanceId}:${item.id}`}
										onExpandDetails={onExpandDetails}
									/>
								))}
							</div>
						</section>
					) : null}

					{grouped.artists.length > 0 ? (
						<section className="space-y-4">
							<div className="flex items-center justify-between">
								<h2 className="text-xl font-semibold text-foreground">Artists</h2>
							</div>
							<div className="grid gap-4 lg:grid-cols-2">
								{grouped.artists.map((item) => (
									<LibraryCard
										key={`${item.instanceId}:${item.id}`}
										item={item}
										onToggleMonitor={onToggleMonitor}
										pending={pendingKey === `${item.service}:${item.id}` && isMonitorPending}
										externalLink={buildLibraryExternalLink(item, serviceLookup[item.instanceId])}
										onViewAlbums={onViewAlbums}
										onSearchArtist={onSearchArtist}
										artistSearchPending={pendingArtistSearch === `${item.instanceId}:${item.id}`}
										onExpandDetails={onExpandDetails}
									/>
								))}
							</div>
						</section>
					) : null}

					{grouped.authors.length > 0 ? (
						<section className="space-y-4">
							<div className="flex items-center justify-between">
								<h2 className="text-xl font-semibold text-foreground">Authors</h2>
							</div>
							<div className="grid gap-4 lg:grid-cols-2">
								{grouped.authors.map((item) => (
									<LibraryCard
										key={`${item.instanceId}:${item.id}`}
										item={item}
										onToggleMonitor={onToggleMonitor}
										pending={pendingKey === `${item.service}:${item.id}` && isMonitorPending}
										externalLink={buildLibraryExternalLink(item, serviceLookup[item.instanceId])}
										onViewBooks={onViewBooks}
										onSearchAuthor={onSearchAuthor}
										authorSearchPending={pendingAuthorSearch === `${item.instanceId}:${item.id}`}
										onExpandDetails={onExpandDetails}
									/>
								))}
							</div>
						</section>
					) : null}
				</>
			)}

			{totalItems > 0 && (
				<Pagination
					currentPage={page}
					totalItems={totalItems}
					pageSize={pageSize}
					onPageChange={onPageChange}
					onPageSizeChange={onPageSizeChange}
					pageSizeOptions={[25, 50, 100]}
				/>
			)}

			{isError ? (
				<PremiumEmptyState
					icon={LibraryIcon}
					title="Failed to load library"
					description={error?.message ?? "An error occurred while loading your library. Please try again."}
				/>
			) : null}
		</>
	);
};
