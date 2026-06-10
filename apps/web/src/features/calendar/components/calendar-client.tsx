"use client";

import { useCallback, useMemo } from "react";
import { PremiumSkeleton } from "../../../components/layout";
import { Alert, AlertDescription } from "../../../components/ui";
import { useMultiInstanceCalendarQuery } from "../../../hooks/api/useDashboard";
import { useServicesQuery } from "../../../hooks/api/useServicesQuery";
import { safeOpenUrl } from "../../../lib/utils/url-validation";
import { useCalendarData } from "../hooks/use-calendar-data";
import { useCalendarPlexLinks } from "../hooks/use-calendar-plex-links";
import { useFirstDayOfWeek } from "../../../hooks/useFirstDayOfWeek";
import { useCalendarState } from "../hooks/use-calendar-state";
import { formatDateOnly } from "../lib/calendar-formatters";
import { CalendarEventList } from "./calendar-event-list";
import { CalendarFilters } from "./calendar-filters";
import { CalendarGrid } from "./calendar-grid";
import { CalendarHeader } from "./calendar-header";

export const CalendarClient = () => {
	const { weekStart } = useFirstDayOfWeek();
	const calendarState = useCalendarState(weekStart);
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

	const { data, isLoading, error, refetch, dataUpdatedAt, isFetching, isError } =
		useMultiInstanceCalendarQuery(queryParams);

	const { data: services } = useServicesQuery();

	const calendarData = useCalendarData(data, services, filters);
	const { eventsByDate, serviceMap, instanceOptions, filteredEvents } = calendarData;

	// Plex deep links — only fetched when Plex is configured
	const hasPlex = useMemo(
		() => services?.some((s) => s.service === "plex") ?? false,
		[services],
	);
	const plexUrlMap = useCalendarPlexLinks(filteredEvents, hasPlex);

	const handleOpenExternal = useCallback((href: string) => {
		if (!href) return;
		safeOpenUrl(href);
	}, []);

	const selectedKey = selectedDate ? formatDateOnly(selectedDate) : undefined;
	const selectedEvents = selectedKey ? (eventsByDate.get(selectedKey) ?? []) : [];

	// Loading skeleton mirroring the side-by-side layout
	if (isLoading) {
		return (
			<div className="space-y-5 animate-in fade-in duration-500">
				{/* Header skeleton */}
				<div className="flex items-center gap-5">
					<PremiumSkeleton className="h-7 w-24 rounded-lg" />
					<PremiumSkeleton
						className="h-5 w-px"
						style={{ animationDelay: "30ms" }}
					/>
					<PremiumSkeleton
						className="h-7 w-44 rounded-lg"
						style={{ animationDelay: "50ms" }}
					/>
				</div>

				{/* Filter skeleton */}
				<div className="flex gap-2">
					<PremiumSkeleton
						className="h-9 w-60 rounded-xl"
						style={{ animationDelay: "80ms" }}
					/>
					<PremiumSkeleton
						className="h-8 w-[140px] rounded-xl"
						style={{ animationDelay: "100ms" }}
					/>
				</div>

				{/* Side-by-side skeleton */}
				<div className="xl:flex xl:gap-6 xl:items-start">
					{/* Grid skeleton */}
					<div className="xl:flex-1 xl:min-w-0">
						<div className="grid grid-cols-7 gap-px mb-1.5">
							{Array.from({ length: 7 }).map((_, i) => (
								<PremiumSkeleton
									key={i}
									className="h-4 mx-auto w-7 rounded"
									style={{
										animationDelay: `${120 + i * 12}ms`,
									}}
								/>
							))}
						</div>
						<div className="grid grid-cols-7 gap-px rounded-2xl overflow-hidden border border-border/10">
							{Array.from({ length: 42 }).map((_, i) => (
								<PremiumSkeleton
									key={i}
									className="h-[115px] lg:h-[130px]"
									style={{
										animationDelay: `${150 + i * 10}ms`,
									}}
								/>
							))}
						</div>
					</div>

					{/* Panel skeleton */}
					<div className="mt-6 xl:mt-0 xl:w-[380px] xl:shrink-0">
						<div className="rounded-2xl border border-border/10 overflow-hidden">
							<PremiumSkeleton
								className="h-16"
								style={{ animationDelay: "520ms" }}
							/>
							<div className="p-4 space-y-2.5">
								{Array.from({ length: 3 }).map((_, i) => (
									<PremiumSkeleton
										key={i}
										className="h-24 rounded-xl"
										style={{
											animationDelay: `${560 + i * 40}ms`,
										}}
									/>
								))}
							</div>
						</div>
					</div>
				</div>
			</div>
		);
	}

	return (
		<div className="space-y-5">
			{/* Header with navigation */}
			<CalendarHeader
				monthStart={monthStart}
				isLoading={isLoading}
				dataUpdatedAt={dataUpdatedAt}
				isFetching={isFetching}
				isError={isError}
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
						Unable to load calendar data. Please refresh and try
						again.
					</AlertDescription>
				</Alert>
			)}

			{/* Content: Grid + Detail Panel — side-by-side on xl+ screens */}
			<div className="xl:flex xl:gap-6 xl:items-start">
				{/* Calendar Grid */}
				<div
					className="xl:flex-1 xl:min-w-0 animate-in fade-in slide-in-from-bottom-2 duration-400"
					style={{
						animationDelay: "150ms",
						animationFillMode: "backwards",
					}}
				>
					<CalendarGrid
						days={daysInView}
						currentMonth={monthStart}
						selectedDate={selectedDate}
						onSelectDate={calendarState.setSelectedDate}
						eventsByDate={eventsByDate}
						weekStart={weekStart}
					/>
				</div>

				{/* Event Detail Panel — sticky sidebar on xl+ */}
				<div
					className="mt-6 xl:mt-0 xl:w-[380px] xl:shrink-0 animate-in fade-in slide-in-from-bottom-2 duration-400"
					style={{
						animationDelay: "250ms",
						animationFillMode: "backwards",
					}}
				>
					<div className="xl:sticky xl:top-6 xl:max-h-[calc(100vh-3rem)] xl:overflow-y-auto xl:[&::-webkit-scrollbar]:w-1 xl:[&::-webkit-scrollbar-thumb]:rounded-full xl:[&::-webkit-scrollbar-thumb]:bg-white/10">
						<CalendarEventList
							selectedDate={selectedDate}
							selectedEvents={selectedEvents}
							serviceMap={serviceMap}
							onOpenExternal={handleOpenExternal}
							plexUrlMap={plexUrlMap}
						/>
					</div>
				</div>
			</div>
		</div>
	);
};
