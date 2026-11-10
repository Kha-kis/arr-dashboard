import { afterEach, expect, it, vi } from "vitest";
import { startRuntimeReadTiming } from "../../backup/restore-runtime-read-timing.js";
import { createJellyfinDisplayCheckpoint } from "../jellyfin-display-work.js";
import {
	fingerprintJellyfinLibraryDisplayRows,
	fingerprintJellyfinLibraryRows,
} from "../jellyfin-generation-metadata.js";
import {
	measureJellyfinDisplayReadPhase,
	startJellyfinDisplayReadPhase,
	withJellyfinDisplayReadTiming,
	type JellyfinDisplayReadTiming,
} from "../jellyfin-display-read-timing.js";

afterEach(() => vi.restoreAllMocks());
it("does not add clock reads or promise wrappers outside an opted-in read", () => {
	const clock = vi.spyOn(performance, "now").mockImplementation(() => {
		throw new Error("unexpected diagnostic");
	});
	expect(() => startJellyfinDisplayReadPhase("validate")()).not.toThrow();
	const original = Promise.resolve("original");
	expect(measureJellyfinDisplayReadPhase("validate", () => original)).toBe(original);
	expect(clock).not.toHaveBeenCalled();
});
it("emits bounded frozen counters with overlapping phases and existing runtime waits kept separate", async () => {
	let now = 0;
	vi.spyOn(performance, "now").mockImplementation(() => now);
	let result!: JellyfinDisplayReadTiming;
	expect(
		await withJellyfinDisplayReadTiming(
			async () => {
				const validate = startJellyfinDisplayReadPhase("validate");
				now = 2;
				const hash = startJellyfinDisplayReadPhase("fingerprint"),
					wait = startRuntimeReadTiming("yield");
				now = 7;
				hash();
				wait();
				validate();
				validate();
				await measureJellyfinDisplayReadPhase("validate", async () => {
					now = 10;
				});
				return "original";
			},
			(value) => {
				result = value;
			},
		),
	).toBe("original");
	expect(result.stages.validate).toEqual({ count: 2, totalMs: 10, maxMs: 7 });
	expect(result.stages.fingerprint).toEqual({ count: 1, totalMs: 5, maxMs: 5 });
	expect(result.runtime.yield).toEqual({ count: 1, totalMs: 5, maxMs: 5 });
	expect(Object.keys(result.stages).sort()).toEqual([
		"checkpoint-wait",
		"fingerprint",
		"materialize",
		"validate",
	]);
	expect(Object.isFrozen(result) && Object.isFrozen(result.stages)).toBe(true);
	expect(Object.values(result.stages).every(Object.isFrozen)).toBe(true);
});
it.each([false, true])(
	"preserves the original value or error even if diagnostics fail (failure=%s)",
	async (fails) => {
		const sentinel = new Error("synthetic-private-error");
		let result!: JellyfinDisplayReadTiming;
		const pending = withJellyfinDisplayReadTiming(
			() =>
				measureJellyfinDisplayReadPhase("materialize", () => {
					if (fails) throw sentinel;
					return Promise.resolve("original");
				}),
			(value) => {
				result = value;
				throw new Error("sink-failed");
			},
		);
		if (fails) await expect(pending).rejects.toBe(sentinel);
		else await expect(pending).resolves.toBe("original");
		expect(result.stages.materialize.count).toBe(1);
		expect(JSON.stringify(result)).not.toContain("synthetic");
		expect(JSON.stringify(result)).not.toContain("error");
	},
);
it("isolates concurrent scopes and ignores late inherited finishes", async () => {
	let now = 0;
	vi.spyOn(performance, "now").mockImplementation(() => now);
	let release!: () => void, late!: () => void;
	const held = new Promise<void>((done) => {
		release = done;
	});
	let first!: JellyfinDisplayReadTiming, second!: JellyfinDisplayReadTiming;
	const pending = withJellyfinDisplayReadTiming(
		async () => {
			const finish = startJellyfinDisplayReadPhase("materialize");
			late = startJellyfinDisplayReadPhase("fingerprint");
			await held;
			finish();
		},
		(v) => {
			first = v;
		},
	);
	now = 2;
	await withJellyfinDisplayReadTiming(
		async () => {
			const finish = startJellyfinDisplayReadPhase("validate");
			now = 7;
			finish();
		},
		(v) => {
			second = v;
		},
	);
	now = 10;
	release();
	await pending;
	now = 20;
	late();
	expect(first.stages.materialize).toEqual({ count: 1, totalMs: 10, maxMs: 10 });
	expect(first.stages.fingerprint.count).toBe(0);
	expect(first.stages.validate.count).toBe(0);
	expect(second.stages.validate).toEqual({ count: 1, totalMs: 5, maxMs: 5 });
	expect(second.stages.materialize.count).toBe(0);
});
it("preserves asynchronous rejection and discards nonfinite timing samples", async () => {
	let now = 0;
	vi.spyOn(performance, "now").mockImplementation(() => now);
	const sentinel = new Error("synthetic-private-rejection");
	let result!: JellyfinDisplayReadTiming;
	await expect(
		withJellyfinDisplayReadTiming(
			() =>
				measureJellyfinDisplayReadPhase("validate", async () => {
					now = Number.NaN;
					throw sentinel;
				}),
			(v) => {
				result = v;
			},
		),
	).rejects.toBe(sentinel);
	expect(result.stages.validate).toEqual({ count: 0, totalMs: 0, maxMs: 0 });
	expect(JSON.stringify(result)).not.toContain("synthetic");
});
it("restores parent scopes without attributing nested work twice", async () => {
	let now = 0;
	vi.spyOn(performance, "now").mockImplementation(() => now);
	let inner!: JellyfinDisplayReadTiming, outer!: JellyfinDisplayReadTiming;
	await withJellyfinDisplayReadTiming(
		async () => {
			await withJellyfinDisplayReadTiming(
				() =>
					measureJellyfinDisplayReadPhase("validate", async () => {
						now = 3;
					}),
				(v) => {
					inner = v;
				},
			);
			await measureJellyfinDisplayReadPhase("validate", async () => {
				now = 7;
			});
		},
		(v) => {
			outer = v;
		},
	);
	expect(inner.stages.validate.totalMs).toBe(3);
	expect(outer.stages.validate.totalMs).toBe(4);
});
it("observes real cooperative waits and full fingerprints without changing canonical bytes", async () => {
	const rows = [
		{
			tmdbId: 42,
			mediaType: "series" as const,
			libraryId: "synthetic-library",
			libraryName: "Synthetic",
			title: "Synthetic",
			jellyfinId: "synthetic-id",
			lastWatchedAt: null,
			watchCount: 0,
			watchedByUsers: "[]",
			onDeck: false,
			userRating: null,
			collections: "[]",
			addedAt: null,
			thumb: null,
		},
	];
	const expected = fingerprintJellyfinLibraryRows(rows);
	let result!: JellyfinDisplayReadTiming;
	const actual = await withJellyfinDisplayReadTiming(
		async () => {
			const checkpoint = createJellyfinDisplayCheckpoint();
			for (let i = 0; i < 256; i++) {
				const pause = checkpoint();
				if (pause) await pause;
			}
			return fingerprintJellyfinLibraryDisplayRows(rows);
		},
		(v) => {
			result = v;
		},
	);
	expect(actual).toBe(expected);
	expect(result.stages.fingerprint.count).toBe(1);
	expect(result.stages["checkpoint-wait"].count).toBeGreaterThanOrEqual(1);
});
