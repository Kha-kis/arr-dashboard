/**
 * SABnzbd JSON API client.
 *
 * The API key is required in the query string by SABnzbd. Never log the
 * request URL or re-follow a redirect, which could disclose that key.
 */
export const SABNZBD_REQUEST_TIMEOUT_MS = 8_000;
export const SABNZBD_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

export class SabnzbdClientError extends Error {
	constructor(
		readonly category: "network" | "authentication" | "http" | "format" | "response-size",
		message: string,
		readonly status?: number,
	) {
		super(message);
		this.name = "SabnzbdClientError";
	}
}

export async function sabCall(
	baseUrl: string,
	apiKey: string,
	params: Record<string, string>,
	options: { headers?: HeadersInit } = {},
): Promise<unknown> {
	const url = new URL(`${baseUrl.replace(/\/+$/, "")}/api`);
	if (!["http:", "https:"].includes(url.protocol)) {
		throw new Error("SABnzbd URL must use HTTP or HTTPS");
	}
	url.searchParams.set("output", "json");
	url.searchParams.set("apikey", apiKey);
	for (const [key, value] of Object.entries(params)) {
		url.searchParams.set(key, value);
	}

	const headers = new Headers(options.headers);
	headers.set("Accept", "application/json");
	let response: Response;
	try {
		response = await fetch(url, {
			headers,
			signal: AbortSignal.timeout(SABNZBD_REQUEST_TIMEOUT_MS),
			redirect: "error",
		});
	} catch {
		// Do not attach the fetch exception: runtimes may include the credential URL.
		throw new SabnzbdClientError("network", "Could not connect to SABnzbd");
	}

	if (!response.ok) {
		throw new SabnzbdClientError(
			"http",
			`SABnzbd returned HTTP ${response.status}`,
			response.status,
		);
	}
	const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
	if (!contentType.includes("application/json") && !contentType.includes("+json")) {
		throw new SabnzbdClientError("format", "SABnzbd returned an unsupported response format");
	}

	const contentLength = Number(response.headers.get("content-length"));
	if (Number.isFinite(contentLength) && contentLength > SABNZBD_MAX_RESPONSE_BYTES) {
		await response.body?.cancel();
		throw new SabnzbdClientError("response-size", "SABnzbd response exceeded the supported size");
	}

	const reader = response.body?.getReader();
	if (!reader) {
		throw new Error("SABnzbd returned an empty response");
	}
	const chunks: Uint8Array[] = [];
	let length = 0;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			length += value.byteLength;
			if (length > SABNZBD_MAX_RESPONSE_BYTES) {
				await reader.cancel();
				throw new SabnzbdClientError(
					"response-size",
					"SABnzbd response exceeded the supported size",
				);
			}
			chunks.push(value);
		}
	} finally {
		reader.releaseLock();
	}

	const bytes = new Uint8Array(length);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}

	let body: unknown;
	try {
		body = JSON.parse(new TextDecoder().decode(bytes));
	} catch {
		throw new SabnzbdClientError("format", "SABnzbd returned invalid JSON");
	}
	if (!body || typeof body !== "object" || Array.isArray(body)) {
		throw new SabnzbdClientError("format", "SABnzbd returned an invalid response envelope");
	}
	const error = (body as { error?: unknown }).error;
	if (typeof error === "string" && error.trim()) {
		throw new SabnzbdClientError("authentication", "SABnzbd rejected the request");
	}
	return body;
}

export function asRecord(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
}

export function text(value: unknown): string {
	return typeof value === "string" || typeof value === "number" ? String(value) : "";
}

export function boundedInteger(value: unknown, minimum: number, maximum: number): number {
	const parsed = typeof value === "number" ? value : Number(value);
	if (!Number.isInteger(parsed)) return minimum;
	return Math.min(maximum, Math.max(minimum, parsed));
}

export function pageParams(start: unknown, limit: unknown): { start: number; limit: number } {
	return {
		start: boundedInteger(start, 0, 1_000_000),
		limit: boundedInteger(limit, 1, 100),
	};
}
