/**
 * Server action for issuing/rotating a tenant's tracker webhook API key
 * (Task 9) — called from components/ApiKeyPanel.tsx's "Generate key" /
 * "Regenerate key" button on app/settings/page.tsx.
 *
 * WHY this is a separate action file rather than living inline in
 * ApiKeyPanel.tsx: 'use server' functions are the only kind of export a
 * Client Component can import and call directly (see lib/actions/
 * odometer.ts's header for the same split) — the actual key generation
 * (lib/api-keys.ts, no directive) stays plain, testable TypeScript that
 * this file just wires up to a tenant + the database.
 */
'use server';

import { revalidatePath } from 'next/cache';
import { requireTenant } from '@/lib/auth';
import { getDb } from '@/lib/db';
import { tenantApiKeys } from '@/lib/db/schema';
import { generateApiKey } from '@/lib/api-keys';

// Issues a brand-new key for the caller's tenant, invalidating any
// previous one. Returns the RAW key exactly once — it is never stored
// (only its hash is) and never logged, so this return value is the only
// place in the entire system it's ever visible again after this call
// returns; components/ApiKeyPanel.tsx is responsible for showing it to the
// user and warning them it won't be shown again.
//
// WHY an UPSERT (insert ... on conflict do update) instead of a plain
// insert: lib/db/schema.ts's tenantApiKeys.tenantId has a UNIQUE
// constraint — a tenant has at most one active key. Rotating a key isn't
// "add a second key"; it's "atomically replace the one key this tenant
// has" — a single UPSERT statement does that in one round trip with no
// read-then-write gap where a concurrent request could see a stale row.
export async function rotateApiKey(): Promise<{ raw: string }> {
  const { tenantId } = await requireTenant();
  const db = getDb();

  const { raw, hash } = generateApiKey();

  await db
    .insert(tenantApiKeys)
    .values({ tenantId, keyHash: hash })
    .onConflictDoUpdate({
      target: tenantApiKeys.tenantId,
      set: { keyHash: hash, createdAt: new Date() },
    });

  // Busts the Router Cache so /settings's "key exists, created <date>"
  // display reflects the new createdAt the next time the page renders
  // (e.g. after a client-side navigation away and back).
  revalidatePath('/settings');

  return { raw };
}
