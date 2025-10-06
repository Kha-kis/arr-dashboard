"use client";

import { cn } from "../../lib/utils";
import { Button, type ButtonProps } from "./button";
import type { LucideIcon } from "lucide-react";

/**
 * EmptyState Component
 *
 * Displays a friendly empty state with icon, title, description, and optional action.
 *
 * Usage:
 * ```tsx
 * <EmptyState
 *   icon={InboxIcon}
 *   title="No items found"
 *   description="Get started by creating your first item."
 *   action={{ label: "Create Item", onClick: () => {} }}
 * />
 * ```
 */

export interface EmptyStateProps {
  /** Lucide icon component */
  icon?: LucideIcon;
  /** Main heading */
  title: string;
  /** Supporting description */
  description?: string;
  /** Optional action button */
  action?: {
    label: string;
    variant?: ButtonProps["variant"];
  } & Pick<ButtonProps, "onClick" | "href">;
  /** Additional className */
  className?: string;
}

export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  className,
}: EmptyStateProps) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center text-center p-12 rounded-2xl border border-border/30 bg-bg-subtle/20",
        className,
      )}
      role="status"
      aria-live="polite"
    >
      {Icon && (
        <div className="mb-4 p-4 rounded-xl bg-bg-muted/50">
          <Icon className="h-8 w-8 text-fg-muted" aria-hidden="true" />
        </div>
      )}

      <h3 className="text-lg font-semibold text-fg mb-2">{title}</h3>

      {description && (
        <p className="text-sm text-fg-muted max-w-md mb-6">{description}</p>
      )}

      {action && (
        <Button
          variant={action.variant || "primary"}
          onClick={action.onClick}
          {...(action.href ? { asChild: true } : {})}
        >
          {action.label}
        </Button>
      )}
    </div>
  );
}
