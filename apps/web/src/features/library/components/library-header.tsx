"use client";

import type { LibraryService, QuiObservationStatus, TorrentStateCounts } from "@arr/shared";
import {
	ArrowDownAZ,
	ArrowUpAZ,
	BookOpen,
	Film,
	Filter,
	HardDriveDownload,
	Library as LibraryIcon,
	Music,
	RefreshCw,
	Tv,
} from "lucide-react";
import { useState } from "react";
import { FilterSelect } from "../../../components/layout";
import { PlexQueryEvidenceNotice } from "../../../components/presentational/plex-evidence-notice";
import { Button, Input } from "../../../components/ui";
import { usePlexAccounts, usePlexScanMutation, usePlexSections } from "../../../hooks/api/usePlex";
import { useThemeGradient } from "../../../hooks/useThemeGradient";
import { ApiError } from "../../../lib/api-client/base";
import { getLinuxInstanceName, getLinuxUsername, useIncognitoMode } from "../../../lib/incognito";
import { SERVICE_GRADIENTS } from "../../../lib/theme-gradients";
import { cn } from "../../../lib/utils";
import type { SyncStatus } from "../hooks/use-library-data";
import {
	type QualityFilterValue,
	type SortByValue,
	type SortOrderValue,
	TORRENT_STATE_FILTERS,
	type TorrentStateFilterValue,
} from "../hooks/use-library-filters";
import { QuiObservationNotice } from "./qui-observation-notice";

/**
 * Service filter options for the library
 */
const SERVICE_OPTIONS: Array<{
	value: "all" | LibraryService;
	label: string;
	icon: React.ComponentType<{ className?: string }>;
	gradient?: { from: string; to: string; glow: string };
}> = [
	{ value: "all", label: "All", icon: LibraryIcon },
	{ value: "radarr", label: "Movies", icon: Film, gradient: SERVICE_GRADIENTS.radarr },
	{ value: "sonarr", label: "Series", icon: Tv, gradient: SERVICE_GRADIENTS.sonarr },
	{ value: "lidarr", label: "Artists", icon: Music, gradient: SERVICE_GRADIENTS.lidarr },
	{ value: "readarr", label: "Authors", icon: BookOpen, gradient: SERVICE_GRADIENTS.readarr },
];

/**
 * Status filter options for the library
 */
const STATUS_FILTERS = [
	{ value: "all", label: "All statuses" },
	{ value: "monitored", label: "Monitored" },
	{ value: "unmonitored", label: "Not monitored" },
] as const;

/**
 * File filter options for the library
 */
const FILE_FILTERS = [
	{ value: "all", label: "All files" },
	{ value: "has-file", label: "Has file" },
	{ value: "missing", label: "Missing file" },
] as const;

const QUALITY_FILTERS = [
	{ value: "all", label: "All quality" },
	{ value: "cutoff-unmet", label: "Cutoff unmet" },
	{ value: "cutoff-met", label: "Cutoff met" },
] as const;

/**
 * Sort options for the library. The qui-specific `torrentRatio` option is
 * appended at render time when `hasQui` is true — sorting by ratio without
 * any qui-correlated rows would just put NULLs everywhere.
 */
const BASE_SORT_OPTIONS: Array<{ value: SortByValue; label: string }> = [
	{ value: "sortTitle", label: "Title" },
	{ value: "year", label: "Year" },
	{ value: "sizeOnDisk", label: "Size" },
	{ value: "added", label: "Added" },
];

/**
 * Props for the LibraryHeader component
 */
interface LibraryHeaderProps {
	quiObservationStatus?: QuiObservationStatus;
	/** Currently selected service filter */
	serviceFilter: "all" | LibraryService;
	/** Handler for service filter changes */
	onServiceFilterChange: (value: "all" | LibraryService) => void;
	/** Currently selected instance filter */
	instanceFilter: string;
	/** Handler for instance filter changes */
	onInstanceFilterChange: (value: string) => void;
	/** Currently selected status filter */
	statusFilter: (typeof STATUS_FILTERS)[number]["value"];
	/** Handler for status filter changes */
	onStatusFilterChange: (value: (typeof STATUS_FILTERS)[number]["value"]) => void;
	/** Currently selected file filter */
	fileFilter: (typeof FILE_FILTERS)[number]["value"];
	/** Handler for file filter changes */
	onFileFilterChange: (value: (typeof FILE_FILTERS)[number]["value"]) => void;
	/** Currently selected quality filter */
	qualityFilter: QualityFilterValue;
	/** Handler for quality filter changes */
	onQualityFilterChange: (value: QualityFilterValue) => void;
	/** Currently selected qui torrent-state filter */
	torrentStateFilter: TorrentStateFilterValue;
	/** Handler for torrent-state filter changes */
	onTorrentStateFilterChange: (value: TorrentStateFilterValue) => void;
	/** Whether at least one qui instance is configured (gates the dropdown) */
	hasQui?: boolean;
	/** Per-state counts surfaced in the dropdown labels */
	torrentStateCounts?: TorrentStateCounts;
	/** Current search term */
	searchTerm: string;
	/** Handler for search term changes */
	onSearchTermChange: (value: string) => void;
	/** Current sort field */
	sortBy: SortByValue;
	/** Handler for sort field changes */
	onSortByChange: (value: SortByValue) => void;
	/** Current sort order */
	sortOrder: SortOrderValue;
	/** Handler for sort order changes */
	onSortOrderChange: (value: SortOrderValue) => void;
	/** Available instance options */
	instanceOptions: Array<{
		id: string;
		label: string;
		service: LibraryService;
	}>;
	/** Sync status from the cache */
	syncStatus: SyncStatus | null;
	/** Whether any instance is currently syncing */
	isSyncing: boolean;
	/** Whether sync status is unavailable or an instance reported a sync error */
	hasSyncError: boolean;
	/** Currently selected "watched by" filter user */
	watchedByFilter?: string;
	/** Handler for "watched by" filter changes */
	onWatchedByFilterChange?: (value: string) => void;
	/** Whether Plex instances are configured */
	hasPlexInstances?: boolean;
}

/**
 * Format a date string for display
 */
function formatSyncTime(dateString: string | null): string {
	if (!dateString) return "Never";
	const date = new Date(dateString);
	const now = new Date();
	const diffMs = now.getTime() - date.getTime();
	const diffMins = Math.floor(diffMs / 60000);

	if (diffMins < 1) return "Just now";
	if (diffMins < 60) return `${diffMins}m ago`;
	const diffHours = Math.floor(diffMins / 60);
	if (diffHours < 24) return `${diffHours}h ago`;
	const diffDays = Math.floor(diffHours / 24);
	return `${diffDays}d ago`;
}

/**
 * Header section for the library page with filters, sorting, and search
 */
export const LibraryHeader: React.FC<LibraryHeaderProps> = ({
	quiObservationStatus,
	serviceFilter,
	onServiceFilterChange,
	instanceFilter,
	onInstanceFilterChange,
	statusFilter,
	onStatusFilterChange,
	fileFilter,
	onFileFilterChange,
	qualityFilter,
	onQualityFilterChange,
	torrentStateFilter,
	onTorrentStateFilterChange,
	hasQui = false,
	torrentStateCounts,
	searchTerm,
	onSearchTermChange,
	sortBy,
	onSortByChange,
	sortOrder,
	onSortOrderChange,
	instanceOptions,
	syncStatus,
	isSyncing,
	hasSyncError,
	watchedByFilter = "all",
	onWatchedByFilterChange,
	hasPlexInstances = false,
}) => {
	const [incognitoMode] = useIncognitoMode();
	const quiAvailable = quiObservationStatus?.status === "available";
	const showQuiControls = hasQui || quiAvailable || quiObservationStatus?.status === "unavailable";
	const { gradient: themeGradient } = useThemeGradient();
	const plexSectionsQuery = usePlexSections(hasPlexInstances);
	const plexScanMutation = usePlexScanMutation();
	const [scanDropdownOpen, setScanDropdownOpen] = useState(false);
	const scanSelectionRejected =
		plexScanMutation.error instanceof ApiError && plexScanMutation.error.status === 409;

	const plexSections = plexSectionsQuery.data?.sections ?? [];
	const plexInstanceIds = [...new Set(plexSections.map((section) => section.instanceId))].sort();
	const hasPlexSections = hasPlexInstances && plexSections.length > 0;
	const catalog = plexSectionsQuery.data?.catalog;
	const catalogAvailable =
		(catalog?.availability === "current" || catalog?.availability === "last-known") &&
		typeof catalog.observedAt === "string" &&
		Number.isFinite(Date.parse(catalog.observedAt)) &&
		plexSections.every(
			(section) => typeof section.sectionUuid === "string" && section.sectionUuid.trim().length > 0,
		);
	const canScanPlex =
		hasPlexSections &&
		!plexSectionsQuery.isError &&
		!plexSectionsQuery.isFetching &&
		!plexScanMutation.isPending &&
		catalogAvailable;
	const sectionsUnavailable =
		hasPlexInstances &&
		(plexSectionsQuery.isError || (plexSectionsQuery.isSuccess && !catalogAvailable));
	const plexGradient = SERVICE_GRADIENTS.plex;
	const plexAccountsQuery = usePlexAccounts(hasPlexInstances && Boolean(onWatchedByFilterChange));
	const plexUsers = plexAccountsQuery.data?.users ?? [];

	const handleScanSection = (instanceId: string, sectionId: string, sectionUuid: string) => {
		if (!canScanPlex || plexScanMutation.isPending) return;
		plexScanMutation.mutate({ instanceId, sectionId, sectionUuid });
		setScanDropdownOpen(false);
	};

	return (
		<header className="space-y-6">
			{showQuiControls && (
				<QuiObservationNotice
					status={quiObservationStatus ?? { status: "unavailable", observedAt: null }}
				/>
			)}
			{/* Title Section */}
			<div
				className="relative animate-in fade-in slide-in-from-bottom-4 duration-500"
				style={{ animationFillMode: "backwards" }}
			>
				<div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
					<div className="space-y-1">
						{/* Label with icon */}
						<div className="flex items-center gap-2 text-sm text-muted-foreground">
							<LibraryIcon className="h-4 w-4" />
							<span>Media Library</span>
						</div>

						{/* Gradient title */}
						<h1 className="text-3xl font-bold tracking-tight">
							<span
								style={{
									background: `linear-gradient(135deg, ${themeGradient.from}, ${themeGradient.to})`,
									WebkitBackgroundClip: "text",
									WebkitTextFillColor: "transparent",
									backgroundClip: "text",
								}}
							>
								Your Collection
							</span>
						</h1>

						{/* Description */}
						<p className="text-muted-foreground max-w-xl">
							Browse, filter, and manage your media across all connected instances
						</p>
					</div>

					<div className="flex items-center gap-3">
						{/* Plex Scan Button */}
						{hasPlexSections && (
							<div className="relative">
								<Button
									variant="secondary"
									size="sm"
									onClick={() => setScanDropdownOpen(!scanDropdownOpen)}
									disabled={!canScanPlex || plexScanMutation.isPending}
									className="relative overflow-hidden"
								>
									<HardDriveDownload
										className={cn("h-4 w-4 mr-2", plexScanMutation.isPending && "animate-pulse")}
										style={{ color: plexGradient.from }}
									/>
									{plexScanMutation.isPending ? "Requesting scan..." : "Scan Plex"}
								</Button>
								{scanDropdownOpen && canScanPlex && !plexScanMutation.isPending && (
									<div className="absolute right-0 top-full mt-1 z-dropdown rounded-lg border border-border/50 bg-card/95 backdrop-blur-sm shadow-lg min-w-[200px]">
										<div className="p-1">
											{plexSections.map((section) => (
												<button
													key={`${section.instanceId}:${section.sectionId}`}
													type="button"
													onClick={() =>
														handleScanSection(
															section.instanceId,
															section.sectionId,
															section.sectionUuid,
														)
													}
													className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-sm text-foreground hover:bg-muted transition-colors"
												>
													<span className="truncate text-xs text-muted-foreground">
														Plex {plexInstanceIds.indexOf(section.instanceId) + 1}:{" "}
														{incognitoMode
															? getLinuxInstanceName(section.instanceName)
															: section.instanceName}
													</span>
													<span className="truncate">
														{incognitoMode
															? getLinuxInstanceName(section.sectionTitle)
															: section.sectionTitle}
													</span>
													<span className="text-xs text-muted-foreground ml-auto shrink-0">
														{section.mediaType}
													</span>
												</button>
											))}
										</div>
									</div>
								)}
							</div>
						)}

						{/* Sync Status Indicator */}
						{syncStatus && (
							<div className="flex items-center gap-2 rounded-xl border border-border/30 bg-muted/10 px-4 py-2 text-sm">
								{isSyncing ? (
									<>
										<RefreshCw
											className="h-4 w-4 animate-spin"
											style={{ color: themeGradient.from }}
										/>
										<span className="text-muted-foreground">Syncing...</span>
									</>
								) : !syncStatus.isCached ? (
									<span className="text-warning">Cache unavailable</span>
								) : (
									<>
										<RefreshCw className="h-4 w-4 text-muted-foreground" />
										<span className="text-muted-foreground">
											Last known{" "}
											<span style={{ color: themeGradient.from }} className="font-medium">
												{syncStatus.totalCachedItems.toLocaleString()}
											</span>
											{" items"}
											{syncStatus.lastSync && (
												<span className="text-muted-foreground/70">
													{" • "}Synced {formatSyncTime(syncStatus.lastSync)}
												</span>
											)}
										</span>
										{hasSyncError && <span className="text-warning">Sync unavailable</span>}
									</>
								)}
							</div>
						)}
					</div>
				</div>
			</div>

			{hasPlexInstances && (
				<PlexQueryEvidenceNotice
					error={plexSectionsQuery.error}
					evidence={plexSectionsQuery.data?.evidence}
					label="Plex canonical mapping and watch evidence"
				/>
			)}
			{hasPlexInstances && catalogAvailable && catalog?.availability === "last-known" && (
				<p role="status" className="text-sm text-muted-foreground">
					Showing the last-known Plex section catalog. The server rechecks the selected section and
					Plex identity before requesting a scan.
				</p>
			)}
			{sectionsUnavailable && (
				<div
					role="status"
					className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground"
				>
					<span>
						Plex section catalog is unavailable. Retry the section read to recover scan controls.
					</span>
					<Button
						type="button"
						variant="secondary"
						size="sm"
						disabled={plexSectionsQuery.isFetching}
						onClick={() => void plexSectionsQuery.refetch()}
					>
						Retry Plex sections
					</Button>
				</div>
			)}
			{hasPlexInstances && plexScanMutation.isSuccess && (
				<p role="status" className="text-sm text-muted-foreground">
					Scan requested. Plex acknowledged the request; scan completion is not confirmed here.
				</p>
			)}
			{hasPlexInstances && plexScanMutation.isError && (
				<p role="alert" className="text-sm text-warning">
					{scanSelectionRejected
						? "Scan selection rejected. No scan was requested. Select a section again after the section catalog reloads."
						: "Scan request not confirmed. Check Plex before requesting another scan; it may have received the request."}
				</p>
			)}

			{/* Filters Card */}
			<div
				className="overflow-hidden rounded-xl border border-border/30 bg-muted/10 animate-in fade-in slide-in-from-bottom-4 duration-500"
				style={{ animationDelay: "100ms", animationFillMode: "backwards" }}
			>
				{/* Header */}
				<div className="flex items-center gap-3 px-6 py-4 border-b border-border/50">
					<div
						className="flex h-10 w-10 items-center justify-center rounded-xl"
						style={{
							background: `linear-gradient(135deg, ${themeGradient.from}20, ${themeGradient.to}20)`,
							border: `1px solid ${themeGradient.from}30`,
						}}
					>
						<Filter className="h-5 w-5" style={{ color: themeGradient.from }} />
					</div>
					<div>
						<h2 className="text-lg font-semibold">Filters</h2>
						<p className="text-sm text-muted-foreground">Filter and sort your library</p>
					</div>
				</div>

				{/* Filter Controls */}
				<div className="flex flex-col gap-4 p-6">
					{/* Service Toggle + Search Row */}
					<div className="flex flex-wrap items-center gap-4">
						{/* Service Toggle Pills */}
						<div className="inline-flex max-w-full flex-wrap gap-1 rounded-xl bg-background/50 border border-border/50 p-1">
							{SERVICE_OPTIONS.map((option) => {
								const Icon = option.icon;
								const isActive = serviceFilter === option.value;
								const gradient = option.gradient ?? themeGradient;

								return (
									<button
										key={option.value}
										type="button"
										onClick={() => onServiceFilterChange(option.value)}
										className={cn(
											"relative flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-lg transition-all duration-300",
											isActive ? "text-white" : "text-muted-foreground hover:text-foreground",
										)}
									>
										{isActive && (
											<div
												className="absolute inset-0 rounded-lg"
												style={{
													background: `linear-gradient(135deg, ${gradient.from}, ${gradient.to})`,
													boxShadow: `0 4px 12px -4px ${gradient.glow}`,
												}}
											/>
										)}
										<Icon className={cn("h-4 w-4 relative z-10", !isActive && "opacity-70")} />
										<span className="relative z-10">{option.label}</span>
									</button>
								);
							})}
						</div>

						{/* Search Input */}
						<div className="relative flex-1 min-w-[200px] max-w-md ml-auto">
							<Input
								placeholder="Filter by title, overview, or tag"
								value={searchTerm}
								onChange={(event) => onSearchTermChange(event.target.value)}
								className="bg-background/50 border-border/50 focus:border-primary"
							/>
						</div>
					</div>

					{/* Filter Dropdowns Row */}
					<div className="flex flex-wrap items-end gap-4">
						<FilterSelect
							label="Instance"
							value={instanceFilter}
							onChange={onInstanceFilterChange}
							options={[
								{ value: "all", label: "All instances" },
								...instanceOptions
									.filter((option) => serviceFilter === "all" || option.service === serviceFilter)
									.map((option) => ({
										value: option.id,
										label: incognitoMode ? getLinuxInstanceName(option.label) : option.label,
									})),
							]}
							className="min-w-[160px]"
						/>

						<FilterSelect
							label="Status"
							value={statusFilter}
							onChange={(value) =>
								onStatusFilterChange(value as (typeof STATUS_FILTERS)[number]["value"])
							}
							options={STATUS_FILTERS.map((option) => ({
								value: option.value,
								label: option.label,
							}))}
							className="min-w-[140px]"
						/>

						<FilterSelect
							label="Files"
							value={fileFilter}
							onChange={(value) =>
								onFileFilterChange(value as (typeof FILE_FILTERS)[number]["value"])
							}
							options={FILE_FILTERS.map((option) => ({
								value: option.value,
								label: option.label,
							}))}
							className="min-w-[130px]"
						/>

						<FilterSelect
							label="Quality"
							value={qualityFilter}
							onChange={(value) => onQualityFilterChange(value as QualityFilterValue)}
							options={QUALITY_FILTERS.map((option) => ({
								value: option.value,
								label: option.label,
							}))}
							className="min-w-[140px]"
						/>

						{/* Torrent state filter (qui) — hidden when no qui instance configured.
							Also hidden when qui IS configured but every matched-state bucket
							is empty (only `none` has data) — that means qui was just added
							and the backfill hasn't covered anything yet. Showing a useless
							dropdown in that state would confuse new qui users. */}
						{showQuiControls && (
							<fieldset disabled={!quiAvailable}>
								<FilterSelect
									label="Torrent state"
									value={torrentStateFilter}
									onChange={(value) => onTorrentStateFilterChange(value as TorrentStateFilterValue)}
									options={TORRENT_STATE_FILTERS.map((option) => {
										const counts = quiAvailable ? torrentStateCounts : undefined;
										const count =
											option.value === "all"
												? counts?.all
												: counts?.[option.value as keyof TorrentStateCounts];
										const label = option.value === "none" ? "No available qUI data" : option.label;
										return {
											value: option.value,
											label: typeof count === "number" ? `${label} (${count})` : label,
										};
									})}
									className="min-w-[200px]"
								/>
							</fieldset>
						)}

						{/* Watched By filter (Plex) */}
						{plexUsers.length > 0 && onWatchedByFilterChange && (
							<FilterSelect
								label="Watched by"
								value={watchedByFilter}
								onChange={onWatchedByFilterChange}
								options={[
									{ value: "all", label: "All users" },
									...plexUsers.map((user) => ({
										value: user,
										label: incognitoMode ? getLinuxUsername(user) : user,
									})),
								]}
								className="min-w-[140px]"
							/>
						)}

						{/* Sort Controls — append the qui-only "Torrent ratio" option
							when qui is configured (NULLs go last regardless of asc/desc) */}
						<div className="flex items-end gap-2 ml-auto">
							<FilterSelect
								label="Sort By"
								value={sortBy}
								onChange={(value) => onSortByChange(value as SortByValue)}
								options={[
									...BASE_SORT_OPTIONS,
									...(showQuiControls && quiAvailable
										? [{ value: "torrentRatio" as SortByValue, label: "Torrent ratio" }]
										: []),
								].map((option) => ({
									value: option.value,
									label: option.label,
								}))}
								className="min-w-[120px]"
							/>
							<Button
								type="button"
								variant="ghost"
								size="sm"
								onClick={() => onSortOrderChange(sortOrder === "asc" ? "desc" : "asc")}
								className="h-[38px] px-3 border border-border/50 bg-background/50"
								title={sortOrder === "asc" ? "Sort ascending" : "Sort descending"}
							>
								{sortOrder === "asc" ? (
									<ArrowUpAZ className="h-4 w-4" />
								) : (
									<ArrowDownAZ className="h-4 w-4" />
								)}
							</Button>
						</div>
					</div>
				</div>
			</div>
		</header>
	);
};
