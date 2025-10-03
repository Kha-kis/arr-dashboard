/**
 * Tailwind Preset - Design Tokens Integration
 *
 * Maps CSS custom properties to Tailwind utilities.
 * Import this in tailwind.config.ts to use semantic tokens via Tailwind classes.
 */

import type { Config } from "tailwindcss";

const preset: Partial<Config> = {
  theme: {
    extend: {
      colors: {
        // Semantic color system
        bg: {
          DEFAULT: "hsl(var(--color-bg) / <alpha-value>)",
          subtle: "hsl(var(--color-bg-subtle) / <alpha-value>)",
          muted: "hsl(var(--color-bg-muted) / <alpha-value>)",
          overlay: "hsl(var(--color-bg-overlay) / <alpha-value>)",
        },
        fg: {
          DEFAULT: "hsl(var(--color-fg) / <alpha-value>)",
          muted: "hsl(var(--color-fg-muted) / <alpha-value>)",
          subtle: "hsl(var(--color-fg-subtle) / <alpha-value>)",
        },
        primary: {
          DEFAULT: "hsl(var(--color-primary) / <alpha-value>)",
          hover: "hsl(var(--color-primary-hover) / <alpha-value>)",
          fg: "hsl(var(--color-primary-fg) / <alpha-value>)",
        },
        accent: {
          DEFAULT: "hsl(var(--color-accent) / <alpha-value>)",
          secondary: "hsl(var(--color-accent-secondary) / <alpha-value>)",
        },
        success: {
          DEFAULT: "hsl(var(--color-success) / <alpha-value>)",
          fg: "hsl(var(--color-success-fg) / <alpha-value>)",
        },
        warning: {
          DEFAULT: "hsl(var(--color-warning) / <alpha-value>)",
          fg: "hsl(var(--color-warning-fg) / <alpha-value>)",
        },
        danger: {
          DEFAULT: "hsl(var(--color-danger) / <alpha-value>)",
          fg: "hsl(var(--color-danger-fg) / <alpha-value>)",
        },
        info: {
          DEFAULT: "hsl(var(--color-info) / <alpha-value>)",
          fg: "hsl(var(--color-info-fg) / <alpha-value>)",
        },
        border: {
          DEFAULT: "hsl(var(--color-border) / <alpha-value>)",
          hover: "hsl(var(--color-border-hover) / <alpha-value>)",
          focus: "hsl(var(--color-border-focus) / <alpha-value>)",
        },
        ring: "hsl(var(--color-focus-ring) / <alpha-value>)",
      },
      spacing: {
        // Expose token spacing (most already match Tailwind defaults)
        0: "var(--space-0)",
        1: "var(--space-1)",
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
      borderRadius: {
        sm: "var(--radius-sm)",
        DEFAULT: "var(--radius-md)",
        md: "var(--radius-md)",
        lg: "var(--radius-lg)",
        xl: "var(--radius-xl)",
        "2xl": "var(--radius-2xl)",
        full: "var(--radius-full)",
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
        none: "var(--shadow-none)",
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
        linear: "var(--ease-linear)",
        in: "var(--ease-in)",
        out: "var(--ease-out)",
        "in-out": "var(--ease-in-out)",
      },
    },
  },
};

export default preset;
