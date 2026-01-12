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
	// Spring configurations
	springs,

	// Card with hover lift
	MotionCard,

	// Button with tap scale
	MotionButton,

	// Fade in animations
	MotionFade,

	// Staggered list animations
	MotionList,
	MotionListItem,

	// Scale in animation
	MotionScale,

	// Hover glow effect
	MotionGlow,

	// Re-export AnimatePresence for enter/exit
	AnimatePresence,
} from "./motion-components";

// Page transition for smooth navigation animations
export { PageTransition, pageVariants, pageTransition } from "./page-transition";
