'use client';

import { cn } from "../../lib/utils";

type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";

const variantStyles: Record<ButtonVariant, string> = {
  primary: "bg-sky-500 hover:bg-sky-600 text-white",
  secondary: "bg-white/10 hover:bg-white/20 text-white",
  ghost: "hover:bg-white/10 text-white",
  danger: "bg-red-500 hover:bg-red-600 text-white",
};

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  asChild?: boolean;
}

export const Button = ({ className, variant = "primary", type = "button", ...props }: ButtonProps) => (
  <button
    type={type}
    className={cn(
      "inline-flex items-center justify-center rounded-lg px-4 py-2 text-sm font-medium transition focus:outline-none focus:ring-2 focus:ring-sky-400 focus:ring-offset-2 focus:ring-offset-slate-950 disabled:opacity-50",
      variantStyles[variant],
      className,
    )}
    {...props}
  />
);
