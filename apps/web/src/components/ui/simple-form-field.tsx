"use client";

import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

interface SimpleFormFieldProps {
  label: string;
  htmlFor?: string;
  hint?: string;
  error?: string;
  required?: boolean;
  children: ReactNode;
  className?: string;
}

/**
 * Simple form field wrapper with label, hint, and error handling
 *
 * Use this for basic form layouts outside of react-hook-form.
 * For react-hook-form integration, use the Form components from shadcn.
 *
 * @example
 * ```tsx
 * <SimpleFormField
 *   label="API Key"
 *   htmlFor="apikey"
 *   hint="Found in Sonarr > Settings > General"
 *   error={errors.apiKey}
 *   required
 * >
 *   <Input id="apikey" {...register('apiKey')} />
 * </SimpleFormField>
 * ```
 */
export function SimpleFormField({
  label,
  htmlFor,
  hint,
  error,
  required,
  children,
  className,
}: SimpleFormFieldProps) {
  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      <label
        htmlFor={htmlFor}
        className="text-sm font-medium text-foreground"
      >
        {label}
        {required && <span className="ml-1 text-destructive">*</span>}
      </label>
      {children}
      {hint && !error && (
        <p className="text-xs text-muted-foreground">{hint}</p>
      )}
      {error && (
        <p className="text-xs text-destructive">{error}</p>
      )}
    </div>
  );
}
