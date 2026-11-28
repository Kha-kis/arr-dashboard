import { describe, expect, it } from "vitest";
import { retryJellyfinSnapshotTransaction } from "../jellyfin-snapshot-transaction.js";

describe("bounded Jellyfin snapshot transaction retry", () => {
	it("returns ordinary transaction success without repeating it", async () => {
		let calls = 0;
		await expect(
			retryJellyfinSnapshotTransaction(async () => {
				calls += 1;
				return 42;
			}),
		).resolves.toBe(42);
		expect(calls).toBe(1);
	});
	it("can recover after three obsolete snapshots using four distinct transaction factory calls", async () => {
		let calls = 0;
		const snapshot = Object.assign(new Error("synthetic private detail"), {
			code: "SQLITE_BUSY_SNAPSHOT",
		});
		await expect(
			retryJellyfinSnapshotTransaction(async () => {
				calls += 1;
				if (calls <= 3) throw snapshot;
				return "committed";
			}),
		).resolves.toBe("committed");
		expect(calls).toBe(4);
	});
	it("exhausts its budget and preserves the actual final error", async () => {
		let calls = 0;
		const snapshot = Object.assign(new Error("synthetic private detail"), {
			code: "SQLITE_BUSY_SNAPSHOT",
		});
		await expect(
			retryJellyfinSnapshotTransaction(async () => {
				calls += 1;
				throw snapshot;
			}),
		).rejects.toBe(snapshot);
		expect(calls).toBe(4);
	});
	it.each(["SQLITE_BUSY", "SQLITE_LOCKED", "P2028", "sqlite_busy_snapshot", "other"])(
		"never retries non-snapshot code %s",
		async (code) => {
			let calls = 0;
			const failure = Object.assign(new Error("synthetic private detail"), { code });
			await expect(
				retryJellyfinSnapshotTransaction(async () => {
					calls += 1;
					throw failure;
				}),
			).rejects.toBe(failure);
			expect(calls).toBe(1);
		},
	);
	it("does not invoke an error accessor or replace its original error", async () => {
		let calls = 0,
			reads = 0;
		const failure = Object.defineProperty({}, "code", {
			get() {
				reads += 1;
				throw new Error("private");
			},
		});
		await expect(
			retryJellyfinSnapshotTransaction(async () => {
				calls += 1;
				throw failure;
			}),
		).rejects.toBe(failure);
		expect(calls).toBe(1);
		expect(reads).toBe(0);
	});
	it("does not infer retry permission from inherited or non-primitive codes", async () => {
		for (const failure of [
			Object.create({ code: "SQLITE_BUSY_SNAPSHOT" }),
			{ code: { toString: () => "SQLITE_BUSY_SNAPSHOT" } },
			null,
			"SQLITE_BUSY_SNAPSHOT",
		]) {
			let calls = 0;
			await expect(
				retryJellyfinSnapshotTransaction(async () => {
					calls += 1;
					throw failure;
				}),
			).rejects.toBe(failure);
			expect(calls).toBe(1);
		}
	});
});
