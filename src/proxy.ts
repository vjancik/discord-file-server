import { getSessionCookie } from "better-auth/cookies";
import { type NextRequest, NextResponse } from "next/server";

/**
 * Optimistic redirect layer only (cookie presence, no DB hit) — real
 * authorization happens in the DAL (src/auth/dal.ts) and the tus hooks.
 * Public routes (/s/*, /f/*, /api/*) are excluded via the matcher.
 */
export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // /login must not redirect on mere cookie presence: a stale cookie whose
  // session row is gone (revoked, expired, restored DB) would ping-pong
  // against requireUser() forever. The login page itself redirects
  // authenticated users after a real session lookup.
  if (pathname === "/login") {
    return NextResponse.next();
  }

  if (!getSessionCookie(request)) {
    return NextResponse.redirect(new URL("/login", request.nextUrl));
  }

  return NextResponse.next();
}

export const config = {
  matcher: [
    "/((?!api|_next/static|_next/image|s/|f/|favicon\\.ico|icon\\.svg|og\\.png|robots\\.txt).*)",
  ],
};
