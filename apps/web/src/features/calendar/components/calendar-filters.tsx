import { Button } from "../../../components/ui/button";
import { Input } from "../../../components/ui/input";
import type { ServiceFilterValue } from "../hooks/use-calendar-state";

const SERVICE_FILTERS = [
	{ value: "all" as const, label: "All" },
	{ value: "sonarr" as const, label: "Sonarr" },
	{ value: "radarr" as const, label: "Radarr" },
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
	const isFilterActive =
		serviceFilter !== "all" ||
		instanceFilter !== "all" ||
		searchTerm.trim().length > 0 ||
		includeUnmonitored;

	return (
		<div className="flex flex-wrap items-end gap-3 rounded-lg border border-white/10 bg-white/5 px-4 py-3">
			<div className="flex min-w-[200px] flex-col gap-1 text-sm text-white/80">
				<label className="text-xs uppercase text-white/50" htmlFor="calendar-search">
					Search
				</label>
				<Input
					id="calendar-search"
					value={searchTerm}
					onChange={(event) => onSearchChange(event.target.value)}
					placeholder="Search titles or descriptions"
					className="border-white/20 bg-slate-900/80 text-white placeholder:text-white/40"
				/>
			</div>
			<div className="flex min-w-[160px] flex-col gap-1 text-sm text-white/80">
				<label className="text-xs uppercase text-white/50" htmlFor="calendar-service-filter">
					Service
				</label>
				<select
					id="calendar-service-filter"
					value={serviceFilter}
					onChange={(event) => onServiceFilterChange(event.target.value as ServiceFilterValue)}
					className="rounded-md border border-white/20 bg-slate-900/80 px-3 py-2 text-sm text-white focus:border-sky-400 focus:outline-none focus:ring-1 focus:ring-sky-400"
					style={{ color: "#f8fafc" }}
				>
					{SERVICE_FILTERS.map((option) => (
						<option key={option.value} value={option.value} className="bg-slate-900 text-white">
							{option.label}
						</option>
					))}
				</select>
			</div>
			<div className="flex min-w-[200px] flex-col gap-1 text-sm text-white/80">
				<label className="text-xs uppercase text-white/50" htmlFor="calendar-instance-filter">
					Instance
				</label>
				<select
					id="calendar-instance-filter"
					value={instanceFilter}
					onChange={(event) => onInstanceFilterChange(event.target.value)}
					className="rounded-md border border-white/20 bg-slate-900/80 px-3 py-2 text-sm text-white focus:border-sky-400 focus:outline-none focus:ring-1 focus:ring-sky-400"
					style={{ color: "#f8fafc" }}
				>
					<option value="all" className="bg-slate-900 text-white">
						All instances
					</option>
					{instanceOptions.map((option) => (
						<option key={option.value} value={option.value} className="bg-slate-900 text-white">
							{option.label}
						</option>
					))}
				</select>
			</div>
			<label className="flex items-center gap-2 text-sm text-white/70">
				<input
					type="checkbox"
					checked={includeUnmonitored}
					onChange={(event) => onIncludeUnmonitoredChange(event.target.checked)}
					className="h-4 w-4"
				/>
				Include unmonitored items
			</label>
			<div className="ml-auto">
				<Button variant="ghost" onClick={onResetFilters} disabled={!isFilterActive}>
					Reset filters
				</Button>
			</div>
		</div>
	);
};
