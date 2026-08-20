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
//   - newly generated untracked files (including ignored output)
//   - obsolete or foreign tracked files (tracked, not produced by the generator)
//   - untracked foreign files
//   - file-mode drift
//
// Method: verify no pre-existing untracked or ignored files sit beneath the
// generated directory, validate every existing path component from the real
// repository root down to the generated directory (no symlink or junction may
// escape the repository), remove the generated directory, run the pinned
// generator to reconstruct it, then query Git for every difference beneath
// that directory relative to the index. A clean tree matches the index
// exactly.
//
// Pre-existing untracked or ignored files are never deleted: the guard reports
// them and refuses to run. Ignored files that the generator produces after the
// safe preflight are reported as missing from the committed exact tree.
//
// Usage: pnpm run check:prisma-generated
// Exit:  0 = reconstructed tree matches the index; 1 = drift detected,
//          pre-existing untracked files present, or generation failed.

import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, realpathSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// Forward-slash pathspec used for Git queries; Git always uses `/` regardless
// of the host OS. The filesystem path is derived from the same components via
// the host `path` module, so identity checks are separator-correct on Windows.
const GENERATED_REL = "apps/api/src/generated/prisma";
const GENERATED_PATH = path.resolve(REPO_ROOT, ...GENERATED_REL.split("/"));

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

// Platform-correct path validation. `pathImpl` is a node:path module
// (path.posix, path.win32, or the host default) so the same contract is
// exercised under every separator scheme, including on Linux CI. Validation is
// absolute-path identity after resolution, never a string comparison against a
// hard-coded separator style.
export function makePathValidator(pathImpl, repoRoot, generatedRel) {
	const generatedPath = pathImpl.resolve(repoRoot, ...generatedRel.split("/"));

	// Resolve a path and verify it stays inside the repository root. Returns
	// the absolute, normalized path.
	function assertInsideRepo(target) {
		const abs = pathImpl.resolve(target);
		const rel = pathImpl.relative(repoRoot, abs);
		if (rel === "") {
			throw new Error(`Refusing to operate on repository root: ${abs}`);
		}
		if (
			pathImpl.isAbsolute(rel) ||
			rel.startsWith("..") ||
			pathImpl.resolve(repoRoot, rel) !== abs
		) {
			throw new Error(`Refusing to operate on path outside repository: ${abs}`);
		}
		return abs;
	}

	// Verify the target resolves to the expected generated directory. Refuses
	// empty paths, the repository root, paths outside the repository, and any
	// path that is not exactly the expected generated directory.
	function validateGeneratedPath(target) {
		if (typeof target !== "string" || target === "") {
			throw new Error("Generated directory path is empty; refusing to remove");
		}
		const abs = assertInsideRepo(target);
		if (abs !== generatedPath) {
			throw new Error(
				`Resolved path ${abs} does not match expected generated directory ${generatedPath}`,
			);
		}
		return abs;
	}

	return { generatedPath, assertInsideRepo, validateGeneratedPath };
}

const validator = makePathValidator(path, REPO_ROOT, GENERATED_REL);

// Filesystem-boundary validation. `pathImpl` is the host path module (or a
// testable equivalent) and `fsOps` supplies realpathSync/lstatSync/existsSync.
// The trust boundary is the real (symlink-resolved) repository root; every
// existing component beneath it is inspected with lstat so that no symbolic
// link or Windows junction in an ancestor can redirect recursive removal
// outside the repository.
export function makeDeletionBoundaryValidator(pathImpl, repoRoot, generatedRel, fsOps) {
	const components = generatedRel.split("/");
	const realRoot = fsOps.realpathSync(repoRoot);

	function assertBoundary() {
		let current = realRoot;
		let lastExisting = realRoot;
		for (const component of components) {
			current = pathImpl.join(current, component);
			if (!fsOps.existsSync(current)) {
				break;
			}
			const st = fsOps.lstatSync(current);
			if (st.isSymbolicLink()) {
				throw new Error(`Refusing to remove through symbolic link: ${current}`);
			}
			if (!st.isDirectory()) {
				throw new Error(`Expected directory at ${current}, found a non-directory`);
			}
			lastExisting = current;
		}
		// Real-path containment of the nearest existing ancestor: even after
		// rejecting symlinks at every component, confirm the real path stays
		// beneath the real repository root.
		const realExisting = fsOps.realpathSync(lastExisting);
		const rel = pathImpl.relative(realRoot, realExisting);
		if (rel === "" || pathImpl.isAbsolute(rel) || rel.startsWith("..")) {
			throw new Error(`Resolved path escapes repository root: ${realExisting}`);
		}
		return { realRoot, lastExisting };
	}

	return { assertBoundary, realRoot };
}

const fsOps = { existsSync, lstatSync, realpathSync };
const deletionBoundary = makeDeletionBoundaryValidator(path, REPO_ROOT, GENERATED_REL, fsOps);

// Refuse to remove anything that is missing, a symbolic link, or not a
// directory. Uses lstat so a symlink (including one pointing at a directory)
// is never followed during recursive deletion.
export function assertSafeRemoval(abs, ops = fsOps) {
	if (!ops.existsSync(abs)) {
		return;
	}
	const st = ops.lstatSync(abs);
	if (st.isSymbolicLink()) {
		throw new Error(`Refusing to remove symbolic link: ${abs}`);
	}
	if (!st.isDirectory()) {
		throw new Error(`Expected directory at ${abs}, found a non-directory`);
	}
}

// Safely remove the generated output directory after path-safety checks.
function removeGeneratedDir() {
	const abs = validator.validateGeneratedPath(GENERATED_PATH);
	deletionBoundary.assertBoundary();
	assertSafeRemoval(abs);
	rmSync(abs, { recursive: true, force: true });
}

// Untracked, non-ignored files beneath the generated directory.
function untrackedFiles(gitRun, pathspec) {
	const out = gitRun(["ls-files", "--others", "--exclude-standard", "-z", "--", pathspec]);
	return out.split("\0").filter(Boolean);
}

// Untracked files that are also ignored, beneath the generated directory.
function ignoredUntrackedFiles(gitRun, pathspec) {
	const out = gitRun([
		"ls-files",
		"--others",
		"--ignored",
		"--exclude-standard",
		"-z",
		"--",
		pathspec,
	]);
	return out.split("\0").filter(Boolean);
}

// Tracked differences between the working tree and the index beneath the
// generated directory, via `git diff --name-status -z`. Returns modified and
// deleted path lists. Deleted paths are committed files the generator no
// longer produces (obsolete or foreign tracked files).
function trackedDrift(gitRun, pathspec) {
	const out = gitRun(["diff", "--name-status", "-z", "--", pathspec]);
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
function modeDrift(gitRun, pathspec) {
	const out = gitRun(["diff", "--summary", "--", pathspec]);
	const modePaths = new Set();
	for (const line of out.split("\n")) {
		if (/^\s*mode change\s/.test(line)) {
			const changedPath = line.trim().split(/\s+/).pop();
			if (changedPath) {
				modePaths.add(changedPath);
			}
		}
	}
	return modePaths;
}

// All post-generation difference categories beneath the generated directory,
// including ignored output the generator produced after the safe preflight.
// `gitRun` executes git in the repository (injectable for tests).
export function collectPostGenerationDrift(gitRun, pathspec) {
	const { modified, deleted } = trackedDrift(gitRun, pathspec);
	const modePaths = modeDrift(gitRun, pathspec);
	const untracked = untrackedFiles(gitRun, pathspec);
	const ignored = ignoredUntrackedFiles(gitRun, pathspec);
	return { modified, deleted, modePaths, untracked, ignored };
}

function main() {
	if (!existsSync(REPO_ROOT)) {
		console.error(`::error::Repository root not found: ${REPO_ROOT}`);
		process.exit(1);
	}

	// Pre-deletion preflight: refuse to destroy pre-existing untracked or
	// ignored files. Nothing is removed and generation is not run.
	const preExisting = untrackedFiles(git, `${GENERATED_REL}/`);
	const preIgnored = ignoredUntrackedFiles(git, `${GENERATED_REL}/`);
	if (preExisting.length > 0 || preIgnored.length > 0) {
		console.error("::error::Pre-existing untracked files block the generated-client check.");
		console.error(
			"::error::The guard refuses to delete files that are not tracked by Git. Remove or commit them first:",
		);
		for (const filePath of preExisting) {
			console.error(`  untracked: ${filePath}`);
		}
		for (const filePath of preIgnored) {
			console.error(`  ignored:   ${filePath}`);
		}
		console.error("::error::No files were removed and generation was not run.");
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

	const { modified, deleted, modePaths, untracked, ignored } = collectPostGenerationDrift(
		git,
		`${GENERATED_REL}/`,
	);

	const drift = [...modified, ...deleted, ...untracked, ...ignored];
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
	for (const filePath of modified) {
		if (modePaths.has(filePath)) {
			console.error(`  mode:      ${filePath}`);
		} else {
			console.error(`  modified:  ${filePath}`);
		}
	}
	for (const filePath of deleted) {
		console.error(`  deleted:   ${filePath}`);
	}
	for (const filePath of untracked) {
		console.error(`  untracked: ${filePath}`);
	}
	for (const filePath of ignored) {
		console.error(`  ignored:   ${filePath}`);
	}
	process.exit(1);
}

const isEntryPoint =
	process.argv[1] !== undefined &&
	import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isEntryPoint) {
	main();
}
