'use client';

/**
 * Client-side bridge that keeps Clerk's "active organization" in sync with
 * the tenant the server has already decided on.
 *
 * WHY this has to run on the client at all: Clerk's active-organization
 * flag lives in browser session state (it's what `orgId` in `auth()`
 * reads on the server), and only the client SDK's `setActive()` can change
 * it — there is no server-side equivalent. `lib/auth.ts`'s
 * `requireTenant()` can DERIVE which org a user belongs to (by looking up
 * their memberships), but it can't make the browser's session remember
 * that for next time. Without this component, every request from a user
 * with no active org would repeat the membership lookup in
 * `requireTenant()` forever instead of ever reaching the fast path.
 *
 * This renders nothing — it's a side-effect-only component, mounted once
 * near the root of the signed-in tree.
 */
import { useEffect } from 'react';
import { useAuth, useOrganizationList } from '@clerk/nextjs';

export function SyncActiveOrg() {
  // `orgId` here mirrors exactly what the server's `auth()` would see —
  // if it's already set, `requireTenant()`'s fast path already works and
  // this component has nothing to do.
  const { isLoaded: authLoaded, orgId } = useAuth();

  // CONCEPT: `useOrganizationList` is a Clerk hook (client-only — it reads
  // live browser session state, unlike `auth()` on the server) that exposes
  // the signed-in user's organization memberships plus `setActive()`, the
  // only way to change which org is "active" for this browser session.
  // `userMemberships: { infinite: false }` opts into fetching the first
  // page of memberships (Clerk requires opting in explicitly per resource
  // to avoid firing network requests nobody asked for); we only ever need
  // the first one.
  const { isLoaded: orgListLoaded, setActive, userMemberships } = useOrganizationList({
    userMemberships: { infinite: false },
  });

  useEffect(() => {
    if (!authLoaded || !orgListLoaded) return;

    // Session already has an active org — the server-side fast path in
    // requireTenant() already applies, nothing to sync.
    if (orgId) return;

    if (userMemberships.data === undefined || userMemberships.data.length === 0) return;

    const firstMembership = userMemberships.data[0];
    void setActive({ organization: firstMembership.organization.id });
    // setActive is intentionally omitted from deps: Clerk's hook returns a
    // stable-enough reference in practice, and re-running this effect only
    // needs to be gated on the data actually changing, not on identity
    // churn of the setter.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authLoaded, orgListLoaded, orgId, userMemberships.data]);

  return null;
}
