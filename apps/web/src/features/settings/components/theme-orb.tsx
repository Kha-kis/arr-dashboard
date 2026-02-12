/**
 * Theme Orb Button
 *
 * Reusable color orb used in Standard, Immersive, and Premium theme selectors.
 * Consolidates three near-identical orb implementations from appearance-tab.tsx.
 *
 * Variants:
 * - "standard" — Subtle glow, single ping animation
 * - "immersive" — Intense glow, double-layered ping with staggered delay
 */

import { cn } from "../../../lib/utils";
import type { ColorTheme } from "../../../providers/color-theme-provider";

interface ThemeOrbProps {
	preset: ColorTheme;
	label: string;
	gradient: { from: string; to: string; glow: string };
	isSelected: boolean;
	isHovered: boolean;
	variant?: "standard" | "immersive";
	animationDelay?: string;
	onSelect: (theme: ColorTheme) => void;
	onHover: (theme: ColorTheme | null) => void;
}

export const ThemeOrbButton = ({
	preset,
	label,
	gradient,
	isSelected,
	isHovered,
	variant = "standard",
	animationDelay,
	onSelect,
	onHover,
}: ThemeOrbProps) => {
	const isIntense = variant === "immersive";
	const glowInset = isIntense ? "-inset-3" : "-inset-2";
	const glowBlur = isIntense ? "blur-lg" : "blur-md";
	const selectedGlowOpacity = isIntense ? "opacity-70" : "opacity-60";
	const hoverGlowOpacity = isIntense ? "group-hover:opacity-40" : "group-hover:opacity-30";
	const highlightWhite = isIntense ? "rgba(255,255,255,0.4)" : "rgba(255,255,255,0.3)";

	return (
		<button
			type="button"
			onClick={() => onSelect(preset)}
			onMouseEnter={() => onHover(preset)}
			onMouseLeave={() => onHover(null)}
			className={cn(
				"group relative flex flex-col items-center gap-3 rounded-xl p-4 transition-all duration-300",
				"hover:bg-muted/30",
				isSelected && "bg-muted/50"
			)}
			style={animationDelay ? { animationDelay } : undefined}
		>
			{/* Orb */}
			<div className="relative">
				{/* Glow ring */}
				<div
					className={cn(
						`absolute ${glowInset} rounded-full ${glowBlur} transition-all duration-500`,
						isSelected ? selectedGlowOpacity : `opacity-0 ${hoverGlowOpacity}`
					)}
					style={{ backgroundColor: gradient.glow }}
				/>

				{/* Main orb */}
				<div
					className={cn(
						"relative h-14 w-14 rounded-full transition-all duration-300",
						"ring-2 ring-offset-2 ring-offset-background",
						isSelected
							? "ring-foreground/20 scale-110"
							: "ring-transparent group-hover:ring-border group-hover:scale-105"
					)}
					style={{
						background: `linear-gradient(135deg, ${gradient.from}, ${gradient.to})`,
						boxShadow: isSelected
							? isIntense
								? `0 0 30px -4px ${gradient.glow}, 0 8px 24px -4px ${gradient.glow}`
								: `0 8px 24px -4px ${gradient.glow}`
							: `0 4px 12px -4px ${gradient.glow}`,
					}}
				>
					{/* Inner highlight */}
					<div
						className="absolute inset-0 rounded-full opacity-50"
						style={{
							background: `linear-gradient(135deg, ${highlightWhite} 0%, transparent 50%)`,
						}}
					/>

					{/* Selection indicator */}
					{isSelected && (
						<div className="absolute inset-0 flex items-center justify-center">
							<div className="h-2 w-2 rounded-full bg-white shadow-sm animate-in zoom-in duration-300" />
						</div>
					)}
				</div>

				{/* Ping effects */}
				{(isHovered || isSelected) && (
					<>
						<div
							className={cn(
								"absolute -inset-1 rounded-full animate-ping",
								isSelected
									? isIntense ? "opacity-30" : "opacity-20"
									: isIntense ? "opacity-15" : "opacity-10"
							)}
							style={{
								backgroundColor: gradient.from,
								animationDuration: isIntense ? "1.5s" : "2s",
							}}
						/>
						{isIntense && (
							<div
								className={cn(
									"absolute -inset-2 rounded-full animate-ping",
									isSelected ? "opacity-20" : "opacity-10"
								)}
								style={{
									backgroundColor: gradient.to,
									animationDuration: "2s",
									animationDelay: "0.3s",
								}}
							/>
						)}
					</>
				)}
			</div>

			{/* Label */}
			<span
				className={cn(
					"text-xs font-medium transition-colors duration-300",
					isSelected ? "text-foreground" : "text-muted-foreground group-hover:text-foreground"
				)}
			>
				{label}
			</span>
		</button>
	);
};
