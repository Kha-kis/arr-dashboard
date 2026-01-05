/**
 * useThemeGradient Hook
 *
 * Convenience hook that combines useColorTheme with THEME_GRADIENTS lookup.
 * Use this in components that need theme-aware gradient styling.
 *
 * @example
 * ```tsx
 * const { gradient, colorTheme } = useThemeGradient();
 *
 * return (
 *   <div style={{ background: `linear-gradient(135deg, ${gradient.from}, ${gradient.to})` }}>
 *     Content
 *   </div>
 * );
 * ```
 */

import { useColorTheme } from "../providers/color-theme-provider";
import { THEME_GRADIENTS, type ThemeGradient } from "../lib/theme-gradients";
import type { ColorTheme } from "../providers/color-theme-provider";

interface UseThemeGradientReturn {
	/** The current theme gradient colors */
	gradient: ThemeGradient;
	/** The current color theme name */
	colorTheme: ColorTheme;
	/** Function to change the color theme */
	setColorTheme: (theme: ColorTheme) => void;
	/** All available theme gradients */
	allGradients: typeof THEME_GRADIENTS;
}

export function useThemeGradient(): UseThemeGradientReturn {
	const { colorTheme, setColorTheme } = useColorTheme();
	const gradient = THEME_GRADIENTS[colorTheme];

	return {
		gradient,
		colorTheme,
		setColorTheme,
		allGradients: THEME_GRADIENTS,
	};
}
