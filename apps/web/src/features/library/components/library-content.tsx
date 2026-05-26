"use client";

import type {
	LibraryEnrichmentItem,
	LibraryItem,
	SeriesProgressItem,
	ServiceInstanceSummary,
	WatchEnrichmentItem,
} from "@arr/shared";
import { Library as LibraryIcon } from "lucide-react";
import { useMemo } from "react";
import { PremiumEmptyState, PremiumSkeleton } from "../../../components/layout";
import { Pagination } from "../../../components/ui";
import { useLibrarySeedingSummary, useTrackerIcons } from "../../../hooks/api/useQui";
import { buildJellyfinUrl, buildPlexUrl } from "../lib/library-utils";

/**
 * Props for LibraryCard component (passthrough)
 */
interface LibraryCardProps {
	item: LibraryItem;
	onToggleMonitor: (item: LibraryItem) => void;
	pending: boolean;
	externalLink?: string | null;
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
	tmdbRating?: number | null;
	openIssueCount?: number;
	posterPath?: string | null;
	watchCount?: number;
	onDeck?: boolean;
	lastWatchedAt?: string | null;
	watchedByUsers?: string[];
	plexUserRating?: number | null;
	seriesProgress?: { watched: number; total: number; percent: number } | null;
	plexUrl?: string | null;
	/** Label for the media server link (e.g., "Plex", "Jellyfin", "Emby") */
	mediaServerLabel?: string;
	/** qui torrent state (seeding/ratio) for at-a-glance card pill */
	quiState?: { state: string; ratio: number } | null;
	/** Per-item tracker summary (count + top hostnames) from qui correlation */
	seedingSummary?: { trackerCount: number; topHosts: string[] } | null;
	/** qui's tracker-meta map (hostname → {iconUrl, name}) for brand icons */
	trackerIcons?: Record<string, { iconUrl?: string; name?: string }>;
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
	/** Seerr enrichment map keyed by "movie:{tmdbId}" or "tv:{tmdbId}" */
	enrichmentMap?: Record<string, LibraryEnrichmentItem> | null;
	/** Watch enrichment map keyed by "movie:{tmdbId}" or "series:{tmdbId}" (merged from Plex + Jellyfin/Emby) */
	watchEnrichmentMap?: Record<string, WatchEnrichmentItem> | null;
	/** Series progress map keyed by TMDB ID (merged from Plex + Jellyfin/Emby) */
	seriesProgressMap?: Record<number, SeriesProgressItem> | null;
	/** Map of Plex instanceId → machineId for building deep links */
	plexMachineIdMap?: Map<string, string>;
	/** Map of Jellyfin/Emby instanceId → server info for building deep links */
	jellyfinServerMap?: Map<
		string,
		{ baseUrl: string; service: "jellyfin" | "emby"; serverId: string }
	>;
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
	enrichmentMap,
	watchEnrichmentMap,
	seriesProgressMap,
	plexMachineIdMap,
	jellyfinServerMap,
}) => {
	/** Lookup enrichment for a library item by its tmdbId + type */
	const getEnrichment = (item: LibraryItem) => {
		if (!enrichmentMap || !item.remoteIds?.tmdbId) return undefined;
		const key = `${item.type === "movie" ? "movie" : "tv"}:${item.remoteIds.tmdbId}`;
		return enrichmentMap[key];
	};

	/** Lookup Plex watch enrichment for a library item */
	const getWatchEnrichment = (item: LibraryItem) => {
		if (!watchEnrichmentMap || !item.remoteIds?.tmdbId) return undefined;
		const key = `${item.type === "movie" ? "movie" : "series"}:${item.remoteIds.tmdbId}`;
		return watchEnrichmentMap[key];
	};

	/** Build a media server deep link URL for a library item (Plex or Jellyfin/Emby) */
	const getMediaServerUrl = (item: LibraryItem): string | null => {
		const watchData = getWatchEnrichment(item);
		if (!watchData?.instanceId) return null;
		// Try Plex
		if (watchData.ratingKey && plexMachineIdMap && plexMachineIdMap.size > 0) {
			const machineId = plexMachineIdMap.get(watchData.instanceId);
			if (machineId) return buildPlexUrl(machineId, watchData.ratingKey);
		}
		// Try Jellyfin/Emby
		if (watchData.jellyfinId && jellyfinServerMap && jellyfinServerMap.size > 0) {
			const jfServer = jellyfinServerMap.get(watchData.instanceId);
			if (jfServer)
				return buildJellyfinUrl(
					jfServer.baseUrl,
					watchData.jellyfinId,
					jfServer.service,
					jfServer.serverId,
				);
		}
		return null;
	};

	/** Get the media server label for a library item's watch source */
	const getMediaServerLabel = (item: LibraryItem): string | undefined => {
		const watchData = getWatchEnrichment(item);
		if (!watchData?.instanceId) return undefined;
		// Check Jellyfin/Emby first (distinguish by service type)
		if (jellyfinServerMap && jellyfinServerMap.has(watchData.instanceId)) {
			const jf = jellyfinServerMap.get(watchData.instanceId)!;
			return jf.service === "emby" ? "Emby" : "Jellyfin";
		}
		// Plex
		if (plexMachineIdMap && plexMachineIdMap.has(watchData.instanceId)) return "Plex";
		return undefined;
	};

	/** Lookup Plex series progress for a library item */
	const getSeriesProgress = (item: LibraryItem) => {
		if (!seriesProgressMap || item.type !== "series" || !item.remoteIds?.tmdbId) return undefined;
		return seriesProgressMap[item.remoteIds.tmdbId];
	};

	/**
	 * Derive qui torrent state for a library item from the item's own
	 * `torrentState`/`torrentRatio` fields (stamped by the server from
	 * `LibraryCache.torrentState`). Returns null when the row hasn't been
	 * correlated yet — caller skips the badge.
	 *
	 * No per-card polling: the same data is already in the page-level
	 * `/library` response, so this is a synchronous projection over the
	 * already-loaded item.
	 */
	const getQuiState = (item: LibraryItem) => {
		if (!item.torrentState || item.torrentRatio == null) return null;
		return { state: item.torrentState, ratio: item.torrentRatio };
	};

	const allItems = [...grouped.movies, ...grouped.series, ...grouped.artists, ...grouped.authors];

	// Per-card tracker strip data. The hook batches one request for the
	// entire visible page; the React Query key is stable on the sorted
	// item set so re-renders don't refire. Only movies and series have
	// inode-correlatable torrents (artists/authors skip).
	const seedingSummaryItems = useMemo(
		() =>
			allItems
				.filter(
					(item): item is LibraryItem & { instanceId: string; id: number } =>
						(item.type === "movie" || item.type === "series") &&
						typeof item.instanceId === "string" &&
						typeof item.id === "number",
				)
				.map((item) => ({
					arrInstanceId: item.instanceId,
					itemId: item.id,
					itemType: item.type as "movie" | "series",
				})),
		[allItems],
	);
	const seedingSummaryQuery = useLibrarySeedingSummary({ items: seedingSummaryItems });
	const trackerIconsQuery = useTrackerIcons();
	const summaries = seedingSummaryQuery.data?.summaries ?? {};
	const trackerIcons = trackerIconsQuery.data?.trackers;
	// Lookup helper that matches the backend's `arrInstanceId|type:id` key
	// shape. Returns null when the item isn't correlated (qui doesn't
	// know about its hashes, or it's an artist/author).
	const getSeedingSummary = (
		item: LibraryItem,
	): { trackerCount: number; topHosts: string[] } | null => {
		if (!item.instanceId || typeof item.id !== "number") return null;
		const key = `${item.instanceId}|${item.type}:${item.id}`;
		const s = summaries[key];
		if (!s || s.trackerCount === 0) return null;
		return { trackerCount: s.trackerCount, topHosts: s.topHosts };
	};
	const typesPresent = [grouped.movies, grouped.series, grouped.artists, grouped.authors].filter(
		(g) => g.length > 0,
	).length;
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
				<div className="grid gap-4 md:grid-cols-2">
					{allItems.map((item) => {
						const enrichment = getEnrichment(item);
						const watchData = getWatchEnrichment(item);
						return (
							<LibraryCard
								key={`${item.instanceId}:${item.id}`}
								item={item}
								onToggleMonitor={onToggleMonitor}
								pending={pendingKey === `${item.service}:${item.id}` && isMonitorPending}
								externalLink={buildLibraryExternalLink(item, serviceLookup[item.instanceId])}
								onSearchMovie={item.type === "movie" ? onSearchMovie : undefined}
								movieSearchPending={
									item.type === "movie"
										? pendingMovieSearch === `${item.instanceId}:${item.id}`
										: undefined
								}
								onSearchSeries={item.type === "series" ? onSearchSeries : undefined}
								seriesSearchPending={
									item.type === "series"
										? pendingSeriesSearch === `${item.instanceId}:${item.id}`
										: undefined
								}
								onViewAlbums={item.type === "artist" ? onViewAlbums : undefined}
								onSearchArtist={item.service === "lidarr" ? onSearchArtist : undefined}
								artistSearchPending={
									item.service === "lidarr"
										? pendingArtistSearch === `${item.instanceId}:${item.id}`
										: undefined
								}
								onViewBooks={item.type === "author" ? onViewBooks : undefined}
								onSearchAuthor={item.service === "readarr" ? onSearchAuthor : undefined}
								authorSearchPending={
									item.service === "readarr"
										? pendingAuthorSearch === `${item.instanceId}:${item.id}`
										: undefined
								}
								onExpandDetails={onExpandDetails}
								tmdbRating={enrichment?.voteAverage}
								openIssueCount={enrichment?.openIssueCount}
								posterPath={enrichment?.posterPath}
								watchCount={watchData?.watchCount}
								onDeck={watchData?.onDeck}
								lastWatchedAt={watchData?.lastWatchedAt}
								watchedByUsers={watchData?.watchedByUsers}
								plexUserRating={watchData?.userRating}
								seriesProgress={getSeriesProgress(item)}
								plexUrl={getMediaServerUrl(item)}
								mediaServerLabel={getMediaServerLabel(item)}
								quiState={getQuiState(item)}
								seedingSummary={getSeedingSummary(item)}
								trackerIcons={trackerIcons}
							/>
						);
					})}
				</div>
			) : (
				<>
					{grouped.movies.length > 0 ? (
						<section className="space-y-4">
							<div className="flex items-center justify-between">
								<h2 className="text-xl font-semibold text-foreground">Movies</h2>
							</div>
							<div className="grid gap-4 md:grid-cols-2">
								{grouped.movies.map((item) => {
									const enrichment = getEnrichment(item);
									const watchData = getWatchEnrichment(item);
									return (
										<LibraryCard
											key={`${item.instanceId}:${item.id}`}
											item={item}
											onToggleMonitor={onToggleMonitor}
											pending={pendingKey === `${item.service}:${item.id}` && isMonitorPending}
											externalLink={buildLibraryExternalLink(item, serviceLookup[item.instanceId])}
											onSearchMovie={onSearchMovie}
											movieSearchPending={pendingMovieSearch === `${item.instanceId}:${item.id}`}
											onExpandDetails={onExpandDetails}
											tmdbRating={enrichment?.voteAverage}
											openIssueCount={enrichment?.openIssueCount}
											posterPath={enrichment?.posterPath}
											watchCount={watchData?.watchCount}
											onDeck={watchData?.onDeck}
											lastWatchedAt={watchData?.lastWatchedAt}
											watchedByUsers={watchData?.watchedByUsers}
											plexUserRating={watchData?.userRating}
											seriesProgress={getSeriesProgress(item)}
											plexUrl={getMediaServerUrl(item)}
											mediaServerLabel={getMediaServerLabel(item)}
											quiState={getQuiState(item)}
											seedingSummary={getSeedingSummary(item)}
											trackerIcons={trackerIcons}
										/>
									);
								})}
							</div>
						</section>
					) : null}

					{grouped.series.length > 0 ? (
						<section className="space-y-4">
							<div className="flex items-center justify-between">
								<h2 className="text-xl font-semibold text-foreground">Series</h2>
							</div>
							<div className="grid gap-4 md:grid-cols-2">
								{grouped.series.map((item) => {
									const enrichment = getEnrichment(item);
									const watchData = getWatchEnrichment(item);
									return (
										<LibraryCard
											key={`${item.instanceId}:${item.id}`}
											item={item}
											onToggleMonitor={onToggleMonitor}
											pending={pendingKey === `${item.service}:${item.id}` && isMonitorPending}
											externalLink={buildLibraryExternalLink(item, serviceLookup[item.instanceId])}
											onSearchSeries={onSearchSeries}
											seriesSearchPending={pendingSeriesSearch === `${item.instanceId}:${item.id}`}
											onExpandDetails={onExpandDetails}
											tmdbRating={enrichment?.voteAverage}
											openIssueCount={enrichment?.openIssueCount}
											posterPath={enrichment?.posterPath}
											watchCount={watchData?.watchCount}
											onDeck={watchData?.onDeck}
											lastWatchedAt={watchData?.lastWatchedAt}
											watchedByUsers={watchData?.watchedByUsers}
											plexUserRating={watchData?.userRating}
											seriesProgress={getSeriesProgress(item)}
											plexUrl={getMediaServerUrl(item)}
											mediaServerLabel={getMediaServerLabel(item)}
											quiState={getQuiState(item)}
											seedingSummary={getSeedingSummary(item)}
											trackerIcons={trackerIcons}
										/>
									);
								})}
							</div>
						</section>
					) : null}

					{grouped.artists.length > 0 ? (
						<section className="space-y-4">
							<div className="flex items-center justify-between">
								<h2 className="text-xl font-semibold text-foreground">Artists</h2>
							</div>
							<div className="grid gap-4 md:grid-cols-2">
								{grouped.artists.map((item) => {
									const enrichment = getEnrichment(item);
									const watchData = getWatchEnrichment(item);
									return (
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
											tmdbRating={enrichment?.voteAverage}
											openIssueCount={enrichment?.openIssueCount}
											posterPath={enrichment?.posterPath}
											watchCount={watchData?.watchCount}
											onDeck={watchData?.onDeck}
											lastWatchedAt={watchData?.lastWatchedAt}
											watchedByUsers={watchData?.watchedByUsers}
											plexUserRating={watchData?.userRating}
											seriesProgress={getSeriesProgress(item)}
											plexUrl={getMediaServerUrl(item)}
											mediaServerLabel={getMediaServerLabel(item)}
											quiState={getQuiState(item)}
											seedingSummary={getSeedingSummary(item)}
											trackerIcons={trackerIcons}
										/>
									);
								})}
							</div>
						</section>
					) : null}

					{grouped.authors.length > 0 ? (
						<section className="space-y-4">
							<div className="flex items-center justify-between">
								<h2 className="text-xl font-semibold text-foreground">Authors</h2>
							</div>
							<div className="grid gap-4 md:grid-cols-2">
								{grouped.authors.map((item) => {
									const enrichment = getEnrichment(item);
									const watchData = getWatchEnrichment(item);
									return (
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
											tmdbRating={enrichment?.voteAverage}
											openIssueCount={enrichment?.openIssueCount}
											posterPath={enrichment?.posterPath}
											watchCount={watchData?.watchCount}
											onDeck={watchData?.onDeck}
											lastWatchedAt={watchData?.lastWatchedAt}
											watchedByUsers={watchData?.watchedByUsers}
											plexUserRating={watchData?.userRating}
											seriesProgress={getSeriesProgress(item)}
											plexUrl={getMediaServerUrl(item)}
											mediaServerLabel={getMediaServerLabel(item)}
											quiState={getQuiState(item)}
											seedingSummary={getSeedingSummary(item)}
											trackerIcons={trackerIcons}
										/>
									);
								})}
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
					description={
						error?.message ?? "An error occurred while loading your library. Please try again."
					}
				/>
			) : null}
		</>
	);
};
