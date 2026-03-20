"use client";

import { Eye, EyeOff, RotateCcw, Search, X } from "lucide-react";
import { useThemeGradient } from "../../../hooks/useThemeGradient";
import { getLinuxInstanceName, useIncognitoMode } from "../../../lib/incognito";
import { getServiceGradient } from "../../../lib/theme-gradients";
import type { ServiceFilterValue } from "../hooks/use-calendar-state";

const SERVICE_TABS: Array<{ value: ServiceFilterValue; label: string }> = [
	{ value: "all", label: "All" },
	{ value: "sonarr", label: "Sonarr" },
	{ value: "radarr", label: "Radarr" },
	{ value: "lidarr", label: "Lidarr" },
	{ value: "readarr", label: "Readarr" },
];

interface CalendarFiltersProps {
	searchTerm: string;
	serviceFilter: ServiceFilterValue;
	instanceFilter: string;
	includeUnmonitored: boolean;
	instanceOptions: Array<{ value: string; label: string }>;
	onSearchChange: (term: string) => void;
	onServiceFilterChange: (filter: ServiceFilterValue) => void;
	onInstanceFilterChange: (filter: string) => void;
	onIncludeUnmonitoredChange: (include: boolean) => void;
	onResetFilters: () => void;
}

export const CalendarFilters = ({
	searchTerm,
	serviceFilter,
	instanceFilter,
	includeUnmonitored,
	instanceOptions,
	onSearchChange,
	onServiceFilterChange,
	onInstanceFilterChange,
	onIncludeUnmonitoredChange,
	onResetFilters,
}: CalendarFiltersProps) => {
	const [incognitoMode] = useIncognitoMode();
	const { gradient: themeGradient } = useThemeGradient();

	const isFilterActive =
		serviceFilter !== "all" ||
		instanceFilter !== "all" ||
		searchTerm.trim().length > 0 ||
		includeUnmonitored;

	return (
		<div
			className="flex flex-wrap items-center gap-3 animate-in fade-in slide-in-from-bottom-2 duration-400"
			style={{ animationDelay: "80ms", animationFillMode: "backwards" }}
		>
			{/* Service tabs */}
			<div className="flex items-center rounded-xl border border-border/10 bg-card/[0.04] p-[3px]">
				{SERVICE_TABS.map((tab) => {
					const isActive = serviceFilter === tab.value;
					const serviceColor =
						tab.value !== "all"
							? getServiceGradient(tab.value).from
							: themeGradient.from;

					return (
						<button
							key={tab.value}
							type="button"
							onClick={() => onServiceFilterChange(tab.value)}
							className="relative rounded-lg px-2.5 py-1.5 text-[11px] font-semibold tracking-wide transition-all"
							style={{
								backgroundColor: isActive
									? `${serviceColor}12`
									: "transparent",
								color: isActive ? serviceColor : undefined,
								boxShadow: isActive
									? `0 0 12px ${serviceColor}08`
									: "none",
							}}
						>
							{tab.label}
							{/* Active accent underline */}
							{isActive && (
								<span
									className="absolute bottom-[2px] left-1/2 -translate-x-1/2 h-[2px] w-3/5 rounded-full transition-all"
									style={{ backgroundColor: serviceColor }}
								/>
							)}
						</button>
					);
				})}
			</div>

			{/* Instance filter */}
			{instanceOptions.length > 1 && (
				<select
					value={instanceFilter}
					onChange={(e) => onInstanceFilterChange(e.target.value)}
					className="h-8 rounded-xl border border-border/10 bg-card/[0.04] px-2.5 text-[11px] font-medium text-foreground focus:outline-none focus:border-border/25 transition-colors appearance-none pr-6"
					style={{
						backgroundImage: `url("data:image/svg+xml,%3csvg xmlns='http://www.w3.org/2000/svg' fill='none' viewBox='0 0 20 20'%3e%3cpath stroke='%236b7280' stroke-linecap='round' stroke-linejoin='round' stroke-width='1.5' d='M6 8l4 4 4-4'/%3e%3c/svg%3e")`,
						backgroundPosition: "right 4px center",
						backgroundSize: "16px",
						backgroundRepeat: "no-repeat",
					}}
				>
					<option value="all">All instances</option>
					{instanceOptions.map((opt) => (
						<option key={opt.value} value={opt.value}>
							{incognitoMode ? getLinuxInstanceName(opt.label) : opt.label}
						</option>
					))}
				</select>
			)}

			{/* Search */}
			<div className="relative group/search">
				<Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3 w-3 text-muted-foreground/25 group-focus-within/search:text-muted-foreground/50 transition-colors" />
				<input
					type="text"
					value={searchTerm}
					onChange={(e) => onSearchChange(e.target.value)}
					placeholder="Search…"
					className="h-8 w-[160px] rounded-xl border border-border/10 bg-card/[0.04] pl-7 pr-7 text-[12px] text-foreground placeholder:text-muted-foreground/20 focus:outline-none transition-all"
					style={{
						borderColor: searchTerm
							? `${themeGradient.from}25`
							: undefined,
						boxShadow: searchTerm
							? `0 0 0 1px ${themeGradient.from}10, 0 0 12px ${themeGradient.from}06`
							: undefined,
					}}
				/>
				{searchTerm && (
					<button
						type="button"
						onClick={() => onSearchChange("")}
						className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground/35 hover:text-foreground transition-colors"
					>
						<X className="h-3 w-3" />
					</button>
				)}
			</div>

			{/* Spacer */}
			<div className="flex-1" />

			{/* Unmonitored toggle */}
			<button
				type="button"
				onClick={() => onIncludeUnmonitoredChange(!includeUnmonitored)}
				className="flex items-center gap-1.5 rounded-xl px-2.5 py-1.5 text-[11px] font-medium transition-all hover:bg-white/[0.04]"
				style={{
					color: includeUnmonitored ? themeGradient.from : undefined,
					boxShadow: includeUnmonitored
						? `0 0 10px ${themeGradient.from}0c`
						: undefined,
				}}
			>
				{includeUnmonitored ? (
					<Eye className="h-3 w-3" />
				) : (
					<EyeOff className="h-3 w-3" />
				)}
				Unmonitored
			</button>

			{/* Reset */}
			{isFilterActive && (
				<button
					type="button"
					onClick={onResetFilters}
					className="flex items-center gap-1 rounded-xl px-2 py-1.5 text-[11px] font-medium text-muted-foreground/35 hover:text-foreground hover:bg-white/[0.04] transition-all animate-in fade-in duration-200"
				>
					<RotateCcw className="h-3 w-3" />
					Reset
				</button>
			)}
		</div>
	);
};
