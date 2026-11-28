/**
 * Pins provider-specific permission and authentication probes for Seerr (#465) and Jellyfin (#976).
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

describe("testServiceConnection provider probes (#465, #976)", () => {
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

	it("sends HTTP Basic Auth alongside the service API key on every Seerr probe", async () => {
		fetchSpy
			.mockResolvedValueOnce(jsonResponse({ version: "2.0.0" }))
			.mockResolvedValueOnce(jsonResponse({ pending: 0 }));

		await testServiceConnection("https://seerr.example.test", "secret", "seerr", {
			username: "proxy-user",
			password: "proxy-pass",
		});

		for (const call of fetchSpy.mock.calls) {
			const headers = call[1]?.headers as Record<string, string>;
			expect(headers.Authorization).toBe("Basic cHJveHktdXNlcjpwcm94eS1wYXNz");
			expect(headers["X-Api-Key"]).toBe("secret");
		}
	});

	it("rejects Basic Auth for Jellyfin without falling back to legacy auth headers", async () => {
		const result = await testServiceConnection("https://jellyfin.test", "api-key", "jellyfin", {
			username: "proxy-user",
			password: "proxy-pass",
		});

		expect(result.success).toBe(false);
		expect(result.error).toMatch(/not supported for jellyfin/i);
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it.each([
		[401, "Authentication failed (401)"],
		[403, "Access forbidden (403)"],
		[404, "Endpoint not found (404)"],
		[503, "Server error (503)"],
	])("rejects a protected Jellyfin probe that returns HTTP %i", async (status, error) => {
		fetchSpy
			.mockResolvedValueOnce(
				jsonResponse({ Id: "synthetic-jellyfin", ServerName: "Synthetic", Version: "12.4.0" }),
			)
			.mockResolvedValueOnce(new Response("synthetic protected-probe failure", { status }));

		const result = await testServiceConnection(
			"https://jellyfin.example.test",
			"synthetic-key",
			"jellyfin",
		);

		expect(result.success).toBe(false);
		expect(result.error).toBe(error);
		if (status === 401) {
			expect(result.details).toBe(
				"Invalid API key. Generate one in Jellyfin Dashboard > API Keys.",
			);
		}
		expect(fetchSpy).toHaveBeenCalledTimes(2);
		expect(fetchSpy.mock.calls[1]?.[0]).toBe("https://jellyfin.example.test/System/Info");
		expect(new Headers(fetchSpy.mock.calls[1]?.[1]?.headers).get("authorization")).toBe(
			'MediaBrowser Token="synthetic-key"',
		);
	});

	it("accepts a successful Jellyfin probe with the supported MediaBrowser token header", async () => {
		fetchSpy
			.mockResolvedValueOnce(
				jsonResponse({ Id: "synthetic-jellyfin", ServerName: "Synthetic", Version: "12.4.0" }),
			)
			.mockResolvedValueOnce(jsonResponse({ Id: "synthetic-jellyfin" }));

		const result = await testServiceConnection(
			"https://jellyfin.example.test",
			"synthetic-key",
			"jellyfin",
		);

		expect(result.success).toBe(true);
		expect(result.version).toBe("12.4.0");
		expect(new Headers(fetchSpy.mock.calls[1]?.[1]?.headers).get("authorization")).toBe(
			'MediaBrowser Token="synthetic-key"',
		);
	});

	it.each([200, 403])("keeps shared Emby probe behavior honest for HTTP %i", async (status) => {
		fetchSpy
			.mockResolvedValueOnce(jsonResponse({ Id: "synthetic-emby", Version: "4.9.1.0" }))
			.mockResolvedValueOnce(jsonResponse({ Id: "synthetic-emby" }, status));
		const result = await testServiceConnection(
			"https://emby.example.test",
			"synthetic-key",
			"emby",
		);
		expect(result.success).toBe(status === 200);
		expect(fetchSpy).toHaveBeenCalledTimes(2);
		expect(fetchSpy.mock.calls[1]?.[0]).toBe("https://emby.example.test/System/Info");
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

	it.each([
		[
			"html",
			() =>
				new Response("<html>Synthetic page</html>", { headers: { "content-type": "text/html" } }),
		],
		[
			"malformed JSON",
			() => new Response("{", { headers: { "content-type": "application/json" } }),
		],
		["missing identity", () => jsonResponse({ ServerName: "Synthetic", Version: "12.4.0" })],
		["different identity", () => jsonResponse({ Id: "different-synthetic-server" })],
		["blank identity", () => jsonResponse({ Id: "" })],
	] as const)(
		"refuses a protected 2xx with %s instead of usable server evidence",
		async (_kind, protectedResponse) => {
			fetchSpy
				.mockResolvedValueOnce(
					jsonResponse({
						Id: "synthetic-current-server",
						ServerName: "Synthetic",
						Version: "12.4.0",
					}),
				)
				.mockResolvedValueOnce(protectedResponse());

			const result = await testServiceConnection(
				"https://jellyfin.example.test",
				"synthetic-token",
				"jellyfin",
			);

			expect(result).toMatchObject({
				success: false,
				error: "Invalid authenticated server response",
			});
			expect(JSON.stringify(result)).not.toMatch(
				/synthetic-(current-server|token)|different-synthetic-server/,
			);
			expect(fetchSpy).toHaveBeenCalledTimes(2);
		},
	);

	it.each(["jellyfin", "emby"] as const)(
		"accepts the matching %s protected identity even when a proxy omits the JSON media type",
		async (service) => {
			fetchSpy
				.mockResolvedValueOnce(jsonResponse({ Id: "matching-server", Version: "10.11.11" }))
				.mockResolvedValueOnce(new Response(JSON.stringify({ Id: "matching-server" })));

			const result = await testServiceConnection(
				"https://media.example.test",
				"synthetic-token",
				service,
			);

			expect(result).toMatchObject({ success: true, version: "10.11.11" });
			expect(fetchSpy).toHaveBeenCalledTimes(2);
		},
	);

	it("includes the protected response body in the existing deadline", async () => {
		const lifetime = new AbortController();
		const abortTimeout = vi
			.spyOn(AbortSignal, "timeout")
			.mockReturnValueOnce(new AbortController().signal)
			.mockReturnValueOnce(lifetime.signal);
		let startBody!: () => void;
		const bodyStarted = new Promise<void>((resolve) => {
			startBody = resolve;
		});
		const cancel = vi.fn();
		const body = new ReadableStream({ pull: startBody, cancel }, { highWaterMark: 0 });
		fetchSpy
			.mockResolvedValueOnce(jsonResponse({ Id: "matching-server" }))
			.mockResolvedValueOnce(new Response(body));

		try {
			const outcome = testServiceConnection(
				"https://media.example.test",
				"synthetic-token",
				"jellyfin",
			);
			await bodyStarted;
			lifetime.abort();
			await expect(outcome).resolves.toMatchObject({
				success: false,
				error: "Invalid authenticated server response",
			});
			expect(abortTimeout.mock.calls).toEqual([[5000], [5000]]);
			expect(cancel).toHaveBeenCalledTimes(1);
		} finally {
			abortTimeout.mockRestore();
		}
	});
});
