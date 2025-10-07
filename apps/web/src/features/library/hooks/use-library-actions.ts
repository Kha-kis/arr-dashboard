"use client";

import { useState } from "react";
import type { LibraryItem } from "@arr/shared";
import { toast } from "../../../components/ui";
import {
	useLibraryMonitorMutation,
	useLibrarySeasonSearchMutation,
	useLibrarySeriesSearchMutation,
	useLibraryMovieSearchMutation,
} from "../../../hooks/api/useLibrary";

export interface LibraryActions {
	handleSeasonMonitor: (
		series: LibraryItem,
		seasonNumber: number,
		nextMonitored: boolean,
	) => Promise<void>;
	handleSeasonSearch: (series: LibraryItem, seasonNumber: number) => Promise<void>;
	handleSeriesSearch: (series: LibraryItem) => Promise<void>;
	handleMovieSearch: (movie: LibraryItem) => Promise<void>;
	pendingSeasonAction: string | null;
	pendingMovieSearch: string | null;
	pendingSeriesSearch: string | null;
}

/**
 * Custom hook for managing library action handlers
 *
 * Provides handlers for:
 * - Toggling season monitoring for series
 * - Searching for season episodes
 * - Searching for entire series
 * - Searching for movies
 *
 * Each action includes:
 * - Pending state tracking
 * - Success/error toast notifications
 * - Proper error handling
 *
 * @returns Object containing all action handlers and pending states
 */
export function useLibraryActions(): LibraryActions {
	const [pendingSeasonAction, setPendingSeasonAction] = useState<string | null>(null);
	const [pendingMovieSearch, setPendingMovieSearch] = useState<string | null>(null);
	const [pendingSeriesSearch, setPendingSeriesSearch] = useState<string | null>(null);

	// Mutation hooks
	const seasonMonitorMutation = useLibraryMonitorMutation();
	const seasonSearchMutation = useLibrarySeasonSearchMutation();
	const seriesSearchMutation = useLibrarySeriesSearchMutation();
	const movieSearchMutation = useLibraryMovieSearchMutation();

	/**
	 * Toggles monitoring for a specific season of a series
	 */
	const handleSeasonMonitor = async (
		series: LibraryItem,
		seasonNumber: number,
		nextMonitored: boolean,
	) => {
		if (series.service !== "sonarr") {
			toast.warning("Season monitoring actions are only available for Sonarr series.");
			return;
		}

		const seasonLabel = seasonNumber === 0 ? "Specials" : `Season ${seasonNumber}`;
		const seriesTitle = series.title ?? "Series";
		const actionKey = `monitor:${series.instanceId}:${series.id}:${seasonNumber}`;
		setPendingSeasonAction(actionKey);
		try {
			await seasonMonitorMutation.mutateAsync({
				instanceId: series.instanceId,
				service: series.service,
				itemId: series.id,
				monitored: nextMonitored,
				seasonNumbers: [seasonNumber],
			});
			toast.success(
				`${seasonLabel} ${nextMonitored ? "monitoring enabled" : "monitoring disabled"} for ${seriesTitle}`,
			);
		} catch (error) {
			const message = error instanceof Error ? error.message : "Unknown error";
			toast.error(`Failed to ${nextMonitored ? "enable" : "disable"} ${seasonLabel}: ${message}`);
		} finally {
			setPendingSeasonAction(null);
		}
	};

	/**
	 * Queues a search for all episodes in a specific season
	 */
	const handleSeasonSearch = async (series: LibraryItem, seasonNumber: number) => {
		if (series.service !== "sonarr") {
			toast.warning("Season searches are only available for Sonarr series.");
			return;
		}

		const seasonLabel = seasonNumber === 0 ? "Specials" : `Season ${seasonNumber}`;
		const seriesTitle = series.title ?? "Series";
		const actionKey = `search:${series.instanceId}:${series.id}:${seasonNumber}`;
		setPendingSeasonAction(actionKey);
		try {
			await seasonSearchMutation.mutateAsync({
				instanceId: series.instanceId,
				service: series.service,
				seriesId: series.id,
				seasonNumber,
			});
			toast.success(`${seasonLabel} search queued for ${seriesTitle}`);
		} catch (error) {
			const message = error instanceof Error ? error.message : "Unknown error";
			toast.error(`Failed to queue search for ${seasonLabel}: ${message}`);
		} finally {
			setPendingSeasonAction(null);
		}
	};

	/**
	 * Queues a search for all monitored episodes in a series
	 */
	const handleSeriesSearch = async (series: LibraryItem) => {
		if (series.service !== "sonarr") {
			toast.warning("Series searches are only available for Sonarr instances.");
			return;
		}

		const seriesTitle = series.title ?? "Series";
		const actionKey = `${series.instanceId}:${series.id}`;
		setPendingSeriesSearch(actionKey);
		try {
			await seriesSearchMutation.mutateAsync({
				instanceId: series.instanceId,
				service: "sonarr",
				seriesId: series.id,
			});
			toast.success(`${seriesTitle} search queued`);
		} catch (error) {
			const message = error instanceof Error ? error.message : "Unknown error";
			toast.error(`Failed to queue search for ${seriesTitle}: ${message}`);
		} finally {
			setPendingSeriesSearch(null);
		}
	};

	/**
	 * Queues a search for a movie
	 */
	const handleMovieSearch = async (movie: LibraryItem) => {
		if (movie.service !== "radarr") {
			toast.warning("Movie searches are only available for Radarr instances.");
			return;
		}

		const movieTitle = movie.title ?? "Movie";
		const actionKey = `${movie.instanceId}:${movie.id}`;
		setPendingMovieSearch(actionKey);
		try {
			await movieSearchMutation.mutateAsync({
				instanceId: movie.instanceId,
				service: "radarr",
				movieId: movie.id,
			});
			toast.success(`${movieTitle} search queued`);
		} catch (error) {
			const message = error instanceof Error ? error.message : "Unknown error";
			toast.error(`Failed to queue search for ${movieTitle}: ${message}`);
		} finally {
			setPendingMovieSearch(null);
		}
	};

	return {
		handleSeasonMonitor,
		handleSeasonSearch,
		handleSeriesSearch,
		handleMovieSearch,
		pendingSeasonAction,
		pendingMovieSearch,
		pendingSeriesSearch,
	};
}
