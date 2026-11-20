export const dynamic = "force-dynamic";

const HOP_HEADERS = [
	"connection",
	"keep-alive",
	"proxy-authenticate",
	"proxy-authorization",
	"te",
	"trailer",
	"transfer-encoding",
	"upgrade",
];

function endToEndHeaders(original: Headers): Headers {
	const headers = new Headers(original);
	for (const name of (original.get("connection") ?? "").split(",")) {
		if (name.trim()) headers.delete(name.trim());
	}
	for (const name of HOP_HEADERS) headers.delete(name);
	return headers;
}

/** Keep API unavailability distinct from an invalid session or a real API error. */
export async function GET(request: Request): Promise<Response> {
	const apiHost = process.env.API_HOST || "http://localhost:3001";
	// Only the server-owned configuration selects the destination, never the caller's host.
	const target = new URL(`${apiHost.replace(/\/+$/, "")}/auth/me`);
	target.search = new URL(request.url).search;
	const requestHeaders = endToEndHeaders(request.headers);
	requestHeaders.delete("host");
	requestHeaders.delete("content-length");
	requestHeaders.delete("content-encoding");

	let upstream: Response;
	let body: ArrayBuffer;
	try {
		upstream = await fetch(target, {
			method: "GET",
			headers: requestHeaders,
			cache: "no-store",
			redirect: "manual",
			signal: AbortSignal.any([request.signal, AbortSignal.timeout(3000)]),
		});
		// Observe the complete small auth response before publishing success.
		body = await upstream.arrayBuffer();
	} catch {
		return Response.json(
			{ error: "API temporarily unavailable", category: "api-unavailable" },
			{ status: 503, headers: { "Cache-Control": "private, no-store" } },
		);
	}

	const headers = endToEndHeaders(upstream.headers);
	// Fetch decodes compressed responses; their original framing is no longer valid.
	headers.delete("content-length");
	headers.delete("content-encoding");
	headers.set("cache-control", "private, no-store");
	// Cookie values may contain commas; preserve each renewal as its own header.
	headers.delete("set-cookie");
	for (const cookie of upstream.headers.getSetCookie()) headers.append("set-cookie", cookie);
	const emptyBody = [204, 205, 304].includes(upstream.status);
	return new Response(emptyBody ? null : body, { status: upstream.status, headers });
}
