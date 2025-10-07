import { Button } from "../../../components/ui/button";
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
	return (
		<header className="flex flex-col gap-4">
			<div className="flex flex-col justify-between gap-3 md:flex-row md:items-center">
				<div>
					<p className="text-sm font-medium uppercase text-white/60">Schedule</p>
					<h1 className="text-3xl font-semibold text-white">Upcoming Releases</h1>
				</div>
				<div className="flex items-center gap-2">
					<Button variant="ghost" onClick={onPreviousMonth}>
						&larr; Prev
					</Button>
					<span className="min-w-[160px] text-center text-sm text-white/80">
						{formatMonthLabel(monthStart)}
					</span>
					<Button variant="ghost" onClick={onNextMonth}>
						Next &rarr;
					</Button>
					<Button variant="ghost" onClick={onGoToday}>
						Today
					</Button>
					<Button variant="ghost" onClick={onRefresh} disabled={isLoading}>
						Refresh
					</Button>
				</div>
			</div>
			<p className="text-sm text-white/60">
				Combined calendar view for Sonarr and Radarr instances. Use the filters below to drill into
				specific services or hosts.
			</p>
		</header>
	);
};
