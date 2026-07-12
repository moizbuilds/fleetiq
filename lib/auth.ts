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
 */
import { auth, clerkClient } from '@clerk/nextjs/server';
import { redirect } from 'next/navigation';

// Auto-provisions a single-user "organization" the first time someone signs
// in with no active org yet.
//
// WHY: Clerk's default flow shows a org picker/creation screen to every new
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

export async function requireTenant(): Promise<{ tenantId: string; userId: string }> {
  const { userId, orgId } = await auth();

  if (!userId) {
    redirect('/sign-in');
  }

  if (orgId) {
    return { tenantId: orgId, userId };
  }

  // No active org yet — provision one now. Clerk will make this the
  // session's active org on the client's *next* request (it's set via a
  // client-side call), but the id returned here is already correct to use
  // server-side for this request: we just created it and own the id.
  const tenantId = await ensurePersonalOrg(userId);
  return { tenantId, userId };
}
