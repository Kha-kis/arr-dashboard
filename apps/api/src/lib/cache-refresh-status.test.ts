import { describe, expect, it } from "vitest";
import { assertCompleteCacheRefresh } from "./cache-refresh-status.js";

describe("assertCompleteCacheRefresh", () => {
	it("accepts only a fully published current generation", () => {
		expect(() =>
			assertCompleteCacheRefresh("plex", {
				complete: true,
				completedAt: new Date(),
				superseded: false,
			}),
		).not.toThrow();
	});

	it.each([
		[{ complete: false, completedAt: undefined, superseded: false }, "incomplete"],
		[{ complete: true, completedAt: undefined, superseded: false }, "not published"],
		[{ complete: false, completedAt: undefined, superseded: true }, "superseded"],
	])("rejects refresh evidence that is %s", (result, reason) => {
		expect(() => assertCompleteCacheRefresh("plex", result)).toThrow(reason);
	});
});
