"use client";

import { motion } from "framer-motion";
import type { ReactNode } from "react";

/**
 * Page Transition Template
 *
 * This template wraps all authenticated route pages with a smooth
 * enter animation. In Next.js App Router, template.tsx re-renders
 * on navigation, providing fresh animation triggers.
 *
 * Note: Exit animations require more complex setup (FrozenRouter pattern)
 * and aren't implemented here for simplicity. Enter animations provide
 * most of the premium feel.
 */
const pageEnterVariants = {
	hidden: {
		opacity: 0,
		y: 12,
	},
	visible: {
		opacity: 1,
		y: 0,
		transition: {
			type: "tween",
			ease: [0.25, 0.1, 0.25, 1],
			duration: 0.3,
		},
	},
};

export default function Template({ children }: { children: ReactNode }) {
	return (
		<motion.div
			initial="hidden"
			animate="visible"
			variants={pageEnterVariants}
			className="flex-1 flex flex-col"
		>
			{children}
		</motion.div>
	);
}
