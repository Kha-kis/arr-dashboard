import path from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
	plugins: [react()],
	test: {
		environment: "jsdom",
		globals: true,
		setupFiles: ["./vitest.setup.ts"],
		include: [
			"src/**/*.{test,spec}.{ts,tsx}",
			// `app/` route tests live next to their route components (e.g.
			// `app/__tests__/page.test.tsx` for the root `/` route).
			"app/**/*.{test,spec}.{ts,tsx}",
		],
		coverage: {
			provider: "v8",
			reporter: ["text", "json", "html"],
			include: ["src/**/*.{ts,tsx}"],
			exclude: ["src/**/*.test.{ts,tsx}", "src/**/*.spec.{ts,tsx}"],
		},
	},
	resolve: {
		alias: {
			"@": path.resolve(__dirname, "./src"),
			"@arr/shared": path.resolve(__dirname, "../../packages/shared/src"),
		},
	},
});
