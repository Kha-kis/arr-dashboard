"use client"

import * as React from "react"
import { cn } from "@/lib/utils"
import { useColorTheme } from "../../providers/color-theme-provider"
import { THEME_GRADIENTS } from "../../lib/theme-gradients"

interface InputProps extends React.ComponentProps<"input"> {
  /** Enable premium theme-aware focus styling */
  premium?: boolean
}

/**
 * Premium Input Component
 *
 * A refined input with theme-aware focus states and glassmorphic styling.
 * When `premium` prop is true, the input will use dynamic theme colors
 * for focus states with glow effects.
 *
 * @example
 * ```tsx
 * <Input premium placeholder="Enter your email..." />
 * ```
 */
const Input = React.forwardRef<HTMLInputElement, InputProps>(
  ({ className, type, premium = false, ...props }, ref) => {
    const { colorTheme } = useColorTheme()
    const themeGradient = THEME_GRADIENTS[colorTheme]
    const [isFocused, setIsFocused] = React.useState(false)

    // Premium focus styles with theme-aware glow
    const premiumFocusStyle = premium && isFocused
      ? {
          borderColor: themeGradient.from,
          boxShadow: `0 0 0 3px ${themeGradient.fromLight}, 0 0 20px -5px ${themeGradient.glow}`,
        }
      : undefined

    return (
      <input
        type={type}
        className={cn(
          // Base styles
          "flex h-10 w-full px-4 py-2 text-sm",
          // Premium rounded corners
          "rounded-xl",
          // Border and background
          "border border-border/50 bg-background/50 backdrop-blur-sm",
          // Placeholder
          "placeholder:text-muted-foreground/60",
          // File input styling
          "file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground",
          // Standard focus (non-premium) - kept for compatibility
          !premium && "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 ring-offset-background",
          // Premium focus removes default ring for custom styling
          premium && "focus-visible:outline-none",
          // Transitions
          "transition-all duration-300",
          // Disabled state
          "disabled:cursor-not-allowed disabled:opacity-50",
          // Hover state
          "hover:border-border hover:bg-background/70",
          className
        )}
        style={premiumFocusStyle}
        onFocus={(e) => {
          setIsFocused(true)
          props.onFocus?.(e)
        }}
        onBlur={(e) => {
          setIsFocused(false)
          props.onBlur?.(e)
        }}
        ref={ref}
        {...props}
      />
    )
  }
)
Input.displayName = "Input"

export { Input }
export type { InputProps }
