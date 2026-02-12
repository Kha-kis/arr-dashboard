import nextPlugin from "@next/eslint-plugin-next";
import reactPlugin from "eslint-plugin-react";
import hooksPlugin from "eslint-plugin-react-hooks";
import unusedImports from "eslint-plugin-unused-imports";
import tseslint from "@typescript-eslint/eslint-plugin";
import tsParser from "@typescript-eslint/parser";
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

			// TypeScript rules (relaxed for now)
			"@typescript-eslint/no-explicit-any": "off",

			// Unused imports - auto-fixable
			"unused-imports/no-unused-imports": "warn",
			"unused-imports/no-unused-vars": [
				"warn",
				{
					vars: "all",
					varsIgnorePattern: "^_",
					args: "after-used",
					argsIgnorePattern: "^_",
				},
			],
			"@typescript-eslint/no-unused-vars": "off", // Handled by unused-imports
		},
	},
];

export default eslintConfig;
