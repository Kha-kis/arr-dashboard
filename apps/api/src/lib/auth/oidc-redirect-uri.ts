import { oidcRedirectUriSchema } from "@arr/shared";

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

function isPublicHttpOrigin(value: string | undefined): boolean {
	if (!value) {
		return false;
	}

	try {
		const url = new URL(value);
		return (
			["http:", "https:"].includes(url.protocol) &&
			!url.username &&
			!url.password &&
			!url.search &&
			!url.hash &&
			!isLoopbackAddress(url.hostname)
		);
	} catch {
		return false;
	}
}

/**
 * Select a public OIDC base URL exclusively from operator-controlled settings.
 * A WebAuthn origin is a safe fallback for installations where APP_URL still
 * has its local default because both features share the browser-facing origin.
 */
export function resolveOidcAppUrl(
	externalUrl: string | null | undefined,
	appUrl: string,
	webAuthnOrigin?: string,
): string {
	if (externalUrl) {
		return externalUrl;
	}

	if (isPublicHttpOrigin(appUrl)) {
		return appUrl;
	}

	if (webAuthnOrigin && isPublicHttpOrigin(webAuthnOrigin)) {
		return new URL(webAuthnOrigin).origin;
	}

	return appUrl;
}

export function oidcRedirectUriMatchesAppOrigin(redirectUri: string, appUrl: string): boolean {
	const expectedRedirectUri = buildOidcRedirectUriFromAppUrl(appUrl);
	return (
		expectedRedirectUri !== null &&
		new URL(redirectUri).origin === new URL(expectedRedirectUri).origin
	);
}
