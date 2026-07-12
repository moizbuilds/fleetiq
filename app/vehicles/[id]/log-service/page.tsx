/**
 * Log-service page ("/vehicles/[id]/log-service") — Task 6. Reached either
 * from a schedule row's "Mark done" link (app/vehicles/[id]/page.tsx,
 * preselecting that item via `?item=<id>`) or by navigating directly for an
 * unscheduled repair. A Server Component that fetches the vehicle (tenant-
 * scoped, 404 if missing), its schedule items, and its latest reading, then
 * hands all of that to components/ServiceForm.tsx.
 */
import { notFound } from 'next/navigation';
import { and, desc, eq } from 'drizzle-orm';
import { requireTenant } from '@/lib/auth';
import { getDb } from '@/lib/db';
import { vehicles, scheduleItems, odometerReadings } from '@/lib/db/schema';
import { isValidUuid } from '@/lib/types';
import { formatKm } from '@/lib/status';
import { ServiceForm, type ServiceScheduleItemOption } from '@/components/ServiceForm';

export default async function LogServicePage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ item?: string }>;
}) {
  const { id } = await params;
  const { item: requestedItemId } = await searchParams;

  // Same trust-boundary reasoning as app/vehicles/[id]/page.tsx: `id` comes
  // straight from the URL, so it's checked against a UUID shape before ever
  // touching the database (a non-UUID string would make Postgres itself
  // throw, surfacing as an opaque 500 instead of a clean 404).
  if (!isValidUuid(id)) {
    notFound();
  }

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

  const [items, [latestReading]] = await Promise.all([
    db.select().from(scheduleItems).where(eq(scheduleItems.vehicleId, id)),
    db
      .select({ readingKm: odometerReadings.readingKm })
      .from(odometerReadings)
      .where(eq(odometerReadings.vehicleId, id))
      .orderBy(desc(odometerReadings.recordedAt), desc(odometerReadings.readingKm))
      .limit(1),
  ]);

  const itemOptions: ServiceScheduleItemOption[] = items.map((item) => {
    const nextDue = [
      item.nextDueKm !== null ? formatKm(item.nextDueKm) : null,
      item.nextDueDate,
    ]
      .filter(Boolean)
      .join(' / ');
    return { id: item.id, name: item.name, nextDueLabel: nextDue || 'No threshold set' };
  });

  // `requestedItemId` comes straight from the URL's query string —
  // attacker-controlled, same as `id` above (globals.md's trust-boundary
  // rule). Only trust it as a preselection if it actually names one of
  // THIS vehicle's schedule items; a stray/foreign/malformed value just
  // falls back to no preselection instead of the form silently pointing at
  // nothing.
  const preselectedItemId =
    requestedItemId !== undefined && itemOptions.some((i) => i.id === requestedItemId)
      ? requestedItemId
      : null;

  const hasPhotoUpload = Boolean(process.env.BLOB_READ_WRITE_TOKEN);
  const today = new Date().toISOString().slice(0, 10);

  return (
    <div>
      <p className="eyebrow">Log service</p>
      <h1 className="mt-3 text-2xl font-semibold text-bone break-words">{vehicle.nickname}</h1>

      <div className="mt-6">
        <ServiceForm
          vehicleId={vehicle.id}
          scheduleItems={itemOptions}
          preselectedItemId={preselectedItemId}
          latestReadingKm={latestReading?.readingKm ?? null}
          today={today}
          hasPhotoUpload={hasPhotoUpload}
        />
      </div>
    </div>
  );
}
