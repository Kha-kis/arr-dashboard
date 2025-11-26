"use client";

import { createElement } from "react";
import { cn } from "../../lib/utils";

interface TypographyProps {
	as?: "h1" | "h2" | "h3" | "h4" | "p" | "span";
	variant?: "h1" | "h2" | "h3" | "h4" | "body" | "small" | "caption" | "overline";
	className?: string;
	children?: React.ReactNode;
}

const variantStyles = {
	h1: "text-4xl font-semibold text-white",
	h2: "text-2xl font-bold text-white",
	h3: "text-xl font-semibold text-white",
	h4: "text-lg font-semibold text-white",
	body: "text-base text-white/70",
	small: "text-sm text-white/60",
	caption: "text-xs text-white/50",
	overline: "text-sm font-medium uppercase tracking-wide text-white/60",
};

const defaultElements: Record<string, string> = {
	h1: "h1",
	h2: "h2",
	h3: "h3",
	h4: "h4",
	body: "p",
	small: "p",
	caption: "span",
	overline: "p",
};

/**
 * Typography component for consistent text styling
 *
 * Provides semantic typography variants aligned with design tokens.
 * Use this instead of manual text classes for consistency.
 *
 * @example
 * ```tsx
 * <Typography variant="h1">Dashboard</Typography>
 * <Typography variant="body">Welcome back</Typography>
 * <Typography variant="overline">Status</Typography>
 * ```
 */
export const Typography = ({
	as,
	variant = "body",
	className,
	children,
}: TypographyProps) => {
	const element = as || defaultElements[variant] || "p";

	return createElement(
		element,
		{ className: cn(variantStyles[variant], className) },
		children,
	);
};
