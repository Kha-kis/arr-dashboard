import { afterEach, describe, expect, it, vi } from "vitest";
import { AUTH_UNAUTHORIZED_EVENT, apiRequest, UnauthorizedError } from "../base";

afterEach(() => {
	vi.restoreAllMocks();
});

describe("apiRequest authentication boundary", () => {
	it("broadcasts a browser-wide signal before returning a 401 error", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 401 }));
		const unauthorized = vi.fn();
		window.addEventListener(AUTH_UNAUTHORIZED_EVENT, unauthorized, { once: true });

		await expect(apiRequest("/api/services")).rejects.toBeInstanceOf(UnauthorizedError);

		expect(unauthorized).toHaveBeenCalledTimes(1);
	});
});
