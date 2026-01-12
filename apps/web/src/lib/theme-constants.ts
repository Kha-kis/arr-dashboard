/**
 * Color Theme Constants
 *
 * This file contains theme constants that need to be imported by both:
 * - Server Components (layout.tsx for the blocking script)
 * - Client Components (color-theme-provider.tsx)
 *
 * Keeping these in a separate file without "use client" directive
 * allows them to be imported anywhere.
 */

export const COLOR_THEMES = [
	"blue",
	"purple",
	"green",
	"orange",
	"rose",
	"slate",
	"winamp",
	"terminal",
	"vaporwave",
	"cyber",
	"noir",
	"vhs",
	"synthwave",
	"amber",
	"arr",
	"qbittorrent",
	"cyberpunk",
	"midnight",
] as const;

export type ColorTheme = (typeof COLOR_THEMES)[number];

export const DEFAULT_THEME: ColorTheme = "blue";
export const STORAGE_KEY = "arr-color-theme";
