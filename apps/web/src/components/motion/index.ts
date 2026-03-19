/**
 * Motion Components - Framer Motion Enhanced UI
 *
 * Import motion-enhanced components for premium micro-interactions:
 *
 * ```tsx
 * import {
 *   MotionCard,
 *   MotionButton,
 *   MotionFade,
 *   MotionList,
 *   MotionListItem,
 *   springs,
 * } from "@/components/motion";
 * ```
 */

export {
	// Re-export AnimatePresence for enter/exit
	AnimatePresence,
	// Button with tap scale
	MotionButton,
	// Card with hover lift
	MotionCard,
	// Fade in animations
	MotionFade,
	// Hover glow effect
	MotionGlow,
	// Staggered list animations
	MotionList,
	MotionListItem,
	// Scale in animation
	MotionScale,
	// Spring configurations
	springs,
} from "./motion-components";

// Page transition for smooth navigation animations
export { PageTransition, pageTransition, pageVariants } from "./page-transition";
