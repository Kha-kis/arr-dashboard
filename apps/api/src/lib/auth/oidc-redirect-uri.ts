import { oidcRedirectUriSchema } from "@arr/shared";

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
