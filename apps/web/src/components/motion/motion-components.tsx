"use client";

import { motion, type HTMLMotionProps, type Variants } from "framer-motion";
import { forwardRef } from "react";
import { cn } from "../../lib/utils";

/**
 * Motion Components Library
 *
 * A collection of Framer Motion-enhanced components that add
 * premium micro-interactions to the UI.
 *
 * These components use spring physics for natural-feeling animations
 * that set "cutting edge" apps apart from standard UIs.
 */

// ============================================
// SPRING CONFIGURATIONS
// ============================================

/**
 * Spring presets for consistent motion feel across the app
 */
export const springs = {
	/** Gentle, subtle animations */
	soft: { type: "spring", stiffness: 300, damping: 30 } as const,
	/** Standard snappy feel */
	snappy: { type: "spring", stiffness: 400, damping: 25 } as const,
	/** Quick, responsive interactions */
	quick: { type: "spring", stiffness: 500, damping: 30 } as const,
	/** Bouncy, playful animations */
	bouncy: { type: "spring", stiffness: 400, damping: 15 } as const,
};

// ============================================
// MOTION CARD
// ============================================

interface MotionCardProps extends HTMLMotionProps<"div"> {
	/** Enable hover lift effect */
	hoverLift?: boolean;
	/** Enable tap scale effect */
	tapScale?: boolean;
	/** Custom hover scale */
	hoverScale?: number;
	/** Custom tap scale */
	tapScaleValue?: number;
}

/**
 * MotionCard - A card with hover/tap micro-interactions
 *
 * @example
 * ```tsx
 * <MotionCard hoverLift className="p-6 bg-card rounded-xl">
 *   Card content
 * </MotionCard>
 * ```
 */
export const MotionCard = forwardRef<HTMLDivElement, MotionCardProps>(
	(
		{
			children,
			className,
			hoverLift = true,
			tapScale = false,
			hoverScale = 1.02,
			tapScaleValue = 0.98,
			...props
		},
		ref
	) => {
		return (
			<motion.div
				ref={ref}
				className={cn(className)}
				whileHover={
					hoverLift
						? {
								y: -4,
								scale: hoverScale,
								transition: springs.soft,
						  }
						: undefined
				}
				whileTap={
					tapScale
						? {
								scale: tapScaleValue,
								transition: springs.quick,
						  }
						: undefined
				}
				{...props}
			>
				{children}
			</motion.div>
		);
	}
);
MotionCard.displayName = "MotionCard";

// ============================================
// MOTION BUTTON
// ============================================

interface MotionButtonProps extends HTMLMotionProps<"button"> {
	/** Disable all motion effects */
	disableMotion?: boolean;
}

/**
 * MotionButton - A button with tap scale micro-interaction
 *
 * @example
 * ```tsx
 * <MotionButton onClick={handleClick} className="px-4 py-2 bg-primary">
 *   Click me
 * </MotionButton>
 * ```
 */
export const MotionButton = forwardRef<HTMLButtonElement, MotionButtonProps>(
	({ children, className, disableMotion = false, ...props }, ref) => {
		return (
			<motion.button
				ref={ref}
				className={cn(className)}
				whileHover={
					!disableMotion
						? {
								scale: 1.02,
								transition: springs.soft,
						  }
						: undefined
				}
				whileTap={
					!disableMotion
						? {
								scale: 0.97,
								transition: springs.quick,
						  }
						: undefined
				}
				{...props}
			>
				{children}
			</motion.button>
		);
	}
);
MotionButton.displayName = "MotionButton";

// ============================================
// MOTION FADE
// ============================================

interface MotionFadeProps extends HTMLMotionProps<"div"> {
	/** Direction to fade in from */
	direction?: "up" | "down" | "left" | "right" | "none";
	/** Distance to travel (in pixels) */
	distance?: number;
	/** Animation delay in seconds */
	delay?: number;
	/** Animation duration in seconds */
	duration?: number;
}

/**
 * MotionFade - Fade in animation wrapper
 *
 * @example
 * ```tsx
 * <MotionFade direction="up" delay={0.2}>
 *   Content that fades in from below
 * </MotionFade>
 * ```
 */
export const MotionFade = forwardRef<HTMLDivElement, MotionFadeProps>(
	(
		{
			children,
			className,
			direction = "up",
			distance = 20,
			delay = 0,
			duration = 0.4,
			...props
		},
		ref
	) => {
		const getInitialPosition = () => {
			switch (direction) {
				case "up":
					return { y: distance };
				case "down":
					return { y: -distance };
				case "left":
					return { x: distance };
				case "right":
					return { x: -distance };
				default:
					return {};
			}
		};

		return (
			<motion.div
				ref={ref}
				className={cn(className)}
				initial={{ opacity: 0, ...getInitialPosition() }}
				animate={{ opacity: 1, x: 0, y: 0 }}
				transition={{
					duration,
					delay,
					ease: [0.25, 0.1, 0.25, 1], // Smooth ease-out
				}}
				{...props}
			>
				{children}
			</motion.div>
		);
	}
);
MotionFade.displayName = "MotionFade";

// ============================================
// MOTION LIST
// ============================================

interface MotionListProps extends HTMLMotionProps<"div"> {
	/** Stagger delay between items (seconds) */
	staggerDelay?: number;
	/** Initial delay before animation starts */
	initialDelay?: number;
}

/**
 * Container variants for staggered list animations
 */
const listContainerVariants: Variants = {
	hidden: { opacity: 1 },
	visible: (custom: { staggerDelay: number; initialDelay: number }) => ({
		opacity: 1,
		transition: {
			delayChildren: custom.initialDelay,
			staggerChildren: custom.staggerDelay,
		},
	}),
};

/**
 * MotionList - Container for staggered list item animations
 *
 * @example
 * ```tsx
 * <MotionList staggerDelay={0.1}>
 *   <MotionListItem>Item 1</MotionListItem>
 *   <MotionListItem>Item 2</MotionListItem>
 *   <MotionListItem>Item 3</MotionListItem>
 * </MotionList>
 * ```
 */
export const MotionList = forwardRef<HTMLDivElement, MotionListProps>(
	({ children, className, staggerDelay = 0.05, initialDelay = 0, ...props }, ref) => {
		return (
			<motion.div
				ref={ref}
				className={cn(className)}
				variants={listContainerVariants}
				initial="hidden"
				animate="visible"
				custom={{ staggerDelay, initialDelay }}
				{...props}
			>
				{children}
			</motion.div>
		);
	}
);
MotionList.displayName = "MotionList";

// ============================================
// MOTION LIST ITEM
// ============================================

interface MotionListItemProps extends HTMLMotionProps<"div"> {
	/** Direction to animate from */
	direction?: "up" | "down" | "left" | "right";
}

/**
 * List item variants for staggered animations
 */
const listItemVariants: Variants = {
	hidden: (direction: string) => {
		const distance = 20;
		switch (direction) {
			case "up":
				return { opacity: 0, y: distance };
			case "down":
				return { opacity: 0, y: -distance };
			case "left":
				return { opacity: 0, x: distance };
			case "right":
				return { opacity: 0, x: -distance };
			default:
				return { opacity: 0, y: distance };
		}
	},
	visible: {
		opacity: 1,
		x: 0,
		y: 0,
		transition: {
			type: "spring",
			stiffness: 300,
			damping: 24,
		},
	},
};

/**
 * MotionListItem - Individual items for staggered list animations
 *
 * @example
 * ```tsx
 * <MotionList>
 *   <MotionListItem>Fades in with stagger</MotionListItem>
 * </MotionList>
 * ```
 */
export const MotionListItem = forwardRef<HTMLDivElement, MotionListItemProps>(
	({ children, className, direction = "up", ...props }, ref) => {
		return (
			<motion.div
				ref={ref}
				className={cn(className)}
				variants={listItemVariants}
				custom={direction}
				{...props}
			>
				{children}
			</motion.div>
		);
	}
);
MotionListItem.displayName = "MotionListItem";

// ============================================
// MOTION SCALE
// ============================================

interface MotionScaleProps extends HTMLMotionProps<"div"> {
	/** Initial scale (0-1) */
	initialScale?: number;
	/** Animation delay */
	delay?: number;
}

/**
 * MotionScale - Scale-in animation wrapper
 *
 * @example
 * ```tsx
 * <MotionScale delay={0.2}>
 *   Content that scales in
 * </MotionScale>
 * ```
 */
export const MotionScale = forwardRef<HTMLDivElement, MotionScaleProps>(
	({ children, className, initialScale = 0.95, delay = 0, ...props }, ref) => {
		return (
			<motion.div
				ref={ref}
				className={cn(className)}
				initial={{ opacity: 0, scale: initialScale }}
				animate={{ opacity: 1, scale: 1 }}
				transition={{
					...springs.soft,
					delay,
				}}
				{...props}
			>
				{children}
			</motion.div>
		);
	}
);
MotionScale.displayName = "MotionScale";

// ============================================
// MOTION GLOW (for hover effects)
// ============================================

interface MotionGlowProps extends HTMLMotionProps<"div"> {
	/** Glow color (hex or rgba) */
	glowColor?: string;
	/** Glow intensity (blur radius in px) */
	glowIntensity?: number;
}

/**
 * MotionGlow - Adds a glowing effect on hover
 *
 * @example
 * ```tsx
 * <MotionGlow glowColor="rgba(59, 130, 246, 0.4)">
 *   <Button>Glowing Button</Button>
 * </MotionGlow>
 * ```
 */
export const MotionGlow = forwardRef<HTMLDivElement, MotionGlowProps>(
	({ children, className, glowColor = "rgba(59, 130, 246, 0.3)", glowIntensity = 20, ...props }, ref) => {
		return (
			<motion.div
				ref={ref}
				className={cn("relative", className)}
				whileHover={{
					boxShadow: `0 0 ${glowIntensity}px ${glowColor}`,
					transition: springs.soft,
				}}
				{...props}
			>
				{children}
			</motion.div>
		);
	}
);
MotionGlow.displayName = "MotionGlow";

// ============================================
// MOTION PRESENCE (for enter/exit animations)
// ============================================

export { AnimatePresence } from "framer-motion";
