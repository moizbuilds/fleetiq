/**
 * Tenant resolution — every DB query in FleetIQ is scoped to a `tenantId`,
 * and this file is the ONLY place that's allowed to decide what that ID is.
 *
 * WHY tenantId comes from Clerk's active organization instead of the
 * userId directly: FleetIQ is built so a household or small shop can share
 * one fleet later without a schema change — the tenant is an
 * *organization*, and a lone user just gets an organization of one,
 * invisible to them (see `ensurePersonalOrg` below).
 *
 * CONCEPT: `auth()` reads the signed Clerk session token attached to the
 * current request (set by proxy.ts's clerkMiddleware). It's trustworthy
 * precisely because it comes from a verified session, never from a header
 * or query param a client could forge — see globals.md's tenant-isolation
 * rule.
 *
 * NOTE: this file is intentionally NOT unit-tested. Clerk's `auth()` and
 * `clerkClient()` need a live session/API key to do anything meaningful, so
 * there's nothing to assert without a real Clerk environment. Every
 * function that actually touches the database (schedule logic, vehicle
 * queries, etc.) takes `tenantId` as a plain string parameter instead of
 * calling `requireTenant()` itself — that's what makes THOSE functions
 * testable without a network or a Clerk account (dependency injection: the
 * caller, e.g. a Server Component or Route Handler, resolves the tenant
 * once via requireTenant() and passes the id down).
 *
 * NOTE on the org-activation gap this file used to have: Clerk's session
 * does NOT auto-activate an organization just because it was created —
 * "active organization" is client-side session state that only a browser
 * (via `setActive()`) can set. A server component creating an org has no
 * way to also mark it active. The old code assumed otherwise, which meant
 * every request with no active org created a brand-new "My Fleet" org
 * (never activated, so `orgId` stayed empty on the *next* request too) —
 * data scattered across an ever-growing pile of orgs. The fix has two
 * halves that both have to be in place: (1) below, `requireTenant()` looks
 * up the user's EXISTING memberships before ever creating one, so creation
 * only happens once per user, ever; (2) `components/sync-active-org.tsx`
 * runs client-side to call `setActive()` so the *next* request hits the
 * fast path (`orgId` already on the session) instead of re-deriving the
 * membership every time.
 */
import { cache } from 'react';
import { auth, clerkClient } from '@clerk/nextjs/server';
import { redirect } from 'next/navigation';
import { isDemoMode, DEMO_TENANT_ID, DEMO_USER_ID } from './demo';

// Auto-provisions a single-user "organization" the first time someone signs
// in with no org membership at all yet.
//
// WHY: Clerk's default flow shows an org picker/creation screen to every new
// user, even someone who will only ever manage their own cars. Creating
// "My Fleet" for them automatically means a single user never sees that
// screen — org membership becomes an implementation detail instead of
// something they have to set up.
async function ensurePersonalOrg(userId: string): Promise<string> {
  const client = await clerkClient();
  const org = await client.organizations.createOrganization({
    name: 'My Fleet',
    createdBy: userId,
  });
  return org.id;
}

// The org-resolution half of tenant lookup, pulled out of requireTenant()
// so app/api/ai/schedule/route.ts (a Route Handler, not a Server Component)
// can share it. WHY this must be one function instead of two copies: a
// Route Handler can't call redirect() the way requireTenant() does for
// page/Server Action callers — Next.js's redirect() throws a special
// control-flow signal that only Server Components/Actions know how to catch
// and turn into an HTTP redirect response; a fetch() caller hitting an API
// route would just see an unhandled exception. So route.ts has to do its
// own `auth()` call and its own 401 JSON response, but the actual "which
// org is this user's tenant" logic — fast path, membership lookup,
// first-time provisioning — must stay written exactly once, or the two
// call sites (page loads vs. API calls) would risk drifting on how a tenant
// gets resolved.
export async function resolveTenantId(userId: string, orgId: string | null): Promise<string> {
  // Demo mode (lib/demo.ts) has no Clerk session to derive a tenant from at
  // all — `userId`/`orgId` above wouldn't even be real values in demo mode
  // (every call site that could reach here with demo mode on short-circuits
  // before ever calling Clerk's `auth()`; see requireTenant() below). This
  // fixed id is the ONE tenant every row lib/demo-seed.ts inserts belongs
  // to, so short-circuiting here keeps that single fact true no matter
  // which caller resolves the tenant.
  if (isDemoMode()) {
    return DEMO_TENANT_ID;
  }

  // Fast path: the session already carries an active org (either the user
  // picked one, or `sync-active-org.tsx` set it on a previous request).
  if (orgId) {
    return orgId;
  }

  // No active org on the session — check whether the user is already a
  // member of one before assuming they need a new one. This is what makes
  // org creation idempotent: after the very first request, every later
  // request finds the existing membership here instead of creating another
  // "My Fleet".
  const client = await clerkClient();
  const { data: memberships } = await client.users.getOrganizationMembershipList({
    userId,
    limit: 1,
  });

  if (memberships.length > 0) {
    return memberships[0].organization.id;
  }

  // Truly the first time this user has ever been seen — provision their
  // personal org now. `sync-active-org.tsx` will pick this membership up on
  // the client and call `setActive()`, so the *next* request takes the fast
  // path above instead of re-running this lookup.
  return ensurePersonalOrg(userId);
}

// CONCEPT: React's `cache()` memoizes a function's result for the lifetime
// of a single server request — call it from three different Server
// Components rendering the same page, and the wrapped function's body only
// actually runs once; the other two calls just read the cached result.
// WHY this matters here: without it, a page that calls `requireTenant()`
// from a layout AND a page AND a nested component would run the
// membership-list lookup (a real API call to Clerk) three times over for
// one page load, and — worse — could race and create two orgs if a user's
// very first request renders multiple components before any of them
// finishes.
export const requireTenant = cache(async (): Promise<{ tenantId: string; userId: string }> => {
  // Demo mode: skip Clerk's `auth()` entirely rather than just short-
  // circuiting AFTER calling it. `auth()` reads session state that
  // proxy.ts's clerkMiddleware would normally attach to the request — and
  // in demo mode proxy.ts never runs clerkMiddleware at all (it returns
  // `NextResponse.next()` unconditionally; see that file's header), so
  // calling `auth()` here would throw a "clerkMiddleware() must be used"
  // error instead of just returning an empty session. Every page/action
  // that calls requireTenant() gets the same fixed fake identity instead.
  if (isDemoMode()) {
    return { tenantId: DEMO_TENANT_ID, userId: DEMO_USER_ID };
  }

  const { userId, orgId } = await auth();

  if (!userId) {
    redirect('/sign-in');
  }

  const tenantId = await resolveTenantId(userId, orgId ?? null);
  return { tenantId, userId };
});
