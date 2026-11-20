import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const candidate = fileURLToPath(new URL("../../", import.meta.url));
const specRoot = path.join(candidate, "e2e");
const ts = createRequire(path.join(candidate, "package.json"))("typescript");

function loadConfig(ci) {
	const filename = path.join(candidate, "playwright.config.ts");
	const result = ts.transpileModule(readFileSync(filename, "utf8"), {
		fileName: filename,
		reportDiagnostics: true,
		compilerOptions: {
			target: ts.ScriptTarget.ES2022,
			module: ts.ModuleKind.CommonJS,
			esModuleInterop: true,
		},
	});
	assert.equal(result.diagnostics?.length ?? 0, 0, "the real config must transpile");
	const exports = {};
	vm.runInNewContext(
		result.outputText,
		{
			exports,
			__dirname: candidate,
			process: { env: ci ? { CI: "true" } : {} },
			require(specifier) {
				if (specifier === "@playwright/test") {
					return { defineConfig: (config) => config, devices: { "Desktop Chrome": {} } };
				}
				if (specifier === "node:path") return path;
				// Never load local environment files while evaluating the config contract.
				if (specifier === "dotenv") return { config() {} };
				assert.fail(`unexpected config import: ${specifier}`);
			},
		},
		{ filename, timeout: 1_000 },
	);
	return exports.default;
}

for (const ci of [true, false]) {
	test(`${ci ? "CI" : "local"}: Chromium selects browser specs, not Node contracts or auth setup`, () => {
		const config = loadConfig(ci);
		const chromium = config.projects.find((project) => project.name === "chromium");
		assert.equal(typeof chromium?.testMatch, "string", "Chromium needs an explicit browser glob");
		const matches = (file) => path.matchesGlob(file, chromium.testMatch);
		const browserSpecs = readdirSync(specRoot).filter((file) => file.endsWith(".spec.ts"));
		assert.ok(browserSpecs.length > 0, "exercise real root browser specs");
		for (const file of browserSpecs) assert.ok(matches(file), `${file} must remain discoverable`);
		assert.ok(matches("future/nested/browser.spec.ts"), "do not freeze the current spec list");
		const nodeContracts = readdirSync(specRoot, { recursive: true }).filter((file) =>
			file.endsWith(".test.mjs"),
		);
		assert.ok(nodeContracts.length > 0, "exercise real Node contract paths");
		for (const file of nodeContracts) assert.equal(matches(file), false, `${file} is Node-only`);
		assert.equal(matches("auth.setup.ts"), false);
		const setup = config.projects.find((project) => project.name === "setup");
		assert.ok(setup.testMatch.test("auth.setup.ts"), "setup must retain its auth fixture");
		for (const file of browserSpecs) assert.equal(setup.testMatch.test(file), false);
		assert.ok(chromium.dependencies.includes("setup"));
	});
}
