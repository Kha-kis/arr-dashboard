"use client"

import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"
import { useColorTheme } from "../../providers/color-theme-provider"
import { THEME_GRADIENTS, SEMANTIC_COLORS } from "../../lib/theme-gradients"

/**
 * Premium Badge Variants
 *
 * Includes theme-aware gradient variant and semantic color variants.
 * All variants use rounded-lg for premium feel.
 */
const badgeVariants = cva(
  "inline-flex items-center gap-1 rounded-lg border font-medium transition-all duration-200 focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2",
  {
    variants: {
      variant: {
        // Default - solid primary
        default: "border-transparent bg-primary text-primary-foreground",
        // Gradient - theme-aware (handled separately)
        gradient: "border-transparent text-white",
        // Secondary - subtle glassmorphic
        secondary: "border-border/50 bg-muted/50 text-foreground backdrop-blur-sm",
        // Outline - border only
        outline: "border-border text-foreground bg-transparent",
        // Destructive
        destructive: "border-transparent bg-destructive text-destructive-foreground",
        // Semantic variants with subtle backgrounds
        success: "border-transparent",
        warning: "border-transparent",
        danger: "border-transparent",
        info: "border-transparent",
      },
      size: {
        xs: "px-1.5 py-0.5 text-[10px]",
        default: "px-2.5 py-0.5 text-xs",
        sm: "px-2.5 py-1 text-xs",
        md: "px-3 py-1.5 text-xs",
        lg: "px-4 py-2 text-sm",
      },
      // Glow effect for emphasis
      glow: {
        true: "",
        false: "",
      },
      // Pulsing animation for attention
      pulse: {
        true: "animate-pulse",
        false: "",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
      glow: false,
      pulse: false,
    },
  }
)

export interface BadgeProps
  extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof badgeVariants> {}

/**
 * Premium Badge Component
 *
 * A refined badge with semantic colors and optional glow effects.
 *
 * @example
 * ```tsx
 * <Badge variant="gradient">Premium</Badge>
 * <Badge variant="success" glow>Active</Badge>
 * <Badge variant="warning" pulse>Pending</Badge>
 * ```
 */
function Badge({ className, variant, size, glow, pulse, style, ...props }: BadgeProps) {
  const { colorTheme } = useColorTheme()
  const themeGradient = THEME_GRADIENTS[colorTheme]

  // Dynamic styles based on variant
  const getVariantStyles = (): React.CSSProperties | undefined => {
    switch (variant) {
      case "gradient":
        return {
          background: `linear-gradient(135deg, ${themeGradient.from}, ${themeGradient.to})`,
          boxShadow: glow ? `0 2px 8px -2px ${themeGradient.glow}` : undefined,
          ...style,
        }
      case "success":
        return {
          backgroundColor: SEMANTIC_COLORS.success.bg,
          color: SEMANTIC_COLORS.success.text,
          borderColor: SEMANTIC_COLORS.success.border,
          boxShadow: glow ? `0 2px 8px -2px ${SEMANTIC_COLORS.success.glow}` : undefined,
          ...style,
        }
      case "warning":
        return {
          backgroundColor: SEMANTIC_COLORS.warning.bg,
          color: SEMANTIC_COLORS.warning.text,
          borderColor: SEMANTIC_COLORS.warning.border,
          boxShadow: glow ? `0 2px 8px -2px ${SEMANTIC_COLORS.warning.glow}` : undefined,
          ...style,
        }
      case "danger":
        return {
          backgroundColor: SEMANTIC_COLORS.error.bg,
          color: SEMANTIC_COLORS.error.text,
          borderColor: SEMANTIC_COLORS.error.border,
          boxShadow: glow ? `0 2px 8px -2px ${SEMANTIC_COLORS.error.glow}` : undefined,
          ...style,
        }
      case "info":
        return {
          backgroundColor: themeGradient.fromLight,
          color: themeGradient.from,
          borderColor: themeGradient.fromMuted,
          boxShadow: glow ? `0 2px 8px -2px ${themeGradient.glow}` : undefined,
          ...style,
        }
      default:
        return glow && variant === "default"
          ? { boxShadow: `0 2px 8px -2px hsl(var(--primary) / 0.4)`, ...style }
          : style
    }
  }

  return (
    <div
      className={cn(badgeVariants({ variant, size, glow, pulse }), className)}
      style={getVariantStyles()}
      {...props}
    />
  )
}

export { Badge, badgeVariants }
