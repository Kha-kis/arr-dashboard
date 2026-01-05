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
 */

export const COLOR_THEMES = ["blue", "purple", "green", "orange", "rose", "slate"] as const;
export type ColorTheme = (typeof COLOR_THEMES)[number];

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
};

const STORAGE_KEY = "arr-color-theme";
const DEFAULT_THEME: ColorTheme = "blue";

interface ColorThemeContextValue {
	colorTheme: ColorTheme;
	setColorTheme: (theme: ColorTheme) => void;
	themes: typeof COLOR_THEMES;
	themeInfo: typeof THEME_INFO;
}

const ColorThemeContext = createContext<ColorThemeContextValue | undefined>(undefined);

export function ColorThemeProvider({ children }: { children: ReactNode }) {
	const [colorTheme, setColorThemeState] = useState<ColorTheme>(DEFAULT_THEME);
	const [mounted, setMounted] = useState(false);

	// Load theme from localStorage on mount
	useEffect(() => {
		const stored = localStorage.getItem(STORAGE_KEY);
		if (stored && COLOR_THEMES.includes(stored as ColorTheme)) {
			setColorThemeState(stored as ColorTheme);
		}
		setMounted(true);
	}, []);

	// Apply theme to document
	useEffect(() => {
		if (!mounted) return;

		const root = document.documentElement;
		// Remove previous theme
		COLOR_THEMES.forEach((theme) => {
			if (theme !== "blue") {
				root.removeAttribute(`data-theme`);
			}
		});

		// Apply new theme (blue is default, so no data-theme needed)
		if (colorTheme !== "blue") {
			root.setAttribute("data-theme", colorTheme);
		} else {
			root.removeAttribute("data-theme");
		}

		// Persist to localStorage
		localStorage.setItem(STORAGE_KEY, colorTheme);
	}, [colorTheme, mounted]);

	const setColorTheme = useCallback((theme: ColorTheme) => {
		setColorThemeState(theme);
	}, []);

	// Prevent hydration mismatch by not rendering until mounted
	// But we need to render children for server-side rendering
	const value: ColorThemeContextValue = {
		colorTheme: mounted ? colorTheme : DEFAULT_THEME,
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
