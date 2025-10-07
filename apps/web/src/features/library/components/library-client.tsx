"use client";

import { useEffect, useState } from "react";
import type { LibraryItem } from "@arr/shared";
import { useLibraryMonitorMutation } from "../../../hooks/api/useLibrary";
import { useLibraryFilters, useLibraryData, useLibraryActions } from "../hooks";
import { LibraryHeader } from "./library-header";
import { LibraryContent } from "./library-content";
import { LibraryCard } from "./library-card";
import { ItemDetailsModal } from "./item-details-modal";
import { SeasonBreakdownModal } from "./season-breakdown-modal";
import { buildLibraryExternalLink } from "../lib/library-utils";

/**
 * Main library client component
 *
 * This component orchestrates the library view by:
 * - Managing filter state via useLibraryFilters
 * - Fetching and processing data via useLibraryData
 * - Handling actions via useLibraryActions
 * - Managing modal state for item details and season breakdowns
 * - Coordinating between LibraryHeader and LibraryContent
 *
 * The component maintains minimal local state (modals and item monitoring)
 * while delegating most logic to custom hooks and child components.
 */
export const LibraryClient: React.FC = () => {
	// Modal state
	const [itemDetail, setItemDetail] = useState<LibraryItem | null>(null);
	const [seasonDetail, setSeasonDetail] = useState<LibraryItem | null>(null);

	// Custom hooks
	const filters = useLibraryFilters();
	const data = useLibraryData({
		serviceFilter: filters.serviceFilter,
		instanceFilter: filters.instanceFilter,
		searchTerm: filters.searchTerm,
		statusFilter: filters.statusFilter,
		fileFilter: filters.fileFilter,
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

	// Modal handlers
	const handleExpandDetails = (item: LibraryItem) => setItemDetail(item);
	const handleCloseItemDetail = () => setItemDetail(null);
	const handleViewSeasons = (item: LibraryItem) => {
		if (item.type !== "series" || !item.seasons?.length) {
			return;
		}
		setSeasonDetail(item);
	};
	const handleCloseSeasonDetail = () => setSeasonDetail(null);

	// Item monitoring handler
	const handleToggleMonitor = (item: LibraryItem) => {
		monitorMutation.mutate({
			instanceId: item.instanceId,
			service: item.service,
			itemId: item.id,
			monitored: !(item.monitored ?? false),
		});
	};

	return (
		<>
			<div className="space-y-6">
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
					instanceOptions={data.instanceOptions}
				/>

				<LibraryContent
					isLoading={data.isLoading}
					isError={data.isError}
					error={data.error}
					grouped={data.grouped}
					onToggleMonitor={handleToggleMonitor}
					pendingKey={pendingKey}
					isMonitorPending={monitorMutation.isPending}
					serviceLookup={data.serviceLookup}
					onViewSeasons={handleViewSeasons}
					onSearchMovie={actions.handleMovieSearch}
					pendingMovieSearch={actions.pendingMovieSearch}
					onSearchSeries={actions.handleSeriesSearch}
					pendingSeriesSearch={actions.pendingSeriesSearch}
					onExpandDetails={handleExpandDetails}
					buildLibraryExternalLink={buildLibraryExternalLink}
					LibraryCard={LibraryCard}
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
		</>
	);
};
