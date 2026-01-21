"use client"

import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"
import { useThemeGradient } from "../../hooks/useThemeGradient"

/**
 * Premium Skeleton Variants
 *
 * Multiple animation styles for different contexts:
 * - pulse: Standard fade in/out (default)
 * - shimmer: Premium gradient sweep effect
 * - wave: Subtle wave animation
 * - none: Static placeholder
 */
const skeletonVariants = cva(
  "rounded-lg bg-muted",
  {
    variants: {
      animation: {
        pulse: "animate-pulse",
        shimmer: "relative overflow-hidden",
        wave: "animate-pulse",
        none: "",
      },
      /** Use theme color tint in the shimmer */
      themed: {
        true: "",
        false: "",
      },
    },
    defaultVariants: {
      animation: "shimmer",
      themed: false,
    },
  }
)

export interface SkeletonProps
  extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof skeletonVariants> {}

/**
 * Premium Skeleton Component
 *
 * A loading placeholder with multiple animation styles.
 *
 * @example
 * ```tsx
 * <Skeleton className="h-4 w-32" />
 * <Skeleton animation="shimmer" themed className="h-12 w-12 rounded-full" />
 * <Skeleton animation="pulse" className="h-20 w-full" />
 * ```
 */
function Skeleton({
  className,
  animation,
  themed,
  ...props
}: SkeletonProps) {
  const { gradient: themeGradient } = useThemeGradient()

  // Shimmer gradient colors
  const shimmerGradient = themed
    ? `linear-gradient(90deg, transparent 0%, ${themeGradient.fromLight} 50%, transparent 100%)`
    : "linear-gradient(90deg, transparent 0%, rgba(255,255,255,0.08) 50%, transparent 100%)"

  return (
    <div
      className={cn(skeletonVariants({ animation, themed }), className)}
      role="status"
      aria-label="Loading"
      {...props}
    >
      {animation === "shimmer" && (
        <div
          className="absolute inset-0 -translate-x-full animate-[shimmer_2s_infinite]"
          style={{ background: shimmerGradient }}
        />
      )}
    </div>
  )
}

/**
 * Predefined Skeleton Patterns
 */

interface SkeletonTextProps extends VariantProps<typeof skeletonVariants> {
  lines?: number
  className?: string
}

/**
 * Premium Text Skeleton
 *
 * Multi-line text placeholder with staggered widths.
 */
function SkeletonText({ lines = 3, className, animation, themed }: SkeletonTextProps) {
  return (
    <div className={cn("space-y-2", className)} role="status" aria-label="Loading text">
      {Array.from({ length: lines }).map((_, i) => (
        <Skeleton
          key={i}
          animation={animation}
          themed={themed}
          className={cn(
            "h-4",
            i === 0 ? "w-full" : i === lines - 1 ? "w-1/2" : "w-3/4"
          )}
          style={{ animationDelay: `${i * 100}ms` }}
        />
      ))}
    </div>
  )
}

interface SkeletonCardProps extends VariantProps<typeof skeletonVariants> {
  className?: string
}

/**
 * Premium Card Skeleton
 *
 * Full card placeholder matching Card component styling.
 */
function SkeletonCard({ className, animation, themed }: SkeletonCardProps) {
  return (
    <div
      className={cn(
        "rounded-2xl border border-border/50 bg-card/30 backdrop-blur-xs p-6 space-y-4",
        className
      )}
      role="status"
      aria-label="Loading card"
    >
      {/* Header */}
      <div className="space-y-2">
        <Skeleton animation={animation} themed={themed} className="h-5 w-32" />
        <Skeleton animation={animation} themed={themed} className="h-4 w-48" />
      </div>
      {/* Content */}
      <SkeletonText lines={3} animation={animation} themed={themed} />
    </div>
  )
}

interface SkeletonAvatarProps extends VariantProps<typeof skeletonVariants> {
  size?: "xs" | "sm" | "md" | "lg" | "xl"
  className?: string
}

/**
 * Premium Avatar Skeleton
 *
 * Circular placeholder for avatars and icons.
 */
function SkeletonAvatar({ size = "md", className, animation, themed }: SkeletonAvatarProps) {
  const sizeClasses = {
    xs: "h-6 w-6",
    sm: "h-8 w-8",
    md: "h-10 w-10",
    lg: "h-12 w-12",
    xl: "h-16 w-16",
  }

  return (
    <Skeleton
      animation={animation}
      themed={themed}
      className={cn("rounded-full", sizeClasses[size], className)}
      aria-label="Loading avatar"
    />
  )
}

interface SkeletonTableProps extends VariantProps<typeof skeletonVariants> {
  rows?: number
  columns?: number
  className?: string
}

/**
 * Premium Table Skeleton
 *
 * Table placeholder matching Table component styling.
 */
function SkeletonTable({
  rows = 5,
  columns = 4,
  className,
  animation,
  themed,
}: SkeletonTableProps) {
  return (
    <div
      className={cn(
        "rounded-xl border border-border/50 bg-card/30 backdrop-blur-xs overflow-hidden",
        className
      )}
      role="status"
      aria-label="Loading table"
    >
      {/* Header */}
      <div className="border-b border-border/50 bg-muted/30 px-4 py-3">
        <div className="flex gap-4">
          {Array.from({ length: columns }).map((_, i) => (
            <Skeleton
              key={`header-${i}`}
              animation={animation}
              themed={themed}
              className="h-4 flex-1"
              style={{ animationDelay: `${i * 50}ms` }}
            />
          ))}
        </div>
      </div>
      {/* Rows */}
      {Array.from({ length: rows }).map((_, rowIndex) => (
        <div
          key={`row-${rowIndex}`}
          className="border-b border-border/30 last:border-0 px-4 py-4"
        >
          <div className="flex gap-4">
            {Array.from({ length: columns }).map((_, colIndex) => (
              <Skeleton
                key={`cell-${rowIndex}-${colIndex}`}
                animation={animation}
                themed={themed}
                className={cn("h-4 flex-1", colIndex === 0 && "w-32 flex-none")}
                style={{ animationDelay: `${(rowIndex * columns + colIndex) * 30}ms` }}
              />
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}

interface SkeletonStatCardProps extends VariantProps<typeof skeletonVariants> {
  className?: string
}

/**
 * Premium Stat Card Skeleton
 *
 * Placeholder for dashboard stat cards.
 */
function SkeletonStatCard({ className, animation, themed }: SkeletonStatCardProps) {
  return (
    <div
      className={cn(
        "rounded-2xl border border-border/50 bg-card/30 backdrop-blur-xs p-6",
        className
      )}
      role="status"
      aria-label="Loading stat"
    >
      <div className="flex items-center justify-between">
        <div className="space-y-2 flex-1">
          <Skeleton animation={animation} themed={themed} className="h-4 w-24" />
          <Skeleton animation={animation} themed={themed} className="h-8 w-16" />
        </div>
        <Skeleton animation={animation} themed={themed} className="h-10 w-10 rounded-xl" />
      </div>
      <div className="mt-4">
        <Skeleton animation={animation} themed={themed} className="h-2 w-full rounded-full" />
      </div>
    </div>
  )
}

export {
  Skeleton,
  SkeletonText,
  SkeletonCard,
  SkeletonAvatar,
  SkeletonTable,
  SkeletonStatCard,
  skeletonVariants,
}
export type { SkeletonTextProps, SkeletonCardProps, SkeletonAvatarProps, SkeletonTableProps, SkeletonStatCardProps }
