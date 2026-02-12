"use client";

import type { ReactNode } from "react";
import { cn } from "../../lib/utils";
import { getServiceGradient, SEMANTIC_COLORS } from "../../lib/theme-gradients";
import { useThemeGradient } from "../../hooks/useThemeGradient";
import type { LucideIcon } from "lucide-react";

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
				"rounded-xl border border-border/50 bg-card/30 backdrop-blur-xs overflow-x-auto",
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
   SERVICE BADGE
   Service-specific badge with consistent colors (Sonarr, Radarr, Prowlarr)
   ============================================================================= */

interface ServiceBadgeProps {
	service: "sonarr" | "radarr" | "prowlarr" | string;
	className?: string;
}

export const ServiceBadge = ({ service, className }: ServiceBadgeProps) => {
	const gradient = getServiceGradient(service);

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
	const { gradient: themeGradient } = useThemeGradient();

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
	const { gradient: themeGradient } = useThemeGradient();

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
