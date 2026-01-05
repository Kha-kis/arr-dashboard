"use client";

import type { ReactNode } from "react";
import { cn } from "../../lib/utils";
import { THEME_GRADIENTS, SERVICE_GRADIENTS, SEMANTIC_COLORS } from "../../lib/theme-gradients";
import { useColorTheme } from "../../providers/color-theme-provider";
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
	const { colorTheme } = useColorTheme();
	const themeGradient = THEME_GRADIENTS[colorTheme];

	return (
		<div
			className={cn(
				"inline-flex rounded-xl bg-card/30 backdrop-blur-sm border border-border/50 p-1.5",
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
   PREMIUM TABLE
   Glassmorphic table wrapper with theme-aware styling
   ============================================================================= */

interface PremiumTableProps {
	children: ReactNode;
	className?: string;
}

export const PremiumTable = ({ children, className }: PremiumTableProps) => {
	return (
		<div
			className={cn(
				"rounded-xl border border-border/50 bg-card/30 backdrop-blur-sm overflow-hidden",
				className
			)}
		>
			{children}
		</div>
	);
};

interface PremiumTableHeaderProps {
	children: ReactNode;
	className?: string;
}

export const PremiumTableHeader = ({ children, className }: PremiumTableHeaderProps) => {
	return (
		<thead className={cn("border-b border-border/50 bg-muted/30", className)}>
			{children}
		</thead>
	);
};

interface PremiumTableRowProps {
	children: ReactNode;
	className?: string;
	isHoverable?: boolean;
}

export const PremiumTableRow = ({
	children,
	className,
	isHoverable = true,
}: PremiumTableRowProps) => {
	return (
		<tr
			className={cn(
				"border-b border-border/30 last:border-0",
				isHoverable && "hover:bg-muted/20 transition-colors",
				className
			)}
		>
			{children}
		</tr>
	);
};

/* =============================================================================
   PREMIUM EMPTY STATE
   Empty state with theme gradient icon and styling
   ============================================================================= */

interface PremiumEmptyStateProps {
	icon: LucideIcon;
	title: string;
	description?: string;
	action?: ReactNode;
	className?: string;
}

export const PremiumEmptyState = ({
	icon: Icon,
	title,
	description,
	action,
	className,
}: PremiumEmptyStateProps) => {
	const { colorTheme } = useColorTheme();
	const themeGradient = THEME_GRADIENTS[colorTheme];

	return (
		<div
			className={cn(
				"flex flex-col items-center justify-center py-16 px-8 text-center",
				"rounded-2xl border-2 border-dashed border-border/50 bg-card/20",
				className
			)}
		>
			{/* Icon with gradient background */}
			<div
				className="mb-6 flex h-20 w-20 items-center justify-center rounded-2xl"
				style={{
					background: `linear-gradient(135deg, ${themeGradient.from}20, ${themeGradient.to}20)`,
					border: `1px solid ${themeGradient.from}30`,
				}}
			>
				<Icon className="h-10 w-10" style={{ color: themeGradient.from }} />
			</div>

			{/* Title */}
			<h3 className="text-xl font-semibold mb-2">{title}</h3>

			{/* Description */}
			{description && (
				<p className="text-muted-foreground max-w-md mb-6">{description}</p>
			)}

			{/* Action */}
			{action}
		</div>
	);
};

/* =============================================================================
   PREMIUM PROGRESS BAR
   Theme-aware progress bar with glow effect
   ============================================================================= */

interface PremiumProgressProps {
	value: number;
	max?: number;
	/** Semantic color overrides theme */
	variant?: "default" | "success" | "warning" | "danger";
	/** Show percentage label */
	showLabel?: boolean;
	/** Size variant */
	size?: "sm" | "md" | "lg";
	className?: string;
}

export const PremiumProgress = ({
	value,
	max = 100,
	variant = "default",
	showLabel = false,
	size = "md",
	className,
}: PremiumProgressProps) => {
	const { colorTheme } = useColorTheme();
	const themeGradient = THEME_GRADIENTS[colorTheme];

	const percentage = Math.min((value / max) * 100, 100);

	const getColors = () => {
		switch (variant) {
			case "success":
				return SEMANTIC_COLORS.success;
			case "warning":
				return SEMANTIC_COLORS.warning;
			case "danger":
				return SEMANTIC_COLORS.error;
			default:
				return { from: themeGradient.from, to: themeGradient.to, glow: themeGradient.glow };
		}
	};

	const colors = getColors();
	const heightClass = { sm: "h-1.5", md: "h-2", lg: "h-3" }[size];

	return (
		<div className={cn("w-full", className)}>
			{showLabel && (
				<div className="flex justify-between text-xs text-muted-foreground mb-1">
					<span>{value}</span>
					<span>{percentage.toFixed(0)}%</span>
				</div>
			)}
			<div className={cn("bg-muted/50 rounded-full overflow-hidden", heightClass)}>
				<div
					className="h-full rounded-full transition-all duration-500"
					style={{
						width: `${percentage}%`,
						background: `linear-gradient(90deg, ${colors.from}, ${colors.to})`,
						boxShadow: `0 0 8px ${colors.glow}`,
					}}
				/>
			</div>
		</div>
	);
};

/* =============================================================================
   SERVICE BADGE
   Service-specific badge with consistent colors (Sonarr, Radarr, Prowlarr)
   ============================================================================= */

interface ServiceBadgeProps {
	service: "sonarr" | "radarr" | "prowlarr" | string;
	className?: string;
}

export const ServiceBadge = ({ service, className }: ServiceBadgeProps) => {
	const serviceKey = service.toLowerCase() as keyof typeof SERVICE_GRADIENTS;
	const gradient = SERVICE_GRADIENTS[serviceKey] ?? SERVICE_GRADIENTS.prowlarr;

	return (
		<span
			className={cn(
				"inline-flex items-center rounded-md px-2 py-0.5 text-xs font-medium capitalize",
				className
			)}
			style={{
				backgroundColor: `${gradient.from}20`,
				color: gradient.from,
				border: `1px solid ${gradient.from}40`,
			}}
		>
			{service}
		</span>
	);
};

/* =============================================================================
   STATUS BADGE
   Status badge with semantic colors
   ============================================================================= */

interface StatusBadgeProps {
	status: "success" | "warning" | "error" | "info" | "default";
	children: ReactNode;
	icon?: LucideIcon;
	className?: string;
}

export const StatusBadge = ({ status, children, icon: Icon, className }: StatusBadgeProps) => {
	const { colorTheme } = useColorTheme();
	const themeGradient = THEME_GRADIENTS[colorTheme];

	const getColors = () => {
		switch (status) {
			case "success":
				return SEMANTIC_COLORS.success;
			case "warning":
				return SEMANTIC_COLORS.warning;
			case "error":
				return SEMANTIC_COLORS.error;
			case "info":
				return {
					bg: themeGradient.fromLight,
					border: themeGradient.fromMuted,
					text: themeGradient.from,
				};
			default:
				return {
					bg: "rgba(100, 116, 139, 0.1)",
					border: "rgba(100, 116, 139, 0.3)",
					text: "rgb(148, 163, 184)",
				};
		}
	};

	const colors = getColors();

	return (
		<span
			className={cn(
				"inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-xs font-medium",
				className
			)}
			style={{
				backgroundColor: colors.bg,
				color: colors.text,
				border: `1px solid ${colors.border}`,
			}}
		>
			{Icon && <Icon className="h-3 w-3" />}
			{children}
		</span>
	);
};

/* =============================================================================
   INSTANCE CARD
   Reusable instance status card with service gradient
   ============================================================================= */

interface InstanceCardProps {
	instanceName: string;
	service: "sonarr" | "radarr" | "prowlarr" | string;
	isActive?: boolean;
	status?: ReactNode;
	stats?: ReactNode;
	actions?: ReactNode;
	children?: ReactNode;
	className?: string;
	animationDelay?: number;
}

export const InstanceCard = ({
	instanceName,
	service,
	isActive = true,
	status,
	stats,
	actions,
	children,
	className,
	animationDelay = 0,
}: InstanceCardProps) => {
	const serviceKey = service.toLowerCase() as keyof typeof SERVICE_GRADIENTS;
	const gradient = SERVICE_GRADIENTS[serviceKey] ?? SERVICE_GRADIENTS.prowlarr;

	return (
		<div
			className={cn(
				"group relative overflow-hidden rounded-2xl border border-border/50 bg-card/30 backdrop-blur-sm",
				"transition-all duration-300 hover:border-border hover:shadow-lg",
				"animate-in fade-in slide-in-from-bottom-4 duration-500",
				className
			)}
			style={{
				animationDelay: `${animationDelay}ms`,
				animationFillMode: "backwards",
			}}
		>
			{/* Top gradient accent line */}
			<div
				className="absolute top-0 left-0 right-0 h-1"
				style={{
					background: `linear-gradient(90deg, ${gradient.from}, ${gradient.to})`,
				}}
			/>

			{/* Hover glow */}
			<div
				className="pointer-events-none absolute -inset-4 opacity-0 blur-2xl transition-opacity duration-500 group-hover:opacity-20"
				style={{ backgroundColor: gradient.glow }}
			/>

			{/* Header */}
			<div className="relative p-4 pb-0">
				<div className="flex items-start justify-between mb-3">
					<div>
						<div className="flex items-center gap-2 mb-1">
							<h3 className="font-semibold text-foreground">{instanceName}</h3>
							<ServiceBadge service={service} />
						</div>
						{status}
					</div>
					{actions}
				</div>
			</div>

			{/* Stats */}
			{stats && (
				<div className="relative px-4 py-3 border-t border-border/30">
					{stats}
				</div>
			)}

			{/* Custom content */}
			{children && (
				<div className="relative px-4 pb-4">
					{children}
				</div>
			)}
		</div>
	);
};

/* =============================================================================
   PREMIUM SECTION
   Section wrapper with consistent premium styling
   ============================================================================= */

interface PremiumSectionProps {
	title?: string;
	description?: string;
	icon?: LucideIcon;
	actions?: ReactNode;
	children: ReactNode;
	className?: string;
	animationDelay?: number;
}

export const PremiumSection = ({
	title,
	description,
	icon: Icon,
	actions,
	children,
	className,
	animationDelay = 0,
}: PremiumSectionProps) => {
	const { colorTheme } = useColorTheme();
	const themeGradient = THEME_GRADIENTS[colorTheme];

	return (
		<section
			className={cn(
				"animate-in fade-in slide-in-from-bottom-4 duration-500",
				className
			)}
			style={{
				animationDelay: `${animationDelay}ms`,
				animationFillMode: "backwards",
			}}
		>
			{(title || actions) && (
				<div className="flex items-center justify-between mb-4">
					<div className="flex items-center gap-3">
						{Icon && (
							<div
								className="flex h-8 w-8 items-center justify-center rounded-lg"
								style={{
									background: `linear-gradient(135deg, ${themeGradient.from}20, ${themeGradient.to}20)`,
									border: `1px solid ${themeGradient.from}30`,
								}}
							>
								<Icon className="h-4 w-4" style={{ color: themeGradient.from }} />
							</div>
						)}
						{(title || description) && (
							<div>
								{title && (
									<h3 className="font-semibold text-foreground">{title}</h3>
								)}
								{description && (
									<p className="text-sm text-muted-foreground">{description}</p>
								)}
							</div>
						)}
					</div>
					{actions}
				</div>
			)}
			{children}
		</section>
	);
};

/* =============================================================================
   GLASSMORPHIC CARD
   Simple glassmorphic container without header
   ============================================================================= */

interface GlassmorphicCardProps {
	children: ReactNode;
	className?: string;
	padding?: "none" | "sm" | "md" | "lg";
	animationDelay?: number;
}

export const GlassmorphicCard = ({
	children,
	className,
	padding = "md",
	animationDelay = 0,
}: GlassmorphicCardProps) => {
	const paddingClass = {
		none: "",
		sm: "p-4",
		md: "p-6",
		lg: "p-8",
	}[padding];

	return (
		<div
			className={cn(
				"rounded-2xl border border-border/50 bg-card/30 backdrop-blur-sm",
				"animate-in fade-in slide-in-from-bottom-4 duration-500",
				paddingClass,
				className
			)}
			style={{
				animationDelay: `${animationDelay}ms`,
				animationFillMode: "backwards",
			}}
		>
			{children}
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
	const { colorTheme } = useColorTheme();
	const themeGradient = THEME_GRADIENTS[colorTheme];

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
					focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary/20
					[&>option]:bg-background [&>option]:text-foreground"
				style={{
					// Theme-aware focus state
				}}
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
	const { colorTheme } = useColorTheme();
	const themeGradient = THEME_GRADIENTS[colorTheme];

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
					"border border-border/50 bg-card/50 backdrop-blur-sm",
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
