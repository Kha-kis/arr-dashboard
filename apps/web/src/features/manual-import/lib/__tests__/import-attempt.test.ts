import { webcrypto } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as attempts from "../import-attempt";
import {
	importScopeKey,
	importSelectionHash,
	readImportAttempt,
	retainImportAttempt,
} from "../import-attempt";

const file = {
	path: "/synthetic/private-file",
	downloadId: "ABCDEF".repeat(10).slice(0, 40),
	movieId: 12,
};
beforeEach(() => {
	sessionStorage.clear();
	vi.stubGlobal("crypto", webcrypto);
});
afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

describe("Manual Import retained attempt boundaries", () => {
	it("retains another deliberate remainder intention when the expected current key was not submitted", async () => {
		const hash = await importSelectionHash([file], "copy", "terminal-original");
		const first = attempts.retainRemainingImportAttempt(
			"scope",
			hash,
			"copy",
			"terminal-original",
			null,
		);
		const next = attempts.retainRemainingImportAttempt(
			"scope",
			hash,
			"copy",
			"terminal-original",
			first.idempotencyKey,
		);
		expect(next.idempotencyKey).not.toBe(first.idempotencyKey);
		expect(next).toMatchObject({
			version: 2,
			remainderOf: "terminal-original",
			selectionHash: hash,
		});
		expect(readImportAttempt("scope")).toEqual(next);
	});
	it("retains a distinct normal intention after an explicit non-submission review", async () => {
		const hash = await importSelectionHash([file], "move");
		const original = retainImportAttempt("scope", hash, "move");
		const next = attempts.retainNewImportAttempt("scope", hash, "move", original.idempotencyKey);
		expect(next.idempotencyKey).not.toBe(original.idempotencyKey);
		expect(next).toMatchObject({ version: 1, selectionHash: hash, importMode: "move" });
		expect(next).not.toHaveProperty("remainderOf");
		expect(readImportAttempt("scope")).toEqual(next);
		expect(sessionStorage.getItem("scope")).not.toMatch(/private-file|ABCDEF/);
	});
	it("retains a new discovered intention only while the expected browser key is absent", async () => {
		const hash = await importSelectionHash([file], "copy");
		const next = attempts.retainNewImportAttempt("scope", hash, "copy", null);
		expect(readImportAttempt("scope")).toEqual(next);
		expect(() => attempts.retainNewImportAttempt("scope", hash, "copy", null)).toThrow(/changed/i);
		expect(readImportAttempt("scope")).toEqual(next);
	});
	it("retains a distinct predecessor-bound key for an explicit remaining intention", async () => {
		const key = await importScopeKey("scope");
		const original = retainImportAttempt(key, await importSelectionHash([file], "copy"), "copy");
		const hash = await importSelectionHash([file], "copy", "original");
		const next = attempts.retainRemainingImportAttempt(
			key,
			hash,
			"copy",
			"original",
			original.idempotencyKey,
		);
		expect(next.idempotencyKey).not.toBe(original.idempotencyKey);
		expect(next).toMatchObject({ version: 2, importMode: "copy", remainderOf: "original" });
		expect(readImportAttempt(key)).toEqual(next);
		expect(
			attempts.retainRemainingImportAttempt(key, hash, "copy", "original", original.idempotencyKey),
		).toEqual(next);
		expect(sessionStorage.getItem(key)).not.toMatch(/private-file|ABCDEF/);
		expect(await importSelectionHash([file], "copy", "other")).not.toBe(hash);
	});
	it("does not replace an attempt that changed since explicit review", async () => {
		const hash = await importSelectionHash([file], "move");
		const original = retainImportAttempt("scope", hash, "move");
		expect(() =>
			attempts.retainRemainingImportAttempt("scope", hash, "move", "original", null),
		).toThrow();
		expect(readImportAttempt("scope")).toEqual(original);
	});
	it("retains an explicitly discovered remainder without private source material", async () => {
		const hash = await importSelectionHash([file], "move", "discovered");
		const next = attempts.retainRemainingImportAttempt("scope", hash, "move", "discovered", null);
		expect(next).toMatchObject({ remainderOf: "discovered", version: 2 });
		expect(readImportAttempt("scope")).toEqual(next);
	});
	it("retains an opaque immutable key without private paths, owner or source", async () => {
		const key = await importScopeKey("synthetic-private-owner:synthetic-private-source");
		const hash = await importSelectionHash([file], "auto");
		const first = retainImportAttempt(key, hash, "auto");
		expect(readImportAttempt(key)).toEqual(first);
		expect(retainImportAttempt(key, hash, "move")).toEqual(first);
		expect(key + sessionStorage.getItem(key)).not.toMatch(
			/private-owner|private-source|private-file|ABCDEF/,
		);
		expect(first.importMode).toBe("move");
		expect(sessionStorage.length).toBe(1);
	});
	it("isolates owner, connection and source bindings", async () => {
		const keys = await Promise.all(
			[
				"owner:connection:source",
				"other:connection:source",
				"owner:other:source",
				"owner:connection:other",
			].map(importScopeKey),
		);
		expect(new Set(keys).size).toBe(4);
		retainImportAttempt(keys[0]!, await importSelectionHash([file], "copy"), "copy");
		for (const key of keys.slice(1)) expect(readImportAttempt(key)).toBeNull();
	});
	it("normalizes ordering, hash case and auto/move without minting another attempt", async () => {
		const second = { ...file, path: "/synthetic/second-file", movieId: 13 };
		expect(await importSelectionHash([file, second], "auto")).toBe(
			await importSelectionHash(
				[{ ...second, downloadId: second.downloadId.toLowerCase() }, file],
				"move",
			),
		);
	});
	it.each([
		{ ...file, movieId: 13 },
		{ ...file, path: "/synthetic/changed-file" },
		{ ...file, downloadId: "other-source" },
	])("rejects changed file identity under the original attempt", async (changed) => {
		const key = await importScopeKey("scope");
		const first = retainImportAttempt(key, await importSelectionHash([file], "move"), "move");
		expect(() => retainImportAttempt(key, "0".repeat(64), "move")).toThrow(/selection differs/i);
		const changedHash = await importSelectionHash([changed], "move");
		expect(() => retainImportAttempt(key, changedHash, "move")).toThrow(/selection differs/i);
		expect(readImportAttempt(key)).toEqual(first);
	});
	it("rejects changed mode and ignores untrusted quality for identity", async () => {
		const key = await importScopeKey("scope");
		const hash = await importSelectionHash([file], "move");
		retainImportAttempt(key, hash, "move");
		expect(await importSelectionHash([{ ...file, quality: { quality: { id: 99 } } }], "move")).toBe(
			hash,
		);
		const copyHash = await importSelectionHash([file], "copy");
		expect(() => retainImportAttempt(key, copyHash, "copy")).toThrow(/selection differs/i);
	});
	it.each(["corrupt", "null", "[]", JSON.stringify({ version: 2 }), "x".repeat(2049)])(
		"does not discard inconsistent storage to create a new key",
		(value) => {
			sessionStorage.setItem("scope", value);
			expect(() => readImportAttempt("scope")).toThrow(/unavailable or inconsistent/i);
			expect(() => retainImportAttempt("scope", "0".repeat(64), "move")).toThrow(
				/unavailable or inconsistent/i,
			);
			expect(sessionStorage.getItem("scope")).toBe(value);
		},
	);
	it("rejects otherwise valid retained records containing extra private fields", async () => {
		const retained = retainImportAttempt(
			"scope",
			await importSelectionHash([file], "move"),
			"move",
		);
		sessionStorage.setItem("scope", JSON.stringify({ ...retained, path: file.path }));
		expect(() => readImportAttempt("scope")).toThrow(/unavailable or inconsistent/i);
	});
	it("fails closed for denied or silently discarded storage writes", () => {
		vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => undefined);
		expect(() => retainImportAttempt("scope", "0".repeat(64), "move")).toThrow(
			/storage is unavailable/i,
		);
	});
});
