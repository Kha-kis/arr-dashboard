import { afterEach, describe, expect, it, vi } from "vitest";
import { apiRequest } from "./base";

const jsonResponse = (body: unknown) =>
	new Response(JSON.stringify(body), {
		status: 200,
		headers: { "Content-Type": "application/json" },
	});

describe("apiRequest", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
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
