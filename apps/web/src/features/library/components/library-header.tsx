"use client";

import type { LibraryService } from "@arr/shared";
import {
	ArrowDownAZ,
	ArrowUpAZ,
	Film,
	Library as LibraryIcon,
	RefreshCw,
	Tv,
} from "lucide-react";
import { Button, Input } from "../../../components/ui";
import type { SortByValue, SortOrderValue } from "../hooks/use-library-filters";
import type { SyncStatus } from "../hooks/use-library-data";

/**
 * Service filter options for the library
 */
const SERVICE_OPTIONS: Array<{
	value: "all" | LibraryService;
	label: string;
	icon: JSX.Element;
}> = [
	{ value: "all", label: "All", icon: <LibraryIcon className="h-4 w-4" /> },
	{ value: "radarr", label: "Movies", icon: <Film className="h-4 w-4" /> },
	{ value: "sonarr", label: "Series", icon: <Tv className="h-4 w-4" /> },
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

/**
 * Sort options for the library
 */
const SORT_OPTIONS: Array<{ value: SortByValue; label: string }> = [
	{ value: "sortTitle", label: "Title" },
	{ value: "year", label: "Year" },
	{ value: "sizeOnDisk", label: "Size" },
	{ value: "added", label: "Added" },
];

/**
 * Props for the LibraryHeader component
 */
interface LibraryHeaderProps {
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
 *
 * Displays the page title, description, sync status, and all filter controls including:
 * - Service filter (All/Movies/Series)
 * - Instance filter dropdown
 * - Status filter (All/Monitored/Unmonitored)
 * - File filter (All/Has file/Missing)
 * - Sort controls (field and direction)
 * - Search input
 */
export const LibraryHeader: React.FC<LibraryHeaderProps> = ({
	serviceFilter,
	onServiceFilterChange,
	instanceFilter,
	onInstanceFilterChange,
	statusFilter,
	onStatusFilterChange,
	fileFilter,
	onFileFilterChange,
	searchTerm,
	onSearchTermChange,
	sortBy,
	onSortByChange,
	sortOrder,
	onSortOrderChange,
	instanceOptions,
	syncStatus,
	isSyncing,
}) => {
	return (
		<header className="space-y-4">
			<div className="flex items-start justify-between">
				<div className="space-y-1.5">
					<p className="text-xs uppercase tracking-[0.4em] text-fg-muted">Library</p>
					<h1 className="text-2xl font-semibold text-fg">
						Everything your *arr instances manage
					</h1>
					<p className="text-sm text-fg-muted">
						Browse, filter, and adjust monitoring for movies and series across every
						connected instance.
					</p>
				</div>

				{/* Sync Status Indicator */}
				{syncStatus && (
					<div className="flex items-center gap-2 rounded-lg border border-border bg-bg-subtle px-3 py-2 text-xs text-fg-muted">
						{isSyncing ? (
							<>
								<RefreshCw className="h-3.5 w-3.5 animate-spin text-sky-400" />
								<span>Syncing...</span>
							</>
						) : (
							<>
								<RefreshCw className="h-3.5 w-3.5" />
								<span>
									{syncStatus.totalCachedItems.toLocaleString()} items
									{syncStatus.lastSync && ` • Updated ${formatSyncTime(syncStatus.lastSync)}`}
								</span>
							</>
						)}
					</div>
				)}
			</div>

			<div className="flex flex-col gap-4 rounded-2xl border border-border bg-bg-subtle p-4 backdrop-blur">
				<div className="flex flex-wrap items-center gap-3">
					<div className="inline-flex rounded-full bg-bg-hover p-1">
						{SERVICE_OPTIONS.map((option) => (
							<Button
								key={option.value}
								type="button"
								variant={serviceFilter === option.value ? "primary" : "secondary"}
								className="flex items-center gap-2 px-4 py-2 text-sm"
								onClick={() => onServiceFilterChange(option.value)}
							>
								{option.icon}
								<span>{option.label}</span>
							</Button>
						))}
					</div>

					<div className="flex items-center gap-3">
						<label className="text-xs uppercase tracking-[0.3em] text-fg-muted">
							Instance
						</label>
						<select
							value={instanceFilter}
							onChange={(event) => onInstanceFilterChange(event.target.value)}
							className="rounded-md border border-border bg-bg-subtle px-3 py-2 text-sm text-fg hover:border-sky-400/80 focus:border-sky-400 focus:outline-none focus:ring-1 focus:ring-sky-400"
							disabled={instanceOptions.length === 0}
						>
							<option value="all" className="bg-bg text-fg">
								All instances
							</option>
							{instanceOptions
								.filter(
									(option) => serviceFilter === "all" || option.service === serviceFilter,
								)
								.map((option) => (
									<option key={option.id} value={option.id} className="bg-bg text-fg">
										{option.label}
									</option>
								))}
						</select>
					</div>

					<div className="flex items-center gap-3">
						<label className="text-xs uppercase tracking-[0.3em] text-fg-muted">
							Status
						</label>
						<select
							value={statusFilter}
							onChange={(event) =>
								onStatusFilterChange(
									event.target.value as (typeof STATUS_FILTERS)[number]["value"],
								)
							}
							className="rounded-md border border-border bg-bg-subtle px-3 py-2 text-sm text-fg hover:border-sky-400/80 focus:border-sky-400 focus:outline-none focus:ring-1 focus:ring-sky-400"
						>
							{STATUS_FILTERS.map((option) => (
								<option key={option.value} value={option.value} className="bg-bg text-fg">
									{option.label}
								</option>
							))}
						</select>
					</div>

					<div className="flex items-center gap-3">
						<label className="text-xs uppercase tracking-[0.3em] text-fg-muted">
							Files
						</label>
						<select
							value={fileFilter}
							onChange={(event) =>
								onFileFilterChange(
									event.target.value as (typeof FILE_FILTERS)[number]["value"],
								)
							}
							className="rounded-md border border-border bg-bg-subtle px-3 py-2 text-sm text-fg hover:border-sky-400/80 focus:border-sky-400 focus:outline-none focus:ring-1 focus:ring-sky-400"
						>
							{FILE_FILTERS.map((option) => (
								<option key={option.value} value={option.value} className="bg-bg text-fg">
									{option.label}
								</option>
							))}
						</select>
					</div>

					{/* Sort Controls */}
					<div className="flex items-center gap-2">
						<label className="text-xs uppercase tracking-[0.3em] text-fg-muted">
							Sort
						</label>
						<select
							value={sortBy}
							onChange={(event) => onSortByChange(event.target.value as SortByValue)}
							className="rounded-md border border-border bg-bg-subtle px-3 py-2 text-sm text-fg hover:border-sky-400/80 focus:border-sky-400 focus:outline-none focus:ring-1 focus:ring-sky-400"
						>
							{SORT_OPTIONS.map((option) => (
								<option key={option.value} value={option.value} className="bg-bg text-fg">
									{option.label}
								</option>
							))}
						</select>
						<Button
							type="button"
							variant="ghost"
							size="sm"
							onClick={() => onSortOrderChange(sortOrder === "asc" ? "desc" : "asc")}
							className="p-2"
							title={sortOrder === "asc" ? "Sort ascending" : "Sort descending"}
						>
							{sortOrder === "asc" ? (
								<ArrowUpAZ className="h-4 w-4" />
							) : (
								<ArrowDownAZ className="h-4 w-4" />
							)}
						</Button>
					</div>

					<div className="relative ml-auto w-full max-w-sm">
						<Input
							placeholder="Filter by title, overview, or tag"
							value={searchTerm}
							onChange={(event) => onSearchTermChange(event.target.value)}
						/>
					</div>
				</div>
			</div>
		</header>
	);
};
