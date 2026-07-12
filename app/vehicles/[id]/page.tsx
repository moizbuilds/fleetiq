/**
 * Vehicle detail page ("/vehicles/[id]") — placeholder for Task 4.
 *
 * This is the redirect target after `createVehicle` saves a new vehicle
 * (see lib/actions/vehicles.ts), so it has to exist and actually work end
 * to end even though the real page — schedule generation, odometer
 * history, service log — isn't built until Tasks 5 and 8. For now it just
 * proves the save-then-view flow and shows the vehicle's core fields.
 *
 * WHY the `id` param is checked against a UUID shape before ever touching
 * the database: `id` comes straight from the URL, which means it's
 * attacker-controlled (globals.md's trust-boundary rule) — a visitor can
 * type anything into that URL segment. The `vehicles.id` column is a
 * Postgres `uuid`, so handing a non-UUID string straight to `eq()` would
 * make Postgres itself throw an "invalid input syntax for type uuid" error,
 * surfacing as an opaque 500 instead of the same clean 404 a well-formed
 * but nonexistent id gets.
 */
import { notFound } from 'next/navigation';
import { and, eq } from 'drizzle-orm';
import { requireTenant } from '@/lib/auth';
import { getDb } from '@/lib/db';
import { vehicles } from '@/lib/db/schema';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function VehiclePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  if (!UUID_PATTERN.test(id)) {
    notFound();
  }

  // requireTenant() gives the verified Clerk org id — never trust a
  // tenant/ownership check based on anything the client sent. Scoping the
  // query by BOTH id and tenantId in one WHERE clause (rather than
  // fetching by id and checking tenantId after) means a vehicle belonging
  // to a different tenant is indistinguishable from one that doesn't exist
  // at all — a 404, not a 403 that would leak "yes, that id exists".
  const { tenantId } = await requireTenant();

  const db = getDb();
  const [vehicle] = await db
    .select()
    .from(vehicles)
    .where(and(eq(vehicles.id, id), eq(vehicles.tenantId, tenantId)))
    .limit(1);

  if (!vehicle) {
    notFound();
  }

  return (
    <div>
      <p className="eyebrow">Vehicle</p>
      <h1 className="mt-3 text-2xl font-semibold text-bone break-words">{vehicle.nickname}</h1>

      <dl className="mt-6 grid grid-cols-2 gap-4 border border-seam bg-panel p-5 text-sm sm:grid-cols-4">
        <div>
          <dt className="text-steel">Make</dt>
          <dd className="mt-1 text-bone">{vehicle.make ?? '—'}</dd>
        </div>
        <div>
          <dt className="text-steel">Model</dt>
          <dd className="mt-1 text-bone">{vehicle.model ?? '—'}</dd>
        </div>
        <div>
          <dt className="text-steel">Year</dt>
          <dd className="mono-figures mt-1 text-bone">{vehicle.year ?? '—'}</dd>
        </div>
        <div>
          <dt className="text-steel">Plate</dt>
          <dd className="mono-figures mt-1 text-bone">{vehicle.plate ?? '—'}</dd>
        </div>
      </dl>

      <p className="mt-6 border-l-2 border-seam pl-3 text-sm text-steel">
        Schedule generation lands in Task 5.
      </p>
    </div>
  );
}
