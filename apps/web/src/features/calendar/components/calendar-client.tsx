"use client";

import { useCallback, useMemo, useState, useEffect } from "react";
import { useMultiInstanceCalendarQuery } from "../../../hooks/api/useDashboard";
import { useServicesQuery } from "../../../hooks/api/useServicesQuery";
import { Alert, AlertDescription } from "../../../components/ui";
import { AmbientGlow } from "../../../components/layout";
import { safeOpenUrl } from "../../../lib/utils/url-validation";
import { formatDateOnly } from "../lib/calendar-formatters";
import { useCalendarState } from "../hooks/use-calendar-state";
import { useCalendarData } from "../hooks/use-calendar-data";
import { CalendarHeader } from "./calendar-header";
import { CalendarFilters } from "./calendar-filters";
import { CalendarGrid } from "./calendar-grid";
import { CalendarEventList } from "./calendar-event-list";

export const CalendarClient = () => {
	const [mounted, setMounted] = useState(false);
	const calendarState = useCalendarState();
	const { calendarStart, calendarEnd, filters, monthStart, selectedDate, daysInView } =
		calendarState;

	useEffect(() => {
		setMounted(true);
	}, []);

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
	if (!mounted || isLoading) {
		return (
			<section className="relative flex flex-col gap-8">
				<AmbientGlow />
				<div className="space-y-8 animate-in fade-in duration-500">
					<div className="space-y-4">
						<div className="h-8 w-48 rounded-lg bg-muted/50 animate-pulse" />
						<div className="h-10 w-64 rounded-lg bg-muted/30 animate-pulse" />
					</div>
					<div className="rounded-2xl border border-border/30 bg-card/30 p-6">
						<div className="grid grid-cols-7 gap-2">
							{Array.from({ length: 35 }).map((_, i) => (
								<div
									key={i}
									className="h-20 rounded-lg bg-muted/20 animate-pulse"
									style={{ animationDelay: `${i * 20}ms` }}
								/>
							))}
						</div>
					</div>
				</div>
			</section>
		);
	}

	return (
		<section className="relative flex flex-col gap-8">
			{/* Ambient background glow */}
			<AmbientGlow />

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
			<div
				className="rounded-2xl border border-border/50 bg-card/30 backdrop-blur-sm p-4 animate-in fade-in slide-in-from-bottom-4 duration-500"
				style={{ animationDelay: "200ms", animationFillMode: "backwards" }}
			>
				<CalendarGrid
					days={daysInView}
					currentMonth={monthStart}
					selectedDate={selectedDate}
					onSelectDate={calendarState.setSelectedDate}
					eventsByDate={eventsByDate}
					className="min-h-[520px]"
				/>
			</div>

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
		</section>
	);
};
