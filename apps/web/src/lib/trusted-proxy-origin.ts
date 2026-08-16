import type { NextRequest } from "next/server";

export const ARR_DASHBOARD_ORIGIN_HEADER = "x-arr-dashboard-origin";

function nearestProxyValue(value: string | null): string | null {
	return value?.split(",").at(-1)?.trim() || null;
}

function resolveBrowserOrigin(request: Pick<NextRequest, "headers" | "nextUrl">): string | null {
	const host =
		nearestProxyValue(request.headers.get("x-forwarded-host")) ?? request.headers.get("host");
	const forwardedProtocol = nearestProxyValue(request.headers.get("x-forwarded-proto"));
	const protocol =
		forwardedProtocol === "http" || forwardedProtocol === "https"
			? forwardedProtocol
			: request.nextUrl.protocol.replace(/:$/, "");

	if (!host || (protocol !== "http" && protocol !== "https")) {
		return null;
	}

	try {
		const origin = new URL(`${protocol}://${host}`);
		if (
			origin.username ||
			origin.password ||
			origin.pathname !== "/" ||
			origin.search ||
			origin.hash
		) {
			return null;
		}
		return origin.origin;
	} catch {
		return null;
	}
}

/**
 * Replace client-controlled forwarding metadata with an origin stamped by the
 * browser-facing Next server before a rewrite sends the request to the API.
 */
export function buildTrustedProxyHeaders(request: Pick<NextRequest, "headers" | "nextUrl">) {
	const headers = new Headers(request.headers);
	const browserOrigin = resolveBrowserOrigin(request);
	headers.delete(ARR_DASHBOARD_ORIGIN_HEADER);
	headers.delete("x-forwarded-host");
	headers.delete("x-forwarded-proto");
	if (browserOrigin) {
		const origin = new URL(browserOrigin);
		headers.set(ARR_DASHBOARD_ORIGIN_HEADER, origin.origin);
		headers.set("x-forwarded-host", origin.host);
		headers.set("x-forwarded-proto", origin.protocol.slice(0, -1));
	}
	return headers;
}
