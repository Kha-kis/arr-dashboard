"use client";

import { useCallback, useMemo } from "react";
import { useMultiInstanceCalendarQuery } from "../../../hooks/api/useDashboard";
import { useServicesQuery } from "../../../hooks/api/useServicesQuery";
import { Alert, AlertDescription } from "../../../components/ui";
import { safeOpenUrl } from "../../../lib/utils/url-validation";
import { formatDateOnly } from "../lib/calendar-formatters";
import { useCalendarState } from "../hooks/use-calendar-state";
import { useCalendarData } from "../hooks/use-calendar-data";
import { CalendarHeader } from "./calendar-header";
import { CalendarFilters } from "./calendar-filters";
import { CalendarGrid } from "./calendar-grid";
import { CalendarEventList } from "./calendar-event-list";

export const CalendarClient = () => {
	const calendarState = useCalendarState();
	const { calendarStart, calendarEnd, filters, monthStart, selectedDate, daysInView } =
		calendarState;

	const queryParams = useMemo(
		() => ({
			start: formatDateOnly(calendarStart),
			end: formatDateOnly(calendarEnd),
			unmonitored: filters.includeUnmonitored,
		}),
		[calendarStart, calendarEnd, filters.includeUnmonitored],
	);

	const { data, isLoading, error, refetch } = useMultiInstanceCalendarQuery(queryParams);

	const { data: services } = useServicesQuery();

	const calendarData = useCalendarData(data, services, filters);
	const { eventsByDate, serviceMap, instanceOptions } = calendarData;

	const handleOpenExternal = useCallback((href: string) => {
		if (!href) {
			return;
		}
		safeOpenUrl(href);
	}, []);

	const selectedKey = selectedDate ? formatDateOnly(selectedDate) : undefined;
	const selectedEvents = selectedKey ? (eventsByDate.get(selectedKey) ?? []) : [];

	return (
		<section className="flex flex-col gap-10">
			<CalendarHeader
				monthStart={monthStart}
				isLoading={isLoading}
				onPreviousMonth={calendarState.handlePreviousMonth}
				onNextMonth={calendarState.handleNextMonth}
				onGoToday={calendarState.handleGoToday}
				onRefresh={() => void refetch()}
			/>

			<CalendarFilters
				searchTerm={filters.searchTerm}
				serviceFilter={filters.serviceFilter}
				instanceFilter={filters.instanceFilter}
				includeUnmonitored={filters.includeUnmonitored}
				instanceOptions={instanceOptions}
				onSearchChange={calendarState.setSearchTerm}
				onServiceFilterChange={calendarState.setServiceFilter}
				onInstanceFilterChange={calendarState.setInstanceFilter}
				onIncludeUnmonitoredChange={calendarState.setIncludeUnmonitored}
				onResetFilters={calendarState.resetFilters}
			/>

			{error && (
				<Alert variant="danger">
					<AlertDescription>
						Unable to load calendar data. Please refresh and try again.
					</AlertDescription>
				</Alert>
			)}

			<div className="rounded-2xl border border-border bg-bg-subtle p-4">
				<CalendarGrid
					days={daysInView}
					currentMonth={monthStart}
					selectedDate={selectedDate}
					onSelectDate={calendarState.setSelectedDate}
					eventsByDate={eventsByDate}
					className="min-h-[520px]"
				/>
			</div>

			<CalendarEventList
				selectedDate={selectedDate}
				selectedEvents={selectedEvents}
				serviceMap={serviceMap}
				onOpenExternal={handleOpenExternal}
			/>
		</section>
	);
};
