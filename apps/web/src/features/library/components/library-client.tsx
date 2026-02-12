"use client";

import { useCallback, useEffect, useState } from "react";
import type { LibraryItem } from "@arr/shared";
import { useLibraryMonitorMutation } from "../../../hooks/api/useLibrary";
import { useLibraryFilters, useLibraryData, useLibraryActions } from "../hooks";
import { LibraryHeader } from "./library-header";
import { LibraryContent } from "./library-content";
import { LibraryCard } from "./library-card";
import { ItemDetailsModal } from "./item-details-modal";
import { SeasonBreakdownModal } from "./season-breakdown-modal";
import { AlbumBreakdownModal } from "./album-breakdown-modal";
import { BookBreakdownModal } from "./book-breakdown-modal";
import { buildLibraryExternalLink } from "../lib/library-utils";

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
	const [seasonDetail, setSeasonDetail] = useState<LibraryItem | null>(null);
	const [albumDetail, setAlbumDetail] = useState<LibraryItem | null>(null);
	const [bookDetail, setBookDetail] = useState<LibraryItem | null>(null);

	// Custom hooks - filters now include pagination and sorting
	const filters = useLibraryFilters();
	const data = useLibraryData({
		serviceFilter: filters.serviceFilter,
		instanceFilter: filters.instanceFilter,
		searchTerm: filters.searchTerm,
		statusFilter: filters.statusFilter,
		fileFilter: filters.fileFilter,
		sortBy: filters.sortBy,
		sortOrder: filters.sortOrder,
		page: filters.page,
		pageSize: filters.pageSize,
	});
	const actions = useLibraryActions();

	// Monitor mutation for toggling item monitoring
	const monitorMutation = useLibraryMonitorMutation();

	// Calculate pending key for monitor mutation
	const pendingKey = monitorMutation.isPending
		? `${monitorMutation.variables?.service ?? ""}:${monitorMutation.variables?.itemId ?? ""}`
		: null;

	// Update seasonDetail when data changes to reflect fresh season data
	useEffect(() => {
		if (!seasonDetail) {
			return;
		}

		const updated = data.items.find(
			(candidate) =>
				candidate.instanceId === seasonDetail.instanceId &&
				candidate.service === seasonDetail.service &&
				String(candidate.id) === String(seasonDetail.id),
		);

		if (!updated || updated.type !== "series" || !updated.seasons?.length) {
			setSeasonDetail(null);
			return;
		}

		if (updated !== seasonDetail) {
			setSeasonDetail(updated);
		}
	}, [data.items, seasonDetail]);

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
	const handleViewSeasons = useCallback((item: LibraryItem) => {
		if (item.type !== "series" || !item.seasons?.length) {
			return;
		}
		setSeasonDetail(item);
	}, []);
	const handleCloseSeasonDetail = useCallback(() => setSeasonDetail(null), []);
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
	const handleToggleMonitor = useCallback((item: LibraryItem) => {
		monitorMutation.mutate({
			instanceId: item.instanceId,
			service: item.service,
			itemId: item.id,
			monitored: !(item.monitored ?? false),
		});
	}, [monitorMutation]);

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
					onViewSeasons={handleViewSeasons}
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
				/>
			</div>

			{itemDetail && <ItemDetailsModal item={itemDetail} onClose={handleCloseItemDetail} />}

			{seasonDetail && (
				<SeasonBreakdownModal
					item={seasonDetail}
					onClose={handleCloseSeasonDetail}
					onToggleSeason={(seasonNumber, nextMonitored) =>
						actions.handleSeasonMonitor(seasonDetail, seasonNumber, nextMonitored)
					}
					onSearchSeason={(seasonNumber) => actions.handleSeasonSearch(seasonDetail, seasonNumber)}
					pendingActionKey={actions.pendingSeasonAction}
				/>
			)}

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
