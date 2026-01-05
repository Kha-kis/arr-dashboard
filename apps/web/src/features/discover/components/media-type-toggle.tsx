"use client";

import type { DiscoverSearchType } from "@arr/shared";
import { Film, Tv, Check } from "lucide-react";
import { THEME_GRADIENTS } from "../../../lib/theme-gradients";
import { useColorTheme } from "../../../providers/color-theme-provider";
import { cn } from "../../../lib/utils";

/**
 * Props for the MediaTypeToggle component
 */
interface MediaTypeToggleProps {
	/** The currently selected media type */
	searchType: DiscoverSearchType;
	/** Callback when media type changes */
	onTypeChange: (type: DiscoverSearchType) => void;
	/** Number of connected instances */
	instanceCount: number;
}

/**
 * Premium Media Type Toggle
 *
 * Toggle component for switching between movie and series search modes with:
 * - Theme-aware gradient styling for active state
 * - Smooth transitions and hover effects
 * - Instance count indicator with theme colors
 */
export const MediaTypeToggle: React.FC<MediaTypeToggleProps> = ({
	searchType,
	onTypeChange,
	instanceCount,
}) => {
	const { colorTheme } = useColorTheme();
	const themeGradient = THEME_GRADIENTS[colorTheme];

	const options: { type: DiscoverSearchType; label: string; icon: typeof Film; service: string }[] = [
		{ type: "movie", label: "Movies", icon: Film, service: "Radarr" },
		{ type: "series", label: "Series", icon: Tv, service: "Sonarr" },
	];

	return (
		<div className="flex flex-wrap items-center gap-4">
			<div className="inline-flex rounded-xl bg-card/50 backdrop-blur-sm p-1 border border-border/50">
				{options.map(({ type, label, icon: Icon }) => {
					const isActive = searchType === type;
					return (
						<button
							key={type}
							type="button"
							onClick={() => onTypeChange(type)}
							className={cn(
								"relative flex items-center gap-2 rounded-lg px-4 py-2.5 text-sm font-medium transition-all duration-300",
								isActive
									? "text-white shadow-lg"
									: "text-muted-foreground hover:text-foreground hover:bg-card/80"
							)}
							style={
								isActive
									? {
											background: `linear-gradient(135deg, ${themeGradient.from}, ${themeGradient.to})`,
											boxShadow: `0 4px 12px -4px ${themeGradient.glow}`,
										}
									: undefined
							}
						>
							<Icon className="h-4 w-4" />
							<span>{label}</span>
						</button>
					);
				})}
			</div>

			{/* Instance Count Badge */}
			<div
				className="inline-flex items-center gap-2 rounded-xl px-3 py-2 text-sm"
				style={{
					background: `linear-gradient(135deg, ${themeGradient.from}10, ${themeGradient.to}10)`,
					border: `1px solid ${themeGradient.from}20`,
				}}
			>
				<div
					className="flex h-5 w-5 items-center justify-center rounded-md"
					style={{
						background: `linear-gradient(135deg, ${themeGradient.from}30, ${themeGradient.to}30)`,
					}}
				>
					{instanceCount > 0 ? (
						<Check className="h-3 w-3" style={{ color: themeGradient.from }} />
					) : (
						<span className="text-xs font-bold" style={{ color: themeGradient.from }}>0</span>
					)}
				</div>
				<span className="text-muted-foreground">
					<span className="font-medium text-foreground">{instanceCount}</span>
					{" "}
					{searchType === "movie" ? "Radarr" : "Sonarr"} instance{instanceCount === 1 ? "" : "s"}
				</span>
			</div>
		</div>
	);
};
