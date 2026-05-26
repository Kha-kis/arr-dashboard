"use client";

import type { LibraryItem } from "@arr/shared";
import { useSearchParams } from "next/navigation";
import React, { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "../../../components/ui";
import {
	useJellyfinIdentity,
	useJellyfinSeriesProgress,
	useJellyfinWatchEnrichment,
} from "../../../hooks/api/useJellyfin";
import { useLibraryMonitorMutation } from "../../../hooks/api/useLibrary";
import { usePlexIdentity, useSeriesProgress, useWatchEnrichment } from "../../../hooks/api/usePlex";
import { useLibraryEnrichment } from "../../../hooks/api/useSeerr";
import { fetchLibraryItemByTmdbId } from "../../../lib/api-client/library";
import { useSeerrInstances } from "../../seerr/hooks/use-seerr-instances";
import { useLibraryActions, useLibraryData, useLibraryFilters } from "../hooks";
import { buildJellyfinUrl, buildLibraryExternalLink, buildPlexUrl } from "../lib/library-utils";
import { AlbumBreakdownModal } from "./album-breakdown-modal";
import { BookBreakdownModal } from "./book-breakdown-modal";
import { ItemDetailsModal } from "./item-details-modal";
import { LibraryCard } from "./library-card";
import { LibraryContent } from "./library-content";
import { LibraryHeader } from "./library-header";
import { LibraryInsightsSection } from "./library-insights-section";

const EnrichedDetailModal = React.lazy(() =>
	import("./enriched-detail-modal").then((m) => ({ default: m.EnrichedDetailModal })),
);

/**
 * Main library client component
 *
 * This component orchestrates the library view by:
 * - Managing filter state via useLibraryFilters
 * - Fetching paginated data via useLibraryData (server-side pagination)
 * - Handling actions via useLibraryActions
 * - Managing modal state for item details and season breakdowns
 * - Coordinating between LibraryHeader and LibraryContent
 *
 * The component delegates most logic to custom hooks and child components.
 */
export const LibraryClient: React.FC = () => {
	// Modal state
	const [itemDetail, setItemDetail] = useState<LibraryItem | null>(null);
	const [albumDetail, setAlbumDetail] = useState<LibraryItem | null>(null);
	const [bookDetail, setBookDetail] = useState<LibraryItem | null>(null);

	// Deep link: auto-open detail modal when ?tmdbId= is in the URL
	const searchParams = useSearchParams();
	const deepLinkTmdbId = searchParams.get("tmdbId");
	const deepLinkHandled = useRef<string | null>(null);

	useEffect(() => {
		if (!deepLinkTmdbId || deepLinkHandled.current === deepLinkTmdbId) return;
		deepLinkHandled.current = deepLinkTmdbId;

		const tmdbId = Number(deepLinkTmdbId);
		if (!Number.isFinite(tmdbId) || tmdbId <= 0) return;

		fetchLibraryItemByTmdbId(tmdbId).then((item) => {
			if (item) setItemDetail(item);
		});
	}, [deepLinkTmdbId]);

	// Seerr integration — detect if any Seerr instance is configured
	const { defaultInstance: seerrInstance } = useSeerrInstances();
	const seerrInstanceId = seerrInstance?.id ?? null;

	// Custom hooks - filters now include pagination and sorting
	const filters = useLibraryFilters();
	const data = useLibraryData({
		serviceFilter: filters.serviceFilter,
		instanceFilter: filters.instanceFilter,
		searchTerm: filters.searchTerm,
		statusFilter: filters.statusFilter,
		fileFilter: filters.fileFilter,
		qualityFilter: filters.qualityFilter,
		torrentStateFilter: filters.torrentStateFilter,
		sortBy: filters.sortBy,
		sortOrder: filters.sortOrder,
		page: filters.page,
		pageSize: filters.pageSize,
	});
	const actions = useLibraryActions();

	// Seerr enrichment — fetch TMDB ratings + issue counts for current page items
	const enrichmentQuery = useLibraryEnrichment(seerrInstanceId, data.items);
	const enrichmentMap = enrichmentQuery.data?.items ?? null;

	// Watch enrichment — fetch watch counts, on-deck status, last watched from Plex + Jellyfin/Emby
	const plexWatchQuery = useWatchEnrichment(data.items);
	const jellyfinWatchQuery = useJellyfinWatchEnrichment(data.items);
	const watchEnrichmentMap = useMemo(() => {
		const plexItems = plexWatchQuery.data?.items;
		const jfItems = jellyfinWatchQuery.data?.items;
		if (!plexItems && !jfItems) return null;
		// Jellyfin first, Plex on top — Plex wins on conflicts (has ratingKey + labels)
		return { ...jfItems, ...plexItems };
	}, [plexWatchQuery.data, jellyfinWatchQuery.data]);

	// Plex identity — needed to build "Watch in Plex" deep links
	const plexIdentityQuery = usePlexIdentity();
	const plexMachineIdMap = useMemo(() => {
		const map = new Map<string, string>();
		if (plexIdentityQuery.data?.servers) {
			for (const server of plexIdentityQuery.data.servers) {
				map.set(server.instanceId, server.machineId);
			}
		}
		return map;
	}, [plexIdentityQuery.data]);

	// Jellyfin/Emby identity — needed to build "Watch in Jellyfin/Emby" deep links
	const jellyfinIdentityQuery = useJellyfinIdentity();
	const jellyfinServerMap = useMemo(() => {
		const map = new Map<
			string,
			{ baseUrl: string; service: "jellyfin" | "emby"; serverId: string }
		>();
		if (jellyfinIdentityQuery.data) {
			for (const server of jellyfinIdentityQuery.data) {
				map.set(server.instanceId, {
					baseUrl: server.baseUrl,
					service: server.service,
					serverId: server.serverId,
				});
			}
		}
		return map;
	}, [jellyfinIdentityQuery.data]);

	// Series progress — fetch watched/total episode counts from Plex + Jellyfin/Emby
	const seriesTmdbIds = useMemo(
		() =>
			data.items
				.filter((item) => item.type === "series" && item.remoteIds?.tmdbId)
				.map((item) => item.remoteIds!.tmdbId!),
		[data.items],
	);
	const plexProgressQuery = useSeriesProgress(seriesTmdbIds);
	const jellyfinProgressQuery = useJellyfinSeriesProgress(seriesTmdbIds);
	const seriesProgressMap = useMemo(() => {
		const plexProgress = plexProgressQuery.data?.progress;
		const jfProgress = jellyfinProgressQuery.data?.progress;
		if (!plexProgress && !jfProgress) return null;
		return { ...jfProgress, ...plexProgress };
	}, [plexProgressQuery.data, jellyfinProgressQuery.data]);

	// hasQui gates UI surfaces that only make sense with a qui instance configured
	// (Torrent state filter dropdown, per-card badge). Each card now reads its
	// torrentState/torrentRatio directly from `LibraryItem` (stamped by the server
	// from the cached LibraryCache column) — no per-card polling.
	const hasQui = useMemo(
		() =>
			Object.values(data.serviceLookup).some((s) => s.service.toLowerCase() === "qui" && s.enabled),
		[data.serviceLookup],
	);

	// Notify user if Seerr enrichment fails (one-time per error transition)
	useEffect(() => {
		if (enrichmentQuery.isError && seerrInstanceId) {
			toast.warning("Could not load TMDB enrichment data from Seerr");
		}
	}, [enrichmentQuery.isError, seerrInstanceId]);

	// Monitor mutation for toggling item monitoring
	const monitorMutation = useLibraryMonitorMutation();

	// Calculate pending key for monitor mutation
	const pendingKey = monitorMutation.isPending
		? `${monitorMutation.variables?.service ?? ""}:${monitorMutation.variables?.itemId ?? ""}`
		: null;

	// Update albumDetail when data changes to reflect fresh artist data
	useEffect(() => {
		if (!albumDetail) {
			return;
		}

		const updated = data.items.find(
			(candidate) =>
				candidate.instanceId === albumDetail.instanceId &&
				candidate.service === albumDetail.service &&
				String(candidate.id) === String(albumDetail.id),
		);

		if (!updated || updated.type !== "artist") {
			setAlbumDetail(null);
			return;
		}

		if (updated !== albumDetail) {
			setAlbumDetail(updated);
		}
	}, [data.items, albumDetail]);

	// Update bookDetail when data changes to reflect fresh author data
	useEffect(() => {
		if (!bookDetail) {
			return;
		}

		const updated = data.items.find(
			(candidate) =>
				candidate.instanceId === bookDetail.instanceId &&
				candidate.service === bookDetail.service &&
				String(candidate.id) === String(bookDetail.id),
		);

		if (!updated || updated.type !== "author") {
			setBookDetail(null);
			return;
		}

		if (updated !== bookDetail) {
			setBookDetail(updated);
		}
	}, [data.items, bookDetail]);

	// Modal handlers (memoized for React.memo children)
	const handleExpandDetails = useCallback((item: LibraryItem) => setItemDetail(item), []);
	const handleCloseItemDetail = useCallback(() => setItemDetail(null), []);
	const handleViewAlbums = useCallback((item: LibraryItem) => {
		if (item.type !== "artist") {
			return;
		}
		setAlbumDetail(item);
	}, []);
	const handleCloseAlbumDetail = useCallback(() => setAlbumDetail(null), []);
	const handleViewBooks = useCallback((item: LibraryItem) => {
		if (item.type !== "author") {
			return;
		}
		setBookDetail(item);
	}, []);
	const handleCloseBookDetail = useCallback(() => setBookDetail(null), []);

	// Item monitoring handler (memoized)
	const handleToggleMonitor = useCallback(
		(item: LibraryItem) => {
			monitorMutation.mutate({
				instanceId: item.instanceId,
				service: item.service,
				itemId: item.id,
				monitored: !(item.monitored ?? false),
			});
		},
		[monitorMutation],
	);

	// Compute media server deep link URL for the detail modal item (Plex or Jellyfin/Emby)
	const modalMediaServerUrl = useMemo(() => {
		if (!itemDetail || !watchEnrichmentMap || !itemDetail.remoteIds?.tmdbId) return undefined;
		const key = `${itemDetail.type === "movie" ? "movie" : "series"}:${itemDetail.remoteIds.tmdbId}`;
		const wd = watchEnrichmentMap[key];
		if (!wd?.instanceId) return undefined;
		// Try Plex first
		if (wd.ratingKey) {
			const machineId = plexMachineIdMap.get(wd.instanceId);
			if (machineId) return buildPlexUrl(machineId, wd.ratingKey);
		}
		// Try Jellyfin/Emby
		if (wd.jellyfinId) {
			const jfServer = jellyfinServerMap.get(wd.instanceId);
			if (jfServer)
				return buildJellyfinUrl(
					jfServer.baseUrl,
					wd.jellyfinId,
					jfServer.service,
					jfServer.serverId,
				);
		}
		return undefined;
	}, [itemDetail, watchEnrichmentMap, plexMachineIdMap, jellyfinServerMap]);

	return (
		<>
			<LibraryHeader
				serviceFilter={filters.serviceFilter}
				onServiceFilterChange={filters.setServiceFilter}
				instanceFilter={filters.instanceFilter}
				onInstanceFilterChange={filters.setInstanceFilter}
				statusFilter={filters.statusFilter}
				onStatusFilterChange={filters.setStatusFilter}
				fileFilter={filters.fileFilter}
				onFileFilterChange={filters.setFileFilter}
				qualityFilter={filters.qualityFilter}
				onQualityFilterChange={filters.setQualityFilter}
				torrentStateFilter={filters.torrentStateFilter}
				onTorrentStateFilterChange={filters.setTorrentStateFilter}
				hasQui={hasQui}
				torrentStateCounts={data.torrentStateCounts}
				searchTerm={filters.searchTerm}
				onSearchTermChange={filters.setSearchTerm}
				sortBy={filters.sortBy}
				onSortByChange={filters.setSortBy}
				sortOrder={filters.sortOrder}
				onSortOrderChange={filters.setSortOrder}
				instanceOptions={data.instanceOptions}
				syncStatus={data.syncStatus}
				isSyncing={data.isSyncing}
			/>

			<LibraryInsightsSection />

			<div
				className="animate-in fade-in slide-in-from-bottom-4 duration-500"
				style={{ animationDelay: "200ms", animationFillMode: "backwards" }}
			>
				<LibraryContent
					isLoading={data.isLoading}
					isError={data.isError}
					error={data.error}
					grouped={data.grouped}
					totalItems={data.pagination.totalItems}
					page={filters.page}
					pageSize={filters.pageSize}
					onPageChange={filters.setPage}
					onPageSizeChange={filters.setPageSize}
					onToggleMonitor={handleToggleMonitor}
					pendingKey={pendingKey}
					isMonitorPending={monitorMutation.isPending}
					serviceLookup={data.serviceLookup}
					onSearchMovie={actions.handleMovieSearch}
					pendingMovieSearch={actions.pendingMovieSearch}
					onSearchSeries={actions.handleSeriesSearch}
					pendingSeriesSearch={actions.pendingSeriesSearch}
					onViewAlbums={handleViewAlbums}
					onSearchArtist={actions.handleArtistSearch}
					pendingArtistSearch={actions.pendingArtistSearch}
					onViewBooks={handleViewBooks}
					onSearchAuthor={actions.handleAuthorSearch}
					pendingAuthorSearch={actions.pendingAuthorSearch}
					onExpandDetails={handleExpandDetails}
					buildLibraryExternalLink={buildLibraryExternalLink}
					LibraryCard={LibraryCard}
					isSyncing={data.isSyncing}
					enrichmentMap={enrichmentMap}
					watchEnrichmentMap={watchEnrichmentMap}
					seriesProgressMap={seriesProgressMap}
					plexMachineIdMap={plexMachineIdMap}
					jellyfinServerMap={jellyfinServerMap}
				/>
			</div>

			{itemDetail &&
				(seerrInstanceId &&
				(itemDetail.service === "sonarr" || itemDetail.service === "radarr") &&
				itemDetail.remoteIds?.tmdbId ? (
					<Suspense>
						<EnrichedDetailModal
							item={itemDetail}
							seerrInstanceId={seerrInstanceId}
							onClose={handleCloseItemDetail}
							onToggleSeason={(seasonNumber, nextMonitored) =>
								actions.handleSeasonMonitor(itemDetail, seasonNumber, nextMonitored)
							}
							onSearchSeason={(seasonNumber) =>
								actions.handleSeasonSearch(itemDetail, seasonNumber)
							}
							pendingSeasonAction={actions.pendingSeasonAction}
							enrichedPosterPath={
								enrichmentMap && itemDetail.remoteIds?.tmdbId
									? enrichmentMap[
											`${itemDetail.type === "movie" ? "movie" : "tv"}:${itemDetail.remoteIds.tmdbId}`
										]?.posterPath
									: undefined
							}
							plexData={
								watchEnrichmentMap && itemDetail.remoteIds?.tmdbId
									? watchEnrichmentMap[
											`${itemDetail.type === "movie" ? "movie" : "series"}:${itemDetail.remoteIds.tmdbId}`
										]
									: undefined
							}
							userRating={
								watchEnrichmentMap && itemDetail.remoteIds?.tmdbId
									? watchEnrichmentMap[
											`${itemDetail.type === "movie" ? "movie" : "series"}:${itemDetail.remoteIds.tmdbId}`
										]?.userRating
									: undefined
							}
							plexUrl={modalMediaServerUrl}
							mediaServerLabel={(() => {
								if (!itemDetail?.remoteIds?.tmdbId || !watchEnrichmentMap) return undefined;
								const key = `${itemDetail.type === "movie" ? "movie" : "series"}:${itemDetail.remoteIds.tmdbId}`;
								const wd = watchEnrichmentMap[key];
								if (!wd?.instanceId) return undefined;
								if (jellyfinServerMap.has(wd.instanceId)) {
									const jf = jellyfinServerMap.get(wd.instanceId)!;
									return jf.service === "emby" ? "Emby" : "Jellyfin";
								}
								return "Plex";
							})()}
						/>
					</Suspense>
				) : (
					<ItemDetailsModal item={itemDetail} onClose={handleCloseItemDetail} />
				))}

			{albumDetail && (
				<AlbumBreakdownModal
					item={albumDetail}
					onClose={handleCloseAlbumDetail}
					onToggleAlbum={(albumId, nextMonitored) =>
						actions.handleAlbumMonitor(albumDetail, albumId, nextMonitored)
					}
					onSearchAlbum={(albumIds) => actions.handleAlbumSearch(albumDetail, albumIds)}
					pendingActionKey={actions.pendingAlbumAction}
				/>
			)}

			{bookDetail && (
				<BookBreakdownModal
					item={bookDetail}
					onClose={handleCloseBookDetail}
					onToggleBook={(bookId, nextMonitored) =>
						actions.handleBookMonitor(bookDetail, bookId, nextMonitored)
					}
					onSearchBook={(bookIds) => actions.handleBookSearch(bookDetail, bookIds)}
					pendingActionKey={actions.pendingBookAction}
				/>
			)}
		</>
	);
};
