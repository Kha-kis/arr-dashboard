import { oidcRedirectUriSchema } from "@arr/shared";
import type { FastifyRequest } from "fastify";

type RedirectRequest = Pick<FastifyRequest, "headers" | "raw">;

function isLoopbackAddress(value: string): boolean {
	const normalized = value
		.trim()
		.toLowerCase()
		.replace(/^\[|\]$/g, "");
	return (
		normalized === "localhost" ||
		normalized === "0.0.0.0" ||
		normalized === "::" ||
		normalized === "::1" ||
		/^127(?:\.\d{1,3}){3}$/.test(normalized) ||
		/^::ffff:127(?:\.\d{1,3}){3}$/.test(normalized)
	);
}

function resolveTrustedProxyOrigin(trustProxy: boolean, request: RedirectRequest): string | null {
	if (!trustProxy) {
		return null;
	}

	if (!isLoopbackAddress(request.raw.socket.remoteAddress ?? "")) {
		return null;
	}

	const internalOrigin = request.headers["x-arr-dashboard-origin"];
	if (typeof internalOrigin !== "string") {
		return null;
	}

	try {
		const candidate = new URL(internalOrigin);
		if (
			!["http:", "https:"].includes(candidate.protocol) ||
			candidate.username ||
			candidate.password ||
			candidate.pathname !== "/" ||
			candidate.search ||
			candidate.hash ||
			isLoopbackAddress(candidate.hostname)
		) {
			return null;
		}
		return candidate.origin;
	} catch {
		return null;
	}
}

export function buildOidcRedirectUriFromAppUrl(appUrl: string): string | null {
	try {
		const baseUrl = new URL(appUrl);
		if (
			!["http:", "https:"].includes(baseUrl.protocol) ||
			baseUrl.username ||
			baseUrl.password ||
			appUrl.includes("?") ||
			appUrl.includes("#")
		) {
			return null;
		}

		baseUrl.pathname = `${baseUrl.pathname.replace(/\/+$/, "")}/auth/oidc/callback`;
		const result = oidcRedirectUriSchema.safeParse(baseUrl.toString());
		return result.success ? result.data : null;
	} catch {
		return null;
	}
}

export function buildOidcRedirectUriForRequest(
	appUrl: string,
	trustProxy: boolean,
	request: RedirectRequest,
): string | null {
	const configuredRedirectUri = buildOidcRedirectUriFromAppUrl(appUrl);
	if (!configuredRedirectUri) {
		return null;
	}

	const configuredHostname = new URL(appUrl).hostname;
	if (!isLoopbackAddress(configuredHostname)) {
		return configuredRedirectUri;
	}

	const proxyOrigin = resolveTrustedProxyOrigin(trustProxy, request);
	if (!proxyOrigin) {
		return configuredRedirectUri;
	}

	const publicAppUrl = new URL(appUrl);
	const proxyUrl = new URL(proxyOrigin);
	publicAppUrl.protocol = proxyUrl.protocol;
	publicAppUrl.hostname = proxyUrl.hostname;
	publicAppUrl.port = proxyUrl.port;
	return buildOidcRedirectUriFromAppUrl(publicAppUrl.toString());
}

export function oidcRedirectUriMatchesRequestOrigin(
	redirectUri: string,
	appUrl: string,
	trustProxy: boolean,
	request: RedirectRequest,
): boolean {
	const expectedRedirectUri = buildOidcRedirectUriForRequest(appUrl, trustProxy, request);
	return (
		expectedRedirectUri !== null &&
		new URL(redirectUri).origin === new URL(expectedRedirectUri).origin
	);
}
