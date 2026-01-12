"use client";

import type { ReactNode } from "react";
import { cn } from "../../lib/utils";
import { useThemeGradient } from "../../hooks/useThemeGradient";
import type { LucideIcon } from "lucide-react";

interface PremiumPageHeaderProps {
	/** Small label above the title (e.g., "Activity", "Media Library") */
	label?: string;
	/** Optional icon to display with the label */
	labelIcon?: LucideIcon;
	/** Main page title - can include theme-gradient styling */
	title: string;
	/** Whether to apply gradient styling to the title */
	gradientTitle?: boolean;
	/** Description text below the title */
	description?: string;
	/** Highlighted stat to show inline with description */
	highlightStat?: {
		value: string | number;
		label: string;
	};
	/** Action buttons on the right side */
	actions?: ReactNode;
	/** Additional className for the header */
	className?: string;
	/** Animation delay in ms (for staggered reveals) */
	animationDelay?: number;
}

/**
 * Premium Page Header Component
 *
 * A refined header component with dashboard-style aesthetics:
 * - Gradient text title option
 * - Animated entrance effects
 * - Theme-aware accent colors
 * - Subtle decorative elements
 *
 * @example
 * ```tsx
 * <PremiumPageHeader
 *   label="Activity"
 *   labelIcon={Activity}
 *   title="Download History"
 *   gradientTitle
 *   description="Review recent activity from all configured instances"
 *   highlightStat={{ value: 1234, label: "events tracked" }}
 *   actions={<Button>Refresh</Button>}
 * />
 * ```
 */
export const PremiumPageHeader = ({
	label,
	labelIcon: LabelIcon,
	title,
	gradientTitle = false,
	description,
	highlightStat,
	actions,
	className,
	animationDelay = 0,
}: PremiumPageHeaderProps) => {
	const { gradient: themeGradient } = useThemeGradient();

	return (
		<header
			className={cn(
				"relative animate-in fade-in slide-in-from-bottom-4 duration-500",
				className
			)}
			style={{
				animationDelay: `${animationDelay}ms`,
				animationFillMode: "backwards",
			}}
		>
			<div className="flex items-start justify-between gap-4">
				<div className="space-y-1">
					{/* Label with optional icon */}
					{label && (
						<div className="flex items-center gap-2 text-sm text-muted-foreground">
							{LabelIcon && <LabelIcon className="h-4 w-4" />}
							<span>{label}</span>
						</div>
					)}

					{/* Title - optionally with gradient */}
					<h1 className="text-3xl font-bold tracking-tight">
						{gradientTitle ? (
							<span
								style={{
									background: `linear-gradient(135deg, ${themeGradient.from}, ${themeGradient.to})`,
									WebkitBackgroundClip: "text",
									WebkitTextFillColor: "transparent",
									backgroundClip: "text",
								}}
							>
								{title}
							</span>
						) : (
							<span className="text-foreground">{title}</span>
						)}
					</h1>

					{/* Description with optional highlight */}
					{(description || highlightStat) && (
						<p className="text-muted-foreground max-w-xl">
							{description}
							{highlightStat && (
								<span
									className="font-medium"
									style={{ color: themeGradient.from }}
								>
									{description ? " " : ""}
									{highlightStat.value} {highlightStat.label}
								</span>
							)}
						</p>
					)}
				</div>

				{/* Actions */}
				{actions && (
					<div className="flex items-center gap-2">
						{actions}
					</div>
				)}
			</div>
		</header>
	);
};
/**
 * Premium Section Card Component
 *
 * A glassmorphic card container matching the dashboard aesthetic.
 */
interface PremiumCardProps {
	/** Card title */
	title?: string;
	/** Card description */
	description?: string;
	/** Optional icon for the card header */
	icon?: LucideIcon;
	/** Whether to show icon with gradient background */
	gradientIcon?: boolean;
	/** Card content */
	children: ReactNode;
	/** Additional className */
	className?: string;
	/** Animation delay for staggered reveals */
	animationDelay?: number;
	/** Whether to show the card header */
	showHeader?: boolean;
}

export const PremiumCard = ({
	title,
	description,
	icon: Icon,
	gradientIcon = true,
	children,
	className,
	animationDelay = 0,
	showHeader = true,
}: PremiumCardProps) => {
	const { gradient: themeGradient } = useThemeGradient();

	return (
		<div
			className={cn(
				"rounded-2xl border border-border/50 bg-card/30 backdrop-blur-sm overflow-hidden",
				"animate-in fade-in slide-in-from-bottom-4 duration-500",
				className
			)}
			style={{
				animationDelay: `${animationDelay}ms`,
				animationFillMode: "backwards",
			}}
		>
			{showHeader && (title || Icon) && (
				<div className="flex items-center gap-3 px-6 py-4 border-b border-border/50">
					{Icon && (
						<div
							className="flex h-10 w-10 items-center justify-center rounded-xl"
							style={gradientIcon ? {
								background: `linear-gradient(135deg, ${themeGradient.from}, ${themeGradient.to})`,
								boxShadow: `0 8px 24px -8px ${themeGradient.glow}`,
							} : {
								background: `linear-gradient(135deg, ${themeGradient.from}20, ${themeGradient.to}20)`,
								border: `1px solid ${themeGradient.from}30`,
							}}
						>
							<Icon
								className="h-5 w-5"
								style={gradientIcon ? { color: "white" } : { color: themeGradient.from }}
							/>
						</div>
					)}
					{(title || description) && (
						<div>
							{title && <h2 className="text-lg font-semibold">{title}</h2>}
							{description && (
								<p className="text-sm text-muted-foreground">{description}</p>
							)}
						</div>
					)}
				</div>
			)}

			<div className={cn(showHeader && (title || Icon) ? "p-6" : "p-0")}>
				{children}
			</div>
		</div>
	);
};

/**
 * Stats Card Component
 *
 * A compact stat display card matching the dashboard service cards.
 */
interface StatCardProps {
	/** Stat value */
	value: number | string;
	/** Stat label */
	label: string;
	/** Optional description */
	description?: string;
	/** Card icon */
	icon?: LucideIcon;
	/** Custom gradient colors (defaults to theme) */
	gradient?: { from: string; to: string; glow: string };
	/** Click handler */
	onClick?: () => void;
	/** Animation delay */
	animationDelay?: number;
}

export const StatCard = ({
	value,
	label,
	description,
	icon: Icon,
	gradient,
	onClick,
	animationDelay = 0,
}: StatCardProps) => {
	const { gradient: defaultGradient } = useThemeGradient();
	const themeGradient = gradient ?? defaultGradient;

	return (
		<button
			type="button"
			onClick={onClick}
			disabled={!onClick}
			className={cn(
				"group relative overflow-hidden rounded-2xl border border-border/50 bg-card/50 backdrop-blur-sm p-6 text-left transition-all duration-500",
				"animate-in fade-in slide-in-from-bottom-4",
				onClick && "cursor-pointer hover:border-border hover:shadow-lg",
				!onClick && "cursor-default"
			)}
			style={{
				animationDelay: `${animationDelay}ms`,
				animationFillMode: "backwards",
			}}
		>
			{/* Ambient glow on hover */}
			<div
				className={cn(
					"pointer-events-none absolute -inset-4 opacity-0 blur-2xl transition-opacity duration-500",
					onClick && "group-hover:opacity-40"
				)}
				style={{ backgroundColor: themeGradient.glow }}
			/>

			<div className="relative">
				{/* Icon with gradient background */}
				{Icon && (
					<div className="mb-4 flex items-center justify-between">
						<div
							className={cn(
								"flex h-12 w-12 items-center justify-center rounded-xl transition-all duration-300",
								onClick && "group-hover:scale-110"
							)}
							style={{
								background: `linear-gradient(135deg, ${themeGradient.from}, ${themeGradient.to})`,
								boxShadow: `0 8px 24px -8px ${themeGradient.glow}`,
							}}
						>
							<Icon className="h-6 w-6 text-white" />
						</div>
					</div>
				)}

				{/* Value with gradient text */}
				<div className="mb-1">
					<span
						className={cn(
							"text-4xl font-bold tracking-tight transition-all duration-300",
							onClick && "group-hover:translate-x-1"
						)}
						style={{
							background: `linear-gradient(135deg, ${themeGradient.from}, ${themeGradient.to})`,
							WebkitBackgroundClip: "text",
							WebkitTextFillColor: "transparent",
							backgroundClip: "text",
						}}
					>
						{value}
					</span>
				</div>

				{/* Label */}
				<p className="text-sm font-medium text-foreground uppercase tracking-wide">
					{label}
				</p>

				{/* Description */}
				{description && (
					<p className="mt-1 text-xs text-muted-foreground">
						{description}
					</p>
				)}

				{/* Active indicator line */}
				<div
					className={cn(
						"absolute bottom-0 left-0 h-0.5 transition-all duration-500",
						onClick ? "w-0 group-hover:w-full" : "w-8"
					)}
					style={{
						background: `linear-gradient(90deg, ${themeGradient.from}, ${themeGradient.to})`,
					}}
				/>
			</div>
		</button>
	);
};
