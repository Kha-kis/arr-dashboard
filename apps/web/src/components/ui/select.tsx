"use client"

import * as React from "react"
import * as SelectPrimitive from "@radix-ui/react-select"
import { Check, ChevronDown, ChevronUp } from "lucide-react"

import { cn } from "@/lib/utils"
import { useThemeGradient } from "../../hooks/useThemeGradient"

const Select = SelectPrimitive.Root

const SelectGroup = SelectPrimitive.Group

const SelectValue = SelectPrimitive.Value

interface SelectTriggerProps extends React.ComponentPropsWithoutRef<typeof SelectPrimitive.Trigger> {
  /** Enable premium theme-aware styling */
  premium?: boolean
}

/**
 * Premium Select Trigger
 *
 * Glassmorphic select trigger with theme-aware focus states.
 */
const SelectTrigger = React.forwardRef<
  React.ElementRef<typeof SelectPrimitive.Trigger>,
  SelectTriggerProps
>(({ className, children, premium = false, ...props }, ref) => {
  const { gradient: themeGradient } = useThemeGradient()
  const [isFocused, setIsFocused] = React.useState(false)

  const premiumFocusStyle = premium && isFocused
    ? {
        borderColor: themeGradient.from,
        boxShadow: `0 0 0 3px ${themeGradient.fromLight}, 0 0 20px -5px ${themeGradient.glow}`,
      }
    : undefined

  return (
    <SelectPrimitive.Trigger
      ref={ref}
      className={cn(
        // Base styles
        "flex h-10 w-full items-center justify-between px-4 py-2 text-sm",
        // Premium rounded corners
        "rounded-xl",
        // Border and background (glassmorphic)
        "border border-border/50 bg-background/50 backdrop-blur-sm",
        // Placeholder
        "data-[placeholder]:text-muted-foreground/60",
        // Standard focus (non-premium)
        !premium && "focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 ring-offset-background",
        // Premium focus removes default ring
        premium && "focus:outline-none",
        // Transitions
        "transition-all duration-300",
        // States
        "disabled:cursor-not-allowed disabled:opacity-50",
        "hover:border-border hover:bg-background/70",
        // Text overflow
        "[&>span]:line-clamp-1",
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
      {...props}
    >
      {children}
      <SelectPrimitive.Icon asChild>
        <ChevronDown className="h-4 w-4 opacity-50 transition-transform duration-200 data-[state=open]:rotate-180" />
      </SelectPrimitive.Icon>
    </SelectPrimitive.Trigger>
  )
})
SelectTrigger.displayName = SelectPrimitive.Trigger.displayName

const SelectScrollUpButton = React.forwardRef<
  React.ElementRef<typeof SelectPrimitive.ScrollUpButton>,
  React.ComponentPropsWithoutRef<typeof SelectPrimitive.ScrollUpButton>
>(({ className, ...props }, ref) => (
  <SelectPrimitive.ScrollUpButton
    ref={ref}
    className={cn(
      "flex cursor-default items-center justify-center py-1 text-muted-foreground",
      className
    )}
    {...props}
  >
    <ChevronUp className="h-4 w-4" />
  </SelectPrimitive.ScrollUpButton>
))
SelectScrollUpButton.displayName = SelectPrimitive.ScrollUpButton.displayName

const SelectScrollDownButton = React.forwardRef<
  React.ElementRef<typeof SelectPrimitive.ScrollDownButton>,
  React.ComponentPropsWithoutRef<typeof SelectPrimitive.ScrollDownButton>
>(({ className, ...props }, ref) => (
  <SelectPrimitive.ScrollDownButton
    ref={ref}
    className={cn(
      "flex cursor-default items-center justify-center py-1 text-muted-foreground",
      className
    )}
    {...props}
  >
    <ChevronDown className="h-4 w-4" />
  </SelectPrimitive.ScrollDownButton>
))
SelectScrollDownButton.displayName = SelectPrimitive.ScrollDownButton.displayName

/**
 * Premium Select Content
 *
 * Glassmorphic dropdown with smooth animations and theme glow.
 */
const SelectContent = React.forwardRef<
  React.ElementRef<typeof SelectPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof SelectPrimitive.Content>
>(({ className, children, position = "popper", ...props }, ref) => {
  const { gradient: themeGradient } = useThemeGradient()

  return (
    <SelectPrimitive.Portal>
      <SelectPrimitive.Content
        ref={ref}
        className={cn(
          // Base
          "relative z-modal max-h-[--radix-select-content-available-height] min-w-[8rem]",
          "overflow-y-auto overflow-x-hidden",
          // Glassmorphic styling
          "rounded-xl border border-border/50 bg-popover/95 backdrop-blur-xl",
          "text-popover-foreground shadow-xl",
          // Animations
          "data-[state=open]:animate-in data-[state=closed]:animate-out",
          "data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0",
          "data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95",
          "data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2",
          "data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2",
          "origin-[--radix-select-content-transform-origin]",
          // Position adjustments
          position === "popper" &&
            "data-[side=bottom]:translate-y-1 data-[side=left]:-translate-x-1 data-[side=right]:translate-x-1 data-[side=top]:-translate-y-1",
          className
        )}
        style={{
          boxShadow: `0 10px 40px -10px rgba(0,0,0,0.3), 0 0 40px -15px ${themeGradient.glow}`,
        }}
        position={position}
        {...props}
      >
        <SelectScrollUpButton />
        <SelectPrimitive.Viewport
          className={cn(
            "p-1.5",
            position === "popper" &&
              "h-[var(--radix-select-trigger-height)] w-full min-w-[var(--radix-select-trigger-width)]"
          )}
        >
          {children}
        </SelectPrimitive.Viewport>
        <SelectScrollDownButton />
      </SelectPrimitive.Content>
    </SelectPrimitive.Portal>
  )
})
SelectContent.displayName = SelectPrimitive.Content.displayName

const SelectLabel = React.forwardRef<
  React.ElementRef<typeof SelectPrimitive.Label>,
  React.ComponentPropsWithoutRef<typeof SelectPrimitive.Label>
>(({ className, ...props }, ref) => (
  <SelectPrimitive.Label
    ref={ref}
    className={cn(
      "py-1.5 pl-8 pr-2 text-xs font-medium text-muted-foreground uppercase tracking-wide",
      className
    )}
    {...props}
  />
))
SelectLabel.displayName = SelectPrimitive.Label.displayName

/**
 * Premium Select Item
 *
 * Dropdown item with theme-aware hover/focus states.
 */
const SelectItem = React.forwardRef<
  React.ElementRef<typeof SelectPrimitive.Item>,
  React.ComponentPropsWithoutRef<typeof SelectPrimitive.Item>
>(({ className, children, ...props }, ref) => {
  const { gradient: themeGradient } = useThemeGradient()

  return (
    <SelectPrimitive.Item
      ref={ref}
      className={cn(
        // Base
        "relative flex w-full cursor-pointer select-none items-center",
        "rounded-lg py-2 pl-8 pr-3 text-sm outline-none",
        // Hover/focus with gradient background
        "focus:text-foreground",
        // Transitions
        "transition-colors duration-150",
        // States
        "data-[disabled]:pointer-events-none data-[disabled]:opacity-50",
        className
      )}
      style={{
        // Use CSS variable for hover state via inline style
      }}
      {...props}
    >
      {/* Check indicator */}
      <span className="absolute left-2.5 flex h-4 w-4 items-center justify-center">
        <SelectPrimitive.ItemIndicator>
          <Check
            className="h-4 w-4"
            style={{ color: themeGradient.from }}
          />
        </SelectPrimitive.ItemIndicator>
      </span>

      <SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText>
    </SelectPrimitive.Item>
  )
})
SelectItem.displayName = SelectPrimitive.Item.displayName

const SelectSeparator = React.forwardRef<
  React.ElementRef<typeof SelectPrimitive.Separator>,
  React.ComponentPropsWithoutRef<typeof SelectPrimitive.Separator>
>(({ className, ...props }, ref) => (
  <SelectPrimitive.Separator
    ref={ref}
    className={cn("-mx-1 my-1.5 h-px bg-border/50", className)}
    {...props}
  />
))
SelectSeparator.displayName = SelectPrimitive.Separator.displayName

export {
  Select,
  SelectGroup,
  SelectValue,
  SelectTrigger,
  SelectContent,
  SelectLabel,
  SelectItem,
  SelectSeparator,
  SelectScrollUpButton,
  SelectScrollDownButton,
}
export type { SelectTriggerProps }
