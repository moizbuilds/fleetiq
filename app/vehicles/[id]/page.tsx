/**
 * Vehicle detail page ("/vehicles/[id]") — full instrument-panel build
 * (Task 8): header (photo, plate, VIN, decode badge, odometer), compliance
 * section with inline-editable Istimara/Fahes dates, the AI/user
 * maintenance schedule table (components/ScheduleItemRow.tsx: StatusPill +
 * IntervalGauge per row, plus an inline interval-edit toggle added in fix
 * round 1, item 4), service history timeline, and per-year cost totals +
 * cost-per-km. Tasks 4-7's generate/accept schedule flow and "Mark done"
 * wiring are kept exactly as they were — this task only restyles/extends
 * the page around them.
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
import { requireTenant } from '@/lib/auth';
import { getDb } from '@/lib/db';
import { getVehicleDetail } from '@/lib/queries';
import { AI_BRAND_DISCLAIMER, isValidUuid } from '@/lib/types';
import { formatKm } from '@/lib/status';
import { GenerateSchedule } from '@/components/GenerateSchedule';
import { OdometerReadout } from '@/components/OdometerReadout';
import { PlateChip } from '@/components/PlateChip';
import { ComplianceSection } from '@/components/ComplianceSection';
import { ScheduleItemRow } from '@/components/ScheduleItemRow';
import { HistoryTimeline } from '@/components/HistoryTimeline';

const DECODE_SOURCE_LABEL: Record<'vpic' | 'manual' | 'mixed', string> = {
  vpic: 'VIN decoded',
  manual: 'Manual entry',
  mixed: 'VIN + manual',
};

export default async function VehiclePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  if (!isValidUuid(id)) {
    notFound();
  }

  // requireTenant() gives the verified Clerk org id — never trust a
  // tenant/ownership check based on anything the client sent. getVehicleDetail
  // scopes by BOTH id and tenantId in one WHERE clause (rather than fetching
  // by id and checking tenantId after), so a vehicle belonging to a
  // different tenant is indistinguishable from one that doesn't exist at
  // all — a 404, not a 403 that would leak "yes, that id exists".
  const { tenantId } = await requireTenant();
  const db = getDb();
  const detail = await getVehicleDetail(db, tenantId, id, new Date());

  if (!detail) {
    notFound();
  }

  const { vehicle } = detail;
  const specLine = [vehicle.make, vehicle.model, vehicle.year].filter(Boolean).join(' ');
  // globals.md requires the brand-suggestion disclaimer wherever AI brand
  // recommendations are shown (final review, item 1) — but only when a row
  // actually HAS one; a schedule with no AI brand picks at all has nothing
  // for the caveat to apply to.
  const hasBrandRecommendations = detail.scheduleItems.some(
    ({ item }) => item.brandRecommendations.length > 0,
  );

  return (
    <div className="space-y-8">
      {/* ------------------------------------------------------------- */}
      {/* Header                                                        */}
      {/* ------------------------------------------------------------- */}
      <div className="flex flex-col gap-6 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex items-start gap-4">
          {vehicle.photoUrl && (
            /* A user-uploaded Vercel Blob URL, not a locally optimizable
               asset next/image's loader configuration would need to know
               about ahead of time. */
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={vehicle.photoUrl}
              alt=""
              width={64}
              height={64}
              className="h-16 w-16 shrink-0 rounded border border-seam object-cover"
            />
          )}
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-3">
              <h1 className="text-2xl font-semibold text-bone break-words">{vehicle.nickname}</h1>
              <PlateChip plate={vehicle.plate} />
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              {vehicle.vin && <span className="mono-figures text-sm text-steel">{vehicle.vin}</span>}
              <span className="border border-seam px-2 py-0.5 text-[10px] uppercase tracking-wide text-steel-dim">
                {DECODE_SOURCE_LABEL[vehicle.decodeSource]}
              </span>
            </div>
            {specLine && <p className="mt-1 text-sm text-steel">{specLine}</p>}
          </div>
        </div>

        <div className="flex flex-col items-start gap-3 sm:items-end">
          <OdometerReadout km={detail.latestReadingKm} size="sm" />
          <div className="flex gap-2">
            <Link
              href="/odometer"
              className="border border-seam px-3 py-1.5 text-xs text-steel transition-colors hover:border-steel-dim hover:text-bone"
            >
              Log reading
            </Link>
            <Link
              href={`/vehicles/${vehicle.id}/log-service`}
              className="border border-seam px-3 py-1.5 text-xs font-medium text-bone transition-colors hover:bg-panel-2"
            >
              Log service
            </Link>
          </div>
        </div>
      </div>

      {/* ------------------------------------------------------------- */}
      {/* Compliance                                                    */}
      {/* ------------------------------------------------------------- */}
      <ComplianceSection
        vehicleId={vehicle.id}
        istimaraExpiry={vehicle.istimaraExpiry}
        istimaraStatus={detail.compliance.istimara}
        fahesDue={vehicle.fahesDue}
        fahesStatus={detail.compliance.fahes}
      />

      {/* ------------------------------------------------------------- */}
      {/* Maintenance schedule                                          */}
      {/* ------------------------------------------------------------- */}
      <div>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="eyebrow">Maintenance schedule</p>
          {/* Reachable regardless of whether there's a schedule item to
              attach it to — an unscheduled repair has no row of its own in
              the table below. */}
          <Link
            href={`/vehicles/${vehicle.id}/log-service`}
            className="border border-seam px-3 py-1.5 text-xs text-steel transition-colors hover:border-steel-dim hover:text-bone"
          >
            Log a service or repair
          </Link>
        </div>

        {detail.scheduleItems.length === 0 ? (
          <div className="mt-4">
            <GenerateSchedule vehicleId={vehicle.id} />
          </div>
        ) : (
          <div className="mt-4 overflow-x-auto border border-seam bg-panel">
            <table className="w-full min-w-[960px] text-left text-sm">
              <thead>
                <tr className="border-b border-seam text-steel">
                  <th className="px-3 py-2 font-medium">Item</th>
                  <th className="px-3 py-2 font-medium">Status</th>
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
                {detail.scheduleItems.map(({ item, status, intervalConsumedPct }) => (
                  <ScheduleItemRow
                    key={item.id}
                    vehicleId={vehicle.id}
                    item={item}
                    status={status}
                    intervalConsumedPct={intervalConsumedPct}
                  />
                ))}
              </tbody>
            </table>
            {/* Once per table, not per row (final review, item 1) — a small
                muted caption under the Brands column rather than repeating
                it on every AI-sourced row, which would just be the same
                sentence read N times. text-steel (not amber — amber is
                reserved for due-soon status per globals.md), same "small
                muted caption" treatment as the cost-per-km caption below. */}
            {hasBrandRecommendations && (
              <p className="border-t border-seam px-3 py-2 text-xs text-steel">{AI_BRAND_DISCLAIMER}</p>
            )}
          </div>
        )}
      </div>

      {/* ------------------------------------------------------------- */}
      {/* Service history                                               */}
      {/* ------------------------------------------------------------- */}
      <div>
        <p className="eyebrow">Service history</p>
        <div className="mt-4">
          <HistoryTimeline entries={detail.history} />
        </div>
      </div>

      {/* ------------------------------------------------------------- */}
      {/* Costs                                                         */}
      {/* ------------------------------------------------------------- */}
      <div className="border border-seam bg-panel p-5">
        <p className="eyebrow">Costs</p>
        {detail.costs.totalsByYear.length === 0 ? (
          <p className="mt-3 text-sm text-steel">No costed services yet.</p>
        ) : (
          <>
            <dl className="mt-4 grid grid-cols-2 gap-4 sm:grid-cols-4">
              {detail.costs.totalsByYear.map((y) => (
                <div key={y.year}>
                  <dt className="text-xs text-steel">{y.year}</dt>
                  <dd className="mono-figures mt-1 text-bone">{y.totalQar} QAR</dd>
                </div>
              ))}
            </dl>

            {detail.costs.costPerKm !== null && (
              <div className="mt-4 border-t border-seam pt-4">
                <p className="mono-figures text-lg text-bone">{detail.costs.costPerKm.toFixed(2)} QAR/km</p>
                <p className="mt-1 text-xs text-steel">
                  derived from {detail.costs.serviceCount} service{detail.costs.serviceCount === 1 ? '' : 's'} over{' '}
                  {formatKm(detail.costs.distanceKm ?? 0)}
                </p>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
