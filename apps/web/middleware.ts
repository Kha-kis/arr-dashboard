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

// Proxy API requests to the backend
function proxyApiRequest(request: NextRequest): NextResponse | null {
	const { pathname } = request.nextUrl;

	// Check if this is an API or auth request
	if (!pathname.startsWith("/api/") && !pathname.startsWith("/auth/")) {
		return null;
	}

	// Determine API host (Docker: api:3001, Local dev: localhost:3001)
	const apiHost = process.env.API_HOST || "http://localhost:3001";

	// Construct the proxied URL
	const apiUrl = new URL(pathname + request.nextUrl.search, apiHost);

	// Rewrite to the API server
	return NextResponse.rewrite(apiUrl);
}

export function middleware(request: NextRequest) {
	const { pathname } = request.nextUrl;

	// Handle API proxy first
	const apiResponse = proxyApiRequest(request);
	if (apiResponse) {
		return apiResponse;
	}
	const hasSession = Boolean(request.cookies.get(SESSION_COOKIE_NAME));

	// Home page: redirect to dashboard if logged in, otherwise to login
	if (pathname === "/") {
		const url = request.nextUrl.clone();
		url.pathname = hasSession ? "/dashboard" : "/login";
		return NextResponse.redirect(url);
	}

	if (pathname === "/login") {
		if (hasSession) {
			const redirectTo = request.nextUrl.searchParams.get("redirectTo");
			const target = redirectTo && redirectTo.startsWith("/") ? redirectTo : "/dashboard";
			const url = request.nextUrl.clone();
			url.pathname = target;
			url.search = "";
			return NextResponse.redirect(url);
		}
		return NextResponse.next();
	}

	if (isPublicPath(pathname)) {
		return NextResponse.next();
	}

	if (!hasSession) {
		const loginUrl = request.nextUrl.clone();
		loginUrl.pathname = "/login";
		loginUrl.searchParams.set("redirectTo", `${pathname}${request.nextUrl.search}`);
		loginUrl.hash = "";
		return NextResponse.redirect(loginUrl);
	}

	return NextResponse.next();
}

export const config = {
	matcher: [
		"/((?!_next/static|_next/image|favicon.ico|assets|.*\\.(?:png|jpg|jpeg|gif|webp|svg|ico|css|js|woff2?)).*)",
	],
};
