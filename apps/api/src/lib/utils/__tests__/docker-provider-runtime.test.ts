import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	chmodSync,
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const directories: string[] = [];
const repository = resolve(process.cwd(), "../..");
const validator = join(repository, "docker/validate-provider-runtime.cjs");
const packager = join(repository, "docker/prepare-provider-runtimes.cjs");
const testManifest = join(repository, "docker/test-provider-manifest.cjs");
const require = createRequire(import.meta.url);
type Provider = "sqlite" | "postgresql";
const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const entrypoints = [
	"index",
	"launcher",
	"schema-startup",
	"combined-startup",
	"lib/jellyfin/jellyfin-episode-finalizer-worker",
	"lib/jellyfin/jellyfin-episode-page-worker",
];

function write(path: string, value: string) {
	mkdirSync(dirname(path), { recursive: true, mode: 0o755 });
	writeFileSync(path, value, { flag: "wx", mode: 0o644 });
}

function fixture(provider: Provider = "sqlite") {
	const directory = mkdtempSync(join(tmpdir(), "arr-provider-package-"));
	directories.push(directory);
	const deployment = join(directory, "deployment");
	const root = join(deployment, "providers", provider);
	mkdirSync(root, { recursive: true, mode: 0o755 });
	write(join(deployment, "node_modules/@prisma/client/package.json"), '{"version":"7.9.0"}');
	write(join(root, "package.json"), '{"name":"@arr/api","type":"module"}');
	write(join(root, "version.json"), '{"version":"synthetic","commitSha":"fixture"}');
	write(join(root, "tsconfig.json"), '{"compilerOptions":{"target":"ES2022"}}');
	write(join(root, "prisma.config.ts"), "export default {};\n");
	write(join(root, "prisma/schema.prisma"), `datasource db {\n provider = "${provider}"\n}\n`);
	write(join(root, "src/generated/prisma/client.ts"), "export const fixture = true;\n");
	for (const entry of entrypoints) write(join(root, `dist/${entry}.js`), "export {};\n");
	write(
		join(root, "dist/client-config.js"),
		`const config = { "clientVersion": "7.9.0", "activeProvider": "${provider}" };\n` +
			`const schema = 'provider = "${provider}"';\n` +
			`const compiler = 'query_compiler_fast_bg.${provider}.js query_compiler_fast_bg.${provider}.wasm';\n`,
	);
	for (const name of [
		"sqlite-v1.sql",
		"postgresql-v1.sql",
		"registry-sqlite-v1.json",
		"registry-postgresql-v1.json",
	])
		write(join(root, "prisma/runtime-schema", name), `synthetic ${name}\n`);
	symlinkSync("../../node_modules", join(root, "node_modules"));
	manifest(root, provider);
	return { directory, deployment, root };
}

function files(root: string, current = root): string[] {
	return readdirSync(current)
		.flatMap((name) => {
			const path = join(current, name);
			if (name === "runtime-provider.json" || (current === root && name === "node_modules"))
				return [];
			const stat = lstatSync(path);
			return stat.isDirectory() ? files(root, path) : [relative(root, path)];
		})
		.sort();
}

function manifest(root: string, provider: Provider) {
	writeFileSync(
		join(root, "runtime-provider.json"),
		JSON.stringify({
			version: 1,
			provider,
			prismaVersion: "7.9.0",
			files: Object.fromEntries(
				files(root).map((path) => [path, hash(readFileSync(join(root, path)))]),
			),
		}),
		{ mode: 0o644 },
	);
}

function check(root: string, provider: string) {
	return spawnSync(process.execPath, [validator, root, provider], {
		env: { PATH: process.env.PATH, LANG: "C.UTF-8", TZ: "UTC" },
		encoding: "utf8",
		timeout: 5000,
	});
}

function refused(root: string, provider = "sqlite") {
	const result = check(root, provider);
	expect(result.status).toBe(1);
	expect(result.stdout).toBe("");
	expect(result.stderr).not.toContain(root);
	expect(result.stderr).not.toContain("node:internal");
}

afterEach(() => {
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true });
});

describe("test-only provider mock manifests", () => {
	it.each(["dist/index.js", "dist/launcher.js"])(
		"rebinds only %s after validating original bytes",
		(entry) => {
			const { root, directory } = fixture();
			const original = readFileSync(join(root, "runtime-provider.json"));
			const mock = join(directory, "mock.js");
			const output = join(directory, "mock-manifest.json");
			write(mock, "setInterval(() => {}, 1000);\n");
			const { createTestManifest } = require(testManifest);
			createTestManifest(root, "sqlite", output, { [entry]: mock });
			const expected = JSON.parse(original.toString());
			expected.files[entry] = hash(readFileSync(mock));
			expect(JSON.parse(readFileSync(output, "utf8"))).toEqual(expected);
			expect(readFileSync(join(root, "runtime-provider.json"))).toEqual(original);
			expect(check(root, "sqlite").status).toBe(0);
			writeFileSync(join(root, entry), readFileSync(mock));
			refused(root);
			writeFileSync(join(root, "runtime-provider.json"), readFileSync(output));
			expect(check(root, "sqlite").status).toBe(0);
			writeFileSync(join(root, "dist/schema-startup.js"), "export const changed = true;\n");
			refused(root);
		},
	);

	it("refuses an already tampered original before creating an overlay", () => {
		const { root, directory } = fixture();
		const output = join(directory, "overlay.json");
		const mock = join(directory, "mock.js");
		write(mock, "export {};\n");
		writeFileSync(join(root, "dist/index.js"), "changed\n");
		const { createTestManifest } = require(testManifest);
		expect(() => createTestManifest(root, "sqlite", output, { "dist/index.js": mock })).toThrow();
		expect(existsSync(output)).toBe(false);
	});

	it.each(["dist/schema-startup.js", "../unowned", "dist/client-config.js", ""])(
		"refuses non-mock target %s",
		(entry) => {
			const { root, directory } = fixture();
			const mock = join(directory, "mock.js");
			write(mock, "export {};\n");
			const { createTestManifest } = require(testManifest);
			expect(() =>
				createTestManifest(root, "sqlite", join(directory, "output.json"), { [entry]: mock }),
			).toThrow();
		},
	);

	it("refuses empty, symlinked, writable mocks and overwriting an output", () => {
		const { root, directory } = fixture();
		const output = join(directory, "output.json");
		const mock = join(directory, "mock.js");
		const link = join(directory, "link.js");
		write(mock, "export {};\n");
		symlinkSync(mock, link);
		const { createTestManifest } = require(testManifest);
		expect(() => createTestManifest(root, "sqlite", output, {})).toThrow();
		expect(() => createTestManifest(root, "sqlite", output, { "dist/index.js": link })).toThrow();
		chmodSync(mock, 0o664);
		expect(() => createTestManifest(root, "sqlite", output, { "dist/index.js": mock })).toThrow();
		chmodSync(mock, 0o644);
		write(output, "preserved\n");
		expect(() => createTestManifest(root, "sqlite", output, { "dist/index.js": mock })).toThrow();
		expect(readFileSync(output, "utf8")).toBe("preserved\n");
	});
});

describe("immutable Docker provider package admission", () => {
	it.each(["sqlite", "postgresql"] as const)(
		"validates the actual %s files without writes",
		(provider) => {
			const { root } = fixture(provider);
			const before = files(root).map((p) => [p, hash(readFileSync(join(root, p)))]);
			const beforeManifest = readFileSync(join(root, "runtime-provider.json"));
			const result = check(root, provider);
			expect(result.status).toBe(0);
			expect(result.stderr).toBe("");
			expect(files(root).map((p) => [p, hash(readFileSync(join(root, p)))])).toEqual(before);
			expect(readFileSync(join(root, "runtime-provider.json"))).toEqual(beforeManifest);
		},
	);

	it("refuses wrong provider rather than silently selecting a fallback", () => {
		refused(fixture().root, "postgresql");
	});
	it("refuses unsupported provider categories generically", () => {
		refused(fixture().root, "unsupported");
	});
	it("refuses changed bytes even when the provider still matches", () => {
		const { root } = fixture();
		writeFileSync(join(root, "dist/launcher.js"), "export const changed = true;\n");
		refused(root);
	});
	it("refuses wrong compiled configuration even after hashes are recomputed", () => {
		const { root } = fixture();
		const path = join(root, "dist/client-config.js");
		writeFileSync(path, readFileSync(path, "utf8").replaceAll("sqlite", "postgresql"));
		manifest(root, "sqlite");
		refused(root);
	});
	it.each([
		"dist/combined-startup.js",
		"dist/lib/jellyfin/jellyfin-episode-finalizer-worker.js",
		"dist/lib/jellyfin/jellyfin-episode-page-worker.js",
		"prisma/runtime-schema/registry-postgresql-v1.json",
		"src/generated/prisma/client.ts",
	])("refuses absent required runtime input %s despite recomputed hashes", (path) => {
		const { root } = fixture();
		rmSync(join(root, path));
		manifest(root, "sqlite");
		refused(root);
	});
	it("refuses a manifest path escaping the package", () => {
		const { root } = fixture();
		const path = join(root, "runtime-provider.json");
		const value = JSON.parse(readFileSync(path, "utf8"));
		value.files["../unowned"] = "0".repeat(64);
		writeFileSync(path, JSON.stringify(value));
		refused(root);
	});
	it("refuses a symlinked code file despite equal target bytes", () => {
		const { root, directory } = fixture();
		const path = join(root, "dist/index.js");
		write(join(directory, "external.js"), readFileSync(path, "utf8"));
		rmSync(path);
		symlinkSync(join(directory, "external.js"), path);
		refused(root);
	});
	it("refuses a dependency link outside the fixed shared layout", () => {
		const { root, deployment } = fixture();
		rmSync(join(root, "node_modules"));
		symlinkSync(join(deployment, "node_modules"), join(root, "node_modules"));
		refused(root);
	});
	it("refuses a symlinked provider-package parent", () => {
		const { root, deployment } = fixture();
		const parent = join(deployment, "providers");
		const moved = join(deployment, "moved-providers");
		renameSync(parent, moved);
		symlinkSync(moved, parent);
		refused(root);
	});
	it("refuses a writable provider-package parent", () => {
		const { root, deployment } = fixture();
		chmodSync(join(deployment, "providers"), 0o777);
		refused(root);
	});
	it("refuses group-writable application code", () => {
		const { root } = fixture();
		chmodSync(join(root, "dist/index.js"), 0o664);
		refused(root);
	});
	it("refuses an unmanifested application file", () => {
		const { root } = fixture();
		write(join(root, "dist/unverified.js"), "export {};\n");
		refused(root);
	});
	it("stages all fixed inputs and metadata, not project-private files", () => {
		const input = fixture();
		const deployment = join(input.directory, "next-deployment");
		mkdirSync(deployment, { mode: 0o755 });
		write(join(deployment, "version.json"), readFileSync(join(input.root, "version.json"), "utf8"));
		write(join(deployment, "package.json"), readFileSync(join(input.root, "package.json"), "utf8"));
		write(join(deployment, "node_modules/@prisma/client/package.json"), '{"version":"7.9.0"}');
		write(join(input.root, "private-secret"), "excluded synthetic value\n");
		const { stageProviderRuntime } = require(packager);
		const output = stageProviderRuntime(input.root, deployment, "sqlite");
		expect(output).toBe(join(deployment, "providers/sqlite"));
		expect(existsSync(join(output, "private-secret"))).toBe(false);
		for (const path of [
			"dist/index.js",
			"dist/combined-startup.js",
			"src/generated/prisma/client.ts",
			"prisma/schema.prisma",
			"version.json",
		])
			expect(readFileSync(join(output, path))).toEqual(readFileSync(join(input.root, path)));
		expect(check(output, "sqlite").status).toBe(0);
	});
});
