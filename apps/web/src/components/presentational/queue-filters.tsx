"use client";

/**
 * Queue Filters - Premium Glassmorphism Design with shadcn/ui
 *
 * Filter controls for queue items with theme-aware styling.
 * Uses Radix UI Select primitives for proper accessibility and UX.
 */

import { Filter, X, ChevronDown, RotateCcw, Check } from "lucide-react";
import * as SelectPrimitive from "@radix-ui/react-select";
import { cn } from "../../lib/utils";
import { useThemeGradient } from "../../hooks/useThemeGradient";

interface FilterOption {
	value: string;
	label: string;
}

interface QueueFiltersProps {
	// Service filter
	serviceFilter: string;
	onServiceFilterChange: (value: string) => void;
	serviceOptions: readonly FilterOption[];

	// Instance filter
	instanceFilter: string;
	onInstanceFilterChange: (value: string) => void;
	instanceOptions: FilterOption[];

	// Status filter
	statusFilter: string;
	onStatusFilterChange: (value: string) => void;
	statusOptions: FilterOption[];

	// Reset
	filtersActive: boolean;
	onReset: () => void;
}

/**
 * Premium Select component with glassmorphism styling
 * Built on Radix UI for proper accessibility
 */
const PremiumSelect = ({
	label,
	value,
	options,
	onChange,
	placeholder,
	isActive,
	themeGradient,
}: {
	label: string;
	value: string;
	options: readonly FilterOption[];
	onChange: (value: string) => void;
	placeholder: string;
	isActive: boolean;
	themeGradient: { from: string; to: string; glow: string };
}) => {
	return (
		<div className="relative group">
			{/* Floating label */}
			<span
				className={cn(
					"absolute -top-2 left-3 z-20 px-1.5 text-[10px] font-medium uppercase tracking-wider transition-colors duration-300",
					isActive ? "text-foreground" : "text-muted-foreground"
				)}
				style={{
					background: "linear-gradient(180deg, transparent 0%, hsl(var(--card)) 20%)",
					...(isActive && { color: themeGradient.from }),
				}}
			>
				{label}
			</span>

			<SelectPrimitive.Root value={value} onValueChange={onChange}>
				<SelectPrimitive.Trigger
					className={cn(
						"relative flex h-11 w-full min-w-[150px] items-center justify-between gap-2 rounded-xl border px-4 py-2.5 text-sm font-medium transition-all duration-300",
						"bg-card/60 backdrop-blur-xs text-foreground",
						"focus:outline-hidden focus:ring-2 focus:ring-offset-0 focus:ring-offset-transparent",
						"data-placeholder:text-muted-foreground",
						"disabled:cursor-not-allowed disabled:opacity-50",
						isActive
							? "border-primary/50"
							: "border-border/50 hover:border-border hover:bg-card/80"
					)}
					style={{
						boxShadow: isActive ? `0 4px 16px -4px ${themeGradient.glow}` : undefined,
						...(isActive && { borderColor: themeGradient.from }),
					}}
				>
					<SelectPrimitive.Value placeholder={placeholder} />
					<SelectPrimitive.Icon asChild>
						<ChevronDown
							className={cn(
								"h-4 w-4 transition-all duration-300",
								isActive ? "" : "text-muted-foreground"
							)}
							style={isActive ? { color: themeGradient.from } : undefined}
						/>
					</SelectPrimitive.Icon>

					{/* Active indicator dot */}
					{isActive && (
						<div
							className="absolute -top-1 -right-1 h-2.5 w-2.5 rounded-full animate-in zoom-in duration-200"
							style={{
								background: `linear-gradient(135deg, ${themeGradient.from}, ${themeGradient.to})`,
								boxShadow: `0 0 8px ${themeGradient.glow}`,
							}}
						/>
					)}
				</SelectPrimitive.Trigger>

				<SelectPrimitive.Portal>
					<SelectPrimitive.Content
						className={cn(
							"relative z-modal max-h-[300px] min-w-(--radix-select-trigger-width) overflow-hidden",
							"rounded-xl border border-border/50 bg-card/95 backdrop-blur-xl",
							"shadow-xl shadow-black/20",
							"data-[state=open]:animate-in data-[state=closed]:animate-out",
							"data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0",
							"data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95",
							"data-[side=bottom]:slide-in-from-top-2 data-[side=top]:slide-in-from-bottom-2",
							"origin-(--radix-select-content-transform-origin)"
						)}
						position="popper"
						sideOffset={6}
						style={{
							boxShadow: `0 8px 32px -8px ${themeGradient.glow}, 0 4px 16px rgba(0,0,0,0.3)`,
						}}
					>
						{/* Gradient accent line at top */}
						<div
							className="absolute inset-x-0 top-0 h-0.5 z-10"
							style={{
								background: `linear-gradient(90deg, ${themeGradient.from}, ${themeGradient.to})`,
							}}
						/>

						<SelectPrimitive.Viewport className="p-1.5 pt-2">
							{options.map((option) => (
								<SelectPrimitive.Item
									key={option.value}
									value={option.value}
									className={cn(
										"relative flex w-full cursor-pointer select-none items-center rounded-lg py-2.5 pl-9 pr-3 text-sm font-medium outline-hidden transition-all duration-200",
										"text-foreground/80",
										"focus:text-foreground",
										"data-disabled:pointer-events-none data-disabled:opacity-50",
										"data-highlighted:outline-hidden"
									)}
									style={{
										// Hover/focus background with theme color
									}}
									onFocus={(e) => {
										e.currentTarget.style.background = `linear-gradient(135deg, ${themeGradient.from}15, ${themeGradient.to}10)`;
									}}
									onBlur={(e) => {
										e.currentTarget.style.background = "";
									}}
									onMouseEnter={(e) => {
										e.currentTarget.style.background = `linear-gradient(135deg, ${themeGradient.from}15, ${themeGradient.to}10)`;
									}}
									onMouseLeave={(e) => {
										if (document.activeElement !== e.currentTarget) {
											e.currentTarget.style.background = "";
										}
									}}
								>
									<span className="absolute left-2.5 flex h-4 w-4 items-center justify-center">
										<SelectPrimitive.ItemIndicator>
											<Check
												className="h-4 w-4"
												style={{ color: themeGradient.from }}
											/>
										</SelectPrimitive.ItemIndicator>
									</span>
									<SelectPrimitive.ItemText>{option.label}</SelectPrimitive.ItemText>
								</SelectPrimitive.Item>
							))}
						</SelectPrimitive.Viewport>
					</SelectPrimitive.Content>
				</SelectPrimitive.Portal>
			</SelectPrimitive.Root>
		</div>
	);
};

/**
 * Active filter chip showing current filter value
 */
const ActiveFilterChip = ({
	label,
	value,
	onClear,
	themeGradient,
}: {
	label: string;
	value: string;
	onClear: () => void;
	themeGradient: { from: string; to: string; glow: string };
}) => (
	<button
		type="button"
		onClick={onClear}
		className="group inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium transition-all duration-300 hover:scale-105"
		style={{
			background: `linear-gradient(135deg, ${themeGradient.from}15, ${themeGradient.to}15)`,
			border: `1px solid ${themeGradient.from}30`,
			color: themeGradient.from,
		}}
	>
		<span className="opacity-60">{label}:</span>
		<span className="font-semibold">{value}</span>
		<X className="h-3 w-3 ml-0.5 opacity-60 group-hover:opacity-100 transition-opacity" />
	</button>
);

export const QueueFilters = ({
	serviceFilter,
	onServiceFilterChange,
	serviceOptions,
	instanceFilter,
	onInstanceFilterChange,
	instanceOptions,
	statusFilter,
	onStatusFilterChange,
	statusOptions,
	filtersActive,
	onReset,
}: QueueFiltersProps) => {
	const { gradient: themeGradient } = useThemeGradient();

	// Build instance options with "All instances" at the top
	const allInstanceOptions: FilterOption[] = [
		{ value: "all", label: "All instances" },
		...instanceOptions,
	];

	// Build status options with "All statuses" at the top
	const allStatusOptions: FilterOption[] = [
		{ value: "all", label: "All statuses" },
		...statusOptions,
	];

	// Determine which filters are active for chips
	const activeFilters: { label: string; value: string; onClear: () => void }[] = [];

	const selectedService = serviceOptions.find((opt) => opt.value === serviceFilter);
	if (serviceFilter !== "all" && selectedService) {
		activeFilters.push({
			label: "Service",
			value: selectedService.label,
			onClear: () => onServiceFilterChange("all"),
		});
	}

	const selectedInstance = instanceOptions.find((opt) => opt.value === instanceFilter);
	if (instanceFilter !== "all" && selectedInstance) {
		activeFilters.push({
			label: "Instance",
			value: selectedInstance.label,
			onClear: () => onInstanceFilterChange("all"),
		});
	}

	const selectedStatus = statusOptions.find((opt) => opt.value === statusFilter);
	if (statusFilter !== "all" && selectedStatus) {
		activeFilters.push({
			label: "Status",
			value: selectedStatus.label,
			onClear: () => onStatusFilterChange("all"),
		});
	}

	return (
		<div className="space-y-3">
			{/* Main filter bar */}
			<div
				className="relative overflow-hidden rounded-2xl border border-border/40 bg-card/50 backdrop-blur-xs transition-all duration-300"
				style={{
					boxShadow: filtersActive ? `0 4px 20px -4px ${themeGradient.glow}` : undefined,
				}}
			>
				{/* Gradient accent line when filters active */}
				{filtersActive && (
					<div
						className="absolute inset-x-0 top-0 h-0.5 animate-in fade-in duration-300"
						style={{
							background: `linear-gradient(90deg, ${themeGradient.from}, ${themeGradient.to})`,
						}}
					/>
				)}

				<div className="flex flex-wrap items-center gap-4 px-5 py-4">
					{/* Filter icon with theme color when active */}
					<div
						className={cn(
							"flex h-9 w-9 items-center justify-center rounded-xl transition-all duration-300",
							filtersActive ? "scale-110" : "bg-muted/30"
						)}
						style={
							filtersActive
								? {
										background: `linear-gradient(135deg, ${themeGradient.from}20, ${themeGradient.to}20)`,
								  }
								: undefined
						}
					>
						<Filter
							className={cn("h-4 w-4 transition-colors duration-300")}
							style={filtersActive ? { color: themeGradient.from } : undefined}
						/>
					</div>

					{/* Filter selects */}
					<div className="flex flex-wrap items-center gap-4">
						<PremiumSelect
							label="Service"
							value={serviceFilter}
							options={serviceOptions}
							onChange={onServiceFilterChange}
							placeholder="All services"
							isActive={serviceFilter !== "all"}
							themeGradient={themeGradient}
						/>

						<PremiumSelect
							label="Instance"
							value={instanceFilter}
							options={allInstanceOptions}
							onChange={onInstanceFilterChange}
							placeholder="All instances"
							isActive={instanceFilter !== "all"}
							themeGradient={themeGradient}
						/>

						<PremiumSelect
							label="Status"
							value={statusFilter}
							options={allStatusOptions}
							onChange={onStatusFilterChange}
							placeholder="All statuses"
							isActive={statusFilter !== "all"}
							themeGradient={themeGradient}
						/>
					</div>

					{/* Reset button */}
					<div className="ml-auto">
						<button
							type="button"
							onClick={onReset}
							disabled={!filtersActive}
							className={cn(
								"group inline-flex items-center gap-2 rounded-xl border px-4 py-2.5 text-sm font-medium transition-all duration-300",
								filtersActive
									? "border-border/50 bg-card/80 text-foreground hover:border-border hover:bg-card"
									: "border-transparent text-muted-foreground/50 cursor-not-allowed"
							)}
						>
							<RotateCcw
								className={cn(
									"h-4 w-4 transition-transform duration-300",
									filtersActive && "group-hover:-rotate-180"
								)}
							/>
							<span>Reset</span>
						</button>
					</div>
				</div>
			</div>

			{/* Active filter chips */}
			{activeFilters.length > 0 && (
				<div className="flex flex-wrap items-center gap-2 animate-in fade-in slide-in-from-top-2 duration-300">
					<span className="text-xs text-muted-foreground mr-1">Active filters:</span>
					{activeFilters.map((filter) => (
						<ActiveFilterChip
							key={filter.label}
							label={filter.label}
							value={filter.value}
							onClear={filter.onClear}
							themeGradient={themeGradient}
						/>
					))}
				</div>
			)}
		</div>
	);
};
