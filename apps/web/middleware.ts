import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

const SESSION_COOKIE_NAME =
  process.env.NEXT_PUBLIC_SESSION_COOKIE_NAME ?? "arr_session";
const PUBLIC_PATHS = new Set([
  "/",
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

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const hasSession = Boolean(request.cookies.get(SESSION_COOKIE_NAME));

  if (pathname === "/login") {
    if (hasSession) {
      const redirectTo = request.nextUrl.searchParams.get("redirectTo");
      const target =
        redirectTo && redirectTo.startsWith("/") ? redirectTo : "/dashboard";
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
    loginUrl.searchParams.set(
      "redirectTo",
      `${pathname}${request.nextUrl.search}`,
    );
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
