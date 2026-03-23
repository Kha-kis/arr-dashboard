"use client";

import { ChevronLeft, ChevronRight, Dot, RefreshCw } from "lucide-react";
import { useRefreshState } from "../../../hooks/useRefreshState";
import { useThemeGradient } from "../../../hooks/useThemeGradient";
import { formatMonthLabel } from "../lib/calendar-formatters";

interface CalendarHeaderProps {
	monthStart: Date;
	isLoading: boolean;
	onPreviousMonth: () => void;
	onNextMonth: () => void;
	onGoToday: () => void;
	onRefresh: () => void;
}

export const CalendarHeader = ({
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
		<header
			className="animate-in fade-in slide-in-from-bottom-2 duration-400"
			style={{ animationFillMode: "backwards" }}
		>
			<div className="flex items-center justify-between gap-4">
				{/* Left: Title + Month Navigation */}
				<div className="flex items-center gap-5">
					{/* Title with ambient glow */}
					<div className="relative">
						<h1 className="text-[22px] font-bold tracking-tight relative z-10">
							<span
								style={{
									background: `linear-gradient(135deg, ${themeGradient.from}, ${themeGradient.to})`,
									WebkitBackgroundClip: "text",
									WebkitTextFillColor: "transparent",
									backgroundClip: "text",
								}}
							>
								Calendar
							</span>
						</h1>
						{/* Ambient radial glow */}
						<div
							className="absolute -inset-6 -z-10 blur-2xl rounded-full"
							style={{
								background: `radial-gradient(circle, ${themeGradient.from}12, transparent 70%)`,
							}}
						/>
					</div>

					{/* Separator */}
					<span className="w-px h-7 bg-border/15" />

					{/* Month nav */}
					<div className="flex items-center gap-0.5">
						<button
							type="button"
							onClick={onPreviousMonth}
							className="rounded-lg p-1.5 text-muted-foreground/35 hover:text-foreground hover:bg-white/[0.04] transition-all"
							aria-label="Previous month"
						>
							<ChevronLeft className="h-4 w-4" />
						</button>

						<span className="min-w-[155px] text-center text-[15px] font-semibold text-foreground tracking-tight">
							{label}
						</span>

						<button
							type="button"
							onClick={onNextMonth}
							className="rounded-lg p-1.5 text-muted-foreground/35 hover:text-foreground hover:bg-white/[0.04] transition-all"
							aria-label="Next month"
						>
							<ChevronRight className="h-4 w-4" />
						</button>
					</div>
				</div>

				{/* Right: Actions */}
				<div className="flex items-center gap-1">
					<button
						type="button"
						onClick={onGoToday}
						className="rounded-lg px-3 py-1.5 text-xs font-semibold transition-all hover:bg-white/[0.04]"
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
						className="rounded-lg p-1.5 text-muted-foreground/35 hover:text-foreground hover:bg-white/[0.04] transition-all disabled:opacity-30"
						aria-label="Refresh calendar"
					>
						<RefreshCw
							className={`h-3.5 w-3.5 transition-transform duration-500 ${isRefreshing ? "animate-spin" : ""}`}
						/>
					</button>
				</div>
			</div>
		</header>
	);
};
