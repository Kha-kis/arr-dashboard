"use client";

import { motion } from "framer-motion";
import type { ReactNode } from "react";
import { cn } from "../../lib/utils";
import { springs } from "../motion";

/**
 * Bento Grid Layout System
 *
 * A modern, Apple-inspired grid layout with cards of varying sizes.
 * Perfect for dashboards and feature showcases.
 */

interface BentoGridProps {
	children: ReactNode;
	className?: string;
	/** Number of columns at different breakpoints */
	columns?: {
		default?: number;
		sm?: number;
		md?: number;
		lg?: number;
		xl?: number;
	};
}

/**
 * BentoGrid - Container for bento-style grid layout
 *
 * @example
 * ```tsx
 * <BentoGrid>
 *   <BentoCard size="2x2">Hero card</BentoCard>
 *   <BentoCard size="1x1">Small card</BentoCard>
 *   <BentoCard size="2x1">Wide card</BentoCard>
 * </BentoGrid>
 * ```
 */
export function BentoGrid({
	children,
	className,
	columns = { default: 1, sm: 2, md: 3, lg: 4 },
}: BentoGridProps) {
	return (
		<div
			className={cn(
				"grid gap-4 auto-rows-[minmax(180px,auto)]",
				// Responsive columns using CSS grid
				columns.default === 1 && "grid-cols-1",
				columns.default === 2 && "grid-cols-2",
				columns.default === 3 && "grid-cols-3",
				columns.default === 4 && "grid-cols-4",
				columns.sm === 2 && "sm:grid-cols-2",
				columns.sm === 3 && "sm:grid-cols-3",
				columns.md === 2 && "md:grid-cols-2",
				columns.md === 3 && "md:grid-cols-3",
				columns.md === 4 && "md:grid-cols-4",
				columns.lg === 3 && "lg:grid-cols-3",
				columns.lg === 4 && "lg:grid-cols-4",
				columns.lg === 5 && "lg:grid-cols-5",
				columns.xl === 4 && "xl:grid-cols-4",
				columns.xl === 5 && "xl:grid-cols-5",
				columns.xl === 6 && "xl:grid-cols-6",
				className
			)}
		>
			{children}
		</div>
	);
}

type BentoCardSize = "1x1" | "2x1" | "1x2" | "2x2";

interface BentoCardProps {
	children: ReactNode;
	className?: string;
	/** Card size: 1x1 (default), 2x1 (wide), 1x2 (tall), 2x2 (large) */
	size?: BentoCardSize;
	/** Animation delay in milliseconds */
	animationDelay?: number;
	/** Enable hover effects */
	interactive?: boolean;
	/** Click handler */
	onClick?: () => void;
	/** Background gradient colors */
	gradient?: { from: string; to: string; glow: string };
}

/**
 * Get grid span classes for card size
 */
function getSizeClasses(size: BentoCardSize): string {
	switch (size) {
		case "2x1":
			return "md:col-span-2";
		case "1x2":
			return "md:row-span-2";
		case "2x2":
			return "md:col-span-2 md:row-span-2";
		case "1x1":
		default:
			return "";
	}
}

/**
 * BentoCard - Individual card for the bento grid
 *
 * Features:
 * - Multiple sizes (1x1, 2x1, 1x2, 2x2)
 * - Animated entrance
 * - Optional hover lift effect
 * - Optional gradient background
 *
 * @example
 * ```tsx
 * <BentoCard size="2x1" interactive gradient={themeGradient}>
 *   <h3>Wide Card</h3>
 *   <p>Content here</p>
 * </BentoCard>
 * ```
 */
export function BentoCard({
	children,
	className,
	size = "1x1",
	animationDelay = 0,
	interactive = false,
	onClick,
	gradient,
}: BentoCardProps) {
	const sizeClasses = getSizeClasses(size);

	return (
		<motion.div
			className={cn(
				"group relative overflow-hidden rounded-2xl border border-border/50 bg-card/50 backdrop-blur-sm",
				"transition-colors duration-300",
				interactive && "cursor-pointer hover:border-border",
				sizeClasses,
				className
			)}
			initial={{ opacity: 0, y: 20, scale: 0.95 }}
			animate={{ opacity: 1, y: 0, scale: 1 }}
			transition={{
				...springs.soft,
				delay: animationDelay / 1000,
			}}
			whileHover={
				interactive
					? {
							y: -4,
							scale: 1.01,
							boxShadow: gradient
								? `0 20px 40px -12px ${gradient.glow}`
								: "0 20px 40px -12px rgba(0,0,0,0.2)",
							transition: springs.soft,
						}
					: undefined
			}
			whileTap={
				interactive && onClick
					? {
							scale: 0.98,
							transition: springs.quick,
						}
					: undefined
			}
			onClick={onClick}
		>
			{/* Ambient glow on hover */}
			{gradient && (
				<div
					className={cn(
						"pointer-events-none absolute -inset-4 opacity-0 blur-2xl transition-opacity duration-500",
						interactive && "group-hover:opacity-30"
					)}
					style={{ backgroundColor: gradient.glow }}
				/>
			)}

			{/* Content */}
			<div className="relative h-full p-6">{children}</div>

			{/* Gradient border effect on hover */}
			{interactive && gradient && (
				<div
					className="absolute inset-0 opacity-0 group-hover:opacity-100 transition-opacity duration-500 rounded-2xl pointer-events-none"
					style={{
						background: `linear-gradient(135deg, ${gradient.from}10, ${gradient.to}05)`,
					}}
				/>
			)}
		</motion.div>
	);
}

/**
 * BentoCardHeader - Header section for bento cards
 */
export function BentoCardHeader({
	children,
	className,
}: {
	children: ReactNode;
	className?: string;
}) {
	return (
		<div className={cn("flex items-center gap-3 mb-4", className)}>
			{children}
		</div>
	);
}

/**
 * BentoCardIcon - Icon wrapper with gradient background
 */
export function BentoCardIcon({
	children,
	gradient,
	className,
}: {
	children: ReactNode;
	gradient?: { from: string; to: string; glow: string };
	className?: string;
}) {
	return (
		<div
			className={cn(
				"flex h-10 w-10 items-center justify-center rounded-xl",
				!gradient && "bg-muted",
				className
			)}
			style={
				gradient
					? {
							background: `linear-gradient(135deg, ${gradient.from}, ${gradient.to})`,
							boxShadow: `0 4px 12px -4px ${gradient.glow}`,
						}
					: undefined
			}
		>
			{children}
		</div>
	);
}

/**
 * BentoCardTitle - Title for bento cards
 */
export function BentoCardTitle({
	children,
	className,
}: {
	children: ReactNode;
	className?: string;
}) {
	return (
		<h3 className={cn("text-lg font-semibold text-foreground", className)}>
			{children}
		</h3>
	);
}

/**
 * BentoCardDescription - Description text for bento cards
 */
export function BentoCardDescription({
	children,
	className,
}: {
	children: ReactNode;
	className?: string;
}) {
	return (
		<p className={cn("text-sm text-muted-foreground", className)}>{children}</p>
	);
}

/**
 * BentoCardValue - Large value display (for stats)
 */
export function BentoCardValue({
	children,
	gradient,
	className,
}: {
	children: ReactNode;
	gradient?: { from: string; to: string };
	className?: string;
}) {
	return (
		<span
			className={cn("text-4xl font-bold tracking-tight", className)}
			style={
				gradient
					? {
							background: `linear-gradient(135deg, ${gradient.from}, ${gradient.to})`,
							WebkitBackgroundClip: "text",
							WebkitTextFillColor: "transparent",
							backgroundClip: "text",
						}
					: undefined
			}
		>
			{children}
		</span>
	);
}
