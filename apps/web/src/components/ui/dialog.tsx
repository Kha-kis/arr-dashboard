"use client"

import * as React from "react"
import * as DialogPrimitive from "@radix-ui/react-dialog"
import { X } from "lucide-react"

import { cn } from "@/lib/utils"
import { useThemeGradient } from "../../hooks/useThemeGradient"

const Dialog = DialogPrimitive.Root

const DialogTrigger = DialogPrimitive.Trigger

const DialogPortal = DialogPrimitive.Portal

const DialogClose = DialogPrimitive.Close

/**
 * Premium Dialog Overlay
 *
 * Glassmorphic overlay with gradient blur effect instead of solid black.
 */
const DialogOverlay = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Overlay>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Overlay>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Overlay
    ref={ref}
    className={cn(
      "fixed inset-0 z-modal-backdrop backdrop-blur-xs",
      "bg-linear-to-br from-black/70 via-black/60 to-black/70",
      "data-[state=open]:animate-in data-[state=closed]:animate-out",
      "data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0",
      className
    )}
    {...props}
  />
))
DialogOverlay.displayName = DialogPrimitive.Overlay.displayName

interface DialogContentProps extends React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content> {
  /** Show the decorative gradient accent line at top */
  showAccent?: boolean
}

/**
 * Premium Dialog Content
 *
 * Glassmorphic dialog panel with:
 * - Backdrop blur for depth
 * - Theme-aware glow shadow
 * - Optional gradient accent line
 * - Refined close button
 */
const DialogContent = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Content>,
  DialogContentProps
>(({ className, children, showAccent = true, ...props }, ref) => {
  const { gradient: themeGradient } = useThemeGradient()

  return (
    <DialogPortal>
      <DialogOverlay />
      <DialogPrimitive.Content
        ref={ref}
        className={cn(
          // Positioning
          "fixed left-[50%] top-[50%] z-modal w-full max-w-lg",
          "translate-x-[-50%] translate-y-[-50%]",
          // Glassmorphic styling
          "rounded-2xl border border-border/50 bg-card/95 backdrop-blur-xl",
          // Layout
          "grid gap-4 p-6",
          // Animations
          "duration-300",
          "data-[state=open]:animate-in data-[state=closed]:animate-out",
          "data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0",
          "data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95",
          "data-[state=closed]:slide-out-to-left-1/2 data-[state=closed]:slide-out-to-top-[48%]",
          "data-[state=open]:slide-in-from-left-1/2 data-[state=open]:slide-in-from-top-[48%]",
          className
        )}
        style={{
          boxShadow: `0 25px 50px -12px rgba(0,0,0,0.5), 0 0 80px -20px ${themeGradient.glow}`,
        }}
        {...props}
      >
        {/* Top gradient accent line */}
        {showAccent && (
          <div
            className="absolute top-0 left-8 right-8 h-px pointer-events-none"
            style={{
              background: `linear-gradient(90deg, transparent, ${themeGradient.from}, transparent)`,
            }}
          />
        )}

        {children}

        {/* Premium close button */}
        <DialogPrimitive.Close
          className={cn(
            "absolute right-4 top-4",
            "h-8 w-8 flex items-center justify-center",
            "rounded-lg opacity-70 transition-all duration-200",
            "hover:opacity-100 hover:bg-muted/50",
            "focus:outline-hidden focus:ring-2 focus:ring-ring focus:ring-offset-2 ring-offset-background",
            "disabled:pointer-events-none"
          )}
        >
          <X className="h-4 w-4" />
          <span className="sr-only">Close</span>
        </DialogPrimitive.Close>
      </DialogPrimitive.Content>
    </DialogPortal>
  )
})
DialogContent.displayName = DialogPrimitive.Content.displayName

const DialogHeader = ({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) => (
  <div
    className={cn(
      "flex flex-col space-y-2 text-center sm:text-left",
      className
    )}
    {...props}
  />
)
DialogHeader.displayName = "DialogHeader"

const DialogFooter = ({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) => (
  <div
    className={cn(
      "flex flex-col-reverse gap-2 sm:flex-row sm:justify-end",
      className
    )}
    {...props}
  />
)
DialogFooter.displayName = "DialogFooter"

/**
 * Premium Dialog Title
 *
 * Uses display font for premium typography
 */
const DialogTitle = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Title>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Title>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Title
    ref={ref}
    className={cn(
      "text-lg font-semibold leading-none tracking-tight font-display",
      className
    )}
    {...props}
  />
))
DialogTitle.displayName = DialogPrimitive.Title.displayName

const DialogDescription = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Description>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Description>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Description
    ref={ref}
    className={cn("text-sm text-muted-foreground", className)}
    {...props}
  />
))
DialogDescription.displayName = DialogPrimitive.Description.displayName

export {
  Dialog,
  DialogPortal,
  DialogOverlay,
  DialogClose,
  DialogTrigger,
  DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
}
export type { DialogContentProps }
