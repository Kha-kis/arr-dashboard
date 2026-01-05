/**
 * OIDC URL utilities for normalizing and validating issuer URLs.
 *
 * oauth4webapi automatically appends /.well-known/openid-configuration to the issuer URL
 * when performing discovery. This module ensures user-provided URLs are normalized
 * to prevent issues like double paths or trailing slashes.
 */

/**
 * Normalizes an OIDC issuer URL by:
 * 1. Trimming whitespace
 * 2. Removing trailing slashes
 * 3. Removing .well-known/openid-configuration suffix if present
 * 4. Validating the result is still a valid URL
 *
 * @param issuer - The issuer URL to normalize
 * @returns The normalized issuer URL
 * @throws Error if the result is not a valid URL
 *
 * @example
 * normalizeIssuerUrl("https://keycloak/realms/master/")
 * // Returns: "https://keycloak/realms/master"
 *
 * @example
 * normalizeIssuerUrl("https://keycloak/realms/master/.well-known/openid-configuration")
 * // Returns: "https://keycloak/realms/master"
 */
export function normalizeIssuerUrl(issuer: string): string {
	let normalized = issuer.trim();

	// Remove trailing slashes (may be multiple)
	while (normalized.endsWith("/")) {
		normalized = normalized.slice(0, -1);
	}

	// Remove .well-known/openid-configuration suffix if present (case-insensitive)
	const wellKnownSuffix = "/.well-known/openid-configuration";
	if (normalized.toLowerCase().endsWith(wellKnownSuffix)) {
		normalized = normalized.slice(0, -wellKnownSuffix.length);
	}

	// Remove any trailing slashes that may have been before the .well-known suffix
	while (normalized.endsWith("/")) {
		normalized = normalized.slice(0, -1);
	}

	// Validate it's still a valid URL
	try {
		new URL(normalized);
	} catch {
		throw new Error(`Invalid issuer URL: ${issuer}`);
	}

	return normalized;
}
