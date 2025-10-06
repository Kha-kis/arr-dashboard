"use client";

import { cn } from "../../lib/utils";

/**
 * Skeleton Component
 *
 * Displays a loading skeleton placeholder with shimmer animation.
 * Respects prefers-reduced-motion.
 *
 * Usage:
 * ```tsx
 * <Skeleton className="h-4 w-32" />
 * <Skeleton className="h-12 w-12 rounded-full" />
 * ```
 */

export interface SkeletonProps extends React.HTMLAttributes<HTMLDivElement> {}

export function Skeleton({ className, ...props }: SkeletonProps) {
  return (
    <div
      className={cn(
        "animate-pulse rounded-md bg-bg-muted/50 shimmer",
        className,
      )}
      role="status"
      aria-label="Loading"
      {...props}
    />
  );
}

/**
 * Predefined Skeleton Patterns
 */

export function SkeletonText({
  lines = 3,
  className,
}: {
  lines?: number;
  className?: string;
}) {
  return (
    <div
      className={cn("space-y-2", className)}
      role="status"
      aria-label="Loading text"
    >
      {Array.from({ length: lines }).map((_, i) => (
        <Skeleton
          key={i}
          className={cn("h-4", i === lines - 1 ? "w-3/4" : "w-full")}
        />
      ))}
    </div>
  );
}

export function SkeletonCard({ className }: { className?: string }) {
  return (
    <div
      className={cn(
        "rounded-2xl border border-border/50 p-6 space-y-4",
        className,
      )}
      role="status"
      aria-label="Loading card"
    >
      <div className="space-y-2">
        <Skeleton className="h-5 w-32" />
        <Skeleton className="h-4 w-48" />
      </div>
      <SkeletonText lines={3} />
    </div>
  );
}

export function SkeletonAvatar({
  size = "md",
  className,
}: {
  size?: "sm" | "md" | "lg";
  className?: string;
}) {
  const sizeClasses = {
    sm: "h-8 w-8",
    md: "h-10 w-10",
    lg: "h-12 w-12",
  };

  return (
    <Skeleton
      className={cn("rounded-full", sizeClasses[size], className)}
      aria-label="Loading avatar"
    />
  );
}
