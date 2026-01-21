"use client";

import { motion, type Variants } from "framer-motion";
import type { ReactNode } from "react";

/**
 * Page Transition Variants
 *
 * Provides smooth, premium-feeling page transitions for navigation.
 * Uses subtle fade + slide to avoid feeling sluggish while still
 * providing visual polish.
 */
const pageVariants: Variants = {
	initial: {
		opacity: 0,
		y: 8,
	},
	animate: {
		opacity: 1,
		y: 0,
	},
	exit: {
		opacity: 0,
		y: -8,
	},
};

/**
 * Page transition timing
 * Fast enough to not feel sluggish, slow enough to be noticeable
 */
const pageTransition = {
	type: "tween" as const,
	ease: [0.25, 0.1, 0.25, 1] as [number, number, number, number], // Smooth ease-out curve
	duration: 0.25,
};

interface PageTransitionProps {
	children: ReactNode;
	/** Unique key for the page (usually pathname) */
	pageKey?: string;
	/** Custom class name for the wrapper */
	className?: string;
}

/**
 * PageTransition Component
 *
 * Wraps page content with smooth enter/exit animations.
 * Use in template.tsx or around page content.
 *
 * @example
 * ```tsx
 * // In app/template.tsx
 * export default function Template({ children }) {
 *   const pathname = usePathname();
 *   return (
 *     <PageTransition pageKey={pathname}>
 *       {children}
 *     </PageTransition>
 *   );
 * }
 * ```
 */
export function PageTransition({
	children,
	pageKey,
	className = "flex-1 flex flex-col",
}: PageTransitionProps) {
	return (
		<motion.div
			key={pageKey}
			initial="initial"
			animate="animate"
			exit="exit"
			variants={pageVariants}
			transition={pageTransition}
			className={className}
		>
			{children}
		</motion.div>
	);
}

/**
 * Frozen router context to prevent re-renders during page transitions
 * This is needed because Next.js App Router updates context before animation completes
 */
export { pageVariants, pageTransition };
