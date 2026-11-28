import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		include: ["src/lib/provider-observation/__tests__/*.properties.ts"],
	},
});
