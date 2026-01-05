"use client";

/**
 * Legacy Dialog Component (Premium Edition)
 *
 * Provides backward compatibility for the legacy Dialog API with premium styling.
 * - Glassmorphic container with backdrop blur
 * - Theme-aware styling using THEME_GRADIENTS
 * - Animated entrance effects
 *
 * For new code, consider using the shadcn Dialog components or standalone modals.
 */

import * as React from "react";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";
import { THEME_GRADIENTS } from "@/lib/theme-gradients";
import { useColorTheme } from "@/providers/color-theme-provider";

export interface LegacyDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: React.ReactNode;
  size?: "sm" | "md" | "lg" | "xl";
}

const sizeStyles = {
  sm: "max-w-md",
  md: "max-w-2xl",
  lg: "max-w-3xl",
  xl: "max-w-5xl",
};

export function LegacyDialog({ open, onOpenChange, children, size = "md" }: LegacyDialogProps) {
  const { colorTheme } = useColorTheme();
  const themeGradient = THEME_GRADIENTS[colorTheme];

  // Handle ESC key
  React.useEffect(() => {
    const handleEsc = (e: KeyboardEvent) => {
      if (e.key === "Escape" && open) {
        onOpenChange(false);
      }
    };

    document.addEventListener("keydown", handleEsc);
    return () => document.removeEventListener("keydown", handleEsc);
  }, [open, onOpenChange]);

  // Prevent body scroll when modal is open
  React.useEffect(() => {
    if (open) {
      document.body.style.overflow = "hidden";
    } else {
      document.body.style.overflow = "";
    }
    return () => {
      document.body.style.overflow = "";
    };
  }, [open]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-modal-backdrop animate-in fade-in duration-200">
      {/* Backdrop */}
      <div
        className="fixed inset-0 bg-black/70 backdrop-blur-sm"
        onClick={() => onOpenChange(false)}
        aria-hidden="true"
      />

      {/* Dialog Container */}
      <div className="fixed inset-0 flex items-center justify-center p-4 sm:p-6 md:p-8">
        <div
          className={cn(
            "relative z-50 w-full overflow-hidden rounded-2xl border border-border/50 bg-card/95 backdrop-blur-xl shadow-2xl",
            "max-h-[90vh] flex flex-col",
            "animate-in zoom-in-95 slide-in-from-bottom-4 duration-300",
            sizeStyles[size],
          )}
          style={{
            boxShadow: `0 25px 50px -12px rgba(0, 0, 0, 0.5), 0 0 0 1px ${themeGradient.from}15`,
          }}
          onClick={(e) => e.stopPropagation()}
          role="dialog"
          aria-modal="true"
        >
          {children}
        </div>
      </div>
    </div>
  );
}

export function LegacyDialogHeader({
  children,
  className,
  icon,
}: {
  children: React.ReactNode;
  className?: string;
  icon?: React.ReactNode;
}) {
  const { colorTheme } = useColorTheme();
  const themeGradient = THEME_GRADIENTS[colorTheme];

  return (
    <div
      className={cn("flex items-center justify-between gap-4 border-b border-border/30 p-6", className)}
      style={{
        background: `linear-gradient(135deg, ${themeGradient.from}08, transparent)`,
      }}
    >
      {icon ? (
        <div className="flex items-center gap-4">
          <div
            className="flex h-12 w-12 items-center justify-center rounded-xl shrink-0"
            style={{
              background: `linear-gradient(135deg, ${themeGradient.from}20, ${themeGradient.to}20)`,
              border: `1px solid ${themeGradient.from}30`,
            }}
          >
            {icon}
          </div>
          <div>{children}</div>
        </div>
      ) : (
        children
      )}
    </div>
  );
}

export function LegacyDialogTitle({ children, className }: { children: React.ReactNode; className?: string }) {
  return <h2 className={cn("text-xl font-bold text-foreground", className)}>{children}</h2>;
}

export function LegacyDialogDescription({ children, className }: { children: React.ReactNode; className?: string }) {
  return <p className={cn("text-sm text-muted-foreground", className)}>{children}</p>;
}

export function LegacyDialogContent({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={cn("flex-1 overflow-y-auto p-6", className)}>
      {children}
    </div>
  );
}

export function LegacyDialogFooter({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={cn("flex items-center justify-end gap-3 border-t border-border/30 p-6", className)}>
      {children}
    </div>
  );
}

export function LegacyDialogClose({
  onClick,
  className,
}: {
  onClick: () => void;
  className?: string;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "absolute right-4 top-4 z-10 flex h-8 w-8 items-center justify-center rounded-lg bg-black/50 text-white/70 transition-colors hover:bg-black/70 hover:text-white",
        className
      )}
      aria-label="Close dialog"
      type="button"
    >
      <X className="h-4 w-4" />
    </button>
  );
}
