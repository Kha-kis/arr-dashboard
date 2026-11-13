import { describe, expect, it, vi } from "vitest";
import {
	withCleanupOperationGuard,
	withExclusiveCleanupOperationGuard,
} from "../../../library-cleanup/cleanup-maintenance-gate.js";
import { acquireQueueSourceAction } from "../../../queue-cleaner/import-receipt.js";
import { withImportActionGuards } from "../action-guards.js";

describe("shared import action guards", () => {
	it("borrows a real owned source permit once without opening the source to another action", async () => {
		const permit = acquireQueueSourceAction("owner", { downloadId: "source" });
		if (!permit) throw new Error("Expected a synthetic source permit");
		try {
			await expect(
				withImportActionGuards(
					"owner",
					["source"],
					async () => {
						expect(acquireQueueSourceAction("owner", { downloadId: "source" })).toBeNull();
						return 7;
					},
					permit,
				),
			).resolves.toBe(7);
			await expect(
				withImportActionGuards("owner", ["source"], async () => 8, permit),
			).rejects.toMatchObject({ statusCode: 409 });
			expect(acquireQueueSourceAction("owner", { downloadId: "source" })).toBeNull();
		} finally {
			permit();
		}
		const release = acquireQueueSourceAction("owner", { downloadId: "source" });
		expect(release).not.toBeNull();
		release?.();
	});
	it("keeps a borrowed action protected after its parent requests release", async () => {
		const permit = acquireQueueSourceAction("owner", { downloadId: "detached-source" });
		if (!permit) throw new Error("Expected a synthetic source permit");
		let settle!: () => void;
		let announce!: () => void;
		const settlement = new Promise<void>((resolve) => {
			settle = resolve;
		});
		const started = new Promise<void>((resolve) => {
			announce = resolve;
		});
		const work = withImportActionGuards(
			"owner",
			["detached-source"],
			async () => {
				announce();
				await settlement;
			},
			permit,
		);
		try {
			await Promise.race([started, work]);
			permit();
			expect(acquireQueueSourceAction("owner", { downloadId: "detached-source" })).toBeNull();
			await expect(withExclusiveCleanupOperationGuard(async () => true)).rejects.toMatchObject({
				statusCode: 409,
			});
			await expect(
				withImportActionGuards("owner", ["detached-source"], async () => true, permit),
			).rejects.toMatchObject({ statusCode: 409 });
		} finally {
			settle();
			await work.catch(() => undefined);
			permit();
		}
		await expect(
			withImportActionGuards("owner", ["detached-source"], async () => true),
		).resolves.toBe(true);
	});
	it.each([
		{ owner: "different-owner", sources: ["source"] },
		{ owner: "owner", sources: ["different-source"] },
		{ owner: "owner", sources: ["source", "unowned-source"] },
	])(
		"rejects a permit for mismatched ownership or sources: $owner/$sources",
		async ({ owner, sources }) => {
			const permit = acquireQueueSourceAction("owner", { downloadId: "source" });
			if (!permit) throw new Error("Expected a synthetic source permit");
			const work = vi.fn();
			try {
				await expect(withImportActionGuards(owner, sources, work, permit)).rejects.toMatchObject({
					statusCode: 409,
				});
				expect(work).not.toHaveBeenCalled();
			} finally {
				permit();
			}
		},
	);
	it("rejects forged and released permits instead of falling back to ordinary acquisition", async () => {
		const work = vi.fn();
		await expect(
			withImportActionGuards("owner", ["source"], work, () => undefined),
		).rejects.toMatchObject({ statusCode: 409 });
		const permit = acquireQueueSourceAction("owner", { downloadId: "source" });
		if (!permit) throw new Error("Expected a synthetic source permit");
		permit();
		await expect(withImportActionGuards("owner", ["source"], work, permit)).rejects.toMatchObject({
			statusCode: 409,
		});
		expect(work).not.toHaveBeenCalled();
	});
	it("shares normalized source ownership with Queue Cleaner", async () => {
		const source = "A".repeat(40);
		const release = acquireQueueSourceAction("owner", { downloadId: source });
		expect(release).not.toBeNull();
		const execute = vi.fn();
		try {
			await expect(
				withImportActionGuards("owner", [source.toLowerCase()], execute),
			).rejects.toMatchObject({ statusCode: 409 });
			expect(execute).not.toHaveBeenCalled();
		} finally {
			release?.();
		}
		await withImportActionGuards("owner", [source], execute);
		expect(execute).toHaveBeenCalledOnce();
	});
	it("releases a partially acquired multi-source guard without executing", async () => {
		const release = acquireQueueSourceAction("owner", { downloadId: "second" });
		expect(release).not.toBeNull();
		const execute = vi.fn();
		try {
			await expect(withImportActionGuards("owner", ["first", "second"], execute)).rejects.toThrow();
			const firstRelease = acquireQueueSourceAction("owner", { downloadId: "first" });
			expect(firstRelease).not.toBeNull();
			firstRelease?.();
			expect(execute).not.toHaveBeenCalled();
		} finally {
			release?.();
		}
	});
	it("deduplicates hash aliases but not case-distinct opaque IDs", async () => {
		const hash = "A".repeat(40);
		await expect(
			withImportActionGuards("owner", [hash, hash.toLowerCase()], async () => 3),
		).resolves.toBe(3);
		await withImportActionGuards("owner", ["opaque-ID", "opaque-id"], async () => {
			expect(acquireQueueSourceAction("owner", { downloadId: "opaque-ID" })).toBeNull();
			expect(acquireQueueSourceAction("owner", { downloadId: "opaque-id" })).toBeNull();
		});
	});
	it("does not borrow another owner's source authority", async () => {
		await withImportActionGuards("owner-a", ["source"], async () => {
			await expect(withImportActionGuards("owner-b", ["source"], async () => 4)).resolves.toBe(4);
		});
	});
	it("releases guards after execution throws without changing the error", async () => {
		const error = new Error("synthetic operation failure");
		await expect(
			withImportActionGuards("owner", ["source"], async () => {
				throw error;
			}),
		).rejects.toBe(error);
		await expect(withImportActionGuards("owner", ["source"], async () => true)).resolves.toBe(true);
	});
	it("holds source and topology guards until actual detached work settles", async () => {
		let complete!: () => void;
		let announce!: () => void;
		const settlement = new Promise<void>((resolve) => {
			complete = resolve;
		});
		const started = new Promise<void>((resolve) => {
			announce = resolve;
		});
		let work!: Promise<void>;
		await withCleanupOperationGuard(async () => {
			work = withImportActionGuards("owner", ["held-source"], async () => {
				announce();
				await settlement;
			});
			await started;
		});
		try {
			expect(acquireQueueSourceAction("owner", { downloadId: "held-source" })).toBeNull();
			await expect(withExclusiveCleanupOperationGuard(async () => true)).rejects.toMatchObject({
				statusCode: 409,
			});
		} finally {
			complete();
			await work;
		}
		await expect(withExclusiveCleanupOperationGuard(async () => true)).resolves.toBe(true);
		await expect(withImportActionGuards("owner", ["held-source"], async () => true)).resolves.toBe(
			true,
		);
	});
	it("does not start a provider write while an exclusive topology operation is active", async () => {
		const execute = vi.fn();
		await withExclusiveCleanupOperationGuard(async () => {
			await expect(withImportActionGuards("owner", ["source"], execute)).rejects.toMatchObject({
				statusCode: 409,
			});
		});
		expect(execute).not.toHaveBeenCalled();
	});
	it.each(
		[[], [""], [" source "], Array.from({ length: 1001 }, (_, id) => String(id))].map(
			(sources) => ({ sources }),
		),
	)("rejects invalid or unbounded source acquisition", async ({ sources }) => {
		const execute = vi.fn();
		await expect(withImportActionGuards("owner", sources, execute)).rejects.toMatchObject({
			statusCode: 409,
		});
		expect(execute).not.toHaveBeenCalled();
	});
});
