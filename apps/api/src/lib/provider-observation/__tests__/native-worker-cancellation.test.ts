import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { runNativeControlWorker } from "../native-control-worker-transport.js";
import { runPlexNativePageWorker } from "../../plex/plex-native-page-worker-transport.js";
import { runJellyfinNativePageWorker } from "../../jellyfin/jellyfin-native-page-worker-transport.js";

const connection = { baseUrl: "http://synthetic.invalid", apiKey: "synthetic" };
class FakeWorker extends EventEmitter {
	stdout = { resume() {} };
	stderr = { resume() {} };
	terminate = vi.fn<() => Promise<number>>().mockResolvedValue(1);
}
const paths = [
	{
		name: "control",
		run: (options: Parameters<typeof runNativeControlWorker>[1]) =>
			runNativeControlWorker(
				{
					...connection,
					provider: "plex",
					workKey: "paired",
					operation: "identity",
					deadlineAt: Date.now() + 5_000,
				},
				options,
			),
		result: { status: "identity", identity: "server" },
	},
	{
		name: "Plex page",
		run: (options: Parameters<typeof runPlexNativePageWorker>[1]) =>
			runPlexNativePageWorker(
				{
					...connection,
					domain: "library",
					sectionId: "1",
					startIndex: 0,
					limit: 1,
					deadlineAt: Date.now() + 5_000,
				},
				options,
			),
		result: { status: "page", domain: "library", startIndex: 0, totalRecordCount: 0, items: [] },
	},
	{
		name: "Jellyfin page",
		run: (options: Parameters<typeof runJellyfinNativePageWorker>[1]) =>
			runJellyfinNativePageWorker(
				{
					...connection,
					domain: "library",
					libraryId: "1",
					startIndex: 0,
					limit: 1,
					deadlineAt: Date.now() + 5_000,
				},
				options,
			),
		result: { status: "page", domain: "library", startIndex: 0, totalRecordCount: 0, items: [] },
	},
];

describe.each(paths)("$name cancellation ownership", ({ run, result }) => {
	it("does not spawn for an already aborted shutdown", async () => {
		const controller = new AbortController();
		controller.abort();
		const createWorker = vi.fn();
		await expect(run({ signal: controller.signal, createWorker })).rejects.toMatchObject({
			category: "cancelled",
		});
		expect(createWorker).not.toHaveBeenCalled();
	});
	it.each(["resolve", "reject", "throw"])(
		"discards provisional success and joins independent exit after termination %s",
		async (refusal) => {
			const controller = new AbortController(),
				worker = new FakeWorker();
			if (refusal === "reject") worker.terminate.mockRejectedValue(new Error("private"));
			if (refusal === "throw")
				worker.terminate.mockImplementation(() => {
					throw new Error("private");
				});
			const removed = vi.spyOn(controller.signal, "removeEventListener");
			let settled = false;
			const pending = run({ signal: controller.signal, createWorker: () => worker })
				.catch((error: unknown) => error)
				.finally(() => {
					settled = true;
				});
			worker.emit("message", result);
			controller.abort();
			await new Promise<void>((resolve) => setImmediate(resolve));
			expect(settled).toBe(false);
			expect(worker.terminate).toHaveBeenCalledOnce();
			worker.emit("exit", 0);
			expect(await pending).toMatchObject({ category: "cancelled" });
			expect(removed).toHaveBeenCalledOnce();
		},
	);
	it("releases only a clean exit and removes the shutdown listener", async () => {
		const controller = new AbortController(),
			worker = new FakeWorker();
		const removed = vi.spyOn(controller.signal, "removeEventListener");
		const pending = run({ signal: controller.signal, createWorker: () => worker });
		worker.emit("message", result);
		worker.emit("exit", 0);
		expect(await pending).toEqual(result);
		controller.abort();
		expect(worker.terminate).not.toHaveBeenCalled();
		expect(removed).toHaveBeenCalledOnce();
	});
});

it.each(["duplicate", "malformed", "nonzero", "missing", "error"])(
	"control fails closed for %s result/exit",
	async (failure) => {
		const worker = new FakeWorker();
		const pending = paths[0]!.run({ createWorker: () => worker }).catch((error: unknown) => error);
		if (failure !== "missing")
			worker.emit(
				"message",
				failure === "malformed" ? { status: "identity", identity: "" } : paths[0]!.result,
			);
		if (failure === "duplicate") worker.emit("message", paths[0]!.result);
		if (failure === "error") worker.emit("error", new Error("private"));
		worker.emit("exit", failure === "nonzero" ? 1 : 0);
		const error = await pending;
		expect(error).toBeInstanceOf(Error);
		expect(String(error)).not.toContain("private");
	},
);
