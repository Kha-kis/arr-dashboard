"use client";

import type { CalendarItem } from "@arr/shared";
import { cn } from "../../../lib/utils";

interface CalendarGridProps {
	readonly days: Date[];
	readonly currentMonth: Date;
	readonly selectedDate: Date | null;
	readonly onSelectDate: (date: Date) => void;
	readonly eventsByDate: Map<string, CalendarItem[]>;
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
}: CalendarGridProps) => (
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
							? "border-sky-400 bg-sky-500/15 shadow-lg shadow-sky-500/20"
							: hasEvents
								? "border-border bg-bg-subtle hover:border-sky-400"
								: "border-border bg-bg hover:border-border",
						inCurrentMonth ? "text-fg" : "text-fg-muted",
					)}
				>
					<div className="flex shrink-0 items-center justify-between text-xs font-semibold uppercase tracking-wide">
						<span>{formatDayNumber(date)}</span>
						{hasEvents && (
							<span className="rounded-full bg-bg-subtle px-2 py-0.5 text-[10px] text-fg-muted">
								{events.length}
							</span>
						)}
					</div>
					<div className="mt-2 min-h-0 flex-1 space-y-1 overflow-y-auto [&::-webkit-scrollbar]:w-1 [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-white/20 [&::-webkit-scrollbar-track]:bg-transparent">
						{events.map((event) => (
							<div
								key={`${key}:${String(event.id)}`}
								className="truncate rounded-md bg-bg-subtle px-2 py-1 text-xs text-fg-muted"
							>
								<span className="font-medium text-fg">
									{event.service === "sonarr"
										? (event.seriesTitle ?? event.title)
										: (event.movieTitle ?? event.title)}
								</span>
								{event.type === "episode" && event.episodeTitle && (
									<span className="ml-1 text-fg-muted">{event.episodeTitle}</span>
								)}
							</div>
						))}
					</div>
				</button>
			);
		})}
	</div>
);
