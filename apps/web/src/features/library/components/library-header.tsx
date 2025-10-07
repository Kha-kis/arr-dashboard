"use client";

import type { LibraryService } from "@arr/shared";
import { Film, Library as LibraryIcon, Tv } from "lucide-react";
import { Button, Input } from "../../../components/ui";

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
	/** Available instance options */
	instanceOptions: Array<{
		id: string;
		label: string;
		service: LibraryService;
	}>;
}

/**
 * Header section for the library page with filters and search
 *
 * Displays the page title, description, and all filter controls including:
 * - Service filter (All/Movies/Series)
 * - Instance filter dropdown
 * - Status filter (All/Monitored/Unmonitored)
 * - File filter (All/Has file/Missing)
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
	instanceOptions,
}) => {
	return (
		<header className="space-y-4">
			<div className="space-y-1.5">
				<p className="text-xs uppercase tracking-[0.4em] text-white/40">Library</p>
				<h1 className="text-2xl font-semibold text-white">Everything your *arr instances manage</h1>
				<p className="text-sm text-white/60">
					Browse, filter, and adjust monitoring for movies and series across every connected
					instance.
				</p>
			</div>

			<div className="flex flex-col gap-4 rounded-2xl border border-white/10 bg-white/5 p-4 backdrop-blur">
				<div className="flex flex-wrap items-center gap-3">
					<div className="inline-flex rounded-full bg-white/10 p-1">
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
						<label className="text-xs uppercase tracking-[0.3em] text-white/40">Instance</label>
						<select
							value={instanceFilter}
							onChange={(event) => onInstanceFilterChange(event.target.value)}
							className="rounded-md border border-white/20 bg-slate-900/80 px-3 py-2 text-sm text-white hover:border-sky-400/80 focus:border-sky-400 focus:outline-none focus:ring-1 focus:ring-sky-400"
							disabled={instanceOptions.length === 0}
							style={{ color: "#f8fafc" }}
						>
							<option value="all" className="bg-slate-900 text-white">
								All instances
							</option>
							{instanceOptions
								.filter((option) => serviceFilter === "all" || option.service === serviceFilter)
								.map((option) => (
									<option key={option.id} value={option.id} className="bg-slate-900 text-white">
										{option.label}
									</option>
								))}
						</select>
					</div>

					<div className="flex items-center gap-3">
						<label className="text-xs uppercase tracking-[0.3em] text-white/40">Status</label>
						<select
							value={statusFilter}
							onChange={(event) =>
								onStatusFilterChange(event.target.value as (typeof STATUS_FILTERS)[number]["value"])
							}
							className="rounded-md border border-white/20 bg-slate-900/80 px-3 py-2 text-sm text-white hover:border-sky-400/80 focus:border-sky-400 focus:outline-none focus:ring-1 focus:ring-sky-400"
							style={{ color: "#f8fafc" }}
						>
							{STATUS_FILTERS.map((option) => (
								<option key={option.value} value={option.value} className="bg-slate-900 text-white">
									{option.label}
								</option>
							))}
						</select>
					</div>

					<div className="flex items-center gap-3">
						<label className="text-xs uppercase tracking-[0.3em] text-white/40">Files</label>
						<select
							value={fileFilter}
							onChange={(event) =>
								onFileFilterChange(event.target.value as (typeof FILE_FILTERS)[number]["value"])
							}
							className="rounded-md border border-white/20 bg-slate-900/80 px-3 py-2 text-sm text-white hover:border-sky-400/80 focus:border-sky-400 focus:outline-none focus:ring-1 focus:ring-sky-400"
							style={{ color: "#f8fafc" }}
						>
							{FILE_FILTERS.map((option) => (
								<option key={option.value} value={option.value} className="bg-slate-900 text-white">
									{option.label}
								</option>
							))}
						</select>
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
