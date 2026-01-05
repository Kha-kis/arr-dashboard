/**
 * Centralized Theme Gradients System
 *
 * This module provides consistent theme-aware gradient colors across the entire app.
 * Instead of defining THEME_GRADIENTS in each component, import from here.
 *
 * ## Basic Usage:
 * ```tsx
 * import { THEME_GRADIENTS } from "../../../lib/theme-gradients";
 * import { useColorTheme } from "../../../providers/color-theme-provider";
 *
 * const { colorTheme } = useColorTheme();
 * const themeGradient = THEME_GRADIENTS[colorTheme];
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
 *   className="border border-border bg-bg-subtle focus:outline-none"
 *   style={getSelectStyle("mySelect")}
 *   onFocus={() => setFocusedSelect("mySelect")}
 *   onBlur={() => setFocusedSelect(null)}
 * />
 * ```
 *
 * ## Pattern: Theme-Aware Hover Links
 * ```tsx
 * <a
 *   className="text-fg-muted transition-colors"
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
 * Master theme gradient definitions
 *
 * These colors are carefully chosen to:
 * 1. Create smooth gradients between 'from' and 'to'
 * 2. Work well in both light and dark modes
 * 3. Maintain WCAG contrast ratios for text
 * 4. Provide pleasing glow effects
 */
export const THEME_GRADIENTS: Record<ColorTheme, ThemeGradient> = {
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
};

/**
 * Service-specific gradients for visual distinction
 * These maintain service identity regardless of user's color theme
 */
export const SERVICE_GRADIENTS = {
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
} as const;

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
 * Helper function to create CSS gradient strings
 */
export const createGradient = (
	gradient: Pick<ThemeGradient, "from" | "to">,
	direction: "linear" | "radial" = "linear",
	angle = 135
): string => {
	if (direction === "radial") {
		return `radial-gradient(ellipse at center, ${gradient.from}, ${gradient.to})`;
	}
	return `linear-gradient(${angle}deg, ${gradient.from}, ${gradient.to})`;
};

/**
 * Helper function to create glow box-shadow
 */
export const createGlow = (
	glow: string,
	intensity: "subtle" | "medium" | "strong" = "medium"
): string => {
	const blur = { subtle: 12, medium: 20, strong: 32 };
	const spread = { subtle: -4, medium: -4, strong: -8 };
	return `0 4px ${blur[intensity]}px ${spread[intensity]}px ${glow}`;
};

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

// Note: useThemeGradient hook is defined in a separate file to avoid
// importing React in this utility module. See hooks/useThemeGradient.ts
