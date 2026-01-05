"use client"

import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"
import { useColorTheme } from "../../providers/color-theme-provider"
import { THEME_GRADIENTS } from "../../lib/theme-gradients"

/**
 * Premium Card Variants
 *
 * Multiple card styles for different use cases:
 * - default: Subtle glassmorphic card
 * - elevated: Higher contrast with more shadow
 * - ghost: Minimal border, transparent background
 * - gradient: Theme-aware gradient border accent
 */
const cardVariants = cva(
  "rounded-2xl text-card-foreground transition-all duration-300",
  {
    variants: {
      variant: {
        // Default glassmorphic card
        default: "border border-border/50 bg-card/80 backdrop-blur-sm shadow-sm",
        // Elevated with stronger presence
        elevated: "border border-border/40 bg-card/90 backdrop-blur-md shadow-lg",
        // Ghost - minimal styling
        ghost: "border border-transparent bg-transparent",
        // Gradient accent - theme-aware top border
        gradient: "border border-border/30 bg-card/80 backdrop-blur-sm",
      },
      hover: {
        true: "",
        false: "",
      },
      /** Animation delay index for staggered reveals (0-10) */
      animationDelay: {
        0: "",
        1: "",
        2: "",
        3: "",
        4: "",
        5: "",
        6: "",
        7: "",
        8: "",
        9: "",
        10: "",
      },
    },
    compoundVariants: [
      // Hover effects per variant
      {
        variant: "default",
        hover: true,
        className: "hover:border-border/70 hover:shadow-md hover:bg-card/90",
      },
      {
        variant: "elevated",
        hover: true,
        className: "hover:shadow-xl hover:scale-[1.01]",
      },
      {
        variant: "ghost",
        hover: true,
        className: "hover:bg-muted/30",
      },
      {
        variant: "gradient",
        hover: true,
        className: "hover:shadow-lg",
      },
    ],
    defaultVariants: {
      variant: "default",
      hover: false,
      animationDelay: 0,
    },
  }
)

export interface CardProps
  extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof cardVariants> {
  /** Show theme-aware glow effect */
  glow?: boolean
}

/**
 * Premium Card Component
 *
 * A refined card with glassmorphism and optional theme-aware effects.
 *
 * @example
 * ```tsx
 * <Card variant="elevated" hover>Premium content</Card>
 * <Card variant="gradient" glow>Highlighted content</Card>
 * <Card animationDelay={2}>Staggered reveal</Card>
 * ```
 */
const Card = React.forwardRef<HTMLDivElement, CardProps>(
  ({ className, variant, hover, animationDelay, glow, style, ...props }, ref) => {
    const { colorTheme } = useColorTheme()
    const themeGradient = THEME_GRADIENTS[colorTheme]

    // Calculate animation delay in ms (50ms per index)
    const delayMs = animationDelay ? animationDelay * 50 : 0
    const animationStyle = delayMs > 0 ? { animationDelay: `${delayMs}ms` } : undefined

    // Dynamic styles for special variants
    const getVariantStyles = (): React.CSSProperties | undefined => {
      const baseStyles = { ...animationStyle, ...style }

      if (variant === "gradient") {
        return {
          ...baseStyles,
          borderTopColor: themeGradient.from,
          borderTopWidth: "2px",
          boxShadow: glow ? `0 -4px 20px -8px ${themeGradient.glow}` : undefined,
        }
      }

      if (glow) {
        return {
          ...baseStyles,
          boxShadow: `0 4px 20px -8px ${themeGradient.glow}`,
        }
      }

      return Object.keys(baseStyles).length > 0 ? baseStyles : undefined
    }

    return (
      <div
        ref={ref}
        className={cn(cardVariants({ variant, hover, animationDelay }), className)}
        style={getVariantStyles()}
        {...props}
      />
    )
  }
)
Card.displayName = "Card"

/**
 * Premium Card Header
 *
 * Optional gradient underline for emphasis.
 */
interface CardHeaderProps extends React.HTMLAttributes<HTMLDivElement> {
  /** Show theme gradient underline */
  accent?: boolean
}

const CardHeader = React.forwardRef<HTMLDivElement, CardHeaderProps>(
  ({ className, accent, ...props }, ref) => {
    const { colorTheme } = useColorTheme()
    const themeGradient = THEME_GRADIENTS[colorTheme]

    return (
      <div
        ref={ref}
        className={cn(
          "relative flex flex-col space-y-1.5 p-6",
          accent && "pb-5",
          className
        )}
        {...props}
      >
        {props.children}
        {accent && (
          <div
            className="absolute bottom-0 left-6 right-6 h-px"
            style={{
              background: `linear-gradient(90deg, ${themeGradient.from}, ${themeGradient.to}, transparent)`,
            }}
          />
        )}
      </div>
    )
  }
)
CardHeader.displayName = "CardHeader"

/**
 * Premium Card Title
 *
 * Uses display font with refined tracking.
 */
const CardTitle = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(({ className, ...props }, ref) => (
  <div
    ref={ref}
    className={cn(
      "font-display text-xl font-semibold leading-none tracking-tight",
      className
    )}
    {...props}
  />
))
CardTitle.displayName = "CardTitle"

const CardDescription = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(({ className, ...props }, ref) => (
  <div
    ref={ref}
    className={cn("text-sm text-muted-foreground", className)}
    {...props}
  />
))
CardDescription.displayName = "CardDescription"

const CardContent = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(({ className, ...props }, ref) => (
  <div ref={ref} className={cn("p-6 pt-0", className)} {...props} />
))
CardContent.displayName = "CardContent"

const CardFooter = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(({ className, ...props }, ref) => (
  <div
    ref={ref}
    className={cn("flex items-center p-6 pt-0", className)}
    {...props}
  />
))
CardFooter.displayName = "CardFooter"

export { Card, CardHeader, CardFooter, CardTitle, CardDescription, CardContent, cardVariants }
export type { CardHeaderProps }
