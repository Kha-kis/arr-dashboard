import { afterEach, describe, expect, it, vi } from "vitest";
import {
	acknowledgeProtectedUnauthorized,
	getPendingUnauthorizedRevision,
} from "../auth-session-signal";
import { apiRequest, BadRequestError } from "./base";

const jsonResponse = (body: unknown) =>
	new Response(JSON.stringify(body), {
		status: 200,
		headers: { "Content-Type": "application/json" },
	});

describe("apiRequest", () => {
	it("keeps the default malformed successful JSON behavior unchanged", async () => {
		vi.stubGlobal(
			"fetch",
			async () => new Response("{", { headers: { "content-type": "application/json" } }),
		);
		await expect(apiRequest("/api/example")).resolves.toBeUndefined();
	});
	it.each(["{", '{"removal":', ""])(
		"rejects unreadable opted-in successful JSON generically: %j",
		async (body) => {
			vi.stubGlobal(
				"fetch",
				async () => new Response(body, { headers: { "content-type": "application/json" } }),
			);
			await expect(apiRequest("/api/example", { requireJsonSuccess: true })).rejects.toMatchObject({
				name: "InvalidSuccessResponseError",
				message: "Request acknowledgment could not be verified.",
			});
		},
	);
	it("distinguishes a rejected JSON read from genuine204 and valid JSON", async () => {
		const response = jsonResponse({ removal: "completed", search: "submitted" });
		response.json = async () => {
			throw new Error("Synthetic private body failure");
		};
		vi.stubGlobal("fetch", async () => response);
		await expect(apiRequest("/api/example", { requireJsonSuccess: true })).rejects.toMatchObject({
			name: "InvalidSuccessResponseError",
			message: "Request acknowledgment could not be verified.",
		});
		vi.stubGlobal("fetch", async () => new Response(null, { status: 204 }));
		await expect(apiRequest("/api/example", { requireJsonSuccess: true })).resolves.toBeUndefined();
		vi.stubGlobal("fetch", async () => jsonResponse({ ok: true }));
		await expect(apiRequest("/api/example", { requireJsonSuccess: true })).resolves.toEqual({
			ok: true,
		});
	});
	it.each([400, 401, 500])(
		"retains HTTP%s errors when strict successful JSON is requested",
		async (status) => {
			vi.stubGlobal(
				"fetch",
				async () => new Response("{", { status, headers: { "content-type": "application/json" } }),
			);
			await expect(apiRequest("/api/example", { requireJsonSuccess: true })).rejects.toMatchObject({
				status,
			});
		},
	);
	it("preserves structured 400 evidence without changing its error class or making another request", async () => {
		const payload = {
			message: "Controlled test failure",
			failureCategory: "authentication",
			statusRecorded: false,
		};
		let requests = 0;
		vi.stubGlobal("fetch", async () => {
			requests++;
			return new Response(JSON.stringify(payload), {
				status: 400,
				headers: { "Content-Type": "application/json" },
			});
		});
		const request = apiRequest("/api/notifications/channels/synthetic/test", { method: "POST" });
		await expect(request).rejects.toBeInstanceOf(BadRequestError);
		await expect(request).rejects.toMatchObject({
			status: 400,
			message: "Controlled test failure",
			payload,
		});
		expect(requests).toBe(1);
	});

	it.each([
		null,
		{ message: { private: "synthetic" } },
		{ message: 12 },
		{ failureCategory: "timeout" },
	])(
		"malformed 400 messages retain a generic string rather than coercing provider data: %j",
		async (payload) => {
			vi.stubGlobal(
				"fetch",
				async () =>
					new Response(JSON.stringify(payload), {
						status: 400,
						headers: { "Content-Type": "application/json" },
					}),
			);
			await expect(apiRequest("/api/example")).rejects.toMatchObject({
				status: 400,
				message: "Bad Request",
				payload,
			});
		},
	);
	afterEach(() => {
		vi.unstubAllGlobals();
		acknowledgeProtectedUnauthorized(getPendingUnauthorizedRevision());
	});

	it("reports a 401 from session-required OIDC account actions, but not public login", async () => {
		vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 401 })));
		await expect(
			apiRequest("/auth/oidc/login", { method: "POST", json: { intent: "login" } }),
		).rejects.toMatchObject({ status: 401 });
		expect(getPendingUnauthorizedRevision()).toBe(0);
		await expect(
			apiRequest("/auth/oidc/login", { method: "POST", json: { intent: "link" } }),
		).rejects.toMatchObject({ status: 401 });
		expect(getPendingUnauthorizedRevision()).toBeGreaterThan(0);
	});

	it("sends body-less POST actions as explicit empty JSON", async () => {
		const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ running: true }));
		vi.stubGlobal("fetch", fetchMock);

		await apiRequest("/api/hunting/scheduler/toggle", { method: "POST" });

		expect(fetchMock).toHaveBeenCalledWith(
			"/api/hunting/scheduler/toggle",
			expect.objectContaining({
				method: "POST",
				headers: {
					Accept: "application/json",
					"Content-Type": "application/json",
				},
				body: "{}",
			}),
		);
	});

	it("leaves payload-free GET requests body-less", async () => {
		const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ ok: true }));
		vi.stubGlobal("fetch", fetchMock);

		await apiRequest("/api/status");

		expect(fetchMock).toHaveBeenCalledWith(
			"/api/status",
			expect.objectContaining({
				method: "GET",
				headers: { Accept: "application/json" },
				body: undefined,
			}),
		);
	});

	it("preserves caller-provided request bodies", async () => {
		const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ ok: true }));
		vi.stubGlobal("fetch", fetchMock);
		const body = new FormData();
		body.append("file", "contents");

		await apiRequest("/api/import", { method: "POST", body });

		expect(fetchMock).toHaveBeenCalledWith(
			"/api/import",
			expect.objectContaining({
				method: "POST",
				headers: { Accept: "application/json" },
				body,
			}),
		);
	});

	it("preserves backup maintenance conflict guidance from an error payload", async () => {
		const conflictMessage = "Database maintenance cannot overlap a library cleanup operation";
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue(
				new Response(JSON.stringify({ error: conflictMessage }), {
					status: 409,
					statusText: "Conflict",
					headers: { "Content-Type": "application/json" },
				}),
			),
		);

		await expect(apiRequest("/api/backup/create", { json: {} })).rejects.toMatchObject({
			message: conflictMessage,
			status: 409,
		});
	});

	it("prefers a structured message over an error fallback", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue(
				new Response(JSON.stringify({ message: "Detailed message", error: "Fallback" }), {
					status: 409,
					statusText: "Conflict",
					headers: { "Content-Type": "application/json" },
				}),
			),
		);

		await expect(apiRequest("/api/example")).rejects.toMatchObject({
			message: "Detailed message",
			status: 409,
		});
	});
});
