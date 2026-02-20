"use client";

import { useState } from "react";
import { useFocusTrap } from "../../../hooks/useFocusTrap";
import type { LibraryItem, LibraryAlbum } from "@arr/shared";
import {
	ChevronDown,
	ChevronRight,
	Disc3,
	Loader2,
	Music,
	Search,
	X,
	AlertTriangle,
	CheckCircle2,
	HardDrive,
} from "lucide-react";
import { Button } from "../../../components/ui";
import { SEMANTIC_COLORS, SERVICE_GRADIENTS } from "../../../lib/theme-gradients";
import { useThemeGradient } from "../../../hooks/useThemeGradient";
import { useAlbumsQuery } from "../../../hooks/api/useLibrary";
import { AlbumTrackList } from "./album-track-list";
import { formatBytes } from "../lib/library-utils";

// ============================================================================
// Types
// ============================================================================

interface AlbumBreakdownModalProps {
	/** The library item (must be an artist) */
	item: LibraryItem;
	/** Callback to close the modal */
	onClose: () => void;
	/** Callback to toggle monitoring for an album */
	onToggleAlbum: (albumId: number, nextMonitored: boolean) => void;
	/** Callback to search for albums */
	onSearchAlbum: (albumIds: number[]) => void;
	/** The key representing which action is currently pending */
	pendingActionKey: string | null;
}

// ============================================================================
// Constants
// ============================================================================

const LIDARR_COLOR = SERVICE_GRADIENTS.lidarr.from;

const ALBUM_TYPE_COLORS: Record<string, { bg: string; border: string; text: string }> = {
	Album: SEMANTIC_COLORS.success,
	EP: SEMANTIC_COLORS.info,
	Single: { bg: "rgba(168, 85, 247, 0.1)", border: "rgba(168, 85, 247, 0.3)", text: "#a855f7" },
};

// ============================================================================
// Sub-components
// ============================================================================

const AlbumBadge = ({
	tone,
	children,
}: {
	tone: "success" | "warning" | "error" | "muted";
	children: React.ReactNode;
}) => {
	const colors = {
		success: SEMANTIC_COLORS.success,
		warning: SEMANTIC_COLORS.warning,
		error: SEMANTIC_COLORS.error,
		muted: { bg: "rgba(100, 116, 139, 0.1)", border: "rgba(100, 116, 139, 0.3)", text: "#94a3b8" },
	};
	const color = colors[tone];

	return (
		<span
			className="inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium"
			style={{
				backgroundColor: color.bg,
				border: `1px solid ${color.border}`,
				color: color.text,
			}}
		>
			{children}
		</span>
	);
};

const DEFAULT_ALBUM_TYPE_COLOR = SEMANTIC_COLORS.success;

const AlbumTypeBadge = ({ albumType }: { albumType: string }) => {
	const color = ALBUM_TYPE_COLORS[albumType] ?? DEFAULT_ALBUM_TYPE_COLOR;
	return (
		<span
			className="inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium"
			style={{
				backgroundColor: color.bg,
				border: `1px solid ${color.border}`,
				color: color.text,
			}}
		>
			{albumType}
		</span>
	);
};

// ============================================================================
// Main Component
// ============================================================================

export const AlbumBreakdownModal = ({
	item,
	onClose,
	onToggleAlbum,
	onSearchAlbum,
	pendingActionKey,
}: AlbumBreakdownModalProps) => {
	const { gradient: themeGradient } = useThemeGradient();
	const [expandedAlbums, setExpandedAlbums] = useState<Set<number>>(new Set());
	const focusTrapRef = useFocusTrap<HTMLDivElement>(true, onClose);

	// Fetch albums on-demand when modal opens
	const { data, isLoading, isError } = useAlbumsQuery({
		instanceId: item.instanceId,
		artistId: item.id,
		enabled: item.type === "artist",
	});

	if (item.type !== "artist") {
		return null;
	}

	const albums = data?.albums ?? [];

	const toggleAlbumExpanded = (albumId: number) => {
		setExpandedAlbums((prev) => {
			const next = new Set(prev);
			if (next.has(albumId)) {
				next.delete(albumId);
			} else {
				next.add(albumId);
			}
			return next;
		});
	};

	// Compute overall stats from fetched albums
	const totalTracks = albums.reduce((sum, a) => sum + (a.statistics?.totalTrackCount ?? a.statistics?.trackCount ?? 0), 0);
	const downloadedTracks = albums.reduce((sum, a) => sum + (a.statistics?.trackFileCount ?? 0), 0);
	const totalMissing = Math.max(totalTracks - downloadedTracks, 0);
	const overallProgress = totalTracks > 0 ? Math.round((downloadedTracks / totalTracks) * 100) : 0;

	return (
		<div
			className="fixed inset-0 z-modal-backdrop flex items-center justify-center p-4 animate-in fade-in duration-200"
			onClick={onClose}
			role="dialog"
			aria-modal="true"
			aria-labelledby="album-breakdown-title"
		>
			{/* Backdrop */}
			<div className="absolute inset-0 bg-black/70 backdrop-blur-xs" />

			{/* Modal */}
			<div
				ref={focusTrapRef}
				className="relative w-full max-w-3xl max-h-[90vh] overflow-hidden rounded-2xl border border-border/50 bg-card/95 backdrop-blur-xl shadow-2xl animate-in zoom-in-95 slide-in-from-bottom-4 duration-300"
				style={{
					boxShadow: `0 25px 50px -12px rgba(0, 0, 0, 0.5), 0 0 0 1px ${LIDARR_COLOR}15`,
				}}
				onClick={(event) => event.stopPropagation()}
			>
				{/* Close Button */}
				<button
					type="button"
					onClick={onClose}
					aria-label="Close modal"
					className="absolute right-4 top-4 z-10 flex h-8 w-8 items-center justify-center rounded-lg bg-black/50 text-white/70 transition-colors hover:bg-black/70 hover:text-white"
				>
					<X className="h-4 w-4" />
				</button>

				{/* Header */}
				<div
					className="p-6 border-b border-border/30"
					style={{
						background: `linear-gradient(135deg, ${LIDARR_COLOR}08, transparent)`,
					}}
				>
					<div className="flex items-start gap-4">
						<div
							className="flex h-12 w-12 items-center justify-center rounded-xl shrink-0"
							style={{
								background: `${LIDARR_COLOR}20`,
								border: `1px solid ${LIDARR_COLOR}30`,
							}}
						>
							<Music className="h-6 w-6" style={{ color: LIDARR_COLOR }} />
						</div>
						<div className="flex-1 min-w-0">
							<h2 id="album-breakdown-title" className="text-xl font-bold text-foreground">{item.title}</h2>
							<div className="flex flex-wrap items-center gap-3 mt-1 text-sm text-muted-foreground">
								<span>{item.instanceName}</span>
								<span>•</span>
								<span className="flex items-center gap-1">
									<Disc3 className="h-3.5 w-3.5" />
									{isLoading ? "..." : `${albums.length} album${albums.length !== 1 ? "s" : ""}`}
								</span>
								{!isLoading && (
									totalMissing > 0 ? (
										<AlbumBadge tone="warning">
											<AlertTriangle className="h-3 w-3" />
											{totalMissing} missing track{totalMissing !== 1 ? "s" : ""}
										</AlbumBadge>
									) : albums.length > 0 ? (
										<AlbumBadge tone="success">
											<CheckCircle2 className="h-3 w-3" />
											Complete
										</AlbumBadge>
									) : null
								)}
							</div>

							{/* Overall Progress */}
							{!isLoading && albums.length > 0 && (
								<div className="mt-4 space-y-1.5">
									<div className="flex items-center justify-between text-xs">
										<span className="text-muted-foreground">Overall Progress</span>
										<span className="font-medium text-foreground">
											{downloadedTracks}/{totalTracks} tracks ({overallProgress}%)
										</span>
									</div>
									<div className="h-2 rounded-full bg-muted/30 overflow-hidden">
										<div
											className="h-full transition-all duration-500 rounded-full"
											style={{
												width: `${overallProgress}%`,
												background:
													totalMissing > 0
														? `linear-gradient(90deg, ${SEMANTIC_COLORS.warning.from}, ${SEMANTIC_COLORS.warning.to})`
														: `linear-gradient(90deg, ${SEMANTIC_COLORS.success.from}, ${SEMANTIC_COLORS.success.to})`,
											}}
										/>
									</div>
								</div>
							)}
						</div>
					</div>
				</div>

				{/* Album List */}
				<div className="max-h-[calc(90vh-200px)] overflow-y-auto p-6 space-y-3">
					{isLoading && (
						<div className="flex items-center justify-center py-12 gap-3 text-muted-foreground">
							<Loader2 className="h-5 w-5 animate-spin" />
							<span className="text-sm">Loading albums...</span>
						</div>
					)}

					{isError && (
						<div
							className="p-4 rounded-xl flex items-start gap-3"
							style={{
								backgroundColor: SEMANTIC_COLORS.error.bg,
								border: `1px solid ${SEMANTIC_COLORS.error.border}`,
							}}
						>
							<AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" style={{ color: SEMANTIC_COLORS.error.from }} />
							<p className="text-xs" style={{ color: SEMANTIC_COLORS.error.text }}>
								Failed to load albums. Please try closing and reopening the modal.
							</p>
						</div>
					)}

					{!isLoading && !isError && albums.length === 0 && (
						<div className="flex flex-col items-center justify-center py-12 text-muted-foreground">
							<Disc3 className="h-8 w-8 mb-2 opacity-50" />
							<p className="text-sm">No albums found for this artist.</p>
						</div>
					)}

					{albums.map((album, index) => (
						<AlbumRow
							key={album.id}
							album={album}
							item={item}
							index={index}
							isExpanded={expandedAlbums.has(album.id)}
							onToggleExpanded={() => toggleAlbumExpanded(album.id)}
							onToggleAlbum={onToggleAlbum}
							onSearchAlbum={onSearchAlbum}
							pendingActionKey={pendingActionKey}
							themeGradient={themeGradient}
						/>
					))}
				</div>
			</div>
		</div>
	);
};

// ============================================================================
// AlbumRow Component
// ============================================================================

interface AlbumRowProps {
	album: LibraryAlbum;
	item: LibraryItem;
	index: number;
	isExpanded: boolean;
	onToggleExpanded: () => void;
	onToggleAlbum: (albumId: number, nextMonitored: boolean) => void;
	onSearchAlbum: (albumIds: number[]) => void;
	pendingActionKey: string | null;
	themeGradient: { from: string; to: string; glow: string; fromLight: string; fromMedium: string; fromMuted: string };
}

const AlbumRow = ({
	album,
	item,
	index,
	isExpanded,
	onToggleExpanded,
	onToggleAlbum,
	onSearchAlbum,
	pendingActionKey,
	themeGradient,
}: AlbumRowProps) => {
	const trackTotal = album.statistics?.totalTrackCount ?? album.statistics?.trackCount ?? 0;
	const trackDownloaded = album.statistics?.trackFileCount ?? 0;
	const trackMissing = album.monitored !== false ? Math.max(trackTotal - trackDownloaded, 0) : 0;
	const percentComplete = album.statistics?.percentOfTracks ?? (trackTotal > 0 ? Math.round((trackDownloaded / trackTotal) * 100) : 0);

	const albumKey = `${item.instanceId}:${item.id}:${album.id}`;
	const monitorKey = `monitor:${albumKey}`;
	const searchKey = `search:${item.instanceId}:${item.id}:${album.id}`;
	const albumMonitorPending = pendingActionKey === monitorKey;
	const albumSearchPending = pendingActionKey === searchKey;

	const releaseYear = album.releaseDate ? new Date(album.releaseDate).getFullYear() : null;
	const sizeLabel = album.statistics?.sizeOnDisk ? formatBytes(album.statistics.sizeOnDisk) : null;

	// Get cover image URL
	const coverImage = album.images?.find((img) => img.coverType === "cover")?.url;

	return (
		<div
			className="rounded-xl border border-border/50 bg-card/30 backdrop-blur-xs overflow-hidden transition-all duration-300 hover:border-border/80 animate-in fade-in slide-in-from-bottom-2"
			style={{
				animationDelay: `${index * 50}ms`,
				animationFillMode: "backwards",
				...(isExpanded && {
					borderColor: `${themeGradient.from}40`,
				}),
			}}
		>
			<div className="px-4 py-3">
				<div className="flex flex-wrap items-center justify-between gap-3">
					<button
						onClick={onToggleExpanded}
						aria-expanded={isExpanded}
						className="flex items-center gap-2 text-left hover:text-foreground transition-colors group min-w-0 flex-1"
					>
						<div
							className="flex h-6 w-6 items-center justify-center rounded-md transition-colors shrink-0"
							style={{
								background: isExpanded ? `${themeGradient.from}20` : "transparent",
							}}
						>
							{isExpanded ? (
								<ChevronDown className="h-4 w-4" style={{ color: themeGradient.from }} />
							) : (
								<ChevronRight className="h-4 w-4 text-muted-foreground group-hover:text-foreground" />
							)}
						</div>
						{coverImage ? (
							<div className="h-10 w-10 overflow-hidden rounded-md border border-border/50 bg-muted shrink-0">
								{/* eslint-disable-next-line @next/next/no-img-element -- External image from arr instance */}
								<img src={coverImage} alt="" className="h-full w-full object-cover" />
							</div>
						) : (
							<div className="flex h-10 w-10 items-center justify-center rounded-md border border-border/50 bg-muted/30 shrink-0">
								<Disc3 className="h-4 w-4 text-muted-foreground" />
							</div>
						)}
						<div className="min-w-0">
							<div className="flex flex-wrap items-center gap-2">
								<p className="text-sm font-medium text-foreground truncate">{album.title}</p>
								{album.albumType && <AlbumTypeBadge albumType={album.albumType} />}
								{releaseYear && (
									<span className="text-xs text-muted-foreground">{releaseYear}</span>
								)}
							</div>
						</div>
					</button>

					<div className="flex flex-wrap items-center gap-2">
						{trackTotal > 0 && (
							<AlbumBadge tone={trackMissing > 0 ? "warning" : "success"}>
								{trackDownloaded}/{trackTotal} tracks
							</AlbumBadge>
						)}
						{trackMissing > 0 && <AlbumBadge tone="error">{trackMissing} missing</AlbumBadge>}
						{album.monitored === false && <AlbumBadge tone="muted">Unmonitored</AlbumBadge>}
					</div>

					<div className="flex flex-wrap items-center gap-2">
						<Button
							type="button"
							variant="outline"
							size="sm"
							className="gap-1.5"
							disabled={albumMonitorPending}
							onClick={() => onToggleAlbum(album.id, !(album.monitored ?? false))}
						>
							{albumMonitorPending ? (
								<Loader2 className="h-3.5 w-3.5 animate-spin" />
							) : album.monitored === false ? (
								"Monitor"
							) : (
								"Unmonitor"
							)}
						</Button>
						<Button
							type="button"
							size="sm"
							className="gap-1.5"
							disabled={albumSearchPending}
							onClick={() => onSearchAlbum([album.id])}
							style={{
								background: `linear-gradient(135deg, ${themeGradient.from}, ${themeGradient.to})`,
								boxShadow: `0 4px 12px -4px ${themeGradient.glow}`,
							}}
						>
							{albumSearchPending ? (
								<Loader2 className="h-3.5 w-3.5 animate-spin" />
							) : (
								<Search className="h-3.5 w-3.5" />
							)}
							Search
						</Button>
					</div>
				</div>

				{/* Progress bar */}
				{trackTotal > 0 && (
					<div className="mt-3 space-y-1.5">
						<div className="flex items-center justify-between text-xs">
							<span className="text-muted-foreground">Progress</span>
							<span className="font-medium text-foreground">{percentComplete}%</span>
						</div>
						<div className="h-1.5 rounded-full bg-muted/30 overflow-hidden">
							<div
								className="h-full transition-all duration-300 rounded-full"
								style={{
									width: `${percentComplete}%`,
									background:
										trackMissing > 0
											? `linear-gradient(90deg, ${SEMANTIC_COLORS.warning.from}, ${SEMANTIC_COLORS.warning.to})`
											: `linear-gradient(90deg, ${SEMANTIC_COLORS.success.from}, ${SEMANTIC_COLORS.success.to})`,
								}}
							/>
						</div>
					</div>
				)}
			</div>

			{/* Expanded details */}
			{isExpanded && (
				<div
					className="border-t border-border/30 px-4 py-4 space-y-4"
					style={{
						background: `linear-gradient(135deg, ${themeGradient.from}05, transparent)`,
					}}
				>
					<div className="flex gap-4">
						{/* Album cover */}
						{coverImage && (
							<div className="h-24 w-24 overflow-hidden rounded-lg border border-border/50 bg-muted shadow-md shrink-0">
								{/* eslint-disable-next-line @next/next/no-img-element -- External image from arr instance */}
								<img src={coverImage} alt={album.title} className="h-full w-full object-cover" />
							</div>
						)}

						<div className="flex-1 min-w-0 space-y-3">
							{/* Stats grid */}
							<div className="grid grid-cols-2 md:grid-cols-4 gap-3">
								<div className="rounded-lg border border-border/50 bg-card/30 p-3">
									<p className="text-xs text-muted-foreground">Total Tracks</p>
									<p className="mt-1 text-lg font-semibold text-foreground">{trackTotal}</p>
								</div>
								<div
									className="rounded-lg p-3"
									style={{
										backgroundColor: SEMANTIC_COLORS.success.bg,
										border: `1px solid ${SEMANTIC_COLORS.success.border}`,
									}}
								>
									<p className="text-xs" style={{ color: SEMANTIC_COLORS.success.text }}>Downloaded</p>
									<p className="mt-1 text-lg font-semibold" style={{ color: SEMANTIC_COLORS.success.from }}>{trackDownloaded}</p>
								</div>
								{trackMissing > 0 && (
									<div
										className="rounded-lg p-3"
										style={{
											backgroundColor: SEMANTIC_COLORS.error.bg,
											border: `1px solid ${SEMANTIC_COLORS.error.border}`,
										}}
									>
										<p className="text-xs" style={{ color: SEMANTIC_COLORS.error.text }}>Missing</p>
										<p className="mt-1 text-lg font-semibold" style={{ color: SEMANTIC_COLORS.error.from }}>{trackMissing}</p>
									</div>
								)}
								{sizeLabel && (
									<div className="rounded-lg border border-border/50 bg-card/30 p-3">
										<p className="text-xs text-muted-foreground flex items-center gap-1">
											<HardDrive className="h-3 w-3" />
											On Disk
										</p>
										<p className="mt-1 text-sm font-semibold text-foreground">{sizeLabel}</p>
									</div>
								)}
							</div>

							{/* Overview */}
							{album.overview && (
								<p className="text-xs leading-relaxed text-muted-foreground">{album.overview}</p>
							)}

							{/* Genre tags */}
							{album.genres && album.genres.length > 0 && (
								<div className="flex flex-wrap gap-1.5">
									{album.genres.map((genre) => (
										<span
											key={genre}
											className="rounded-full border border-border bg-muted px-2 py-0.5 text-xs text-muted-foreground"
										>
											{genre}
										</span>
									))}
								</div>
							)}
						</div>
					</div>

					{/* Missing tracks warning */}
					{trackMissing > 0 && album.monitored !== false && (
						<div
							className="p-3 rounded-xl flex items-start gap-3"
							style={{
								backgroundColor: SEMANTIC_COLORS.warning.bg,
								border: `1px solid ${SEMANTIC_COLORS.warning.border}`,
							}}
						>
							<AlertTriangle
								className="h-4 w-4 shrink-0 mt-0.5"
								style={{ color: SEMANTIC_COLORS.warning.from }}
							/>
							<p className="text-xs" style={{ color: SEMANTIC_COLORS.warning.text }}>
								{trackMissing} track{trackMissing === 1 ? "" : "s"} missing. Click{" "}
								&ldquo;Search&rdquo; to look for {trackMissing === 1 ? "it" : "them"}.
							</p>
						</div>
					)}

					{/* Track listing */}
					<AlbumTrackList instanceId={item.instanceId} albumId={album.id} />
				</div>
			)}
		</div>
	);
};
