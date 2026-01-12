"use client";

import { cn } from "../../../lib/utils";
import { useThemeGradient } from "../../../hooks/useThemeGradient";
import type { DeduplicatedCalendarItem } from "../hooks/use-calendar-data";

interface CalendarGridProps {
	readonly days: Date[];
	readonly currentMonth: Date;
	readonly selectedDate: Date | null;
	readonly onSelectDate: (date: Date) => void;
	readonly eventsByDate: Map<string, DeduplicatedCalendarItem[]>;
	readonly className?: string;
}

const formatDateKey = (date: Date): string => {
	const iso = date.toISOString();
	const index = iso.indexOf("T");
	return index === -1 ? iso : iso.slice(0, index);
};

const isSameDay = (a: Date | null, b: Date): boolean => {
	if (!a) {
		return false;
	}
	return (
		a.getUTCFullYear() === b.getUTCFullYear() &&
		a.getUTCMonth() === b.getUTCMonth() &&
		a.getUTCDate() === b.getUTCDate()
	);
};

const isSameMonth = (a: Date, b: Date): boolean =>
	a.getUTCFullYear() === b.getUTCFullYear() && a.getUTCMonth() === b.getUTCMonth();

const formatDayNumber = (date: Date): string =>
	new Intl.DateTimeFormat(undefined, { day: "numeric" }).format(date);

export const CalendarGrid = ({
	days,
	currentMonth,
	selectedDate,
	onSelectDate,
	eventsByDate,
	className,
}: CalendarGridProps) => {
	const { gradient: themeGradient } = useThemeGradient();

	return (
		<div className={cn("grid grid-cols-7 gap-2", className)}>
		{days.map((date) => {
			const key = formatDateKey(date);
			const events = eventsByDate.get(key) ?? [];
			const inCurrentMonth = isSameMonth(currentMonth, date);
			const isSelected = isSameDay(selectedDate, date);
			const hasEvents = events.length > 0;

			return (
				<button
					key={key}
					type="button"
					onClick={() => onSelectDate(date)}
					className={cn(
						"flex h-[140px] flex-col rounded-xl border px-3 py-2 text-left transition",
						isSelected
							? ""
							: hasEvents
								? "border-border bg-card"
								: "border-border bg-background hover:border-border",
						inCurrentMonth ? "text-foreground" : "text-muted-foreground",
					)}
					style={
						isSelected
							? {
									borderColor: themeGradient.from,
									backgroundColor: themeGradient.fromLight,
									boxShadow: `0 10px 15px -3px ${themeGradient.glow}`,
								}
							: hasEvents
								? { ["--hover-border-color" as string]: themeGradient.from }
								: undefined
					}
					onMouseEnter={(e) => {
						if (!isSelected && hasEvents) {
							e.currentTarget.style.borderColor = themeGradient.from;
						}
					}}
					onMouseLeave={(e) => {
						if (!isSelected && hasEvents) {
							e.currentTarget.style.borderColor = "";
						}
					}}
				>
					<div className="flex shrink-0 items-center justify-between text-xs font-semibold uppercase tracking-wide">
						<span>{formatDayNumber(date)}</span>
						{hasEvents && (
							<span className="rounded-full bg-card px-2 py-0.5 text-[10px] text-muted-foreground">
								{events.length}
							</span>
						)}
					</div>
					<div className="mt-2 min-h-0 flex-1 space-y-1 overflow-y-auto [&::-webkit-scrollbar]:w-1 [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-white/20 [&::-webkit-scrollbar-track]:bg-transparent">
						{events.map((event) => (
							<div
								key={`${key}:${String(event.id)}`}
								className="truncate rounded-md bg-card px-2 py-1 text-xs text-muted-foreground"
							>
								<span className="font-medium text-foreground">
									{event.service === "sonarr"
										? (event.seriesTitle ?? event.title)
										: (event.movieTitle ?? event.title)}
								</span>
								{event.type === "episode" && event.episodeTitle && (
									<span className="ml-1 text-muted-foreground">{event.episodeTitle}</span>
								)}
							</div>
						))}
					</div>
				</button>
			);
		})}
		</div>
	);
};
