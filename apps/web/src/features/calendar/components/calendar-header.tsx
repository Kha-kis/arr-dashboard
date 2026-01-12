"use client";

import { Button } from "../../../components/ui/button";
import { formatMonthLabel } from "../lib/calendar-formatters";
import { useThemeGradient } from "../../../hooks/useThemeGradient";
import { Calendar, ChevronLeft, ChevronRight, RefreshCw } from "lucide-react";
import { cn } from "../../../lib/utils";
import { useState } from "react";

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
	const [isRefreshing, setIsRefreshing] = useState(false);

	const handleRefresh = () => {
		setIsRefreshing(true);
		onRefresh();
		setTimeout(() => setIsRefreshing(false), 500);
	};

	return (
		<header
			className="relative animate-in fade-in slide-in-from-bottom-4 duration-500"
			style={{ animationFillMode: "backwards" }}
		>
			<div className="flex items-start justify-between gap-4">
				<div className="space-y-1">
					{/* Label with icon */}
					<div className="flex items-center gap-2 text-sm text-muted-foreground">
						<Calendar className="h-4 w-4" />
						<span>Schedule</span>
					</div>

					{/* Gradient title */}
					<h1 className="text-3xl font-bold tracking-tight">
						<span
							style={{
								background: `linear-gradient(135deg, ${themeGradient.from}, ${themeGradient.to})`,
								WebkitBackgroundClip: "text",
								WebkitTextFillColor: "transparent",
								backgroundClip: "text",
							}}
						>
							Upcoming Releases
						</span>
					</h1>

					{/* Description */}
					<p className="text-muted-foreground max-w-xl">
						Combined calendar view for Sonarr and Radarr instances
					</p>
				</div>

				{/* Navigation Controls */}
				<div className="flex items-center gap-2">
					{/* Month navigation group */}
					<div
						className="flex items-center rounded-xl border border-border/50 bg-card/30 backdrop-blur-sm overflow-hidden"
					>
						<Button
							variant="ghost"
							size="sm"
							onClick={onPreviousMonth}
							className="rounded-none border-r border-border/50 px-3"
						>
							<ChevronLeft className="h-4 w-4" />
						</Button>
						<span
							className="min-w-[140px] px-4 py-2 text-center text-sm font-medium"
							style={{ color: themeGradient.from }}
						>
							{formatMonthLabel(monthStart)}
						</span>
						<Button
							variant="ghost"
							size="sm"
							onClick={onNextMonth}
							className="rounded-none border-l border-border/50 px-3"
						>
							<ChevronRight className="h-4 w-4" />
						</Button>
					</div>

					{/* Today button */}
					<Button
						variant="ghost"
						size="sm"
						onClick={onGoToday}
						className="border border-border/50 bg-card/30 backdrop-blur-sm"
					>
						Today
					</Button>

					{/* Refresh button */}
					<Button
						variant="secondary"
						size="sm"
						onClick={handleRefresh}
						disabled={isLoading}
						className={cn(
							"relative overflow-hidden transition-all duration-300",
							isRefreshing && "pointer-events-none"
						)}
					>
						<RefreshCw
							className={cn(
								"h-4 w-4 transition-transform duration-500",
								isRefreshing && "animate-spin"
							)}
						/>
						{isRefreshing && (
							<div
								className="absolute inset-0 animate-shimmer"
								style={{
									background: `linear-gradient(90deg, transparent, ${themeGradient.glow}, transparent)`,
								}}
							/>
						)}
					</Button>
				</div>
			</div>
		</header>
	);
};
