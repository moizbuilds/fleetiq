/**
 * Route protection for FleetIQ.
 *
 * Clerk's clerkMiddleware runs on every matched request (see `config`
 * below) and makes `auth()` available in Server Components and Route
 * Handlers downstream. Everything in the app requires sign-in EXCEPT the
 * sign-in page itself (or nobody could ever sign in) and the integrations
 * webhook API, which authenticates its callers with its own API key
 * instead of a Clerk session — a third-party webhook caller has no Clerk
 * session for Clerk to check.
 *
 * WHY an allowlist of public routes rather than a denylist of protected
 * ones: a route added later (e.g. Task 3's /vehicles) is protected by
 * default the moment it exists — the naive denylist approach would leave
 * a brand-new route silently public until someone remembers to add it.
 *
 * NOTE: this file is named `proxy.ts`, not `middleware.ts` — Next.js 16
 * renamed the file convention (the old name still works today but logs a
 * one-time deprecation warning at build time). Clerk's `clerkMiddleware`
 * helper still returns a plain request handler under the hood, so it
 * works unchanged as this file's default export; only the filename and
 * this comment changed, not the auth logic itself.
 */
import { NextResponse } from "next/server";
import type { NextFetchEvent, NextRequest } from "next/server";
import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";
import { hasValidClerkPublishableKey } from "@/lib/env";

const isPublicRoute = createRouteMatcher([
  "/sign-in(.*)",
  "/api/integrations(.*)",
]);

const runClerkAuth = clerkMiddleware(
  async (auth, req) => {
    if (!isPublicRoute(req)) {
      await auth.protect();
    }
  },
  // WHY pass signInUrl explicitly instead of relying only on the
  // NEXT_PUBLIC_CLERK_SIGN_IN_URL env var: without either one, a
  // signed-out visitor hitting a protected route gets bounced to Clerk's
  // hosted Account Portal (a generic clerk.accounts.dev page) instead of
  // our themed /sign-in page — the env var alone is easy to forget when
  // copying prod config between environments, so this makes the app
  // correct even if that var is ever unset.
  { signInUrl: "/sign-in" },
);

// WHY branch here instead of always calling runClerkAuth: clerkMiddleware
// throws "Publishable key not valid" synchronously the moment it runs
// against a missing/placeholder key — before the request ever reaches
// app/layout.tsx, which is where the setup-notice guard lives. Without
// this branch every route would still 500 with placeholder keys, even
// with that guard in place. Falling through with NextResponse.next() lets
// the request reach the layout, which renders the setup notice instead.
export default function proxy(request: NextRequest, event: NextFetchEvent) {
  if (!hasValidClerkPublishableKey()) {
    return NextResponse.next();
  }
  return runClerkAuth(request, event);
}

export const config = {
  matcher: [
    // Skip Next.js internals and static assets, unless referenced in search params.
    "/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
    // Always run for API routes.
    "/(api|trpc)(.*)",
  ],
};
