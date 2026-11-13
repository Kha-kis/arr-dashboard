#!/usr/bin/env node
// Build-only staging. Never invoked by container startup or connected to a DB.
const {
	readFileSync,
	writeFileSync,
	mkdirSync,
	copyFileSync,
	chmodSync,
	lstatSync,
	readdirSync,
	symlinkSync,
} = require("node:fs");
const { spawnSync } = require("node:child_process");
const { join, resolve } = require("node:path");
const {
	validateProviderRuntime,
	collectPackageFiles,
	schemaProvider,
	hash,
} = require("./validate-provider-runtime.cjs");

function copyTree(source, destination) {
	const stat = lstatSync(source);
	if (stat.isSymbolicLink()) throw new Error("Build input must be a regular file or directory.");
	if (stat.isDirectory()) {
		mkdirSync(destination, { mode: 0o755 });
		for (const name of readdirSync(source)) copyTree(join(source, name), join(destination, name));
	} else if (stat.isFile()) {
		copyFileSync(source, destination);
		chmodSync(destination, 0o644);
	} else throw new Error("Unsupported build input.");
}

function stageProviderRuntime(project, deployment, provider) {
	if (!["sqlite", "postgresql"].includes(provider)) throw new Error("Unsupported build provider.");
	const projectRoot = resolve(project),
		deployRoot = resolve(deployment);
	if (
		projectRoot === deployRoot ||
		schemaProvider(readFileSync(join(projectRoot, "prisma/schema.prisma"), "utf8")) !== provider
	)
		throw new Error("Provider build input is inconsistent.");
	const parent = join(deployRoot, "providers");
	mkdirSync(parent, { recursive: true, mode: 0o755 });
	const output = join(parent, provider);
	mkdirSync(output, { mode: 0o755 }); // Refuse an existing/partial output, never replace it.
	for (const name of ["dist", "prisma"]) copyTree(join(projectRoot, name), join(output, name));
	mkdirSync(join(output, "src/generated"), { recursive: true, mode: 0o755 });
	copyTree(join(projectRoot, "src/generated/prisma"), join(output, "src/generated/prisma"));
	for (const name of ["package.json", "version.json"])
		copyTree(join(deployRoot, name), join(output, name));
	copyTree(join(projectRoot, "prisma.config.ts"), join(output, "prisma.config.ts"));
	writeFileSync(
		join(output, "tsconfig.json"),
		'{"compilerOptions":{"target":"ES2022","module":"ESNext","moduleResolution":"Bundler","esModuleInterop":true,"skipLibCheck":true}}\n',
		{ flag: "wx", mode: 0o644 },
	);
	symlinkSync("../../node_modules", join(output, "node_modules"));
	const prismaVersion = JSON.parse(
		readFileSync(join(deployRoot, "node_modules/@prisma/client/package.json"), "utf8"),
	).version;
	const files = Object.fromEntries(
		collectPackageFiles(output).map((name) => [name, hash(readFileSync(join(output, name)))]),
	);
	writeFileSync(
		join(output, "runtime-provider.json"),
		`${JSON.stringify({ version: 1, provider, prismaVersion, files })}\n`,
		{ flag: "wx", mode: 0o644 },
	);
	validateProviderRuntime(output, provider);
	return output;
}

function buildProviderRuntimes(project, deployment) {
	const projectRoot = resolve(project),
		schemaFile = join(projectRoot, "prisma/schema.prisma");
	const original = readFileSync(schemaFile, "utf8");
	if (schemaProvider(original) !== "sqlite")
		throw new Error("Canonical build input must use SQLite.");
	stageProviderRuntime(projectRoot, deployment, "sqlite");
	try {
		const changed = original.replace(
			/(datasource\s+db\s*\{[^}]*\bprovider\s*=\s*)"sqlite"/,
			'$1"postgresql"',
		);
		if (changed === original || schemaProvider(changed) !== "postgresql")
			throw new Error("Provider build schema could not be prepared.");
		writeFileSync(schemaFile, changed);
		// This synthetic, unreachable URL is only generation input. No DB command.
		const env = {
			...process.env,
			DATABASE_URL: "postgresql://build:build@127.0.0.1:1/unused_build",
			CHECKPOINT_DISABLE: "1",
		};
		for (const args of [
			["exec", "prisma", "generate", "--schema", "prisma/schema.prisma"],
			["run", "build"],
		]) {
			const run = spawnSync("pnpm", args, { cwd: projectRoot, env, stdio: "inherit" });
			if (run.error || run.status !== 0)
				throw new Error("Provider generation or compilation failed.");
		}
		stageProviderRuntime(projectRoot, deployment, "postgresql");
	} finally {
		writeFileSync(schemaFile, original);
	}
}

module.exports = { stageProviderRuntime, buildProviderRuntimes };
if (require.main === module) {
	try {
		if (process.argv.length !== 4)
			throw new Error("Explicit build project and deployment required.");
		buildProviderRuntimes(process.argv[2], process.argv[3]);
	} catch {
		process.stderr.write("Provider runtime build did not complete.\n");
		process.exitCode = 1;
	}
}
