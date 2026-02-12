/**
 * Centralized Theme Gradients System
 *
 * This module provides consistent theme-aware gradient colors across the entire app.
 * It exports constants, types, and utility functions for theming.
 *
 * ## Quick Start (Recommended):
 * ```tsx
 * // For theme gradients (user's selected color theme)
 * import { useThemeGradient } from "@/hooks/useThemeGradient";
 * const { gradient } = useThemeGradient();
 *
 * // For service gradients (Sonarr/Radarr/Prowlarr colors)
 * import { getServiceGradient, SERVICE_GRADIENTS } from "@/lib/theme-gradients";
 *
 * // Runtime lookup (when service comes from a variable)
 * const gradient = getServiceGradient(instance.service);
 *
 * // Compile-time lookup (when service is hardcoded)
 * const gradient = SERVICE_GRADIENTS.sonarr;
 * ```
 *
 * ## Pattern: Theme-Aware Select Elements
 * Since Tailwind classes are generated at build time, dynamic theme colors require inline styles:
 * ```tsx
 * const [focusedSelect, setFocusedSelect] = useState<string | null>(null);
 *
 * const getSelectStyle = (id: string) => {
 *   if (focusedSelect === id) {
 *     return {
 *       borderColor: themeGradient.from,
 *       boxShadow: `0 0 0 1px ${themeGradient.from}`,
 *     };
 *   }
 *   return undefined;
 * };
 *
 * <select
 *   className="border border-border bg-card focus:outline-hidden"
 *   style={getSelectStyle("mySelect")}
 *   onFocus={() => setFocusedSelect("mySelect")}
 *   onBlur={() => setFocusedSelect(null)}
 * />
 * ```
 *
 * ## Pattern: Theme-Aware Hover Links
 * ```tsx
 * <a
 *   className="text-muted-foreground transition-colors"
 *   onMouseEnter={(e) => { e.currentTarget.style.color = themeGradient.from; }}
 *   onMouseLeave={(e) => { e.currentTarget.style.color = ""; }}
 * />
 * ```
 *
 * ## Pattern: Theme-Aware Badges
 * ```tsx
 * <span
 *   className="rounded-full border px-2 py-0.5 text-xs"
 *   style={{
 *     borderColor: `${themeGradient.from}66`, // 40% opacity
 *     backgroundColor: themeGradient.fromLight,
 *     color: themeGradient.from,
 *   }}
 * />
 * ```
 *
 * ## Color Hierarchy:
 * - Theme colors (THEME_GRADIENTS): Primary accent, selections, focus states, info badges
 * - Service colors (SERVICE_GRADIENTS): Sonarr=cyan, Radarr=orange, Prowlarr=purple
 * - Semantic colors (SEMANTIC_COLORS): success=green, warning=amber, error=red
 */


import type { ColorTheme } from "../providers/color-theme-provider";

/**
 * Theme gradient configuration for each color theme
 *
 * @property from - Primary gradient start color (hex)
 * @property to - Secondary gradient end color (hex)
 * @property glow - Glow/shadow color with opacity (rgba)
 * @property fromLight - Lighter variant of 'from' for subtle backgrounds
 * @property accent - Contrasting accent for emphasis
 */
export interface ThemeGradient {
	/** Primary color - gradient start */
	from: string;
	/** Secondary color - gradient end */
	to: string;
	/** Glow color for shadows (with opacity) */
	glow: string;
	/** Light variant for subtle backgrounds (10% opacity) */
	fromLight: string;
	/** Medium variant for hover states (20% opacity) */
	fromMedium: string;
	/** Muted variant for borders (30% opacity) */
	fromMuted: string;
}

/**
 * CSS Variable-based theme gradient
 *
 * Uses CSS custom properties (--theme-*) defined in globals.css.
 * This enables instant theme switching without React re-renders and
 * eliminates flash on page load since the blocking script sets
 * data-theme before any paint occurs.
 *
 * The CSS variables are resolved by the browser at render time,
 * ensuring the correct theme colors are displayed immediately.
 */
const CSS_THEME_GRADIENT: ThemeGradient = {
	from: "var(--theme-from)",
	to: "var(--theme-to)",
	glow: "var(--theme-glow)",
	fromLight: "var(--theme-from-light)",
	fromMedium: "var(--theme-from-medium)",
	fromMuted: "var(--theme-from-muted)",
};

/**
 * Master theme gradient definitions
 *
 * All themes now use CSS variables for instant switching and flash-free loading.
 * The actual color values are defined in globals.css under each [data-theme] selector.
 *
 * Benefits:
 * 1. No flash on page load - blocking script sets data-theme before paint
 * 2. Instant theme switching - CSS variables update without React re-render
 * 3. SSR compatible - CSS variables work in server-rendered HTML
 * 4. Backwards compatible - existing code using THEME_GRADIENTS[colorTheme] still works
 */
export const THEME_GRADIENTS: Record<ColorTheme, ThemeGradient> = {
	blue: CSS_THEME_GRADIENT,
	purple: CSS_THEME_GRADIENT,
	green: CSS_THEME_GRADIENT,
	orange: CSS_THEME_GRADIENT,
	rose: CSS_THEME_GRADIENT,
	slate: CSS_THEME_GRADIENT,
	winamp: CSS_THEME_GRADIENT,
	terminal: CSS_THEME_GRADIENT,
	vaporwave: CSS_THEME_GRADIENT,
	cyber: CSS_THEME_GRADIENT,
	noir: CSS_THEME_GRADIENT,
	vhs: CSS_THEME_GRADIENT,
	synthwave: CSS_THEME_GRADIENT,
	amber: CSS_THEME_GRADIENT,
	// Premium themes
	arr: CSS_THEME_GRADIENT,
	qbittorrent: CSS_THEME_GRADIENT,
	cyberpunk: CSS_THEME_GRADIENT,
	midnight: CSS_THEME_GRADIENT,
};

/**
 * Static hex values for each theme (for color manipulation, debugging, etc.)
 *
 * Use these when you need actual color values instead of CSS variable references,
 * such as for canvas drawing, color calculations, or server-side rendering
 * where CSS variables aren't available.
 */
export const THEME_GRADIENT_VALUES: Record<ColorTheme, ThemeGradient> = {
	blue: {
		from: "#3b82f6",      // blue-500
		to: "#8b5cf6",        // violet-500
		glow: "rgba(59, 130, 246, 0.4)",
		fromLight: "rgba(59, 130, 246, 0.1)",
		fromMedium: "rgba(59, 130, 246, 0.2)",
		fromMuted: "rgba(59, 130, 246, 0.3)",
	},
	purple: {
		from: "#8b5cf6",      // violet-500
		to: "#ec4899",        // pink-500
		glow: "rgba(139, 92, 246, 0.4)",
		fromLight: "rgba(139, 92, 246, 0.1)",
		fromMedium: "rgba(139, 92, 246, 0.2)",
		fromMuted: "rgba(139, 92, 246, 0.3)",
	},
	green: {
		from: "#22c55e",      // green-500
		to: "#14b8a6",        // teal-500
		glow: "rgba(34, 197, 94, 0.4)",
		fromLight: "rgba(34, 197, 94, 0.1)",
		fromMedium: "rgba(34, 197, 94, 0.2)",
		fromMuted: "rgba(34, 197, 94, 0.3)",
	},
	orange: {
		from: "#f97316",      // orange-500
		to: "#eab308",        // yellow-500
		glow: "rgba(249, 115, 22, 0.4)",
		fromLight: "rgba(249, 115, 22, 0.1)",
		fromMedium: "rgba(249, 115, 22, 0.2)",
		fromMuted: "rgba(249, 115, 22, 0.3)",
	},
	rose: {
		from: "#f43f5e",      // rose-500
		to: "#ec4899",        // pink-500
		glow: "rgba(244, 63, 94, 0.4)",
		fromLight: "rgba(244, 63, 94, 0.1)",
		fromMedium: "rgba(244, 63, 94, 0.2)",
		fromMuted: "rgba(244, 63, 94, 0.3)",
	},
	slate: {
		from: "#64748b",      // slate-500
		to: "#475569",        // slate-600
		glow: "rgba(100, 116, 139, 0.3)",
		fromLight: "rgba(100, 116, 139, 0.1)",
		fromMedium: "rgba(100, 116, 139, 0.15)",
		fromMuted: "rgba(100, 116, 139, 0.2)",
	},
	// === NOSTALGIC / SPECIAL THEMES ===
	winamp: {
		from: "#00ff00",      // Classic Winamp neon green
		to: "#39ff14",        // Electric lime
		glow: "rgba(0, 255, 0, 0.5)",
		fromLight: "rgba(0, 255, 0, 0.1)",
		fromMedium: "rgba(0, 255, 0, 0.2)",
		fromMuted: "rgba(0, 255, 0, 0.3)",
	},
	terminal: {
		from: "#20c20e",      // Matrix green
		to: "#00ff41",        // Phosphor green
		glow: "rgba(32, 194, 14, 0.5)",
		fromLight: "rgba(32, 194, 14, 0.1)",
		fromMedium: "rgba(32, 194, 14, 0.2)",
		fromMuted: "rgba(32, 194, 14, 0.3)",
	},
	vaporwave: {
		from: "#ff6ec7",      // Hot pink
		to: "#00ffff",        // Cyan
		glow: "rgba(255, 110, 199, 0.5)",
		fromLight: "rgba(255, 110, 199, 0.1)",
		fromMedium: "rgba(255, 110, 199, 0.2)",
		fromMuted: "rgba(255, 110, 199, 0.3)",
	},
	cyber: {
		from: "#00d4ff",      // Electric cyan
		to: "#ff00ff",        // Magenta
		glow: "rgba(0, 212, 255, 0.5)",
		fromLight: "rgba(0, 212, 255, 0.1)",
		fromMedium: "rgba(0, 212, 255, 0.2)",
		fromMuted: "rgba(0, 212, 255, 0.3)",
	},
	// === NEW IMMERSIVE THEMES ===
	noir: {
		from: "#c9a855",      // Muted gold
		to: "#e8dcc8",        // Cream
		glow: "rgba(201, 168, 85, 0.5)",
		fromLight: "rgba(201, 168, 85, 0.1)",
		fromMedium: "rgba(201, 168, 85, 0.2)",
		fromMuted: "rgba(201, 168, 85, 0.3)",
	},
	vhs: {
		from: "#b8c4d0",      // Blue-tinted white
		to: "#d94545",        // Recording red
		glow: "rgba(184, 196, 208, 0.5)",
		fromLight: "rgba(184, 196, 208, 0.1)",
		fromMedium: "rgba(184, 196, 208, 0.2)",
		fromMuted: "rgba(184, 196, 208, 0.3)",
	},
	synthwave: {
		from: "#ff2d95",      // Hot pink
		to: "#00ffff",        // Electric cyan
		glow: "rgba(255, 45, 149, 0.5)",
		fromLight: "rgba(255, 45, 149, 0.1)",
		fromMedium: "rgba(255, 45, 149, 0.2)",
		fromMuted: "rgba(255, 45, 149, 0.3)",
	},
	amber: {
		from: "#ffb000",      // Amber phosphor
		to: "#ffc940",        // Bright amber
		glow: "rgba(255, 176, 0, 0.5)",
		fromLight: "rgba(255, 176, 0, 0.1)",
		fromMedium: "rgba(255, 176, 0, 0.2)",
		fromMuted: "rgba(255, 176, 0, 0.3)",
	},
	// Premium themes
	arr: {
		from: "#35c5f4",      // Sonarr cyan
		to: "#ffc230",        // Radarr amber
		glow: "rgba(53, 197, 244, 0.5)",
		fromLight: "rgba(53, 197, 244, 0.1)",
		fromMedium: "rgba(53, 197, 244, 0.2)",
		fromMuted: "rgba(53, 197, 244, 0.3)",
	},
	qbittorrent: {
		from: "#4a90c2",      // qBittorrent blue - flat design, no gradient
		to: "#4a90c2",        // Same as 'from' - qBittorrent uses flat colors, not gradients
		glow: "transparent",  // No glow effects - authentic desktop app style
		fromLight: "rgba(74, 144, 194, 0.1)",
		fromMedium: "rgba(74, 144, 194, 0.15)",
		fromMuted: "rgba(74, 144, 194, 0.2)",
	},
	cyberpunk: {
		from: "#ff2a6d",      // Cyberpunk 2077 hot pink
		to: "#05d9e8",        // Electric cyan
		glow: "rgba(255, 42, 109, 0.6)",
		fromLight: "rgba(255, 42, 109, 0.1)",
		fromMedium: "rgba(255, 42, 109, 0.2)",
		fromMuted: "rgba(255, 42, 109, 0.35)",
	},
	midnight: {
		from: "#4a0080",      // Deep purple
		to: "#000033",        // Midnight blue
		glow: "rgba(100, 50, 180, 0.5)",
		fromLight: "rgba(74, 0, 128, 0.1)",
		fromMedium: "rgba(74, 0, 128, 0.2)",
		fromMuted: "rgba(74, 0, 128, 0.3)",
	},
};

/**
 * Service gradient configuration
 *
 * @property from - Primary gradient start color (hex)
 * @property to - Secondary gradient end color (hex)
 * @property glow - Glow/shadow color with opacity (rgba)
 */
export interface ServiceGradient {
	/** Primary color - gradient start */
	from: string;
	/** Secondary color - gradient end */
	to: string;
	/** Glow color for shadows (with opacity) */
	glow: string;
}

/** Valid service types for gradient lookup */
export type ServiceType = "sonarr" | "radarr" | "prowlarr" | "lidarr" | "readarr";

/**
 * Service-specific gradients for visual distinction
 * These maintain service identity regardless of user's color theme
 *
 * - Sonarr (TV): Cyan-Blue gradient
 * - Radarr (Movies): Orange-Yellow gradient
 * - Prowlarr (Indexers): Purple-Pink gradient
 * - Lidarr (Music): Green-Teal gradient
 * - Readarr (Books): Violet-Indigo gradient
 */
export const SERVICE_GRADIENTS: Record<ServiceType, ServiceGradient> = {
	sonarr: {
		from: "#06b6d4",      // cyan-500
		to: "#3b82f6",        // blue-500
		glow: "rgba(6, 182, 212, 0.4)",
	},
	radarr: {
		from: "#f97316",      // orange-500
		to: "#eab308",        // yellow-500
		glow: "rgba(249, 115, 22, 0.4)",
	},
	prowlarr: {
		from: "#a855f7",      // purple-500
		to: "#ec4899",        // pink-500
		glow: "rgba(168, 85, 247, 0.4)",
	},
	lidarr: {
		from: "#22c55e",      // green-500 (music/harmony)
		to: "#14b8a6",        // teal-500
		glow: "rgba(34, 197, 94, 0.4)",
	},
	readarr: {
		from: "#8b5cf6",      // violet-500 (books/wisdom)
		to: "#6366f1",        // indigo-500
		glow: "rgba(139, 92, 246, 0.4)",
	},
};

/**
 * Get gradient colors for a service type
 *
 * Safely retrieves the gradient for a service, handling case-insensitivity
 * and falling back to Prowlarr's gradient for unknown services.
 *
 * @param service - Service name (case-insensitive): "sonarr", "radarr", "prowlarr"
 * @returns ServiceGradient object with from, to, and glow colors
 *
 * @example
 * ```tsx
 * // In a component receiving service type from props/data
 * const gradient = getServiceGradient(instance.service);
 *
 * <div style={{
 *   background: `linear-gradient(135deg, ${gradient.from}, ${gradient.to})`,
 *   boxShadow: `0 4px 20px -4px ${gradient.glow}`
 * }} />
 * ```
 */
export function getServiceGradient(service: string): ServiceGradient {
	const serviceKey = service.toLowerCase() as ServiceType;
	return SERVICE_GRADIENTS[serviceKey] ?? SERVICE_GRADIENTS.prowlarr;
}

/**
 * Semantic colors that remain constant across themes
 * Used for status indicators, alerts, etc.
 */
export const SEMANTIC_COLORS = {
	success: {
		from: "#22c55e",
		to: "#14b8a6",
		glow: "rgba(34, 197, 94, 0.4)",
		bg: "rgba(34, 197, 94, 0.1)",
		border: "rgba(34, 197, 94, 0.3)",
		text: "#4ade80",
	},
	warning: {
		from: "#f59e0b",
		to: "#eab308",
		glow: "rgba(245, 158, 11, 0.4)",
		bg: "rgba(245, 158, 11, 0.1)",
		border: "rgba(245, 158, 11, 0.3)",
		text: "#fbbf24",
	},
	error: {
		from: "#ef4444",
		to: "#f43f5e",
		glow: "rgba(239, 68, 68, 0.4)",
		bg: "rgba(239, 68, 68, 0.1)",
		border: "rgba(239, 68, 68, 0.3)",
		text: "#f87171",
	},
	info: {
		from: "#3b82f6",
		to: "#6366f1",
		glow: "rgba(59, 130, 246, 0.4)",
		bg: "rgba(59, 130, 246, 0.1)",
		border: "rgba(59, 130, 246, 0.3)",
		text: "#60a5fa",
	},
} as const;

/**
 * Brand colors for third-party services (ratings, external links)
 * Used for consistent styling of external service badges
 */
export const BRAND_COLORS = {
	imdb: {
		bg: "rgba(245, 197, 24, 0.1)",
		border: "rgba(245, 197, 24, 0.25)",
		text: "#f5c518",
	},
	rottenTomatoes: {
		bg: "rgba(93, 138, 58, 0.1)",
		border: "rgba(93, 138, 58, 0.25)",
		text: "#5d8a3a",
	},
	tmdb: {
		bg: "rgba(1, 210, 119, 0.1)",
		border: "rgba(1, 210, 119, 0.25)",
		text: "#01d277",
	},
	trakt: {
		bg: "rgba(237, 29, 36, 0.1)",
		border: "rgba(237, 29, 36, 0.25)",
		text: "#ed1d24",
	},
} as const;

/**
 * Protocol colors for indexer types
 * Uses service gradient colors for consistency
 */
export const PROTOCOL_COLORS = {
	torrent: SERVICE_GRADIENTS.radarr.from, // Orange - #f97316
	usenet: SERVICE_GRADIENTS.sonarr.from, // Cyan - #06b6d4
} as const;

/**
 * Star rating color (amber/gold)
 * Use SEMANTIC_COLORS.warning.text for consistency
 */
export const RATING_COLOR = SEMANTIC_COLORS.warning.text; // #fbbf24

/**
 * Helper to get theme-aware info colors (for badges, etc.)
 * Returns semantic colors for error/warning, theme colors for info
 */
export const getInfoColor = (
	severity: "info" | "warning" | "error" | "success",
	themeGradient: ThemeGradient
): { bg: string; border: string; text: string } => {
	if (severity === "info") {
		return {
			bg: themeGradient.fromLight,
			border: themeGradient.fromMuted,
			text: themeGradient.from,
		};
	}
	return {
		bg: SEMANTIC_COLORS[severity].bg,
		border: SEMANTIC_COLORS[severity].border,
		text: SEMANTIC_COLORS[severity].text,
	};
};

/**
 * Semantic color type for status indicators
 */
export type SemanticColorKey = keyof typeof SEMANTIC_COLORS;

// Note: useThemeGradient hook is defined in a separate file to avoid
// importing React in this utility module. See hooks/useThemeGradient.ts
