"use client"

import * as React from "react"
import { Slot } from "@radix-ui/react-slot"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"
import { useColorTheme } from "../../providers/color-theme-provider"
import { THEME_GRADIENTS } from "../../lib/theme-gradients"

/**
 * Premium Button Variants
 *
 * Includes theme-aware gradient variant with glow effects.
 * All variants use rounded-xl for premium feel.
 */
const buttonVariants = cva(
  // Base styles
  [
    "inline-flex items-center justify-center gap-2 whitespace-nowrap",
    "text-sm font-medium",
    "rounded-xl", // Premium rounded corners
    "ring-offset-background",
    "transition-all duration-300", // Smooth transitions
    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
    "disabled:pointer-events-none disabled:opacity-50",
    "[&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0",
    "active:scale-[0.98]", // Press-down effect
  ].join(" "),
  {
    variants: {
      variant: {
        // Default/Primary - solid primary color
        default: "bg-primary text-primary-foreground hover:bg-primary/90 shadow-sm hover:shadow-md",
        primary: "bg-primary text-primary-foreground hover:bg-primary/90 shadow-sm hover:shadow-md",

        // Gradient - theme-aware gradient (requires inline styles)
        gradient: "text-white hover:scale-[1.02] hover:shadow-lg",

        // Danger/Destructive - red for dangerous actions
        danger: "bg-destructive text-destructive-foreground hover:bg-destructive/90",
        destructive: "bg-destructive text-destructive-foreground hover:bg-destructive/90",

        // Outline - border with transparent background
        outline: [
          "border border-border/50 bg-transparent",
          "hover:bg-muted/50 hover:border-border",
          "backdrop-blur-sm",
        ].join(" "),

        // Secondary - glassmorphic style
        secondary: [
          "bg-card/50 text-foreground",
          "border border-border/50",
          "backdrop-blur-sm",
          "hover:bg-card/80 hover:border-border",
        ].join(" "),

        // Ghost - no background until hover
        ghost: "hover:bg-muted/50 hover:text-foreground text-muted-foreground",

        // Link - underline style
        link: "text-primary underline-offset-4 hover:underline",
      },
      size: {
        default: "h-10 px-4 py-2",
        sm: "h-8 px-3 text-xs",
        lg: "h-12 px-6 text-base",
        xl: "h-14 px-8 text-lg",
        icon: "h-10 w-10",
        "icon-sm": "h-8 w-8",
        "icon-lg": "h-12 w-12",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean
}

/**
 * Premium Button Component
 *
 * A refined button with multiple variants including a theme-aware gradient option.
 *
 * @example
 * ```tsx
 * <Button variant="gradient">Premium Action</Button>
 * <Button variant="secondary">Secondary</Button>
 * <Button variant="ghost" size="icon"><Icon /></Button>
 * ```
 */
const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, style, ...props }, ref) => {
    const { colorTheme } = useColorTheme()
    const themeGradient = THEME_GRADIENTS[colorTheme]
    const Comp = asChild ? Slot : "button"

    // Gradient variant gets dynamic theme styles
    const gradientStyles = variant === "gradient"
      ? {
          background: `linear-gradient(135deg, ${themeGradient.from}, ${themeGradient.to})`,
          boxShadow: `0 4px 14px -4px ${themeGradient.glow}`,
          ...style,
        }
      : style

    return (
      <Comp
        className={cn(buttonVariants({ variant, size, className }))}
        ref={ref}
        style={gradientStyles}
        {...props}
      />
    )
  }
)
Button.displayName = "Button"

export { Button, buttonVariants }
