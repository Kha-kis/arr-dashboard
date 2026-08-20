// Focused tests for the Prisma generated-client guard's path-safety helpers.
//
// Exercises the Windows separator contract through path.win32 and path.posix
// so the same matrix runs on Linux CI and on native Windows Node, plus
// filesystem-boundary tests (ancestor symlinks, junctions, deletion boundary)
// and a post-generation ignored-drift integration test backed by a temporary
// git repository. Run with:
//
//   node --test scripts/check-prisma-generated.test.mjs

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path, { join, posix, win32 } from "node:path";
import { test } from "node:test";
import {
	assertSafeRemoval,
	collectPostGenerationDrift,
	makeDeletionBoundaryValidator,
	makePathValidator,
} from "./check-prisma-generated.mjs";

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

// Windows directory junctions do not require Developer Mode; report whether a
// junction (or, on POSIX, an ordinary symlink) can be created.
function junctionsUnsupported() {
	try {
		const root = mkdtempSync(join(tmpdir(), "prisma-guard-junction-"));
		try {
			const real = join(root, "real");
			const link = join(root, "link");
			mkdirSync(real);
			symlinkSync(real, link, process.platform === "win32" ? "junction" : "dir");
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

const fsOps = { existsSync, lstatSync, realpathSync };

function boundary(repoRoot) {
	return makeDeletionBoundaryValidator(path, repoRoot, GENERATED_REL, fsOps).assertBoundary;
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

test("A. final target symlink rejected before removal", { skip: symlinksUnsupported() }, () => {
	const root = mkdtempSync(join(tmpdir(), "prisma-guard-final-link-"));
	try {
		const repo = join(root, "repo");
		const outside = join(root, "outside");
		const target = join(repo, "apps", "api", "src", "generated", "prisma");
		mkdirSync(join(repo, "apps", "api", "src", "generated"), { recursive: true });
		mkdirSync(outside);
		symlinkSync(outside, target);
		assert.throws(() => boundary(repo)(), /symbolic link/);
		assert.ok(existsSync(outside), "outside target must survive");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("B. parent symlink ancestor rejected before removal", { skip: symlinksUnsupported() }, () => {
	const root = mkdtempSync(join(tmpdir(), "prisma-guard-parent-link-"));
	try {
		const repo = join(root, "repo");
		const outside = join(root, "outside-generated");
		mkdirSync(join(repo, "apps", "api", "src"), { recursive: true });
		mkdirSync(join(outside, "prisma"), { recursive: true });
		symlinkSync(outside, join(repo, "apps", "api", "src", "generated"));
		assert.throws(() => boundary(repo)(), /symbolic link/);
		assert.ok(existsSync(join(outside, "prisma")), "outside-generated/prisma must survive");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("C. higher ancestor symlink rejected without deleting outside content", {
	skip: symlinksUnsupported(),
}, () => {
	const root = mkdtempSync(join(tmpdir(), "prisma-guard-higher-link-"));
	try {
		const repo = join(root, "repo");
		const outside = join(root, "outside-src");
		mkdirSync(join(repo, "apps", "api"), { recursive: true });
		mkdirSync(join(outside, "generated", "prisma"), { recursive: true });
		symlinkSync(outside, join(repo, "apps", "api", "src"));
		assert.throws(() => boundary(repo)(), /symbolic link/);
		assert.ok(
			existsSync(join(outside, "generated", "prisma")),
			"outside-src/generated/prisma must survive",
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("D. missing final directory with safe ancestors accepted", () => {
	const root = mkdtempSync(join(tmpdir(), "prisma-guard-missing-safe-"));
	try {
		const repo = join(root, "repo");
		mkdirSync(join(repo, "apps", "api", "src", "generated"), { recursive: true });
		assert.doesNotThrow(() => boundary(repo)());
		assert.ok(!existsSync(join(repo, "apps", "api", "src", "generated", "prisma")));
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("E. missing final directory beneath symlinked parent rejected", {
	skip: symlinksUnsupported(),
}, () => {
	const root = mkdtempSync(join(tmpdir(), "prisma-guard-missing-link-"));
	try {
		const repo = join(root, "repo");
		const outside = join(root, "outside-generated");
		mkdirSync(join(repo, "apps", "api", "src"), { recursive: true });
		mkdirSync(outside);
		symlinkSync(outside, join(repo, "apps", "api", "src", "generated"));
		assert.throws(() => boundary(repo)(), /symbolic link/);
		assert.ok(
			!existsSync(join(outside, "prisma")),
			"generation must not write through the symlink",
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("F. ordinary directory tree accepted and removable", () => {
	const root = mkdtempSync(join(tmpdir(), "prisma-guard-ordinary-"));
	try {
		const repo = join(root, "repo");
		const target = join(repo, "apps", "api", "src", "generated", "prisma");
		mkdirSync(target, { recursive: true });
		writeFileSync(join(target, "file.ts"), "// generated\n");
		assert.doesNotThrow(() => boundary(repo)());
		const { realRoot, lastExisting } = makeDeletionBoundaryValidator(
			path,
			repo,
			GENERATED_REL,
			fsOps,
		).assertBoundary();
		assert.equal(lastExisting, target);
		assert.ok(realRoot.startsWith(root), "real root stays inside fixture");
		assert.doesNotThrow(() => assertSafeRemoval(target));
		rmSync(target, { recursive: true, force: true });
		assert.ok(!existsSync(target), "ordinary directory must be removable");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("G. junction/ancestor link rejected on native hosts", { skip: junctionsUnsupported() }, () => {
	const root = mkdtempSync(join(tmpdir(), "prisma-guard-junction-"));
	try {
		const repo = join(root, "repo");
		const outside = join(root, "outside-junction");
		mkdirSync(join(repo, "apps", "api", "src"), { recursive: true });
		mkdirSync(join(outside, "prisma"), { recursive: true });
		symlinkSync(outside, join(repo, "apps", "api", "src", "generated"), "junction");
		assert.throws(() => boundary(repo)(), /symbolic link/);
		assert.ok(existsSync(join(outside, "prisma")), "junction target must survive");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("post-generation ignored output participates in drift", () => {
	const root = mkdtempSync(join(tmpdir(), "prisma-guard-postgen-"));
	try {
		const repo = join(root, "repo");
		const generated = join(repo, ...GENERATED_REL.split("/"));
		mkdirSync(generated, { recursive: true });
		execFileSync("git", ["init", "-q"], { cwd: repo });
		execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repo });
		execFileSync("git", ["config", "user.name", "Test"], { cwd: repo });
		writeFileSync(join(generated, "tracked.ts"), "// tracked\n");
		execFileSync("git", ["add", "."], { cwd: repo });
		execFileSync("git", ["commit", "-qm", "seed"], { cwd: repo });
		// Generator produced an ignored file after the safe preflight.
		writeFileSync(join(generated, "fresh.probe"), "// ignored output\n");
		writeFileSync(join(repo, ".gitignore"), "*.probe\n");
		const gitRun = (args) => execFileSync("git", args, { cwd: repo, encoding: "utf8" });
		const drift = collectPostGenerationDrift(gitRun, `${GENERATED_REL}/`);
		assert.deepEqual(drift.modified, []);
		assert.deepEqual(drift.deleted, []);
		assert.deepEqual(drift.untracked, []);
		assert.deepEqual(drift.ignored, ["apps/api/src/generated/prisma/fresh.probe"]);
		assert.ok(
			drift.ignored.length > 0,
			"post-generation ignored output must be classified as drift",
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
