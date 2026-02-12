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
import {
	PremiumSkeleton,
	GlassmorphicCard,
} from "../../../components/layout";

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

	// Loading skeleton
	if (isLoading) {
		return (
			<div className="space-y-8 animate-in fade-in duration-500">
				<div className="space-y-4">
					<PremiumSkeleton className="h-8 w-48" />
					<PremiumSkeleton className="h-10 w-64" />
				</div>
				<GlassmorphicCard padding="md">
					<div className="grid grid-cols-7 gap-2">
						{Array.from({ length: 35 }).map((_, i) => (
							<PremiumSkeleton
								key={i}
								className="h-20"
								style={{ animationDelay: `${i * 20}ms` }}
							/>
						))}
					</div>
				</GlassmorphicCard>
			</div>
		);
	}

	return (
		<>
			{/* Header with navigation */}
			<CalendarHeader
				monthStart={monthStart}
				isLoading={isLoading}
				onPreviousMonth={calendarState.handlePreviousMonth}
				onNextMonth={calendarState.handleNextMonth}
				onGoToday={calendarState.handleGoToday}
				onRefresh={() => void refetch()}
			/>

			{/* Filters */}
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

			{/* Error Alert */}
			{error && (
				<Alert variant="danger">
					<AlertDescription>
						Unable to load calendar data. Please refresh and try again.
					</AlertDescription>
				</Alert>
			)}

			{/* Calendar Grid */}
			<GlassmorphicCard padding="sm" animationDelay={200}>
				<CalendarGrid
					days={daysInView}
					currentMonth={monthStart}
					selectedDate={selectedDate}
					onSelectDate={calendarState.setSelectedDate}
					eventsByDate={eventsByDate}
					className="min-h-[520px]"
				/>
			</GlassmorphicCard>

			{/* Event List */}
			<div
				className="animate-in fade-in slide-in-from-bottom-4 duration-500"
				style={{ animationDelay: "300ms", animationFillMode: "backwards" }}
			>
				<CalendarEventList
					selectedDate={selectedDate}
					selectedEvents={selectedEvents}
					serviceMap={serviceMap}
					onOpenExternal={handleOpenExternal}
				/>
			</div>
		</>
	);
};
