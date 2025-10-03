'use client';

import { forwardRef } from "react";
import { cn } from "../../lib/utils";

export interface SelectProps extends React.SelectHTMLAttributes<HTMLSelectElement> {
  error?: boolean;
}

export const Select = forwardRef<HTMLSelectElement, SelectProps>(
  ({ className, error, children, ...props }, ref) => (
    <select
      ref={ref}
      className={cn(
        "w-full rounded-lg border px-3 py-2 text-sm transition-colors",
        "bg-white/10 text-fg",
        "border-border hover:border-border/60",
        "focus:border-primary focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 focus:ring-offset-bg",
        "disabled:cursor-not-allowed disabled:opacity-50",
        error && "border-danger focus:border-danger focus:ring-danger",
        className,
      )}
      {...props}
    >
      {children}
    </select>
  ),
);

Select.displayName = "Select";

export interface SelectOptionProps extends React.OptionHTMLAttributes<HTMLOptionElement> {}

export const SelectOption = forwardRef<HTMLOptionElement, SelectOptionProps>(
  ({ className, ...props }, ref) => (
    <option
      ref={ref}
      className={cn("bg-bg text-fg", className)}
      {...props}
    />
  ),
);

SelectOption.displayName = "SelectOption";
