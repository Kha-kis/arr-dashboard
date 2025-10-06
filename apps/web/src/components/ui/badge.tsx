"use client";

import { cn } from "../../lib/utils";

type BadgeVariant = "default" | "success" | "warning" | "danger" | "info";
type BadgeSize = "sm" | "md" | "lg";

const variantStyles: Record<BadgeVariant, string> = {
  default: "bg-bg-muted/50 border-border/50 text-fg-muted backdrop-blur-sm",
  success: "bg-success/10 border-success/30 text-success-fg backdrop-blur-sm",
  warning: "bg-warning/10 border-warning/30 text-warning-fg backdrop-blur-sm",
  danger: "bg-danger/10 border-danger/30 text-danger-fg backdrop-blur-sm",
  info: "bg-info/10 border-info/30 text-info-fg backdrop-blur-sm",
};

const sizeStyles: Record<BadgeSize, string> = {
  sm: "px-2.5 py-1 text-xs",
  md: "px-3 py-1.5 text-xs",
  lg: "px-4 py-2 text-sm",
};

export interface BadgeProps extends React.HTMLAttributes<HTMLSpanElement> {
  variant?: BadgeVariant;
  size?: BadgeSize;
}

export const Badge = ({
  className,
  variant = "default",
  size = "md",
  ...props
}: BadgeProps) => (
  <span
    className={cn(
      "inline-flex items-center gap-1.5 rounded-full border font-semibold transition-all duration-200",
      "hover:scale-105",
      variantStyles[variant],
      sizeStyles[size],
      className,
    )}
    {...props}
  />
);
