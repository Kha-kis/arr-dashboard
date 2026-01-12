"use client";

/**
 * Legacy Dropdown Menu Component
 *
 * Provides backward compatibility for the legacy DropdownMenu API.
 * For new code, use the shadcn DropdownMenu components instead.
 *
 * @deprecated Use shadcn DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, etc. instead
 */

import { useState, useRef, useEffect } from "react";
import { cn } from "@/lib/utils";

export interface LegacyDropdownMenuProps {
  trigger: React.ReactNode;
  children: React.ReactNode;
  align?: "left" | "right";
  className?: string;
}

export function LegacyDropdownMenu({
  trigger,
  children,
  align = "right",
  className,
}: LegacyDropdownMenuProps) {
  const [isOpen, setIsOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };

    if (isOpen) {
      document.addEventListener("mousedown", handleClickOutside);
    }

    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
    };
  }, [isOpen]);

  return (
    <div ref={menuRef} className={cn("relative", className)}>
      <button
        type="button"
        onClick={() => setIsOpen(!isOpen)}
        className="p-1.5 rounded-lg text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors"
      >
        {trigger}
      </button>

      {isOpen && (
        <div
          className={cn(
            "absolute z-modal mt-1 min-w-[160px] py-1 rounded-lg border border-border bg-popover shadow-lg",
            "animate-in fade-in-0 zoom-in-95 duration-100",
            align === "right" ? "right-0" : "left-0",
          )}
        >
          {children}
        </div>
      )}
    </div>
  );
}

export interface LegacyDropdownMenuItemProps {
  children: React.ReactNode;
  onClick?: () => void;
  variant?: "default" | "danger";
  disabled?: boolean;
  icon?: React.ReactNode;
}

export function LegacyDropdownMenuItem({
  children,
  onClick,
  variant = "default",
  disabled = false,
  icon,
}: LegacyDropdownMenuItemProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cn(
        "w-full flex items-center gap-2 px-3 py-2 text-sm text-left transition-colors",
        "disabled:opacity-50 disabled:cursor-not-allowed",
        variant === "default" && "text-muted-foreground hover:text-foreground hover:bg-muted/50",
        variant === "danger" && "text-destructive hover:bg-destructive/10",
      )}
    >
      {icon && <span className="w-4 h-4">{icon}</span>}
      {children}
    </button>
  );
}

export function LegacyDropdownMenuDivider() {
  return <div className="my-1 h-px bg-border" />;
}
