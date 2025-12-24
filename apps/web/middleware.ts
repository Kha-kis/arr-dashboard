import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

const SESSION_COOKIE_NAME = process.env.NEXT_PUBLIC_SESSION_COOKIE_NAME ?? "arr_session";
const PUBLIC_PATHS = new Set([
	"/login",
	"/setup",
	"/favicon.ico",
	"/robots.txt",
	"/sitemap.xml",
]);
const PUBLIC_FILE = /\.(.*)$/;

const isPublicPath = (pathname: string) => {
	if (PUBLIC_PATHS.has(pathname)) {
		return true;
	}
	if (pathname.startsWith("/_next")) {
		return true;
	}
	if (pathname.startsWith("/static")) {
		return true;
	}
	return PUBLIC_FILE.test(pathname);
};

/**
 * Validate session by calling the auth/me endpoint
 * Returns:
 * - true: session is valid
 * - false: session is definitely invalid (401 response)
 * - true (fallback): on server errors or network issues to avoid false logouts
 */
async function validateSession(request: NextRequest): Promise<boolean> {
	const sessionCookie = request.cookies.get(SESSION_COOKIE_NAME);
	if (!sessionCookie?.value) {
		return false;
	}

	try {
		// Use internal API URL for server-side validation
		const apiHost = process.env.API_HOST || "http://localhost:3001";
		const response = await fetch(`${apiHost}/auth/me`, {
			method: "GET",
			headers: {
				Cookie: `${SESSION_COOKIE_NAME}=${sessionCookie.value}`,
			},
			// Short timeout to avoid blocking middleware
			signal: AbortSignal.timeout(3000),
		});

		// Only treat 401 as invalid session
		// Server errors (5xx) should NOT invalidate the session - the cookie might be valid
		// but the server is temporarily unavailable
		if (response.status === 401) {
			return false;
		}

		// For any other response (including 5xx errors), assume session might be valid
		// This prevents false logouts during API issues
		return true;
	} catch {
		// On network error, assume session might be valid to avoid blocking users
		// The actual API calls will fail and redirect them properly
		return true;
	}
}

/**
 * Create a response that clears the invalid session cookie
 */
function clearSessionAndRedirect(request: NextRequest, targetPath: string): NextResponse {
	const url = request.nextUrl.clone();
	url.pathname = targetPath;
	if (targetPath === "/login") {
		const { pathname, search } = request.nextUrl;
		if (pathname !== "/" && pathname !== "/login") {
			url.searchParams.set("redirectTo", `${pathname}${search}`);
		}
	}
	url.hash = "";

	const response = NextResponse.redirect(url);
	// Clear the invalid session cookie
	response.cookies.delete(SESSION_COOKIE_NAME);
	return response;
}

export async function middleware(request: NextRequest) {
	const { pathname } = request.nextUrl;

	// Skip middleware for API/auth routes - handled by rewrites in next.config.mjs
	if (pathname.startsWith("/api/") || pathname.startsWith("/auth/")) {
		return NextResponse.next();
	}

	const sessionCookie = request.cookies.get(SESSION_COOKIE_NAME);
	const hasSessionCookie = Boolean(sessionCookie?.value);

	// Home page: redirect to dashboard if logged in, otherwise to login
	if (pathname === "/") {
		if (hasSessionCookie) {
			const isValid = await validateSession(request);
			if (isValid) {
				const url = request.nextUrl.clone();
				url.pathname = "/dashboard";
				return NextResponse.redirect(url);
			}
			// Invalid session - clear cookie and redirect to login
			return clearSessionAndRedirect(request, "/login");
		}
		const url = request.nextUrl.clone();
		url.pathname = "/login";
		return NextResponse.redirect(url);
	}

	if (pathname === "/login") {
		if (hasSessionCookie) {
			const isValid = await validateSession(request);
			if (isValid) {
				const redirectTo = request.nextUrl.searchParams.get("redirectTo");
				const target = redirectTo && redirectTo.startsWith("/") ? redirectTo : "/dashboard";
				const url = request.nextUrl.clone();
				url.pathname = target;
				url.search = "";
				return NextResponse.redirect(url);
			}
			// Invalid session - clear cookie and stay on login
			const response = NextResponse.next();
			response.cookies.delete(SESSION_COOKIE_NAME);
			return response;
		}
		return NextResponse.next();
	}

	if (isPublicPath(pathname)) {
		return NextResponse.next();
	}

	// Protected routes - validate session
	if (!hasSessionCookie) {
		return clearSessionAndRedirect(request, "/login");
	}

	const isValid = await validateSession(request);
	if (!isValid) {
		// Invalid session - clear cookie and redirect to login
		return clearSessionAndRedirect(request, "/login");
	}

	return NextResponse.next();
}

export const config = {
	matcher: [
		"/((?!_next/static|_next/image|favicon.ico|assets|.*\\.(?:png|jpg|jpeg|gif|webp|svg|ico|css|js|woff2?)).*)",
	],
};
