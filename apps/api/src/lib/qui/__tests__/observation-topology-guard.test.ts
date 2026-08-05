import { describe, expect, it, vi } from "vitest";
import { withQuiObservationTopologyGuard } from "../observation-topology-guard.js";

function deferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

describe("withQuiObservationTopologyGuard", () => {
	it("serializes observation writes and topology mutations for the same user", async () => {
		const firstBlocked = deferred();
		const firstStarted = deferred();
		const second = vi.fn(async () => "mutation-complete");

		const firstPromise = withQuiObservationTopologyGuard("user-1", async () => {
			firstStarted.resolve();
			await firstBlocked.promise;
			return "sync-complete";
		});
		await firstStarted.promise;

		const secondPromise = withQuiObservationTopologyGuard("user-1", second);
		await Promise.resolve();
		expect(second).not.toHaveBeenCalled();

		firstBlocked.resolve();
		await expect(firstPromise).resolves.toBe("sync-complete");
		await expect(secondPromise).resolves.toBe("mutation-complete");
		expect(second).toHaveBeenCalledOnce();
	});

	it("does not serialize independent users", async () => {
		const firstBlocked = deferred();
		const firstStarted = deferred();
		const second = vi.fn(async () => "other-user-complete");

		const firstPromise = withQuiObservationTopologyGuard("user-1", async () => {
			firstStarted.resolve();
			await firstBlocked.promise;
		});
		await firstStarted.promise;

		await expect(withQuiObservationTopologyGuard("user-2", second)).resolves.toBe(
			"other-user-complete",
		);
		expect(second).toHaveBeenCalledOnce();

		firstBlocked.resolve();
		await firstPromise;
	});

	it("releases the next operation when the current operation fails", async () => {
		const expected = new Error("sync failed");

		await expect(
			withQuiObservationTopologyGuard("user-1", async () => {
				throw expected;
			}),
		).rejects.toBe(expected);
		await expect(
			withQuiObservationTopologyGuard("user-1", async () => "mutation-complete"),
		).resolves.toBe("mutation-complete");
	});
});
