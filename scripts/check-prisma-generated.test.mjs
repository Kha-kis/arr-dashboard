// Focused tests for the Prisma generated-client guard's path-safety helpers.
//
// Exercises the Windows separator contract through path.win32 and path.posix
// so the same matrix runs on Linux CI and on native Windows Node. Run with:
//
//   node --test scripts/check-prisma-generated.test.mjs

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, posix, win32 } from "node:path";
import { test } from "node:test";
import { assertSafeRemoval, makePathValidator } from "./check-prisma-generated.mjs";

const GENERATED_REL = "apps/api/src/generated/prisma";

// Skip symlink cases on hosts that cannot create symlinks (e.g. Windows
// without Developer Mode / admin privileges). The lstat-based symlink guard is
// platform-agnostic and still exercised on Linux CI.
function symlinksUnsupported() {
	try {
		const root = mkdtempSync(join(tmpdir(), "prisma-guard-linkcheck-"));
		try {
			const real = join(root, "real");
			const link = join(root, "link");
			mkdirSync(real);
			symlinkSync(real, link);
			return false;
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	} catch {
		return true;
	}
}

function validate(pathImpl, repoRoot, target) {
	return makePathValidator(pathImpl, repoRoot, GENERATED_REL).validateGeneratedPath(target);
}

function expectedPath(pathImpl, repoRoot) {
	return makePathValidator(pathImpl, repoRoot, GENERATED_REL).generatedPath;
}

test("posix: expected generated path accepted", () => {
	const repoRoot = "/repo";
	const target = "/repo/apps/api/src/generated/prisma";
	assert.equal(validate(posix, repoRoot, target), expectedPath(posix, repoRoot));
	assert.equal(validate(posix, repoRoot, target), target);
});

test("posix: path outside repository rejected", () => {
	const repoRoot = "/repo";
	assert.throws(() => validate(posix, repoRoot, "/tmp/prisma"), /outside repository/);
	assert.throws(
		() => validate(posix, repoRoot, "/repo/apps/api/src/generated/prisma2"),
		/does not match expected generated directory/,
	);
	assert.throws(() => validate(posix, repoRoot, "/repo/apps/../../prisma"), /outside repository/);
});

test("posix: repository root rejected", () => {
	assert.throws(() => validate(posix, "/repo", "/repo"), /repository root/);
});

test("posix: empty path rejected", () => {
	assert.throws(() => validate(posix, "/repo", ""), /empty/);
});

test("win32: expected generated path accepted", () => {
	const repoRoot = "C:\\repo";
	const target = "C:\\repo\\apps\\api\\src\\generated\\prisma";
	assert.equal(validate(win32, repoRoot, target), expectedPath(win32, repoRoot));
	assert.equal(validate(win32, repoRoot, target), target);
});

test("win32: forward-slash input accepted after resolution", () => {
	const repoRoot = "C:\\repo";
	const target = "C:/repo/apps/api/src/generated/prisma";
	assert.equal(validate(win32, repoRoot, target), expectedPath(win32, repoRoot));
});

test("win32: path outside repository rejected", () => {
	const repoRoot = "C:\\repo";
	assert.throws(() => validate(win32, repoRoot, "C:\\other\\prisma"), /outside repository/);
	assert.throws(
		() => validate(win32, repoRoot, "C:\\repo\\apps\\api\\src\\generated\\prisma2"),
		/does not match expected generated directory/,
	);
	assert.throws(
		() => validate(win32, repoRoot, "D:\\repo\\apps\\api\\src\\generated\\prisma"),
		/outside repository/,
	);
});

test("win32: repository root rejected", () => {
	assert.throws(() => validate(win32, "C:\\repo", "C:\\repo"), /repository root/);
});

test("win32: empty path rejected", () => {
	assert.throws(() => validate(win32, "C:\\repo", ""), /empty/);
});

test("symlink target rejected before removal", { skip: symlinksUnsupported() }, () => {
	const root = mkdtempSync(join(tmpdir(), "prisma-guard-symlink-"));
	try {
		const real = join(root, "real");
		const link = join(root, "generated");
		mkdirSync(real);
		symlinkSync(real, link);
		assert.throws(() => assertSafeRemoval(link), /symbolic link/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("missing path is safe (nothing to remove)", () => {
	const root = mkdtempSync(join(tmpdir(), "prisma-guard-missing-"));
	try {
		assert.doesNotThrow(() => assertSafeRemoval(join(root, "does-not-exist")));
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("regular directory is removable", () => {
	const root = mkdtempSync(join(tmpdir(), "prisma-guard-dir-"));
	try {
		const dir = join(root, "generated");
		mkdirSync(dir);
		assert.doesNotThrow(() => assertSafeRemoval(dir));
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
