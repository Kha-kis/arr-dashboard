"use client";

import { CalendarDays, ChevronLeft, ChevronRight, Dot, RefreshCw } from "lucide-react";
import { DataFreshness, PremiumPageHeader } from "../../../components/layout";
import { POLLING_STANDARD } from "../../../lib/polling-intervals";
import { useRefreshState } from "../../../hooks/useRefreshState";
import { useThemeGradient } from "../../../hooks/useThemeGradient";
import { formatMonthLabel } from "../lib/calendar-formatters";

interface CalendarHeaderProps {
	dataUpdatedAt?: number;
	isFetching?: boolean;
	isError?: boolean;
	monthStart: Date;
	isLoading: boolean;
	onPreviousMonth: () => void;
	onNextMonth: () => void;
	onGoToday: () => void;
	onRefresh: () => void;
}

export const CalendarHeader = ({
	dataUpdatedAt,
	isFetching,
	isError,
	monthStart,
	isLoading,
	onPreviousMonth,
	onNextMonth,
	onGoToday,
	onRefresh,
}: CalendarHeaderProps) => {
	const { gradient: themeGradient } = useThemeGradient();
	const [isRefreshing, handleRefresh] = useRefreshState(onRefresh);

	const label = formatMonthLabel(monthStart);

	return (
		<PremiumPageHeader
			label="Media planning"
			labelIcon={CalendarDays}
			title="Calendar"
			gradientTitle
			description="Plan upcoming releases across your connected media services."
			actions={
				<div className="flex flex-wrap items-center gap-2">
					<div className="flex items-center gap-0.5 rounded-lg border border-border/50 bg-card/30 p-0.5">
						<button
							type="button"
							onClick={onPreviousMonth}
							className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
							aria-label="Previous month"
						>
							<ChevronLeft className="h-4 w-4" />
						</button>

						<span className="min-w-36 text-center text-sm font-semibold text-foreground">
							{label}
						</span>

						<button
							type="button"
							onClick={onNextMonth}
							className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
							aria-label="Next month"
						>
							<ChevronRight className="h-4 w-4" />
						</button>
					</div>
					{/* Calendar feed freshness (single polled query drives the grid) */}
					<DataFreshness
						dataUpdatedAt={dataUpdatedAt}
						isFetching={isFetching}
						isError={isError}
						pollIntervalMs={POLLING_STANDARD}
					/>
					<button
						type="button"
						onClick={onGoToday}
						className="rounded-md px-3 py-1.5 text-xs font-semibold transition-colors hover:bg-accent"
						style={{
							color: themeGradient.from,
						}}
					>
						<Dot className="h-4 w-4 inline -ml-1 -mr-0.5" />
						Today
					</button>

					<button
						type="button"
						onClick={handleRefresh}
						disabled={isLoading}
						className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-30"
						aria-label="Refresh calendar"
					>
						<RefreshCw
							className={`h-3.5 w-3.5 transition-transform duration-500 ${isRefreshing ? "animate-spin" : ""}`}
						/>
					</button>
				</div>
			}
		/>
	);
};
