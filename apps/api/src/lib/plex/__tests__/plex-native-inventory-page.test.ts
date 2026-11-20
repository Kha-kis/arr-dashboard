import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { PlexClient } from "../plex-client.js";

const log = { warn: vi.fn(), info: vi.fn() } as never;

function response(container: Record<string, unknown>) {
	return new Response(JSON.stringify({ MediaContainer: container }), {
		status: 200,
		headers: { "Content-Type": "application/json" },
	});
}

describe("Plex durable native inventory page", () => {
	afterEach(() => {
		vi.useRealTimers();
		vi.unstubAllGlobals();
		vi.clearAllMocks();
	});

	it("returns only a validated requested page and bounds a later provider failure", async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(
				response({
					offset: 0,
					size: 1,
					totalSize: 2,
					Metadata: [
						{
							ratingKey: "movie-1",
							type: "movie",
							title: "Synthetic",
							Guid: [{ id: "tmdb://101" }],
						},
					],
				}),
			)
			.mockRejectedValueOnce(new Error("private synthetic failure"));
		vi.stubGlobal("fetch", fetchMock);
		const client = new PlexClient("http://plex.test", "token", log);
		const deadlineAt = Date.now() + 5_000;
		await expect(
			client.readNativeInventoryPage({
				domain: "library",
				sectionId: "owned/movies",
				startIndex: 0,
				limit: 1,
				deadlineAt,
			}),
		).resolves.toEqual({
			status: "page",
			domain: "library",
			startIndex: 0,
			totalRecordCount: 2,
			items: [
				{ ratingKey: "movie-1", type: "movie", title: "Synthetic", externalIds: { tmdb: [101] } },
			],
		});
		const url = new URL(String(fetchMock.mock.calls[0]?.[0]));
		expect(url.pathname).toBe("/library/sections/owned%2Fmovies/all");
		expect(url.searchParams.get("X-Plex-Container-Start")).toBe("0");
		expect(url.searchParams.get("X-Plex-Container-Size")).toBe("1");
		await expect(
			client.readNativeInventoryPage({
				domain: "library",
				sectionId: "owned/movies",
				startIndex: 1,
				limit: 1,
				deadlineAt,
			}),
		).resolves.toEqual({ status: "unavailable", reason: "provider-unavailable" });
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it.each([
		[
			{
				offset: 1,
				size: 1,
				totalSize: 1,
				Metadata: [{ ratingKey: "movie-1", type: "movie", title: "Synthetic" }],
			},
			"changed offset",
		],
		[
			{
				offset: 0,
				size: 2,
				totalSize: 2,
				Metadata: [
					{ ratingKey: "movie-1", type: "movie", title: "Synthetic" },
					{ ratingKey: "movie-1", type: "movie", title: "Synthetic" },
				],
			},
			"duplicate native ID",
		],
	] as const)("rejects %s as incomplete coverage", async (container, _reason) => {
		vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response(container)));
		const client = new PlexClient("http://plex.test", "token", log);
		await expect(
			client.readNativeInventoryPage({
				domain: "library",
				sectionId: "movies",
				startIndex: 0,
				limit: 2,
				deadlineAt: Date.now() + 5_000,
			}),
		).resolves.toEqual({ status: "unavailable", reason: "coverage-incomplete" });
	});

	it.each([
		["library", "fetch", false],
		["episode", "fetch", false],
		["library", "body", false],
		["episode", "body", false],
		["library", "fetch", true],
		["episode", "body", true],
	] as const)(
		"observes an overdue %s %s read without releasing it (logger throws: %s)",
		async (domain, phase, throws) => {
			vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
			const warnings: unknown[] = [];
			const logger = {
				warn: (value: unknown) => {
					warnings.push(value);
					if (throws) throw new Error("private-logger-failure");
				},
				info: () => {},
			} as never;
			let releaseFetch: (value: Response) => void = () => {};
			let body: ReadableStreamDefaultController<Uint8Array> | undefined;
			const pending = new Response(
				new ReadableStream<Uint8Array>({
					start: (controller) => {
						body = controller;
					},
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
			vi.stubGlobal(
				"fetch",
				phase === "fetch"
					? () =>
							new Promise<Response>((resolve) => {
								releaseFetch = resolve;
							})
					: async () => pending,
			);
			const client = new PlexClient("http://private-synthetic.test", "private-token", logger);
			let settled = false;
			const task = client
				.readNativeInventoryPage({
					domain,
					sectionId: "private-section",
					startIndex: 0,
					limit: 1,
					deadlineAt: Date.now() + 60_000,
				})
				.finally(() => {
					settled = true;
				});
			try {
				await vi.advanceTimersByTimeAsync(15_999);
				expect(warnings).toEqual([]);
				await vi.advanceTimersByTimeAsync(1);
				expect(warnings).toEqual([
					{
						category: "plex-native-read-overdue",
						domain,
						phase,
						elapsedMs: 16_000,
					},
				]);
				expect(settled).toBe(false);
				await vi.advanceTimersByTimeAsync(5_000);
				expect(warnings).toHaveLength(1);
				expect(JSON.stringify(warnings)).not.toContain("private-");
			} finally {
				const container = {
					offset: 0,
					size: 1,
					totalSize: 1,
					Metadata: [
						domain === "library"
							? { ratingKey: "movie-1", type: "movie", title: "private-title" }
							: {
									ratingKey: "episode-1",
									type: "episode",
									title: "private-title",
									grandparentRatingKey: "series-1",
									parentIndex: 1,
									index: 1,
								},
					],
				};
				if (phase === "fetch") {
					await pending.body?.cancel();
					releaseFetch(response(container));
				} else {
					body?.enqueue(new TextEncoder().encode(JSON.stringify({ MediaContainer: container })));
					body?.close();
				}
				const result = await task;
				expect(result.status).toBe("page");
				expect(vi.getTimerCount()).toBe(0);
			}
		},
	);

	it.each(["success", "coverage", "schema", "provider"] as const)(
		"clears the native observer after %s settlement",
		async (kind) => {
			vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
			const warnings: unknown[] = [];
			const logger = { warn: (value: unknown) => warnings.push(value), info: () => {} } as never;
			vi.stubGlobal(
				"fetch",
				kind === "provider"
					? async () => {
							throw new Error("private-provider-failure");
						}
					: async () =>
							response(
								kind === "schema"
									? { Metadata: "invalid" }
									: {
											offset: kind === "coverage" ? 1 : 0,
											size: 1,
											totalSize: 1,
											Metadata: [{ ratingKey: "movie-1", type: "movie", title: "Synthetic" }],
										},
							),
			);
			const result = await new PlexClient(
				"http://plex.test",
				"token",
				logger,
			).readNativeInventoryPage({
				domain: "library",
				sectionId: "movies",
				startIndex: 0,
				limit: 1,
				deadlineAt: Date.now() + 60_000,
			});
			expect(result.status).toBe(kind === "success" ? "page" : "unavailable");
			expect(vi.getTimerCount()).toBe(0);
			await vi.advanceTimersByTimeAsync(30_000);
			expect(warnings).toEqual([]);
		},
	);

	it.each([
		[1_000, 60_000, 2_000],
		[15_000, 250, 1_250],
	] as const)(
		"observes the existing minimum of client %s and slice %s without new timeout policy",
		async (timeout, remaining, observationAt) => {
			vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
			const warnings: unknown[] = [];
			let rejectFetch: (error: Error) => void = () => {};
			vi.stubGlobal(
				"fetch",
				() =>
					new Promise<Response>((_resolve, reject) => {
						rejectFetch = reject;
					}),
			);
			const client = new PlexClient(
				"http://plex.test",
				"token",
				{
					warn: (value: unknown) => warnings.push(value),
					info: () => {},
				} as never,
				timeout,
			);
			const task = client.readNativeInventoryPage({
				domain: "library",
				sectionId: "movies",
				startIndex: 0,
				limit: 1,
				deadlineAt: Date.now() + remaining,
			});
			try {
				await vi.advanceTimersByTimeAsync(observationAt - 1);
				expect(warnings).toEqual([]);
				await vi.advanceTimersByTimeAsync(1);
				expect(warnings).toEqual([
					{
						category: "plex-native-read-overdue",
						domain: "library",
						phase: "fetch",
						elapsedMs: observationAt,
					},
				]);
			} finally {
				rejectFetch(new Error("synthetic provider failure"));
				await task;
				expect(vi.getTimerCount()).toBe(0);
			}
		},
	);

	it("keeps ordinary request results intact when a phase observer throws", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
		const phases: string[] = [];
		vi.stubGlobal(
			"fetch",
			async () =>
				new Response('{"ok":true}', {
					status: 200,
					headers: { "Content-Type": "application/json" },
				}),
		);
		const result = await new PlexClient("http://plex.test", "token", log).request("/synthetic", {
			schema: z.object({ ok: z.boolean() }),
			onReadPhase: (phase) => {
				phases.push(phase);
				throw new Error("private-observer-failure");
			},
		});
		expect(result).toEqual({ ok: true });
		expect(phases).toEqual(["fetch", "body", "validation"]);
		expect(vi.getTimerCount()).toBe(0);
	});
});
