import { getSessionCookie } from "better-auth/cookies";
import { type NextRequest, NextResponse } from "next/server";

/**
 * Optimistic redirect layer only (cookie presence, no DB hit) — real
 * authorization happens in the DAL (src/auth/dal.ts) and the tus hooks.
 * Public routes (/s/*, /f/*, /api/*) are excluded via the matcher.
 */
export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const sessionCookie = getSessionCookie(request);

  if (pathname === "/login") {
    return sessionCookie
      ? NextResponse.redirect(new URL("/", request.nextUrl))
      : NextResponse.next();
  }

  if (!sessionCookie) {
    return NextResponse.redirect(new URL("/login", request.nextUrl));
  }

  return NextResponse.next();
}

export const config = {
  matcher: [
    "/((?!api|_next/static|_next/image|s/|f/|favicon\\.ico|robots\\.txt).*)",
  ],
};
