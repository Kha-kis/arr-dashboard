import { describe, expect, it, vi } from "vitest";
import {
	parseNativeControlWorkerRequest,
	parseNativeControlWorkerResult,
} from "../native-control-worker-protocol.js";

const input = {
	version: 1,
	provider: "plex" as const,
	workKey: "paired" as const,
	operation: "discovery" as const,
	baseUrl: "http://synthetic.invalid",
	apiKey: "synthetic",
	httpAuthHeaders: {},
	deadlineAt: Date.now() + 5_000,
	requestTimeoutMs: 1_000,
};
const plex = {
	domain: "library",
	sectionKey: "1",
	sectionUuid: "uuid",
	sectionType: "show",
	scopeKey: '["1","uuid","show"]',
};
const jelly = { libraryId: "1", collectionType: "", scopeKey: "library:1" };
const ready = { status: "ready", catalogIdentity: "[]", scopes: [plex] };

describe("native control descriptor-only protocol", () => {
	it("accepts only the fixed provider and operation coordinates", () => {
		expect(parseNativeControlWorkerRequest(input)).toEqual(input);
		for (const change of [
			{ workKey: "library" },
			{ operation: "DELETE" },
			{ url: "/other" },
			{ signal: new AbortController().signal },
			{ requestTimeoutMs: 15_001 },
			{ apiKey: "" },
			{ baseUrl: "file:///tmp" },
		])
			expect(parseNativeControlWorkerRequest({ ...input, ...change })).toBeNull();
		expect(
			parseNativeControlWorkerRequest({ ...input, provider: "jellyfin", workKey: "episode" }),
		).not.toBeNull();
	});
	it("does not execute getters in requests, envelopes, arrays, or scopes", () => {
		const get = vi.fn(() => {
			throw new Error("private");
		});
		for (const [value, field] of [
			[{ ...input }, "apiKey"],
			[{ ...ready }, "status"],
			[{ ...plex }, "scopeKey"],
		] as const) {
			Object.defineProperty(value, field, { get, enumerable: true });
			if (field === "apiKey") expect(parseNativeControlWorkerRequest(value)).toBeNull();
			else
				expect(
					parseNativeControlWorkerResult(
						field === "scopeKey" ? { ...ready, scopes: [value] } : value,
						input,
					),
				).toBeNull();
		}
		const scopes = [plex];
		Object.defineProperty(scopes, "0", { get, enumerable: true });
		expect(parseNativeControlWorkerResult({ ...ready, scopes }, input)).toBeNull();
		expect(get).not.toHaveBeenCalled();
	});
	it("preserves paired Plex coordinates and empty Jellyfin collection types", () => {
		const result = { ...ready, scopes: [plex, { ...plex, domain: "episode" }] };
		expect(parseNativeControlWorkerResult(result, input)).toEqual(result);
		expect(
			parseNativeControlWorkerResult(
				{ ...ready, scopes: [jelly] },
				{ ...input, provider: "jellyfin", workKey: "episode" },
			),
		).toEqual({ ...ready, scopes: [jelly] });
		expect(parseNativeControlWorkerResult({ ...ready, scopes: [] }, input)).toEqual({
			...ready,
			scopes: [],
		});
	});
	it("rejects malformed, duplicate, oversized, or misbound discovery", () => {
		for (const scopes of [
			[plex, plex],
			[{ ...plex, scopeKey: "wrong" }],
			[{ ...plex, extra: true }],
			[{ ...plex, domain: "episode", sectionType: "movie" }],
			[jelly],
			null,
			new Array(2),
		])
			expect(parseNativeControlWorkerResult({ ...ready, scopes }, input)).toBeNull();
		for (const catalogIdentity of ["", "\0", "a".repeat(8193), null])
			expect(parseNativeControlWorkerResult({ ...ready, catalogIdentity }, input)).toBeNull();
	});
	it("applies each domain's scope cap independently", () => {
		const scopes = Array.from({ length: 10_000 }, (_, i) => ({
			...plex,
			sectionKey: String(i),
			scopeKey: JSON.stringify([String(i), "uuid", "show"]),
		}));
		expect(
			parseNativeControlWorkerResult(
				{ ...ready, scopes: scopes.flatMap((scope) => [scope, { ...scope, domain: "episode" }]) },
				input,
			),
		).not.toBeNull();
		expect(
			parseNativeControlWorkerResult(
				{
					...ready,
					scopes: [...scopes, { ...plex, sectionKey: "last", scopeKey: '["last","uuid","show"]' }],
				},
				input,
			),
		).toBeNull();
	});
	it("binds identity messages to identity operations and closes failure categories", () => {
		expect(
			parseNativeControlWorkerResult(
				{ status: "identity", identity: "raw-id" },
				{ ...input, operation: "identity" },
			),
		).toEqual({ status: "identity", identity: "raw-id" });
		expect(
			parseNativeControlWorkerResult({ status: "identity", identity: "raw-id" }, input),
		).toBeNull();
		expect(parseNativeControlWorkerResult(ready, { ...input, operation: "identity" })).toBeNull();
		for (const reason of ["deadline-exceeded", "provider-unavailable", "coverage-incomplete"])
			expect(parseNativeControlWorkerResult({ status: "unavailable", reason }, input)).toEqual({
				status: "unavailable",
				reason,
			});
		expect(
			parseNativeControlWorkerResult({ status: "failed", category: "private" }, input),
		).toBeNull();
	});
});
