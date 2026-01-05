"use client";

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
				"w-full rounded-xl border px-4 py-3 text-sm transition-all duration-200",
				"bg-bg-subtle text-fg",
				"border-border hover:border-border/80 hover:bg-bg-subtle/80",
				"focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20 focus:bg-bg-subtle/80",
				"disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:border-border",
				error && "border-danger focus:border-danger focus:ring-danger/20",
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
		<option ref={ref} className={cn("bg-bg text-fg", className)} {...props} />
	),
);

SelectOption.displayName = "SelectOption";
