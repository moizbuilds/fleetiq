/**
 * Settings page ("/settings") — Task 9. A Server Component whose only job
 * is to look up whether the tenant already has a tracker API key (and when
 * it was created), then hand that off to components/ApiKeyPanel.tsx for
 * the actual generate/regenerate UI and the webhook connection docs.
 *
 * WHY this page never reads the key's HASH, only its `createdAt`: the raw
 * key can't be recovered from its hash (that's the point — see
 * lib/api-keys.ts's header), and the hash itself has no legitimate use in
 * this page's rendering. Reading only `createdAt` means there's nothing
 * sensitive in this Server Component's data at all.
 */
import { requireTenant } from '@/lib/auth';
import { getDb } from '@/lib/db';
import { tenantApiKeys } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';
import { ApiKeyPanel } from '@/components/ApiKeyPanel';

export default async function SettingsPage() {
  const { tenantId } = await requireTenant();
  const db = getDb();

  const [existing] = await db
    .select({ createdAt: tenantApiKeys.createdAt })
    .from(tenantApiKeys)
    .where(eq(tenantApiKeys.tenantId, tenantId))
    .limit(1);

  const keyCreatedAtLabel = existing
    ? existing.createdAt.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })
    : null;

  // Falls back to a relative path when NEXT_PUBLIC_APP_URL isn't set (e.g.
  // local dev without .env.local fully filled in) — the docs panel still
  // shows a usable path, just not an absolute URL a real device could
  // reach until the env var is set for a real deployment.
  const endpointUrl = `${process.env.NEXT_PUBLIC_APP_URL ?? ''}/api/integrations/odometer`;

  return (
    <div>
      <h1 className="eyebrow">Settings</h1>
      <p className="mt-3 text-steel">Manage the API key a GPS tracker device uses to log odometer readings.</p>
      <div className="mt-6">
        <ApiKeyPanel keyCreatedAtLabel={keyCreatedAtLabel} endpointUrl={endpointUrl} />
      </div>
    </div>
  );
}
