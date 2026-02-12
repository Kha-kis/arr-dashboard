"use client";

import type { ReactNode } from "react";
import { cn } from "../../lib/utils";
import { useThemeGradient } from "../../hooks/useThemeGradient";
import type { LucideIcon } from "lucide-react";

/* =============================================================================
   PREMIUM TABS
   Tab navigation with gradient active states matching dashboard aesthetics
   ============================================================================= */

export interface PremiumTab {
	id: string;
	label: string;
	icon?: LucideIcon;
	badge?: number | string;
	/** Custom gradient for this tab (defaults to theme) */
	gradient?: { from: string; to: string; glow: string };
}

interface PremiumTabsProps {
	tabs: PremiumTab[];
	activeTab: string;
	onTabChange: (tabId: string) => void;
	className?: string;
}

export const PremiumTabs = ({ tabs, activeTab, onTabChange, className }: PremiumTabsProps) => {
	const { gradient: themeGradient } = useThemeGradient();

	return (
		<div
			className={cn(
				"inline-flex rounded-xl bg-card/30 backdrop-blur-xs border border-border/50 p-1.5",
				className
			)}
		>
			{tabs.map((tab) => {
				const Icon = tab.icon;
				const isActive = activeTab === tab.id;
				const gradient = tab.gradient ?? themeGradient;

				return (
					<button
						key={tab.id}
						type="button"
						onClick={() => onTabChange(tab.id)}
						className={cn(
							"relative flex items-center gap-2 px-4 py-2.5 text-sm font-medium rounded-lg transition-all duration-300",
							isActive
								? "text-white"
								: "text-muted-foreground hover:text-foreground"
						)}
					>
						{/* Active background */}
						{isActive && (
							<div
								className="absolute inset-0 rounded-lg"
								style={{
									background: `linear-gradient(135deg, ${gradient.from}, ${gradient.to})`,
									boxShadow: `0 4px 12px -4px ${gradient.glow}`,
								}}
							/>
						)}

						{/* Icon */}
						{Icon && (
							<Icon
								className={cn(
									"h-4 w-4 relative z-10",
									!isActive && "opacity-70"
								)}
							/>
						)}

						{/* Label */}
						<span className="relative z-10">{tab.label}</span>

						{/* Badge */}
						{tab.badge !== undefined && (
							<span
								className={cn(
									"relative z-10 min-w-[20px] px-1.5 py-0.5 text-xs font-medium rounded-full text-center",
									isActive
										? "bg-white/20 text-white"
										: "bg-muted text-muted-foreground"
								)}
							>
								{tab.badge}
							</span>
						)}
					</button>
				);
			})}
		</div>
	);
};

/* =============================================================================
   FILTER SELECT
   Premium styled select dropdown
   ============================================================================= */

interface FilterSelectProps {
	value: string;
	onChange: (value: string) => void;
	options: Array<{ value: string; label: string }>;
	label?: string;
	className?: string;
}

export const FilterSelect = ({
	value,
	onChange,
	options,
	label,
	className,
}: FilterSelectProps) => {
	return (
		<div className={cn("flex flex-col gap-1.5", className)}>
			{label && (
				<label className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
					{label}
				</label>
			)}
			<select
				value={value}
				onChange={(e) => onChange(e.target.value)}
				className="rounded-lg border border-border/50 bg-background/50 px-3 py-2 text-sm
					focus:outline-hidden focus:border-primary focus:ring-1 focus:ring-primary/20
					[&>option]:bg-background [&>option]:text-foreground"
			>
				{options.map((option) => (
					<option key={option.value} value={option.value}>
						{option.label}
					</option>
				))}
			</select>
		</div>
	);
};

/* =============================================================================
   PREMIUM BUTTON VARIANTS
   Theme-aware button styles
   ============================================================================= */

interface GradientButtonProps {
	children: ReactNode;
	onClick?: () => void;
	disabled?: boolean;
	icon?: LucideIcon;
	variant?: "primary" | "secondary" | "ghost";
	size?: "sm" | "md" | "lg";
	className?: string;
}

export const GradientButton = ({
	children,
	onClick,
	disabled = false,
	icon: Icon,
	variant = "primary",
	size = "md",
	className,
}: GradientButtonProps) => {
	const { gradient: themeGradient } = useThemeGradient();

	const sizeClasses = {
		sm: "px-3 py-1.5 text-sm gap-1.5",
		md: "px-4 py-2 text-sm gap-2",
		lg: "px-6 py-3 text-base gap-2",
	}[size];

	const iconSizes = { sm: "h-3.5 w-3.5", md: "h-4 w-4", lg: "h-5 w-5" }[size];

	if (variant === "primary") {
		return (
			<button
				type="button"
				onClick={onClick}
				disabled={disabled}
				className={cn(
					"relative inline-flex items-center justify-center font-medium rounded-lg",
					"text-white transition-all duration-300",
					"disabled:opacity-50 disabled:cursor-not-allowed",
					"hover:scale-[1.02] hover:shadow-lg active:scale-[0.98]",
					sizeClasses,
					className
				)}
				style={{
					background: `linear-gradient(135deg, ${themeGradient.from}, ${themeGradient.to})`,
					boxShadow: `0 4px 14px -4px ${themeGradient.glow}`,
				}}
			>
				{Icon && <Icon className={iconSizes} />}
				{children}
			</button>
		);
	}

	if (variant === "secondary") {
		return (
			<button
				type="button"
				onClick={onClick}
				disabled={disabled}
				className={cn(
					"relative inline-flex items-center justify-center font-medium rounded-lg",
					"border border-border/50 bg-card/50 backdrop-blur-xs",
					"text-foreground transition-all duration-300",
					"disabled:opacity-50 disabled:cursor-not-allowed",
					"hover:border-border hover:bg-card/80",
					sizeClasses,
					className
				)}
			>
				{Icon && <Icon className={iconSizes} />}
				{children}
			</button>
		);
	}

	// Ghost variant
	return (
		<button
			type="button"
			onClick={onClick}
			disabled={disabled}
			className={cn(
				"relative inline-flex items-center justify-center font-medium rounded-lg",
				"text-muted-foreground transition-all duration-300",
				"disabled:opacity-50 disabled:cursor-not-allowed",
				"hover:text-foreground hover:bg-muted/50",
				sizeClasses,
				className
			)}
		>
			{Icon && <Icon className={iconSizes} />}
			{children}
		</button>
	);
};

/* =============================================================================
   PREMIUM LOADING SKELETON
   Premium skeleton loaders
   ============================================================================= */

interface PremiumSkeletonProps {
	className?: string;
	variant?: "line" | "card" | "circle";
	style?: React.CSSProperties;
}

export const PremiumSkeleton = ({ className, variant = "line", style }: PremiumSkeletonProps) => {
	const baseClass = "bg-muted/50 animate-pulse";

	if (variant === "card") {
		return (
			<div
				className={cn(
					baseClass,
					"rounded-2xl h-48",
					className
				)}
				style={style}
			/>
		);
	}

	if (variant === "circle") {
		return (
			<div
				className={cn(
					baseClass,
					"rounded-full h-12 w-12",
					className
				)}
				style={style}
			/>
		);
	}

	return (
		<div
			className={cn(
				baseClass,
				"rounded-lg h-4",
				className
			)}
			style={style}
		/>
	);
};

/* =============================================================================
   PREMIUM PAGE LOADING
   Full page loading state
   ============================================================================= */

interface PremiumPageLoadingProps {
	showHeader?: boolean;
	cardCount?: number;
}

export const PremiumPageLoading = ({
	showHeader = true,
	cardCount = 4,
}: PremiumPageLoadingProps) => {
	return (
		<div className="space-y-8 animate-in fade-in duration-500">
			{showHeader && (
				<div className="space-y-4">
					<PremiumSkeleton className="h-8 w-48" />
					<PremiumSkeleton className="h-10 w-64" />
				</div>
			)}
			<div className={cn("grid gap-4", cardCount <= 2 ? "md:grid-cols-2" : "md:grid-cols-2 xl:grid-cols-4")}>
				{Array.from({ length: cardCount }).map((_, i) => (
					<PremiumSkeleton
						key={i}
						variant="card"
						className="h-32"
						style={{ animationDelay: `${i * 50}ms` } as React.CSSProperties}
					/>
				))}
			</div>
		</div>
	);
};
