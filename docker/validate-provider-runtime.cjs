#!/usr/bin/env node
// Read-only admission for one build-produced provider package. No database I/O.
const {
	constants,
	openSync,
	fstatSync,
	readFileSync,
	closeSync,
	lstatSync,
	readdirSync,
	readlinkSync,
} = require("node:fs");
const { createHash } = require("node:crypto");
const { join, resolve, dirname, basename } = require("node:path");

const required = [
	"package.json",
	"version.json",
	"tsconfig.json",
	"prisma.config.ts",
	"prisma/schema.prisma",
	"src/generated/prisma/client.ts",
	"dist/index.js",
	"dist/launcher.js",
	"dist/schema-startup.js",
	"dist/combined-startup.js",
	"dist/lib/jellyfin/jellyfin-episode-finalizer-worker.js",
	"dist/lib/jellyfin/jellyfin-episode-page-worker.js",
	"prisma/runtime-schema/sqlite-v1.sql",
	"prisma/runtime-schema/postgresql-v1.sql",
	"prisma/runtime-schema/registry-sqlite-v1.json",
	"prisma/runtime-schema/registry-postgresql-v1.json",
];
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const refuse = () => {
	throw new Error("Provider runtime package is unavailable.");
};

function readRegular(path) {
	const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
	try {
		const stat = fstatSync(fd);
		if (!stat.isFile() || stat.size > 32 * 1024 * 1024 || stat.mode & 0o022) refuse();
		return readFileSync(fd);
	} finally {
		closeSync(fd);
	}
}

function collectPackageFiles(root) {
	const files = [];
	function visit(directory, prefix = "") {
		const stat = lstatSync(directory);
		if (!stat.isDirectory() || stat.isSymbolicLink() || stat.mode & 0o022) refuse();
		for (const name of readdirSync(directory)) {
			if (!prefix && ["runtime-provider.json", "node_modules"].includes(name)) continue;
			const path = join(directory, name),
				relative = prefix + name;
			const entry = lstatSync(path);
			if (entry.isSymbolicLink() || entry.mode & 0o022) refuse();
			if (entry.isDirectory()) visit(path, `${relative}/`);
			else if (entry.isFile()) {
				files.push(relative);
				if (files.length > 2048) refuse();
			} else refuse();
		}
	}
	visit(root);
	return files.sort();
}

function schemaProvider(schema) {
	const blocks = [...schema.matchAll(/datasource\s+db\s*\{([^}]+)\}/g)];
	if (blocks.length !== 1) refuse();
	const values = [...blocks[0][1].matchAll(/\bprovider\s*=\s*"(sqlite|postgresql)"/g)];
	if (values.length !== 1) refuse();
	return values[0][1];
}

function validateProviderRuntime(directory, provider) {
	try {
		if (!["sqlite", "postgresql"].includes(provider)) refuse();
		const root = resolve(directory);
		if (basename(root) !== provider || basename(dirname(root)) !== "providers") refuse();
		for (const directory of [root, dirname(root), dirname(dirname(root))]) {
			const stat = lstatSync(directory);
			if (!stat.isDirectory() || stat.isSymbolicLink() || stat.mode & 0o022) refuse();
		}
		const document = JSON.parse(readRegular(join(root, "runtime-provider.json")));
		if (
			!document ||
			Array.isArray(document) ||
			Object.keys(document).sort().join(",") !== "files,prismaVersion,provider,version" ||
			document.version !== 1 ||
			document.provider !== provider ||
			typeof document.prismaVersion !== "string" ||
			!document.files ||
			Array.isArray(document.files) ||
			typeof document.files !== "object"
		)
			refuse();
		const names = Object.keys(document.files).sort();
		if (!names.length || names.length > 2048) refuse();
		for (const name of names) {
			if (
				name.includes("\\") ||
				name.includes("\0") ||
				name.split("/").some((part) => !part || part === "." || part === "..") ||
				(!name.startsWith("dist/") &&
					!name.startsWith("prisma/") &&
					!name.startsWith("src/generated/prisma/") &&
					!required.includes(name)) ||
				!/^[a-f0-9]{64}$/.test(document.files[name])
			)
				refuse();
		}
		if (
			required.some((name) => !names.includes(name)) ||
			JSON.stringify(collectPackageFiles(root)) !== JSON.stringify(names)
		)
			refuse();
		const dependencyLink = join(root, "node_modules");
		if (
			!lstatSync(dependencyLink).isSymbolicLink() ||
			readlinkSync(dependencyLink) !== "../../node_modules"
		)
			refuse();
		const shared = lstatSync(resolve(root, "../../node_modules"));
		if (!shared.isDirectory() || shared.isSymbolicLink() || shared.mode & 0o022) refuse();
		const client = JSON.parse(
			readFileSync(join(dependencyLink, "@prisma/client/package.json"), "utf8"),
		);
		if (client.version !== document.prismaVersion) refuse();
		let configs = 0;
		for (const name of names) {
			const bytes = readRegular(join(root, name));
			if (hash(bytes) !== document.files[name]) refuse();
			if (name === "prisma/schema.prisma" && schemaProvider(bytes.toString("utf8")) !== provider)
				refuse();
			if (!name.startsWith("dist/") || !name.endsWith(".js")) continue;
			const text = bytes.toString("utf8");
			const count = (value) => text.split(value).length - 1;
			const other = provider === "sqlite" ? "postgresql" : "sqlite";
			const active = count(`"activeProvider": "${provider}"`);
			const schema = count(`provider = "${provider}"`);
			const compilers = count(`query_compiler_fast_bg.${provider}.`);
			const wrong =
				count(`"activeProvider": "${other}"`) +
				count(`provider = "${other}"`) +
				count(`query_compiler_fast_bg.${other}.`);
			if (!(active + schema + compilers + wrong)) continue;
			if (
				active !== 1 ||
				schema !== 1 ||
				compilers !== 2 ||
				wrong !== 0 ||
				count(`"clientVersion": "${document.prismaVersion}"`) !== 1
			)
				refuse();
			configs++;
		}
		if (configs !== 1) refuse();
	} catch {
		refuse();
	}
}

module.exports = { validateProviderRuntime, collectPackageFiles, schemaProvider, hash };
if (require.main === module) {
	try {
		if (process.argv.length !== 4) refuse();
		validateProviderRuntime(process.argv[2], process.argv[3]);
	} catch {
		process.stderr.write("Provider runtime package is unavailable.\n");
		process.exitCode = 1;
	}
}
