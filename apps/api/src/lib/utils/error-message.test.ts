import { describe, expect, it } from "vitest";
import { getErrorMessage } from "./error-message.js";

function fetchFailure(code: string): Error {
	const error = new Error("fetch failed");
	error.cause = { code };
	return error;
}

describe("getErrorMessage network diagnostics", () => {
	it.each([
		"DEPTH_ZERO_SELF_SIGNED_CERT",
		"SELF_SIGNED_CERT_IN_CHAIN",
		"UNABLE_TO_VERIFY_LEAF_SIGNATURE",
	])("provides certificate guidance for %s", (code) => {
		expect(getErrorMessage(fetchFailure(code))).toBe(
			"The configured host's TLS certificate could not be verified",
		);
	});

	it("identifies an expired certificate", () => {
		expect(getErrorMessage(fetchFailure("CERT_HAS_EXPIRED"))).toBe(
			"The configured host's TLS certificate has expired",
		);
	});
});
