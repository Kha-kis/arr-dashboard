"use client";

import { cn } from "../../lib/utils";

type ButtonVariant = "primary" | "secondary" | "ghost" | "danger" | "gradient";
type ButtonSize = "sm" | "md" | "lg";

const variantStyles: Record<ButtonVariant, string> = {
	primary: cn(
		"relative overflow-hidden bg-primary text-white shadow-lg shadow-primary/30",
		"hover:shadow-xl hover:shadow-primary/40 hover:scale-[1.02]",
		"active:scale-[0.98]",
		"before:absolute before:inset-0 before:bg-gradient-to-r before:from-white/20 before:to-transparent before:opacity-0 hover:before:opacity-100 before:transition-opacity",
	),
	gradient: cn(
		"relative overflow-hidden bg-gradient-to-r from-primary via-accent to-accent/80 text-white shadow-lg shadow-primary/30",
		"hover:shadow-xl hover:shadow-accent/40 hover:scale-[1.02]",
		"active:scale-[0.98]",
		"before:absolute before:inset-0 before:bg-gradient-to-r before:from-transparent before:via-white/20 before:to-transparent before:translate-x-[-100%] hover:before:translate-x-[100%] before:transition-transform before:duration-700",
	),
	secondary: cn(
		"bg-bg-subtle/40 backdrop-blur-sm hover:bg-bg-subtle/60 text-fg border border-border/50",
		"hover:border-border/80 hover:shadow-md",
		"active:scale-[0.98] transition-all",
	),
	ghost: cn(
		"hover:bg-bg-subtle/50 text-fg-muted hover:text-fg",
		"active:scale-[0.98] transition-all",
	),
	danger: cn(
		"bg-danger/90 hover:bg-danger text-white shadow-lg shadow-danger/20",
		"hover:shadow-xl hover:shadow-danger/30 hover:scale-[1.02]",
		"active:scale-[0.98]",
	),
};

const sizeStyles: Record<ButtonSize, string> = {
	sm: "px-3 py-1.5 text-xs h-8",
	md: "px-4 py-2 text-sm h-10",
	lg: "px-6 py-3 text-base h-12",
};

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
	variant?: ButtonVariant;
	size?: ButtonSize;
	asChild?: boolean;
}

export const Button = ({
	className,
	variant = "primary",
	size = "md",
	type = "button",
	...props
}: ButtonProps) => (
	<button
		type={type}
		className={cn(
			"inline-flex items-center justify-center rounded-xl font-medium transition-all duration-200",
			"focus:outline-none focus:ring-2 focus:ring-primary/50 focus:ring-offset-2 focus:ring-offset-bg",
			"disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:scale-100",
			variantStyles[variant],
			sizeStyles[size],
			className,
		)}
		{...props}
	/>
);
