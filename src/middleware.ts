import { NextResponse, type NextRequest } from "next/server";

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;
  if (
    pathname.startsWith("/login") ||
    pathname.startsWith("/register") ||
    pathname.startsWith("/api") ||
    pathname.startsWith("/staff/") ||
    pathname.startsWith("/b/") ||
    pathname.startsWith("/booking/") ||
    pathname.startsWith("/pay/") ||
    pathname.startsWith("/r/") ||
    pathname.startsWith("/developers") ||
    /\.(?:png|jpe?g|webp|gif|svg|ico|woff2?)$/i.test(pathname)
  ) {
    return NextResponse.next();
  }
  if (!request.cookies.get("ab_session")) {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    return NextResponse.redirect(url);
  }
  return NextResponse.next();
}

export const config = { matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"] };
