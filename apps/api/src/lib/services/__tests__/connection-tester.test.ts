/**
 * Pins the Seerr-specific permission probe added in #465.
 *
 * Why this test exists:
 *   Seerr's `/api/v1/status` is tagged `public` in its openapi spec and
 *   skips the `isAuthenticated` middleware. That means a Seerr instance
 *   whose API-key-backed user (user ID 1 by default, per
 *   `seerr/server/middleware/auth.ts`) has no usable permissions still
 *   passes the status probe — the connection check then reports
 *   "success" while every real feature call (Discover, Requests, Users)
 *   returns 403. We added a second probe to `/api/v1/request/count`
 *   to surface this misconfiguration at setup time. These tests pin
 *   that flow so a future refactor can't silently drop it.
 *
 *   For non-Seerr services, the second probe MUST NOT run — they don't
 *   share Seerr's user-1-permission semantic. Test that too.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { testServiceConnection } from "../connection-tester.js";

type FetchSpy = ReturnType<typeof vi.fn>;

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

describe("testServiceConnection — Seerr permission probe (#465)", () => {
	let fetchSpy: FetchSpy;

	beforeEach(() => {
		fetchSpy = vi.fn();
		vi.stubGlobal("fetch", fetchSpy);
	});

	afterEach(() => {
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
	});

	it("returns success when both /status and /request/count succeed", async () => {
		fetchSpy
			.mockResolvedValueOnce(jsonResponse({ version: "2.0.0" }))
			.mockResolvedValueOnce(jsonResponse({ pending: 0, approved: 0, available: 0 }));

		const result = await testServiceConnection("http://seerr:5055", "secret", "seerr");

		expect(result.success).toBe(true);
		expect(result.version).toBe("2.0.0");
		expect(fetchSpy.mock.calls[0]?.[0]).toBe("http://seerr:5055/api/v1/status");
		expect(fetchSpy.mock.calls[1]?.[0]).toBe("http://seerr:5055/api/v1/request/count");
	});

	it("returns the permission-specific error when /request/count returns 403", async () => {
		fetchSpy.mockResolvedValueOnce(jsonResponse({ version: "2.0.0" })).mockResolvedValueOnce(
			new Response(
				JSON.stringify({
					status: 403,
					error: "You do not have permission to access this endpoint",
				}),
				{ status: 403, headers: { "Content-Type": "application/json" } },
			),
		);

		const result = await testServiceConnection("http://seerr:5055", "secret", "seerr");

		expect(result.success).toBe(false);
		expect(result.error).toMatch(/lacks required permissions/i);
		// The detail must mention user ID 1 — that's the actionable diagnostic
		// per `seerr/server/middleware/auth.ts:13-22`. Without naming user 1,
		// operators won't know which user account to edit in Seerr.
		expect(result.details).toMatch(/user id 1/i);
		// The detail must also mention Seerr's Settings → Users path —
		// that's the operator's next step. If a refactor removes the path
		// guidance, this test fails before users get a useless error.
		expect(result.details).toMatch(/settings.+users/i);
		// Version from the first probe should still be reported so support
		// requests have it without re-asking.
		expect(result.version).toBe("2.0.0");
	});

	it("falls through to success when the permission probe fails with a non-403 status", async () => {
		// Rationale: the status probe already proved reachability + key
		// validity. A transient 500 or 429 on the second probe shouldn't
		// flunk the connection test — the user should still be allowed to
		// proceed, and any real problem will surface at feature-call time.
		fetchSpy
			.mockResolvedValueOnce(jsonResponse({ version: "2.0.0" }))
			.mockResolvedValueOnce(new Response("internal", { status: 500 }));

		const result = await testServiceConnection("http://seerr:5055", "secret", "seerr");

		expect(result.success).toBe(true);
		expect(result.version).toBe("2.0.0");
	});

	it("falls through to success when the permission probe throws (network blip)", async () => {
		// Same rationale as the non-403 case — don't fail the whole test
		// on a transient on the second hop.
		fetchSpy
			.mockResolvedValueOnce(jsonResponse({ version: "2.0.0" }))
			.mockRejectedValueOnce(new TypeError("fetch failed"));

		const result = await testServiceConnection("http://seerr:5055", "secret", "seerr");

		expect(result.success).toBe(true);
	});

	it("does NOT probe /request/count for non-Seerr services", async () => {
		// Only Seerr has the user-1-permission semantic. Probing
		// /request/count against Sonarr/Radarr/Prowlarr would either 404
		// or hit a totally unrelated endpoint.
		fetchSpy.mockResolvedValueOnce(jsonResponse({ version: "4.0.0" }));

		const result = await testServiceConnection("http://sonarr:8989", "secret", "sonarr");

		expect(result.success).toBe(true);
		expect(fetchSpy).toHaveBeenCalledTimes(1);
		expect(fetchSpy.mock.calls[0]?.[0]).toBe("http://sonarr:8989/api/v3/system/status");
	});

	it("still returns the existing /status error when the first probe fails (no second probe)", async () => {
		// 401 on the first probe should short-circuit — there's no point
		// probing a permission-gated endpoint when the API key itself is
		// rejected.
		fetchSpy.mockResolvedValueOnce(
			new Response("unauthorized", {
				status: 401,
				headers: { "Content-Type": "application/json" },
			}),
		);

		const result = await testServiceConnection("http://seerr:5055", "secret", "seerr");

		expect(result.success).toBe(false);
		expect(result.error).toMatch(/authentication failed/i);
		expect(fetchSpy).toHaveBeenCalledTimes(1);
	});
});
