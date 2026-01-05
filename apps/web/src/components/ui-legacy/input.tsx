"use client";

import { forwardRef } from "react";
import { cn } from "../../lib/utils";

export interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {}

export const Input = forwardRef<HTMLInputElement, InputProps>(
	({ className, type = "text", ...props }, ref) => (
		<input
			ref={ref}
			type={type}
			className={cn(
				"w-full rounded-xl border border-border bg-bg-subtle px-4 py-3 text-sm text-fg",
				"placeholder:text-fg-muted/60",
				"transition-all duration-200",
				"hover:border-border/80 hover:bg-bg-subtle/80",
				"focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20 focus:bg-bg-subtle/80",
				"disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:border-border",
				className,
			)}
			{...props}
		/>
	),
);

Input.displayName = "Input";
