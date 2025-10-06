"use client";

import { cn } from "../../lib/utils";
import type { LucideIcon } from "lucide-react";
import { AlertCircle, CheckCircle, Info, AlertTriangle, X } from "lucide-react";

/**
 * Alert Component
 *
 * Displays contextual feedback messages with variants for different states.
 *
 * Usage:
 * ```tsx
 * <Alert variant="success">
 *   <AlertTitle>Success!</AlertTitle>
 *   <AlertDescription>Your changes have been saved.</AlertDescription>
 * </Alert>
 * ```
 */

export type AlertVariant = "info" | "success" | "warning" | "danger";

const variantStyles: Record<AlertVariant, string> = {
  info: "bg-info/10 border-info/30 text-info-fg",
  success: "bg-success/10 border-success/30 text-success-fg",
  warning: "bg-warning/10 border-warning/30 text-warning-fg",
  danger: "bg-danger/10 border-danger/30 text-danger-fg",
};

const variantIcons: Record<AlertVariant, LucideIcon> = {
  info: Info,
  success: CheckCircle,
  warning: AlertTriangle,
  danger: AlertCircle,
};

export interface AlertProps extends React.HTMLAttributes<HTMLDivElement> {
  variant?: AlertVariant;
  /** Show dismiss button */
  dismissible?: boolean;
  /** Callback when dismissed */
  onDismiss?: () => void;
}

export function Alert({
  variant = "info",
  dismissible,
  onDismiss,
  className,
  children,
  ...props
}: AlertProps) {
  const Icon = variantIcons[variant];

  return (
    <div
      role="alert"
      className={cn(
        "relative flex items-start gap-3 rounded-xl border p-4 backdrop-blur-sm",
        variantStyles[variant],
        className,
      )}
      {...props}
    >
      <Icon className="h-5 w-5 flex-shrink-0 mt-0.5" aria-hidden="true" />

      <div className="flex-1 space-y-1">{children}</div>

      {dismissible && (
        <button
          onClick={onDismiss}
          className="flex-shrink-0 rounded-lg p-1 hover:bg-black/10 transition-colors"
          aria-label="Dismiss alert"
        >
          <X className="h-4 w-4" />
        </button>
      )}
    </div>
  );
}

export function AlertTitle({
  className,
  ...props
}: React.HTMLAttributes<HTMLHeadingElement>) {
  return (
    <h5
      className={cn("font-semibold leading-none tracking-tight", className)}
      {...props}
    />
  );
}

export function AlertDescription({
  className,
  ...props
}: React.HTMLAttributes<HTMLParagraphElement>) {
  return <p className={cn("text-sm opacity-90", className)} {...props} />;
}
