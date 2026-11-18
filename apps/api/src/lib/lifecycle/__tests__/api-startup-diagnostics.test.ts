import { describe, expect, it } from "vitest";
import { getApiStartupDiagnostic } from "../api-startup-diagnostics.js";

describe("bounded API startup failure diagnostics", () => {
	it("completes the failure drain when the stderr pipe reader has closed", async () => {
		const source = ts.transpileModule(
			readFileSync(new URL("../api-startup-diagnostics.ts", import.meta.url), "utf8"),
			{ compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } },
		).outputText;
		const child = spawn(
			process.execPath,
			[
				"--input-type=module",
				"-e",
				`${source}\nprocess.once("message", async () => {
  writeApiStartupDiagnostic(getApiStartupDiagnostic("listen", new Error("synthetic")));
  process.stdout.write("drain-started\\n");
  await new Promise(setImmediate);
  await new Promise(resolve => process.stdout.write("drain-completed\\n", resolve));
  process.disconnect();
  process.exit(1);
});
process.send("ready");`,
			],
			{ stdio: ["ignore", "pipe", "pipe", "ipc"], env: { NODE_NO_WARNINGS: "1" } },
		);
		let stdout = "";
		child.stdout!.setEncoding("utf8").on("data", (chunk) => {
			stdout += chunk;
		});
		const closed = once(child, "close");
		try {
			const [message] = await once(child, "message");
			expect(message).toBe("ready");
			const readerClosed = once(child.stderr!, "close");
			child.stderr!.destroy();
			await readerClosed;
			child.send("run");
			const [code, signal] = await closed;
			expect(code).toBe(1);
			expect(signal).toBeNull();
			expect(stdout).toBe("drain-started\ndrain-completed\n");
		} finally {
			if (child.exitCode === null && child.signalCode === null) {
				child.kill("SIGKILL");
				await closed;
			}
		}
	});
	it("retains each declared stage and freezes the exact serializable field set", () => {
		for (const stage of [
			"schema",
			"runtime-open",
			"settings",
			"server-build",
			"listen",
			"handoff",
			"running",
			"unknown",
		]) {
			const diagnostic = getApiStartupDiagnostic(stage, new Error("private detail"));
			expect(Object.isFrozen(diagnostic)).toBe(true);
			expect(JSON.parse(JSON.stringify(diagnostic))).toEqual({
				category: "api-startup-failure",
				stage,
				errorCategory: "unknown",
				code: null,
			});
		}
	});

	it("categorizes only recognized database, filesystem, network, bind and framework codes", () => {
		const families = [
			[
				"database",
				[
					"SQLITE_BUSY",
					"SQLITE_LOCKED",
					"SQLITE_CORRUPT",
					"SQLITE_NOTADB",
					"SQLITE_ERROR",
					"SQLITE_CONSTRAINT",
					"SQLITE_CONSTRAINT_UNIQUE",
					"SQLITE_CONSTRAINT_PRIMARYKEY",
					"SQLITE_CONSTRAINT_FOREIGNKEY",
					"SQLITE_CONSTRAINT_NOTNULL",
					"SQLITE_CONSTRAINT_CHECK",
					"P1000",
					"P1001",
					"P1008",
					"P2002",
					"P2003",
					"P2010",
					"P2023",
					"P2024",
					"P2025",
				],
			],
			["schema", ["P2021", "P2022"]],
			["filesystem", ["EACCES", "EPERM", "ENOENT", "ENOSPC", "EMFILE"]],
			["bind", ["EADDRINUSE", "EADDRNOTAVAIL"]],
			["network", ["ECONNREFUSED", "ETIMEDOUT", "EAI_AGAIN"]],
			[
				"framework",
				[
					"FST_ERR_PLUGIN_TIMEOUT",
					"FST_ERR_DEC_ALREADY_PRESENT",
					"FST_ERR_DEC_MISSING_DEPENDENCY",
					"FST_ERR_PLUGIN_NOT_VALID",
					"FST_ERR_PLUGIN_VERSION_MISMATCH",
				],
			],
		] as const;
		for (const [errorCategory, codes] of families) {
			for (const code of codes) {
				expect(getApiStartupDiagnostic("settings", { code })).toEqual({
					category: "api-startup-failure",
					stage: "settings",
					errorCategory,
					code,
				});
			}
		}
	});

	it("maps closed runtime and standard names without emitting them", () => {
		const cases = [
			["RestoreRuntimeAdmissionError", "runtime-admission"],
			["RestoreRuntimeStateError", "runtime-state"],
			["SqliteRestoreStorageUnavailableError", "storage-identity"],
			["SqliteRestoreRuntimeEnrollmentError", "storage-identity"],
			["RestoreRuntimeOwnershipError", "storage-ownership"],
			["SqliteRestoreRuntimeOwnershipError", "storage-ownership"],
			["RuntimeSchemaStartupError", "schema"],
			["RuntimeSchemaRegistryError", "schema"],
			["RuntimeSchemaPlanError", "schema"],
			["SqliteDateCompatibilityError", "schema"],
			["PrismaClientKnownRequestError", "database"],
			["PrismaClientUnknownRequestError", "database"],
			["PrismaClientInitializationError", "database"],
			["PrismaClientRustPanicError", "database"],
			["PrismaClientValidationError", "validation"],
			["ZodError", "validation"],
			["TypeError", "type"],
			["RangeError", "range"],
		] as const;
		for (const [name, errorCategory] of cases) {
			expect(getApiStartupDiagnostic("runtime-open", { name })).toEqual({
				category: "api-startup-failure",
				stage: "runtime-open",
				errorCategory,
				code: null,
			});
		}
		expect(getApiStartupDiagnostic("listen", new TypeError("private"))).toMatchObject({
			errorCategory: "type",
		});
		expect(
			getApiStartupDiagnostic("runtime-open", {
				name: "RestoreRuntimeOwnershipError",
				code: "EACCES",
			}),
		).toMatchObject({ errorCategory: "storage-ownership", code: "EACCES" });
		expect(
			getApiStartupDiagnostic("schema", { name: "PrismaClientKnownRequestError", code: "P2021" }),
		).toMatchObject({ errorCategory: "schema", code: "P2021" });
	});

	it("reads data descriptors only on the error and its immediate prototype", () => {
		const prototype = { name: "RangeError", code: "EADDRINUSE" };
		expect(getApiStartupDiagnostic("listen", Object.create(prototype))).toMatchObject({
			errorCategory: "range",
			code: "EADDRINUSE",
		});
		expect(
			getApiStartupDiagnostic("listen", Object.create(Object.create(prototype))),
		).toMatchObject({
			errorCategory: "unknown",
			code: null,
		});
		let reads = 0;
		const error = Object.create(prototype, {
			name: {
				get() {
					reads++;
					throw new Error("private getter");
				},
			},
			code: {
				get() {
					reads++;
					throw new Error("private getter");
				},
			},
		});
		expect(getApiStartupDiagnostic("listen", error)).toMatchObject({
			errorCategory: "unknown",
			code: null,
		});
		expect(reads).toBe(0);
	});

	it("never reads or serializes private error details or coercion hooks", () => {
		const reads: PropertyKey[] = [];
		const privateValue = "https://private.invalid/token?secret=owner /private/database user-id";
		const error = new Proxy(
			{ name: privateValue, code: `SQLITE_${privateValue}` },
			{
				get(_target, key) {
					reads.push(key);
					throw new Error(privateValue);
				},
				ownKeys() {
					throw new Error(privateValue);
				},
			},
		);
		const stage = {
			toString() {
				throw new Error(privateValue);
			},
		};
		const serialized = JSON.stringify(getApiStartupDiagnostic(stage, error));
		expect(serialized).toBe(
			'{"category":"api-startup-failure","stage":"unknown","errorCategory":"unknown","code":null}',
		);
		expect(reads).toEqual([]);
	});

	it("does not accept arbitrary code prefixes, object keys, names or stages", () => {
		for (const code of [
			"SQLITE_PRIVATE",
			"P9999",
			"FST_ERR_PRIVATE",
			"EPRIVATE",
			"__proto__",
			"constructor",
			{},
			42,
		]) {
			expect(getApiStartupDiagnostic("private-stage", { name: "PrivateError", code })).toEqual({
				category: "api-startup-failure",
				stage: "unknown",
				errorCategory: "unknown",
				code: null,
			});
		}
		for (const stage of ["__proto__", "constructor", undefined, null, 1, Symbol("private")]) {
			expect(getApiStartupDiagnostic(stage, null).stage).toBe("unknown");
		}
		for (const name of ["__proto__", "constructor", "toString", {}, 42]) {
			expect(getApiStartupDiagnostic("settings", { name })).toMatchObject({
				errorCategory: "unknown",
				code: null,
			});
		}
	});

	it("handles primitive thrown values without reading boxed prototypes", () => {
		for (const error of [null, undefined, "private detail", 12, true, 1n, Symbol("private")]) {
			expect(getApiStartupDiagnostic("handoff", error)).toEqual({
				category: "api-startup-failure",
				stage: "handoff",
				errorCategory: "unknown",
				code: null,
			});
		}
	});

	it("falls back completely if descriptor or prototype reflection throws", () => {
		const descriptorFailure = new Proxy(
			{ code: "EACCES" },
			{
				getOwnPropertyDescriptor(target, key) {
					if (key === "name") throw new Error("private descriptor failure");
					return Reflect.getOwnPropertyDescriptor(target, key);
				},
			},
		);
		const prototypeFailure = new Proxy(
			{},
			{
				getPrototypeOf() {
					throw new Error("private prototype failure");
				},
			},
		);
		const revoked = Proxy.revocable({}, {});
		revoked.revoke();
		for (const error of [descriptorFailure, prototypeFailure, revoked.proxy]) {
			expect(getApiStartupDiagnostic("server-build", error)).toEqual({
				category: "api-startup-failure",
				stage: "server-build",
				errorCategory: "unknown",
				code: null,
			});
		}
	});
});

import { spawn } from "node:child_process";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import ts from "typescript";
