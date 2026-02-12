"use client";

import type { LibraryService } from "@arr/shared";
import {
	ArrowDownAZ,
	ArrowUpAZ,
	BookOpen,
	Film,
	Filter,
	Library as LibraryIcon,
	Music,
	RefreshCw,
	Tv,
} from "lucide-react";
import { Button, Input } from "../../../components/ui";
import { GlassmorphicCard, FilterSelect } from "../../../components/layout";
import { SERVICE_GRADIENTS } from "../../../lib/theme-gradients";
import { useThemeGradient } from "../../../hooks/useThemeGradient";
import { cn } from "../../../lib/utils";
import type { SortByValue, SortOrderValue } from "../hooks/use-library-filters";
import type { SyncStatus } from "../hooks/use-library-data";

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
	const { gradient: themeGradient } = useThemeGradient();

	return (
		<header className="space-y-6">
			{/* Title Section */}
			<div
				className="relative animate-in fade-in slide-in-from-bottom-4 duration-500"
				style={{ animationFillMode: "backwards" }}
			>
				<div className="flex items-start justify-between gap-4">
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

					{/* Sync Status Indicator */}
					{syncStatus && (
						<div
							className="flex items-center gap-2 rounded-xl border border-border/50 bg-card/30 backdrop-blur-xs px-4 py-2 text-sm"
						>
							{isSyncing ? (
								<>
									<RefreshCw
										className="h-4 w-4 animate-spin"
										style={{ color: themeGradient.from }}
									/>
									<span className="text-muted-foreground">Syncing...</span>
								</>
							) : (
								<>
									<RefreshCw className="h-4 w-4 text-muted-foreground" />
									<span className="text-muted-foreground">
										<span style={{ color: themeGradient.from }} className="font-medium">
											{syncStatus.totalCachedItems.toLocaleString()}
										</span>
										{" items"}
										{syncStatus.lastSync && (
											<span className="text-muted-foreground/70">
												{" • "}Updated {formatSyncTime(syncStatus.lastSync)}
											</span>
										)}
									</span>
								</>
							)}
						</div>
					)}
				</div>
			</div>

			{/* Filters Card */}
			<GlassmorphicCard
				padding="none"
				animationDelay={100}
				className="overflow-hidden"
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
						<div className="inline-flex rounded-xl bg-background/50 border border-border/50 p-1">
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
											isActive ? "text-white" : "text-muted-foreground hover:text-foreground"
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
									.filter(
										(option) => serviceFilter === "all" || option.service === serviceFilter,
									)
									.map((option) => ({
										value: option.id,
										label: option.label,
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

						{/* Sort Controls */}
						<div className="flex items-end gap-2 ml-auto">
							<FilterSelect
								label="Sort By"
								value={sortBy}
								onChange={(value) => onSortByChange(value as SortByValue)}
								options={SORT_OPTIONS.map((option) => ({
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
			</GlassmorphicCard>
		</header>
	);
};
