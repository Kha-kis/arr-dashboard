"use client";

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
		<div className="flex flex-wrap items-end gap-3 rounded-lg border border-border bg-bg-subtle px-4 py-3">
			<FormField label="Service" htmlFor="queue-service-filter" className="min-w-[160px]">
				<select
					id="queue-service-filter"
					value={serviceFilter}
					onChange={(event) => onServiceFilterChange(event.target.value)}
					className="rounded-md border border-border bg-bg px-3 py-2 text-sm text-fg focus:border-sky-400 focus:outline-none focus:ring-1 focus:ring-sky-400"
				>
					{serviceOptions.map((option) => (
						<option key={option.value} value={option.value} className="bg-bg text-fg">
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
					className="rounded-md border border-border bg-bg px-3 py-2 text-sm text-fg focus:border-sky-400 focus:outline-none focus:ring-1 focus:ring-sky-400"
				>
					<option value="all" className="bg-bg text-fg">
						All instances
					</option>
					{instanceOptions.map((option) => (
						<option key={option.value} value={option.value} className="bg-bg text-fg">
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
					className="rounded-md border border-border bg-bg px-3 py-2 text-sm text-fg focus:border-sky-400 focus:outline-none focus:ring-1 focus:ring-sky-400"
				>
					<option value="all" className="bg-bg text-fg">
						All statuses
					</option>
					{statusOptions.map((option) => (
						<option key={option.value} value={option.value} className="bg-bg text-fg">
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
