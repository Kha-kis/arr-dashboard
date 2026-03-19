/**
 * Unit tests for withSeerrRetry.
 */

import { describe, expect, it, vi } from "vitest";
import { SeerrApiError } from "../../errors.js";
import { withSeerrRetry } from "../seerr-retry.js";

describe("withSeerrRetry", () => {
	it("returns immediately on first success", async () => {
		const fn = vi.fn().mockResolvedValue("ok");
		const result = await withSeerrRetry(fn, { maxAttempts: 3, baseDelayMs: 1 });
		expect(result).toBe("ok");
		expect(fn).toHaveBeenCalledTimes(1);
	});

	it("retries on 503 and succeeds", async () => {
		const fn = vi
			.fn()
			.mockRejectedValueOnce(new SeerrApiError("503", { seerrStatus: 503 }))
			.mockResolvedValue("ok");
		const result = await withSeerrRetry(fn, { maxAttempts: 3, baseDelayMs: 1 });
		expect(result).toBe("ok");
		expect(fn).toHaveBeenCalledTimes(2);
	});

	it("does NOT retry on 404 (non-retryable)", async () => {
		const fn = vi
			.fn()
			.mockRejectedValue(new SeerrApiError("404", { seerrStatus: 404 }));
		await expect(
			withSeerrRetry(fn, { maxAttempts: 3, baseDelayMs: 1 }),
		).rejects.toThrow(SeerrApiError);
		expect(fn).toHaveBeenCalledTimes(1);
	});

	it("exhausts max attempts then throws", async () => {
		const fn = vi
			.fn()
			.mockRejectedValue(new SeerrApiError("500", { seerrStatus: 500 }));
		await expect(
			withSeerrRetry(fn, { maxAttempts: 3, baseDelayMs: 1 }),
		).rejects.toThrow(SeerrApiError);
		expect(fn).toHaveBeenCalledTimes(3);
	});

	it("honours Retry-After on 429", async () => {
		const err429 = new SeerrApiError("429", {
			seerrStatus: 429,
			retryAfterMs: 50, // 50ms
		});
		const fn = vi
			.fn()
			.mockRejectedValueOnce(err429)
			.mockResolvedValue("ok");

		const start = Date.now();
		const result = await withSeerrRetry(fn, { maxAttempts: 3, baseDelayMs: 1 });
		const elapsed = Date.now() - start;

		expect(result).toBe("ok");
		expect(elapsed).toBeGreaterThanOrEqual(40); // Allow 10ms tolerance
	});

	it("retries on network errors", async () => {
		const networkErr = new Error("fetch failed: ECONNREFUSED");
		const fn = vi
			.fn()
			.mockRejectedValueOnce(networkErr)
			.mockResolvedValue("ok");
		const result = await withSeerrRetry(fn, { maxAttempts: 3, baseDelayMs: 1 });
		expect(result).toBe("ok");
		expect(fn).toHaveBeenCalledTimes(2);
	});

	it("does not retry non-retryable non-SeerrApiError", async () => {
		const fn = vi.fn().mockRejectedValue(new Error("something unrelated"));
		await expect(
			withSeerrRetry(fn, { maxAttempts: 3, baseDelayMs: 1 }),
		).rejects.toThrow("something unrelated");
		expect(fn).toHaveBeenCalledTimes(1);
	});

	it("retries on timeout errors", async () => {
		const fn = vi
			.fn()
			.mockRejectedValueOnce(SeerrApiError.timeout("timed out"))
			.mockResolvedValue("ok");
		const result = await withSeerrRetry(fn, { maxAttempts: 3, baseDelayMs: 1 });
		expect(result).toBe("ok");
		expect(fn).toHaveBeenCalledTimes(2);
	});
});
