/**
 * Odometer log page ("/odometer") — Task 6. A Server Component that fetches
 * the tenant's vehicles plus each one's latest reading (for the vehicle
 * picker's "last reading" figures), then hands that off to components/
 * OdometerForm.tsx for the actual client-side form and its submit state.
 */
import Link from 'next/link';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { requireTenant } from '@/lib/auth';
import { getDb } from '@/lib/db';
import { vehicles, odometerReadings } from '@/lib/db/schema';
import { formatKm, formatShortDate } from '@/lib/status';
import { OdometerForm, type OdometerVehicleOption } from '@/components/OdometerForm';

export default async function OdometerPage() {
  const { tenantId } = await requireTenant();
  const db = getDb();

  const vehicleRows = await db
    .select({ id: vehicles.id, nickname: vehicles.nickname, plate: vehicles.plate })
    .from(vehicles)
    .where(eq(vehicles.tenantId, tenantId));

  if (vehicleRows.length === 0) {
    return (
      <div>
        <h1 className="eyebrow">Log odometer reading</h1>
        <p className="mt-4 text-steel">No vehicles in your fleet yet.</p>
        <Link
          href="/vehicles/new"
          className="mt-4 inline-block border border-seam px-5 py-2.5 text-sm text-bone transition-colors hover:bg-panel-2"
        >
          Add a vehicle
        </Link>
      </div>
    );
  }

  // One query for every reading across all of this tenant's vehicles
  // (ordered so each vehicle's LATEST row comes first — same tiebreak as
  // lib/actions/odometer.ts's getLatestReading: recordedAt desc, readingKm
  // desc), reduced in JS below. WHY one batched query instead of N
  // per-vehicle lookups: a fleet page's vehicle count can grow, and this
  // keeps the round-trip count fixed at two total regardless of fleet size.
  // (This is a read-only DISPLAY query, not a business-rule guard — unlike
  // getLatestReading it doesn't need to run inside a transaction, so it
  // isn't reused directly here.)
  const readings = await db
    .select({
      vehicleId: odometerReadings.vehicleId,
      readingKm: odometerReadings.readingKm,
      recordedAt: odometerReadings.recordedAt,
    })
    .from(odometerReadings)
    .where(
      and(
        eq(odometerReadings.tenantId, tenantId),
        inArray(odometerReadings.vehicleId, vehicleRows.map((v) => v.id)),
      ),
    )
    .orderBy(desc(odometerReadings.recordedAt), desc(odometerReadings.readingKm));

  const latestByVehicle = new Map<string, { readingKm: number; recordedAt: Date }>();
  for (const r of readings) {
    if (!latestByVehicle.has(r.vehicleId)) {
      latestByVehicle.set(r.vehicleId, { readingKm: r.readingKm, recordedAt: r.recordedAt });
    }
  }

  const vehicleOptions: OdometerVehicleOption[] = vehicleRows.map((v) => {
    const latest = latestByVehicle.get(v.id);
    return {
      id: v.id,
      nickname: v.nickname,
      plate: v.plate,
      lastReadingLabel: latest
        ? `${formatKm(latest.readingKm)} · ${formatShortDate(latest.recordedAt)}`
        : 'No reading yet',
    };
  });

  return (
    <div>
      <h1 className="eyebrow">Log odometer reading</h1>
      <p className="mt-3 text-steel">Pick a vehicle and enter its current mileage.</p>
      <div className="mt-6">
        <OdometerForm vehicles={vehicleOptions} />
      </div>
    </div>
  );
}
