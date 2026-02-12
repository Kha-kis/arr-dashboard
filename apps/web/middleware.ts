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
 * Validate session by calling the auth/me endpoint.
 * Returns true if session is valid, false if definitely invalid (401).
 * On server errors or network issues, returns true to avoid false logouts.
 */
async function validateSession(request: NextRequest): Promise<boolean> {
	const sessionCookie = request.cookies.get(SESSION_COOKIE_NAME);
	if (!sessionCookie?.value) {
		return false;
	}

	try {
		const apiHost = process.env.API_HOST || "http://localhost:3001";
		const response = await fetch(`${apiHost}/auth/me`, {
			method: "GET",
			headers: {
				Cookie: `${SESSION_COOKIE_NAME}=${sessionCookie.value}`,
			},
			signal: AbortSignal.timeout(3000),
		});

		// Only treat 401 as invalid session
		// Server errors (5xx) should NOT invalidate — the cookie might be valid
		// but the server is temporarily unavailable
		return response.status !== 401;
	} catch {
		// On network error, assume session might be valid to avoid blocking users
		return true;
	}
}

/**
 * Create a response that clears the invalid session cookie and redirects
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
	response.cookies.delete(SESSION_COOKIE_NAME);
	return response;
}

export async function middleware(request: NextRequest) {
	const { pathname } = request.nextUrl;

	// Skip middleware for API/auth/health routes — handled by rewrites in next.config.mjs
	if (pathname.startsWith("/api/") || pathname.startsWith("/auth/") || pathname === "/health") {
		return NextResponse.next();
	}

	// RSC (React Server Component) requests are client-side navigations.
	// For these, return 401 instead of redirect on auth failure —
	// redirects would break the RSC wire format, and the client-side AuthGate
	// handles redirect logic for unauthenticated users.
	const isRSC = request.headers.get("RSC") === "1";

	const sessionCookie = request.cookies.get(SESSION_COOKIE_NAME);
	const hasSessionCookie = Boolean(sessionCookie?.value);

	// Home page: redirect to dashboard if logged in, otherwise to login
	if (pathname === "/") {
		if (hasSessionCookie) {
			const valid = await validateSession(request);
			if (valid) {
				const url = request.nextUrl.clone();
				url.pathname = "/dashboard";
				return NextResponse.redirect(url);
			}
			return clearSessionAndRedirect(request, "/login");
		}
		const url = request.nextUrl.clone();
		url.pathname = "/login";
		return NextResponse.redirect(url);
	}

	if (pathname === "/login") {
		if (hasSessionCookie) {
			const valid = await validateSession(request);
			if (valid) {
				const redirectTo = request.nextUrl.searchParams.get("redirectTo");
				const target = redirectTo && redirectTo.startsWith("/") ? redirectTo : "/dashboard";
				const url = request.nextUrl.clone();
				url.pathname = target;
				url.search = "";
				return NextResponse.redirect(url);
			}
			const response = NextResponse.next();
			response.cookies.delete(SESSION_COOKIE_NAME);
			return response;
		}
		return NextResponse.next();
	}

	if (isPublicPath(pathname)) {
		return NextResponse.next();
	}

	// Protected routes — validate session
	if (!hasSessionCookie) {
		if (isRSC) return new NextResponse(null, { status: 401 });
		return clearSessionAndRedirect(request, "/login");
	}

	const valid = await validateSession(request);
	if (!valid) {
		if (isRSC) return new NextResponse(null, { status: 401 });
		return clearSessionAndRedirect(request, "/login");
	}

	return NextResponse.next();
}

export const config = {
	matcher: [
		"/((?!_next/static|_next/image|favicon.ico|assets|.*\\.(?:png|jpg|jpeg|gif|webp|svg|ico|css|js|woff2?)).*)",
	],
};
