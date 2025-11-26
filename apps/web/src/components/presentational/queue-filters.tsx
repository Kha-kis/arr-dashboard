/**
 * Queue Filters - Presentational Component
 *
 * Filter controls for queue items (service, instance, status).
 * Includes reset button when filters are active.
 * Pure UI component with no business logic.
 */

import { Button, FormField } from "../ui";

interface FilterOption {
	value: string;
	label: string;
}

interface QueueFiltersProps {
	// Service filter
	serviceFilter: string;
	onServiceFilterChange: (value: string) => void;
	serviceOptions: readonly FilterOption[];

	// Instance filter
	instanceFilter: string;
	onInstanceFilterChange: (value: string) => void;
	instanceOptions: FilterOption[];

	// Status filter
	statusFilter: string;
	onStatusFilterChange: (value: string) => void;
	statusOptions: FilterOption[];

	// Reset
	filtersActive: boolean;
	onReset: () => void;
}

export const QueueFilters = ({
	serviceFilter,
	onServiceFilterChange,
	serviceOptions,
	instanceFilter,
	onInstanceFilterChange,
	instanceOptions,
	statusFilter,
	onStatusFilterChange,
	statusOptions,
	filtersActive,
	onReset,
}: QueueFiltersProps) => {
	return (
		<div className="flex flex-wrap items-end gap-3 rounded-lg border border-white/10 bg-white/5 px-4 py-3">
			<FormField label="Service" htmlFor="queue-service-filter" className="min-w-[160px]">
				<select
					id="queue-service-filter"
					value={serviceFilter}
					onChange={(event) => onServiceFilterChange(event.target.value)}
					className="rounded-md border border-white/20 bg-slate-900/80 px-3 py-2 text-sm text-white focus:border-sky-400 focus:outline-none focus:ring-1 focus:ring-sky-400"
					style={{ color: "#f8fafc" }}
				>
					{serviceOptions.map((option) => (
						<option key={option.value} value={option.value} className="bg-slate-900 text-white">
							{option.label}
						</option>
					))}
				</select>
			</FormField>

			<FormField label="Instance" htmlFor="queue-instance-filter" className="min-w-[200px]">
				<select
					id="queue-instance-filter"
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
			</FormField>

			<FormField label="Status" htmlFor="queue-status-filter" className="min-w-[200px]">
				<select
					id="queue-status-filter"
					value={statusFilter}
					onChange={(event) => onStatusFilterChange(event.target.value)}
					className="rounded-md border border-white/20 bg-slate-900/80 px-3 py-2 text-sm text-white focus:border-sky-400 focus:outline-none focus:ring-1 focus:ring-sky-400"
					style={{ color: "#f8fafc" }}
				>
					<option value="all" className="bg-slate-900 text-white">
						All statuses
					</option>
					{statusOptions.map((option) => (
						<option key={option.value} value={option.value} className="bg-slate-900 text-white">
							{option.label}
						</option>
					))}
				</select>
			</FormField>

			<div className="ml-auto">
				<Button variant="ghost" onClick={onReset} disabled={!filtersActive}>
					Reset
				</Button>
			</div>
		</div>
	);
};
