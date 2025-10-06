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
  a.getUTCFullYear() === b.getUTCFullYear() &&
  a.getUTCMonth() === b.getUTCMonth();

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
            "flex min-h-[110px] flex-col rounded-xl border px-3 py-2 text-left transition",
            isSelected
              ? "border-sky-400 bg-sky-500/15 shadow-lg shadow-sky-500/20"
              : hasEvents
                ? "border-white/15 bg-slate-900/60 hover:border-sky-400"
                : "border-white/10 bg-slate-900/40 hover:border-white/25",
            inCurrentMonth ? "text-white" : "text-white/40",
          )}
        >
          <div className="flex items-center justify-between text-xs font-semibold uppercase tracking-wide">
            <span>{formatDayNumber(date)}</span>
            {hasEvents && (
              <span className="rounded-full bg-white/20 px-2 py-0.5 text-[10px] text-white/80">
                {events.length}
              </span>
            )}
          </div>
          <div className="mt-2 space-y-1">
            {events.slice(0, 3).map((event) => (
              <div
                key={`${key}:${String(event.id)}`}
                className="truncate rounded-md bg-white/15 px-2 py-1 text-xs text-white/80"
              >
                <span className="font-medium text-white">
                  {event.service === "sonarr"
                    ? (event.seriesTitle ?? event.title)
                    : (event.movieTitle ?? event.title)}
                </span>
                {event.type === "episode" && event.episodeTitle && (
                  <span className="ml-1 text-white/60">
                    {event.episodeTitle}
                  </span>
                )}
              </div>
            ))}
            {events.length > 3 && (
              <p className="text-[11px] text-white/60">
                +{events.length - 3} more
              </p>
            )}
          </div>
        </button>
      );
    })}
  </div>
);
