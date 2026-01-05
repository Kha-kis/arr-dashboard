import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

/**
 * Utility function for merging Tailwind CSS classes
 *
 * Combines clsx for conditional classes with tailwind-merge
 * to properly handle conflicting Tailwind utilities.
 *
 * @example
 * cn("px-2 py-1", condition && "bg-primary", "px-4")
 * // Result: "py-1 bg-primary px-4" (px-4 overrides px-2)
 */
export function cn(...inputs: ClassValue[]) {
	return twMerge(clsx(inputs));
}
