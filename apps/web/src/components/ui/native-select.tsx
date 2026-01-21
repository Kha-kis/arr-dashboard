"use client";

import * as React from "react";
import { forwardRef } from "react";
import { cn } from "@/lib/utils";

/**
 * Native HTML Select Components
 *
 * These provide styled native <select> elements for simple use cases.
 * For more advanced dropdowns, use the Radix-based Select components.
 *
 * @example
 * ```tsx
 * <NativeSelect value={value} onChange={handleChange}>
 *   <SelectOption value="option1">Option 1</SelectOption>
 *   <SelectOption value="option2">Option 2</SelectOption>
 * </NativeSelect>
 * ```
 */

export interface NativeSelectProps extends React.SelectHTMLAttributes<HTMLSelectElement> {
  error?: boolean;
}

export const NativeSelect = forwardRef<HTMLSelectElement, NativeSelectProps>(
  ({ className, error, children, ...props }, ref) => (
    <select
      ref={ref}
      className={cn(
        "w-full rounded-lg border px-4 py-2.5 text-sm transition-colors",
        "bg-background text-foreground",
        "border-input hover:border-input/80",
        "focus:border-ring focus:outline-hidden focus:ring-2 focus:ring-ring/20",
        "disabled:cursor-not-allowed disabled:opacity-50",
        error && "border-destructive focus:border-destructive focus:ring-destructive/20",
        className,
      )}
      {...props}
    >
      {children}
    </select>
  ),
);

NativeSelect.displayName = "NativeSelect";

export interface SelectOptionProps extends React.OptionHTMLAttributes<HTMLOptionElement> {}

export const SelectOption = forwardRef<HTMLOptionElement, SelectOptionProps>(
  ({ className, ...props }, ref) => (
    <option ref={ref} className={cn("bg-background text-foreground", className)} {...props} />
  ),
);

SelectOption.displayName = "SelectOption";
