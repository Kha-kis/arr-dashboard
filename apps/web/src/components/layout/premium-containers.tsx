"use client";

import type { ReactNode } from "react";
import { cn } from "../../lib/utils";
import { getServiceGradient } from "../../lib/theme-gradients";
import { useThemeGradient } from "../../hooks/useThemeGradient";
import type { LucideIcon } from "lucide-react";
import { ServiceBadge } from "./premium-data-display";

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
	const { gradient: themeGradient } = useThemeGradient();

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
	const { gradient: themeGradient } = useThemeGradient();

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

export interface GlassmorphicCardProps {
	children: ReactNode;
	className?: string;
	padding?: "none" | "sm" | "md" | "lg";
	animationDelay?: number;
	style?: React.CSSProperties;
}

export const GlassmorphicCard = ({
	children,
	className,
	padding = "md",
	animationDelay = 0,
	style,
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
				"rounded-2xl border border-border/50 bg-card/30 backdrop-blur-xs",
				"animate-in fade-in slide-in-from-bottom-4 duration-500",
				paddingClass,
				className
			)}
			style={{
				animationDelay: style?.animationDelay ?? `${animationDelay}ms`,
				animationFillMode: "backwards",
				...style,
			}}
		>
			{children}
		</div>
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
	isActive: _isActive = true,
	status,
	stats,
	actions,
	children,
	className,
	animationDelay = 0,
}: InstanceCardProps) => {
	const gradient = getServiceGradient(service);

	return (
		<div
			className={cn(
				"group relative overflow-hidden rounded-2xl border border-border/50 bg-card/30 backdrop-blur-xs",
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
