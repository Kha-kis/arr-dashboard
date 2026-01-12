import type { ServiceInstanceSummary } from "@arr/shared";
import type { DeduplicatedCalendarItem } from "../hooks/use-calendar-data";
import { formatLongDate } from "../lib/calendar-formatters";
import { CalendarEventCard } from "./calendar-event-card";

interface CalendarEventListProps {
	selectedDate: Date | null;
	selectedEvents: DeduplicatedCalendarItem[];
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
		<div className="rounded-2xl border border-border bg-card p-4">
			<div className="flex flex-wrap items-center justify-between gap-2">
				<div>
					<h2 className="text-lg font-semibold text-foreground">
						{selectedDate ? formatLongDate(selectedDate) : "Select a date"}
					</h2>
					<p className="text-xs uppercase text-muted-foreground">
						{selectedEvents.length} scheduled item
						{selectedEvents.length === 1 ? "" : "s"}
					</p>
				</div>
			</div>
			{selectedEvents.length === 0 ? (
				<p className="mt-4 text-sm text-muted-foreground">No scheduled items for this date.</p>
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
