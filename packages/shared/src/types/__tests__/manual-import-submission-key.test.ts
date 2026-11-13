import { describe, expect, it } from "vitest";
import { manualImportSubmissionSchema } from "../manual-import.js";

const submission = {
	instanceId: "instance",
	service: "radarr",
	files: [{ path: "/synthetic/file", downloadId: "source", movieId: 12 }],
};

describe("manual import attempt identity", () => {
	it("preserves an explicit key rather than silently stripping replay protection", () => {
		expect(
			manualImportSubmissionSchema.parse({ ...submission, idempotencyKey: "attempt-1" }),
		).toHaveProperty("idempotencyKey", "attempt-1");
	});
	it("accepts older clients without inventing a new attempt key", () => {
		expect(manualImportSubmissionSchema.parse(submission)).not.toHaveProperty("idempotencyKey");
	});
	it.each(["", " ", " attempt", "attempt ", "a/b", "x".repeat(129), 12, null])(
		"rejects malformed explicit attempt identity (%j)",
		(idempotencyKey) => {
			expect(
				manualImportSubmissionSchema.safeParse({ ...submission, idempotencyKey }).success,
			).toBe(false);
		},
	);
});
