"use client";

import { BookOpen, Disc3, Film, Tv } from "lucide-react";
import { useThemeGradient } from "../../../hooks/useThemeGradient";
import { getLinuxIsoName, useIncognitoMode } from "../../../lib/incognito";
import { cn } from "../../../lib/utils";
import { getServiceGradient } from "../../../lib/theme-gradients";
import type { DeduplicatedCalendarItem } from "../hooks/use-calendar-data";
import { formatDateOnly } from "../lib/calendar-formatters";

interface CalendarGridProps {
	readonly days: Date[];
	readonly currentMonth: Date;
	readonly selectedDate: Date | null;
	readonly onSelectDate: (date: Date) => void;
	readonly eventsByDate: Map<string, DeduplicatedCalendarItem[]>;
	readonly weekStart?: 0 | 1;
	readonly className?: string;
}

const WEEKDAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MAX_VISIBLE_CHIPS = 4;

/** Type icons for grid event chips */
const CHIP_ICONS: Record<
	string,
	React.ComponentType<{ className?: string; style?: React.CSSProperties }>
> = {
	episode: Tv,
	movie: Film,
	album: Disc3,
	book: BookOpen,
};

const formatDateKey = (date: Date): string => {
	const iso = date.toISOString();
	const index = iso.indexOf("T");
	return index === -1 ? iso : iso.slice(0, index);
};

const isSameDay = (a: Date | null, b: Date): boolean => {
	if (!a) return false;
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
	new Intl.DateTimeFormat(undefined, { day: "numeric", timeZone: "UTC" }).format(date);

/** Extract unique service colors from a day's events */
const getUniqueServiceColors = (
	events: DeduplicatedCalendarItem[],
): string[] => {
	const seen = new Set<string>();
	const colors: string[] = [];
	for (const e of events) {
		if (!seen.has(e.service)) {
			seen.add(e.service);
			colors.push(getServiceGradient(e.service).from);
		}
	}
	return colors;
};

/**
 * Multi-service color bar — 3px strip at cell top showing which services
 * have events on that day. Each service gets an equal-width segment.
 */
const ServiceBar = ({ colors }: { colors: string[] }) => (
	<div className="absolute top-0 left-0 right-0 h-[3px] flex overflow-hidden z-10">
		{colors.map((color) => (
			<div
				key={color}
				className="flex-1 h-full"
				style={{
					background: `linear-gradient(90deg, ${color}, ${color}cc)`,
				}}
			/>
		))}
	</div>
);

/**
 * Event chip with type icon + gradient background.
 * Shows service-colored icon and title in a tinted pill.
 */
const EventChip = ({ event }: { event: DeduplicatedCalendarItem }) => {
	const [incognitoMode] = useIncognitoMode();
	const serviceGrad = getServiceGradient(event.service);
	const ChipIcon = CHIP_ICONS[event.type];
	const rawTitle =
		event.type === "episode"
			? (event.seriesTitle ?? event.title)
			: event.type === "movie"
				? (event.movieTitle ?? event.title)
				: event.type === "album"
					? (event.artistName ?? event.title)
					: event.type === "book"
						? (event.authorName ?? event.title)
						: event.title;
	const title = incognitoMode ? getLinuxIsoName(rawTitle ?? "") : rawTitle;

	return (
		<div
			className="group/chip flex items-center gap-1 rounded-[5px] px-1.5 py-[3px] text-[10px] leading-tight transition-all hover:brightness-125"
			style={{
				background: `linear-gradient(135deg, ${serviceGrad.from}0a, transparent 80%)`,
			}}
		>
			{ChipIcon && (
				<ChipIcon
					className="h-[10px] w-[10px] shrink-0"
					style={{ color: `${serviceGrad.from}80` }}
				/>
			)}
			<span className="truncate font-medium text-foreground/70 group-hover/chip:text-foreground/90 transition-colors">
				{title}
			</span>
		</div>
	);
};

/**
 * Overflow indicator — colored dots previewing hidden events + count
 */
const MoreIndicator = ({
	hiddenEvents,
	dominantColor,
}: {
	hiddenEvents: DeduplicatedCalendarItem[];
	dominantColor: string;
}) => (
	<div className="flex items-center justify-center gap-[3px] pt-0.5">
		{hiddenEvents.slice(0, 3).map((e, i) => (
			<span
				key={i}
				className="h-[3px] w-[3px] rounded-full"
				style={{
					backgroundColor: `${getServiceGradient(e.service).from}70`,
				}}
			/>
		))}
		<span
			className="text-[8px] font-bold tabular-nums ml-0.5"
			style={{ color: `${dominantColor}45` }}
		>
			+{hiddenEvents.length}
		</span>
	</div>
);

export const CalendarGrid = ({
	days,
	currentMonth,
	selectedDate,
	onSelectDate,
	eventsByDate,
	weekStart = 0,
	className,
}: CalendarGridProps) => {
	const { gradient: themeGradient } = useThemeGradient();
	const todayKey = formatDateOnly(new Date());

	const rotatedLabels = [
		...WEEKDAY_LABELS.slice(weekStart),
		...WEEKDAY_LABELS.slice(0, weekStart),
	];
	// Weekend column indices after rotation
	const satIndex = (6 - weekStart + 7) % 7;
	const sunIndex = (0 - weekStart + 7) % 7;

	return (
		<div className="overflow-x-auto -mx-1 px-1">
			{/* Weekday headers */}
			<div className="grid grid-cols-7 gap-px min-w-[480px] mb-1.5">
				{rotatedLabels.map((day, i) => (
					<div
						key={day}
						className={cn(
							"py-2.5 text-center text-[10px] font-bold uppercase tracking-[0.15em]",
							i === satIndex || i === sunIndex
								? "text-muted-foreground/20"
								: "text-muted-foreground/40",
						)}
					>
						{day}
					</div>
				))}
			</div>

			{/* Day cells grid */}
			<div
				className={cn(
					"grid grid-cols-7 gap-px min-w-[480px] rounded-2xl overflow-hidden border border-border/10 bg-border/[0.04]",
					className,
				)}
			>
				{days.map((date) => {
					const key = formatDateKey(date);
					const events = eventsByDate.get(key) ?? [];
					const inCurrentMonth = isSameMonth(currentMonth, date);
					const isSelected = isSameDay(selectedDate, date);
					const isTodayDate = key === todayKey;
					const hasEvents = events.length > 0;
					const isPast = key < todayKey;

					const serviceColors = hasEvents
						? getUniqueServiceColors(events)
						: [];
					const dominantColor =
						serviceColors[0] ?? themeGradient.from;

					// Density-based opacity for heatmap effect (1.5% per event, max 7%)
					const densityOpacity = hasEvents
						? Math.min(events.length * 0.015, 0.07)
						: 0;

					// Cell selection/glow style
					const cellStyle: React.CSSProperties = {};
					if (isSelected) {
						cellStyle.boxShadow = `inset 3px 0 0 ${themeGradient.from}, 0 0 25px -6px ${themeGradient.from}20`;
					} else if (isTodayDate) {
						cellStyle.boxShadow = `inset 0 0 0 1px ${themeGradient.from}15`;
					}

					return (
						<button
							key={key}
							type="button"
							onClick={() => onSelectDate(date)}
							className={cn(
								"flex flex-col text-left transition-all duration-200 h-[115px] lg:h-[130px] relative group/cell",
								inCurrentMonth
									? isPast && !isTodayDate
										? "bg-card/[0.06]"
										: "bg-card/10"
									: "bg-card/[0.03]",
								!isSelected && "hover:bg-card/20",
								isPast && !isTodayDate && "opacity-70",
							)}
							style={cellStyle}
						>
							{/* Service color bar */}
							{hasEvents && <ServiceBar colors={serviceColors} />}

							{/* Density heatmap overlay */}
							{hasEvents && !isSelected && (
								<div
									className="absolute inset-0 pointer-events-none"
									style={{
										backgroundColor: dominantColor,
										opacity: densityOpacity,
									}}
								/>
							)}

							{/* Selected overlay */}
							{isSelected && (
								<div
									className="absolute inset-0 pointer-events-none"
									style={{
										backgroundColor: themeGradient.from,
										opacity: 0.05,
									}}
								/>
							)}

							{/* Ambient bottom glow */}
							{hasEvents && (
								<div
									className="absolute inset-0 pointer-events-none"
									style={{
										background: `radial-gradient(ellipse at bottom, ${dominantColor}08 0%, transparent 70%)`,
									}}
								/>
							)}

							{/* Day number row */}
							<div className="flex items-center justify-between px-2 pt-2 pb-0.5 relative z-10">
								<div className="relative">
									<span
										className={cn(
											"text-xs font-semibold tabular-nums leading-none relative z-10",
											isTodayDate
												? "flex items-center justify-center h-[26px] w-[26px] rounded-full text-white -ml-0.5"
												: inCurrentMonth
													? isPast
														? "text-foreground/45"
														: "text-foreground/80"
													: "text-muted-foreground/18",
										)}
										style={
											isTodayDate
												? {
														background: `linear-gradient(135deg, ${themeGradient.from}, ${themeGradient.to})`,
														boxShadow: `0 2px 10px ${themeGradient.from}50, 0 0 0 2px ${themeGradient.from}20`,
													}
												: undefined
										}
									>
										{formatDayNumber(date)}
									</span>

									{/* Today breathing pulse */}
									{isTodayDate && (
										<span
											className="absolute -inset-0.5 rounded-full animate-ping pointer-events-none"
											style={{
												border: `1.5px solid ${themeGradient.from}`,
												animationDuration: "3s",
												opacity: 0.25,
											}}
										/>
									)}
								</div>

								{/* Event count badge */}
								{hasEvents && events.length > 1 && (
									<span
										className="text-[9px] font-bold tabular-nums leading-none rounded-full px-1.5 py-0.5"
										style={{
											backgroundColor: `${dominantColor}15`,
											color: `${dominantColor}90`,
										}}
									>
										{events.length}
									</span>
								)}
							</div>

							{/* Event chips */}
							<div className="flex-1 px-1.5 pb-1.5 space-y-px relative z-10 overflow-y-auto [&::-webkit-scrollbar]:w-0.5 [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-white/10">
								{events
									.slice(0, MAX_VISIBLE_CHIPS)
									.map((event) => (
										<EventChip
											key={`${key}:${String(event.id)}`}
											event={event}
										/>
									))}
								{events.length > MAX_VISIBLE_CHIPS && (
									<MoreIndicator
										hiddenEvents={events.slice(
											MAX_VISIBLE_CHIPS,
										)}
										dominantColor={dominantColor}
									/>
								)}
							</div>
						</button>
					);
				})}
			</div>
		</div>
	);
};
