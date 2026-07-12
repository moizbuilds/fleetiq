/**
 * Vehicle detail page ("/vehicles/[id]") — Task 4 built the core-fields
 * placeholder; Task 5 adds the AI maintenance-schedule flow (generate,
 * review, accept). Odometer history, the service log, and this page's full
 * instrument styling (OdometerReadout, AnnunciatorLamp, IntervalGauge) all
 * arrive in Task 8 — the schedule table below is deliberately plain, just
 * token-consistent, until then.
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
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { and, desc, eq } from 'drizzle-orm';
import { requireTenant } from '@/lib/auth';
import { getDb } from '@/lib/db';
import { vehicles, scheduleItems, odometerReadings } from '@/lib/db/schema';
import { isValidUuid } from '@/lib/types';
import { formatKm } from '@/lib/status';
import { GenerateSchedule } from '@/components/GenerateSchedule';

const AI_SOURCE_TOOLTIP = "AI-recommended — verify against your owner's manual.";

export default async function VehiclePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  if (!isValidUuid(id)) {
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

  // CONCEPT: Promise.all runs both independent queries concurrently instead
  // of one after the other — neither query depends on the other's result
  // (both only need `id`, already known), so awaiting them sequentially
  // would just add the two round trips together for no reason.
  const [items, [latestReading]] = await Promise.all([
    db.select().from(scheduleItems).where(eq(scheduleItems.vehicleId, id)),
    db
      .select({ readingKm: odometerReadings.readingKm })
      .from(odometerReadings)
      .where(eq(odometerReadings.vehicleId, id))
      .orderBy(desc(odometerReadings.recordedAt))
      .limit(1),
  ]);

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
        <div>
          <dt className="text-steel">Odometer</dt>
          <dd className="mono-figures mt-1 text-bone">
            {latestReading ? formatKm(latestReading.readingKm) : 'No reading yet'}
          </dd>
        </div>
      </dl>

      <div className="mt-8">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="eyebrow">Maintenance schedule</p>
          {/* Reachable regardless of whether there's a schedule item to
              attach it to — an unscheduled repair (Task 6) has no row of
              its own in the table below. */}
          <Link
            href={`/vehicles/${vehicle.id}/log-service`}
            className="border border-seam px-3 py-1.5 text-xs text-steel transition-colors hover:border-steel-dim hover:text-bone"
          >
            Log a service or repair
          </Link>
        </div>

        {items.length === 0 ? (
          <div className="mt-4">
            <GenerateSchedule vehicleId={vehicle.id} />
          </div>
        ) : (
          <div className="mt-4 overflow-x-auto border border-seam bg-panel">
            <table className="w-full min-w-[860px] text-left text-sm">
              <thead>
                <tr className="border-b border-seam text-steel">
                  <th className="px-3 py-2 font-medium">Item</th>
                  <th className="px-3 py-2 font-medium">Interval</th>
                  <th className="px-3 py-2 font-medium">Next due</th>
                  <th className="px-3 py-2 font-medium">Brands</th>
                  <th className="px-3 py-2 font-medium">Source</th>
                  <th className="px-3 py-2 font-medium">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {items.map((item) => {
                  const interval = [
                    item.intervalKm !== null ? formatKm(item.intervalKm) : null,
                    item.intervalMonths !== null ? `${item.intervalMonths} mo` : null,
                  ]
                    .filter(Boolean)
                    .join(' / ');

                  const nextDue = [
                    item.nextDueKm !== null ? formatKm(item.nextDueKm) : null,
                    item.nextDueDate,
                  ]
                    .filter(Boolean)
                    .join(' / ');

                  return (
                    <tr key={item.id} className="border-b border-seam last:border-b-0">
                      <td className="px-3 py-2 text-bone">{item.name}</td>
                      <td className="mono-figures px-3 py-2 text-steel">{interval || '—'}</td>
                      <td className="mono-figures px-3 py-2 text-steel">{nextDue || '—'}</td>
                      <td className="px-3 py-2 text-steel">
                        {item.brandRecommendations.length > 0 ? item.brandRecommendations.join(', ') : '—'}
                      </td>
                      <td className="px-3 py-2">
                        <span
                          className="border border-seam px-2 py-0.5 text-xs uppercase text-steel"
                          title={item.source === 'ai' ? AI_SOURCE_TOOLTIP : undefined}
                        >
                          {item.source}
                        </span>
                      </td>
                      <td className="px-3 py-2 text-right">
                        {/* `?item=` preselects this row's schedule item on
                            the log-service form (app/vehicles/[id]/
                            log-service/page.tsx validates it's actually
                            THIS vehicle's item before trusting it — the
                            query string is attacker-controlled). */}
                        <Link
                          href={`/vehicles/${vehicle.id}/log-service?item=${item.id}`}
                          className="text-xs text-steel underline decoration-seam underline-offset-4 transition-colors hover:text-bone"
                        >
                          Mark done
                        </Link>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
