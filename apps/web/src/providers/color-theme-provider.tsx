"use client";

import {
	createContext,
	useContext,
	useEffect,
	useState,
	useCallback,
	type ReactNode,
} from "react";

/**
 * Color Theme Provider
 *
 * Manages color theme presets independently from the light/dark mode.
 * Works alongside next-themes to provide full theme customization:
 * - next-themes: handles light/dark mode via "class" attribute
 * - ColorThemeProvider: handles color preset via "data-theme" attribute
 *
 * This allows combinations like "dark purple" or "light green".
 *
 * IMPORTANT: An inline blocking script in layout.tsx sets the data-theme
 * attribute BEFORE React hydration. The script uses COLOR_THEMES from
 * theme-constants.ts (single source of truth) to prevent theme flash.
 */

// Import from shared constants (single source of truth)
import { COLOR_THEMES, type ColorTheme, DEFAULT_THEME, STORAGE_KEY } from "../lib/theme-constants";

// Re-export for backwards compatibility with existing imports
export { COLOR_THEMES, type ColorTheme, DEFAULT_THEME, STORAGE_KEY };

/**
 * Premium theme identifiers
 */
export const PREMIUM_THEME_IDS = ["arr", "qbittorrent", "cyberpunk", "midnight"] as const;
export type PremiumThemeId = (typeof PREMIUM_THEME_IDS)[number];

/**
 * Check if premium themes are unlocked (for development/testing)
 * Set via browser console: localStorage.setItem('arr-premium-unlocked', 'true')
 */
const PREMIUM_STORAGE_KEY = "arr-premium-unlocked";

export function isPremiumUnlocked(): boolean {
	if (typeof window === "undefined") return false;
	try {
		return localStorage.getItem(PREMIUM_STORAGE_KEY) === "true";
	} catch {
		return false;
	}
}

/**
 * Check if a theme is a premium theme
 */
export function isPremiumTheme(theme: ColorTheme): boolean {
	return PREMIUM_THEME_IDS.includes(theme as PremiumThemeId);
}

/**
 * Premium theme info for "Coming Soon" display
 */
export const PREMIUM_THEME_INFO: Record<PremiumThemeId, { label: string; color: string; description: string }> = {
	arr: {
		label: "*arr Suite",
		color: "hsl(193 91% 58%)",
		description: "Authentic Sonarr/Radarr dark interface aesthetic",
	},
	qbittorrent: {
		label: "qBittorrent",
		color: "hsl(210 65% 55%)",
		description: "Classic torrent client UI with blue accents",
	},
	cyberpunk: {
		label: "Cyberpunk",
		color: "hsl(55 100% 50%)",
		description: "Neon yellow chaos with glitch distortions",
	},
	midnight: {
		label: "Midnight",
		color: "hsl(240 80% 20%)",
		description: "Deep space galaxy with stars and nebulae",
	},
};

/**
 * Premium theme gradient values for orb display
 */
export const PREMIUM_GRADIENT_VALUES: Record<PremiumThemeId, { from: string; to: string; glow: string }> = {
	arr: {
		from: "#35c5f4",
		to: "#ffc230",
		glow: "rgba(53, 197, 244, 0.5)",
	},
	qbittorrent: {
		from: "#4a90c2",
		to: "#dc8033",
		glow: "rgba(74, 144, 194, 0.5)",
	},
	cyberpunk: {
		from: "#ffff00",
		to: "#ff0055",
		glow: "rgba(255, 255, 0, 0.5)",
	},
	midnight: {
		from: "#1a1a4e",
		to: "#4a0080",
		glow: "rgba(100, 50, 180, 0.5)",
	},
};

/**
 * Standard themes adapt to light/dark mode
 */
export const STANDARD_THEMES: ColorTheme[] = ["blue", "purple", "green", "orange", "rose", "slate"];

/**
 * Immersive themes have their own dark aesthetic and don't adapt to light/dark mode.
 * They include special visual effects like scanlines, neon glow, etc.
 */
export const IMMERSIVE_THEMES: ColorTheme[] = ["winamp", "terminal", "vaporwave", "cyber", "noir", "vhs", "synthwave", "amber"];

/**
 * Check if a theme is an immersive (premium) theme
 */
export function isImmersiveTheme(theme: ColorTheme): boolean {
	return IMMERSIVE_THEMES.includes(theme);
}

export const THEME_INFO: Record<ColorTheme, { label: string; color: string; description: string }> = {
	blue: {
		label: "Blue",
		color: "hsl(217 91% 60%)",
		description: "Default blue theme with purple accent",
	},
	purple: {
		label: "Purple",
		color: "hsl(270 95% 60%)",
		description: "Vibrant purple with rose accent",
	},
	green: {
		label: "Green",
		color: "hsl(142 76% 36%)",
		description: "Natural green with teal accent",
	},
	orange: {
		label: "Orange",
		color: "hsl(25 95% 53%)",
		description: "Warm orange with amber accent",
	},
	rose: {
		label: "Rose",
		color: "hsl(346 77% 50%)",
		description: "Elegant rose with pink accent",
	},
	slate: {
		label: "Slate",
		color: "hsl(215 20% 45%)",
		description: "Minimal slate for a clean look",
	},
	winamp: {
		label: "Winamp",
		color: "hsl(120 100% 50%)",
		description: "Classic media player with neon green LEDs",
	},
	terminal: {
		label: "Terminal",
		color: "hsl(120 100% 40%)",
		description: "Matrix-style hacker aesthetic with CRT glow",
	},
	vaporwave: {
		label: "Vaporwave",
		color: "hsl(300 100% 70%)",
		description: "Retro 80s sunset with pink and cyan",
	},
	cyber: {
		label: "Y2K Cyber",
		color: "hsl(195 100% 50%)",
		description: "Futuristic chrome with electric accents",
	},
	noir: {
		label: "Film Noir",
		color: "hsl(45 60% 55%)",
		description: "1940s cinema aesthetic with dramatic shadows",
	},
	vhs: {
		label: "VHS",
		color: "hsl(200 15% 75%)",
		description: "Analog video nostalgia with tracking artifacts",
	},
	synthwave: {
		label: "Synthwave",
		color: "hsl(320 100% 60%)",
		description: "80s retrofuturism with neon highways",
	},
	amber: {
		label: "Amber CRT",
		color: "hsl(35 100% 50%)",
		description: "Classic monochrome terminal with phosphor glow",
	},
	// Premium themes
	arr: {
		label: "*arr Suite",
		color: "hsl(193 91% 58%)",
		description: "Authentic Sonarr/Radarr dark interface aesthetic",
	},
	qbittorrent: {
		label: "qBittorrent",
		color: "hsl(210 65% 55%)",
		description: "Classic torrent client UI with blue accents",
	},
	cyberpunk: {
		label: "Cyberpunk",
		color: "hsl(55 100% 50%)",
		description: "Neon yellow chaos with glitch distortions",
	},
	midnight: {
		label: "Midnight",
		color: "hsl(240 80% 20%)",
		description: "Deep space galaxy with stars and nebulae",
	},
};

/**
 * Get the initial theme from the DOM or localStorage.
 * The inline blocking script in layout.tsx sets data-theme before React runs,
 * so we can read it here to avoid theme flash.
 */
function getInitialTheme(): ColorTheme {
	// During SSR, return default
	if (typeof window === "undefined") {
		return DEFAULT_THEME;
	}

	// First, check the DOM attribute (set by blocking script)
	const domTheme = document.documentElement.getAttribute("data-theme");
	if (domTheme && COLOR_THEMES.includes(domTheme as ColorTheme)) {
		return domTheme as ColorTheme;
	}

	// If no data-theme attribute, check localStorage
	// (handles the case where theme is "blue" which doesn't set the attribute)
	try {
		const stored = localStorage.getItem(STORAGE_KEY);
		if (stored && COLOR_THEMES.includes(stored as ColorTheme)) {
			return stored as ColorTheme;
		}
	} catch {
		// localStorage not available
	}

	return DEFAULT_THEME;
}

interface ColorThemeContextValue {
	colorTheme: ColorTheme;
	setColorTheme: (theme: ColorTheme) => void;
	themes: typeof COLOR_THEMES;
	themeInfo: typeof THEME_INFO;
}

const ColorThemeContext = createContext<ColorThemeContextValue | undefined>(undefined);

export function ColorThemeProvider({ children }: { children: ReactNode }) {
	// Use lazy initialization to read from DOM/localStorage immediately
	// This prevents the flash because the blocking script already set the attribute
	const [colorTheme, setColorThemeState] = useState<ColorTheme>(getInitialTheme);
	const [mounted, setMounted] = useState(false);

	// Mark as mounted after hydration
	useEffect(() => {
		setMounted(true);
	}, []);

	// Apply theme to document when it changes
	useEffect(() => {
		if (!mounted) return;

		const root = document.documentElement;

		// Apply new theme (blue is default, so no data-theme needed)
		if (colorTheme !== "blue") {
			root.setAttribute("data-theme", colorTheme);
		} else {
			root.removeAttribute("data-theme");
		}

		// Persist to localStorage
		try {
			localStorage.setItem(STORAGE_KEY, colorTheme);
		} catch {
			// localStorage not available
		}
	}, [colorTheme, mounted]);

	const setColorTheme = useCallback((theme: ColorTheme) => {
		setColorThemeState(theme);
	}, []);

	const value: ColorThemeContextValue = {
		colorTheme,
		setColorTheme,
		themes: COLOR_THEMES,
		themeInfo: THEME_INFO,
	};

	return (
		<ColorThemeContext.Provider value={value}>
			{children}
		</ColorThemeContext.Provider>
	);
}

export function useColorTheme() {
	const context = useContext(ColorThemeContext);
	if (context === undefined) {
		throw new Error("useColorTheme must be used within a ColorThemeProvider");
	}
	return context;
}
