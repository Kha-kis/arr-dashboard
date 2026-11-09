/**
 * SABnzbd HTTP client.
 *
 * SABnzbd authenticates with an API key on the query string. Callers must
 * not log the URL. This is the usenet counterpart of the qui client: one
 * request-scoped call, no cached credentials.
 */

export async function sabCall(
	baseUrl: string,
	apiKey: string,
	params: Record<string, string>,
): Promise<unknown> {
	const url = new URL(`${baseUrl.replace(/\/$/, "")}/api`);
	url.searchParams.set("output", "json");
	url.searchParams.set("apikey", apiKey);
	for (const [key, value] of Object.entries(params)) {
		url.searchParams.set(key, value);
	}
	const response = await fetch(url, {
		headers: { Accept: "application/json" },
		signal: AbortSignal.timeout(8000),
	});
	if (!response.ok) {
		throw new Error(`SABnzbd returned HTTP ${response.status}`);
	}
	const body = (await response.json()) as { error?: unknown };
	if (typeof body.error === "string" && body.error) {
		throw new Error("SABnzbd rejected the request");
	}
	return body;
}

export function asRecord(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

export function text(value: unknown): string {
	return typeof value === "string" || typeof value === "number" ? String(value) : "";
}
