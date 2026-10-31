import assert from "node:assert/strict";
import {
	existsSync,
	mkdtempSync,
	lstatSync,
	readFileSync,
	writeFileSync,
	chmodSync,
	symlinkSync,
	linkSync,
	unlinkSync,
	rmdirSync,
	readdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

// A missing export is an explicit introduction RED, not a load/syntax error.
let startup: typeof import("../combined-startup.js") | null = null;
beforeAll(async () => {
	if (existsSync(new URL("../combined-startup.ts", import.meta.url)))
		startup = await import("../combined-startup.js");
});
const implementation = () => {
	assert(startup, "combined startup protocol is not implemented");
	return startup;
};
const nonce = "a".repeat(64);
const message = () => ({
	kind: "arr-combined-startup",
	version: 1,
	nonce,
	apiPort: 3011,
	webPort: 3010,
	listenAddress: "127.0.0.1",
});
const roots: string[] = [];
function root() {
	const path = mkdtempSync(join(tmpdir(), "combined-startup-test-"));
	roots.push(path);
	return path;
}
afterEach(() => {
	// Only these fresh private test roots; no recursive deletion or application data.
	for (const path of roots.splice(0)) {
		for (const name of readdirSync(path)) {
			const child = join(path, name);
			if (lstatSync(child).isDirectory()) {
				for (const file of readdirSync(child)) unlinkSync(join(child, file));
				rmdirSync(child);
			} else unlinkSync(child);
		}
		rmdirSync(path);
	}
});

describe("combined effective settings", () => {
	it("keeps database ports/address ahead of image environment defaults", () => {
		expect(
			implementation().resolveCombinedStartupSettings(
				{ apiPort: 3011, webPort: 3010, listenAddress: "127.0.0.1" },
				{ API_PORT: "3001", PORT: "3000", HOST: "0.0.0.0" },
			),
		).toEqual({ apiPort: 3011, webPort: 3010, listenAddress: "127.0.0.1" });
	});
	it("uses environment and then defaults only for absent validated settings", () => {
		const absent = { apiPort: null, webPort: null, listenAddress: null };
		expect(
			implementation().resolveCombinedStartupSettings(absent, {
				API_PORT: "4011",
				PORT: "4010",
				HOST: "::1",
			}),
		).toEqual({ apiPort: 4011, webPort: 4010, listenAddress: "::1" });
		expect(implementation().resolveCombinedStartupSettings(absent, {})).toEqual({
			apiPort: 3001,
			webPort: 3000,
			listenAddress: "0.0.0.0",
		});
	});
	for (const value of ["0", "65536", "3011junk", "-1", "3.5", " 3011"])
		it(`refuses invalid effective environment port ${JSON.stringify(value)}`, () => {
			expect(() =>
				implementation().resolveCombinedStartupSettings(
					{ apiPort: null, webPort: null, listenAddress: null },
					{ API_PORT: value },
				),
			).toThrow();
		});
});

describe("current nonce and strict message", () => {
	it("accepts the exact allowlisted shape and never returns extra input fields", () => {
		expect(implementation().parseCombinedStartupMessage(message(), nonce)).toEqual(message());
	});
	for (const [label, mutate] of [
		[
			"old nonce",
			(m: Record<string, unknown>) => {
				m.nonce = "b".repeat(64);
			},
		],
		[
			"version",
			(m: Record<string, unknown>) => {
				m.version = 2;
			},
		],
		[
			"unknown kind",
			(m: Record<string, unknown>) => {
				m.kind = "other";
			},
		],
		[
			"private field",
			(m: Record<string, unknown>) => {
				m.secret = "synthetic-never-return";
			},
		],
		[
			"missing field",
			(m: Record<string, unknown>) => {
				delete m.webPort;
			},
		],
		[
			"zero port",
			(m: Record<string, unknown>) => {
				m.apiPort = 0;
			},
		],
		[
			"fractional port",
			(m: Record<string, unknown>) => {
				m.webPort = 3.5;
			},
		],
		[
			"string port",
			(m: Record<string, unknown>) => {
				m.apiPort = "3011";
			},
		],
		[
			"over-range port",
			(m: Record<string, unknown>) => {
				m.webPort = 65536;
			},
		],
		[
			"unsafe address",
			(m: Record<string, unknown>) => {
				m.listenAddress = "127.0.0.1;command";
			},
		],
		[
			"empty address",
			(m: Record<string, unknown>) => {
				m.listenAddress = "";
			},
		],
	] as const)
		it(`refuses ${label}`, () => {
			const input: Record<string, unknown> = message();
			mutate(input);
			expect(() => implementation().parseCombinedStartupMessage(input, nonce)).toThrow();
		});
});

describe("real owned channel filesystem", () => {
	it("publishes exclusively and reads only a bounded current result", () => {
		const api = implementation(),
			context = api.prepareCombinedStartupChannel(root());
		expect(lstatSync(context.directory).mode & 0o777).toBe(0o700);
		expect(api.readCombinedStartupResult(context)).toBeNull();
		const m = { ...message(), nonce: context.nonce };
		api.publishCombinedStartupResult(context, m);
		expect(api.readCombinedStartupResult(context)).toEqual(m);
		expect(lstatSync(join(context.directory, "result.json")).mode & 0o777).toBe(0o600);
		expect(() => api.publishCombinedStartupResult(context, m)).toThrow();
		expect(api.readCombinedStartupResult(context)).toEqual(m);
		api.removeCombinedStartupChannel(context);
		expect(existsSync(context.directory)).toBe(false);
	});
	it("refuses a symlink destination without touching its target", () => {
		const api = implementation(),
			directory = root(),
			context = api.prepareCombinedStartupChannel(directory),
			target = join(directory, "retained");
		writeFileSync(target, "retained", { mode: 0o600 });
		symlinkSync(target, join(context.directory, "result.json"));
		expect(() =>
			api.publishCombinedStartupResult(context, { ...message(), nonce: context.nonce }),
		).toThrow();
		expect(() => api.readCombinedStartupResult(context)).toThrow();
		expect(readFileSync(target, "utf8")).toBe("retained");
	});
	it("refuses nonprivate directories before publication", () => {
		const api = implementation(),
			context = api.prepareCombinedStartupChannel(root());
		chmodSync(context.directory, 0o755);
		expect(() =>
			api.publishCombinedStartupResult(context, { ...message(), nonce: context.nonce }),
		).toThrow();
		expect(existsSync(join(context.directory, "result.json"))).toBe(false);
	});
	it("refuses wrong directory identity, stale request and unowned cleanup contents", () => {
		const api = implementation(),
			context = api.prepareCombinedStartupChannel(root());
		expect(() => api.readCombinedStartupResult({ ...context, inode: "0" })).toThrow();
		writeFileSync(join(context.directory, "unexpected"), "retained", { mode: 0o600 });
		expect(() => api.removeCombinedStartupChannel(context)).toThrow();
		expect(existsSync(join(context.directory, "request.json"))).toBe(true);
		unlinkSync(join(context.directory, "unexpected"));
		writeFileSync(
			join(context.directory, "request.json"),
			JSON.stringify({ version: 1, nonce: "b".repeat(64) }),
			{ mode: 0o600 },
		);
		expect(() => api.readCombinedStartupResult(context)).toThrow();
	});
	for (const [label, text] of [
		["malformed", "{"],
		["oversize", "x".repeat(4097)],
		["wrong nonce", JSON.stringify(message())],
	] as const)
		it(`refuses ${label} result without publishing success`, () => {
			const api = implementation(),
				context = api.prepareCombinedStartupChannel(root());
			writeFileSync(join(context.directory, "result.json"), text, { mode: 0o600 });
			expect(() => api.readCombinedStartupResult(context)).toThrow();
		});
	it("does not accept a hardlinked result as ready", () => {
		const api = implementation(),
			context = api.prepareCombinedStartupChannel(root());
		api.publishCombinedStartupResult(context, { ...message(), nonce: context.nonce });
		linkSync(join(context.directory, "result.json"), join(context.directory, "second-link"));
		expect(api.readCombinedStartupResult(context)).toBeNull();
	});
});
