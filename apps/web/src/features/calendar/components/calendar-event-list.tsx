"use client";

import type { ServiceInstanceSummary } from "@arr/shared";
import { CalendarDays } from "lucide-react";
import { useThemeGradient } from "../../../hooks/useThemeGradient";
import type { DeduplicatedCalendarItem } from "../hooks/use-calendar-data";
import { formatLongDate } from "../lib/calendar-formatters";
import { CalendarEventCard } from "./calendar-event-card";

interface CalendarEventListProps {
	selectedDate: Date | null;
	selectedEvents: DeduplicatedCalendarItem[];
	serviceMap: Map<string, ServiceInstanceSummary>;
	onOpenExternal: (href: string) => void;
	plexUrlMap: Map<string, string>;
}

export const CalendarEventList = ({
	selectedDate,
	selectedEvents,
	serviceMap,
	onOpenExternal,
	plexUrlMap,
}: CalendarEventListProps) => {
	const { gradient: themeGradient } = useThemeGradient();

	return (
		<div className="rounded-2xl border border-border/10 bg-card/[0.03] overflow-hidden">
			{/* Panel header */}
			<div className="px-5 py-4 border-b border-border/[0.06]">
				<div className="flex items-center gap-3">
					{/* Gradient icon container */}
					<div
						className="h-8 w-8 rounded-lg flex items-center justify-center shrink-0"
						style={{
							background: `linear-gradient(135deg, ${themeGradient.from}15, ${themeGradient.to}08)`,
						}}
					>
						<CalendarDays
							className="h-4 w-4"
							style={{ color: themeGradient.from }}
						/>
					</div>

					<div className="min-w-0 flex-1">
						<h2 className="text-sm font-semibold text-foreground truncate">
							{selectedDate
								? formatLongDate(selectedDate)
								: "Select a date"}
						</h2>
						{selectedEvents.length > 0 && (
							<span className="text-[10px] text-muted-foreground/35 font-medium">
								{selectedEvents.length} item
								{selectedEvents.length !== 1 ? "s" : ""} scheduled
							</span>
						)}
					</div>

					{/* Count badge */}
					{selectedEvents.length > 0 && (
						<span
							className="text-[11px] font-bold tabular-nums rounded-full px-2.5 py-0.5 shrink-0"
							style={{
								backgroundColor: `${themeGradient.from}10`,
								color: `${themeGradient.from}`,
							}}
						>
							{selectedEvents.length}
						</span>
					)}
				</div>
			</div>

			{/* Events content */}
			<div className="p-4">
				{selectedEvents.length === 0 ? (
					<div className="py-10 text-center">
						<div
							className="h-12 w-12 mx-auto mb-3 rounded-xl flex items-center justify-center"
							style={{
								background: `linear-gradient(135deg, ${themeGradient.from}08, ${themeGradient.to}04)`,
							}}
						>
							<CalendarDays
								className="h-6 w-6"
								style={{ color: `${themeGradient.from}25` }}
							/>
						</div>
						<p className="text-xs text-muted-foreground/25 font-medium">
							{selectedDate
								? "No scheduled items for this date"
								: "Select a date to view events"}
						</p>
					</div>
				) : (
					<div className="space-y-2.5">
						{selectedEvents.map((event, index) => (
							<CalendarEventCard
								key={`${event.service}:${event.instanceId}:${String(event.id)}`}
								event={event}
								serviceMap={serviceMap}
								onOpenExternal={onOpenExternal}
								plexUrlMap={plexUrlMap}
								index={index}
							/>
						))}
					</div>
				)}
			</div>
		</div>
	);
};
