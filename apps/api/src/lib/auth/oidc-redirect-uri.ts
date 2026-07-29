import { oidcRedirectUriSchema } from "@arr/shared";

export function buildOidcRedirectUriFromAppUrl(appUrl: string): string | null {
	try {
		const result = oidcRedirectUriSchema.safeParse(
			new URL("/auth/oidc/callback", appUrl).toString(),
		);
		return result.success ? result.data : null;
	} catch {
		return null;
	}
}
