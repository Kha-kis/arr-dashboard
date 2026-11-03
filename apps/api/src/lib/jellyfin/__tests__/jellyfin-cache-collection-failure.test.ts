import { once } from "node:events";
import { createServer, type ServerResponse } from "node:http";
import type { FastifyBaseLogger } from "fastify";
import pino from "pino";
import { describe, expect, it } from "vitest";
import {
	collectJellyfinCacheLiveEvidence,
	type JellyfinCacheCollectionResult,
} from "../jellyfin-cache-refresher.js";
import { JellyfinClient } from "../jellyfin-client.js";

function captureLog() {
	const lines: string[] = [];
	const log = pino({ level: "info" }, { write: (line: string) => lines.push(line) });
	return { log, lines, records: () => lines.map((line) => JSON.parse(line)) };
}

// Unexpected failure after the real collection await, outside the nearer read catch.
function unexpectedCollectionClient(error: unknown): JellyfinClient {
	return {
		getUsers: async () => [{ id: "private-user", name: "private-name" }],
		getLibraries: async () => [
			{ id: "private-library", name: "private-library-name", collectionType: "movies" },
		],
		getLibraryItemsWithCoverage: async (
			_user: string,
			_library: string,
			options: { onReadStage?: (stage: "items-mapped") => void },
		) => {
			options.onReadStage?.("items-mapped");
			return {
				expectedRawCount: 1,
				pagesAttempted: 1,
				pagesCompleted: 1,
				rawObserved: 1,
				reason: null,
				get items() {
					throw error;
				},
			};
		},
	} as unknown as JellyfinClient;
}

function expectUnknown(result: JellyfinCacheCollectionResult) {
	expect(result).toMatchObject({ upserted: 0, complete: false, receipt: { evidence: "unknown" } });
	expect(result.errors).toBeGreaterThan(0);
	expect(result.snapshot).toBeUndefined();
	expect(result.completedAt).toBeUndefined();
	expect(result.receipt.publishedCanonicalEntities).toBeUndefined();
}

describe("Jellyfin unexpected collection failure diagnostics", () => {
	it.each([
		["type-error", new TypeError("private-title https://private.invalid/private-token")],
		["range-error", new RangeError("private-range")],
		["syntax-error", new SyntaxError("private-syntax")],
		["error", new Error("private-error", { cause: { url: "private-url" } })],
		["non-error", "private-thrown-value"],
		[
			"unknown",
			new Proxy(
				{},
				{
					getPrototypeOf: () => {
						throw new Error("private-prototype");
					},
				},
			),
		],
	])("emits only closed phase/type fields for %s", async (errorType, error) => {
		if (errorType !== "unknown" && error instanceof Error) {
			for (const field of ["name", "message", "stack", "meta", "code", "cause"]) {
				Object.defineProperty(error, field, {
					get: () => {
						throw new Error("private-getter");
					},
				});
			}
		}
		const captured = captureLog();
		const result = await collectJellyfinCacheLiveEvidence(
			unexpectedCollectionClient(error),
			"private-instance",
			captured.log,
		);
		expectUnknown(result);
		expect(result.errorMessages).toEqual(["refresh-failed"]);
		const failures = captured.records().filter((record) => record.category === "refresh-failed");
		expect(failures).toHaveLength(1);
		expect(failures[0]).toMatchObject({
			level: 50,
			category: "refresh-failed",
			stage: "library-items-mapped",
			errorType,
		});
		expect(Object.keys(failures[0]).sort()).toEqual([
			"category",
			"errorType",
			"hostname",
			"level",
			"msg",
			"pid",
			"stage",
			"time",
		]);
		expect(captured.lines.join("")).not.toContain("private-");
	});

	it.each([false, true])(
		"observes signal aborted=%s without downgrading failure",
		async (aborted) => {
			const controller = new AbortController();
			if (aborted) controller.abort(new Error("private-abort-reason"));
			const captured = captureLog();
			const result = await collectJellyfinCacheLiveEvidence(
				unexpectedCollectionClient(new TypeError("private-error")),
				"private-instance",
				captured.log,
				{
					signal: controller.signal,
					onStage: () => {
						throw new Error("private-observer");
					},
				},
			);
			expectUnknown(result);
			expect(result.errorMessages).toEqual(["refresh-failed"]);
			expect(captured.records()).toEqual([
				expect.objectContaining({
					level: 50,
					category: "refresh-failed",
					stage: "library-items-mapped",
					errorType: "type-error",
					signalAborted: aborted,
				}),
			]);
			expect(captured.lines.join("")).not.toContain("private-");
		},
	);

	it.each(["throwing-error", "bound-child", "throwing-bindings"])(
		"retains unknown evidence when diagnostics encounter %s",
		async (scenario) => {
			const captured = captureLog();
			let log: FastifyBaseLogger = captured.log;
			if (scenario === "bound-child")
				log = captured.log.child({ url: "private-url", token: "private-token" });
			else if (scenario === "throwing-bindings")
				captured.log.bindings = () => {
					throw new Error("private-bindings");
				};
			else
				log.error = () => {
					throw new Error("private-logger");
				};
			const result = await collectJellyfinCacheLiveEvidence(
				unexpectedCollectionClient(new Error("private-error")),
				"private-instance",
				log,
			);
			expectUnknown(result);
			expect(result.errorMessages).toEqual(["refresh-failed"]);
			const failures = captured.records().filter((record) => record.category === "refresh-failed");
			if (scenario === "throwing-error") expect(failures).toEqual([]);
			else {
				expect(failures).toEqual([
					expect.objectContaining({ level: 50, stage: "library-items-mapped", errorType: "error" }),
				]);
				if (scenario === "bound-child") {
					// Existing child bindings must not suppress the ERROR or enter the new fields.
					expect(failures[0]).toMatchObject({ url: "private-url", token: "private-token" });
					expect(Object.keys(failures[0]).sort()).toEqual([
						"category",
						"errorType",
						"hostname",
						"level",
						"msg",
						"pid",
						"stage",
						"time",
						"token",
						"url",
					]);
				}
			}
			if (scenario !== "bound-child") expect(captured.lines.join("")).not.toContain("private-");
		},
	);
});

// New loopback regressions; these do not reproduce the historical unknown QA exception.
describe("Jellyfin actual collection read failure boundary", () => {
	it.each(["cancellation", "unsignaled-transport-failure"] as const)(
		"returns unknown without a publication snapshot after %s during library body read",
		async (mode) => {
			const captured = captureLog();
			const controller = new AbortController();
			const stages: string[] = [];
			const requests: string[] = [];
			let held: ServerResponse | undefined;
			let markBodyRead!: () => void;
			const bodyRead = new Promise<void>((resolve) => {
				markBodyRead = resolve;
			});
			const server = createServer((request, reply) => {
				const path = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
				requests.push(path);
				reply.writeHead(200, { "Content-Type": "application/json", Connection: "close" });
				if (path === "/System/Info/Public")
					reply.end(
						JSON.stringify({
							Id: "private-server",
							ServerName: "private-server-name",
							Version: "1",
						}),
					);
				else if (path === "/Users")
					reply.end(JSON.stringify([{ Id: "private-user", Name: "private-name" }]));
				else if (path.endsWith("/Views"))
					reply.end(
						JSON.stringify({
							Items: [
								{
									Id: "private-library",
									Name: "private-library-name",
									Type: "CollectionFolder",
									CollectionType: "movies",
								},
							],
							TotalRecordCount: 1,
						}),
					);
				else if (path === "/Users/private-user/Items") {
					held = reply;
					reply.write('{"Items":[');
				} else reply.end('{"Items":[],"TotalRecordCount":0}');
			});
			server.listen(0, "127.0.0.1");
			await once(server, "listening");
			const address = server.address();
			if (!address || typeof address === "string") throw new Error("loopback required");
			const client = new JellyfinClient(
				`http://127.0.0.1:${address.port}`,
				"private-token",
				captured.log,
				2000,
				undefined,
				undefined,
				mode === "cancellation" ? controller.signal : undefined,
			);
			let running: Promise<JellyfinCacheCollectionResult> | undefined;
			try {
				await expect(client.getPublicInfo()).resolves.toMatchObject({ id: "private-server" });
				running = collectJellyfinCacheLiveEvidence(client, "private-instance", captured.log, {
					...(mode === "cancellation" ? { signal: controller.signal } : {}),
					onStage: (stage) => {
						stages.push(stage);
						if (stage === "library-page-body") markBodyRead();
					},
				});
				await Promise.race([
					bodyRead,
					running.then(() => {
						throw new Error("collection settled before library body read");
					}),
				]);
				expect(held).toBeDefined();
				if (mode === "cancellation") controller.abort(new Error("private-cancellation"));
				else held?.destroy();
				const result = await running;
				expectUnknown(result);
				expect(result.receipt.units.some((unit) => unit.fatalCount > 0)).toBe(true);
				expect(stages).toContain("library-page-body");
				expect(stages).not.toContain("library-page-accepted");
				expect(requests.filter((path) => path === "/Users/private-user/Items")).toHaveLength(1);
				expect(controller.signal.aborted).toBe(mode === "cancellation");
				const records = captured.records();
				expect(records).toContainEqual(
					expect.objectContaining({ category: "incomplete-refresh", level: 40 }),
				);
				expect(records).toContainEqual(
					expect.objectContaining({
						category: "jellyfin-provider-read-failure",
						phase: "body",
						kind: mode === "cancellation" ? "aborted" : expect.not.stringMatching(/^aborted$/),
					}),
				);
				expect(captured.lines.join("")).not.toContain("private-");
			} finally {
				controller.abort();
				held?.destroy();
				server.closeAllConnections();
				await running?.catch(() => {});
				await new Promise<void>((resolve) => server.close(() => resolve()));
			}
		},
	);
});
