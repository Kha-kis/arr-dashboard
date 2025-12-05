/**
 * Design Tokens - JavaScript/TypeScript API
 *
 * Spacing, typography, and design constants for programmatic use.
 * For Tailwind usage, see tailwind-preset.ts
 * For CSS custom properties, see tokens.css
 */

/**
 * Spacing scale (matches Tailwind spacing)
 * Use these for programmatic spacing calculations
 */
export const spacing = {
	0: 0,
	1: 4,
	2: 8,
	3: 12,
	4: 16,
	5: 20,
	6: 24,
	8: 32,
	10: 40,
	12: 48,
	16: 64,
	20: 80,
	24: 96,
} as const;

/**
 * Typography scale
 * Font sizes in pixels (convert to rem for CSS)
 */
export const fontSize = {
	xs: 12,
	sm: 14,
	base: 16,
	lg: 18,
	xl: 20,
	"2xl": 24,
	"3xl": 30,
	"4xl": 36,
} as const;

/**
 * Font weights
 */
export const fontWeight = {
	normal: 400,
	medium: 500,
	semibold: 600,
	bold: 700,
} as const;

/**
 * Line heights
 */
export const lineHeight = {
	none: 1,
	tight: 1.25,
	snug: 1.375,
	normal: 1.5,
	relaxed: 1.625,
	loose: 2,
} as const;

/**
 * Border radius values
 */
export const borderRadius = {
	sm: 4,
	md: 8,
	lg: 12,
	xl: 16,
	"2xl": 24,
	full: 9999,
} as const;

/**
 * Typography presets
 * Matches CSS utility classes from tailwind-preset
 */
export const typography = {
	h1: {
		fontSize: fontSize["3xl"],
		lineHeight: lineHeight.tight,
		fontWeight: fontWeight.bold,
	},
	h2: {
		fontSize: fontSize["2xl"],
		lineHeight: lineHeight.tight,
		fontWeight: fontWeight.bold,
	},
	h3: {
		fontSize: fontSize.xl,
		lineHeight: lineHeight.normal,
		fontWeight: fontWeight.semibold,
	},
	h4: {
		fontSize: fontSize.lg,
		lineHeight: lineHeight.normal,
		fontWeight: fontWeight.semibold,
	},
	body: {
		fontSize: fontSize.base,
		lineHeight: lineHeight.normal,
		fontWeight: fontWeight.normal,
	},
	small: {
		fontSize: fontSize.sm,
		lineHeight: lineHeight.normal,
		fontWeight: fontWeight.normal,
	},
	caption: {
		fontSize: fontSize.xs,
		lineHeight: lineHeight.normal,
		fontWeight: fontWeight.normal,
	},
} as const;
