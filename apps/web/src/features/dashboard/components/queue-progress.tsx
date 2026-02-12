"use client";

import { cn } from "../../../lib/utils";
import { useThemeGradient } from "../../../hooks/useThemeGradient";

interface QueueProgressProps {
	value?: number;
	size?: "sm" | "md";
	/** Optional service type for service-specific coloring */
	service?: "sonarr" | "radarr";
}

/**
 * Premium progress bar with theme-aware gradient and glow effects
 */
export const QueueProgress = ({ value, size = "md", service: _service }: QueueProgressProps) => {
	const { gradient: themeGradient } = useThemeGradient();

	if (typeof value !== "number" || Number.isNaN(value)) {
		return (
			<div className="flex flex-col gap-1">
				<div className={cn(
					"relative overflow-hidden rounded-full bg-muted/30",
					size === "sm" ? "h-2" : "h-2.5"
				)}>
					<div className="absolute inset-0 bg-linear-to-r from-muted/20 via-muted/40 to-muted/20 animate-pulse" />
				</div>
				<span className="text-xs text-muted-foreground">–</span>
			</div>
		);
	}

	const clamped = Math.max(0, Math.min(100, Math.round(value)));
	const height = size === "sm" ? "h-2" : "h-2.5";
	const isComplete = clamped === 100;

	return (
		<div className="flex flex-col gap-1.5">
			{/* Progress bar track */}
			<div className={cn("relative overflow-hidden rounded-full bg-muted/20", height)}>
				{/* Progress fill with gradient - clean, no distracting animations */}
				<div
					className="absolute inset-y-0 left-0 rounded-full transition-all duration-500 ease-out"
					style={{
						width: `${clamped}%`,
						background: `linear-gradient(90deg, ${themeGradient.from}, ${themeGradient.to})`,
						boxShadow: clamped > 10 ? `0 0 8px -2px ${themeGradient.glow}` : undefined,
					}}
				>
					{/* Subtle inner highlight for depth */}
					<div
						className="absolute inset-0 rounded-full opacity-30"
						style={{
							background: "linear-gradient(180deg, rgba(255,255,255,0.4) 0%, transparent 40%)",
						}}
					/>
				</div>
			</div>

			{/* Percentage text with theme color when complete */}
			<span
				className={cn(
					"text-xs transition-colors duration-300",
					isComplete ? "font-medium" : "text-muted-foreground"
				)}
				style={isComplete ? { color: themeGradient.from } : undefined}
			>
				{clamped}%{isComplete && " Complete"}
			</span>
		</div>
	);
};
