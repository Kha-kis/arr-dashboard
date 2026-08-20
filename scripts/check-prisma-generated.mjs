#!/usr/bin/env node
// Prisma generated-client exact-tree drift guard.
//
// Proves the complete tree beneath apps/api/src/generated/prisma is
// byte-for-byte and path-for-path identical to a fresh output produced by the
// pinned Prisma generator from the current schema.
//
// Detects:
//   - modified tracked generated files
//   - missing generated files (tracked, not produced by the generator)
//   - newly generated untracked files
//   - obsolete or foreign tracked files (tracked, not produced by the generator)
//   - untracked foreign files
//   - file-mode drift
//
// Method: remove the entire generated directory (after path-safety checks),
// run the pinned generator to reconstruct it, then query Git for every
// difference beneath that directory relative to the index. A clean tree
// matches the index exactly.
//
// Usage: pnpm run check:prisma-generated
// Exit:  0 = reconstructed tree matches the index; 1 = drift detected or
//          generation failed.

import { execFileSync } from "node:child_process";
import { rmSync, existsSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve, relative } from "node:path";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const GENERATED_DIR = "apps/api/src/generated/prisma";
const GENERATED_PATH = resolve(REPO_ROOT, GENERATED_DIR);

function git(args) {
	return execFileSync("git", args, { cwd: REPO_ROOT, encoding: "utf8" });
}

function runGenerate() {
	const cmd = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
	execFileSync(cmd, ["--filter", "@arr/api", "db:generate"], {
		cwd: REPO_ROOT,
		stdio: "inherit",
	});
}

// Resolve a path and verify it stays inside the repository root. Returns the
// absolute, normalized path.
function assertInsideRepo(target) {
	const abs = resolve(target);
	const rel = relative(REPO_ROOT, abs);
	if (rel === "") {
		throw new Error(`Refusing to operate on repository root: ${abs}`);
	}
	if (rel.startsWith("..") || resolve(REPO_ROOT, rel) !== abs) {
		throw new Error(`Refusing to operate on path outside repository: ${abs}`);
	}
	return abs;
}

// Safely remove the generated output directory. Refuses empty paths, the
// repository root, paths outside the repository, or any path that is not the
// expected generated directory.
function removeGeneratedDir() {
	if (GENERATED_DIR === "") {
		throw new Error("Generated directory path is empty; refusing to remove");
	}
	const abs = assertInsideRepo(GENERATED_PATH);
	if (relative(REPO_ROOT, abs) !== GENERATED_DIR) {
		throw new Error(
			`Resolved path ${abs} does not match expected generated directory ${GENERATED_DIR}`,
		);
	}
	if (!existsSync(abs)) {
		return;
	}
	if (!statSync(abs).isDirectory()) {
		throw new Error(`Expected directory at ${abs}, found a non-directory`);
	}
	rmSync(abs, { recursive: true, force: true });
}

// Tracked differences between the working tree and the index beneath the
// generated directory, via `git diff --name-status -z`. Returns modified and
// deleted path lists. Deleted paths are committed files the generator no
// longer produces (obsolete or foreign tracked files).
function trackedDrift() {
	const out = git(["diff", "--name-status", "-z", "--", `${GENERATED_DIR}/`]);
	const tokens = out.split("\0");
	const modified = [];
	const deleted = [];
	let i = 0;
	while (i < tokens.length) {
		const code = tokens[i];
		if (code === "") {
			i += 1;
			continue;
		}
		const status = code[0];
		if (status === "D") {
			deleted.push(tokens[i + 1]);
			i += 2;
		} else if (status === "R" || status === "C") {
			modified.push(tokens[i + 2]);
			i += 3;
		} else {
			modified.push(tokens[i + 1]);
			i += 2;
		}
	}
	return { modified, deleted };
}

// Paths with a file-mode change between the working tree and the index, from
// `git diff --summary`. These also appear as modified in trackedDrift().
function modeDrift() {
	const out = git(["diff", "--summary", "--", `${GENERATED_DIR}/`]);
	const modePaths = new Set();
	for (const line of out.split("\n")) {
		if (/^\s*mode change\s/.test(line)) {
			const path = line.trim().split(/\s+/).pop();
			if (path) {
				modePaths.add(path);
			}
		}
	}
	return modePaths;
}

// Untracked files beneath the generated directory.
function untrackedFiles() {
	const out = git([
		"ls-files",
		"--others",
		"--exclude-standard",
		"-z",
		"--",
		`${GENERATED_DIR}/`,
	]);
	return out.split("\0").filter(Boolean);
}

function main() {
	if (!existsSync(REPO_ROOT)) {
		console.error(`::error::Repository root not found: ${REPO_ROOT}`);
		process.exit(1);
	}

	try {
		removeGeneratedDir();
	} catch (err) {
		console.error(`::error::Refusing to remove generated directory: ${err.message}`);
		process.exit(1);
	}

	try {
		runGenerate();
	} catch {
		console.error("::error::Prisma generation failed after removing the generated directory.");
		console.error(
			"::error::The generated directory may need to be restored by rerunning the generator: `pnpm --filter @arr/api db:generate`",
		);
		process.exit(1);
	}

	const { modified, deleted } = trackedDrift();
	const modePaths = modeDrift();
	const untracked = untrackedFiles();

	const drift = [...modified, ...deleted, ...untracked];
	if (drift.length === 0) {
		console.log("Prisma generated client is up to date.");
		process.exit(0);
	}

	console.error("::error::The committed Prisma client is out of date.");
	console.error(
		`::error::Run \`pnpm --filter @arr/api db:generate\` and commit all changes under \`apps/api/src/generated/prisma\`.`,
	);
	console.error("");
	console.error("Affected generated paths:");
	for (const path of modified) {
		if (modePaths.has(path)) {
			console.error(`  mode:      ${path}`);
		} else {
			console.error(`  modified:  ${path}`);
		}
	}
	for (const path of deleted) {
		console.error(`  deleted:   ${path}`);
	}
	for (const path of untracked) {
		console.error(`  untracked: ${path}`);
	}
	process.exit(1);
}

main();