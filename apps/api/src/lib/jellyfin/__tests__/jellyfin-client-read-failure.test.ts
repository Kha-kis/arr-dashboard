import type { FastifyBaseLogger } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { UpstreamValidationError } from "../../validation/parse-upstream.js";
import { JellyfinClient } from "../jellyfin-client.js";
import { jellyfinServerInfoSchema } from "../jellyfin-schemas.js";

// All identities, credentials, response bodies, and errors here are synthetic.
const PRIVATE_SENTINEL = "synthetic-private-read-sentinel";
const serverInfo = { Id: "server-1", ServerName: "Synthetic server", Version: "1.0" };

function setup() {
	const warn = vi.fn();
	const client = new JellyfinClient(`http://${PRIVATE_SENTINEL}.test`, PRIVATE_SENTINEL, {
		warn,
	} as unknown as FastifyBaseLogger);
	const fetchMock = vi.fn();
	vi.stubGlobal("fetch", fetchMock);
	return { client, warn, fetchMock };
}

function jsonResponse(body: unknown = serverInfo) {
	const response = new Response(JSON.stringify(body), {
		headers: { "Content-Type": "application/json" },
	});
	return { response };
}

function failedBodyResponse(error: unknown) {
	return new Response(
		new ReadableStream<Uint8Array>({
			pull(controller) {
				controller.error(error);
			},
		}),
		{ headers: { "Content-Type": "application/json" } },
	);
}

function expectDiagnostic(
	warn: ReturnType<typeof vi.fn>,
	expected: { phase: string; kind: string; status?: number | null; transportCode?: string | null },
) {
	const calls = warn.mock.calls.filter(
		([fields]) => fields?.category === "jellyfin-provider-read-failure",
	);
	expect(calls).toHaveLength(1);
	const [fields, message] = calls[0]!;
	expect(fields).toEqual({
		category: "jellyfin-provider-read-failure",
		phase: expected.phase,
		kind: expected.kind,
		status: expected.status ?? null,
		transportCode: expected.transportCode ?? null,
		elapsedMs: expect.any(Number),
	});
	expect(Number.isSafeInteger(fields.elapsedMs)).toBe(true);
	expect(fields.elapsedMs).toBeGreaterThanOrEqual(0);
	expect(message).toBe("Jellyfin provider read failed");
	expect(JSON.stringify(calls)).not.toContain(PRIVATE_SENTINEL);
	return fields;
}

describe("JellyfinClient closed provider read diagnostics", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
	});

	it.each([
		["direct code", Object.assign(new TypeError(PRIVATE_SENTINEL), { code: "ECONNRESET" })],
		[
			"one cause code",
			new TypeError(PRIVATE_SENTINEL, { cause: { code: "ECONNRESET", secret: PRIVATE_SENTINEL } }),
		],
	])("records request transport failure with %s and preserves the exception", async (_, error) => {
		const { client, warn, fetchMock } = setup();
		fetchMock.mockRejectedValue(error);

		await expect(client.getServerInfo()).rejects.toBe(error);

		expectDiagnostic(warn, { phase: "request", kind: "transport", transportCode: "ECONNRESET" });
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it.each([
		["TimeoutError", "timeout"],
		["AbortError", "aborted"],
	])("records request %s without changing its identity", async (name, kind) => {
		const { client, warn, fetchMock } = setup();
		const error = new DOMException(PRIVATE_SENTINEL, name);
		fetchMock.mockRejectedValue(error);

		await expect(client.getServerInfo()).rejects.toBe(error);

		expectDiagnostic(warn, { phase: "request", kind });
	});

	it.each([
		["body abort", new DOMException(PRIVATE_SENTINEL, "AbortError"), "aborted"],
		["body timeout", new DOMException(PRIVATE_SENTINEL, "TimeoutError"), "timeout"],
		[
			"body transport",
			new TypeError(PRIVATE_SENTINEL, { cause: { code: "UND_ERR_SOCKET" } }),
			"transport",
		],
		["malformed JSON", new SyntaxError(PRIVATE_SENTINEL), "invalid-json"],
		["unknown body error", new Error(PRIVATE_SENTINEL), "unavailable"],
	])("observes %s and returns an accurate safe body error", async (_, error, kind) => {
		const { client, warn, fetchMock } = setup();
		const response = failedBodyResponse(error);
		fetchMock.mockResolvedValue(response);

		const rejection = await client.getServerInfo().catch((error: unknown) => error);
		expect(rejection).toMatchObject({
			message:
				kind === "timeout"
					? "Jellyfin response body timed out"
					: kind === "transport"
						? "Jellyfin response body transport failed"
						: "Jellyfin API returned invalid JSON",
		});
		expect(rejection).not.toHaveProperty("cause");
		expect(JSON.stringify(rejection)).not.toContain(PRIVATE_SENTINEL);

		expectDiagnostic(warn, {
			phase: "body",
			kind,
			status: 200,
			transportCode: kind === "transport" ? "UND_ERR_SOCKET" : null,
		});
		expect(response.bodyUsed).toBe(true);
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("records real JSON syntax rejection without another body read", async () => {
		const { client, warn, fetchMock } = setup();
		const response = new Response(`{${PRIVATE_SENTINEL}`, {
			headers: { "Content-Type": "application/json" },
		});
		fetchMock.mockResolvedValue(response);

		await expect(client.getServerInfo()).rejects.toThrow("Jellyfin API returned invalid JSON");

		expectDiagnostic(warn, { phase: "body", kind: "invalid-json", status: 200 });
		expect(response.bodyUsed).toBe(true);
	});

	it("records schema rejection without persisting its private payload in the warning", async () => {
		const { client, warn, fetchMock } = setup();
		const { response } = jsonResponse({ ServerName: PRIVATE_SENTINEL });
		fetchMock.mockResolvedValue(response);

		await expect(client.getServerInfo()).rejects.toBeInstanceOf(UpstreamValidationError);

		expectDiagnostic(warn, { phase: "validation", kind: "schema", status: 200 });
		expect(response.bodyUsed).toBe(true);
	});

	it("preserves unexpected validation exceptions without calling them schema failures", async () => {
		const { client, warn, fetchMock } = setup();
		const error = Object.assign(new Error(PRIVATE_SENTINEL), { name: "UpstreamValidationError" });
		vi.spyOn(jellyfinServerInfoSchema, "safeParse").mockImplementationOnce(() => {
			throw error;
		});
		fetchMock.mockResolvedValue(jsonResponse().response);

		await expect(client.getServerInfo()).rejects.toBe(error);

		expectDiagnostic(warn, { phase: "validation", kind: "unavailable", status: 200 });
	});

	it("records unexpected content type without reading its body", async () => {
		const { client, warn, fetchMock } = setup();
		const response = new Response(PRIVATE_SENTINEL, { headers: { "Content-Type": "text/html" } });
		const json = vi.spyOn(response, "json");
		const text = vi.spyOn(response, "text");
		fetchMock.mockResolvedValue(response);

		await expect(client.getServerInfo()).rejects.toThrow(
			"Jellyfin API returned an unexpected response type",
		);

		expectDiagnostic(warn, { phase: "response", kind: "unexpected-content-type", status: 200 });
		expect(json).not.toHaveBeenCalled();
		expect(text).not.toHaveBeenCalled();
		expect(response.bodyUsed).toBe(false);
	});

	it("retains the HTTP warning and error and adds only the bounded failure status", async () => {
		const { client, warn, fetchMock } = setup();
		const response = new Response(PRIVATE_SENTINEL, { status: 503 });
		const json = vi.spyOn(response, "json");
		fetchMock.mockResolvedValue(response);

		await expect(client.getServerInfo()).rejects.toThrow("Jellyfin API request failed: HTTP 503");

		expectDiagnostic(warn, { phase: "response", kind: "http-error", status: 503 });
		expect(warn).toHaveBeenCalledWith({ status: 503 }, "Jellyfin API request failed");
		expect(json).not.toHaveBeenCalled();
		expect(response.bodyUsed).toBe(false);
	});

	it.each([
		["private code", { code: PRIVATE_SENTINEL, cause: { secret: PRIVATE_SENTINEL } }],
		["nested code", { cause: { cause: { code: "ECONNRESET" } } }],
		["private primitive", PRIVATE_SENTINEL],
		["null rejection", null],
	])("keeps %s unavailable and private", async (_, error) => {
		const { client, warn, fetchMock } = setup();
		fetchMock.mockRejectedValue(error);

		await expect(client.getServerInfo()).rejects.toBe(error);

		expectDiagnostic(warn, { phase: "request", kind: "unavailable" });
	});

	it.each(["name", "code", "cause"])(
		"ignores hostile %s getters without replacing the rejection",
		async (key) => {
			const { client, warn, fetchMock } = setup();
			const error = Object.defineProperty({}, key, {
				get() {
					throw new Error(PRIVATE_SENTINEL);
				},
			});
			fetchMock.mockRejectedValue(error);

			await expect(client.getServerInfo()).rejects.toBe(error);

			expectDiagnostic(warn, { phase: "request", kind: "unavailable" });
		},
	);

	it("does not read exception messages, stacks, bodies, or stringify hooks", async () => {
		const { client, warn, fetchMock } = setup();
		const privateGetter = vi.fn(() => {
			throw new Error(PRIVATE_SENTINEL);
		});
		const error = Object.defineProperties(new TypeError(PRIVATE_SENTINEL), {
			message: { get: privateGetter },
			stack: { get: privateGetter },
			body: { get: privateGetter },
			toJSON: { get: privateGetter },
		});
		fetchMock.mockRejectedValue(error);

		await expect(client.getServerInfo()).rejects.toBe(error);

		expectDiagnostic(warn, { phase: "request", kind: "transport" });
		expect(privateGetter).not.toHaveBeenCalled();
	});

	it("does not let a throwing diagnostic logger replace a request rejection", async () => {
		const { client, warn, fetchMock } = setup();
		const error = new TypeError(PRIVATE_SENTINEL);
		warn.mockImplementation(() => {
			throw new Error("synthetic logger failure");
		});
		fetchMock.mockRejectedValue(error);

		await expect(client.getServerInfo()).rejects.toBe(error);
		expect(warn).toHaveBeenCalledTimes(1);
	});

	it("does not let a throwing diagnostic logger replace the generic body error", async () => {
		const { client, warn, fetchMock } = setup();
		const response = failedBodyResponse(new DOMException(PRIVATE_SENTINEL, "AbortError"));
		warn.mockImplementation(() => {
			throw new Error("synthetic logger failure");
		});
		fetchMock.mockResolvedValue(response);

		await expect(client.getServerInfo()).rejects.toThrow("Jellyfin API returned invalid JSON");
		expect(warn).toHaveBeenCalledTimes(1);
	});

	it("records elapsed time as a finite nonnegative integer", async () => {
		const { client, warn, fetchMock } = setup();
		vi.spyOn(performance, "now").mockReturnValueOnce(100).mockReturnValueOnce(122.8);
		fetchMock.mockRejectedValue(new TypeError(PRIVATE_SENTINEL));

		await expect(client.getServerInfo()).rejects.toBeInstanceOf(TypeError);

		expect(expectDiagnostic(warn, { phase: "request", kind: "transport" }).elapsedMs).toBe(22);
	});

	it("returns the same successful result with one body read and no failure warning", async () => {
		const { client, warn, fetchMock } = setup();
		const { response } = jsonResponse();
		fetchMock.mockResolvedValue(response);

		await expect(client.getServerInfo()).resolves.toEqual({
			id: "server-1",
			serverName: "Synthetic server",
			version: "1.0",
			operatingSystem: "",
		});

		expect(warn).not.toHaveBeenCalled();
		expect(response.bodyUsed).toBe(true);
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("does not add read diagnostics to a POST request failure", async () => {
		const { client, warn, fetchMock } = setup();
		const error = new TypeError(PRIVATE_SENTINEL);
		fetchMock.mockRejectedValue(error);

		await expect(client.refreshLibrary()).rejects.toBe(error);

		expect(warn).not.toHaveBeenCalled();
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(fetchMock.mock.calls[0]?.[1]?.method).toBe("POST");
	});
});
