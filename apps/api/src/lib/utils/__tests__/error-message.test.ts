import { describe, expect, it } from "vitest";
import { getErrorMessage } from "../error-message.js";

describe("getErrorMessage", () => {
	it("turns Node fetch connection causes into an actionable message", () => {
		const error = Object.assign(new TypeError("fetch failed"), {
			cause: Object.assign(new Error("connect ECONNREFUSED 192.0.2.1:8096"), {
				code: "ECONNREFUSED",
			}),
		});

		expect(getErrorMessage(error)).toBe("Connection refused by the configured host (ECONNREFUSED)");
	});

	it("does not expose an unknown nested fetch cause", () => {
		const error = Object.assign(new TypeError("fetch failed"), {
			cause: new Error("request to https://private.example/api failed"),
		});

		expect(getErrorMessage(error)).toBe("fetch failed");
	});

	it("preserves ordinary errors and fallbacks", () => {
		expect(getErrorMessage(new Error("ordinary failure"))).toBe("ordinary failure");
		expect(getErrorMessage(undefined, "fallback")).toBe("fallback");
	});
});
