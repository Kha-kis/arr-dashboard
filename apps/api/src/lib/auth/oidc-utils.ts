/**
 * OIDC URL utilities for normalizing and validating issuer URLs.
 *
 * oauth4webapi performs strict string comparison (per RFC 8414 §2) between
 * the stored issuer and the `issuer` field in the discovery document.
 * We resolve the canonical issuer from the provider to avoid mismatches.
 */

/**
 * Basic normalization: trims whitespace and strips .well-known suffix.
 * Does NOT alter trailing slashes — use resolveCanonicalIssuer() for
 * the authoritative issuer value from the provider.
 */
export function normalizeIssuerUrl(issuer: string): string {
	let normalized = issuer.trim();

	// Remove .well-known/openid-configuration suffix if present (case-insensitive)
	// Users may paste the full discovery URL instead of the issuer URL
	const wellKnownSuffix = "/.well-known/openid-configuration";
	if (normalized.toLowerCase().endsWith(wellKnownSuffix)) {
		normalized = normalized.slice(0, -wellKnownSuffix.length);
	}

	// Validate it's still a valid URL
	try {
		new URL(normalized);
	} catch {
		throw new Error(`Invalid issuer URL: ${issuer}`);
	}

	return normalized;
}

/**
 * Resolves the canonical issuer URL by fetching the OIDC discovery document
 * and returning the provider's `issuer` field. This ensures the stored value
 * exactly matches what oauth4webapi will compare against.
 *
 * Falls back to the normalized URL if discovery fails (e.g., network error),
 * so existing providers that already work are not broken.
 *
 * @param issuer - The user-provided issuer URL
 * @returns The provider's canonical issuer URL
 *
 * @example
 * // Authentik returns issuer with trailing slash
 * await resolveCanonicalIssuer("https://auth.example.com/application/o/app/")
 * // Returns: "https://auth.example.com/application/o/app/"
 *
 * @example
 * // Keycloak returns issuer without trailing slash
 * await resolveCanonicalIssuer("https://keycloak.example.com/realms/master/")
 * // Returns: "https://keycloak.example.com/realms/master"
 */
export async function resolveCanonicalIssuer(issuer: string): Promise<string> {
	const normalized = normalizeIssuerUrl(issuer);

	try {
		// Try discovery with the URL as-is first, then with opposite trailing slash
		const primaryUrl = normalized.endsWith("/")
			? `${normalized}.well-known/openid-configuration`
			: `${normalized}/.well-known/openid-configuration`;

		const fetchOpts = {
			headers: { Accept: "application/json" },
			signal: AbortSignal.timeout(10_000),
		};

		let response = await fetch(primaryUrl, fetchOpts);

		// If first attempt fails, try opposite trailing slash variant
		if (!response.ok) {
			const alt = normalized.endsWith("/")
				? `${normalized.slice(0, -1)}/.well-known/openid-configuration`
				: `${normalized}/.well-known/openid-configuration`;
			if (alt !== primaryUrl) {
				response = await fetch(alt, fetchOpts);
			}
		}

		if (response.ok) {
			const doc = (await response.json()) as { issuer?: string };
			if (doc.issuer && typeof doc.issuer === "string") {
				return doc.issuer;
			}
		}
	} catch {
		// Discovery failed — fall back to normalized URL
		// This preserves behavior for providers that were already working
	}

	return normalized;
}
