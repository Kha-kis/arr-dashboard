import type { CalendarItem, ServiceInstanceSummary } from "@arr/shared";
import { formatLongDate } from "../lib/calendar-formatters";
import { CalendarEventCard } from "./calendar-event-card";

interface CalendarEventListProps {
  selectedDate: Date | null;
  selectedEvents: CalendarItem[];
  serviceMap: Map<string, ServiceInstanceSummary>;
  onOpenExternal: (href: string) => void;
}

export const CalendarEventList = ({
  selectedDate,
  selectedEvents,
  serviceMap,
  onOpenExternal,
}: CalendarEventListProps) => {
  return (
    <div className="rounded-2xl border border-white/10 bg-slate-950/50 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-lg font-semibold text-white">
            {selectedDate ? formatLongDate(selectedDate) : "Select a date"}
          </h2>
          <p className="text-xs uppercase text-white/40">
            {selectedEvents.length} scheduled item
            {selectedEvents.length === 1 ? "" : "s"}
          </p>
        </div>
      </div>
      {selectedEvents.length === 0 ? (
        <p className="mt-4 text-sm text-white/60">
          No scheduled items for this date.
        </p>
      ) : (
        <div className="mt-4 space-y-3">
          {selectedEvents.map((event) => (
            <CalendarEventCard
              key={`${event.service}:${event.instanceId}:${String(event.id)}`}
              event={event}
              serviceMap={serviceMap}
              onOpenExternal={onOpenExternal}
            />
          ))}
        </div>
      )}
    </div>
  );
};
