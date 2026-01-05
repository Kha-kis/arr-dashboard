"use client";

import { Info } from "lucide-react";
import { THEME_GRADIENTS } from "../../../lib/theme-gradients";
import { useColorTheme } from "../../../providers/color-theme-provider";

interface SyncStrategyControlProps {
	value: "auto" | "manual" | "notify";
	onChange: (value: "auto" | "manual" | "notify") => void;
	disabled?: boolean;
}

export const SyncStrategyControl = ({
	value,
	onChange,
	disabled,
}: SyncStrategyControlProps) => {
	const { colorTheme } = useColorTheme();
	const themeGradient = THEME_GRADIENTS[colorTheme];

	// Strategy definitions - notify uses theme colors (applied via inline style)
	const strategies = [
		{
			value: "auto" as const,
			label: "Auto-sync",
			description: "Automatically sync when updates are available (only if no custom modifications)",
			colorClass: "text-green-600 dark:text-green-400",
			bgClass: "bg-green-500/10",
			borderClass: "border-green-500/30",
			useTheme: false,
		},
		{
			value: "notify" as const,
			label: "Notify only",
			description: "Show notification when updates are available, but don't auto-sync",
			colorClass: null,
			bgClass: null,
			borderClass: null,
			useTheme: true, // Theme color
		},
		{
			value: "manual" as const,
			label: "Manual",
			description: "Never check for updates, all syncing must be done manually",
			colorClass: "text-gray-600 dark:text-gray-400",
			bgClass: "bg-gray-500/10",
			borderClass: "border-gray-500/30",
			useTheme: false,
		},
	];

	return (
		<div className="space-y-3">
			<div className="flex items-center gap-2">
				<label className="text-sm font-medium text-fg">
					TRaSH Guides Sync Strategy
				</label>
				<button
					type="button"
					className="group relative"
					aria-label="More info about sync strategy"
					aria-describedby="sync-strategy-tooltip"
				>
					<Info className="h-4 w-4 text-fg-muted cursor-help" />
					<div
						id="sync-strategy-tooltip"
						role="tooltip"
						className="invisible group-hover:visible group-focus:visible absolute left-0 top-6 z-10 w-64 rounded-lg border border-border bg-bg p-3 text-xs text-fg-muted shadow-lg"
					>
						<p>
							Controls how this template handles TRaSH Guides updates from
							GitHub.
						</p>
						<p className="mt-2">
							Note: Auto-sync will only work if the template has no custom
							modifications.
						</p>
					</div>
				</button>
			</div>

			<div className="space-y-2" role="radiogroup" aria-label="Sync strategy">
				{strategies.map((strategy) => {
					const isSelected = value === strategy.value;
					const useThemeStyle = strategy.useTheme && isSelected;

					return (
						<button
							key={strategy.value}
							type="button"
							role="radio"
							aria-checked={isSelected}
							onClick={() => onChange(strategy.value)}
							disabled={disabled}
							className={`w-full text-left rounded-lg border p-3 transition-all disabled:opacity-50 disabled:cursor-not-allowed ${
								isSelected && !strategy.useTheme
									? `${strategy.borderClass} ${strategy.bgClass}`
									: !isSelected
									? "border-border bg-bg-subtle hover:border-border-hover hover:bg-bg-hover"
									: ""
							}`}
							style={useThemeStyle ? {
								borderColor: themeGradient.fromMuted,
								backgroundColor: themeGradient.fromLight,
							} : undefined}
						>
							<div className="flex items-start justify-between gap-3">
								<div className="flex-1 min-w-0">
									<div className="flex items-center gap-2">
										<span
											className={`text-sm font-medium ${
												isSelected && !strategy.useTheme ? strategy.colorClass : !isSelected ? "text-fg" : ""
											}`}
											style={useThemeStyle ? { color: themeGradient.from } : undefined}
										>
											{strategy.label}
										</span>
										{isSelected && (
											<span className="text-xs text-fg-muted">(Current)</span>
										)}
									</div>
									<p className="text-xs text-fg-muted mt-1">
										{strategy.description}
									</p>
								</div>
								<span
									aria-hidden="true"
									className={`mt-0.5 h-4 w-4 shrink-0 rounded-full border-2 flex items-center justify-center ${
										isSelected && !strategy.useTheme
											? "border-current bg-current"
											: !isSelected
											? "border-fg-muted"
											: ""
									}`}
									style={useThemeStyle ? {
										borderColor: themeGradient.from,
										backgroundColor: themeGradient.from,
									} : undefined}
								>
									{isSelected && (
										<span className="h-1.5 w-1.5 rounded-full bg-bg" />
									)}
								</span>
							</div>
						</button>
					);
				})}
			</div>
		</div>
	);
};
