"use client";

import { Button } from "../../../components/ui/button";
import { Input } from "../../../components/ui/input";
import { useThemeGradient } from "../../../hooks/useThemeGradient";
import { Filter, RotateCcw } from "lucide-react";
import type { ServiceFilterValue } from "../hooks/use-calendar-state";

const SERVICE_FILTERS = [
	{ value: "all" as const, label: "All" },
	{ value: "sonarr" as const, label: "Sonarr" },
	{ value: "radarr" as const, label: "Radarr" },
	{ value: "lidarr" as const, label: "Lidarr" },
	{ value: "readarr" as const, label: "Readarr" },
];

interface CalendarFiltersProps {
	searchTerm: string;
	serviceFilter: ServiceFilterValue;
	instanceFilter: string;
	includeUnmonitored: boolean;
	instanceOptions: Array<{ value: string; label: string }>;
	onSearchChange: (term: string) => void;
	onServiceFilterChange: (filter: ServiceFilterValue) => void;
	onInstanceFilterChange: (filter: string) => void;
	onIncludeUnmonitoredChange: (include: boolean) => void;
	onResetFilters: () => void;
}

export const CalendarFilters = ({
	searchTerm,
	serviceFilter,
	instanceFilter,
	includeUnmonitored,
	instanceOptions,
	onSearchChange,
	onServiceFilterChange,
	onInstanceFilterChange,
	onIncludeUnmonitoredChange,
	onResetFilters,
}: CalendarFiltersProps) => {
	const { gradient: themeGradient } = useThemeGradient();

	const isFilterActive =
		serviceFilter !== "all" ||
		instanceFilter !== "all" ||
		searchTerm.trim().length > 0 ||
		includeUnmonitored;

	return (
		<div
			className="rounded-2xl border border-border/50 bg-card/30 backdrop-blur-xs overflow-hidden animate-in fade-in slide-in-from-bottom-4 duration-500"
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
					<p className="text-sm text-muted-foreground">Narrow down your calendar view</p>
				</div>
			</div>

			{/* Filter Controls */}
			<div className="flex flex-wrap items-end gap-4 p-6">
				<div className="flex min-w-[200px] flex-1 flex-col gap-1.5">
					<label
						className="text-xs font-medium text-muted-foreground uppercase tracking-wide"
						htmlFor="calendar-search"
					>
						Search
					</label>
					<Input
						id="calendar-search"
						value={searchTerm}
						onChange={(event) => onSearchChange(event.target.value)}
						placeholder="Search titles or descriptions"
						className="bg-background/50 border-border/50 focus:border-primary"
					/>
				</div>

				<div className="flex min-w-[140px] flex-col gap-1.5">
					<label
						className="text-xs font-medium text-muted-foreground uppercase tracking-wide"
						htmlFor="calendar-service-filter"
					>
						Service
					</label>
					<select
						id="calendar-service-filter"
						value={serviceFilter}
						onChange={(event) => onServiceFilterChange(event.target.value as ServiceFilterValue)}
						className="rounded-lg border border-border/50 bg-background/50 px-3 py-2 text-sm focus:border-primary focus:outline-hidden focus:ring-1 focus:ring-primary/20 [&>option]:bg-background [&>option]:text-foreground"
					>
						{SERVICE_FILTERS.map((option) => (
							<option key={option.value} value={option.value}>
								{option.label}
							</option>
						))}
					</select>
				</div>

				<div className="flex min-w-[180px] flex-col gap-1.5">
					<label
						className="text-xs font-medium text-muted-foreground uppercase tracking-wide"
						htmlFor="calendar-instance-filter"
					>
						Instance
					</label>
					<select
						id="calendar-instance-filter"
						value={instanceFilter}
						onChange={(event) => onInstanceFilterChange(event.target.value)}
						className="rounded-lg border border-border/50 bg-background/50 px-3 py-2 text-sm focus:border-primary focus:outline-hidden focus:ring-1 focus:ring-primary/20 [&>option]:bg-background [&>option]:text-foreground"
					>
						<option value="all">All instances</option>
						{instanceOptions.map((option) => (
							<option key={option.value} value={option.value}>
								{option.label}
							</option>
						))}
					</select>
				</div>

				<div className="ml-auto flex items-center gap-4">
					<label className="flex items-center gap-2 text-sm text-muted-foreground cursor-pointer hover:text-foreground transition-colors">
						<input
							type="checkbox"
							checked={includeUnmonitored}
							onChange={(event) => onIncludeUnmonitoredChange(event.target.checked)}
							className="rounded border-border/50 bg-background/50 text-primary focus:ring-primary/20"
						/>
						Include unmonitored
					</label>

					<Button
						variant="ghost"
						size="sm"
						onClick={onResetFilters}
						disabled={!isFilterActive}
						className="gap-2"
					>
						<RotateCcw className="h-4 w-4" />
						Reset
					</Button>
				</div>
			</div>
		</div>
	);
};
