import { NextResponse, type NextRequest } from "next/server";
import { AUTH_COOKIE, authToken, safeEqual } from "./lib/auth";

const PUBLIC = ["/login", "/api/login"];

export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  if (PUBLIC.includes(pathname)) return NextResponse.next();

  const password = process.env.PASSWORD;
  if (!password) {
    // Fail closed in production; stay open for local development.
    if (process.env.NODE_ENV !== "production") return NextResponse.next();
    return new NextResponse("PASSWORD environment variable is not set.", { status: 503 });
  }

  const cookie = req.cookies.get(AUTH_COOKIE)?.value ?? "";
  if (cookie && safeEqual(cookie, await authToken(password))) return NextResponse.next();

  if (pathname.startsWith("/api/")) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const url = req.nextUrl.clone();
  url.pathname = "/login";
  url.search = "";
  return NextResponse.redirect(url);
}

export const config = {
  // Static assets, icons, manifest and service worker stay public so "Add to Home Screen" works.
  matcher: ["/((?!_next/static|_next/image|icons/|manifest.webmanifest|sw.js|favicon.ico).*)"],
};
