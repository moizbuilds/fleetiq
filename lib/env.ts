/**
 * Shared environment-readiness checks.
 *
 * WHY this needs to live in one shared file instead of being duplicated:
 * two different layers of the app need to know whether Clerk is
 * configured — `proxy.ts` (runs on every request, before any React
 * renders) and `app/layout.tsx` (renders the setup notice instead of the
 * real app). Clerk's own `clerkMiddleware()` throws "Publishable key not
 * valid" synchronously the instant it runs, so proxy.ts must skip calling
 * it at all when the key is a placeholder — checking in only one of the
 * two places would either still 500 every route (proxy throws first) or
 * silently drift out of sync with the layout's check the next time either
 * one changes.
 */
export function hasValidClerkPublishableKey(): boolean {
  const key = process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;
  return !!key && key.startsWith("pk_") && !key.includes("placeholder");
}
