import { setImmediate as turn } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { JellyfinClient } from "../jellyfin-client.js";

const log = { warn: vi.fn() } as never;
function response(value: unknown) {
	return new Response(JSON.stringify(value), { headers: { "Content-Type": "application/json" } });
}
function monitor<T>(promise: Promise<T>) {
	let state: "pending" | "fulfilled" | "rejected" = "pending";
	const joined = promise.then(
		() => {
			state = "fulfilled";
		},
		() => {
			state = "rejected";
		},
	);
	return { state: () => state, joined };
}
describe("real Jellyfin read deadline against abort-insensitive transport", () => {
	afterEach(() => {
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
	});
	it("rejects an expired GET and cancels its late response instead of accepting it", async () => {
		const timeout = new AbortController();
		vi.spyOn(AbortSignal, "timeout").mockReturnValue(timeout.signal);
		let finish: (response: Response) => void = () => {};
		vi.stubGlobal(
			"fetch",
			() =>
				new Promise<Response>((resolve) => {
					finish = resolve;
				}),
		);
		const client = new JellyfinClient("http://synthetic.invalid", "synthetic-token", log);
		const result = monitor(client.getServerInfo());
		let canceled = false;
		const late = new Response(
			new ReadableStream<Uint8Array>({
				start(controller) {
					controller.enqueue(
						new TextEncoder().encode('{"Id":"server","ServerName":"Synthetic","Version":"1"}'),
					);
				},
				cancel() {
					canceled = true;
				},
			}),
			{ headers: { "Content-Type": "application/json" } },
		);
		try {
			timeout.abort(new DOMException("synthetic timeout", "TimeoutError"));
			await turn();
			expect(result.state()).toBe("rejected");
			finish(late);
			await turn();
			expect(canceled).toBe(true);
			expect(result.state()).toBe("rejected");
		} finally {
			finish(response({ Id: "server", ServerName: "Synthetic", Version: "1" }));
			await result.joined;
		}
	});
	it("rejects an expired on-deck body and cancels it rather than accepting late rows", async () => {
		const timeout = new AbortController();
		vi.spyOn(AbortSignal, "timeout").mockReturnValue(timeout.signal);
		let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
		let canceled = false;
		const body = new ReadableStream<Uint8Array>({
			start(value) {
				controller = value;
			},
			cancel() {
				canceled = true;
			},
		});
		vi.stubGlobal(
			"fetch",
			async () => new Response(body, { headers: { "Content-Type": "application/json" } }),
		);
		const client = new JellyfinClient("http://synthetic.invalid", "synthetic-token", log);
		const result = monitor(client.getResumeItems("synthetic-user"));
		try {
			await turn();
			timeout.abort(new DOMException("synthetic timeout", "TimeoutError"));
			await turn();
			expect(result.state()).toBe("rejected");
			expect(canceled).toBe(true);
		} finally {
			if (!canceled) {
				controller!.enqueue(new TextEncoder().encode('{"Items":[],"TotalRecordCount":0}'));
				controller!.close();
			}
			await result.joined;
		}
	});
	it("honors caller cancellation while GET is pending without consuming its retry", async () => {
		const caller = new AbortController();
		let finish: (value: Response) => void = () => {};
		const fetchMock = vi.fn(
			() =>
				new Promise<Response>((resolve) => {
					finish = resolve;
				}),
		);
		vi.stubGlobal("fetch", fetchMock);
		const client = new JellyfinClient(
			"http://synthetic.invalid",
			"synthetic-token",
			log,
			undefined,
			{},
			"JELLYFIN",
			caller.signal,
		);
		const result = monitor(client.getNextUp("synthetic-user"));
		try {
			caller.abort();
			await turn();
			expect(result.state()).toBe("rejected");
			expect(fetchMock).toHaveBeenCalledTimes(1);
		} finally {
			finish(response({ Items: [], TotalRecordCount: 0 }));
			await result.joined;
		}
	});
	it("observes a late fetch rejection after the caller has already failed", async () => {
		const timeout = new AbortController();
		vi.spyOn(AbortSignal, "timeout").mockReturnValue(timeout.signal);
		let fail: (reason: Error) => void = () => {};
		vi.stubGlobal(
			"fetch",
			() =>
				new Promise<Response>((_resolve, reject) => {
					fail = reject;
				}),
		);
		const client = new JellyfinClient("http://synthetic.invalid", "synthetic-token", log);
		const result = monitor(client.getServerInfo());
		timeout.abort(new DOMException("synthetic timeout", "TimeoutError"));
		await turn();
		expect(result.state()).toBe("rejected");
		fail(new Error("synthetic late rejection"));
		await turn();
		await result.joined;
		expect(result.state()).toBe("rejected");
	});
	it("still performs exactly one fresh on-deck retry after a fetch ignores its timeout", async () => {
		const first = new AbortController(),
			second = new AbortController();
		vi.spyOn(AbortSignal, "timeout")
			.mockReturnValueOnce(first.signal)
			.mockReturnValue(second.signal);
		let finish: (value: Response) => void = () => {};
		const fetchMock = vi
			.fn()
			.mockImplementationOnce(
				() =>
					new Promise<Response>((resolve) => {
						finish = resolve;
					}),
			)
			.mockResolvedValueOnce(
				response({
					Items: [{ Id: "movie-1", Name: "Synthetic", Type: "Movie" }],
					TotalRecordCount: 1,
				}),
			);
		vi.stubGlobal("fetch", fetchMock);
		const client = new JellyfinClient("http://synthetic.invalid", "synthetic-token", log);
		const result = client.getResumeItems("synthetic-user");
		try {
			first.abort(new DOMException("synthetic timeout", "TimeoutError"));
			await expect(result).resolves.toEqual([expect.objectContaining({ id: "movie-1" })]);
			expect(fetchMock).toHaveBeenCalledTimes(2);
			expect(fetchMock.mock.calls[0]?.[1].signal).not.toBe(fetchMock.mock.calls[1]?.[1].signal);
		} finally {
			finish(response({ Items: [], TotalRecordCount: 0 }));
			await result.catch(() => {});
		}
	});
	it("preserves valid JSON split within a multibyte character", async () => {
		const value = new TextEncoder().encode(
			'{"Id":"server","ServerName":"Fixture Ω","Version":"1"}',
		);
		const split = value.indexOf(0xce) + 1;
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(value.slice(0, split));
				controller.enqueue(value.slice(split));
				controller.close();
			},
		});
		vi.stubGlobal(
			"fetch",
			async () => new Response(body, { headers: { "Content-Type": "application/json" } }),
		);
		const client = new JellyfinClient("http://synthetic.invalid", "synthetic-token", log);
		await expect(client.getServerInfo()).resolves.toEqual({
			id: "server",
			serverName: "Fixture Ω",
			version: "1",
			operatingSystem: "",
		});
	});
});
