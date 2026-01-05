/**
 * Tailwind Preset - shadcn/ui Compatible Design Tokens
 *
 * Maps CSS custom properties to Tailwind utilities.
 * Token naming follows shadcn/ui conventions for component compatibility.
 */

import type { Config } from "tailwindcss";
import plugin from "tailwindcss/plugin";

const preset: Partial<Config> = {
	theme: {
		extend: {
			fontFamily: {
				// Display font - Satoshi for headings and brand
				display: ["var(--font-display)", "system-ui", "sans-serif"],
				// Body font - DM Sans for UI and content
				body: ["var(--font-body)", "system-ui", "sans-serif"],
				// Mono font for code
				mono: ["ui-monospace", "SFMono-Regular", "Consolas", "monospace"],
			},
			colors: {
				// shadcn/ui standard tokens
				background: "hsl(var(--background) / <alpha-value>)",
				foreground: "hsl(var(--foreground) / <alpha-value>)",
				card: {
					DEFAULT: "hsl(var(--card) / <alpha-value>)",
					foreground: "hsl(var(--card-foreground) / <alpha-value>)",
				},
				popover: {
					DEFAULT: "hsl(var(--popover) / <alpha-value>)",
					foreground: "hsl(var(--popover-foreground) / <alpha-value>)",
				},
				primary: {
					DEFAULT: "hsl(var(--primary) / <alpha-value>)",
					foreground: "hsl(var(--primary-foreground) / <alpha-value>)",
				},
				secondary: {
					DEFAULT: "hsl(var(--secondary) / <alpha-value>)",
					foreground: "hsl(var(--secondary-foreground) / <alpha-value>)",
				},
				muted: {
					DEFAULT: "hsl(var(--muted) / <alpha-value>)",
					foreground: "hsl(var(--muted-foreground) / <alpha-value>)",
				},
				accent: {
					DEFAULT: "hsl(var(--accent) / <alpha-value>)",
					foreground: "hsl(var(--accent-foreground) / <alpha-value>)",
				},
				destructive: {
					DEFAULT: "hsl(var(--destructive) / <alpha-value>)",
					foreground: "hsl(var(--destructive-foreground) / <alpha-value>)",
				},
				// Semantic status colors (arr-dashboard custom)
				success: {
					DEFAULT: "hsl(var(--success) / <alpha-value>)",
					foreground: "hsl(var(--success-foreground) / <alpha-value>)",
				},
				warning: {
					DEFAULT: "hsl(var(--warning) / <alpha-value>)",
					foreground: "hsl(var(--warning-foreground) / <alpha-value>)",
				},
				info: {
					DEFAULT: "hsl(var(--info) / <alpha-value>)",
					foreground: "hsl(var(--info-foreground) / <alpha-value>)",
				},
				// Borders and inputs
				border: "hsl(var(--border) / <alpha-value>)",
				input: "hsl(var(--input) / <alpha-value>)",
				ring: "hsl(var(--ring) / <alpha-value>)",
				// Chart colors
				chart: {
					1: "hsl(var(--chart-1) / <alpha-value>)",
					2: "hsl(var(--chart-2) / <alpha-value>)",
					3: "hsl(var(--chart-3) / <alpha-value>)",
					4: "hsl(var(--chart-4) / <alpha-value>)",
					5: "hsl(var(--chart-5) / <alpha-value>)",
				},
				// Sidebar colors
				sidebar: {
					DEFAULT: "hsl(var(--sidebar) / <alpha-value>)",
					foreground: "hsl(var(--sidebar-foreground) / <alpha-value>)",
					primary: "hsl(var(--sidebar-primary) / <alpha-value>)",
					"primary-foreground":
						"hsl(var(--sidebar-primary-foreground) / <alpha-value>)",
					accent: "hsl(var(--sidebar-accent) / <alpha-value>)",
					"accent-foreground":
						"hsl(var(--sidebar-accent-foreground) / <alpha-value>)",
					border: "hsl(var(--sidebar-border) / <alpha-value>)",
					ring: "hsl(var(--sidebar-ring) / <alpha-value>)",
				},
			},
			borderRadius: {
				lg: "var(--radius)",
				md: "calc(var(--radius) - 2px)",
				sm: "calc(var(--radius) - 4px)",
			},
			spacing: {
				0: "var(--space-0)",
				1: "var(--space-1)",
				"1.5": "var(--space-1-5)",
				2: "var(--space-2)",
				3: "var(--space-3)",
				4: "var(--space-4)",
				5: "var(--space-5)",
				6: "var(--space-6)",
				8: "var(--space-8)",
				10: "var(--space-10)",
				12: "var(--space-12)",
				16: "var(--space-16)",
				20: "var(--space-20)",
				24: "var(--space-24)",
			},
			fontSize: {
				xs: ["var(--text-xs)", { lineHeight: "var(--leading-normal)" }],
				sm: ["var(--text-sm)", { lineHeight: "var(--leading-normal)" }],
				base: ["var(--text-base)", { lineHeight: "var(--leading-normal)" }],
				lg: ["var(--text-lg)", { lineHeight: "var(--leading-normal)" }],
				xl: ["var(--text-xl)", { lineHeight: "var(--leading-normal)" }],
				"2xl": ["var(--text-2xl)", { lineHeight: "var(--leading-tight)" }],
				"3xl": ["var(--text-3xl)", { lineHeight: "var(--leading-tight)" }],
				"4xl": ["var(--text-4xl)", { lineHeight: "var(--leading-tight)" }],
			},
			fontWeight: {
				normal: "var(--font-normal)",
				medium: "var(--font-medium)",
				semibold: "var(--font-semibold)",
				bold: "var(--font-bold)",
			},
			lineHeight: {
				none: "var(--leading-none)",
				tight: "var(--leading-tight)",
				snug: "var(--leading-snug)",
				normal: "var(--leading-normal)",
				relaxed: "var(--leading-relaxed)",
				loose: "var(--leading-loose)",
			},
			boxShadow: {
				sm: "var(--shadow-sm)",
				DEFAULT: "var(--shadow-md)",
				md: "var(--shadow-md)",
				lg: "var(--shadow-lg)",
				xl: "var(--shadow-xl)",
				primary: "var(--shadow-primary)",
				accent: "var(--shadow-accent)",
			},
			zIndex: {
				dropdown: "var(--z-dropdown)",
				sticky: "var(--z-sticky)",
				fixed: "var(--z-fixed)",
				"modal-backdrop": "var(--z-modal-backdrop)",
				modal: "var(--z-modal)",
				popover: "var(--z-popover)",
				toast: "var(--z-toast)",
				tooltip: "var(--z-tooltip)",
			},
			transitionDuration: {
				fast: "var(--duration-fast)",
				DEFAULT: "var(--duration-normal)",
				normal: "var(--duration-normal)",
				slow: "var(--duration-slow)",
				slower: "var(--duration-slower)",
			},
			transitionTimingFunction: {
				DEFAULT: "var(--ease-standard)",
				in: "var(--ease-in)",
				out: "var(--ease-out)",
				bounce: "var(--ease-bounce)",
			},
		},
	},
	plugins: [
		plugin(({ addUtilities }) => {
			addUtilities({
				// Semantic typography utilities with display font for headings
				".text-h1": {
					fontFamily: "var(--font-display), system-ui, sans-serif",
					fontSize: "var(--text-3xl)",
					lineHeight: "var(--leading-tight)",
					fontWeight: "var(--font-bold)",
					letterSpacing: "-0.025em",
				},
				".text-h2": {
					fontFamily: "var(--font-display), system-ui, sans-serif",
					fontSize: "var(--text-2xl)",
					lineHeight: "var(--leading-tight)",
					fontWeight: "var(--font-bold)",
					letterSpacing: "-0.02em",
				},
				".text-h3": {
					fontFamily: "var(--font-display), system-ui, sans-serif",
					fontSize: "var(--text-xl)",
					lineHeight: "var(--leading-normal)",
					fontWeight: "var(--font-semibold)",
					letterSpacing: "-0.015em",
				},
				".text-h4": {
					fontFamily: "var(--font-display), system-ui, sans-serif",
					fontSize: "var(--text-lg)",
					lineHeight: "var(--leading-normal)",
					fontWeight: "var(--font-semibold)",
					letterSpacing: "-0.01em",
				},
				".text-body": {
					fontSize: "var(--text-base)",
					lineHeight: "var(--leading-normal)",
					fontWeight: "var(--font-normal)",
				},
				".text-small": {
					fontSize: "var(--text-sm)",
					lineHeight: "var(--leading-normal)",
					fontWeight: "var(--font-normal)",
				},
				".text-caption": {
					fontSize: "var(--text-xs)",
					lineHeight: "var(--leading-normal)",
					fontWeight: "var(--font-normal)",
				},
				// Premium text utilities
				".text-overline": {
					fontSize: "var(--text-xs)",
					lineHeight: "var(--leading-normal)",
					fontWeight: "var(--font-medium)",
					letterSpacing: "0.1em",
					textTransform: "uppercase",
				},
				".text-display": {
					fontFamily: "var(--font-display), system-ui, sans-serif",
					fontSize: "var(--text-4xl)",
					lineHeight: "var(--leading-none)",
					fontWeight: "var(--font-bold)",
					letterSpacing: "-0.03em",
				},
			});
		}),
	],
};

export default preset;
