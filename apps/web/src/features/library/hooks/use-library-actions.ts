"use client";

import { useCallback, useState } from "react";
import type { LibraryItem } from "@arr/shared";
import { toast } from "../../../components/ui";
import {
	useLibraryAlbumMonitorMutation,
	useLibraryAlbumSearchMutation,
	useLibraryArtistSearchMutation,
	useLibraryAuthorSearchMutation,
	useLibraryBookMonitorMutation,
	useLibraryBookSearchMutation,
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
	handleArtistSearch: (artist: LibraryItem) => Promise<void>;
	handleAlbumMonitor: (artist: LibraryItem, albumId: number, nextMonitored: boolean) => Promise<void>;
	handleAlbumSearch: (artist: LibraryItem, albumIds: number[]) => Promise<void>;
	pendingSeasonAction: string | null;
	pendingMovieSearch: string | null;
	pendingSeriesSearch: string | null;
	pendingArtistSearch: string | null;
	pendingAlbumAction: string | null;
	handleAuthorSearch: (author: LibraryItem) => Promise<void>;
	handleBookMonitor: (author: LibraryItem, bookId: number, nextMonitored: boolean) => Promise<void>;
	handleBookSearch: (author: LibraryItem, bookIds: number[]) => Promise<void>;
	pendingAuthorSearch: string | null;
	pendingBookAction: string | null;
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
	const [pendingArtistSearch, setPendingArtistSearch] = useState<string | null>(null);
	const [pendingAlbumAction, setPendingAlbumAction] = useState<string | null>(null);
	const [pendingAuthorSearch, setPendingAuthorSearch] = useState<string | null>(null);
	const [pendingBookAction, setPendingBookAction] = useState<string | null>(null);

	// Mutation hooks
	const seasonMonitorMutation = useLibraryMonitorMutation();
	const seasonSearchMutation = useLibrarySeasonSearchMutation();
	const seriesSearchMutation = useLibrarySeriesSearchMutation();
	const movieSearchMutation = useLibraryMovieSearchMutation();
	const artistSearchMutation = useLibraryArtistSearchMutation();
	const albumSearchMutation = useLibraryAlbumSearchMutation();
	const albumMonitorMutation = useLibraryAlbumMonitorMutation();
	const authorSearchMutation = useLibraryAuthorSearchMutation();
	const bookSearchMutation = useLibraryBookSearchMutation();
	const bookMonitorMutation = useLibraryBookMonitorMutation();

	/**
	 * Toggles monitoring for a specific season of a series
	 */
	const handleSeasonMonitor = useCallback(async (
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
	}, [seasonMonitorMutation]);

	/**
	 * Queues a search for all episodes in a specific season
	 */
	const handleSeasonSearch = useCallback(async (series: LibraryItem, seasonNumber: number) => {
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
	}, [seasonSearchMutation]);

	/**
	 * Queues a search for all monitored episodes in a series
	 */
	const handleSeriesSearch = useCallback(async (series: LibraryItem) => {
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
	}, [seriesSearchMutation]);

	/**
	 * Queues a search for a movie
	 */
	const handleMovieSearch = useCallback(async (movie: LibraryItem) => {
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
	}, [movieSearchMutation]);

	/**
	 * Queues a search for all monitored albums of an artist
	 */
	const handleArtistSearch = useCallback(async (artist: LibraryItem) => {
		if (artist.service !== "lidarr") {
			toast.warning("Artist searches are only available for Lidarr instances.");
			return;
		}

		const artistTitle = artist.title ?? "Artist";
		const actionKey = `${artist.instanceId}:${artist.id}`;
		setPendingArtistSearch(actionKey);
		try {
			await artistSearchMutation.mutateAsync({
				instanceId: artist.instanceId,
				service: "lidarr",
				artistId: artist.id,
			});
			toast.success(`${artistTitle} search queued`);
		} catch (error) {
			const message = error instanceof Error ? error.message : "Unknown error";
			toast.error(`Failed to queue search for ${artistTitle}: ${message}`);
		} finally {
			setPendingArtistSearch(null);
		}
	}, [artistSearchMutation]);

	/**
	 * Toggles monitoring for a specific album
	 */
	const handleAlbumMonitor = useCallback(async (
		artist: LibraryItem,
		albumId: number,
		nextMonitored: boolean,
	) => {
		if (artist.service !== "lidarr") {
			toast.warning("Album monitoring actions are only available for Lidarr artists.");
			return;
		}

		const actionKey = `monitor:${artist.instanceId}:${artist.id}:${albumId}`;
		setPendingAlbumAction(actionKey);
		try {
			await albumMonitorMutation.mutateAsync({
				instanceId: artist.instanceId,
				artistId: artist.id,
				albumIds: [albumId],
				monitored: nextMonitored,
			});
			toast.success(`Album ${nextMonitored ? "monitoring enabled" : "monitoring disabled"}`);
		} catch (error) {
			const message = error instanceof Error ? error.message : "Unknown error";
			toast.error(`Failed to ${nextMonitored ? "enable" : "disable"} album monitoring: ${message}`);
		} finally {
			setPendingAlbumAction(null);
		}
	}, [albumMonitorMutation]);

	/**
	 * Queues a search for specific albums
	 */
	const handleAlbumSearch = useCallback(async (artist: LibraryItem, albumIds: number[]) => {
		if (artist.service !== "lidarr") {
			toast.warning("Album searches are only available for Lidarr instances.");
			return;
		}

		const actionKey = `search:${artist.instanceId}:${artist.id}:${albumIds.join(",")}`;
		setPendingAlbumAction(actionKey);
		try {
			await albumSearchMutation.mutateAsync({
				instanceId: artist.instanceId,
				albumIds,
			});
			toast.success(`Album search queued for ${artist.title ?? "Artist"}`);
		} catch (error) {
			const message = error instanceof Error ? error.message : "Unknown error";
			toast.error(`Failed to queue album search: ${message}`);
		} finally {
			setPendingAlbumAction(null);
		}
	}, [albumSearchMutation]);

	/**
	 * Queues a search for all monitored books of an author
	 */
	const handleAuthorSearch = useCallback(async (author: LibraryItem) => {
		if (author.service !== "readarr") {
			toast.warning("Author searches are only available for Readarr instances.");
			return;
		}

		const authorTitle = author.title ?? "Author";
		const actionKey = `${author.instanceId}:${author.id}`;
		setPendingAuthorSearch(actionKey);
		try {
			await authorSearchMutation.mutateAsync({
				instanceId: author.instanceId,
				service: "readarr",
				authorId: author.id,
			});
			toast.success(`${authorTitle} search queued`);
		} catch (error) {
			const message = error instanceof Error ? error.message : "Unknown error";
			toast.error(`Failed to queue search for ${authorTitle}: ${message}`);
		} finally {
			setPendingAuthorSearch(null);
		}
	}, [authorSearchMutation]);

	/**
	 * Toggles monitoring for a specific book
	 */
	const handleBookMonitor = useCallback(async (
		author: LibraryItem,
		bookId: number,
		nextMonitored: boolean,
	) => {
		if (author.service !== "readarr") {
			toast.warning("Book monitoring actions are only available for Readarr authors.");
			return;
		}

		const actionKey = `monitor:${author.instanceId}:${author.id}:${bookId}`;
		setPendingBookAction(actionKey);
		try {
			await bookMonitorMutation.mutateAsync({
				instanceId: author.instanceId,
				authorId: author.id,
				bookIds: [bookId],
				monitored: nextMonitored,
			});
			toast.success(`Book ${nextMonitored ? "monitoring enabled" : "monitoring disabled"}`);
		} catch (error) {
			const message = error instanceof Error ? error.message : "Unknown error";
			toast.error(`Failed to ${nextMonitored ? "enable" : "disable"} book monitoring: ${message}`);
		} finally {
			setPendingBookAction(null);
		}
	}, [bookMonitorMutation]);

	/**
	 * Queues a search for specific books
	 */
	const handleBookSearch = useCallback(async (author: LibraryItem, bookIds: number[]) => {
		if (author.service !== "readarr") {
			toast.warning("Book searches are only available for Readarr instances.");
			return;
		}

		const actionKey = `search:${author.instanceId}:${author.id}:${bookIds.join(",")}`;
		setPendingBookAction(actionKey);
		try {
			await bookSearchMutation.mutateAsync({
				instanceId: author.instanceId,
				bookIds,
			});
			toast.success(`Book search queued for ${author.title ?? "Author"}`);
		} catch (error) {
			const message = error instanceof Error ? error.message : "Unknown error";
			toast.error(`Failed to queue book search: ${message}`);
		} finally {
			setPendingBookAction(null);
		}
	}, [bookSearchMutation]);

	return {
		handleSeasonMonitor,
		handleSeasonSearch,
		handleSeriesSearch,
		handleMovieSearch,
		handleArtistSearch,
		handleAlbumMonitor,
		handleAlbumSearch,
		pendingSeasonAction,
		pendingMovieSearch,
		pendingSeriesSearch,
		pendingArtistSearch,
		pendingAlbumAction,
		handleAuthorSearch,
		handleBookMonitor,
		handleBookSearch,
		pendingAuthorSearch,
		pendingBookAction,
	};
}
