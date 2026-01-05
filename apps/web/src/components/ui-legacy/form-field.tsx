"use client";

import { cn } from "../../lib/utils";
import type { ReactNode } from "react";

interface FormFieldProps {
	label: string;
	htmlFor?: string;
	hint?: string;
	error?: string;
	required?: boolean;
	children: ReactNode;
	className?: string;
}

/**
 * Form field wrapper with label, hint, and error handling
 *
 * Provides consistent form field structure with:
 * - Label (with optional required indicator)
 * - Hint text
 * - Error message
 * - Proper spacing and styling
 *
 * @example
 * ```tsx
 * <FormField
 *   label="API Key"
 *   htmlFor="apikey"
 *   hint="Found in Sonarr > Settings > General"
 *   error={errors.apiKey}
 *   required
 * >
 *   <Input id="apikey" {...register('apiKey')} />
 * </FormField>
 * ```
 */
export const FormField = ({
	label,
	htmlFor,
	hint,
	error,
	required,
	children,
	className,
}: FormFieldProps) => {
	return (
		<div className={cn("flex flex-col gap-1.5", className)}>
			<label
				htmlFor={htmlFor}
				className="text-sm font-medium text-fg"
			>
				{label}
				{required && <span className="ml-1 text-danger">*</span>}
			</label>
			{children}
			{hint && !error && (
				<p className="text-xs text-fg-muted">{hint}</p>
			)}
			{error && (
				<p className="text-xs text-danger">{error}</p>
			)}
		</div>
	);
};
