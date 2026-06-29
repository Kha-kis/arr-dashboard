import nextPlugin from "@next/eslint-plugin-next";
import tseslint from "@typescript-eslint/eslint-plugin";
import tsParser from "@typescript-eslint/parser";
import reactPlugin from "eslint-plugin-react";
import hooksPlugin from "eslint-plugin-react-hooks";
import unusedImports from "eslint-plugin-unused-imports";
import globals from "globals";

/** @type {import('eslint').Linter.Config[]} */
const eslintConfig = [
	{
		ignores: [
			"node_modules/**",
			".next/**",
			"out/**",
			"build/**",
			"coverage/**",
			"next-env.d.ts",
			"server.js",
		],
	},
	{
		files: ["**/*.{js,jsx,ts,tsx}"],
		plugins: {
			"@next/next": nextPlugin,
			"@typescript-eslint": tseslint,
			react: reactPlugin,
			"react-hooks": hooksPlugin,
			"unused-imports": unusedImports,
		},
		languageOptions: {
			parser: tsParser,
			parserOptions: {
				ecmaVersion: "latest",
				sourceType: "module",
				ecmaFeatures: {
					jsx: true,
				},
			},
			globals: {
				...globals.browser,
				...globals.node,
				React: "readonly",
			},
		},
		settings: {
			react: {
				version: "detect",
			},
		},
		rules: {
			// Next.js rules
			...nextPlugin.configs.recommended.rules,
			...nextPlugin.configs["core-web-vitals"].rules,

			// React rules
			"react/react-in-jsx-scope": "off",
			"react/prop-types": "off",
			"react/no-unescaped-entities": "warn",

			// React Hooks rules
			"react-hooks/rules-of-hooks": "error",
			"react-hooks/exhaustive-deps": "warn",

			// TypeScript rules
			"@typescript-eslint/no-explicit-any": "warn",

			// Console usage — use structured error handling, not console.log
			"no-console": ["warn", { allow: ["warn", "error"] }],

			// Hardcoded hex colors — use SEMANTIC_COLORS / BRAND_COLORS /
			// useThemeGradient() from lib/theme-gradients.ts instead (B2 sweep
			// follow-up). AST-based so issue numbers in comments (#474) never
			// false-positive. Palette-definition files are exempted below;
			// genuine one-offs need an eslint-disable with a reason.
			"no-restricted-syntax": [
				"error",
				{
					selector: "Literal[value=/#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})\\b/]",
					message:
						"Hardcoded hex color. Use SEMANTIC_COLORS / BRAND_COLORS or useThemeGradient() from lib/theme-gradients.ts. If this is a genuine carve-out, add an eslint-disable comment with the reason.",
				},
				{
					selector:
						"TemplateElement[value.raw=/#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})\\b/]",
					message:
						"Hardcoded hex color in template literal. Use SEMANTIC_COLORS / BRAND_COLORS or useThemeGradient() from lib/theme-gradients.ts. If this is a genuine carve-out, add an eslint-disable comment with the reason.",
				},
				// Charter §7 L4 — no arbitrary z-index. The semantic z-index scale
				// (z-dropdown..z-tooltip, 1000–2100 in globals.css) owns all GLOBAL
				// layering. A Tailwind `z-[100]`+ arbitrary value brute-forces its way
				// into that territory instead of using a semantic class. Scoped to 3+
				// digits so benign local stacking (z-[1], z-[2]) stays free.
				{
					selector: "Literal[value=/z-\\[\\d{3,}\\]/]",
					message:
						"Arbitrary z-index. Use a semantic z-index class (z-modal, z-toast, z-dropdown, …) instead of a hardcoded high value. Low local-stacking values (z-[1], z-[2]) are fine; if this large value is a genuine carve-out, add an eslint-disable comment with the reason.",
				},
				{
					selector: "TemplateElement[value.raw=/z-\\[\\d{3,}\\]/]",
					message:
						"Arbitrary z-index in template literal. Use a semantic z-index class (z-modal, z-toast, z-dropdown, …) instead of a hardcoded high value. Low local-stacking values (z-[1], z-[2]) are fine; if this large value is a genuine carve-out, add an eslint-disable comment with the reason.",
				},
			],

			// Unused imports - auto-fixable
			"unused-imports/no-unused-imports": "warn",
			"unused-imports/no-unused-vars": [
				"warn",
				{
					vars: "all",
					varsIgnorePattern: "^_",
					args: "after-used",
					argsIgnorePattern: "^_",
					caughtErrors: "all",
					caughtErrorsIgnorePattern: "^_",
				},
			],
			"@typescript-eslint/no-unused-vars": "off", // Handled by unused-imports
		},
	},
	{
		// Palette-definition files — these ARE the places hex colors belong:
		// theme-gradients is the token source itself; color-theme-provider
		// defines the theme palettes; queue-cleaner constants is a categorical
		// chart palette (9 distinct hues — semantic tokens would lose
		// distinguishability); appearance-preview fakes browser chrome
		// (charter carve-out).
		files: [
			"tailwind.config.ts",
			"src/lib/theme-gradients.ts",
			"src/providers/color-theme-provider.tsx",
			"src/features/queue-cleaner/lib/constants.ts",
			"src/features/settings/components/appearance-preview.tsx",
			// Tests stub theme-gradient objects with literal colors
			"**/__tests__/**",
			"**/*.test.{ts,tsx}",
		],
		rules: {
			"no-restricted-syntax": "off",
		},
	},
];

export default eslintConfig;
