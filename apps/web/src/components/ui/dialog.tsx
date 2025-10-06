"use client";

import { type ReactNode, useEffect } from "react";
import { cn } from "../../lib/utils";

export interface DialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: ReactNode;
  size?: "sm" | "md" | "lg" | "xl";
}

const sizeStyles = {
  sm: "max-w-md",
  md: "max-w-2xl",
  lg: "max-w-3xl",
  xl: "max-w-5xl",
};

export const Dialog = ({
  open,
  onOpenChange,
  children,
  size = "md",
}: DialogProps) => {
  // Handle ESC key
  useEffect(() => {
    const handleEsc = (e: KeyboardEvent) => {
      if (e.key === "Escape" && open) {
        onOpenChange(false);
      }
    };

    document.addEventListener("keydown", handleEsc);
    return () => document.removeEventListener("keydown", handleEsc);
  }, [open, onOpenChange]);

  // Prevent body scroll when modal is open
  useEffect(() => {
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
    <div className="fixed inset-0 z-modal-backdrop">
      {/* Backdrop */}
      <div
        className="fixed inset-0 bg-bg/80 backdrop-blur"
        onClick={() => onOpenChange(false)}
        aria-hidden="true"
      />

      {/* Dialog Container */}
      <div className="fixed inset-0 flex items-center justify-center p-4 sm:p-6 md:p-8">
        <div
          className={cn(
            "relative z-modal w-full overflow-hidden rounded-2xl border border-border bg-bg-subtle/95 shadow-xl",
            "max-h-[90vh] flex flex-col",
            sizeStyles[size],
          )}
          onClick={(e) => e.stopPropagation()}
          role="dialog"
          aria-modal="true"
        >
          {children}
        </div>
      </div>
    </div>
  );
};

export interface DialogHeaderProps {
  children: ReactNode;
  className?: string;
}

export const DialogHeader = ({ children, className }: DialogHeaderProps) => (
  <div className={cn("flex flex-col space-y-1.5 px-6 pt-6", className)}>
    {children}
  </div>
);

export interface DialogTitleProps {
  children: ReactNode;
  className?: string;
}

export const DialogTitle = ({ children, className }: DialogTitleProps) => (
  <h2 className={cn("text-lg font-semibold text-fg", className)}>{children}</h2>
);

export interface DialogDescriptionProps {
  children: ReactNode;
  className?: string;
}

export const DialogDescription = ({
  children,
  className,
}: DialogDescriptionProps) => (
  <p className={cn("text-sm text-fg-muted", className)}>{children}</p>
);

export interface DialogContentProps {
  children: ReactNode;
  className?: string;
}

export const DialogContent = ({ children, className }: DialogContentProps) => (
  <div className={cn("flex-1 overflow-y-auto px-6 py-4", className)}>
    {children}
  </div>
);

export interface DialogFooterProps {
  children: ReactNode;
  className?: string;
}

export const DialogFooter = ({ children, className }: DialogFooterProps) => (
  <div
    className={cn(
      "flex items-center justify-end gap-3 px-6 pb-6 pt-4",
      className,
    )}
  >
    {children}
  </div>
);
