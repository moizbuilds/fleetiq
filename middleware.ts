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
 * NOTE: Next.js 16 renamed this file convention from `middleware.ts` to
 * `proxy.ts` (function `middleware` → `proxy`); `middleware.ts` still
 * works today but logs a one-time deprecation warning at build time. Kept
 * as `middleware.ts` here to match the task spec — flagged in the task
 * report for a possible follow-up rename to `proxy.ts`.
 */
import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";

const isPublicRoute = createRouteMatcher([
  "/sign-in(.*)",
  "/api/integrations(.*)",
]);

export default clerkMiddleware(async (auth, req) => {
  if (!isPublicRoute(req)) {
    await auth.protect();
  }
});

export const config = {
  matcher: [
    // Skip Next.js internals and static assets, unless referenced in search params.
    "/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
    // Always run for API routes.
    "/(api|trpc)(.*)",
  ],
};
