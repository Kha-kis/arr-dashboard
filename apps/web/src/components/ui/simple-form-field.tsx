"use client";

import { type ReactNode, type ReactElement, cloneElement, isValidElement, useId } from "react";
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
 * This component automatically injects aria-invalid and aria-describedby
 * into direct child input elements for accessibility compliance.
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
  const generatedId = useId();
  const errorId = `${generatedId}-error`;
  const hintId = `${generatedId}-hint`;

  // Build aria-describedby value based on what's visible
  const describedBy = [
    error ? errorId : null,
    hint && !error ? hintId : null,
  ].filter(Boolean).join(" ") || undefined;

  // Inject aria attributes into the child input if it's a valid React element
  const enhancedChildren = isValidElement(children)
    ? cloneElement(children as ReactElement<{ "aria-invalid"?: boolean; "aria-describedby"?: string }>, {
        "aria-invalid": !!error || undefined,
        "aria-describedby": describedBy,
      })
    : children;

  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      <label
        htmlFor={htmlFor}
        className="text-sm font-medium text-foreground"
      >
        {label}
        {required && <span className="ml-1 text-destructive">*</span>}
      </label>
      {enhancedChildren}
      {hint && !error && (
        <p id={hintId} className="text-xs text-muted-foreground">{hint}</p>
      )}
      {error && (
        <p id={errorId} className="text-xs text-destructive" role="alert">{error}</p>
      )}
    </div>
  );
}
