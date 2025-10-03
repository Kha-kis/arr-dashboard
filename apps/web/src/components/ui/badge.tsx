'use client';

import { cn } from "../../lib/utils";

type BadgeVariant = "default" | "success" | "warning" | "danger" | "info";
type BadgeSize = "sm" | "md" | "lg";

const variantStyles: Record<BadgeVariant, string> = {
  default: "bg-white/10 border-border text-fg-muted",
  success: "bg-success/10 border-success/40 text-success-fg",
  warning: "bg-warning/10 border-warning/40 text-warning-fg",
  danger: "bg-danger/10 border-danger/40 text-danger-fg",
  info: "bg-info/10 border-info/40 text-info-fg",
};

const sizeStyles: Record<BadgeSize, string> = {
  sm: "px-2 py-0.5 text-xs",
  md: "px-2.5 py-0.5 text-sm",
  lg: "px-3 py-1 text-sm",
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
      "inline-flex items-center gap-1 rounded-full border font-medium",
      variantStyles[variant],
      sizeStyles[size],
      className,
    )}
    {...props}
  />
);
