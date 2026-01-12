/**
 * Theme-Aware Input Styles
 *
 * Provides consistent, theme-aware styling for form inputs, buttons, and interactive elements.
 * Use these utilities with the centralized theme-gradients system.
 *
 * Usage:
 * ```tsx
 * import { getInputStyles, getSelectStyles } from "@/lib/theme-input-styles";
 * import { useThemeGradient } from "@/hooks/useThemeGradient";
 *
 * const { gradient: themeGradient } = useThemeGradient();
 * const inputStyles = getInputStyles(themeGradient);
 *
 * <input
 *   className={inputStyles.base}
 *   style={inputStyles.focusStyle}
 *   onFocus={(e) => inputStyles.applyFocus(e.currentTarget)}
 *   onBlur={(e) => inputStyles.removeFocus(e.currentTarget)}
 * />
 * ```
 */

import type { ThemeGradient } from "./theme-gradients";

/**
 * Generate inline style object for focus state
 */
export const getFocusStyles = (gradient: ThemeGradient) => ({
	borderColor: gradient.from,
	boxShadow: `0 0 0 2px ${gradient.fromLight}`,
	outline: "none",
});

/**
 * Generate inline style object for active/selected state
 */
export const getActiveStyles = (gradient: ThemeGradient) => ({
	borderColor: gradient.from,
	backgroundColor: gradient.fromLight,
});

/**
 * Generate inline style object for hover state on buttons
 */
export const getHoverStyles = (gradient: ThemeGradient) => ({
	borderColor: gradient.fromMuted,
});

/**
 * Get complete input styling utilities
 */
export const getInputStyles = (gradient: ThemeGradient) => ({
	/**
	 * Base Tailwind classes for inputs (without focus colors)
	 */
	base: "w-full rounded-lg border border-border bg-card px-3 py-2 text-sm text-foreground transition-all duration-200",

	/**
	 * Style object to apply on focus (use with onFocus handler or CSS)
	 */
	focusStyle: {
		"--theme-focus-color": gradient.from,
		"--theme-focus-ring": gradient.fromLight,
		"--theme-focus-border": gradient.fromMuted,
	} as React.CSSProperties,

	/**
	 * Apply focus styles programmatically
	 */
	applyFocus: (element: HTMLElement) => {
		element.style.borderColor = gradient.from;
		element.style.boxShadow = `0 0 0 2px ${gradient.fromLight}`;
		element.style.outline = "none";
	},

	/**
	 * Remove focus styles programmatically
	 */
	removeFocus: (element: HTMLElement) => {
		element.style.borderColor = "";
		element.style.boxShadow = "";
	},

	/**
	 * Get CSS object for focus state (use with style prop)
	 */
	getFocusCSS: () => getFocusStyles(gradient),
});

/**
 * Get select/dropdown styling utilities
 */
export const getSelectStyles = (gradient: ThemeGradient) => ({
	/**
	 * Base Tailwind classes for select elements
	 */
	base: "w-full rounded-lg border border-border bg-card px-3 py-2 text-sm text-foreground transition-all duration-200 cursor-pointer",

	/**
	 * Apply focus styles programmatically
	 */
	applyFocus: (element: HTMLElement) => {
		element.style.borderColor = gradient.from;
		element.style.boxShadow = `0 0 0 2px ${gradient.fromLight}`;
		element.style.outline = "none";
	},

	/**
	 * Remove focus styles programmatically
	 */
	removeFocus: (element: HTMLElement) => {
		element.style.borderColor = "";
		element.style.boxShadow = "";
	},
});

/**
 * Get button styling with theme-aware active state
 */
export const getToggleButtonStyles = (gradient: ThemeGradient, isActive: boolean) => ({
	/**
	 * Base classes (without active state)
	 */
	base: "flex-1 rounded-lg border px-3 py-2 text-sm capitalize transition-all duration-200",

	/**
	 * Style object for the button based on active state
	 */
	style: isActive
		? {
				borderColor: gradient.from,
				backgroundColor: gradient.fromLight,
				color: gradient.from,
		  }
		: undefined,

	/**
	 * Additional classes for inactive state
	 */
	inactiveClasses: "border-border bg-card text-muted-foreground hover:text-foreground",
});

/**
 * Get chip/tag styling with theme colors
 */
export const getChipStyles = (gradient: ThemeGradient, isActive: boolean = false) => ({
	style: {
		backgroundColor: gradient.fromLight,
		borderColor: gradient.fromMuted,
		color: gradient.from,
	},
});

/**
 * CSS class strings that work with Tailwind's focus-within and hover states
 * These use CSS variable fallbacks for theming
 */
export const INPUT_BASE_CLASSES = {
	/** Standard text input */
	input: "w-full rounded-lg border border-border bg-card px-3 py-2 text-sm text-foreground transition-all duration-200 focus:outline-none",

	/** Select/dropdown */
	select: "w-full rounded-lg border border-border bg-card px-3 py-2 text-sm text-foreground transition-all duration-200 cursor-pointer focus:outline-none",

	/** Textarea */
	textarea: "w-full rounded-lg border border-border bg-card px-3 py-2 text-sm text-foreground transition-all duration-200 resize-none focus:outline-none",

	/** Checkbox/Radio */
	checkbox: "h-4 w-4 rounded border-2 transition-all duration-200 cursor-pointer border-border/50 bg-card/50 focus:ring-2 focus:ring-offset-0",
};

/**
 * Hook-friendly function to get all input utilities
 */
export const useInputStyles = (gradient: ThemeGradient) => {
	return {
		input: getInputStyles(gradient),
		select: getSelectStyles(gradient),
		toggleButton: (isActive: boolean) => getToggleButtonStyles(gradient, isActive),
		chip: (isActive?: boolean) => getChipStyles(gradient, isActive),
		focus: getFocusStyles(gradient),
		active: getActiveStyles(gradient),
		hover: getHoverStyles(gradient),
	};
};
