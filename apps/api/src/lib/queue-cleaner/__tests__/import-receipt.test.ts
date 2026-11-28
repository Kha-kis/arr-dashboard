import { describe, expect, it } from "vitest";
import { acquireQueueSourceAction } from "../import-receipt.js";

describe("shared queue source action guard", () => {
	it.each([40, 64])(
		"treats case variants of a %i-character info hash as the same owner's source",
		(length) => {
			const release = acquireQueueSourceAction("fixture-owner", { downloadId: "A".repeat(length) });
			const otherOwner = acquireQueueSourceAction("fixture-other", {
				downloadId: "a".repeat(length),
			});
			try {
				expect(release).not.toBeNull();
				expect(otherOwner).not.toBeNull();
				expect(
					acquireQueueSourceAction("fixture-owner", { downloadId: "a".repeat(length) }),
				).toBeNull();
			} finally {
				release?.();
				otherOwner?.();
			}
			// A repeated release must not accidentally release a subsequent holder.
			const next = acquireQueueSourceAction("fixture-owner", { downloadId: "a".repeat(length) });
			try {
				expect(next).not.toBeNull();
				release?.();
				expect(
					acquireQueueSourceAction("fixture-owner", { downloadId: "a".repeat(length) }),
				).toBeNull();
			} finally {
				next?.();
			}
		},
	);

	it("does not collapse opaque provider IDs that differ by case", () => {
		const first = acquireQueueSourceAction("fixture-owner", { downloadId: "opaque-ID" });
		const second = acquireQueueSourceAction("fixture-owner", { downloadId: "opaque-id" });
		try {
			expect(first).not.toBeNull();
			expect(second).not.toBeNull();
		} finally {
			first?.();
			second?.();
		}
	});
});
