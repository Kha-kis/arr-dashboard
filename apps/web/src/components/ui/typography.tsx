"use client";

import { createElement } from "react";
import { cn } from "@/lib/utils";

type TypographyVariant = "h1" | "h2" | "h3" | "h4" | "body" | "small" | "caption" | "overline";
type TypographyElement = "h1" | "h2" | "h3" | "h4" | "p" | "span";

interface TypographyProps {
  as?: TypographyElement;
  variant?: TypographyVariant;
  className?: string;
  children?: React.ReactNode;
}

const variantStyles: Record<TypographyVariant, string> = {
  h1: "text-4xl font-semibold text-foreground",
  h2: "text-2xl font-bold text-foreground",
  h3: "text-xl font-semibold text-foreground",
  h4: "text-lg font-semibold text-foreground",
  body: "text-base text-muted-foreground",
  small: "text-sm text-muted-foreground",
  caption: "text-xs text-muted-foreground",
  overline: "text-sm font-medium uppercase tracking-wide text-muted-foreground",
};

const defaultElements: Record<TypographyVariant, TypographyElement> = {
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
 * Provides semantic typography variants aligned with shadcn design tokens.
 * Use this instead of manual text classes for consistency.
 *
 * @example
 * ```tsx
 * <Typography variant="h1">Dashboard</Typography>
 * <Typography variant="body">Welcome back</Typography>
 * <Typography variant="overline">Status</Typography>
 * <Typography as="span" variant="small">Helper text</Typography>
 * ```
 */
export function Typography({
  as,
  variant = "body",
  className,
  children,
}: TypographyProps) {
  const element = as || defaultElements[variant];

  return createElement(
    element,
    { className: cn(variantStyles[variant], className) },
    children,
  );
}
