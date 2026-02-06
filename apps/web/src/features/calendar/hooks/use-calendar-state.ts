import { useCallback, useEffect, useMemo, useState } from "react";
import type { CalendarItem } from "@arr/shared";
import { createMonthDate, formatDateOnly } from "../lib/calendar-formatters";

export type ServiceFilterValue = "all" | "sonarr" | "radarr" | "lidarr" | "readarr";

export interface CalendarFilters {
	serviceFilter: ServiceFilterValue;
	instanceFilter: string;
	searchTerm: string;
	includeUnmonitored: boolean;
}

export interface CalendarState {
	// Date state
	currentMonth: Date;
	selectedDate: Date | null;
	monthStart: Date;
	monthEnd: Date;
	calendarStart: Date;
	calendarEnd: Date;
	daysInView: Date[];

	// Filter state
	filters: CalendarFilters;

	// Actions
	setSelectedDate: (date: Date | null) => void;
	handlePreviousMonth: () => void;
	handleNextMonth: () => void;
	handleGoToday: () => void;
	setServiceFilter: (filter: ServiceFilterValue) => void;
	setInstanceFilter: (filter: string) => void;
	setSearchTerm: (term: string) => void;
	setIncludeUnmonitored: (include: boolean) => void;
	resetFilters: () => void;
}

export const useCalendarState = (): CalendarState => {
	const [currentMonth, setCurrentMonth] = useState(() => {
		const now = new Date();
		return createMonthDate(now.getUTCFullYear(), now.getUTCMonth());
	});

	const [selectedDate, setSelectedDate] = useState<Date | null>(null);
	const [serviceFilter, setServiceFilter] = useState<ServiceFilterValue>("all");
	const [instanceFilter, setInstanceFilter] = useState<string>("all");
	const [searchTerm, setSearchTerm] = useState("");
	const [includeUnmonitored, setIncludeUnmonitored] = useState(false);

	const { monthStart, monthEnd, calendarStart, calendarEnd } = useMemo(() => {
		const start = createMonthDate(currentMonth.getUTCFullYear(), currentMonth.getUTCMonth());
		const end = new Date(start);
		end.setUTCMonth(end.getUTCMonth() + 1);
		end.setUTCDate(0);

		const calendarStartDate = new Date(start);
		calendarStartDate.setUTCDate(calendarStartDate.getUTCDate() - calendarStartDate.getUTCDay());

		const calendarEndDate = new Date(end);
		calendarEndDate.setUTCDate(calendarEndDate.getUTCDate() + (6 - calendarEndDate.getUTCDay()));

		return {
			monthStart: start,
			monthEnd: end,
			calendarStart: calendarStartDate,
			calendarEnd: calendarEndDate,
		};
	}, [currentMonth]);

	const daysInView = useMemo(() => {
		const days: Date[] = [];
		const cursor = new Date(calendarStart);
		while (cursor.getTime() <= calendarEnd.getTime()) {
			days.push(new Date(cursor));
			cursor.setUTCDate(cursor.getUTCDate() + 1);
		}
		return days;
	}, [calendarStart, calendarEnd]);

	// Auto-select today or first day when days change
	useEffect(() => {
		if (!selectedDate) {
			const todayKey = formatDateOnly(new Date());
			for (const day of daysInView) {
				if (formatDateOnly(day) === todayKey) {
					setSelectedDate(day);
					return;
				}
			}
			setSelectedDate(daysInView[0] ?? null);
		}
	}, [daysInView, selectedDate]);

	const handlePreviousMonth = useCallback(() => {
		const prev = new Date(monthStart);
		prev.setUTCMonth(prev.getUTCMonth() - 1);
		setCurrentMonth(prev);
		setSelectedDate(null);
	}, [monthStart]);

	const handleNextMonth = useCallback(() => {
		const next = new Date(monthStart);
		next.setUTCMonth(next.getUTCMonth() + 1);
		setCurrentMonth(next);
		setSelectedDate(null);
	}, [monthStart]);

	const handleGoToday = useCallback(() => {
		const today = new Date();
		const month = createMonthDate(today.getUTCFullYear(), today.getUTCMonth());
		setCurrentMonth(month);
		setSelectedDate(null);
	}, []);

	const resetFilters = useCallback(() => {
		setSearchTerm("");
		setServiceFilter("all");
		setInstanceFilter("all");
		setIncludeUnmonitored(false);
	}, []);

	return {
		currentMonth,
		selectedDate,
		monthStart,
		monthEnd,
		calendarStart,
		calendarEnd,
		daysInView,
		filters: {
			serviceFilter,
			instanceFilter,
			searchTerm,
			includeUnmonitored,
		},
		setSelectedDate,
		handlePreviousMonth,
		handleNextMonth,
		handleGoToday,
		setServiceFilter,
		setInstanceFilter,
		setSearchTerm,
		setIncludeUnmonitored,
		resetFilters,
	};
};
