import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { acknowledgeSyncReview, createSyncProgressStream } from "./sync";

class FakeEventSource {
	static last: FakeEventSource | null = null;
	onmessage: ((event: MessageEvent) => void) | null = null;
	onerror: ((event: Event) => void) | null = null;
	close = vi.fn();

	constructor(public readonly url: string) {
		FakeEventSource.last = this;
	}

	dispatchMessage(data: unknown): void {
		this.onmessage?.({ data: JSON.stringify(data) } as MessageEvent);
	}
}

describe("createSyncProgressStream", () => {
	const originalEventSource = globalThis.EventSource;

	beforeEach(() => {
		vi.useFakeTimers();
		FakeEventSource.last = null;
		globalThis.EventSource = FakeEventSource as unknown as typeof EventSource;
	});

	afterEach(() => {
		vi.useRealTimers();
		globalThis.EventSource = originalEventSource;
	});

	it("closes the stream after an uncertain terminal result", () => {
		const onProgress = vi.fn();
		createSyncProgressStream("sync-1", onProgress);
		const source = FakeEventSource.last;
		expect(source).not.toBeNull();

		source!.dispatchMessage({ status: "UNCERTAIN", progress: 100 });

		expect(onProgress).toHaveBeenCalledWith({ status: "UNCERTAIN", progress: 100 });
		expect(source!.close).not.toHaveBeenCalled();
		vi.advanceTimersByTime(1000);
		expect(source!.close).toHaveBeenCalledOnce();
	});
});

describe("acknowledgeSyncReview", () => {
	it("posts to the backup-less uncertainty acknowledgement endpoint", async () => {
		const responseBody = {
			success: true,
			status: "FAILED" as const,
			message: "Manual review acknowledged. No automatic rollback was performed.",
		};
		const fetchMock = vi.fn().mockResolvedValue(
			new Response(JSON.stringify(responseBody), {
				status: 200,
				headers: { "content-type": "application/json" },
			}),
		);
		vi.stubGlobal("fetch", fetchMock);

		await expect(acknowledgeSyncReview("sync-1")).resolves.toEqual(responseBody);
		expect(fetchMock).toHaveBeenCalledWith(
			"/api/trash-guides/sync/sync-1/acknowledge-review",
			expect.objectContaining({ method: "POST", body: "{}" }),
		);

		vi.unstubAllGlobals();
	});
});
