#!/usr/bin/env node
// Test fixture tooling only. Never copied into the production runtime image.
// Rebind deliberate service mocks without weakening production admission.
const {
	constants,
	closeSync,
	fstatSync,
	openSync,
	readFileSync,
	writeFileSync,
} = require("node:fs");
const { isAbsolute, relative, resolve } = require("node:path");
const { hash, validateProviderRuntime } = require("./validate-provider-runtime.cjs");

function createTestManifest(directory, provider, output, overrides) {
	validateProviderRuntime(directory, provider);
	const root = resolve(directory);
	const outputPath = resolve(output);
	const outputRelative = relative(root, outputPath);
	if (!outputRelative || (!outputRelative.startsWith("../") && !isAbsolute(outputRelative)))
		throw Error("Test manifest must remain outside the runtime package");
	const entries = Object.entries(overrides);
	if (!entries.length || entries.length > 2) throw Error("Expected controlled service mocks");
	const manifest = JSON.parse(readFileSync(resolve(root, "runtime-provider.json"), "utf8"));
	for (const [target, mock] of entries) {
		if (target !== "dist/index.js" && target !== "dist/launcher.js")
			throw Error("Unsupported mock target");
		const fd = openSync(mock, constants.O_RDONLY | constants.O_NOFOLLOW);
		try {
			const stat = fstatSync(fd);
			if (!stat.isFile() || stat.size > 4 * 1024 * 1024 || stat.mode & 0o022)
				throw Error("Unsafe mock input");
			manifest.files[target] = hash(readFileSync(fd));
		} finally {
			closeSync(fd);
		}
	}
	writeFileSync(outputPath, `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx", mode: 0o644 });
}

if (require.main === module) {
	try {
		const [directory, provider, output, ...pairs] = process.argv.slice(2);
		if (!directory || !provider || !output || !pairs.length || pairs.length % 2)
			throw Error("Arguments");
		const overrides = {};
		for (let index = 0; index < pairs.length; index += 2) {
			if (Object.hasOwn(overrides, pairs[index])) throw Error("Duplicate mock target");
			overrides[pairs[index]] = pairs[index + 1];
		}
		createTestManifest(directory, provider, output, overrides);
	} catch {
		process.stderr.write("Test-only provider manifest preparation refused.\n");
		process.exitCode = 1;
	}
}

module.exports = { createTestManifest };
